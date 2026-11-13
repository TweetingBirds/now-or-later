// Run with: node --test worker/test
// The MCP server for AI assistants (worker/mcp.js) and its agent keys, against an
// in-memory stand-in for Workers KV.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { putBoard } from "../worker.js";
import { dayIn } from "../mcp.js";

function memoryKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v, metadata: e.meta || null } : { value: null, metadata: null }; },
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: m.get(name).meta })), list_complete: true }; },
  };
}
const NATE = "nate-owner-token-0123456789";
const TIFF = "tiffany-owner-token-0123";
const env = () => ({ NOW_AND_THEN: memoryKV(), TOKEN_NATE: NATE, TOKEN_TIFFANY: TIFF, ADMINS: "nate", MAX_BOARDS: "3" });
const W = "https://w.example";
const call = (e, method, path, { token, body, headers = {} } = {}) => worker.fetch(new Request(W + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
}), e);
const get = async (e, token) => (await call(e, "GET", "/data", { token })).json();

const LISTS = [
  { id: "n", name: "Now", role: "now", order: 1, color: "#f2b84b", updatedAt: 1 },
  { id: "tm", name: "Tomorrow", role: "tomorrow", order: 2, updatedAt: 1 },
  { id: "l", name: "Later", role: "later", order: 3, updatedAt: 1 },
];
const todo = (id, listId, text, more = {}) => ({ id, listId, text, order: 1, done: false, doneDay: null, archived: false, updatedAt: 1, ...more });
async function setup(scope = "write", todos = [todo("a", "n", "milk")], settings = {}) {
  const e = env();
  await call(e, "PUT", "/data", { token: NATE, body: { settings: { carry: true, updatedAt: 1, ...settings }, lists: LISTS, todos }, headers: { "X-Time-Zone": "America/New_York" } });
  const r = await call(e, "POST", "/agents", { token: NATE, body: { label: "Claude", scope } });
  assert.equal(r.status, 200);
  return { e, agent: await r.json() };
}
let rid = 0;
async function rpc(e, agent, method, params, { inPath = true } = {}) {
  const body = { jsonrpc: "2.0", id: ++rid, method, ...(params ? { params } : {}) };
  const r = inPath
    ? await call(e, "POST", "/mcp/" + agent.token, { body })
    : await call(e, "POST", "/mcp", { body, token: agent.token });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
async function tool(e, agent, name, args = {}) {
  const { body } = await rpc(e, agent, "tools/call", { name, arguments: args });
  assert.ok(body.result, JSON.stringify(body));
  const res = body.result;
  return { error: res.isError ? res.content[0].text : null, value: res.structuredContent };
}

test("agent keys: made once, shown once, only work on /mcp", async () => {
  const { e, agent } = await setup();
  assert.match(agent.token, /^na_[A-Za-z0-9_-]{43}$/);
  assert.equal(agent.url, W + "/mcp/" + agent.token);
  assert.equal(agent.scope, "write");
  assert.ok(![...e.NOW_AND_THEN.m.values()].some(x => String(x.v).includes(agent.token)), "the key itself is never stored");
  for (const [m, p] of [["GET", "/data"], ["PUT", "/data"], ["POST", "/add"], ["GET", "/devices"], ["POST", "/agents"], ["POST", "/shared"], ["GET", "/snapshots"], ["DELETE", "/data?confirm=delete"]]) {
    assert.equal((await call(e, m, p, { token: agent.token, body: m === "GET" ? undefined : {} })).status, 401, `${m} ${p} turns agent keys away`);
  }
  const list = (await (await call(e, "GET", "/agents", { token: NATE })).json()).agents;
  assert.deepEqual(list.map(a => [a.label, a.scope]), [["Claude", "write"]]);
  assert.equal((await call(e, "DELETE", "/agents/" + list[0].id, { token: TIFF })).status, 404, "only from the same board");
  assert.equal((await (await call(e, "GET", "/agents", { token: TIFF })).json()).agents.length, 0, "each board sees only its own");
  assert.equal((await rpc(e, agent, "ping")).status, 200);
  assert.equal((await call(e, "DELETE", "/agents/" + list[0].id, { token: NATE })).status, 200);
  assert.equal((await rpc(e, agent, "ping")).status, 410, "a removed key stops at once");
  assert.equal((await call(e, "POST", "/mcp/na_" + "A".repeat(43), { body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 401);
  assert.equal((await call(e, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" }, token: NATE })).status, 401, "a board token isn't an agent key");
});

test("MCP handshake: initialize, notifications, tools/list by scope, header or address", async () => {
  const { e, agent } = await setup("read");
  let { body } = await rpc(e, agent, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.ok(body.result.capabilities.tools);
  assert.match(body.result.instructions, /paper notebook/);
  assert.match(body.result.instructions, /only read/);
  ({ body } = await rpc(e, agent, "initialize", { protocolVersion: "1999-01-01" }));
  assert.match(body.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  const r = await call(e, "POST", "/mcp/" + agent.token, { body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(r.status, 202);
  ({ body } = await rpc(e, agent, "tools/list", null, { inPath: false }));
  assert.deepEqual(body.result.tools.map(t => t.name), ["list_todos"]);
  assert.equal((await tool(e, agent, "add_todos", { text: "x" })).error.includes("only read"), true);
  ({ body } = await rpc(e, agent, "nope/what"));
  assert.equal(body.error.code, -32601);
  assert.equal((await call(e, "GET", "/mcp/" + agent.token)).status, 405);
  assert.equal((await call(e, "GET", "/.well-known/oauth-protected-resource")).status, 404);

  const w = await (await call(e, "POST", "/agents", { token: NATE, body: { scope: "write" } })).json();
  ({ body } = await rpc(e, w, "tools/list"));
  assert.deepEqual(body.result.tools.map(t => t.name), ["list_todos", "add_todos", "check_off", "move_todo", "edit_todo", "pencil_in", "delete_todo"]);
  assert.equal(w.label, "AI assistant");
});

test("list_todos shows lists in order, steps nested, today in the person's time zone", async () => {
  const { e, agent } = await setup("read", [
    todo("a", "n", "milk", { order: 2 }), todo("b", "n", "bake", { order: 1 }),
    todo("b1", "n", "flour", { parentId: "b" }), todo("x", "l", "trip", { pencil: "2027-01-02" }),
    todo("d", "n", "done one", { done: true, archived: true, archivedDay: "2026-11-01", fromName: "Now" }),
    todo("gone", "n", "deleted", { deleted: true }),
  ]);
  const { value } = await tool(e, agent, "list_todos");
  assert.equal(value.today, dayIn("America/New_York"));
  assert.deepEqual(value.lists.map(l => l.name), ["Now", "Tomorrow", "Later"]);
  assert.deepEqual(value.lists[0].todos.map(t => t.text), ["bake", "milk"]);
  assert.deepEqual(value.lists[0].todos[0].steps.map(t => t.text), ["flour"]);
  assert.equal(value.lists[2].todos[0].pencil, "2027-01-02");
  assert.equal(value.done, undefined);
  const only = (await tool(e, agent, "list_todos", { list: "later", include_done: true })).value;
  assert.deepEqual(only.lists.map(l => l.name), ["Later"]);
  assert.deepEqual(only.done, []);
  assert.equal((await tool(e, agent, "list_todos", { include_done: true })).value.done[0].text, "done one");
  assert.match((await tool(e, agent, "list_todos", { list: "Groceries" })).error, /no list called/);
});

test("add, check off, move, edit, pencil in and delete reach the app as ordinary edits", async () => {
  const { e, agent } = await setup();
  let r = await tool(e, agent, "add_todos", { text: "- call Mom\n- pay rent", list: "tomorrow" });
  assert.equal(r.value.list, "Tomorrow");
  let b = await get(e, NATE);
  const mom = b.todos.find(t => t.text === "call Mom");
  assert.equal(mom.listId, "tm");
  assert.ok(b.todos.find(t => t.text === "pay rent").order > mom.order);

  r = await tool(e, agent, "add_todos", { text: "eggs\nbutter", under: "a" });
  b = await get(e, NATE);
  assert.ok(b.todos.filter(t => t.parentId === "a").length === 2);
  const [eggs, butter] = ["eggs", "butter"].map(x => b.todos.find(t => t.text === x).id);

  // Checking the last step checks the todo; unchecking a step unchecks it.
  await tool(e, agent, "check_off", { id: eggs });
  assert.equal((await get(e, NATE)).todos.find(t => t.id === "a").done, false);
  await tool(e, agent, "check_off", { id: butter });
  b = await get(e, NATE);
  assert.equal(b.todos.find(t => t.id === "a").done, true);
  assert.equal(b.todos.find(t => t.id === "a").doneDay, dayIn("America/New_York"));
  await tool(e, agent, "check_off", { id: eggs, done: false });
  assert.equal((await get(e, NATE)).todos.find(t => t.id === "a").done, false);

  // Moving takes the steps along.
  r = await tool(e, agent, "move_todo", { id: "a", list: "Later", position: "top" });
  assert.equal(r.value.list, "Later");
  b = await get(e, NATE);
  assert.ok(b.todos.filter(t => t.id === "a" || t.parentId === "a").every(t => t.listId === "l"));

  r = await tool(e, agent, "pencil_in", { id: "a", date: "2099-05-01" });
  assert.equal(r.value.pencil, "2099-05-01");
  assert.match((await tool(e, agent, "pencil_in", { id: mom.id, date: "2099-05-01" })).error, /Tomorrow/);
  assert.match((await tool(e, agent, "pencil_in", { id: eggs, date: "2099-05-01" })).error, /Steps/);
  assert.match((await tool(e, agent, "pencil_in", { id: "a", date: "2000-01-01" })).error, /passed/);
  assert.match((await tool(e, agent, "pencil_in", { id: "a", date: "soon" })).error, /look like/);
  // Moving to Now takes the pencil off, as in the app.
  await tool(e, agent, "move_todo", { id: "a", list: "now" });
  assert.equal((await get(e, NATE)).todos.find(t => t.id === "a").pencil, null);

  await tool(e, agent, "edit_todo", { id: mom.id, text: "  call Mom\nabout Sunday " });
  assert.equal((await get(e, NATE)).todos.find(t => t.id === mom.id).text, "call Mom about Sunday");

  r = await tool(e, agent, "delete_todo", { id: "a" });
  assert.equal(r.value.deleted.length, 3, "the todo and its two steps");
  b = await get(e, NATE);
  assert.ok(b.todos.filter(t => t.id === "a" || t.parentId === "a").every(t => t.deleted));
  assert.match((await tool(e, agent, "check_off", { id: "a" })).error, /no todo/);
  assert.match((await tool(e, agent, "check_off", {})).error, /missing/);
});

test("with Done right away on, a checked todo goes to Done", async () => {
  const { e, agent } = await setup("write", [todo("a", "n", "milk")], { doneNow: true });
  const r = await tool(e, agent, "check_off", { id: "a" });
  assert.equal(r.value.moved_to, "Done");
  const t = (await get(e, NATE)).todos.find(x => x.id === "a");
  assert.equal(t.archived, true);
  assert.equal(t.fromName, "Now");
  assert.match((await tool(e, agent, "check_off", { id: "a" })).error, /already in Done/);
});

test("an assistant's change survives a device saving an older copy at the same moment", async () => {
  const { e, agent } = await setup();
  const stale = await e.NOW_AND_THEN.get("board:nate", "json");
  await tool(e, agent, "check_off", { id: "a" });
  await tool(e, agent, "add_todos", { text: "from Claude" });
  // A device's save that started before the assistant's lands after it.
  await putBoard(e, { board: "nate" }, stale, { lists: LISTS, todos: [todo("d1", "n", "typed", { updatedAt: Date.now() })] });
  const b = await get(e, NATE);
  assert.equal(b.todos.find(t => t.id === "a").done, true);
  assert.ok(b.todos.some(t => t.text === "from Claude") && b.todos.some(t => t.text === "typed"));
});

test("the time zone comes from the app, and a bad one is ignored", async () => {
  const { e } = await setup();
  assert.equal((await e.NOW_AND_THEN.get("board:nate", "json")).tz, "America/New_York");
  await call(e, "PUT", "/data", { token: NATE, body: { lists: LISTS, todos: [] }, headers: { "X-Time-Zone": "Not/AZone" } });
  assert.equal((await e.NOW_AND_THEN.get("board:nate", "json")).tz, "America/New_York");
  assert.equal((await get(e, NATE)).tz, undefined, "it isn't part of the board the app sees");
});

test("deleting an invited board removes its assistants; read and write limits", async () => {
  const e = env();
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const j = await (await call(e, "POST", "/join", { body: { code: inv.code } })).json();
  await call(e, "PUT", "/data", { token: j.token, body: { lists: LISTS, todos: [] } });
  const a = await (await call(e, "POST", "/agents", { token: j.token, body: { scope: "write" } })).json();
  assert.equal((await rpc(e, a, "ping")).status, 200);
  for (let i = 1; i < 10; i++) assert.equal((await call(e, "POST", "/agents", { token: j.token, body: {} })).status, 200);
  assert.equal((await call(e, "POST", "/agents", { token: j.token, body: {} })).status, 409, "ten per board");
  assert.equal((await call(e, "DELETE", "/data?confirm=delete", { token: j.token })).status, 200);
  assert.equal((await rpc(e, a, "ping")).status, 410);
  assert.ok(![...e.NOW_AND_THEN.m.keys()].some(k => k.startsWith("atok:")));
});

test("a shared list's todos added by an assistant reach the other board", async () => {
  const { e, agent } = await setup();
  await call(e, "PUT", "/data", { token: TIFF, body: { lists: LISTS.map(l => ({ ...l, id: "t" + l.id })), todos: [] } });
  await call(e, "PUT", "/data", { token: NATE, body: { lists: [...LISTS, { id: "g", name: "Groceries", order: 4, updatedAt: 1 }], todos: [] } });
  const { sid } = await (await call(e, "POST", "/shared", { token: NATE, body: { listId: "g" } })).json();
  const { code } = await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json();
  assert.equal((await call(e, "POST", "/shared/join", { token: TIFF, body: { code } })).status, 200);
  const r = await tool(e, agent, "add_todos", { text: "bananas", list: "groceries" });
  assert.equal(r.value.list, "Groceries");
  assert.ok((await get(e, TIFF)).todos.some(t => t.text === "bananas" && t.listId === "g"));
  assert.deepEqual((await tool(e, agent, "list_todos", { list: "Groceries" })).value.lists[0].shared_with.length, 2);
  assert.match((await tool(e, agent, "pencil_in", { id: (await get(e, NATE)).todos.find(t => t.text === "bananas").id, date: "2099-01-01" })).error, /shared/);
});
