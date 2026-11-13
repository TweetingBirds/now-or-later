// MCP server: lets an AI assistant (Claude, or anything else that speaks the Model
// Context Protocol) read and change one board's todos.
//
// It's the "Streamable HTTP" transport without sessions or streaming: every
// request is one JSON-RPC message (or a batch) POSTed to /mcp, and every answer is
// plain JSON. The Worker keeps nothing between requests.
//
// Who's asking is an agent key ("na_..."), made in the app under Settings > Sync >
// Advanced > AI assistants. Each key opens one board, can be read only or read and
// change, and only ever works here: /data, sharing, invites, devices and deleting
// the board all turn it away. The key goes in an Authorization header, or in the
// address itself (/mcp/na_...) for apps whose connector screen has nowhere to put
// a header.
//
// Changes are saved the way a quick add is (see quickAdd in worker.js): each
// changed todo goes into the inbox first and is then merged with the board, so a
// device saving at the same moment can't write over it. They are ordinary edits
// with a fresh timestamp, so the merge rules in app/core.js apply as they do to
// any device, and the app shows them on its next sync.
//
// The tools follow the app's own rules: steps go with their todo, checking a
// todo's last step checks the todo, "Done right away" moves a checked todo to
// Done, and "Pencil in for…" only works off Now and Tomorrow.

import { stamp, quickLines, QUICK_MAX } from "../app/core.js";

export const DOCS_URL = "https://now-or-later.app/agents.md";
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TEXT_MAX = 5000;
const DONE_SHOWN = 50; // recent Done todos list_todos returns when asked
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const INSTRUCTIONS = `Now or Later is a simple todo app that works like a paper notebook. The lists are usually Now (today), Tomorrow and Later (someday), plus any the person added. Each morning, unfinished Tomorrow todos move into Now. Checked todos stay on their list for the rest of the day, then move to Done.
Call list_todos first: it gives each list, the todos on it with their ids, and today's date in the person's time zone. Todos can have steps (one level). Put something on Now for today, Tomorrow for tomorrow, and Later for someday. For a particular day further out, add it to Later (or another list that isn't Now or Tomorrow) and pencil_in the date: the app brings it to the front in time. There are no due dates, reminders or overdue todos, on purpose.
Keep todo text short, the way someone would jot it in a notebook. Don't delete or reorganize things the person didn't ask about.`;

// ---------- the tools ----------

const id = { type: "string", description: "The todo's id, from list_todos." };
const listArg = (what) => ({ type: "string", description: `${what} A list's name, or now, tomorrow or later.` });

