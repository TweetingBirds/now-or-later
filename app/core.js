// The rules the app and the sync Worker must agree on, in one place: how two
// copies of a board merge, which Done todos count as "older", where a quick add
// lands, and what the morning moves from Tomorrow into Now.
//
// It's an ES module with no dependencies. The app loads it with
// <script type="module"> and reads it as window.NatCore; the Worker imports it
// (wrangler bundles it in); worker/test/core.test.mjs tests it directly.

export const TOMBSTONE_DAYS = 60; // deleted items are remembered this long
export const OLD_DAYS = 90;       // Done todos finished longer ago than this move off the board
export const QUICK_MAX = 50;      // todos per quick add
export const QUICK_LEN = 500;     // characters per quick-added todo

export const stamp = (x) => (x && x.updatedAt) || 0;

// Should `next` replace `prev`? The newer edit wins. On a tie, a live copy beats
// a tombstone (a todo moved between lists at that moment); otherwise the copy
// that arrived later wins, so a device's own unsent edit never beats the
// Worker's answer it was just merged with.
export function wins(next, prev) {
  if (!prev) return true;
  const a = stamp(next), b = stamp(prev);
  if (a !== b) return a > b;
  if (!!prev.deleted !== !!next.deleted) return !next.deleted;
  return true;
}

// Newest copy of each item across the groups, in order (later groups win ties).
// Items without a string id are dropped.
export function pickNewest(groups, assign) {
  const m = new Map();
  for (const xs of groups) for (const item of xs || []) {
    if (!item || typeof item.id !== "string") continue;
    const prev = m.get(item.id);
    if (prev === item || !wins(item, prev)) continue;
    // The app keeps its own objects (rows on screen point at them) and copies the
    // winner's fields in; the Worker just takes the winner.
    if (prev && assign) assign(prev, item); else m.set(item.id, item);
  }
  return [...m.values()];
}

// Tombstones older than TOMBSTONE_DAYS are dropped.
export function pruneTombstones(xs, now = Date.now()) {
  const cutoff = now - TOMBSTONE_DAYS * 864e5;
  return xs.filter((i) => !(i.deleted && stamp(i) < cutoff));
}

// Merges two boards: newest wins per list, per todo, and for settings.
export function mergeBoards(a, b, { now = Date.now(), assign } = {}) {
  const sa = (a && a.settings) || {}, sb = (b && b.settings) || {};
  return {
    version: 1,
    settings: wins(sb, sa) ? sb : sa,
    lists: pruneTombstones(pickNewest([a && a.lists, b && b.lists], assign), now),
    todos: pruneTombstones(pickNewest([a && a.todos, b && b.todos], assign), now),
  };
}

// "YYYY-MM-DD" for a Date, in local time (the app) or UTC (the Worker).
export const dayKey = (d, utc = false) => utc
  ? d.toISOString().slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Older Done: a Done todo whose day is before `cutDay`, unless its list is in
// `keepLists` (archived lists keep their todos for "Use again"; shared lists
// keep theirs).
export function isOld(t, cutDay, keepLists = new Set()) {
  return !!t && !t.deleted && t.archived === true && typeof t.archivedDay === "string" && t.archivedDay < cutDay && !keepLists.has(t.listId);
}
export function oldCutoff(now = new Date(), utc = false) {
  const d = new Date(now.getTime()); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - OLD_DAYS);
  return dayKey(d, utc);
}

// Where a quick add lands: the list named by `to` (a role like "tomorrow", or a
// list's name), else Now, else the first list. `lists` is the live lists in order.
export function quickTarget(lists, to) {
  const want = String(to || "").trim().toLowerCase();
  return (want && (lists.find((l) => l.role === want) || lists.find((l) => String(l.name || "").trim().toLowerCase() === want)))
    || lists.find((l) => l.role === "now") || lists[0] || null;
}
// Each non-empty line becomes a todo; list bullets are dropped.
export function quickLines(text) {
  return String(text || "").split(/\r?\n/).map((x) => x.trim().replace(/^[-*•]\s+/, "").slice(0, QUICK_LEN)).filter(Boolean).slice(0, QUICK_MAX);
}

