// Now or Later: a notebook-style todo board.
// Lists live on this device (localStorage) and, when configured, sync through a
// small Cloudflare Worker that merges changes todo by todo (see /worker).
(() => {
  "use strict";
  // The rules shared with the sync Worker (merging, older Done, quick add, the
  // morning carry-over) live in core.js, loaded just before this file.
  const core = globalThis.NatCore;

  // APP_VERSION is bumped by hand for notable releases. The BUILD_* values are
  // stamped by the GitHub Pages workflow on every deploy (left as-is locally).
  const APP_VERSION = "1.27.0";
  const BUILD_NUMBER = "__BUILD_NUMBER__";
  const BUILD_SHA = "__BUILD_SHA__";
  const BUILD_DATE = "__BUILD_DATE__";
  const STAMPED = !BUILD_NUMBER.startsWith("__");

  const BOARD_KEY = "nat.board.v1";
  const LOCAL_KEY = "nat.local.v1"; // per-device: lastDay, sync settings
  const SYNCED_KEY = "nat.synced.v1"; // per-device: updatedAt of each item as the Worker last had it
  const OLD_KEY = "nat.old.v1"; // Done todos finished more than OLD_DAYS ago (see packOld)
  const OLD_DAYS = core.OLD_DAYS;
  const DONE_PAGE = 100; // Done rows drawn at first; "Show more" adds more
  const MAX_LISTS = 10;
  const TOMBSTONE_DAYS = core.TOMBSTONE_DAYS;
  const DEFAULT_COLOR = "#a3a9b5";
  // Colors go into style attributes, so only "#rrggbb" is used. Anything else (say from
  // someone on a shared list) becomes the plain gray. The Worker checks this too.
  const safeColor = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_COLOR);
  const PALETTE = ["#f2b84b", "#7b9cff", "#9b8cf0", "#5cc6a7", "#f28b82", "#f6a6cf", "#8ecae6", "#b5d16b", "#c9a27e", "#ff9f5a", "#7fd1d8", "#a3a9b5"];
  // What a screen reader says for each swatch.
  const COLOR_NAMES = ["Marigold", "Blue", "Lavender", "Mint", "Coral", "Pink", "Sky", "Lime", "Tan", "Orange", "Teal", "Gray"];
  // Deeper colors, only in the color menu (new lists still start from PALETTE).
  const DEEP = ["#2f5bd3", "#7d4fb3", "#c2417a", "#c4622d", "#3f8f5a", "#1f8a8a"];
  const DEEP_NAMES = ["Ballpoint", "Plum", "Berry", "Rust", "Forest", "Ocean"];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  // Every edit is stamped, and the newest stamp wins when devices disagree, so a
  // device whose clock is off would win (or lose) edits it shouldn't. Stamps use the
  // sync Worker's clock when there is one (clockOffset, from X-Server-Time), and each
  // new stamp is later than any this device has seen, so an edit made after seeing
  // another device's always wins over it.
  let lastStamp = 0;
  const clockNow = () => Date.now() + (Number(local.clockOffset) || 0);
  const now = () => (lastStamp = Math.max(clockNow(), lastStamp + 1));
  function seeStamps(b) {
    // A stamp from a clock that's ahead (this device's own, before it knew the
    // Worker's time, or an older app elsewhere) doesn't drag ours along with it.
    const cap = clockNow() + 5 * 60_000;
    for (const x of [b.settings, ...(b.lists || []), ...(b.todos || [])]) {
      const t = (x && x.updatedAt) || 0;
      if (t > lastStamp && t <= cap) lastStamp = t;
    }
  }

  // ---------- storage ----------
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  // A full device (or a browser that turned storage off) refuses to save. The edit
  // still shows, but would be gone after a reload, so say so instead of failing quietly.
  let storageWarned = 0, storageFailed = false;
  const write = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); if (k === BOARD_KEY) storageFailed = false; return true; }
    catch (e) {
      if (k === BOARD_KEY) storageFailed = true;
      if (Date.now() - storageWarned > 10 * 60_000) { storageWarned = Date.now(); setTimeout(() => warnStorage(k), 0); }
      return false;
    }
  };

  let local = Object.assign({ lastDay: null, syncUrl: "", syncToken: "", pristine: false, synced: false, board: "", boardName: "", boardKind: "", admin: false, switching: false, otherBoard: "", theme: "system", font: "hand", colors: "soft", keysAlt: false, sentAt: 0 }, read(LOCAL_KEY) || {});
  const looksLikeBoard = (b) => !!b && typeof b === "object" && Array.isArray(b.lists) && Array.isArray(b.todos);
  let board = read(BOARD_KEY);
  let recovered = "";
  if (!looksLikeBoard(board)) {
    const damaged = localStorage.getItem(BOARD_KEY) !== null;
    board = starterBoard(); local.pristine = true;
    if (local.synced && local.syncUrl && local.syncToken) {
      // The saved lists went missing or got damaged (a browser can lose storage) on a
      // device that syncs. Load the synced board as it is, the way switching boards
      // does, instead of syncing the welcome lists into it.
      local.synced = false; local.switching = true; recovered = "synced";
    } else if (damaged) {
      recovered = "local";
    } else {
      // A device with no lists yet is a first visit: it gets the welcome (see showWelcome).
      // Devices that already had lists never have welcome set, so they never see it.
      local.welcome = "pending";
    }
    write(LOCAL_KEY, local);
  }
  // What the Worker last confirmed it has, as { lists: {id: updatedAt}, todos: {...}, settings }.
  // Anything on this device that is newer hasn't reached the Worker yet. A device that
  // synced before this was tracked starts from its current board, so an upgrade
  // doesn't report every todo as unsynced.
  seeStamps(board);
  let serverSeen = read(SYNCED_KEY);
  if (!serverSeen) { serverSeen = local.synced ? stampsOf(board) : { lists: {}, todos: {}, settings: 0 }; write(SYNCED_KEY, serverSeen); }

  function starterBoard() {
    const t = now();
    const ids = { now: uid(), tom: uid(), later: uid() };
    const todo = (text, listId, order) => ({ id: uid(), text, listId, order, done: false, doneDay: null, archived: false, updatedAt: t });
    return {
      version: 1,
      settings: { carry: true, doneNow: false, updatedAt: t },
      lists: [
        { id: ids.now, name: "Now", color: "#f2b84b", role: "now", order: 1, updatedAt: t },
        { id: ids.tom, name: "Tomorrow", color: "#7b9cff", role: "tomorrow", order: 2, updatedAt: t },
        { id: ids.later, name: "Later", color: "#5cc6a7", role: "later", order: 3, updatedAt: t },
      ],
      todos: [
        todo("Tap a list name to rename it", ids.now, 1),
        todo("Drag me by the handle to another list", ids.now, 2),
        todo("Things for tomorrow go here", ids.tom, 1),
        todo("Someday ideas go in Later", ids.later, 1),
      ],
    };
  }

  // Same merge the Worker runs (core.mergeBoards): newest edit wins per list, per
  // todo, and for settings. Unlike the Worker, it keeps a's objects (this device's
  // board) and copies the winning fields into them. The rendered rows and an
  // in-progress drag hold references to those objects, so replacing them would make
  // the next drop or edit change a copy that is no longer on the board, and the todo
  // would snap back.
  const takeFields = (prev, item) => { for (const k of Object.keys(prev)) if (!(k in item)) delete prev[k]; Object.assign(prev, item); };
  const mergeBoards = (a, b) => core.mergeBoards(a, b, { now: clockNow(), assign: takeFields });

  // ---------- helpers over the board ----------
  // Archived lists stay in board.lists with archived: true (see archiveList).
  const lists = () => board.lists.filter(l => !l.deleted && !l.archived).sort((a, b) => a.order - b.order);
  const listById = (id) => board.lists.find(l => l.id === id && !l.deleted && !l.archived);
  const finishedLists = () => board.lists.filter(l => !l.deleted && l.archived).sort((a, b) => (b.archivedDay || "").localeCompare(a.archivedDay || "") || (b.updatedAt - a.updatedAt));
  // todosIn is a list's todos, without steps (see stepsOf).
  const todosIn = (listId) => board.todos.filter(t => !t.deleted && !t.archived && t.listId === listId && !isStep(t)).sort((a, b) => a.order - b.order);
  // Steps: a todo with a parentId sits under that todo, one level deep, on the same
  // list (see core.js). Each step is its own todo, so sync merges them one by one.
  // A step whose todo isn't there (deleted on another device, say) is shown as an
  // ordinary todo.
  const parentOf = (t) => {
    if (!t.parentId) return null;
    const p = board.todos.find(x => x.id === t.parentId);
    return p && !p.deleted && !p.parentId && !!p.archived === !!t.archived && p.listId === t.listId ? p : null;
  };
  const isStep = (t) => !!parentOf(t);
  const stepsOf = (p) => p.parentId ? [] : board.todos.filter(t => t.parentId === p.id && !t.deleted && !!t.archived === !!p.archived && t.listId === p.listId).sort((a, b) => a.order - b.order);
  // A todo and its steps: what moves, gets deleted or is undone together.
  const family = (t) => [t, ...stepsOf(t)];
  const archived = () => board.todos.filter(t => !t.deleted && t.archived).sort((a, b) => (b.archivedDay || "").localeCompare(a.archivedDay || "") || (b.updatedAt - a.updatedAt));
  const touch = (o, fields) => Object.assign(o, fields, { updatedAt: now() });

  // Lists can be deleted on another device; keep orphaned todos visible in the first list.
  function repairOrphans() {
    const first = lists()[0];
    if (!first) { board = mergeBoards(board, starterBoard()); return; }
    board.todos.forEach(t => { if (!t.deleted && !t.archived && !listById(t.listId)) touch(t, { listId: first.id }); });
  }

  // ---------- dates ----------
  function dayDate() { const d = new Date(); d.setHours(12, 0, 0, 0); return d; }
  const keyOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const todayKey = () => keyOf(dayDate());
  function pretty(key, opts = { weekday: "long", month: "long", day: "numeric" }) {
    const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, opts);
  }
  // Lists can show a date in their header, like the top of a notebook page. Now and
  // Tomorrow do unless you turn it off; any other list can be turned on. The dated
  // lists count up from today, left to right: the first is today, the next tomorrow.
  const showsDate = (l) => typeof l.showDate === "boolean" ? l.showDate : (l.role === "now" || l.role === "tomorrow");
  function listDates(ls) {
    const dates = new Map(), d = dayDate();
    for (const l of ls) if (showsDate(l)) { dates.set(l.id, keyOf(d)); d.setDate(d.getDate() + 1); }
    return dates;
  }

  // Steps go to Done with their todo, on the same day.
  function archive(t) {
    const l = listById(t.listId), kids = stepsOf(t);
    const fields = { archived: true, archivedDay: t.doneDay || todayKey(), fromName: l ? l.name : "", fromColor: l ? safeColor(l.color) : DEFAULT_COLOR };
    touch(t, fields);
    kids.forEach(k => touch(k, fields));
  }

  // ---------- older Done ----------
  // Done keeps everything, and every edit redraws the board and syncs all of it, so
  // after a year a phone would crawl. Todos finished more than OLD_DAYS ago move off
  // the board into their own store on this device (and, with sync, into the Worker's
  // "old:<board>", which it fills on its own; see the Worker's isOld). They come back
  // when someone searches Done or taps "Look further back". Todos on an archived list
  // stay with it so "Use again" has them, and shared lists keep theirs.
  // The rule itself is core.isOld, which the Worker uses too.
  const oldCutoff = () => core.oldCutoff(new Date(clockNow()));
  function packOld() {
    const cut = oldCutoff();
    const keep = new Set(board.lists.filter(l => l.archived || l.shared).map(l => l.id));
    const old = board.todos.filter(t => core.isOld(t, cut, keep));
    if (!old.length) return 0;
    const ids = new Set(old.map(t => t.id));
    const doc = oldDoc();
    const store = new Map(doc.todos.map(t => [t.id, t]));
    for (const t of old) { const prev = store.get(t.id); if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) store.set(t.id, t); }
    // "unsent": the Worker may never have had these (say sync was turned on after
    // they were packed), so the next sync sends them along (see oldToSend).
    // Only drop them from the board once they're safely stored.
    if (!write(OLD_KEY, { todos: [...store.values()], unsent: [...new Set([...doc.unsent, ...ids])] })) return 0;
    board.todos = board.todos.filter(t => !ids.has(t.id));
    oldCache = null;
    return old.length;
  }
  function oldDoc() { const o = read(OLD_KEY); return { todos: o && Array.isArray(o.todos) ? o.todos : [], unsent: o && Array.isArray(o.unsent) ? o.unsent : [] }; }
  const readOld = () => oldDoc().todos;
  function oldToSend() { const doc = oldDoc(), ids = new Set(doc.unsent); return doc.todos.filter(t => ids.has(t.id)); }
  function oldSent(sent) {
    if (!sent.length) return;
    const doc = oldDoc(), done = new Set(sent.map(t => t.id));
    write(OLD_KEY, { todos: doc.todos, unsent: doc.unsent.filter(id => !done.has(id)) });
  }
  function forgetOld() { write(OLD_KEY, { todos: [], unsent: [] }); oldCache = oldServer = null; }
  // Everything older, from this device and (once asked) the Worker, newest copy of
  // each, leaving out anything that's back on the board.
  let oldCache = null, oldServer = null, oldLoading = null;
  function olderDone() {
    if (!oldCache) {
      const m = new Map();
      for (const t of [...readOld(), ...(oldServer || [])]) { const prev = m.get(t.id); if (!prev || (t.updatedAt || 0) > (prev.updatedAt || 0)) m.set(t.id, t); }
      oldCache = [...m.values()];
    }
    const onBoard = new Set(board.todos.map(t => t.id));
    return oldCache.filter(t => !t.deleted && t.archived && !onBoard.has(t.id)).sort((a, b) => (b.archivedDay || "").localeCompare(a.archivedDay || "") || (b.updatedAt - a.updatedAt));
  }
  // Asks the Worker for its older Done once per visit. Without sync, or offline,
  // this device's own store is all there is.
  function loadOlder() {
    if (oldServer || oldLoading || !syncConfigured() || !local.synced || local.otherBoard || !navigator.onLine) return oldLoading || Promise.resolve();
    oldLoading = fetch(local.syncUrl.replace(/\/+$/, "") + "/old", { headers: { "Authorization": "Bearer " + local.syncToken }, cache: "no-store" })
      .then(r => (r.ok ? r.json() : null)).then(got => { if (got && Array.isArray(got.todos)) { oldServer = got.todos; oldCache = null; } })
      .catch(() => {}).finally(() => { oldLoading = null; });
    return oldLoading;
  }
  const mayHaveOlder = () => readOld().length > 0 || (syncConfigured() && local.synced && !oldServer) || olderDone().length > 0;

  function warnStorage(k) {
    if (k !== BOARD_KEY && k !== OLD_KEY) return;
    toast(syncConfigured()
      ? "This device is out of storage space, so changes may not be kept here after the app closes. They'll still sync to your other devices."
      : "This device is out of storage space, so changes may not be kept after the app closes. Download a backup in Settings to keep them.", 10000);
  }

  // Archiving a list (a packing list, say) is something you choose, from its ••• menu
  // or the toast after checking its last todo, once everything on it is checked.
  // Its todos go to Done with it, so "Use again" can bring the list back with all of
  // them unchecked. Now, Tomorrow and Later are the notebook's pages; they stay.
  const canArchive = (l) => !l.role && todosIn(l.id).length > 0 && todosIn(l.id).every(t => t.done);
  function archiveList(l) {
    todosIn(l.id).forEach(archive);
    touch(l, { archived: true, archivedDay: todayKey() });
  }

  // Checked todos move to Done: right away when the "doneNow" setting is on,
  // otherwise the morning after they were checked.
  function sweepDone() {
    const today = todayKey();
    let moved = 0;
    for (const t of board.todos) {
      // A checked step waits for its todo.
      if (!t.deleted && !t.archived && t.done && (board.settings.doneNow || (t.doneDay && t.doneDay < today)) && !isStep(t)) { archive(t); moved++; }
    }
    return moved;
  }

  // The morning ritual: yesterday's checked todos go to Done, and (optionally)
  // unfinished Tomorrow todos move into Now.
  function rollover() {
    const today = todayKey();
    // Builds before this one had a "Start next day" test button that could push
    // lastDay into the future; pull it back so mornings roll over again.
    if (!local.lastDay || local.lastDay > today) { local.lastDay = today; write(LOCAL_KEY, local); return sweepDone(); }
    if (local.lastDay === today) return sweepDone();
    const moved = sweepDone();
    if (board.settings.carry) {
      const nowL = lists().find(l => l.role === "now"), tomL = lists().find(l => l.role === "tomorrow");
      if (nowL && tomL) {
        // Only what was in Tomorrow before today began. A todo changed since midnight
        // was put in Tomorrow today (on another device, which already did its
        // morning), so it stays there.
        const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
        for (const { todo, order } of core.carryOver(board.todos, nowL.id, tomL.id, midnight.getTime() + (Number(local.clockOffset) || 0))) touch(todo, { listId: nowL.id, order });
      }
    }
    pencilNow();
    local.lastDay = today; write(LOCAL_KEY, local);
    return moved;
  }

  // "Pencil in for…": a todo on Later (or another of your own lists) with a day on
  // it moves to Tomorrow the morning before, or to Now on the day (core.pencilMoves).
  // Once it's on Now or Tomorrow the date comes off: it's just a todo again.
  const pencilKey = (d) => { const x = dayDate(); x.setDate(x.getDate() + d); return keyOf(x); };
  const canPencil = (t, l = listById(t.listId)) => !!l && !l.shared && l.role !== "now" && l.role !== "tomorrow" && !isStep(t);
  function pencilNow() {
    const nowL = lists().find(l => l.role === "now"), tomL = lists().find(l => l.role === "tomorrow");
    const moves = core.pencilMoves(board.todos, { nowId: nowL?.id, tomId: tomL?.id, today: todayKey(), tomorrow: pencilKey(1),
      carry: !!board.settings.carry, skip: new Set(board.lists.filter(l => l.shared).map(l => l.id)) });
    for (const { todo, listId, order } of moves) touch(todo, { listId, order, pencil: null });
    return moves;
  }

  // ---------- persistence + sync ----------
  let pushTimer = null, syncing = false, again = false;
  function commit() {
    if (local.pristine) { local.pristine = false; write(LOCAL_KEY, local); }
    write(BOARD_KEY, board);
    render();
    schedulePush();
  }
  function syncConfigured() { return !!(local.syncUrl && local.syncToken); }
  function dataUrl() { return local.syncUrl.replace(/\/+$/, "") + "/data"; }

  // ---------- sync status ----------
  // The badge in the header always says whether this device's edits have reached
  // the Worker, and which board it syncs with, so a wrong token or a dropped
  // connection is visible instead of silent.
  // A plain-words reason for a refused request.
  function answered(status) {
    if (status === 413) return "Your lists are too big to sync. Download a backup in Settings and send me a note, and I'll help.";
    if (status === 429 || status >= 500) return "The sync service is having trouble right now. Your changes are saved on this device and will sync later.";
    return `Sync didn't work (error ${status}). Your changes are saved on this device.`;
  }
  let syncError = "";   // last error from the Worker, cleared by the next good sync
  let netDown = false;  // the last request couldn't reach the Worker at all

  function stampsOf(b) {
    const m = xs => Object.fromEntries((xs || []).map(i => [i.id, i.updatedAt || 0]));
    return { lists: m(b.lists), todos: m(b.todos), settings: (b.settings && b.settings.updatedAt) || 0 };
  }
  function rememberServer(remote) { serverSeen = stampsOf(remote); write(SYNCED_KEY, serverSeen); }
  const isPending = (kind, i) => kind in serverSeen && (i.id in serverSeen[kind] ? (i.updatedAt || 0) > serverSeen[kind][i.id] : !i.deleted);
  // Lists, todos and settings edited here since the Worker last confirmed them.
  function pendingChanges() {
    if (!syncConfigured()) return [];
    const out = [];
    for (const l of board.lists) if (isPending("lists", l)) out.push(l);
    for (const t of board.todos) if (isPending("todos", t)) out.push(t);
    if (((board.settings && board.settings.updatedAt) || 0) > (serverSeen.settings || 0)) out.push(board.settings);
    return out;
  }
  const pendingTodoIds = () => new Set(syncConfigured() ? board.todos.filter(t => isPending("todos", t)).map(t => t.id) : []);

  const firstName = (name) => name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  // Owner boards are named after their TOKEN_<NAME> secret ("nate"). Invited boards
  // have a random id ("b_…") and whatever name the person gave when they joined.
  const isInvited = (id) => /^b_/.test(id || "");
  const boardName = (id = local.board) => firstName(id === local.board && local.boardName ? local.boardName : isInvited(id) ? "" : id);
  // "nate" -> "Nate's board"
  const boardLabel = (id) => {
    const name = boardName(id);
    if (name) return name + "'s board";
    return !id || id === local.board ? "your board" : "another board";
  };
  // Remembers what the Worker says about the board this token opens.
  // The Worker's clock, measured against this device's: half the round trip is
  // allowed for. Small differences are left alone.
  function noteClock(res, sentAt) {
    const server = Number(res.headers.get("X-Server-Time")), back = Date.now();
    if (!server || back - sentAt > 10_000) return;
    const off = Math.round(server - (sentAt + back) / 2);
    const next = Math.abs(off) < 2000 ? 0 : off;
    if (next !== (Number(local.clockOffset) || 0)) {
      local.clockOffset = next; write(LOCAL_KEY, local);
      lastStamp = 0; seeStamps(board);
    }
  }
  function noteBoard(res) {
    const id = res.headers.get("X-Board");
    if (!id) return;
    let name = "";
    try { name = decodeURIComponent(res.headers.get("X-Board-Name") || ""); } catch (e) {}
    local.board = id; local.boardName = name;
    local.boardKind = res.headers.get("X-Board-Kind") || (isInvited(id) ? "invited" : "owner");
    local.admin = res.headers.get("X-Board-Admin") === "1";
  }
  // 410: this device's board was deleted (from another device, or by the Worker's
  // owner on request). Turn sync off here and keep the lists that are on screen.
  function boardGone() {
    Object.assign(local, { syncUrl: "", syncToken: "", synced: false, board: "", boardName: "", boardKind: "", admin: false, otherBoard: "", switching: false });
    write(LOCAL_KEY, local);
    rememberServer({ lists: [], todos: [], settings: {} });
    const msg = "This board was deleted from the sync service, so sync is now off on this device. Your lists are still here.";
    setTimeout(() => { toast(msg, 8000); showStatus(); }, 0);
    return new Error(msg);
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  function lastSyncedText() {
    if (!local.lastSyncAt) return "Not synced yet";
    const d = new Date(local.lastSyncAt), today = new Date();
    return "Last synced " + (d.toDateString() === today.toDateString() ? "at " + clock(d) :
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + clock(d));
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function syncState() {
    if (!syncConfigured()) return "off";
    if (local.otherBoard || syncError) return "error";
    if (!navigator.onLine || netDown) return "offline";
    if (syncing || pushTimer) return "busy";
    return pendingChanges().length ? "pending" : "ok";
  }
  function showStatus() {
    const s = document.getElementById("syncStatus");
    const state = syncState(), n = pendingChanges().length, who = boardName();
    const unsynced = n ? ` · ${n} unsynced` : "";
    const label = {
      off: "On this device",
      error: "Sync problem" + unsynced,
      offline: "Offline" + unsynced,
      busy: "Syncing…",
      pending: `${n} unsynced`,
      ok: who ? `Synced · ${who}` : "Synced",
    }[state];
    s.dataset.state = state; s.textContent = label;
    // The badge only shows when something needs a look: offline, or a sync problem.
    // The rest of the time Settings > Sync says where things stand.
    s.hidden = !(state === "error" || state === "offline");
    document.body.dataset.sync = state;
    const lines = [];
    if (state === "off") lines.push("Lists are kept on this device only. Tap to set up sync.");
    else {
      if (local.board) lines.push(`Syncing with ${boardLabel(local.board)}.`);
      lines.push(lastSyncedText() + ".");
      if (n) lines.push(`${plural(n, "change")} saved here, not synced yet.`);
      if (syncError) lines.push(syncError);
    }
    s.title = lines.join(" ");
    s.setAttribute("aria-label", label + ". " + lines.join(" "));
  }
  // Kept for the call sites that only want the badge refreshed.
  const idleStatus = showStatus;

  // fetch() rejects with a TypeError when the Worker can't be reached at all (no
  // signal, captive Wi-Fi, DNS). That is "offline", not a sync problem.
  function syncFailed(e) {
    if (e instanceof TypeError) { netDown = true; syncError = ""; }
    else { netDown = false; syncError = e.message || String(e); }
    showStatus();
    return syncError || "Couldn't reach the sync service. Check the connection and try again.";
  }
  function syncSucceeded() {
    netDown = false; syncError = "";
    local.lastSyncAt = Date.now(); write(LOCAL_KEY, local);
  }

  // ---------- conflict hints ----------
  // Before merging the Worker's board in, find edits made here that are about to be
  // replaced by a newer edit from another device: the item changed on this device
  // since the last sync, and the Worker's copy also changed since then and is newer.
  function lostEdits(remote) {
    const out = [];
    const check = (kind, mine, theirs) => {
      const byId = new Map(mine.map(i => [i.id, i]));
      for (const r of theirs || []) {
        const m = byId.get(r.id);
        if (!m || !isPending(kind, m)) continue;
        const seen = serverSeen[kind][r.id] || 0;
        if ((r.updatedAt || 0) > seen && (r.updatedAt || 0) > (m.updatedAt || 0)) out.push({ kind, mine: m, theirs: r });
      }
    };
    check("lists", board.lists, remote.lists);
    check("todos", board.todos, remote.todos);
    return out;
  }
  let hintedAt = 0;
  function hintConflicts(lost) {
    if (!lost.length) return;
    hintedAt = Date.now();
    if (lost.length > 1) {
      toast(`${plural(lost.length, "edit")} on this device were replaced by newer changes from another device.`, 6000);
      return;
    }
    const { kind, mine, theirs } = lost[0];
    const name = kind === "lists" ? `The ${theirs.name || mine.name} list` : `“${short(theirs.text || mine.text)}”`;
    let msg;
    if (theirs.deleted) msg = `${name} was deleted on another device.`;
    else if (mine.deleted) msg = `${name} was changed on another device, so it's back.`;
    else msg = `${name} was also changed on another device. The newer version was kept.`;
    toast(msg, 6000);
  }
  const short = (text = "") => text.length > 40 ? text.slice(0, 38).trimEnd() + "…" : text;

  function schedulePush() {
    if (!syncConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; sync(); }, 1200);
    showStatus();
  }

  // Send our board; the Worker merges it with what it has and returns the result.
  async function sync() {
    if (!syncConfigured()) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { showStatus(); return "You're offline. Changes are saved on this device and will sync when you're back online."; }
    syncing = true; showStatus();
    try {
      // First sync on a device that still has only the welcome todos, or that is
      // switching from one person's board to another's: take the saved board as is,
      // so this device's lists aren't merged into it.
      if (!local.synced && (local.pristine || local.switching)) {
        const got = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken } });
        if (got.status === 401) throw new Error("The sync service didn't accept this device's access token.");
        if (got.status === 410) throw boardGone();
        if (got.status === 409) throw new Error(await clashMessage(got));
        if (!got.ok) throw new Error(answered(got.status));
        const remote = await got.json();
        // Older Done on this device went with the lists it had, so it goes too.
        if (remote.lists && remote.lists.some(l => !l.deleted)) { board = remote; rememberServer(remote); forgetOld(); }
      }
      const headers = { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" };
      if (local.board) headers["X-Expect-Board"] = local.board;
      // When this device last sent its board here (see dropRejected).
      const prevSent = local.synced ? local.sentAt || 0 : 0, sentAt = clockNow(), asked = Date.now();
      if (prevSent) headers["X-Synced-At"] = String(prevSent);
      const old = oldToSend();
      const res = await fetch(dataUrl(), { method: "PUT", headers, body: JSON.stringify(old.length ? Object.assign({}, board, { old }) : board) });
      noteClock(res, asked);
      if (res.status === 401) throw new Error("The sync service didn't accept this device's access token.");
      if (res.status === 410) throw boardGone();
      if (res.status === 409) throw new Error(await clashMessage(res));
      if (!res.ok) throw new Error(answered(res.status));
      const merged = await res.json();
      noteBoard(res);
      local.switching = false; local.otherBoard = "";
      const lost = local.synced ? lostEdits(merged) : [];
      // Edits made while the request was in flight are newer, so they survive the merge.
      board = mergeBoards(board, merged);
      dropRejected(merged, prevSent);
      rememberServer(merged);
      seeStamps(merged);
      oldSent(old);
      local.synced = true; local.sentAt = sentAt; lastPull = Date.now(); write(LOCAL_KEY, local);
      syncSucceeded();
      repairOrphans();
      packOld();
      write(BOARD_KEY, board);
      renderWhenFree();
      hintConflicts(lost);
      return true;
    } catch (e) {
      return syncFailed(e);
    } finally {
      syncing = false;
      if (again) { again = false; schedulePush(); }
      showStatus();
    }
  }
  // The Worker drops a deletion coming back from a device that was offline for months
  // (its tombstone was cleaned up after TOMBSTONE_DAYS): something it has never heard
  // of, last changed before this device's previous sync and before that cutoff. Drop
  // the same things here, or this device would keep showing them.
  function dropRejected(merged, prevSent) {
    if (!prevSent) return;
    const cutoff = Math.min(now() - TOMBSTONE_DAYS * 864e5, prevSent);
    for (const kind of ["lists", "todos"]) {
      const known = new Set((merged[kind] || []).map(i => i.id));
      board[kind] = board[kind].filter(i => known.has(i.id) || (i.updatedAt || 0) >= cutoff);
    }
  }
  // The Worker answers 409 instead of merging when the token opens a different
  // board than this device last synced with, or when two people share a token.
  async function clashMessage(res) {
    let info = {};
    try { info = await res.json(); } catch (e) {}
    if (info.error === "board changed") {
      local.otherBoard = info.board || "?"; write(LOCAL_KEY, local);
      return `This token now opens ${boardLabel(info.board)}, not ${boardLabel(info.expected)}. Nothing was synced. ` +
        `If that's a mistake, fix the token in the Worker. If it's what you want, tap Save and sync to switch this device to ${boardLabel(info.board)}.`;
    }
    if (info.error === "token clash") return `The Worker gives the same token to ${(info.boards || []).join(" and ")}. Nothing was synced. Give each person their own token.`;
    return answered(409);
  }
  // Fetch the saved board without sending ours, so a device that's just sitting open
  // picks up changes made elsewhere. This is a read, which is cheap: the Worker only
  // writes to KV on PUT, and KV's free tier allows far fewer writes than reads.
  // It stands aside whenever a push is due or running (that push returns the merged
  // board anyway) and while the person is typing or dragging, so it never
  // re-renders under their hands. The next poll catches up.
  // pull(true) is for a new morning (see checkDay): it waits for a sync that's
  // already running, doesn't stand aside for typing, and gives up after a few seconds.
  let lastPull = 0;
  async function pull(force = false) {
    if (!syncConfigured() || !local.synced || local.otherBoard) return;
    if (force) for (let i = 0; syncing && i < 25; i++) await new Promise(r => setTimeout(r, 200));
    if (syncing || !navigator.onLine || (!force && (pushTimer || busyForPull()))) return;
    syncing = true; lastPull = Date.now();
    const quit = new AbortController(), timer = force ? setTimeout(() => quit.abort(), 5000) : 0;
    try {
      const asked = Date.now();
      const res = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken }, cache: "no-store", signal: quit.signal });
      noteClock(res, asked);
      if (res.status === 401) throw new Error("The sync service didn't accept this device's access token.");
      if (res.status === 410) throw boardGone();
      if (res.status === 409) throw new Error(await clashMessage(res));
      if (!res.ok) throw new Error(answered(res.status));
      // Same board-identity guard as a push: never merge another person's board in.
      const who = res.headers.get("X-Board");
      if (local.board && who && who !== local.board) {
        local.otherBoard = who; write(LOCAL_KEY, local);
        throw new Error(`This token now opens ${boardLabel(who)}, not ${boardLabel(local.board)}. Nothing was synced. ` +
          `If that's a mistake, fix the token in the Worker. If it's what you want, tap Save and sync to switch this device to ${boardLabel(who)}.`);
      }
      const remote = await res.json();
      if (who) noteBoard(res);
      syncSucceeded();
      // Someone may have started typing or dragging while the request was out.
      if (!force && (pushTimer || busyForPull())) return;
      const lost = lostEdits(remote);
      const before = JSON.stringify(board);
      board = mergeBoards(board, remote);
      rememberServer(remote);
      seeStamps(remote);
      repairOrphans();
      packOld();
      const after = JSON.stringify(board);
      if (after !== before) { write(BOARD_KEY, board); renderWhenFree(); }
      hintConflicts(lost);
      // This device had edits the saved board lacks (say a push failed): send them.
      if (hasNewer(board, remote)) schedulePush();
    } catch (e) {
      if (e.name !== "AbortError") syncFailed(e);
    } finally {
      clearTimeout(timer);
      syncing = false;
      if (again) { again = false; schedulePush(); }
      showStatus();
    }
  }
  // True when a has a list, todo or settings edit that b doesn't.
  function hasNewer(a, b) {
    const newer = (x = [], y = []) => {
      const seen = new Map(y.map(i => [i.id, i.updatedAt || 0]));
      return x.some(i => !seen.has(i.id) ? !i.deleted : (i.updatedAt || 0) > seen.get(i.id));
    };
    return newer(a.lists, b.lists) || newer(a.todos, b.todos) ||
      ((a.settings && a.settings.updatedAt) || 0) > ((b.settings && b.settings.updatedAt) || 0);
  }
  // An empty, focused add box isn't an edit in progress (render() puts focus back),
  // and on a desktop it can stay focused for hours, so it doesn't hold off a pull.
  function busyForPull() {
    const a = document.activeElement;
    if (!drag && a && a.id && (a.id.startsWith("add-") || a.id === "doneSearch") && !a.value) return false;
    return isBusyEditing();
  }
  // Synced changes that arrive mid-edit wait for the edit to end, then show.
  let viewStale = false;
  // An open list or todo menu counts as busy too: redrawing the board closes it,
  // so a sync arriving a moment after it opened would make it vanish.
  function renderWhenFree() {
    if (busyForPull() || openPop) viewStale = true; else { viewStale = false; render(); }
  }
  document.addEventListener("focusout", () => setTimeout(() => { if (viewStale) renderWhenFree(); }, 0));
  document.addEventListener("pointerup", () => setTimeout(() => { if (viewStale) renderWhenFree(); }, 0));
  function isBusyEditing() {
    const a = document.activeElement;
    return drag || listDrag || (a && (a.isContentEditable || (a.tagName === "INPUT" && (a.type === "text" || a.type === "search")) || a.classList?.contains("col-title")));
  }

  // ---------- rendering ----------
  const boardEl = document.getElementById("board");
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v; else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach(c => c != null && n.append(c.nodeType ? c : document.createTextNode(c)));
    return n;
  };

  let openPop = null, popTrigger = null;
  // With `refocus`, focus goes back to the button that opened the menu (Esc, Tab).
  function closePop(refocus) {
    if (!openPop) return;
    const back = refocus && openPop.contains(document.activeElement) ? popTrigger : null;
    openPop.remove(); openPop = null; popTrigger = null;
    document.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
    if (back && back.isConnected) back.focus();
    if (viewStale) setTimeout(() => { if (viewStale) renderWhenFree(); }, 0);
  }
  document.addEventListener("pointerdown", e => { if (openPop && !openPop.contains(e.target) && !e.target.closest("[data-pop-trigger]")) closePop(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(true); });
  // Menus float above everything (so the last todo's menu isn't hidden under the add row), so close them if what they point at scrolls away.
  document.addEventListener("scroll", e => { if (openPop && !openPop.contains(e.target)) closePop(); }, true);
  window.addEventListener("resize", () => closePop());

  let unsyncedIds = new Set();
  function render() {
    const scroll = boardEl.scrollLeft;
    const focusedId = document.activeElement?.id;
    const rowFocused = !!document.activeElement?.matches?.(".todo[data-id]");
    // A choice from a menu (Move to, a color) redraws the board: focus goes back
    // to the menu's button rather than to the top of the page.
    const fromMenu = openPop && openPop.contains(document.activeElement) && popTrigger ? popTrigger.id : "";
    closePop();
    const ls = lists();
    unsyncedIds = pendingTodoIds();
    const dates = listDates(ls);
    boardEl.replaceChildren();
    ls.forEach(l => boardEl.append(renderList(l, dates.get(l.id))));
    const full = ls.length >= MAX_LISTS;
    boardEl.append(el("button", { class: "new-list", id: "addList", disabled: full, onclick: addList },
      full ? "List limit reached" : "+ New list", el("small", {}, `${ls.length} of ${MAX_LISTS}`)));
    boardEl.append(renderArchive());
    boardEl.scrollLeft = scroll;
    renderTabs(ls);
    if (fromMenu && document.getElementById(fromMenu)) document.getElementById(fromMenu).focus({ preventScroll: true });
    else if (focusedId && (focusedId.startsWith("add-") || focusedId === "doneSearch")) document.getElementById(focusedId)?.focus();
    else if (kbSel && (rowFocused || document.activeElement === document.body)) focusTodo(kbSel);
  }

  // On a phone only one list fits on screen, so a row of small tabs under the
  // header says which one you're on and jumps to any other, Done included.
  const tabsEl = document.getElementById("listTabs");
  const colFor = (id) => id === "done" ? boardEl.querySelector(".col.archive") : boardEl.querySelector(`.col[data-list="${CSS.escape(id)}"]`);
  const colLeft = (col) => col.getBoundingClientRect().left - boardEl.getBoundingClientRect().left + boardEl.scrollLeft - (parseFloat(getComputedStyle(boardEl).paddingLeft) || 0);
  function renderTabs(ls) {
    const items = [...ls.map(l => ({ id: l.id, name: l.name || "Untitled", c: safeColor(l.color) })), { id: "done", name: "Done", c: "#8a94a3" }];
    tabsEl.replaceChildren(...items.map(t => el("button", { type: "button", class: "tab", "data-for": t.id, style: `--c:${t.c}`,
      onclick: () => {
        const col = colFor(t.id); if (!col) return;
        const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
        boardEl.scrollTo({ left: colLeft(col), behavior: smooth ? "smooth" : "auto" });
      } }, t.name)));
    markTab();
  }
  let tabFrame = 0;
  function markTab() {
    if (!tabsEl.offsetParent) return; // hidden on wider screens
    let best = null, gap = Infinity;
    for (const col of boardEl.querySelectorAll(".col")) {
      const d = Math.abs(colLeft(col) - boardEl.scrollLeft);
      if (d < gap) { gap = d; best = col; }
    }
    const id = best ? (best.classList.contains("archive") ? "done" : best.dataset.list) : "";
    for (const b of tabsEl.children) {
      const on = b.dataset.for === id;
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
      if (on) { const r = b.getBoundingClientRect(), box = tabsEl.getBoundingClientRect(); if (r.left < box.left || r.right > box.right) tabsEl.scrollLeft += r.left - box.left - 16; }
    }
  }
  boardEl.addEventListener("scroll", () => { cancelAnimationFrame(tabFrame); tabFrame = requestAnimationFrame(markTab); }, { passive: true });
  window.addEventListener("resize", () => markTab());

  function renderList(list, dateKey) {
    const todos = todosIn(list.id);
    const dateText = dateKey ? pretty(dateKey) : "";
    const open = todos.filter(t => !t.done).length;
    const col = el("section", { class: "col" + (list.shared ? " shared" : ""), "data-list": list.id, style: `--c:${safeColor(list.color)}`, "aria-labelledby": "h-" + list.id });
    const head = el("div", { class: "col-head" });
    // The name is an input you can edit, so screen readers get a plain heading too.
    head.append(...[
      el("h2", { class: "sr-only", id: "h-" + list.id }, `${list.name}${dateText ? ", " + dateText : ""}, ${open} to do`),
      // Lists drag by this grip; keyboards and screen readers use Move list left/right in the ••• menu.
      el("button", { class: "grip list-grip", title: "Drag to move this list", tabindex: "-1", "aria-hidden": "true", onpointerdown: e => startListDrag(e, list, col) }, "⋮⋮"),
      el("button", { class: "swatch-btn", id: "color-" + list.id, title: "Change color", "aria-label": `Change ${list.name} color`, "data-pop-trigger": true, onclick: e => colorPop(e, list, head) }),
      el("input", {
        class: "col-title", value: list.name, "aria-label": "List name", maxlength: 30, id: "name-" + list.id,
        onchange: e => { const v = e.target.value.trim(); if (v && v !== list.name) { touch(list, { name: v }); commit(); } else e.target.value = list.name; },
        onkeydown: e => { if (e.key === "Enter") e.target.blur(); },
      }),
      list.shared ? el("button", { class: "shared-mark", type: "button", title: sharedWith(list), "aria-label": sharedWith(list), "data-pop-trigger": true, onclick: e => listPop(e, list, head) }, PEOPLE()) : null,
      el("span", { class: "count", title: "Unfinished", "aria-hidden": "true" }, String(open)),
      el("button", { class: "icon-btn", id: "opts-" + list.id, title: "List options", "aria-label": `${list.name} options`, "aria-haspopup": "menu", "data-pop-trigger": true, onclick: e => listPop(e, list, head) }, "•••"),
    ].filter(Boolean));
    const body = el("div", { class: "col-body", "data-drop": list.id });
    if (!todos.length) body.append(el("div", { class: "empty" }, list.role === "later" ? "Someday things go here." : "Nothing here yet."));
    for (const t of todos) {
      const kids = stepsOf(t);
      body.append(renderTodo(t, kids));
      kids.forEach(k => body.append(renderTodo(k, null, t)));
      if ((kids.length && !t.done) || stepFor === t.id) body.append(addStepRow(t));
    }
    const input = el("input", { type: "text", placeholder: `Add to ${list.name}…`, "aria-label": `Add to ${list.name}`, id: "add-" + list.id, enterkeyhint: "done" });
    const form = el("form", { class: "add", onsubmit: e => {
      e.preventDefault(); const v = input.value.trim(); if (!v) return;
      const order = Math.max(0, ...todos.map(t => t.order)) + 1;
      const id = uid();
      board.todos.push({ id, text: v, listId: list.id, order, done: false, doneDay: null, archived: false, updatedAt: now() });
      commit();
      // A long list keeps what was just added in view.
      rowOf(id)?.scrollIntoView({ block: "nearest" });
    } }, input, el("button", { class: "btn", type: "submit" }, "Add"));
    col.append(head);
    if (dateText) col.append(el("div", { class: "col-date", "aria-hidden": "true" }, dateText));
    col.append(body, form);
    return col;
  }

  // A todo's row. `kids` are its steps (for the "1 of 3" count); `parent` is set
  // when the row is itself a step.
  function renderTodo(t, kids, parent) {
    const hit = tagOn && (hasTag(t.text, tagOn) || (kids || []).some(k => hasTag(k.text, tagOn)) || (parent && hasTag(parent.text, tagOn)));
    const row = el("div", { class: "todo" + (t.done ? " done" : "") + (parent ? " step" : "") + (kids && kids.length ? " parent" : "") + (unsyncedIds.has(t.id) ? " unsynced" : "") + (tagOn ? (hit ? " tag-hit" : " tag-dim") : ""),
      "data-id": t.id, ...(parent ? { "data-parent": parent.id } : {}) });
    const text = el("div", { class: "text", ondblclick: () => editText(text, t) }, richText(t.text));
    const pencil = !parent && typeof t.pencil === "string" ? el("span", { class: "pencil", title: `Penciled in for ${pretty(t.pencil)}` }, pretty(t.pencil, { weekday: "short", month: "short", day: "numeric" })) : null;
    const done = kids && kids.length ? kids.filter(k => k.done).length : 0;
    row.append(...[
      // Dragging needs a pointer; keyboards and screen readers move todos from the ••• menu.
      el("button", { class: "grip", title: parent ? "Drag out to make it its own todo" : "Drag to move", tabindex: "-1", "aria-hidden": "true", onpointerdown: e => startDrag(e, t, row) }, "⋮⋮"),
      // The label around the box is the 44-point tap target; the box stays small.
      el("label", { class: "check-hit" }, el("input", { type: "checkbox", class: "check", checked: t.done, "aria-label": parent ? `${t.text}, a step of ${parent.text}` : t.text, onchange: e => checkTodo(t, e.target.checked, e.target) })),
      // The date it's penciled in for and the steps count sit on a small line under the text.
      pencil || (kids && kids.length) ? el("div", { class: "todo-main" }, text, el("div", { class: "todo-meta" },
        pencil, kids && kids.length ? el("span", { class: "prog", title: `${done} of ${kids.length} steps checked` }, `${done} of ${kids.length} steps`) : null)) : text,
      el("span", { class: "unsynced-dot", title: "Not synced yet", "aria-label": "Not synced yet" }),
      el("button", { class: "icon-btn more", id: "more-" + t.id, "aria-label": `Options for “${t.text}”`, "aria-haspopup": "menu", "aria-expanded": "false", "data-pop-trigger": true, onclick: e => todoPop(e, t, row, text) }, "•••"),
    ].filter(Boolean));
    return row;
  }

  // Checking a box. A todo's steps follow it; checking a todo's last step checks
  // the todo, and unchecking a step unchecks it.
  function checkTodo(t, checked, box) {
    const parent = parentOf(t);
    const top = parent || t;
    const list = listById(t.listId);
    let finished = false, topDone = false;
    const undo = undoable(family(top), () => {
      const day = checked ? todayKey() : null;
      touch(t, { done: checked, doneDay: day });
      if (!parent) stepsOf(t).forEach(k => { if (!!k.done !== checked) touch(k, { done: checked, doneDay: day }); });
      else if (checked && !parent.done && stepsOf(parent).every(k => k.done)) touch(parent, { done: true, doneDay: day });
      else if (!checked && parent.done) touch(parent, { done: false, doneDay: null });
      topDone = checked && top.done;
      // Read before Done-right-away moves this todo out of the list.
      finished = topDone && !!list && todosIn(list.id).every(x => x.done);
      // The last todo on one of your own lists: offer to archive it, not on the
      // notebook's pages. Checked todos stay put a moment so the offer can be taken.
      if (topDone && board.settings.doneNow && !(list && canArchive(list))) archive(top);
      commit();
    });
    // Only your own tap on the last box celebrates, never a sync or a reload.
    if (finished) confetti(box);
    if (topDone && list && canArchive(list)) {
      toast(`Everything on ${list.name} is done.`, undo, { label: "Archive list", run: () => archiveNow(list) });
    } else if (topDone) toast(board.settings.doneNow ? "Nice. Moved to Done." : "Nice. It moves to Done tomorrow morning.", undo);
  }

  // The "+ add a step" line under a todo with steps (or one just given its first).
  let stepFor = null; // a todo whose add-a-step line shows before it has any steps
  function addStepRow(p) {
    const input = el("input", { type: "text", class: "step-input", id: "add-step-" + p.id, placeholder: "+ add a step", "aria-label": `Add a step to ${p.text}`, enterkeyhint: "done",
      onkeydown: e => { if (e.key === "Escape") { e.stopPropagation(); input.value = ""; input.blur(); } },
      onblur: () => { if (stepFor === p.id && !input.value.trim()) setTimeout(() => { if (stepFor === p.id && document.activeElement !== input) { stepFor = null; render(); } }, 0); } });
    return el("form", { class: "todo addstep", "data-parent": p.id, onsubmit: e => {
      e.preventDefault(); const v = input.value.trim(); if (!v) return;
      const kids = stepsOf(p);
      board.todos.push({ id: uid(), text: v, listId: p.listId, parentId: p.id, order: Math.max(0, ...kids.map(k => k.order)) + 1, done: false, doneDay: null, archived: false, updatedAt: now() });
      // A new step means the todo isn't finished after all.
      if (p.done) touch(p, { done: false, doneDay: null });
      stepFor = p.id;
      commit();
    } }, input);
  }

  // Todo text with web addresses as links and #words as tags. Built from text
  // nodes and elements, never innerHTML.
  const RICH = /(https?:\/\/[^\s<>"]+)|(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,29})/gu;
  const tagKey = (name) => name.toLowerCase();
  const hasTag = (text, key) => { for (const m of String(text || "").matchAll(RICH)) if (m[3] && tagKey(m[3]) === key) return true; return false; };
  // Each tag gets the same color everywhere, from the list palette (gray left out).
  function tagColor(key) {
    let h = 0; for (const c of key) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return PALETTE[h % (PALETTE.length - 1)];
  }
  function linkLabel(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      return host + (u.pathname.length > 1 || u.search || u.hash ? "/…" : "");
    } catch (e) { return url; }
  }
  function richText(text) {
    text = String(text || "");
    const out = []; let at = 0;
    for (const m of text.matchAll(RICH)) {
      let start = m.index, end = m.index + m[0].length;
      if (m[1]) {
        // Trailing punctuation belongs to the sentence, not the address.
        let url = m[1];
        while (/[.,;:!?)\]'"]$/.test(url) && !(url.endsWith(")") && url.includes("("))) url = url.slice(0, -1);
        end = start + url.length;
        if (start > at) out.push(text.slice(at, start));
        out.push(el("a", { class: "link", href: url, target: "_blank", rel: "noopener noreferrer", title: url, onclick: e => e.stopPropagation(), ondblclick: e => e.stopPropagation() }, linkLabel(url)));
      } else {
        start += m[2].length;
        const key = tagKey(m[3]);
        if (start > at) out.push(text.slice(at, start));
        out.push(el("button", { type: "button", class: "tagmark", style: `--t:${tagColor(key)}`, "aria-pressed": String(tagOn === key),
          title: tagOn === key ? "Stop highlighting" : `Highlight every #${m[3]}`, onclick: e => { e.stopPropagation(); showTag(tagOn === key ? null : key); }, ondblclick: e => e.stopPropagation() }, "#" + m[3]));
      }
      at = end;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }

  // Tapping a #tag highlights every todo with it, on every list, until it's
  // tapped again, Clear is pressed or Esc. It's just a view: nothing is saved.
  let tagOn = null;
  const tagBar = el("div", { class: "tag-bar", role: "status", hidden: true });
  boardEl.before(tagBar);
  function showTag(key) {
    tagOn = key;
    render();
    if (!key) { tagBar.hidden = true; return; }
    const n = board.todos.filter(t => !t.deleted && !t.archived && hasTag(t.text, key) && listById(t.listId)).length;
    tagBar.replaceChildren(
      el("span", {}, "Highlighting ", el("strong", { style: `--t:${tagColor(key)}`, class: "tagmark static" }, "#" + key), ` · ${n} todo${n === 1 ? "" : "s"}`),
      el("button", { type: "button", class: "btn", onclick: () => showTag(null) }, "Clear"));
    tagBar.hidden = false;
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && tagOn && !openPop && !document.querySelector("dialog[open]") && !isTyping(document.activeElement)) showTag(null); });

  function editText(node, t) {
    // Links and tags go back to plain text while it's being edited.
    node.textContent = t.text;
    node.contentEditable = "true"; node.focus();
    document.getSelection().selectAllChildren(node);
    const finish = () => { const v = node.textContent.trim(); node.contentEditable = "false"; if (v && v !== t.text) { touch(t, { text: v }); commit(); } else render(); };
    node.addEventListener("blur", finish, { once: true });
    node.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); node.blur(); }
      if (e.key === "Escape") { node.textContent = t.text; node.blur(); }
    });
  }

  // Menus live on <body> with fixed positioning, so a list's scroll area can't clip them.
  // They open below the trigger, or above it when there isn't room below.
  function popAt(anchor, trigger, ...kids) {
    closePop();
    openPop = el("div", { class: "pop", role: "menu", "aria-label": trigger.getAttribute("aria-label") || "Menu", onkeydown: popKeys }, ...kids);
    openPop.querySelectorAll("button").forEach(b => { if (!b.getAttribute("role")) b.setAttribute("role", "menuitem"); });
    document.body.append(openPop);
    popTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    placePop(anchor, trigger, "right");
    // Focus moves into the menu, so a keyboard or screen reader lands on its first choice.
    popItems()[0]?.focus({ preventScroll: true });
    return openPop;
  }
  const popItems = () => openPop ? [...openPop.querySelectorAll("button:not([disabled]), input, select")] : [];
  // Up and Down (and Home, End) move through the menu; Tab leaves it and closes it.
  function popKeys(e) {
    const items = popItems(), i = items.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (go != null && items.length && e.target.tagName !== "INPUT") {
      e.preventDefault(); items[(go + items.length) % items.length].focus();
    } else if (e.key === "Tab") { e.preventDefault(); closePop(true); }
  }
  function placePop(anchor, trigger, align) {
    const pop = openPop, gap = 4, pad = 8;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const a = anchor.getBoundingClientRect(), t = trigger.getBoundingClientRect();
    pop.style.maxHeight = (vh - pad * 2) + "px";
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = align === "left" ? a.left + 8 : t.right - w;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    let top = t.bottom + gap;
    if (top + h > vh - pad) top = t.top - gap - h >= pad ? t.top - gap - h : Math.max(pad, vh - pad - h);
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }

  function todoPop(e, t, row, text) {
    const parent = parentOf(t);
    const trigger = e.currentTarget;
    const others = lists().filter(l => l.id !== t.listId);
    // Opening a part of the menu makes it bigger, so it's placed again to stay on screen.
    const reveal = (box) => { box.hidden = !box.hidden; placePop(row, trigger, "right"); box.querySelector("input, button")?.focus({ preventScroll: true }); };
    const copyBox = el("div", { hidden: true }), pencilBox = el("div", { hidden: true });
    const listButton = (l, run) => el("button", { class: "item", onclick: run }, el("span", { class: "dot", style: `background:${safeColor(l.color)}` }), l.name);
    popAt(row, e.currentTarget,
      parent ? null : el("div", { class: "lbl" }, "Move to"),
      parent ? null : others.map(l => listButton(l, () => { toast(`Moved to ${l.name}`, undoable(family(t), () => moveTodo(t, l.id, null))); })),
      el("div", { class: "lbl" }, parent ? "This step" : "This todo"),
      el("button", { class: "item", onclick: () => { closePop(); editText(text, t); } }, "Edit text"),
      parent ? null : el("button", { class: "item", onclick: () => { stepFor = t.id; closePop(); render(); document.getElementById("add-step-" + t.id)?.focus(); } }, stepsOf(t).length ? "Add a step" : "Add steps"),
      parent ? null : el("button", { class: "item", onclick: () => { closePop(); toast("Duplicated", copyTodo(t, t.listId, t)); } }, "Duplicate"),
      parent ? null : el("button", { class: "item", onclick: () => reveal(copyBox) }, "Copy to…"),
      copyBox,
      canPencil(t) ? el("button", { class: "item", onclick: () => reveal(pencilBox) }, typeof t.pencil === "string" ? "Change the date…" : "Pencil in for…") : null,
      pencilBox,
      parent ? el("button", { class: "item", onclick: () => { toast("It's its own todo now", undoable([t], () => moveTodo(t, t.listId, nextTopAfter(parent)))); } }, "Make it its own todo") : null,
      el("button", { class: "item danger", onclick: () => { toast("Deleted", undoable(family(t), () => { family(t).forEach(x => touch(x, { deleted: true })); commit(); })); } }, "Delete"),
    );
    copyBox.append(el("div", { class: "lbl" }, "Copy to"), ...lists().map(l => listButton(l, () => {
      closePop();
      const c = copyTodo(t, l.id, l.id === t.listId ? t : null);
      toast(l.id === t.listId ? "Duplicated" : `Copied to ${l.name}`, c);
    })));
    if (canPencil(t)) {
      const has = typeof t.pencil === "string";
      const day = el("input", { type: "date", class: "pencil-date", id: "pencil-" + t.id, min: todayKey(), value: has ? t.pencil : pencilKey(2), "aria-label": "Day to pencil it in for" });
      pencilBox.append(...[
        el("div", { class: "lbl note" }, board.settings.carry ? "It moves to Tomorrow the day before, then into Now on the day." : "It moves into Now on the day."),
        el("div", { class: "pencil-row" }, day, el("button", { class: "btn primary", type: "button", onclick: () => { if (day.value) pencilIn(t, day.value); } }, "Pencil in")),
        has ? el("button", { class: "item", onclick: () => pencilIn(t, null) }, "Take the date off") : null].filter(Boolean));
    }
  }

  // The first todo after `p` (and its steps) on p's list, so something can go right below it.
  function nextTopAfter(p) {
    const ts = todosIn(p.listId), i = ts.indexOf(p);
    return i >= 0 && ts[i + 1] ? ts[i + 1].id : null;
  }

  // Duplicate and Copy to: a fresh, unchecked copy, steps and all. `after` puts it
  // right below that todo; otherwise it goes at the end. Returns what Undo needs.
  function copyTodo(t, listId, after) {
    const list = listById(listId);
    const fresh = [];
    const undo = undoable([], () => {
      const twin = { id: uid(), text: t.text, listId, order: 0, done: false, doneDay: null, archived: false, updatedAt: now() };
      if (typeof t.pencil === "string" && list && canPencil(twin, list)) twin.pencil = t.pencil;
      board.todos.push(twin); fresh.push(twin);
      for (const k of stepsOf(t)) {
        const step = { id: uid(), text: k.text, listId, parentId: twin.id, order: k.order, done: false, doneDay: null, archived: false, updatedAt: now() };
        board.todos.push(step); fresh.push(step);
      }
      moveTodo(twin, listId, after ? nextTopAfter(after) : null);
    });
    // Undo of a copy deletes it: undo puts back each item's snapshot, so give it
    // "deleted" snapshots of the new todos.
    return undo.concat(fresh.map(x => ({ kind: "todos", id: x.id, snap: Object.assign(JSON.parse(JSON.stringify(x)), { deleted: true }), at: x.updatedAt })));
  }

  // Sets (or with null, clears) the day a todo is penciled in for. Today or
  // tomorrow move it right away, the same way the morning would.
  function pencilIn(t, day) {
    closePop();
    const undo = undoable(family(t), () => {
      touch(t, { pencil: day || null });
      pencilNow();
      commit();
    });
    const l = listById(t.listId);
    if (!day) toast("Date taken off", undo);
    else if (l && l.role === "now") toast(`Moved to ${l.name}`, undo);
    else if (l && l.role === "tomorrow") toast(`Moved to ${l.name}. It goes into Now in the morning.`, undo);
    else toast(`Penciled in for ${pretty(day, { weekday: "short", month: "short", day: "numeric" })}`, undo);
  }

  function colorPop(e, list, head) {
    let pending = null;
    const preview = c => { head.closest(".col").style.setProperty("--c", c); pending = c; };
    const apply = c => { touch(list, { color: c }); commit(); };
    popAt(head, e.currentTarget,
      el("div", { class: "lbl" }, "Page color"),
      el("div", { class: "swatches" }, [...PALETTE, ...DEEP].map((c, i) => el("button", {
        style: `background:${c}`, "aria-label": [...COLOR_NAMES, ...DEEP_NAMES][i], role: "menuitemradio", "aria-checked": String(c === list.color), onclick: () => apply(c),
      }))),
      el("label", { class: "custom-color" },
        el("input", { type: "color", value: safeColor(list.color), oninput: ev => preview(ev.target.value), onchange: ev => apply(ev.target.value) }),
        "Custom color"),
    );
    placePop(head, e.currentTarget, "left");
  }

  function listPop(e, list, head) {
    const count = todosIn(list.id).length;
    const ls = lists(), idx = ls.indexOf(list);
    const fallback = ls.find(l => l.id !== list.id && !l.shared);
    const confirmBox = el("div", { hidden: true });
    const leaveBox = el("div", { hidden: true });
    const canShare = !list.shared && list.role !== "now" && list.role !== "tomorrow";
    popAt(head, e.currentTarget,
      list.shared ? el("div", { class: "lbl shared-lbl" }, sharedWith(list)) : null,
      el("button", { class: "item", onclick: () => { closePop(); const i = document.getElementById("name-" + list.id); i.focus(); i.select(); } }, "Rename"),
      el("button", { class: "item", disabled: idx === 0, onclick: () => swapLists(list, ls[idx - 1]) }, "Move list left"),
      el("button", { class: "item", disabled: idx === ls.length - 1, onclick: () => swapLists(list, ls[idx + 1]) }, "Move list right"),
      el("button", { class: "item check-item", role: "menuitemcheckbox", "aria-checked": String(showsDate(list)),
        onclick: () => { closePop(); touch(list, { showDate: !showsDate(list) }); commit(); } }, "Show date"),
      !list.role ? el("button", { class: "item", onclick: () => askArchive(list) }, "Archive list…") : null,
      canShare ? el("button", { class: "item", onclick: () => { closePop(); shareList(list); } }, "Share list…") : null,
      list.shared ? el("button", { class: "item", onclick: () => { closePop(); manageShared(list); } }, "People and links…") : null,
      list.shared ? el("button", { class: "item danger", onclick: () => { leaveBox.hidden = false; } }, "Leave shared list…") : null,
      !list.shared && fallback ? el("button", { class: "item danger", onclick: () => { confirmBox.hidden = false; } }, "Delete list…") : null,
      confirmBox, leaveBox,
    );
    const others = (list.members || []).length - 1;
    leaveBox.append(
      el("div", { class: "lbl" }, others > 0 ? `It comes off your board and stays on ${others === 1 ? "the other person's" : `${others} other boards`}.` : "You're the only one on it, so it will be deleted."),
      el("button", { class: "item danger", onclick: () => { closePop(); leaveList(list); } }, "Yes, leave " + list.name),
    );
    confirmBox.append(
      el("div", { class: "lbl" }, count ? `${count} todo${count > 1 ? "s" : ""} will move to ${fallback?.name}` : "This list is empty"),
      el("button", { class: "item danger", onclick: () => {
        const undo = undoable([list, ...todosIn(list.id).flatMap(family)], () => {
          let o = Math.max(0, ...todosIn(fallback.id).map(t => t.order));
          todosIn(list.id).forEach(t => { const kids = stepsOf(t); touch(t, { listId: fallback.id, order: ++o }); kids.forEach(k => touch(k, { listId: fallback.id })); });
          touch(list, { deleted: true });
          commit();
        });
        toast(`Deleted ${list.name}`, undo);
      } }, "Yes, delete " + list.name),
    );
  }

  // A small yes-or-no box (askDlg). Resolves true for the main button. With no
  // `no`, it only has the one button, for when there's nothing to choose.
  const askDlg = document.getElementById("askDlg");
  function ask({ title, text, yes = "OK", no = "Cancel", danger = false }) {
    document.getElementById("askTitle").textContent = title;
    document.getElementById("askText").textContent = text;
    const yesBtn = document.getElementById("askYes"), noBtn = document.getElementById("askNo");
    yesBtn.textContent = yes; yesBtn.classList.toggle("danger", danger);
    noBtn.style.display = no ? "" : "none"; if (no) noBtn.textContent = no;
    askDlg.returnValue = "";
    askDlg.showModal();
    (no ? noBtn : yesBtn).focus();
    return new Promise(done => askDlg.addEventListener("close", () => done(askDlg.returnValue === "ok"), { once: true }));
  }

  // The ••• menu's Archive list: says what will happen and asks first, or, when
  // something on the list isn't checked yet, says what to do instead.
  async function askArchive(list) {
    closePop();
    const left = todosIn(list.id).filter(t => !t.done).length;
    if (!canArchive(list)) {
      await ask(left
        ? { title: `${list.name} isn't finished`, text: `${left} todo${left === 1 ? " is" : "s are"} still unchecked. Check off everything on it, then archive it.`, no: null }
        : { title: `Nothing on ${list.name} yet`, text: "Archiving is for a finished list, like a packing list after the trip. Add todos, check them all off, then archive it.", no: null });
      return;
    }
    const n = todosIn(list.id).length;
    const ok = await ask({
      title: `Archive ${list.name}?`,
      text: `It comes off the board and goes to Done with its ${n} todo${n === 1 ? "" : "s"}.` +
        (list.shared ? " It's archived for everyone it's shared with." : "") +
        " To bring it back, tap Use again under Archived lists in Done.",
      yes: "Archive list",
    });
    if (ok) archiveNow(list);
  }

  // Archives a list whose todos are all checked: it and its todos go to Done. On a
  // shared list that's for everyone on it, like a rename.
  function archiveNow(list) {
    closePop();
    if (!canArchive(list)) return;
    const undo = undoable([list, ...todosIn(list.id).flatMap(family)], () => { archiveList(list); commit(); });
    toast(list.shared ? `${list.name} archived for everyone on it. It's in Done.` : `${list.name} archived. It's in Done.`, undo);
  }
  // Brings an archived list back to the board with every todo on it unchecked,
  // ready for the next trip.
  function useAgain(list) {
    if (lists().length >= MAX_LISTS) { toast(`You have ${MAX_LISTS} lists already. Delete one to bring ${list.name} back.`, 5000); return; }
    const items = board.todos.filter(t => !t.deleted && t.archived && t.listId === list.id);
    const undo = undoable([list, ...items], () => {
      touch(list, { archived: false, archivedDay: null, order: Math.max(0, ...lists().map(l => l.order)) + 1 });
      items.forEach(t => touch(t, { archived: false, archivedDay: null, done: false, doneDay: null }));
      commit();
    });
    toast(`${list.name} is back with ${items.length} todo${items.length === 1 ? "" : "s"} to check.`, undo);
    document.querySelector(`[data-list="${list.id}"]`)?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }
  // Takes a list off the Archived lists shelf. Its todos stay in Done. For a shared
  // list that means leaving it (the Worker treats a deleted shared list that way).
  function forgetList(list) {
    toast(list.shared ? `Left ${list.name}. Its todos stay in Done.` : `Removed ${list.name}. Its todos stay in Done.`, undoable([list], () => { touch(list, { deleted: true }); commit(); }));
  }

  function swapLists(a, b) {
    const ao = a.order; touch(a, { order: b.order }); touch(b, { order: ao }); commit();
  }

  function addList() {
    const ls = lists();
    if (ls.length >= MAX_LISTS) return;
    const used = new Set(ls.map(l => l.color));
    const color = PALETTE.find(c => !used.has(c)) || PALETTE[ls.length % PALETTE.length];
    const list = { id: uid(), name: "New list", color, role: null, order: Math.max(0, ...ls.map(l => l.order)) + 1, updatedAt: now() };
    board.lists.push(list); commit();
    const i = document.getElementById("name-" + list.id);
    i.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); i.focus(); i.select();
  }

  // ---------- shared lists ----------
  // A shared list lives on its own on the Worker and shows up on the board of
  // everyone on it (see "Shared lists" in worker/worker.js). The Worker marks it
  // with list.shared (its id) and list.members (first names). Name, color and
  // todos are shared; where it sits on the board is each person's own.
  const PEOPLE = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 5.3a3 3 0 0 1 0 5.4M17.5 14.3c1.8.7 3 2.3 3.5 4.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    return svg;
  };
  function sharedWith(list) {
    const me = boardName();
    const others = (list.members || []).filter((n, i, a) => !(n === me && a.indexOf(n) === i));
    if (!others.length) return "Shared · just you for now";
    const names = others.length <= 3 ? others.join(", ").replace(/, ([^,]*)$/, " and $1") : `${others.slice(0, 2).join(", ")} and ${others.length - 2} more`;
    return "Shared with " + names;
  }
  async function sharedFetch(path, opts = {}) {
    const res = await fetch(workerBase() + "/shared" + path, Object.assign({ cache: "no-store" }, opts, {
      headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
    }));
    if (res.status === 401) throw new Error("The sync service didn't accept this device's access token.");
    if (res.status === 410) throw boardGone();
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) { const err = new Error(body.error || answered(res.status)); err.status = res.status; err.code = body.error; throw err; }
    return body;
  }
  const canUseShared = () => syncConfigured() && local.synced && !local.otherBoard;

  // Starts copying text that isn't known yet. Safari only lets a page copy during
  // the tap itself, so the copy begins now and the text follows once the sync
  // service has made the link. Resolves true if the link ended up copied.
  function copySoon(text) {
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        const blob = text.then(t => new Blob([t], { type: "text/plain" }));
        return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(() => true, () => false);
      }
    } catch (e) {}
    return text.then(t => navigator.clipboard.writeText(t)).then(() => true, () => false);
  }

  // Sharing has one place: People and links. "Share list…" on a list that isn't
  // shared yet opens it and makes the first link, and a shared list's menu opens it
  // with "People and links…". It shows who's on the list and every link nobody has
  // used yet, each with Copy (or Share… on a phone) and Withdraw, plus New link.
  // Everything happens inside it, so nothing flashes up in a toast and goes away.
  const peopleDlg = document.getElementById("peopleDlg");
  const LINK_LAG_MS = 90 * 1000; // how long KV's list can miss a link just made
  // pv: what the box shows. Links made or withdrawn on this device are remembered
  // per shared list (made, gone) for a while, because the Worker's list of links can
  // lag behind for up to a minute, even after the box is closed and opened again.
  let pv = null;
  const recentLinks = new Map(); // sid -> { made: Map(code -> link), gone: Set(code) }
  const linksFor = (sid) => {
    if (!recentLinks.has(sid)) recentLinks.set(sid, { made: new Map(), gone: new Set() });
    return recentLinks.get(sid);
  };
  const canSendSheet = () => !!navigator.share && matchMedia("(pointer: coarse)").matches;
  const shareUrl = (code) => appLink({ share: code, sync: workerBase() });

  async function shareList(list) {
    if (!canUseShared()) {
      if (peopleDlg.open) peopleDlg.close();
      openSettingsTo("sync");
      toast("Sharing a list needs sync. Turn it on here first.", 5000);
      return;
    }
    if (!navigator.onLine) { peopleSay("You're offline. Sharing needs a connection.", true); if (!peopleDlg.open) toast("You're offline. Sharing needs a connection.", 4000); return; }
    // Safari only lets a page copy during the tap, so the copy starts now and the
    // link follows once the sync service has made it.
    let give, fail;
    const linkText = new Promise((res, rej) => { give = res; fail = rej; });
    const copied = copySoon(linkText);
    let sid = list.shared;
    openPeople(list, sid);
    pv.making = true; drawPeople();
    try {
      if (!sid) {
        peopleSay(`Sharing ${list.name}…`);
        // The Worker moves the list as it has it, so send any edits here first.
        const first = await sync();
        if (first !== true) throw new Error(first);
        sid = (await sharedFetch("", { method: "POST", body: JSON.stringify({ listId: list.id }) })).sid;
        pv.sid = sid; Object.assign(pv, linksFor(sid));
        await sync();
      }
      const inv = await sharedFetch("/" + encodeURIComponent(sid) + "/invites", { method: "POST" });
      give(shareUrl(inv.code));
      if (!pv || pv.listId !== list.id) return;
      pv.made.set(inv.code, { code: inv.code, expires: inv.expires, mine: true, at: Date.now() });
      pv.fresh = inv.code; pv.copied = ""; pv.making = false;
      peopleSay("");
      drawPeople();
      copied.then(ok => { if (pv && pv.fresh === inv.code) { pv.copied = ok ? inv.code : ""; drawPeople(); } });
      await loadPeople();
    } catch (e) {
      fail(e);
      if (pv && pv.listId === list.id) { pv.making = false; drawPeople(); }
      const msg = e.code === "full" ? "This sync service has as many shared lists as it allows." :
        e.code === "can't share this list" ? "Now and Tomorrow can't be shared, because each morning moves todos between them. Make a new list to share." :
        e instanceof TypeError ? "Couldn't reach the sync service." : e.message;
      peopleSay((sid ? "Couldn't make a link: " : "Couldn't share: ") + msg, true);
      if (pv && !pv.info && !sid) { pv.failed = true; drawPeople(); }
    }
  }

  function manageShared(list) {
    if (!canUseShared()) { openSettingsTo("sync"); return; }
    openPeople(list, list.shared);
    drawPeople();
    loadPeople();
  }

  function openPeople(list, sid) {
    if (!pv || pv.listId !== list.id || !peopleDlg.open) {
      pv = { listId: list.id, name: list.name, sid, info: null, fresh: "", copied: "", making: false, failed: false,
        ...(sid ? linksFor(sid) : { made: new Map(), gone: new Set() }) };
      peopleSay("");
    }
    document.getElementById("peopleTitle").textContent = list.name;
    if (!peopleDlg.open) peopleDlg.showModal();
  }
  peopleDlg.addEventListener("close", () => { pv = null; });

  function peopleSay(text, bad) {
    const msg = document.getElementById("peopleMsg");
    msg.className = bad ? "msg bad" : "msg"; msg.textContent = text;
  }

  async function loadPeople() {
    const me = pv;
    if (!me || !me.sid) return;
    try {
      const also = [...me.made.values()].filter(i => Date.now() - i.at < LINK_LAG_MS).map(i => i.code);
      const info = await sharedFetch("/" + encodeURIComponent(me.sid) + (also.length ? "?also=" + also.join(",") : ""));
      if (pv !== me) return;
      me.info = info;
      document.getElementById("peopleTitle").textContent = me.name = info.name;
      drawPeople();
    } catch (e) {
      if (pv !== me) return;
      peopleSay(e instanceof TypeError ? "Couldn't reach the sync service." : e.message, true);
      if (!me.info) drawPeople();
    }
  }

  // The links to show: what the Worker says is open (it also checks the ones just
  // made here, see loadPeople), or until it has answered, the one just made. Ones
  // withdrawn here stay out even if the Worker's answer was already on its way.
  // The one just made comes first, then the newest.
  function openLinks() {
    const shown = [...(pv.info ? pv.info.invites : [])];
    const just = pv.made.get(pv.fresh);
    if (just && !shown.some(i => i.code === just.code)) shown.push(just);
    return shown.filter(i => !pv.gone.has(i.code))
      .sort((a, b) => (b.code === pv.fresh) - (a.code === pv.fresh) || String(b.expires).localeCompare(String(a.expires)));
  }

  function drawPeople() {
    if (!pv) return;
    const body = document.getElementById("peopleBody"), info = pv.info, name = pv.name;
    const keepFocus = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.key : "";
    const parts = [];
    if (!info && !pv.made.size) {
      parts.push(el("p", {}, pv.failed ? "" : pv.making ? `Making a link to share ${name}…` : "Loading…"));
      body.replaceChildren(...parts);
      return;
    }
    if (pv.fresh && openLinks().some(i => i.code === pv.fresh)) {
      parts.push(el("p", { class: "new-link-what" },
        (pv.copied === pv.fresh ? "Your new link is copied. " : "") +
        `Paste it into a text or email to the person you're sharing ${name} with. When they open it and tap Add list, ${name} shows up on their board, and you'll both see each other's changes.`));
    }
    if (info) {
      parts.push(el("h3", {}, "People"), el("ul", { class: "invite-list" }, info.members.map(m => el("li", {},
        el("span", {}, m.board === info.me ? `${m.name} (you)` : m.name),
        info.owner && m.board !== info.me ? el("button", { class: "btn danger", type: "button", "data-key": "rm-" + m.board, onclick: (ev) => removePerson(ev, m) }, "Remove") : null))));
      if (!info.owner) parts.push(el("p", { class: "note" }, `${info.members[0].name} has been on it longest, so they can take people off it.`));
    }
    const links = openLinks();
    parts.push(el("h3", {}, "Invite links"),
      el("p", { class: "note" }, "Each link adds one person and works for 14 days. Make one for each person you invite."));
    if (links.length) parts.push(el("ul", { class: "invite-list" }, links.map(linkRow)));
    parts.push(el("div", { class: "row start" }, el("button", { class: "btn" + (links.length ? "" : " primary"), type: "button", "data-key": "new", disabled: pv.making,
      onclick: () => shareList({ ...(listById(pv.listId) || { id: pv.listId, name }), shared: pv.sid }) }, pv.making ? "Making a link…" : links.length ? "Make another link" : "Make a link")));
    body.replaceChildren(...parts);
    if (keepFocus) body.querySelector(`[data-key="${CSS.escape(keepFocus)}"]`)?.focus();
  }

  function linkRow(i) {
    const fresh = i.code === pv.fresh, url = shareUrl(i.code);
    const who = fresh ? "Just made" : i.mine ? "Your link" : `${i.byName || "Someone"}'s link`;
    const copyBtn = el("button", { class: "btn" + (fresh ? " primary" : ""), type: "button", "data-key": "copy-" + i.code }, pv.copied === i.code ? "✓ Copied" : canSendSheet() ? "Share…" : "Copy");
    const field = el("input", { type: "text", readonly: true, value: url, "aria-label": "Invite link", hidden: true, onfocus: e => e.target.select() });
    copyBtn.addEventListener("click", async () => {
      if (canSendSheet()) {
        try { await navigator.share({ title: `Join my ${pv.name} list`, url }); return; } catch (e) { if (e.name === "AbortError") return; }
      }
      try {
        await navigator.clipboard.writeText(url);
        pv.copied = i.code; drawPeople();
        setTimeout(() => { if (pv && pv.copied === i.code) { pv.copied = ""; drawPeople(); } }, 4000);
      } catch (e) {
        field.hidden = false; field.focus(); field.select();
        peopleSay("Couldn't copy it here. The link is selected, so copy it from there.", true);
      }
    });
    const withdraw = el("button", { class: "btn", type: "button", "data-key": "wd-" + i.code, onclick: () => withdrawLink(i) }, "Withdraw");
    return el("li", { class: fresh ? "fresh" : "" },
      el("span", {}, `${who} · until ${shortDate(i.expires)}`),
      el("span", { class: "row" }, copyBtn, withdraw),
      field);
  }

  // The link goes from the box right away; if the sync service says no, it comes back.
  async function withdrawLink(i) {
    const me = pv;
    me.gone.add(i.code);
    if (me.fresh === i.code) me.fresh = "";
    peopleSay("Link withdrawn. It won't work anymore.");
    drawPeople();
    try { await sharedFetch("/" + encodeURIComponent(me.sid) + "/invites/" + encodeURIComponent(i.code), { method: "DELETE" }); }
    catch (e) {
      if (e.status !== 404) {
        me.gone.delete(i.code);
        if (pv === me) { peopleSay("Couldn't withdraw it: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message), true); drawPeople(); }
        return;
      }
      if (pv === me) peopleSay("That link was already used or withdrawn.");
    }
    if (pv === me) loadPeople();
  }

  async function removePerson(ev, m) {
    const me = pv;
    ev.currentTarget.disabled = true;
    try {
      await sharedFetch("/" + encodeURIComponent(me.sid) + "/members/" + encodeURIComponent(m.board), { method: "DELETE" });
      if (pv === me) peopleSay(`${m.name} is off ${me.name}. The list leaves their board on their next sync.`);
      await sync();
      if (pv === me) loadPeople();
    } catch (e) {
      if (pv === me) { peopleSay("Couldn't remove them: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message), true); drawPeople(); }
    }
  }

  async function leaveList(list) {
    const name = list.name; // the list object is a tombstone after the sync below
    if (!navigator.onLine) { toast("You're offline. Leaving a shared list needs a connection.", 4000); return; }
    try {
      const res = await sharedFetch("/" + encodeURIComponent(list.shared), { method: "DELETE" });
      await sync();
      toast(res.deleted ? `Left ${name}. You were the last one on it, so it's deleted.` : `Left ${name}. It's still on the others' boards.`, 5000);
    } catch (e) {
      if (e.status === 404) { await sync(); return; }
      toast("Couldn't leave: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message), 6000);
    }
  }

  // ---------- Done archive: search, filter, put back ----------
  // The search and filter live outside render() so they survive re-renders and syncs.
  // limit: how many Done rows are drawn. older: include Done from before OLD_DAYS.
  const doneView = { q: "", range: "all", list: "", limit: DONE_PAGE, older: false };
  const RANGES = [["all", "All"], ["today", "Today"], ["week", "This week"], ["month", "This month"]];
  const fold = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function rangeStart(range) {
    const d = dayDate();
    if (range === "today") return keyOf(d);
    if (range === "week") { d.setDate(d.getDate() - d.getDay()); return keyOf(d); } // weeks start on Sunday
    if (range === "month") { d.setDate(1); return keyOf(d); }
    return "";
  }
  function filteredArchive(items) {
    const words = fold(doneView.q).split(/\s+/).filter(Boolean);
    const since = rangeStart(doneView.range);
    return items.filter(a =>
      (!since || (a.archivedDay || "") >= since) &&
      (!doneView.list || a.fromName === doneView.list) &&
      words.every(w => fold(a.text).includes(w) || fold(a.fromName).includes(w)));
  }
  // Wraps each search word found in the text in <mark>, without touching innerHTML.
  function highlight(text) {
    const words = fold(doneView.q).split(/\s+/).filter(Boolean);
    if (!words.length) return text;
    const f = fold(text); // NFD folding can change length, so only highlight when it didn't
    if (f.length !== text.length) return text;
    const hits = [];
    words.forEach(w => { for (let i = f.indexOf(w); i !== -1; i = f.indexOf(w, i + w.length)) hits.push([i, i + w.length]); });
    hits.sort((a, b) => a[0] - b[0]);
    const out = []; let at = 0;
    for (const [s, e] of hits) {
      if (e <= at) continue;
      const from = Math.max(s, at);
      if (from > at) out.push(text.slice(at, from));
      out.push(el("mark", {}, text.slice(from, e))); at = e;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  function restoreTarget(a) {
    return listById(a.listId) || lists().find(l => l.name === a.fromName) || lists()[0];
  }

  function renderArchive() {
    let all = [];
    const gather = () => { all = doneView.older ? [...archived(), ...olderDone()] : archived(); };
    gather();
    // Searching looks through everything, older Done included.
    const reach = () => {
      if (doneView.older) return;
      doneView.older = true; gather();
      loadOlder().then(() => { if (col.isConnected) { gather(); fill(); } });
    };
    const col = el("section", { class: "col archive", "aria-labelledby": "h-done" });
    const count = el("span", { class: "count" });
    col.append(el("div", { class: "col-head" },
      el("h2", { class: "sr-only", id: "h-done" }, "Done"),
      el("span", { class: "swatch-btn", "aria-hidden": "true" }),
      el("div", { class: "col-title", "aria-hidden": "true" }, "Done"),
      count));
    const body = el("div", { class: "col-body" });
    const summary = el("div", { class: "done-summary", role: "status" });

    const search = el("input", { type: "search", id: "doneSearch", class: "done-search", placeholder: "Search Done…",
      "aria-label": "Search finished todos", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
      oninput: e => { doneView.q = e.target.value; doneView.limit = DONE_PAGE; if (doneView.q.trim()) reach(); fill(); },
      onkeydown: e => { if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = doneView.q = ""; doneView.limit = DONE_PAGE; fill(); } } });
    search.value = doneView.q;

    const chips = el("div", { class: "done-chips", role: "group", "aria-label": "When finished" },
      RANGES.map(([v, label]) => el("button", { type: "button", class: "chip", "data-range": v, "aria-pressed": String(doneView.range === v),
        onclick: () => { doneView.range = v; doneView.limit = DONE_PAGE; chips.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.range === v))); fill(); } }, label)));

    const names = [...new Set(all.map(a => a.fromName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (doneView.list && !names.includes(doneView.list)) doneView.list = "";
    const pick = el("select", { class: "done-list", "aria-label": "From list", onchange: e => { doneView.list = e.target.value; doneView.limit = DONE_PAGE; fill(); } },
      el("option", { value: "" }, "Any list"), names.map(n => el("option", { value: n }, n)));
    pick.value = doneView.list;

    const further = () => !doneView.older && doneView.range === "all" && mayHaveOlder()
      ? el("button", { type: "button", class: "btn more-done", onclick: () => { reach(); fill(); } }, `Look further back (before ${pretty(oldCutoff(), { month: "short", day: "numeric", year: "numeric" })})`)
      : null;
    if (all.length || mayHaveOlder()) col.append(el("div", { class: "done-tools" }, search, chips, el("div", { class: "done-meta" }, summary, names.length > 1 ? pick : null)));
    col.append(body);

    function fill() {
      const items = filteredArchive(all);
      const filtering = !!(doneView.q.trim() || doneView.range !== "all" || doneView.list);
      count.textContent = filtering ? `${items.length} of ${all.length}` : String(all.length);
      const n = items.length, plural = n === 1 ? "" : "s";
      const when = { today: "today", week: "this week", month: "this month" }[doneView.range];
      summary.textContent = !filtering ? "" : when && !doneView.q.trim() ? `${n} finished ${when}` : `${n} match${n === 1 ? "" : "es"}`;
      summary.hidden = !filtering;
      body.replaceChildren();
      if (!all.length && !filtering) { const shelf = finishedShelf(); body.append(...(shelf ? [shelf] : []), el("div", { class: "empty" }, oldLoading ? "Looking further back…" : "Finished todos land here each morning."), ...[further()].filter(Boolean)); return; }
      if (!items.length) {
        body.append(el("div", { class: "empty" }, oldLoading ? "Looking further back…" : doneView.q.trim() ? "Nothing in Done matches that." : "Nothing finished in this stretch yet."),
          el("button", { type: "button", class: "btn clear-filter", onclick: () => { doneView.q = ""; doneView.range = "all"; doneView.list = ""; doneView.limit = DONE_PAGE; render(); } }, "Show everything"));
        return;
      }
      const shelf = finishedShelf();
      if (shelf) body.append(shelf);
      let last = null;
      // Steps show in small type under their todo when both are in view.
      const shownIds = new Set(items.map(a => a.id));
      const kidsOf = new Map();
      for (const a of items) if (a.parentId && shownIds.has(a.parentId)) { if (!kidsOf.has(a.parentId)) kidsOf.set(a.parentId, []); kidsOf.get(a.parentId).push(a); }
      for (const a of items.slice(0, doneView.limit)) {
        if (a.parentId && shownIds.has(a.parentId)) continue;
        if (a.archivedDay !== last) { last = a.archivedDay; body.append(el("div", { class: "day-label" }, a.archivedDay ? pretty(a.archivedDay, { weekday: "short", month: "short", day: "numeric" }) : "Earlier")); }
        const target = restoreTarget(a);
        body.append(el("div", { class: "todo done" },
          el("span", { class: "dot", style: `background:${safeColor(a.fromColor)}` }),
          el("div", { class: "text" }, highlight(a.text)),
          el("button", { type: "button", class: "put-back", title: `Put back on ${target ? target.name : "a list"}`, "aria-label": `Put “${a.text}” back on ${target ? target.name : "a list"}`, onclick: () => restore(a) },
            el("span", { "aria-hidden": "true" }, "↩"), " ", target ? target.name : "")));
        for (const k of (kidsOf.get(a.id) || []).sort((x, y) => (x.order || 0) - (y.order || 0))) body.append(el("div", { class: "todo done done-step" }, el("div", { class: "text" }, highlight(k.text))));
      }
      // Drawing thousands of rows on every edit is what made a full Done slow.
      const rest = items.length - doneView.limit;
      if (rest > 0) body.append(el("button", { type: "button", class: "btn more-done", onclick: () => { doneView.limit += DONE_PAGE * 2; fill(); } }, `Show ${Math.min(rest, DONE_PAGE * 2)} more`));
      else body.append(...[further()].filter(Boolean));
    }
    fill();
    return col;
  }

  // Archived lists, above the finished todos. Shown unless a search or filter is
  // narrowing Done to something else.
  function finishedShelf() {
    const q = fold(doneView.q.trim());
    const shown = finishedLists().filter(l => (!doneView.list || doneView.list === l.name) && (doneView.range === "all" || (l.archivedDay || "") >= rangeStart(doneView.range)) && (!q || fold(l.name).includes(q)));
    if (!shown.length) return null;
    return el("div", { class: "shelf" },
      el("div", { class: "day-label" }, "Archived lists"),
      shown.map(l => {
        const n = board.todos.filter(t => !t.deleted && t.archived && t.listId === l.id).length;
        return el("div", { class: "shelf-item", style: `--c:${safeColor(l.color)}` },
          el("span", { class: "dot", style: `background:${safeColor(l.color)}` }),
          el("button", { type: "button", class: "shelf-name", title: `Show ${l.name}'s todos`, onclick: () => { doneView.list = l.name; doneView.q = ""; doneView.range = "all"; render(); } },
            el("strong", {}, l.name), el("small", {}, `${n} todo${n === 1 ? "" : "s"}${l.archivedDay ? " · " + pretty(l.archivedDay, { month: "short", day: "numeric" }) : ""}`)),
          el("button", { type: "button", class: "put-back", title: `Bring ${l.name} back with everything unchecked`, onclick: () => useAgain(l) }, el("span", { "aria-hidden": "true" }, "↩"), " Use again"),
          el("button", { type: "button", class: "icon-btn", title: "Remove from Archived lists", "aria-label": `Remove ${l.name} from Archived lists`, onclick: () => forgetList(l) }, "×"));
      }));
  }

  // Puts a finished todo back, unchecked, at the bottom of the list it came from.
  // Its steps come back with it, unchecked too.
  function restore(a) {
    const list = restoreTarget(a);
    if (!board.todos.includes(a)) {  // from older Done, steps and all
      board.todos.push(a);
      for (const k of olderDone()) if (k.parentId === a.id && !board.todos.includes(k)) board.todos.push(k);
    }
    const kids = a.parentId ? [] : board.todos.filter(k => k.parentId === a.id && !k.deleted && k.archived);
    const order = Math.max(0, ...todosIn(list.id).map(t => t.order)) + 1;
    const undo = undoable([a, ...kids], () => {
      const back = { archived: false, archivedDay: null, done: false, doneDay: null, listId: list.id };
      touch(a, { ...back, order, ...(a.parentId ? { parentId: null } : {}) });
      kids.forEach(k => touch(k, back));
      commit();
    });
    toast(`Put back on ${list.name}`, undo);
  }

  // ---------- moving & drag ----------
  // Moves a todo, and its steps with it. A step moved this way (dragged out, or
  // "Make it its own todo") becomes an ordinary todo. On Now or Tomorrow a
  // penciled-in date comes off.
  function moveTodo(t, listId, beforeId) {
    const kids = stepsOf(t);
    const siblings = todosIn(listId).filter(x => x.id !== t.id);
    let order;
    const bi = beforeId ? siblings.findIndex(x => x.id === beforeId) : -1;
    if (bi < 0) order = (siblings.at(-1)?.order ?? 0) + 1;
    else order = ((siblings[bi - 1]?.order ?? siblings[bi].order - 2) + siblings[bi].order) / 2;
    const to = listById(listId);
    const fields = { listId, order };
    if (t.parentId) fields.parentId = null;
    if (typeof t.pencil === "string" && !(to && canPencil({}, to))) fields.pencil = null;
    touch(t, fields);
    kids.forEach(k => { if (k.listId !== listId) touch(k, { listId }); });
    commit();
  }

  // One finger drags a todo by its grip. While it is held, a second finger can swipe the board
  // sideways to reach another list; holding the todo near the left or right edge also scrolls.
  let drag = null;
  function startDrag(e, t, row) {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    drag = {
      t, row, id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
      started: false, ghost: null, ph: el("div", { class: "placeholder" }), target: null, before: null,
      swipe: null, raf: 0,
    };
    document.body.classList.add("is-holding");
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("selectstart", noSelect);
    document.addEventListener("touchmove", noTouchScroll, { passive: false });
  }
  const noSelect = e => e.preventDefault();
  const noTouchScroll = e => { if (drag && drag.started) e.preventDefault(); };

  function beginDrag() {
    drag.started = true; closePop();
    document.getSelection()?.removeAllRanges();
    drag.ghost = el("div", { class: "ghost" }, drag.t.text); document.body.append(drag.ghost);
    drag.row.classList.add("dragging"); document.body.classList.add("is-dragging");
    // A todo's steps go with it.
    boardEl.querySelectorAll(`[data-parent="${CSS.escape(drag.t.id)}"]`).forEach(r => r.classList.add("dragging"));
    haptic("lift");
    drag.raf = requestAnimationFrame(edgeScroll);
  }

  // A second finger (or any other pointer) landing while a todo is held becomes the swipe finger.
  function onDown(e) {
    if (!drag || e.pointerId === drag.id) return;
    e.preventDefault(); e.stopPropagation();
    if (!drag.started) beginDrag();
    drag.swipe = { id: e.pointerId, x: e.clientX, scroll: boardEl.scrollLeft, lastX: e.clientX, v: 0, time: e.timeStamp };
  }

  function onMove(e) {
    if (!drag) return;
    const sw = drag.swipe;
    if (sw && e.pointerId === sw.id) {
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - sw.time);
      sw.v = (e.clientX - sw.lastX) / dt; sw.lastX = e.clientX; sw.time = e.timeStamp;
      boardEl.scrollLeft = sw.scroll - (e.clientX - sw.x);
      updateDrop();
      return;
    }
    if (e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      beginDrag();
    }
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    drag.ghost.style.left = (e.clientX - 20) + "px"; drag.ghost.style.top = (e.clientY - 18) + "px";
    updateDrop();
  }

  // Work out which list and position sit under the held todo. Called on every move and whenever the board scrolls under it.
  function updateDrop() {
    if (!drag || !drag.started) return;
    const x = drag.lastX, y = drag.lastY;
    const under = document.elementFromPoint(x, y);
    const col = under && under.closest(".col[data-list]");
    if (!col) { drag.ph.remove(); drag.target = null; return; }
    const body = col.querySelector(".col-body");
    // Drops land between todos, never among a todo's steps.
    const rows = [...body.querySelectorAll(".todo:not(.dragging):not(.step):not(.addstep)")];
    const before = rows.find(r => y < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
    if (drag.target !== col.dataset.list) document.querySelectorAll(".empty[hidden]").forEach(n => n.removeAttribute("hidden"));
    body.querySelector(".empty")?.setAttribute("hidden", "");
    if (before ? drag.ph.nextSibling !== before || drag.ph.parentNode !== body : drag.ph.parentNode !== body || drag.ph.nextSibling) {
      before ? body.insertBefore(drag.ph, before) : body.append(drag.ph);
    }
    if (drag.target && drag.target !== col.dataset.list) haptic("tick");
    drag.target = col.dataset.list; drag.before = before ? before.dataset.id : null;
  }

  // Holding the todo near a side of the board keeps scrolling that way, faster the closer it gets.
  function edgeScroll() {
    if (!drag || !drag.started) return;
    if (!drag.swipe) {
      const r = boardEl.getBoundingClientRect(), zone = Math.min(56, r.width / 6);
      const x = drag.lastX;
      let step = 0;
      if (x > r.right - zone) step = Math.ceil(14 * (x - (r.right - zone)) / zone);
      else if (x < r.left + zone) step = -Math.ceil(14 * ((r.left + zone) - x) / zone);
      if (step) {
        const before = boardEl.scrollLeft;
        boardEl.scrollLeft += step;
        if (boardEl.scrollLeft !== before) updateDrop();
      }
    }
    drag.raf = requestAnimationFrame(edgeScroll);
  }

  // When the swipe finger lifts, settle on the nearest list (or the next one if it was flicked).
  function settleBoard(v = 0) {
    const cols = [...boardEl.children];
    if (!cols.length) return;
    const pad = parseFloat(getComputedStyle(boardEl).paddingLeft) || 0;
    const base = boardEl.getBoundingClientRect().left + pad;
    const offsets = cols.map(c => boardEl.scrollLeft + c.getBoundingClientRect().left - base);
    let i = offsets.reduce((best, o, k) => Math.abs(o - boardEl.scrollLeft) < Math.abs(offsets[best] - boardEl.scrollLeft) ? k : best, 0);
    if (Math.abs(v) > 0.4) {
      const cur = offsets[i];
      if (v < 0 && cur <= boardEl.scrollLeft + 1) i = Math.min(cols.length - 1, i + 1);
      if (v > 0 && cur >= boardEl.scrollLeft - 1) i = Math.max(0, i - 1);
    }
    const max = boardEl.scrollWidth - boardEl.clientWidth;
    boardEl.scrollTo({ left: Math.max(0, Math.min(max, offsets[i])), behavior: "smooth" });
  }
  boardEl.addEventListener("scroll", () => updateDrop(), { passive: true });

  function onUp(e) {
    if (!drag) return;
    if (drag.swipe && e.pointerId === drag.swipe.id) {
      const v = drag.swipe.v; drag.swipe = null;
      settleBoard(v);
      return;
    }
    if (e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.removeEventListener("selectstart", noSelect);
    document.removeEventListener("touchmove", noTouchScroll);
    document.body.classList.remove("is-dragging", "is-holding");
    cancelAnimationFrame(d.raf);
    document.getSelection()?.removeAllRanges();
    if (!d.started) return;
    d.ghost.remove(); d.ph.remove();
    if (d.target && e.type !== "pointercancel") {
      haptic("drop");
      if (d.t.listId === d.target) moveTodo(d.t, d.target, d.before);
      else toast(`Moved to ${listById(d.target).name}`, undoable(family(d.t), () => moveTodo(d.t, d.target, d.before)));
    } else render();
  }

  // ---------- dragging a list ----------
  // A list drags sideways by the grip in its header. The columns reorder as it
  // passes them; near either edge the board scrolls. Dropping saves the new order.
  let listDrag = null;
  function startListDrag(e, list, col) {
    if (e.button !== 0 || drag || listDrag) return;
    e.preventDefault();
    listDrag = { list, col, id: e.pointerId, x: e.clientX, lastX: e.clientX, started: false, raf: 0 };
    document.body.classList.add("is-holding");
    window.addEventListener("pointermove", onListMove);
    window.addEventListener("pointerup", onListUp);
    window.addEventListener("pointercancel", onListUp);
    document.addEventListener("touchmove", noListScroll, { passive: false });
  }
  const noListScroll = e => { if (listDrag && listDrag.started) e.preventDefault(); };
  function onListMove(e) {
    const d = listDrag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.started) {
      if (Math.abs(e.clientX - d.x) < 6) return;
      d.started = true; closePop();
      d.col.classList.add("list-dragging"); document.body.classList.add("is-dragging");
      haptic("lift");
      d.raf = requestAnimationFrame(listEdgeScroll);
    }
    d.lastX = e.clientX;
    placeList();
  }
  // Puts the held list before the first other list whose middle is right of the finger.
  function placeList() {
    const d = listDrag; if (!d) return;
    const cols = [...boardEl.querySelectorAll(".col[data-list]")].filter(c => c !== d.col);
    const before = cols.find(c => { const r = c.getBoundingClientRect(); return d.lastX < r.left + r.width / 2; });
    const anchor = before || boardEl.querySelector(".new-list");
    if (d.col.nextElementSibling !== anchor) { boardEl.insertBefore(d.col, anchor); haptic("tick"); }
  }
  function listEdgeScroll() {
    const d = listDrag; if (!d || !d.started) return;
    const r = boardEl.getBoundingClientRect(), zone = Math.min(56, r.width / 6);
    let step = 0;
    if (d.lastX > r.right - zone) step = Math.ceil(14 * (d.lastX - (r.right - zone)) / zone);
    else if (d.lastX < r.left + zone) step = -Math.ceil(14 * ((r.left + zone) - d.lastX) / zone);
    if (step) { const b = boardEl.scrollLeft; boardEl.scrollLeft += step; if (boardEl.scrollLeft !== b) placeList(); }
    d.raf = requestAnimationFrame(listEdgeScroll);
  }
  function onListUp(e) {
    const d = listDrag;
    if (!d || e.pointerId !== d.id) return;
    listDrag = null;
    window.removeEventListener("pointermove", onListMove);
    window.removeEventListener("pointerup", onListUp);
    window.removeEventListener("pointercancel", onListUp);
    document.removeEventListener("touchmove", noListScroll);
    document.body.classList.remove("is-dragging", "is-holding");
    cancelAnimationFrame(d.raf);
    if (!d.started) return;
    d.col.classList.remove("list-dragging");
    if (e.type === "pointercancel") { render(); return; }
    haptic("drop");
    const ids = [...boardEl.querySelectorAll(".col[data-list]")].map(c => c.dataset.list);
    const ls = ids.map(id => listById(id)).filter(Boolean);
    const changed = ls.filter((l, i) => l.order !== i + 1);
    if (!changed.length) { render(); return; }
    const undo = undoable(changed, () => { ls.forEach((l, i) => { if (l.order !== i + 1) touch(l, { order: i + 1 }); }); commit(); });
    toast(`Moved ${d.list.name}`, undo);
  }

  // ---------- undo ----------
  // An undoable action copies the lists and todos it is about to change, makes the
  // change, and hands back what Undo needs. Undo puts the old fields back with a fresh
  // updatedAt, so the restored version is the newest edit and wins the merge on the
  // Worker and on other devices, like any other edit (a deleted todo comes back from
  // its tombstone the same way). If an item has changed again since, here or on
  // another device, Undo leaves that item alone rather than overwrite the newer edit.
  function undoable(items, change) {
    const before = items.map(o => ({ o, kind: board.lists.includes(o) ? "lists" : "todos", snap: JSON.parse(JSON.stringify(o)) }));
    change();
    return before.map(({ o, kind, snap }) => ({ kind, id: o.id, snap, at: o.updatedAt }));
  }
  let undoEntries = null;
  function undo() {
    const entries = undoEntries;
    if (!entries) return;
    undoEntries = null;
    let skipped = 0;
    for (const { kind, id, snap, at } of entries) {
      const o = board[kind].find(x => x.id === id);
      if (!o || (o.updatedAt || 0) !== at) { skipped++; continue; }
      for (const k of Object.keys(o)) if (!(k in snap)) delete o[k];
      Object.assign(o, snap, { updatedAt: now() });
    }
    if (skipped < entries.length) { repairOrphans(); commit(); }
    toast(!skipped ? "Undone" : skipped === entries.length ? "Couldn't undo. It was changed since then." : "Undone, except what was changed since then.");
  }
  // Cmd+Z / Ctrl+Z works while an Undo toast is showing, unless you're typing.
  document.addEventListener("keydown", e => {
    if (!undoEntries || e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (isBusyEditing() || dlg.open) return;
    e.preventDefault(); undo();
  });

  // ---------- toast ----------
  // Toasts with an Undo button stay up longer, and don't hide while a finger or mouse is on them.
  const toastEl = document.getElementById("toast");
  let toastTimer;
  // As a popover the toast sits in the top layer, so it shows above an open
  // Settings dialog instead of behind it. Older browsers keep the plain version.
  const toastOnTop = typeof toastEl.showPopover === "function";
  if (toastOnTop) toastEl.popover = "manual";
  function hideToast() { toastEl.hidden = true; undoEntries = null; if (toastOnTop) try { toastEl.hidePopover(); } catch (e) {} }
  // The second argument is either how long to show the toast (ms) or what Undo needs, from undoable().
  let toastMs = 2400;
  function armToast() { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, toastMs); }
  // An optional action ({ label, run }) adds a button before Undo, like "Archive list".
  function toast(msg, extra, action) {
    const undoInfo = Array.isArray(extra) ? extra : null;
    undoEntries = undoInfo && undoInfo.length ? undoInfo : null;
    toastMs = typeof extra === "number" ? extra : undoEntries || action ? 6000 : 2400;
    toastEl.replaceChildren(el("span", {}, msg));
    if (action) toastEl.append(el("button", { class: "toast-undo", type: "button", onclick: () => { clearTimeout(toastTimer); hideToast(); action.run(); } }, action.label));
    if (undoEntries) toastEl.append(el("button", { class: "toast-undo", type: "button", onclick: () => { clearTimeout(toastTimer); undo(); } }, "Undo"));
    toastEl.hidden = false;
    // Showing it again puts it above a dialog that opened after it. An open modal
    // dialog makes everything outside it inert, so the toast moves into that dialog
    // (it stays in the top layer, so it still sits at the bottom of the screen);
    // otherwise its Undo couldn't be tapped while Settings is open.
    const isModal = (d) => { try { return d.matches(":modal"); } catch (e) { return true; } };
    const host = [...document.querySelectorAll("dialog[open]")].reverse().find(isModal) || document.body;
    if (toastEl.parentElement !== host) host.append(toastEl);
    if (toastOnTop) try { toastEl.hidePopover(); toastEl.showPopover(); } catch (e) {}
    armToast();
  }
  toastEl.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  toastEl.addEventListener("pointerleave", () => { if (!toastEl.hidden && !toastEl.contains(document.activeElement)) armToast(); });
  // It waits while a keyboard or screen reader is on its buttons, too.
  toastEl.addEventListener("focusin", () => clearTimeout(toastTimer));
  toastEl.addEventListener("focusout", e => { if (!toastEl.hidden && !toastEl.contains(e.relatedTarget)) armToast(); });

  // ---------- settings ----------
  const dlg = document.getElementById("settings");
  document.getElementById("openSettings").addEventListener("click", () => {
    document.getElementById("carry").checked = !!board.settings.carry;
    document.getElementById(board.settings.doneNow ? "doneNow" : "doneLater").checked = true;
    document.getElementById("syncUrl").value = local.syncUrl;
    document.getElementById("syncToken").value = local.syncToken;
    const sm = document.getElementById("syncMsg");
    if (local.otherBoard || syncError) { sm.className = "msg bad"; sm.textContent = syncError || "This device's token now opens a different board. Nothing was synced."; }
    else { sm.className = "msg"; sm.textContent = syncSummary(); }
    showVersion();
    closeRestore(); backupMsg(""); loadSnapshots(); showSyncMore(); inviteMsg("");
    showSyncRow(); showPane("main");
    dlg.showModal();
    checkForUpdate();
  });
  // Settings has a main page and two sub-pages (Sync, Backups) in the same sheet.
  // The header swaps its title for a back button on a sub-page; Esc goes back first.
  const settingsTitle = document.getElementById("settingsTitle"), settingsBack = document.getElementById("settingsBack");
  let pane = "main";
  function showPane(name, from) {
    pane = name;
    dlg.querySelectorAll(".pane").forEach(p => { p.hidden = p.dataset.pane !== name; });
    const sub = dlg.querySelector(`.pane[data-pane="${name}"]`);
    settingsTitle.textContent = name === "main" ? "Settings" : sub.dataset.title;
    settingsBack.hidden = name === "main";
    dlg.classList.toggle("sub", name !== "main");
    dlg.querySelector(".settings-body").scrollTop = 0;
    if (name === "main") { showSyncRow(); if (from) dlg.querySelector(`[data-go="${from}"]`)?.focus(); }
    else if (dlg.open) settingsBack.focus();
  }
  dlg.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => showPane(b.dataset.go)));
  settingsBack.addEventListener("click", () => showPane("main", pane));
  dlg.addEventListener("cancel", e => { if (pane !== "main") { e.preventDefault(); showPane("main", pane); } });
  // Opens Settings straight to a sub-page, e.g. from the sync badge.
  function openSettingsTo(name) { document.getElementById("openSettings").click(); showPane(name); }
  // The Sync row on the main page says where things stand without opening it.
  function showSyncRow() {
    const sub = document.getElementById("syncRowSub"), state = syncState();
    sub.classList.toggle("bad", state === "error");
    if (state === "off") sub.textContent = "Off. Your lists stay on this device.";
    else if (state === "error") sub.textContent = "Needs a look. " + (local.otherBoard ? "This token opens a different board." : "The last sync didn't go through.");
    else sub.textContent = [local.board ? boardLabel(local.board).replace(/^./, c => c.toUpperCase()) : "", state === "offline" ? "Offline" : lastSyncedText()].filter(Boolean).join(" · ");
    document.getElementById("backupRowSub").textContent = syncConfigured() && local.synced
      ? "Download, restore and nightly copies." : "Download or restore a backup file.";
  }
  function syncSummary() {
    if (!syncConfigured()) return "";
    const n = pendingChanges().length;
    return [local.board ? `Syncing with ${boardLabel(local.board)}.` : "", lastSyncedText() + ".",
      n ? `${plural(n, "change")} on this device ${n === 1 ? "hasn't" : "haven't"} synced yet.` : ""].filter(Boolean).join(" ");
  }
  // Tapping the badge syncs now. On a phone there's no hover, so it also says what's wrong.
  document.getElementById("syncStatus").addEventListener("click", async () => {
    if (!syncConfigured()) { openSettingsTo("sync"); return; }
    const state = syncState(), n = pendingChanges().length;
    if (state === "error" && local.otherBoard) { openSettingsTo("sync"); return; }
    if (state === "offline" && !navigator.onLine) {
      toast(n ? `You're offline. ${plural(n, "change")} saved on this device will sync when you're back online.` : "You're offline. Changes will sync when you're back online.", 5000);
      return;
    }
    const asked = Date.now();
    const result = await sync();
    if (result === true && hintedAt < asked) toast(`Synced with ${boardLabel(local.board)}.`);
    else if (typeof result === "string") toast(result, 6000);
  });
  document.getElementById("carry").addEventListener("change", e => {
    board.settings = Object.assign({}, board.settings, { carry: e.target.checked, updatedAt: now() }); commit();
  });
  document.querySelectorAll('input[name="doneWhen"]').forEach(r => r.addEventListener("change", () => {
    board.settings = Object.assign({}, board.settings, { doneNow: document.getElementById("doneNow").checked, updatedAt: now() });
    const moved = sweepDone(); commit();
    if (moved) toast(`${moved} finished todo${moved === 1 ? "" : "s"} moved to Done.`);
  }));
  document.getElementById("saveSync").addEventListener("click", async () => {
    const msg = document.getElementById("syncMsg");
    const url = document.getElementById("syncUrl").value.trim();
    const token = document.getElementById("syncToken").value.trim();
    if ((url && !token) || (!url && token)) { msg.className = "msg bad"; msg.textContent = "Fill in both the address and the token, or leave both empty."; return; }
    if (url && !/^https:\/\//i.test(url)) { msg.className = "msg bad"; msg.textContent = "The address should start with https://"; return; }
    useSync(url, token);
    if (!url) { msg.className = "msg"; msg.textContent = "Sync is off. Lists stay on this device."; syncError = ""; netDown = false; idleStatus(); showSyncMore(); render(); return; }
    msg.className = "msg"; msg.textContent = "Connecting…";
    const result = await sync();
    if (result === true) { msg.textContent = `Connected to ${boardLabel(local.board)}. Your lists are synced.`; render(); showSyncMore(); setTimeout(() => dlg.close(), 1400); }
    else { msg.className = "msg bad"; msg.textContent = "Couldn't sync: " + result; }
  });
  // A new token (or a confirmed switch after a "board changed" warning) means a
  // different board: load it instead of merging this device's lists into it.
  function useSync(url, token) {
    if (url !== local.syncUrl || token !== local.syncToken || local.otherBoard) {
      local.synced = false; local.sentAt = 0;
      if (local.board) { local.switching = true; local.board = ""; }
      Object.assign(local, { boardName: "", boardKind: "", admin: false, otherBoard: "" });
      rememberServer({ lists: [], todos: [], settings: {} });
    }
    local.syncUrl = url; local.syncToken = token; write(LOCAL_KEY, local);
  }
  const workerBase = () => local.syncUrl.replace(/\/+$/, "");
  const appLink = (params) => location.origin + location.pathname + "#" + new URLSearchParams(params).toString();
  // Shares a link with the share sheet on a phone, or copies it on a computer.
  async function shareLink(link, title) {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title, url: link }); return "shared"; } catch (e) { if (e.name === "AbortError") return ""; }
    }
    try { await navigator.clipboard.writeText(link); return "copied"; } catch (e) { prompt("Copy this link:", link); return "shown"; }
  }

  // ---- sync extras: device link, invites (Worker admins), deleting the board ----
  function showSyncMore() {
    const on = syncConfigured() && local.synced && !local.otherBoard;
    document.getElementById("syncMore").hidden = !on;
    document.getElementById("quickAddZone").hidden = !on;
    quickMsg.textContent = "";
    document.getElementById("deleteZone").hidden = !(on && local.boardKind === "invited");
    document.getElementById("deleteBox").hidden = true;
    deviceMsg.textContent = "";
    document.getElementById("invites").hidden = !(on && local.admin);
    document.getElementById("advanced").hidden = !on;
    if (on && local.admin) loadInvites();
    if (on) loadDevices();
  }
  // Says what happened right under the button (a toast is easy to miss in
  // Settings) and what to do next with the link.
  const deviceBtn = document.getElementById("deviceLink");
  const deviceMsg = el("p", { class: "msg device-msg", role: "status" });
  deviceBtn.closest(".row").after(deviceMsg);
  let deviceTimer;
  deviceBtn.addEventListener("click", async () => {
    // The link carries a one-time code that works for a day, not this device's token.
    let code;
    try { ({ code } = await syncApi("/devices", { method: "POST" })); }
    catch (e) { deviceMsg.className = "msg device-msg bad"; deviceMsg.textContent = "Couldn't make a link: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message); return; }
    const how = await shareLink(appLink({ device: code, sync: workerBase() }), "Now or Later");
    if (!how) return;
    const next = "Open it on your other device within a day and tap Connect. It works once. That device then syncs with " + boardLabel(local.board) + ".";
    loadDevices();
    deviceMsg.className = "msg device-msg ok";
    deviceMsg.textContent = {
      copied: "Link copied. Send it to your other device (AirDrop, Messages or Mail to yourself, or a note). " + next,
      shared: "Link sent. " + next,
      shown: "Copy the link that was shown and send it to your other device. " + next,
    }[how];
    if (how === "copied") {
      deviceBtn.textContent = "Copied ✓";
      clearTimeout(deviceTimer);
      deviceTimer = setTimeout(() => { deviceBtn.textContent = "Copy link for another device"; }, 2500);
    }
  });

  // Calls the sync service with this device's token. Used for device links.
  async function syncApi(path, opts = {}) {
    const res = await fetch(workerBase() + path, Object.assign({ cache: "no-store" }, opts, {
      headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
    }));
    if (res.status === 410) throw boardGone();
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (res.status === 404 && path === "/devices" && !opts.method) throw new Error("old service");
    if (!res.ok) throw new Error(res.status === 404 ? "This sync service needs an update for device links." : body.error || "The sync service answered " + res.status + ".");
    return body;
  }
  // Devices connected with a link each have their own token, listed here so a lost
  // phone can be taken off. Devices set up another way (an invite, or by hand) aren't listed.
  async function loadDevices() {
    const ul = document.getElementById("deviceList"), note = document.getElementById("deviceNote");
    try {
      const { devices } = await syncApi("/devices");
      ul.replaceChildren(...devices.map(d => el("li", {},
        el("span", {}, `${d.label || "A device"}${d.me ? " (this one)" : ""} · added ${shortDate(d.created)}`),
        el("button", { class: "btn danger", type: "button", onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          try { await syncApi("/devices/" + encodeURIComponent(d.id), { method: "DELETE" }); note.textContent = `Removed. That ${d.label || "device"} stops syncing.`; loadDevices(); }
          catch (e) { note.textContent = "Couldn't remove it: " + e.message; }
        } }, d.me ? "Sign out" : "Remove"))));
      note.textContent = devices.length ? "" : "No devices added with a link yet.";
    } catch (e) { ul.replaceChildren(); note.textContent = e.message === "old service" ? "" : e.message; }
  }

  // Quick add from Shortcuts: the Worker's POST /add needs its address and this board's token.
  const quickMsg = document.getElementById("quickMsg");
  async function copyQuick(btn, value, label, what) {
    try { await navigator.clipboard.writeText(value); } catch (e) { prompt(`Copy ${what}:`, value); return; }
    quickMsg.className = "msg device-msg ok";
    quickMsg.textContent = what === "the address"
      ? "Address copied. Paste it as the URL in the Shortcut's Get Contents of URL action."
      : "Token copied. In the Shortcut, add a header named Authorization with the value Bearer, a space, then the token. Keep it private: it opens your lists.";
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = label; }, 2500);
  }
  document.getElementById("quickUrl").addEventListener("click", e => copyQuick(e.currentTarget, workerBase() + "/add", "Copy address", "the address"));
  document.getElementById("quickToken").addEventListener("click", e => copyQuick(e.currentTarget, local.syncToken, "Copy access token", "the token"));

  const inviteMsg = (text, bad) => { const m = document.getElementById("inviteMsg"); m.className = bad ? "msg bad" : "msg"; m.textContent = text; };
  async function adminFetch(path, opts = {}) {
    const res = await fetch(workerBase() + path, Object.assign({ cache: "no-store" }, opts, {
      headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
    }));
    if (res.status === 403) throw new Error("Only whoever runs the sync service can invite people.");
    if (!res.ok) throw new Error(answered(res.status));
    return res.json();
  }
  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  async function loadInvites() {
    const ul = document.getElementById("inviteList");
    try {
      const [inv, boards] = await Promise.all([adminFetch("/invites"), adminFetch("/boards")]);
      ul.replaceChildren(...inv.invites.map(i => el("li", {},
        el("span", {}, `${i.label || "Invite"} · expires ${shortDate(i.expires)}`),
        el("button", { class: "btn", type: "button", onclick: async () => {
          try { await adminFetch("/invites/" + encodeURIComponent(i.code), { method: "DELETE" }); inviteMsg("Invite revoked."); loadInvites(); }
          catch (e) { inviteMsg(e.message, true); }
        } }, "Revoke"))));
      const n = boards.boards.length;
      inviteMsg(n ? `${n} ${n === 1 ? "person has" : "people have"} joined by invite, out of ${boards.max} this sync service allows.` : "Nobody has joined by invite yet.");
    } catch (e) { ul.replaceChildren(); inviteMsg(e.message, true); }
  }
  document.getElementById("inviteMake").addEventListener("click", async () => {
    const label = document.getElementById("inviteLabel").value.trim();
    inviteMsg("Creating…");
    try {
      const inv = await adminFetch("/invites", { method: "POST", body: JSON.stringify({ label }) });
      const how = await shareLink(appLink({ join: inv.code, sync: workerBase() }), "Join me on Now or Later");
      document.getElementById("inviteLabel").value = "";
      await loadInvites();
      if (how === "copied") inviteMsg(`Invite link copied. It works once, until ${shortDate(inv.expires)}.`);
    } catch (e) { inviteMsg("Couldn't create an invite: " + e.message, true); }
  });

  document.getElementById("deleteBoard").addEventListener("click", () => {
    document.getElementById("deleteLocal").checked = false;
    document.getElementById("deleteWhat").textContent = `This permanently deletes ${boardLabel(local.board)}, its nightly copies and its access token from the sync service. Your other devices stop syncing. It can't be undone. Download a backup first if you might want your lists later.`;
    document.getElementById("deleteBox").hidden = false;
    document.getElementById("deleteBox").scrollIntoView({ block: "nearest" });
  });
  document.getElementById("deleteCancel").addEventListener("click", () => { document.getElementById("deleteBox").hidden = true; });
  document.getElementById("deleteGo").addEventListener("click", async () => {
    const msg = document.getElementById("syncMsg");
    msg.className = "msg"; msg.textContent = "Deleting…";
    try {
      const res = await fetch(workerBase() + "/data?confirm=delete", { method: "DELETE", headers: { "Authorization": "Bearer " + local.syncToken, "X-Expect-Board": local.board } });
      if (res.status === 403) throw new Error("These lists were set up by whoever runs the sync service. Ask them to delete them.");
      if (!res.ok && res.status !== 410) throw new Error(answered(res.status));
    } catch (e) {
      msg.className = "msg bad"; msg.textContent = "Couldn't delete: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message);
      return;
    }
    clearTimeout(pushTimer); pushTimer = null;
    Object.assign(local, { syncUrl: "", syncToken: "", synced: false, board: "", boardName: "", boardKind: "", admin: false, otherBoard: "", switching: false });
    rememberServer({ lists: [], todos: [], settings: {} });
    syncError = ""; netDown = false;
    if (document.getElementById("deleteLocal").checked) { board = starterBoard(); local.pristine = true; write(BOARD_KEY, board); }
    write(LOCAL_KEY, local);
    document.getElementById("syncUrl").value = ""; document.getElementById("syncToken").value = "";
    msg.textContent = "Your synced board was deleted. Sync is off on this device.";
    showSyncMore(); showStatus(); render();
  });

  // ---- opening an invite, device or shared list link ----
  // #join=<code>&sync=<worker> makes a new board on that Worker (POST /join).
  // #connect=<token>&sync=<worker> connects this device to an existing board.
  // #share=<code>&sync=<worker> adds someone's shared list to this board (POST /shared/join).
  // All live after the #, so the code or token never reaches the web server.
  const joinDlg = document.getElementById("joinDlg");
  let pendingLink = null;
  function readLink() {
    const p = new URLSearchParams(location.hash.slice(1));
    const sync = (p.get("sync") || "").trim(), join = p.get("join"), share = p.get("share"), device = p.get("device");
    // Links from before 1.17 carried the token itself (#connect=). They still work.
    const connect = p.get("connect");
    if (!(join || connect || share || device)) return;
    history.replaceState(null, "", location.pathname + location.search);
    let host = "";
    try { const u = new URL(sync); if (u.protocol === "https:") host = u.host; } catch (e) {}
    if (!host) { toast("That link is missing its sync address.", 5000); return; }
    pendingLink = { sync: sync.replace(/\/+$/, ""), join, connect, share, device };
    if (share) { showShareLink(host); return; }
    const had = syncConfigured() && local.synced;
    const what = join
      ? "You've been invited to sync Now or Later. Joining makes a board of your own, so your lists are saved and show up on your other devices."
      : "This link connects this device to an existing board, so it shows the same lists as your other devices.";
    let keep = "";
    if (join) keep = " The lists on this device go onto your new board." + (had ? ` This device stops syncing with ${boardLabel(local.board)}.` : "");
    else if (had) keep = ` This device stops syncing with ${boardLabel(local.board)} and shows that board instead.`;
    else if (!local.pristine) keep = " Lists on this device are added to that board.";
    document.getElementById("joinTitle").textContent = join ? "Join Now or Later sync" : "Connect this device";
    document.getElementById("joinWhat").textContent = what + keep;
    document.getElementById("joinNameRow").hidden = !join;
    document.getElementById("joinName").value = "";
    document.getElementById("joinHost").textContent = `Sync runs through ${host}.`;
    document.getElementById("joinGo").textContent = join ? "Join" : "Connect";
    document.getElementById("joinGo").disabled = false;
    document.getElementById("joinGo").hidden = false;
    document.getElementById("joinMsg").textContent = "";
    joinDlg.showModal();
  }
  // A shared list goes onto the board this device already syncs with, so it needs
  // sync turned on with the same Worker first.
  function showShareLink(host) {
    const same = canUseShared() && workerBase() === pendingLink.sync;
    document.getElementById("joinTitle").textContent = "Add a shared list";
    document.getElementById("joinWhat").textContent = same
      ? `Someone shared a list with you. It goes onto ${boardLabel(local.board)}, and changes either of you make show up for both. The rest of your board stays private.`
      : syncConfigured() && local.synced
        ? `Someone shared a list with you, but it's on a different sync service (${host}) from the one this device uses. Ask them to share it from the same one.`
        : "Someone shared a list with you. To add it, this device needs to sync first, because the list lives on the sync service. Ask the person who sent this for an invite link, or turn on sync in Settings, then open this link again.";
    document.getElementById("joinNameRow").hidden = true;
    document.getElementById("joinHost").textContent = `Sync runs through ${host}.`;
    document.getElementById("joinGo").textContent = "Add list";
    document.getElementById("joinGo").disabled = !same;
    document.getElementById("joinGo").hidden = !same;
    document.getElementById("joinMsg").textContent = "";
    joinDlg.showModal();
  }
  async function addSharedList(link, msg, go) {
    msg.className = "msg"; msg.textContent = "Adding…"; go.disabled = true;
    try {
      const res = await sharedFetch("/join", { method: "POST", body: JSON.stringify({ code: link.share }) });
      const result = await sync();
      if (result !== true) throw new Error(result);
      pendingLink = null;
      msg.textContent = res.already ? `${res.name} is already on your board.` : `Added ${res.name}${res.by ? `, shared by ${res.by}` : ""}. Changes either of you make show up for both.`;
      render();
      const l = board.lists.find(x => x.shared === res.sid);
      joinDone(() => { if (l) document.getElementById("name-" + l.id)?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); });
    } catch (e) {
      go.disabled = false;
      msg.className = "msg bad";
      msg.textContent = e instanceof TypeError ? "Couldn't reach the sync service. Check the connection and try again." :
        e.code === "invite not found" ? "This link has already been used or has expired. Ask for a new one." :
        e.code === "too many lists" ? `Your board already has ${MAX_LISTS} lists. Delete one to make room, then open the link again.` :
        e.code === "list full" ? "This list already has as many people as it can." : e.message;
    }
  }
  // Once it worked, the box stays up with what happened and a Done button, instead
  // of closing itself a moment later.
  let afterJoin = null;
  function joinDone(then = null) {
    afterJoin = then || (() => {});
    // What happened replaces what it was going to do.
    const msg = document.getElementById("joinMsg");
    document.getElementById("joinWhat").textContent = msg.textContent;
    msg.textContent = ""; document.getElementById("joinHost").textContent = "";
    document.getElementById("joinNameRow").hidden = true;
    const go = document.getElementById("joinGo");
    go.textContent = "Done"; go.disabled = false; go.hidden = false;
    document.getElementById("joinNo").hidden = true;
    go.focus();
  }
  joinDlg.addEventListener("close", () => {
    document.getElementById("joinNo").hidden = false;
    const then = afterJoin; afterJoin = null;
    if (then) then();
  });
  document.getElementById("joinGo").addEventListener("click", async () => {
    if (afterJoin) { joinDlg.close(); return; }
    const link = pendingLink; if (!link) return;
    if (link.share) return addSharedList(link, document.getElementById("joinMsg"), document.getElementById("joinGo"));
    const msg = document.getElementById("joinMsg"), go = document.getElementById("joinGo");
    msg.className = "msg"; msg.textContent = link.join ? "Joining…" : "Connecting…"; go.disabled = true;
    try {
      let token = link.connect;
      if (link.device) {
        const res = await fetch(link.sync + "/devices/connect", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: link.device, label: deviceName() }) });
        if (res.status === 404) throw new Error("This link has already been used or is more than a day old. Make a new one on your other device.");
        if (!res.ok) throw new Error("The sync service answered " + res.status + ".");
        token = (await res.json()).token;
        // The code is used up; if the sync below fails, trying again uses the token.
        link.connect = token; link.device = null;
        useSync(link.sync, token);
      } else if (link.join) {
        const res = await fetch(link.sync + "/join", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: link.join, name: document.getElementById("joinName").value.trim() }) });
        if (res.status === 404) throw new Error("This invite has already been used or has expired. Ask for a new one.");
        if (res.status === 503) throw new Error("This sync service is full right now. Ask whoever invited you.");
        if (!res.ok) throw new Error(answered(res.status));
        token = (await res.json()).token;
        // A brand-new board is empty: this device's lists become its first contents.
        useSync(link.sync, token);
        local.switching = false; write(LOCAL_KEY, local);
      } else {
        useSync(link.sync, token);
      }
      const result = await sync();
      if (result !== true) throw new Error(result);
      pendingLink = null;
      msg.textContent = `Connected to ${boardLabel(local.board)}.`;
      render(); showSyncMore();
      joinDone();
    } catch (e) {
      go.disabled = false;
      msg.className = "msg bad"; msg.textContent = e instanceof TypeError ? "Couldn't reach the sync service. Check the connection and try again." : e.message;
    }
  });

  // ---------- appearance (per device) ----------
  // Dark mode follows the system unless this device picked Light or Dark in Settings.
  // The colors live in styles.css; index.html applies the choice before first paint.
  const THEME_COLORS = { light: "#eef0f3", dark: "#12161c" };
  const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
  function applyTheme() {
    const t = local.theme === "light" || local.theme === "dark" ? local.theme : "system";
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    // Each meta normally matches its own color scheme; an override paints both.
    themeMetas.forEach(m => {
      const own = (m.getAttribute("media") || "").includes("dark") ? "dark" : "light";
      m.setAttribute("content", THEME_COLORS[t === "system" ? own : t]);
    });
  }
  // How todos are written and how strong list colors are, per device like the theme.
  const FONTS = ["hand", "neat", "print"];
  function applyLook() {
    const f = FONTS.includes(local.font) ? local.font : "hand";
    if (f === "hand") delete document.documentElement.dataset.font; else document.documentElement.dataset.font = f;
    if (local.colors === "bold") document.documentElement.dataset.colors = "bold"; else delete document.documentElement.dataset.colors;
  }
  document.querySelectorAll('input[name="font"]').forEach(r => r.addEventListener("change", () => { local.font = r.value; write(LOCAL_KEY, local); applyLook(); }));
  document.querySelectorAll('input[name="colors"]').forEach(r => r.addEventListener("change", () => { local.colors = r.value; write(LOCAL_KEY, local); applyLook(); }));
  document.querySelectorAll('input[name="theme"]').forEach(r => r.addEventListener("change", () => {
    local.theme = r.value; write(LOCAL_KEY, local); applyTheme();
  }));

  // ---------- confetti ----------
  // A real burst from the box that finished a list, plus a shower from the top of
  // the screen, so it's hard to miss. Plain DOM and the Web Animations API, nothing
  // to load. Skipped when the device asks for less motion.
  function confetti(from) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !document.body.animate) return;
    const r = from.getBoundingClientRect();
    const W = innerWidth, H = innerHeight;
    const layer = el("div", { class: "confetti", "aria-hidden": "true" });
    const colors = [...PALETTE.slice(0, 8), "#d9534f", "#2f5bd3"];
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    let longest = 0;
    // Each bit flies on a simple gravity arc with air drag, flipping like paper as it goes.
    const fling = (x, y, vx, vy, ms, i) => {
      const bit = el("i", {});
      const w = rand(8, 15), h = w * rand(0.45, 0.9);
      Object.assign(bit.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px", background: colors[i % colors.length], borderRadius: Math.random() < 0.25 ? "50%" : "2px" });
      layer.append(bit);
      const g = rand(700, 1000), drag = 2.2, spin = rand(-900, 900), flip = rand(540, 1440), sway = rand(10, 30);
      const fall = (t) => { const d = (1 - Math.exp(-drag * t)) / drag; return vy * d + g * (t - d) / drag; };
      // Long enough to fall past the bottom of the screen, however tall it is.
      let end = ms / 1000;
      while (y + fall(end) < H + 30 && end < 8) end += 0.1;
      ms = end * 1000;
      const frames = [];
      for (let k = 0; k <= 24; k++) {
        const t = (k / 24) * end;
        const d = (1 - Math.exp(-drag * t)) / drag;   // distance factor after drag
        const dx = vx * d + Math.sin(t * 6 + i) * sway * (t > 0.3 ? 1 : t / 0.3);
        frames.push({ transform: `translate(${dx}px, ${fall(t)}px) rotate(${spin * t}deg) rotateX(${flip * t}deg)` });
      }
      bit.animate(frames, { duration: ms, easing: "linear", fill: "forwards" });
      longest = Math.max(longest, ms);
    };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (let i = 0; i < 110; i++) {
      const a = -Math.PI / 2 + rand(-0.6, 0.6) * Math.PI;
      const v = rand(600, 1400);
      fling(x, y, Math.cos(a) * v, Math.sin(a) * v, rand(1500, 2500), i);
    }
    // A shower from just above the screen, across its whole width.
    for (let i = 0; i < 90; i++) {
      fling(rand(0, W), -20, rand(-120, 120), rand(0, 250), rand(1500, 2500), i + 3);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), longest + 100);
    haptic("drop");
  }

  // ---------- haptics (per device) ----------
  // Android and most non-Apple browsers have the Vibration API. Safari on iPhone
  // doesn't, but iOS 18 plays its own tick when a switch-style checkbox toggles,
  // so a hidden one stands in there. Macs and other desktops simply stay quiet.
  const canVibrate = typeof navigator.vibrate === "function";
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // Desktop Chrome has navigator.vibrate but no motor, so it only counts on touch screens.
  const hapticsSupported = isIOS || (canVibrate && matchMedia("(pointer: coarse)").matches);
  let hapticSwitch = null;
  function haptic(kind) {
    if (!hapticsSupported) return;
    if (canVibrate) { try { navigator.vibrate(kind === "drop" ? 18 : kind === "lift" ? 12 : 6); } catch (e) {} return; }
    if (!hapticSwitch) {
      hapticSwitch = el("label", { "aria-hidden": "true", style: "display:none" }, el("input", { type: "checkbox", switch: true, tabindex: "-1" }));
      document.head.append(hapticSwitch);
    }
    hapticSwitch.click();
  }
  document.getElementById("openSettings").addEventListener("click", () => {
    const t = ["light", "dark"].includes(local.theme) ? local.theme : "system";
    document.querySelector(`input[name="theme"][value="${t}"]`).checked = true;
    document.querySelector(`input[name="font"][value="${FONTS.includes(local.font) ? local.font : "hand"}"]`).checked = true;
    document.querySelector(`input[name="colors"][value="${local.colors === "bold" ? "bold" : "soft"}"]`).checked = true;
  });

  // ---------- keyboard shortcuts ----------
  // Arrow keys pick a todo (it takes focus, so the browser keeps it in view);
  // letters act on it. Nothing fires while typing in a box or with a dialog open.
  const keysDlg = document.getElementById("keys");
  let kbSel = null; // id of the todo picked with the keyboard
  const rowOf = id => id ? boardEl.querySelector(`.todo[data-id="${CSS.escape(id)}"]`) : null;
  const todoById = id => board.todos.find(t => t.id === id && !t.deleted && !t.archived);
  function focusTodo(id) {
    const r = rowOf(id);
    if (!r) { kbSel = null; return false; }
    kbSel = id; r.tabIndex = -1; r.focus();
    r.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }
  // The list most in view: the first one whose left edge is on screen.
  function listInView() {
    const ls = lists(), left = boardEl.getBoundingClientRect().left;
    return ls.find(l => boardEl.querySelector(`.col[data-list="${l.id}"]`)?.getBoundingClientRect().right > left + 40) || ls[0];
  }
  function focusAdd(list) {
    const i = list && document.getElementById("add-" + list.id);
    if (!i) return;
    kbSel = null;
    i.scrollIntoView({ block: "nearest", inline: "nearest" }); i.focus();
  }
  // After a todo leaves its list (checked into Done, deleted), pick its neighbor.
  function reselect(listId, idx) {
    if (kbSel && rowOf(kbSel) && todoById(kbSel)?.listId === listId) return focusTodo(kbSel);
    const rest = todosIn(listId);
    if (rest.length) focusTodo(rest[Math.min(idx, rest.length - 1)].id);
    else { kbSel = null; document.activeElement?.blur(); }
  }
  // The nearest list in direction dir (-1 or 1) that has todos.
  function neighborList(fromId, dir, needTodos) {
    const ls = lists();
    for (let i = ls.findIndex(l => l.id === fromId) + dir; i >= 0 && i < ls.length; i += dir) {
      if (!needTodos || todosIn(ls[i].id).length) return ls[i];
    }
    return null;
  }
  const isTyping = a => a && (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "SELECT" ||
    (a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "color"].includes(a.type)));
  const openSettingsDlg = () => { closePop(); if (keysDlg.open) keysDlg.close(); if (!dlg.open) document.getElementById("openSettings").click(); };
  const showKeys = () => { closePop(); if (dlg.open) dlg.close(); showKeysAlt(); if (!keysDlg.open) keysDlg.showModal(); };
  // The shortcuts that work anywhere (N, 1–9, comma, ?) are single keys unless this
  // device asks for Option (Alt) with them, so speaking or typing a word elsewhere
  // can't set them off. It's chosen in the shortcuts sheet itself.
  const keysAlt = document.getElementById("keysAlt");
  function showKeysAlt() {
    keysAlt.checked = !!local.keysAlt;
    keysDlg.querySelectorAll(".opt").forEach(k => { k.hidden = !local.keysAlt; });
  }
  keysAlt.addEventListener("change", () => { local.keysAlt = keysAlt.checked; write(LOCAL_KEY, local); showKeysAlt(); });
  // The key a shortcut means. With Option held, e.key is a special character on a Mac
  // (Option-N is a dead key), so read the physical key instead.
  function globalKey(e) {
    if (e.metaKey || e.ctrlKey) return "";
    if (!local.keysAlt) return e.altKey ? "" : e.key;
    if (!e.altKey) return "";
    const c = e.code || "";
    if (c === "KeyN") return "n";
    if (/^Digit[1-9]$/.test(c)) return c.slice(5);
    if (c === "Slash") return "?";
    if (c === "Comma") return ",";
    return "";
  }
  // A click or tap anywhere ends keyboard selection, so render() won't pull focus back.
  document.addEventListener("pointerdown", () => { kbSel = null; }, true);

  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing || drag) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k === ",") { e.preventDefault(); openSettingsDlg(); return; }
    const g = globalKey(e);
    if (!g && (e.metaKey || e.ctrlKey || e.altKey)) return;
    if (document.querySelector("dialog[open]")) return; // dialogs close themselves on Esc
    const a = document.activeElement;
    if (isTyping(a)) {
      if (k === "Escape" && a.id && a.id.startsWith("add-")) { a.value = ""; a.blur(); }
      return;
    }
    if (openPop) return; // Esc closes the menu (handled above)
    if (g === "?") { e.preventDefault(); showKeys(); return; }
    if (g === ",") { e.preventDefault(); openSettingsDlg(); return; }
    if (!e.shiftKey && (g === "n" || g === "N")) {
      e.preventDefault(); focusAdd(lists().find(l => l.role === "now") || lists()[0]); return;
    }
    if (/^[1-9]$/.test(g)) {
      const l = lists()[Number(g) - 1];
      if (l) { e.preventDefault(); focusAdd(l); }
      return;
    }
    if (e.altKey) return; // the rest only act on the selected todo, without modifiers

    const row = a && a.matches && a.matches(".todo[data-id]") ? a : null;
    const t = row ? todoById(row.dataset.id) : null;
    const key = { j: "ArrowDown", k: "ArrowUp", h: "ArrowLeft", l: "ArrowRight", J: "ArrowDown", K: "ArrowUp", H: "ArrowLeft", L: "ArrowRight" }[k] || k;
    const arrow = key.startsWith("Arrow");

    if (k === "Escape" && row) { kbSel = null; row.blur(); return; }
    if (arrow && !t) {
      // Nothing picked yet: start at the top of the list in view (or the first list with todos).
      e.preventDefault();
      const start = listInView();
      const l = start && todosIn(start.id).length ? start : lists().find(x => todosIn(x.id).length);
      if (l) focusTodo(todosIn(l.id)[0].id);
      return;
    }
    if (!t) return;
    const sibs = todosIn(t.listId), idx = sibs.findIndex(x => x.id === t.id);

    if (arrow && e.shiftKey) {
      e.preventDefault();
      if (key === "ArrowUp" && idx > 0) { moveTodo(t, t.listId, sibs[idx - 1].id); focusTodo(t.id); }
      else if (key === "ArrowDown" && idx < sibs.length - 1) { moveTodo(t, t.listId, sibs[idx + 2]?.id || null); focusTodo(t.id); }
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        const to = neighborList(t.listId, key === "ArrowLeft" ? -1 : 1, false);
        if (to) { const u = undoable(family(t), () => moveTodo(t, to.id, null)); focusTodo(t.id); toast(`Moved to ${to.name}`, u); }
      }
      return;
    }
    if (arrow) {
      e.preventDefault();
      if (key === "ArrowUp" && idx > 0) focusTodo(sibs[idx - 1].id);
      else if (key === "ArrowDown" && idx < sibs.length - 1) focusTodo(sibs[idx + 1].id);
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        const to = neighborList(t.listId, key === "ArrowLeft" ? -1 : 1, true);
        if (to) { const ts = todosIn(to.id); focusTodo(ts[Math.min(idx, ts.length - 1)].id); }
      }
      return;
    }
    if (k === "x" || k === "X" || k === " ") {
      e.preventDefault(); kbSel = t.id;
      row.querySelector(".check").click(); // same path as tapping the box, toast included
      reselect(t.listId, idx);
      return;
    }
    if (k === "Enter" || k === "e" || k === "E") {
      e.preventDefault(); kbSel = t.id;
      editText(row.querySelector(".text"), t);
      return;
    }
    if (k === "Backspace" || k === "Delete") {
      e.preventDefault(); kbSel = null;
      toast("Deleted", undoable(family(t), () => { family(t).forEach(x => touch(x, { deleted: true })); commit(); }));
      reselect(t.listId, idx);
    }
  });


  // ---------- backups ----------
  // A backup file is the board itself plus a few labels, so the same code reads a
  // downloaded file and a snapshot from the Worker.
  const backupMsg = (text, bad) => { const m = document.getElementById("backupMsg"); m.className = "msg" + (bad ? " bad" : ""); m.textContent = text; };
  const stampName = () => { const d = new Date(); return keyOf(d) + "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0"); };
  const live = (xs) => (xs || []).filter(x => x && !x.deleted);

  // On a phone the share sheet ("Save to Files") is the dependable way to keep a
  // file; a computer just downloads it.
  async function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    let file = null;
    try { file = new File([blob], name, { type }); } catch (e) {}
    if (file && matchMedia("(pointer: coarse)").matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) { if (e.name === "AbortError") return false; } // otherwise fall back to a download
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: name, style: "display:none" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return true;
  }

  function backupJson(b = board, owner = local.board) {
    return JSON.stringify({ app: "Now or Later", exportedAt: new Date().toISOString(), owner: owner || null,
      version: 1, settings: b.settings, lists: b.lists, todos: b.todos }, null, 2);
  }

  // One row per todo: the lists in board order, then everything in Done, newest first.
  function boardCsv() {
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+@\t]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [["List", "Todo", "Status", "Checked on", "Moved to Done on"]];
    for (const l of lists()) for (const t of todosIn(l.id)) for (const x of family(t)) rows.push([l.name, x === t ? x.text : "  - " + x.text, x.done ? "Checked" : "Open", x.doneDay || "", ""]);
    for (const t of [...archived(), ...olderDone()]) rows.push([t.fromName || "", t.text, "Done", t.doneDay || "", t.archivedDay || ""]);
    return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  // Backups include older Done, from this device and the Worker.
  document.getElementById("exportJson").addEventListener("click", async () => {
    await loadOlder();
    const all = Object.assign({}, board, { todos: [...board.todos, ...olderDone()] });
    if (await saveFile(`now-or-later-${stampName()}.json`, backupJson(all), "application/json")) backupMsg("Backup saved.");
  });
  document.getElementById("exportCsv").addEventListener("click", async () => {
    await loadOlder();
    if (await saveFile(`now-or-later-${stampName()}.csv`, boardCsv(), "text/csv")) backupMsg("CSV saved.");
  });

  // Checks a parsed file looks like a board and keeps only well-formed lists and todos.
  function readBackup(data) {
    if (!data || !Array.isArray(data.lists) || !Array.isArray(data.todos)) throw new Error("This file isn't a Now or Later backup.");
    const ok = (x) => x && typeof x === "object" && typeof x.id === "string";
    const lists = data.lists.filter(l => ok(l) && typeof l.name === "string");
    const todos = data.todos.filter(t => ok(t) && typeof t.text === "string");
    if (!live(lists).length) throw new Error("This backup has no lists in it.");
    return { owner: typeof data.owner === "string" ? data.owner : null, when: data.exportedAt || null,
      settings: data.settings && typeof data.settings === "object" ? data.settings : null, lists, todos };
  }

  // Restoring puts every list and todo in the backup back the way it was, stamped as
  // the newest edit so sync carries it to the other devices. Things added since the
  // backup stay unless "replace" is on, in which case they're deleted.
  function restoreBoard(bk, replace) {
    const t = now(), keep = new Set();
    const put = (items, into) => {
      for (const item of live(items)) {
        keep.add(item.id);
        const copy = Object.assign({}, item, { updatedAt: t });
        const cur = into.find(x => x.id === item.id);
        if (cur) { for (const k of Object.keys(cur)) if (!(k in copy)) delete cur[k]; Object.assign(cur, copy); }
        else into.push(copy);
      }
    };
    put(bk.lists, board.lists);
    put(bk.todos, board.todos);
    // Shared lists aren't only yours, so "replace" leaves them (and their todos) alone.
    const isShared = (x) => x.shared || (x.listId && listById(x.listId)?.shared);
    if (replace) for (const x of [...board.lists, ...board.todos]) if (!x.deleted && !keep.has(x.id) && !isShared(x)) touch(x, { deleted: true });
    if (bk.settings) board.settings = Object.assign({}, board.settings, bk.settings, { updatedAt: t });
    repairOrphans();
    sweepDone();
    commit();
  }

  let pendingRestore = null;
  function offerRestore(bk, label) {
    pendingRestore = bk;
    const n = live(bk.todos).filter(x => !x.archived).length, d = live(bk.todos).filter(x => x.archived).length;
    let text = `Restore ${label}? It has ${live(bk.lists).length} list${live(bk.lists).length === 1 ? "" : "s"}, ${n} todo${n === 1 ? "" : "s"} and ${d} in Done.`;
    if (bk.owner && local.board && bk.owner !== local.board) text += ` Heads up: it came from ${boardLabel(bk.owner)}, and this device syncs with ${boardLabel(local.board)}.`;
    document.getElementById("restoreWhat").textContent = text;
    document.getElementById("restoreReplace").checked = false;
    const box = document.getElementById("restoreBox");
    box.hidden = false; box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    backupMsg("");
  }
  function closeRestore() { pendingRestore = null; document.getElementById("restoreBox").hidden = true; }
  document.getElementById("restoreCancel").addEventListener("click", closeRestore);
  document.getElementById("restoreGo").addEventListener("click", async () => {
    if (!pendingRestore) return;
    const bk = pendingRestore, replace = document.getElementById("restoreReplace").checked;
    closeRestore();
    // Ask the Worker to keep a copy of the board as it is now, so a restore can itself
    // be undone later. If it can't, say so before going ahead.
    if (syncConfigured() && local.synced && !local.otherBoard) {
      backupMsg("Saving a copy of your lists first…");
      let saved = false;
      try { await snapFetch("?reason=before%20restore", { method: "POST" }); saved = true; } catch (e) {}
      if (!saved && !confirm("I couldn't save a copy of your lists on the sync service first, so this restore can only be undone right after it, on this device. Restore anyway?")) { backupMsg("Nothing was restored."); return; }
    }
    // This device's own copy, for the Undo on the toast.
    const before = JSON.parse(JSON.stringify({ settings: board.settings, lists: board.lists, todos: board.todos }));
    restoreBoard(bk, replace);
    backupMsg(syncConfigured() ? "Restored. Your other devices will pick it up on their next sync." : "Restored.");
    toast("Backup restored", 10000, { label: "Undo", run: () => { restoreBoard(before, true); toast("Restore undone"); } });
    loadSnapshots();
  });

  const fileInput = document.getElementById("importFile");
  document.getElementById("importJson").addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      const bk = readBackup(JSON.parse(await f.text()));
      const when = bk.when && !isNaN(new Date(bk.when)) ? new Date(bk.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
      offerRestore(bk, when ? `the backup from ${when}` : `“${f.name}”`);
    } catch (e) {
      closeRestore();
      backupMsg(e instanceof SyntaxError ? "That file couldn't be read as a backup." : e.message, true);
    }
  });

  // ---- copies kept by the Worker ----
  function snapUrl() { return local.syncUrl.replace(/\/+$/, "") + "/snapshots"; }
  async function snapFetch(path = "", opts = {}) {
    const res = await fetch(snapUrl() + path, Object.assign({ cache: "no-store" }, opts, { headers: { "Authorization": "Bearer " + local.syncToken } }));
    if (res.status === 404 && !path) throw new Error("This sync service doesn't keep backups yet.");
    if (res.status === 410) throw boardGone();
    if (!res.ok) throw new Error(answered(res.status));
    const who = res.headers.get("X-Board");
    if (local.board && who && who !== local.board) throw new Error("This token opens a different board.");
    return res.json();
  }
  const snapLabel = (s) => {
    const when = new Date(s.at || s.id);
    let text = isNaN(when) ? s.id : when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (typeof s.todos === "number") text += ` · ${s.todos} todo${s.todos === 1 ? "" : "s"}`;
    if (s.reason && s.reason !== "daily") text += ` · ${s.reason}`;
    return text;
  };
  let snapshots = [];
  async function loadSnapshots() {
    const box = document.getElementById("cloudBackups");
    if (!syncConfigured() || !local.synced || local.otherBoard || !navigator.onLine) { box.hidden = true; return; }
    try {
      const got = await snapFetch();
      snapshots = got.snapshots || [];
      const sel = document.getElementById("snapList");
      sel.replaceChildren(...snapshots.map(s => el("option", { value: s.id }, snapLabel(s))));
      const none = !snapshots.length;
      if (none) sel.append(el("option", { value: "" }, "No saved copies yet"));
      sel.disabled = none;
      document.getElementById("snapRestore").disabled = none;
      document.getElementById("snapDownload").disabled = none;
      document.getElementById("cloudInfo").textContent =
        `The sync service saves a copy of ${boardLabel(got.board || local.board)} each night it changes, and at least once a week, and keeps it for ${got.days || 30} days.` +
        (none ? " The first one is saved tonight." : "");
      box.hidden = false;
    } catch (e) {
      box.hidden = true; // an older Worker, or offline: the file backups above still work
    }
  }
  async function getSnapshot() {
    const id = document.getElementById("snapList").value;
    const s = snapshots.find(x => x.id === id);
    if (!s) return null;
    const data = await snapFetch("/" + encodeURIComponent(id));
    return { s, data };
  }
  document.getElementById("snapRestore").addEventListener("click", async () => {
    backupMsg("Loading…");
    try {
      const got = await getSnapshot(); if (!got) return backupMsg("");
      offerRestore(Object.assign(readBackup(got.data), { owner: local.board }), `the copy from ${snapLabel(got.s).split(" · ")[0]}`);
    } catch (e) { backupMsg("Couldn't load that copy: " + e.message, true); }
  });
  document.getElementById("snapDownload").addEventListener("click", async () => {
    backupMsg("Loading…");
    try {
      const got = await getSnapshot(); if (!got) return backupMsg("");
      const name = `now-or-later-${(got.s.at || got.s.id).slice(0, 16).replace(/[T:]/g, "-")}.json`;
      if (await saveFile(name, backupJson(got.data, local.board), "application/json")) backupMsg("Copy saved."); else backupMsg("");
    } catch (e) { backupMsg("Couldn't download that copy: " + e.message, true); }
  });

  // ---------- day changes & lifecycle ----------
  // On a new day, catch up with the other devices before the morning moves anything.
  // Otherwise this device would move yesterday's Tomorrow into Now from its old copy,
  // and those moves, being the newest edits, would undo anything changed elsewhere
  // this morning (a rename, a todo put back in Tomorrow or brought back from Done).
  let dayChecking = null;
  function checkDay() {
    if (!dayChecking) dayChecking = (async () => {
      try {
        if (local.lastDay !== todayKey() && syncConfigured() && local.synced && !local.otherBoard && navigator.onLine) await pull(true);
      } catch (e) {}
      const packed = packOld();
      if (rollover() || packed) commit(); else if (!isBusyEditing()) render();
    })().finally(() => { dayChecking = null; });
    return dayChecking;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkDay().then(sync);
  });
  window.addEventListener("online", () => { idleStatus(); sync(); });
  // A browser window on a Mac stays "visible" behind other windows, so coming back
  // to it only fires focus. Pull then, at most every few seconds.
  window.addEventListener("focus", () => { if (Date.now() - lastPull > 3000) pull(); });
  // While the app is on screen, check for changes from other devices every 20 seconds.
  // Hidden tabs don't poll; they catch up with a full sync when shown again.
  const POLL_MS = 20 * 1000;
  setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - lastPull >= POLL_MS - 1000) pull();
  }, POLL_MS);
  window.addEventListener("offline", idleStatus);
  setInterval(() => { if (local.lastDay !== todayKey()) checkDay(); }, 60 * 1000);

  // ---------- version & updates ----------
  function showVersion() {
    let text = `Version ${APP_VERSION}`;
    if (STAMPED) {
      const when = new Date(BUILD_DATE);
      text += ` · Build ${BUILD_NUMBER} (${BUILD_SHA})`;
      if (!isNaN(when)) text += ` · ${when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    } else {
      text += " · Local build";
    }
    document.getElementById("versionInfo").textContent = text;
  }
  // Send feedback: a plain email with the version and device filled in, so a
  // bug report says which build it's about without anyone digging through Settings.
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
    if (/iPhone|iPod/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return "Android";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    if (/CrOS/.test(ua)) return "Chromebook";
    if (/Linux/.test(ua)) return "Linux";
    return "Unknown device";
  }
  function feedbackLink() {
    const build = STAMPED ? `Build ${BUILD_NUMBER} (${BUILD_SHA})` : "Local build";
    const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const subject = `Now or Later feedback (${APP_VERSION}${STAMPED ? `, build ${BUILD_NUMBER}` : ""})`;
    const body = `\n\n\n---\nVersion ${APP_VERSION} · ${build}\nDevice: ${deviceName()}, ${installed ? "installed app" : "in the browser"}\n`;
    document.getElementById("feedbackLink").href =
      `mailto:hello@tweetingbirds.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  feedbackLink();
  // version.json is written at deploy time. If the live build differs from the
  // one running here, offer a reload so the page shows what's actually deployed.
  let liveBuild = null;
  // Remembers which build Reload was pressed for, so a reload that still comes
  // up on the old build doesn't throw the same "new version" toast again.
  const RELOAD_KEY = "nat.reloadFor";
  const reloadedFor = () => { try { return sessionStorage.getItem(RELOAD_KEY); } catch { return null; } };
  async function checkForUpdate() {
    if (!STAMPED || !navigator.onLine) return;
    const msg = document.getElementById("updateMsg"), btn = document.getElementById("reloadApp");
    try {
      const res = await fetch("version.json", { cache: "no-store" });
      // At the old address, version.json redirects to the new one: that's the move, not an update.
      if (!res.ok || res.redirected) return;
      const live = await res.json();
      // An older number means version.json itself is behind (a slow cache), not us.
      if (String(live.build) === BUILD_NUMBER || Number(live.build) < Number(BUILD_NUMBER)) {
        try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
        msg.textContent = "This is the latest version."; btn.hidden = true; return;
      }
      const fresh = liveBuild !== live.build;
      liveBuild = live.build;
      btn.hidden = false; btn.disabled = false;
      if (reloadedFor() === String(live.build)) {
        msg.textContent = `Build ${live.build} is out, but this device is still on the old files. Try Reload again in a few minutes.`;
        return;
      }
      msg.textContent = `Build ${live.build} is available.`;
      if (fresh && !dlg.open) toast(`A new version is ready. Open Settings to reload.`);
    } catch { /* offline or blocked: keep what we show */ }
  }
  // "New" on the What's New link until it's opened once after an update.
  function showWhatsNew() { document.getElementById("whatsNewDot").hidden = local.seenVersion === APP_VERSION; }
  document.getElementById("whatsNewLink").addEventListener("click", () => { local.seenVersion = APP_VERSION; write(LOCAL_KEY, local); showWhatsNew(); });
  showWhatsNew();

  // Reloading while the new service worker is still installing let the new page
  // load the old app.js, so it showed the same "new version" toast again. Wait
  // for the new worker to take over first (at most 10 seconds), then reload.
  document.getElementById("reloadApp").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    document.getElementById("updateMsg").textContent = "Updating…";
    try { if (liveBuild) sessionStorage.setItem(RELOAD_KEY, String(liveBuild)); } catch {}
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        const sw = reg.installing || reg.waiting;
        if (sw) await new Promise((done) => {
          setTimeout(done, 10000);
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
          sw.addEventListener("statechange", () => { if (sw.state === "activated" || sw.state === "redundant") done(); });
        });
      }
    } catch {}
    location.reload();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }

  // ---------- quick add from anywhere ----------
  // Text can arrive in the address, so other apps and shortcuts can drop a todo in:
  //   ?add=<text>           adds it to Now. Several lines add several todos.
  //   ?add                  (no text) opens the Now add box, for the Home Screen shortcut.
  //   &to=<list>            another list instead, by role (tomorrow, later) or by name.
  //   ?title=&text=&url=    what the share sheet sends (share_target in the manifest).
  // The address is cleaned up right after, so reloading doesn't add it twice.
  const quickTarget = (to) => core.quickTarget(lists(), to);
  function quickLines(p) {
    let text = p.get("add") || "";
    if (!text) {
      // Apps fill the share fields differently: a page often sends its title and
      // URL, a note sends only text, and some put the link inside the text.
      const title = (p.get("title") || "").trim(), body = (p.get("text") || "").trim(), url = (p.get("url") || "").trim();
      text = body || title;
      if (url && !text.includes(url)) text = text ? text + " " + url : url;
    }
    return core.quickLines(text);
  }
  function quickAdd() {
    const p = new URLSearchParams(location.search);
    if (!["add", "title", "text", "url"].some(k => p.has(k))) return false;
    const list = quickTarget(p.get("to"));
    const keep = new URLSearchParams(location.search);
    for (const k of ["add", "to", "title", "text", "url"]) keep.delete(k);
    history.replaceState(null, "", location.pathname + (keep.toString() ? "?" + keep : "") + location.hash);
    if (!list) return false;
    const lines = quickLines(p);
    if (!lines.length) { setTimeout(() => focusAdd(list), 300); return true; }
    let order = Math.max(0, ...todosIn(list.id).map(t => t.order));
    const t = now();
    const added = lines.map(text => ({ id: uid(), text, listId: list.id, order: ++order, done: false, doneDay: null, archived: false, updatedAt: t }));
    board.todos.push(...added);
    commit();
    // Undo turns them into tombstones, so a device that already synced them drops them too.
    const undo = added.map(x => ({ kind: "todos", id: x.id, snap: { id: x.id, listId: x.listId, deleted: true }, at: x.updatedAt }));
    toast(added.length === 1 ? `Added to ${list.name}` : `Added ${added.length} todos to ${list.name}`, undo);
    return true;
  }

  // ---------- welcome (first visit) ----------
  // Three short steps: what the lists are for, how a day works, and where lists live.
  // Shown once, to a device that had no lists when it opened the app. An invite, device
  // or shared-list link goes first, and the welcome follows when that dialog closes.
  // Settings > About > Welcome tour shows it again.
  const welcomeDlg = document.getElementById("welcome");
  const welcomeSteps = [...welcomeDlg.querySelectorAll(".welcome-step")];
  const welcomeDots = [...welcomeDlg.querySelectorAll(".welcome-dots li")];
  const welcomeNext = document.getElementById("welcomeNext"), welcomeBack = document.getElementById("welcomeBack");
  let welcomeAt = 0;
  function welcomeGo(i) {
    welcomeAt = Math.max(0, Math.min(welcomeSteps.length - 1, i));
    welcomeSteps.forEach((s, n) => { s.hidden = n !== welcomeAt; });
    welcomeDots.forEach((d, n) => d.classList.toggle("on", n === welcomeAt));
    welcomeBack.hidden = welcomeAt === 0;
    const last = welcomeAt === welcomeSteps.length - 1;
    welcomeNext.textContent = last ? "Start writing" : "Next";
    welcomeSteps[welcomeAt].scrollTop = 0;
  }
  function installHint() {
    if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return "";
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "In Safari, tap the Share button, then Add to Home Screen.";
    if (/Android/.test(ua)) return "In Chrome, tap the ⋮ menu, then Add to Home screen.";
    if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua)) return "In Safari, choose File, then Add to Dock.";
    if (/Chrome|Chromium|Edg/.test(ua)) return "Use the install button in the address bar to give it its own window.";
    return "";
  }
  function showWelcome() {
    const hint = installHint();
    document.getElementById("welcomeInstall").hidden = !hint;
    document.getElementById("welcomeInstallHow").textContent = hint;
    // Someone who just joined from a link is already syncing: say so instead of explaining links.
    const synced = syncConfigured() && local.synced;
    const linkItem = welcomeDlg.querySelector('[data-step="3"] .welcome-list li:nth-child(2) > span:last-child');
    const strong = document.createElement("strong");
    strong.textContent = synced ? "You're syncing." : "Got an invite or device link?";
    linkItem.replaceChildren(strong, synced
      ? `Your lists are saved to ${boardLabel(local.board)} and show up on your other devices. Settings → Sync has a link for adding another one.`
      : "Open it on this device and sync sets itself up, so your lists show up everywhere you use Now or Later.");
    document.getElementById("welcomeSync").hidden = synced;
    welcomeGo(0);
    if (!welcomeDlg.open) welcomeDlg.showModal();
    // With a mouse or keyboard, Return moves on. On touch, skip it so no focus ring shows.
    if (matchMedia("(hover: hover)").matches) welcomeNext.focus(); else document.activeElement?.blur();
  }
  function finishWelcome() {
    if (local.welcome !== "done") { local.welcome = "done"; write(LOCAL_KEY, local); }
    if (welcomeDlg.open) welcomeDlg.close();
  }
  welcomeNext.addEventListener("click", () => {
    if (welcomeAt < welcomeSteps.length - 1) { welcomeGo(welcomeAt + 1); return; }
    finishWelcome();
    // Start them where they'll write: the Now list's add box (not on touch, where the keyboard would pop up).
    if (matchMedia("(hover: hover)").matches) document.querySelector(".add input")?.focus();
  });
  welcomeBack.addEventListener("click", () => { welcomeGo(welcomeAt - 1); (welcomeBack.hidden ? welcomeNext : welcomeBack).focus(); });
  welcomeDlg.addEventListener("close", () => { if (local.welcome !== "done") { local.welcome = "done"; write(LOCAL_KEY, local); } });
  welcomeDlg.addEventListener("keydown", e => {
    if (e.target.closest("a, input")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); if (welcomeAt < welcomeSteps.length - 1) welcomeGo(welcomeAt + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); welcomeGo(welcomeAt - 1); }
  });
  // Swipe between steps on touch screens.
  let swipeX = null, swipeY = 0;
  welcomeDlg.addEventListener("touchstart", e => { if (e.touches.length === 1) { swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY; } }, { passive: true });
  welcomeDlg.addEventListener("touchend", e => {
    if (swipeX == null) return;
    const dx = e.changedTouches[0].clientX - swipeX, dy = e.changedTouches[0].clientY - swipeY; swipeX = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && welcomeAt < welcomeSteps.length - 1) welcomeGo(welcomeAt + 1);
    else if (dx > 0) welcomeGo(welcomeAt - 1);
  });
  document.getElementById("welcomeRestore").addEventListener("click", () => {
    finishWelcome(); openSettingsTo("backups"); document.getElementById("importJson").click();
  });
  document.getElementById("welcomeSync").addEventListener("click", () => { finishWelcome(); openSettingsTo("sync"); });
  document.getElementById("showWelcome").addEventListener("click", () => { dlg.close(); showWelcome(); });
  // After an invite or device link's dialog closes (joined or not), a first visit still gets its welcome.
  joinDlg.addEventListener("close", () => { if (local.welcome === "pending") setTimeout(showWelcome, 250); });
  function maybeWelcome() {
    if (local.welcome !== "pending") return;
    if (document.querySelector("dialog[open]")) return; // a link's dialog is up; its close shows the welcome
    showWelcome();
  }

  // ---------- no zoom ----------
  // iOS ignores user-scalable=no, so stop Safari's pinch gestures here. Two-finger
  // touchmoves are pinches too; one-finger scrolling and drags are untouched.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // The keyboard can nudge the whole page up on iOS and leave it there after it closes,
  // which lets list scrolling move the page. Put the page back once nothing is being typed in.
  const isField = n => n && (n.matches("input, select, textarea") || n.isContentEditable);
  document.addEventListener("focusout", () => setTimeout(() => {
    if (!isField(document.activeElement) && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
  }, 150));

  // ---------- arriving from the old address ----------
  // The app moved from now-or-later.tweetingbirds.com to now-or-later.app. Browsers
  // keep localStorage per address, so a small Worker at the old address (mover/ in
  // the repo) packs that device's storage into #move=<payload> and sends it here.
  // The payload sits after the #, so it never reaches a server.
  const MOVE_KEYS = [BOARD_KEY, LOCAL_KEY, SYNCED_KEY];
  async function readMovePayload(str) {
    const kind = str.slice(0, 2);
    const bytes = Uint8Array.from(atob(str.slice(2).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    let text;
    if (kind === "z.") text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    else if (kind === "j.") text = new TextDecoder().decode(bytes);
    else throw new Error("unknown move format");
    const data = JSON.parse(text);
    if (!data || data.v !== 1 || !data.keys || !looksLikeBoard(JSON.parse(data.keys[BOARD_KEY]))) throw new Error("nothing to move");
    return data.keys;
  }
  async function readMove() {
    const str = new URLSearchParams(location.hash.slice(1)).get("move");
    if (!str) return false;
    history.replaceState(null, "", location.pathname + location.search);
    let keys;
    try { keys = await readMovePayload(str); } catch (e) { toast("Your lists didn't come through from the old address. Download a backup there and restore it here.", 8000); return false; }
    const theirs = JSON.parse(keys[LOCAL_KEY] || "{}");
    if (theirs.syncToken && theirs.syncToken === local.syncToken && theirs.syncUrl === local.syncUrl) { toast("Your lists are already here.", 4000); return false; }
    if (!local.pristine && !confirm("Replace the lists on this device with the ones from the old address? The lists here now will be lost unless they're synced.")) return false;
    for (const k of MOVE_KEYS) if (keys[k] != null) localStorage.setItem(k, keys[k]);
    location.reload();
    return true;
  }
  window.addEventListener("hashchange", () => { readMove().then((moving) => { if (!moving) readLink(); }); });

  // ---------- boot ----------
  applyTheme(); applyLook();
  repairOrphans();
  packOld();
  write(BOARD_KEY, board);
  idleStatus();
  render();
  // A new morning waits for the synced board first (see checkDay).
  checkDay().then(sync);
  checkForUpdate();
  readMove().then((moving) => { if (!moving) { quickAdd(); readLink(); maybeWelcome(); } });
  if (recovered === "synced") toast("This device's lists couldn't be read, so they're being loaded from sync.", 6000);
  else if (recovered === "local") toast("This device's lists couldn't be read. Restore a backup from Settings if you have one.", 8000);
})();
