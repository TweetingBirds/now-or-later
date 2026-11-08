// Tests for app/core.js: the rules the app and the Worker share.
// Run with `npm test` in worker/ (or `bash scripts/check.sh` at the top).
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOMBSTONE_DAYS, OLD_DAYS, QUICK_MAX, QUICK_LEN,
  wins, pickNewest, pruneTombstones, mergeBoards, dayKey, isOld, oldCutoff, quickTarget, quickLines, carryOver, pencilMoves,
} from "../../app/core.js";

const DAY = 864e5;

test("the newer edit wins, whichever side it's on", () => {
  assert.equal(wins({ updatedAt: 2 }, { updatedAt: 1 }), true);
  assert.equal(wins({ updatedAt: 1 }, { updatedAt: 2 }), false);
  assert.equal(wins({ updatedAt: 1 }, undefined), true);
  assert.equal(wins({}, { updatedAt: 1 }), false); // no stamp counts as 0
});

test("on a tie a live copy beats a tombstone, otherwise the later copy wins", () => {
  assert.equal(wins({ updatedAt: 5 }, { updatedAt: 5, deleted: true }), true);
  assert.equal(wins({ updatedAt: 5, deleted: true }, { updatedAt: 5 }), false);
  assert.equal(wins({ updatedAt: 5, text: "b" }, { updatedAt: 5, text: "a" }), true);
  assert.equal(wins({ updatedAt: 5, deleted: true }, { updatedAt: 5, deleted: true }), true);
});

test("pickNewest keeps one copy per id and drops items without a string id", () => {
  const out = pickNewest([
    [{ id: "a", text: "old", updatedAt: 1 }, { id: "b", text: "keep", updatedAt: 9 }, { id: 3, updatedAt: 1 }, null],
    [{ id: "a", text: "new", updatedAt: 2 }, { id: "b", text: "stale", updatedAt: 3 }],
  ]);
  assert.deepEqual(out.map((x) => [x.id, x.text]), [["a", "new"], ["b", "keep"]]);
});

test("pickNewest with assign updates the first object in place", () => {
  const mine = { id: "a", text: "old", done: true, updatedAt: 1 };
  const out = pickNewest([[mine], [{ id: "a", text: "new", updatedAt: 2 }]], (prev, item) => {
    for (const k of Object.keys(prev)) if (!(k in item)) delete prev[k];
    Object.assign(prev, item);
  });
  assert.equal(out[0], mine);
  assert.deepEqual(mine, { id: "a", text: "new", updatedAt: 2 });
});

test("tombstones are forgotten after TOMBSTONE_DAYS, live items never", () => {
  const now = Date.UTC(2026, 10, 5);
  const old = now - (TOMBSTONE_DAYS + 1) * DAY, recent = now - DAY;
  const out = pruneTombstones([
    { id: "gone", deleted: true, updatedAt: old },
    { id: "fresh", deleted: true, updatedAt: recent },
    { id: "live", updatedAt: old },
  ], now);
  assert.deepEqual(out.map((x) => x.id), ["fresh", "live"]);
});

test("mergeBoards merges lists, todos and settings by newest", () => {
  const now = Date.UTC(2026, 10, 5);
  const a = {
    settings: { carry: true, updatedAt: 10 },
    lists: [{ id: "n", name: "Now", updatedAt: 1 }],
    todos: [{ id: "t1", text: "a-side", updatedAt: 5 }, { id: "t2", text: "only a", updatedAt: 1 }],
  };
  const b = {
    settings: { carry: false, updatedAt: 9 },
    lists: [{ id: "n", name: "Today", updatedAt: 2 }],
    todos: [{ id: "t1", text: "b-side", updatedAt: 4 }, { id: "t3", deleted: true, updatedAt: now - (TOMBSTONE_DAYS + 5) * DAY }],
  };
  const m = mergeBoards(a, b, { now });
  assert.equal(m.version, 1);
  assert.equal(m.settings.carry, true);
  assert.equal(m.lists[0].name, "Today");
  assert.deepEqual(m.todos.map((t) => t.text), ["a-side", "only a"]);
});

test("mergeBoards copes with a missing side", () => {
  const m = mergeBoards(null, { lists: [{ id: "x", updatedAt: 1 }] });
  assert.deepEqual(m.lists.map((l) => l.id), ["x"]);
  assert.deepEqual(m.todos, []);
  assert.deepEqual(m.settings, {});
});

test("a todo moved between lists at the same moment stays alive", () => {
  const m = mergeBoards(
    { todos: [{ id: "t", listId: "s1", deleted: true, updatedAt: 7 }] },
    { todos: [{ id: "t", listId: "n", updatedAt: 7 }] },
  );
  assert.equal(m.todos[0].deleted, undefined);
  const back = mergeBoards(
    { todos: [{ id: "t", listId: "n", updatedAt: 7 }] },
    { todos: [{ id: "t", listId: "s1", deleted: true, updatedAt: 7 }] },
  );
  assert.equal(back.todos[0].deleted, undefined);
});

test("dayKey gives YYYY-MM-DD", () => {
  assert.equal(dayKey(new Date(Date.UTC(2026, 0, 3, 12)), true), "2026-01-03");
  assert.equal(dayKey(new Date(2026, 0, 3, 12)), "2026-01-03");
});

test("oldCutoff is OLD_DAYS before today", () => {
  assert.equal(oldCutoff(new Date(Date.UTC(2026, 10, 5, 12)), true), dayKey(new Date(Date.UTC(2026, 10, 5, 12) - OLD_DAYS * DAY), true));
});