const TOOLS = [
  {
    name: "list_todos",
    title: "List todos",
    description: "Lists the board's lists in order and the todos on each (with their steps), plus today's date. Done todos are left out unless include_done is true.",
    inputSchema: { type: "object", properties: {
      list: listArg("Only this list."),
      include_done: { type: "boolean", description: `Also return up to ${DONE_SHOWN} recently finished todos from Done.` },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    read: true,
  },
  {
    name: "add_todos",
    title: "Add todos",
    description: `Adds todos to the bottom of a list, one per line of text (up to ${QUICK_MAX}). Goes to Now unless a list is given. With under, the lines become steps of that todo instead.`,
    inputSchema: { type: "object", required: ["text"], properties: {
      text: { type: "string", description: "One todo per line." },
      list: listArg("Where to add them (default Now)."),
      under: { type: "string", description: "A todo's id: add the lines as its steps." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "check_off",
    title: "Check off a todo",
    description: "Checks a todo (and its steps), or unchecks it with done: false. Checking a todo's last open step checks the todo too.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id, done: { type: "boolean", description: "false to uncheck. Default true." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "move_todo",
    title: "Move a todo",
    description: "Moves a todo, with its steps, to another list (or to the top or bottom of its own). A step moved this way becomes an ordinary todo.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id, list: listArg("Where to move it (default: the list it's on)."),
      position: { type: "string", enum: ["top", "bottom"], description: "Default bottom." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "edit_todo",
    title: "Change a todo's text",
    description: "Replaces a todo's text.",
    inputSchema: { type: "object", required: ["id", "text"], properties: { id, text: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "pencil_in",
    title: "Pencil in for a day",
    description: "Pencils a todo in for a day (YYYY-MM-DD). The app moves it to Tomorrow the morning before and into Now on the day; it never becomes overdue. Works for todos on lists other than Now and Tomorrow, and not on shared lists or steps. An empty date takes the pencil off.",
    inputSchema: { type: "object", required: ["id", "date"], properties: {
      id, date: { type: "string", description: "YYYY-MM-DD, or empty to clear." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_todo",
    title: "Delete a todo",
    description: "Deletes a todo and its steps. Only when the person asks; finished todos should be checked off instead.",
    inputSchema: { type: "object", required: ["id"], properties: { id } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];
export const TOOL_NAMES = TOOLS.map((t) => t.name);

// "YYYY-MM-DD" in the board's time zone (the app tells the Worker which one).
export function dayIn(tz, d = new Date()) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch (e) { return d.toISOString().slice(0, 10); }
}

class ToolError extends Error {}

// Helpers over a board as GET /data returns it (shared lists mixed in).
function helpers(board) {
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  const lists = board.lists.filter((l) => !l.deleted && !l.archived).sort(byOrder);
  const live = board.todos.filter((t) => !t.deleted && !t.archived);
  const listOf = (t) => lists.find((l) => l.id === t.listId);
  const parentOf = (t) => {
    if (!t.parentId) return null;
    const p = live.find((x) => x.id === t.parentId);
    return p && !p.parentId && p.listId === t.listId ? p : null;
  };
  const stepsOf = (p) => (p.parentId ? [] : live.filter((t) => t.parentId === p.id && t.listId === p.listId).sort(byOrder));
  const topIn = (listId) => live.filter((t) => t.listId === listId && !parentOf(t)).sort(byOrder);
  const findList = (name) => {
    const want = String(name || "").trim().toLowerCase();
    const l = lists.find((x) => x.role === want) || lists.find((x) => String(x.name || "").trim().toLowerCase() === want);
    if (!l) throw new ToolError(`There's no list called "${name}". The lists are: ${lists.map((x) => x.name).join(", ")}.`);
    return l;
  };
  const findTodo = (todoId) => {
    const t = live.find((x) => x.id === todoId);
    if (!t) throw new ToolError(board.todos.some((x) => x.id === todoId && x.archived) ? "That todo is already in Done." : "There's no todo with that id. Call list_todos for the current ids.");
    return t;
  };
  return { lists, live, listOf, parentOf, stepsOf, topIn, findList, findTodo };
}

function describe(board, today, { list, include_done }) {
  const h = helpers(board);
  const only = list ? h.findList(list) : null;
  const shown = only ? [only] : h.lists;
  const todo = (t) => ({
    id: t.id, text: t.text, done: !!t.done,
    ...(typeof t.pencil === "string" ? { pencil: t.pencil } : {}),
  });
  const out = {
    today,
    lists: shown.map((l) => ({
      name: l.name, ...(l.role ? { role: l.role } : {}), ...(l.shared ? { shared_with: l.members } : {}),
      todos: h.topIn(l.id).map((t) => {
        const steps = h.stepsOf(t);
        return { ...todo(t), ...(steps.length ? { steps: steps.map(todo) } : {}) };
      }),
    })),
  };
  if (include_done) {
    out.done = board.todos.filter((t) => !t.deleted && t.archived && (!only || t.listId === only.id))
      .sort((a, b) => String(b.archivedDay || "").localeCompare(String(a.archivedDay || "")) || stamp(b) - stamp(a))
      .slice(0, DONE_SHOWN)
      .map((t) => ({ id: t.id, text: t.text, finished: t.archivedDay || t.doneDay || null, from: t.fromName || "" }));
  }
  return out;
}

// Runs a tool that changes the board. Returns { changed: [todos], result }.
function change(name, args, board, today, settings) {
  const h = helpers(board);
  const t0 = Date.now();
  const changed = new Map();
  const touch = (t, fields) => { const next = { ...(changed.get(t.id) || t), ...fields, updatedAt: t0 }; changed.set(t.id, next); return next; };
  const str = (v, what) => { if (typeof v !== "string" || !v.trim()) throw new ToolError(`${what} is missing.`); return v; };

  if (name === "add_todos") {
    const lines = quickLines(str(args.text, "text"));
    if (!lines.length) throw new ToolError("text is missing.");
    let listId, parentId = null, order;
    if (args.under) {
      const p = h.findTodo(String(args.under));
      if (h.parentOf(p)) throw new ToolError("Steps can't have steps of their own. Add them under the todo it belongs to.");
      listId = p.listId; parentId = p.id;
      order = Math.max(0, ...h.stepsOf(p).map((k) => k.order || 0));
      if (p.done) touch(p, { done: false, doneDay: null }); // a new step means it isn't finished
    } else {
      const l = args.list ? h.findList(args.list) : (h.lists.find((x) => x.role === "now") || h.lists[0]);
      if (!l) throw new ToolError("This board has no lists yet. Open the app once so it can sync.");
      listId = l.id;
      order = Math.max(0, ...h.topIn(l.id).map((x) => x.order || 0));
    }
    const added = lines.map((text) => touch({
      id: crypto.randomUUID(), text, listId, ...(parentId ? { parentId } : {}), order: ++order,
      done: false, doneDay: null, archived: false,
    }, {}));
    const where = h.lists.find((l) => l.id === listId);
    return { changed, result: { added: added.map((x) => ({ id: x.id, text: x.text })), list: where ? where.name : "", ...(parentId ? { under: parentId } : {}) } };
  }

  const t = h.findTodo(str(args.id, "id"));
  const list = h.listOf(t);

  if (name === "check_off") {
    const checked = args.done !== false;
    const parent = h.parentOf(t);
    const top = parent || t;
    const day = checked ? today : null;
    touch(t, { done: checked, doneDay: day });
    if (!parent) { for (const k of h.stepsOf(t)) if (!!k.done !== checked) touch(k, { done: checked, doneDay: day }); }
    else if (checked && !parent.done && h.stepsOf(parent).every((k) => k.id === t.id || k.done)) touch(parent, { done: true, doneDay: day });
    else if (!checked && parent.done) touch(parent, { done: false, doneDay: null });
    const topDone = checked && (changed.get(top.id) || top).done;
    // "Done right away" in Settings: the todo and its steps go to Done now.
    if (topDone && settings && settings.doneNow) {
      const fields = { archived: true, archivedDay: day, fromName: list ? list.name : "", fromColor: list ? list.color : undefined };
      for (const x of [top, ...h.stepsOf(top)]) touch(x, fields);
    }
    return { changed, result: { id: t.id, text: t.text, done: checked, ...(topDone && settings && settings.doneNow ? { moved_to: "Done" } : {}) } };
  }

  if (name === "move_todo") {
    const to = args.list ? h.findList(args.list) : list;
    if (!to) throw new ToolError("That todo isn't on a list.");
    const others = h.topIn(to.id).filter((x) => x.id !== t.id);
    const order = args.position === "top" ? Math.min(1, ...others.map((x) => x.order || 0)) - 1 : Math.max(0, ...others.map((x) => x.order || 0)) + 1;
    const fields = { listId: to.id, order };
    if (t.parentId) fields.parentId = null;
    if (typeof t.pencil === "string" && (to.role === "now" || to.role === "tomorrow" || to.shared)) fields.pencil = null;
    const kids = h.stepsOf(t);
    touch(t, fields);
    for (const k of kids) if (k.listId !== to.id) touch(k, { listId: to.id });
    return { changed, result: { id: t.id, text: t.text, list: to.name, position: args.position === "top" ? "top" : "bottom" } };
  }

  if (name === "edit_todo") {
    const text = str(args.text, "text").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
    touch(t, { text });
    return { changed, result: { id: t.id, text } };
  }

  if (name === "pencil_in") {
    const date = typeof args.date === "string" ? args.date.trim() : "";
    if (!date) {
      touch(t, { pencil: null });
      return { changed, result: { id: t.id, text: t.text, pencil: null } };
    }
    if (!DAY.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z"))) throw new ToolError("date should look like 2026-11-20.");
    if (!list || list.role === "now" || list.role === "tomorrow") throw new ToolError(`It's already on ${list ? list.name : "the front page"}. Move it to Later (or another list) first, then pencil it in.`);
    if (list.shared) throw new ToolError("Todos on a shared list can't be penciled in.");
    if (h.parentOf(t)) throw new ToolError("Steps can't be penciled in. Pencil in the todo they belong to.");
    if (date < today) throw new ToolError(`${date} has passed (today is ${today}). Move it to Now instead.`);
    touch(t, { pencil: date });
    return { changed, result: { id: t.id, text: t.text, pencil: date } };
  }

  if (name === "delete_todo") {
    for (const x of [t, ...h.stepsOf(t)]) touch(x, { deleted: true });
    return { changed, result: { deleted: [...changed.values()].map((x) => ({ id: x.id, text: x.text })) } };
  }

  throw new ToolError("Unknown tool " + name);
}

// ---------- JSON-RPC ----------

const rpcError = (rid, code, message) => ({ jsonrpc: "2.0", id: rid, error: { code, message } });
const ok = (rid, result) => ({ jsonrpc: "2.0", id: rid, result });
const textResult = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : { structuredContent: value }),
});

// store: { read() -> { board, tz }, save(todos) -> Promise }. agent: { scope, label, name }.
export async function handleRpc(msg, agent, store) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request");
  const rid = msg.id;
  const note = rid === undefined || rid === null; // a notification gets no answer
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const tools = TOOLS.filter((t) => t.read || agent.scope === "write");
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion || "");
      return ok(rid, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "now-or-later", title: "Now or Later", version: "1.0.0" },
        instructions: INSTRUCTIONS + (agent.scope === "write" ? "" : "\nThis connection can only read the lists."),
      });
    }
    case "ping": return note ? null : ok(rid, {});
    case "tools/list": return ok(rid, { tools: tools.map(({ read: _r, ...t }) => t) });
    case "tools/call": {
      const name = String(params.name || "");
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(rid, -32602, "Unknown tool: " + name);
      if (!tools.includes(tool)) return ok(rid, textResult("This connection can only read the lists. To let it make changes, make a new one in Settings > Sync > Advanced and choose \"Can read and change\".", true));
      try {
        const { board, tz } = await store.read();
        const today = dayIn(tz);
        if (tool.read) return ok(rid, textResult(describe(board, today, args)));
        const { changed, result } = change(name, args, board, today, board.settings);
        if (changed.size) await store.save([...changed.values()]);
        return ok(rid, textResult(result));
      } catch (e) {
        if (e instanceof ToolError) return ok(rid, textResult(e.message, true));
        throw e;
      }
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return note ? null : rpcError(rid, -32601, "Method not found: " + msg.method);
  }
}