// Steps: a todo with a parentId sits under that todo, one level deep, on the same
// list. Each step is its own todo, so two people checking different steps both
// keep their checks. A step whose parent isn't live on the same list is shown
// (and moved) as an ordinary todo.
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
const liveIn = (todos, id) => todos.filter((t) => !t.deleted && !t.archived && t.listId === id);
function splitSteps(xs) {
  const ids = new Set(xs.filter((t) => !t.parentId).map((t) => t.id));
  const top = xs.filter((t) => !t.parentId || !ids.has(t.parentId)).sort(byOrder);
  const kids = (p) => xs.filter((t) => t.parentId === p.id).sort(byOrder);
  return { top, kids };
}
// Moves `parents` (top-level todos) to the end of list `toId`, in order, each
// followed by its steps, which keep their own order. Returns [{ todo, order }].
function moveToEnd(todos, parents, kids, toId) {
  let o = Math.max(0, ...splitSteps(liveIn(todos, toId)).top.map((t) => t.order || 0));
  const out = [];
  for (const todo of parents) {
    out.push({ todo, order: ++o });
    for (const s of kids(todo)) out.push({ todo: s, order: s.order || 0 });
  }
  return out;
}

// The morning: unfinished Tomorrow todos move to the end of Now, in order, steps
// and all. Only what was in Tomorrow before `midnight`: a todo changed since then
// was put there today (on a device that already did its morning), so it stays.
// Returns [{ todo, order }] for the caller to apply.
export function carryOver(todos, nowId, tomId, midnight) {
  const { top, kids } = splitSteps(liveIn(todos, tomId));
  return moveToEnd(todos, top.filter((t) => stamp(t) < midnight), kids, nowId);
}

// "Pencil in for…": a todo with pencil: "YYYY-MM-DD" on another list comes to the
// front of the notebook in time for that day. With the Tomorrow-to-Now carry on,
// it moves to Tomorrow the morning before (the carry brings it into Now on the
// day); without it, or without a Tomorrow list, it goes straight to Now on the
// day. A day that has passed (nobody opened the app) goes to Now. Shared lists
// are left out (`skip`): each person's board would pull the todo off the list.
// Returns [{ todo, listId, order }]; the caller clears `pencil` on the todos.
export function pencilMoves(todos, { nowId, tomId, today, tomorrow, carry, skip = new Set() }) {
  if (!nowId) return [];
  const out = [];
  const lists = new Set(todos.filter((t) => !t.deleted && !t.archived && typeof t.pencil === "string" && t.listId !== nowId && t.listId !== tomId && !skip.has(t.listId)).map((t) => t.listId));
  const due = new Map([[nowId, []]]);
  if (carry && tomId) due.set(tomId, []);
  const kidsOf = new Map();
  for (const id of lists) {
    const { top, kids } = splitSteps(liveIn(todos, id));
    for (const t of top) {
      if (typeof t.pencil !== "string") continue;
      kidsOf.set(t.id, kids);
      if (t.pencil <= today) due.get(nowId).push(t);
      else if (due.has(tomId) && t.pencil === tomorrow) due.get(tomId).push(t);
    }
  }
  for (const [to, ts] of due) {
    if (!ts.length) continue;
    ts.sort((a, b) => a.pencil.localeCompare(b.pencil) || byOrder(a, b));
    for (const m of moveToEnd(todos, ts, (p) => kidsOf.get(p.id)(p), to)) out.push({ ...m, listId: to });
  }
  return out;
}

if (typeof globalThis !== "undefined") {
  globalThis.NatCore = { TOMBSTONE_DAYS, OLD_DAYS, QUICK_MAX, QUICK_LEN, stamp, wins, pickNewest, pruneTombstones, mergeBoards, dayKey, isOld, oldCutoff, quickTarget, quickLines, carryOver, pencilMoves };
}