test("isOld: only Done todos older than the cutoff, not on kept lists", () => {
  const cut = "2026-08-01";
  const t = { id: "t", listId: "n", archived: true, archivedDay: "2026-07-31" };
  assert.equal(isOld(t, cut), true);
  assert.equal(isOld({ ...t, archivedDay: "2026-08-01" }, cut), false);
  assert.equal(isOld({ ...t, archived: false }, cut), false);
  assert.equal(isOld({ ...t, deleted: true }, cut), false);
  assert.equal(isOld({ ...t, archivedDay: undefined }, cut), false);
  assert.equal(isOld(t, cut, new Set(["n"])), false);
  assert.equal(isOld(null, cut), false);
});

test("quickTarget: role, then name, then Now, then the first list", () => {
  const lists = [
    { id: "a", name: "Groceries" },
    { id: "n", name: "Now", role: "now" },
    { id: "t", name: "Tomorrow", role: "tomorrow" },
  ];
  assert.equal(quickTarget(lists, "tomorrow").id, "t");
  assert.equal(quickTarget(lists, "  GROCERIES ").id, "a");
  assert.equal(quickTarget(lists, "nope").id, "n");
  assert.equal(quickTarget(lists, "").id, "n");
  assert.equal(quickTarget([{ id: "a", name: "Groceries" }], "").id, "a");
  assert.equal(quickTarget([], "now"), null);
});

test("quickLines: one todo per line, bullets dropped, limits kept", () => {
  assert.deepEqual(quickLines("- milk\r\n* eggs\n\n  • bread  \n"), ["milk", "eggs", "bread"]);
  assert.deepEqual(quickLines(""), []);
  assert.deepEqual(quickLines(undefined), []);
  assert.equal(quickLines("x".repeat(QUICK_LEN + 10))[0].length, QUICK_LEN);
  assert.equal(quickLines(Array.from({ length: QUICK_MAX + 5 }, (_, i) => "t" + i).join("\n")).length, QUICK_MAX);
});

test("carryOver: unfinished Tomorrow todos from before midnight go to the end of Now, in order", () => {
  const midnight = 1000;
  const todos = [
    { id: "n1", listId: "now", order: 3, updatedAt: 1 },
    { id: "t2", listId: "tom", order: 2, updatedAt: 1 },
    { id: "t1", listId: "tom", order: 1, updatedAt: 1 },
    { id: "today", listId: "tom", order: 3, updatedAt: 2000 }, // put there after midnight
    { id: "gone", listId: "tom", order: 4, deleted: true, updatedAt: 1 },
    { id: "done", listId: "tom", order: 5, archived: true, updatedAt: 1 },
    { id: "other", listId: "later", order: 1, updatedAt: 1 },
  ];
  const moves = carryOver(todos, "now", "tom", midnight);
  assert.deepEqual(moves.map((m) => [m.todo.id, m.order]), [["t1", 4], ["t2", 5]]);
  assert.deepEqual(carryOver(todos, "empty", "tom", midnight).map((m) => m.order), [1, 2]);
});

test("carryOver: steps come along under their todo and keep their order", () => {
  const todos = [
    { id: "p", listId: "tom", order: 1, updatedAt: 1 },
    { id: "s2", listId: "tom", order: 2, parentId: "p", updatedAt: 5000 }, // checked this morning
    { id: "s1", listId: "tom", order: 1, parentId: "p", updatedAt: 1 },
    { id: "q", listId: "tom", order: 2, updatedAt: 1 },
    { id: "lost", listId: "tom", order: 3, parentId: "gone", updatedAt: 1 }, // its todo was deleted
    { id: "n1", listId: "now", order: 2, updatedAt: 1 },
    { id: "n1s", listId: "now", order: 9, parentId: "n1", updatedAt: 1 }, // a step's order doesn't count
  ];
  const moves = carryOver(todos, "now", "tom", 1000);
  assert.deepEqual(moves.map((m) => [m.todo.id, m.order]), [["p", 3], ["s1", 1], ["s2", 2], ["q", 4], ["lost", 5]]);
});

test("pencilMoves: Tomorrow the day before, Now on the day, catching up on missed days", () => {
  const todos = [
    { id: "n1", listId: "now", order: 1 },
    { id: "t1", listId: "tom", order: 1 },
    { id: "wed", listId: "later", order: 1, pencil: "2026-11-11" },
    { id: "thu", listId: "later", order: 2, pencil: "2026-11-12" },
    { id: "thuStep", listId: "later", order: 1, parentId: "thu" },
    { id: "past", listId: "trip", order: 1, pencil: "2026-11-02" },
    { id: "plain", listId: "later", order: 3 },
    { id: "shared", listId: "sh", order: 1, pencil: "2026-11-10" },
    { id: "gone", listId: "later", order: 4, pencil: "2026-11-10", deleted: true },
    { id: "stepDated", listId: "later", order: 2, parentId: "thu", pencil: "2026-11-10" }, // steps follow their todo
  ];
  const opts = { nowId: "now", tomId: "tom", today: "2026-11-11", tomorrow: "2026-11-12", carry: true, skip: new Set(["sh"]) };
  const got = pencilMoves(todos, opts).map((m) => [m.todo.id, m.listId, m.order]);
  assert.deepEqual(got, [["past", "now", 2], ["wed", "now", 3], ["thu", "tom", 2], ["thuStep", "tom", 1], ["stepDated", "tom", 2]]);
  // Without the carry, tomorrow's todo waits for its day.
  assert.deepEqual(pencilMoves(todos, { ...opts, carry: false }).map((m) => m.todo.id), ["past", "wed"]);
  // Without a Tomorrow list, the same.
  assert.deepEqual(pencilMoves(todos, { ...opts, tomId: undefined }).map((m) => m.todo.id), ["past", "wed"]);
  // Nothing moves without a Now list.
  assert.deepEqual(pencilMoves(todos, { ...opts, nowId: undefined }), []);
});
