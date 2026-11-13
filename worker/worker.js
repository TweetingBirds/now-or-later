// Cloudflare Worker: sync endpoint for Now or Later.
//
// Stores each board as one JSON document in Workers KV, protected by a bearer token.
// Each device PUTs its whole board; the Worker merges it with what it already has
// (the newest edit wins for each list, each todo and the settings) and returns the
// merged board, so two devices editing at once don't overwrite each other.
//
// Two kinds of token open a board:
//
// - Owner tokens. Every secret named TOKEN_<NAME> (for example TOKEN_NATE) is one
//   person's token, and their board is stored under "board:<name>". These are set
//   by hand with `wrangler secret put` and deploys never touch them.
// - Invited tokens. Someone listed in ADMINS (a plain var in wrangler.toml) creates
//   an invite in the app. Opening the invite link calls POST /join, which creates a
//   new board "board:b_<random>" and a token for it. Only a SHA-256 hash of the
//   token is stored, under "tok:<hash>", so the KV namespace never holds a usable
//   token. The person holding an invited token can delete their board, its backups
//   and the token itself with DELETE /data?confirm=delete.
//
// Shared lists: one list can live on several boards at once (a family's
// "Groceries", say) while the rest of each board stays private. A shared list is
// its own document, "shared:s_<random>", holding the list's name and color, its
// todos and who's on it. Each member's board keeps only a small placement record
// in board.shared ([{ sid, order, updatedAt }]), so everyone can put the list
// wherever they like. GET /data returns the board with its shared lists mixed in
// (each marked with list.shared = sid and list.members = names); PUT /data splits
// the incoming board back apart by each todo's listId. Moving a todo out of a
// shared list leaves a tombstone in the shared document, so the other members'
// devices drop it instead of writing it back. Endpoints:
//   POST   /shared                { listId }  turn one of your lists into a shared list
//   POST   /shared/<sid>/invites              make a one-time link for someone else
//   POST   /shared/join           { code }    add a shared list to your board
//   DELETE /shared/<sid>                      leave it (the last one out deletes it)
//   GET    /shared/<sid>/invites              open links for it (any member)
//   DELETE /shared/<sid>/invites/<code>       withdraw one of those links
//   DELETE /shared/<sid>/members/<board>      take someone off it (the list's owner:
//                                             whoever has been on it longest)
//
// Device links: POST /devices makes a one-time code that expires after a day. The
// new device trades it for a token of its own with POST /devices/connect { code }
// (no token needed: the code is the secret). Device tokens start with "nd_", are
// stored only as a hash ("dtok:<hash>"), open the same board as the token that
// made the link, and can be taken away one by one: GET /devices lists them and
// DELETE /devices/<id> removes one. Deleting a board removes its device tokens too.
//
// Quick add: POST /add puts text straight into a list without opening the app,
// for an iPhone Shortcut (share sheet, Siri, Action button, Back Tap) or anything
// else that can send a request. Body: JSON { text, to } or plain text. Each line
// of text becomes a todo at the bottom of Now, or of the list named by `to` (a
// role like "tomorrow" or "later", or a list's name). Same bearer token as /data.
//
// AI assistants: POST /mcp is an MCP server (see worker/mcp.js) that lets an AI
// assistant read the board and, if allowed, add, check off, move, edit, pencil in
// and delete todos. It takes agent keys ("na_", stored as "atok:<hash>"), which
// work nowhere else. POST /agents { label, scope: "read" | "write" } makes one
// (the key is shown once), GET /agents lists them and DELETE /agents/<id> removes
// one. Deleting a board removes them too.
//
// Backups: once a day (the cron trigger in wrangler.toml) the Worker copies every
// board to a snapshot key "snap:<board>:<ISO time>" that KV deletes by itself after
// SNAPSHOT_DAYS. A board that hasn't changed since its last nightly copy is skipped,
// unless that copy is a week old, so an idle board keeps a few copies without piling
// up 30 identical ones. The app also asks for a snapshot right before it restores a backup.
// GET /snapshots lists a board's snapshots, GET /snapshots/<id> returns one, and
// POST /snapshots takes one now. A token only ever sees its own board's snapshots.
//
// Older Done: Done todos finished more than OLD_DAYS ago move from the board to
// "old:<board>" on each save, and GET /old returns them (see isOld in app/core.js).
//
// Everything here stays inside Workers KV's free tier for a family-sized group: see
// "Costs and limits" in the README.
//
// Bindings (see wrangler.toml and the README):
//   KV namespace binding:  NOW_AND_THEN
//   Secrets:               TOKEN_<NAME>, one per owner (any long random string)
//   Vars:                  ADMINS      owner names who may create invites, e.g. "nate"
//                          MAX_BOARDS  how many invited boards may exist (default 12)
//                          MAX_SHARED  how many shared lists may exist (default 100)

import { TOMBSTONE_DAYS, stamp, pickNewest, pruneTombstones, mergeBoards as mergeCore, isOld, oldCutoff, quickTarget, quickLines } from "../app/core.js";
import { handleRpc, DOCS_URL } from "./mcp.js";

const SNAPSHOT_DAYS = 30;
const INVITE_DAYS = 14;    // default life of an invite link
const GONE_DAYS = 30;      // how long a deleted token answers "board deleted" instead of 401
const SNAP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const INVITE_CODE = /^[A-Za-z0-9_-]{22}$/;
const BOARD_ID = /^b_[a-f0-9]{16}$/;
const SHARED_ID = /^s_[a-f0-9]{16}$/;
const MAX_LISTS = 10;      // same as the app: shared lists count toward it
const MAX_MEMBERS = 10;    // boards per shared list
const UNSHAREABLE = new Set(["now", "tomorrow"]); // the morning rollover moves todos between these
const INBOX_DAYS = 2;      // how long a quick add waits in the inbox (see inbox below)
const DEVICE_HOURS = 24;   // life of a device link
const SNAP_EVERY_DAYS = 7; // an unchanged board still gets a nightly copy this often
const DEVICE_CODE = /^[A-Za-z0-9_-]{22}$/;
const FUTURE_MS = 864e5;   // an edit stamped further ahead than this is from a wrong clock
const SNAP_GAP_MS = 5 * 60_000; // one manual snapshot per board this often
// Limits on what one save can hold, far above real use (a busy year is a few
// thousand todos), so a leaked token or a buggy device can't fill KV.
const MAX_ITEMS = { lists: 500, todos: 30_000, old: 20_000 };
const TEXT_MAX = 5000;     // characters in a todo
const NAME_MAX = 100;      // characters in a list name
const DEVICE_ID = /^[a-f0-9]{64}$/;
const AGENT_TOKEN = /^na_[A-Za-z0-9_-]{43}$/;
const MAX_AGENTS = 10;     // AI assistant connections per board
const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#a3a9b5";
const EMPTY = () => ({ version: 1, settings: {}, lists: [], todos: [] });

// ---------- tokens ----------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function hashToken(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);

// Compares two equal-length hex digests without stopping at the first difference,
// so how long a comparison takes says nothing about how close a guess was.
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Hashes of the TOKEN_* secrets, worked out once per Worker instance.
const secretHashes = new Map();
async function hashOfSecret(value) {
  let h = secretHashes.get(value);
  if (!h) { h = await hashToken(value); secretHashes.set(value, h); }
  return h;
}

// Owner tokens: finds whose TOKEN_* secret this is. Returns { board } for a match,
// { clash: [names] } when two secrets hold the same value (that would silently put
// two people on one board, so it is refused), or null. Both sides are trimmed,
// because a pasted secret often carries a trailing newline. It compares SHA-256
// hashes in constant time instead of the tokens themselves.
async function ownerOf(token, env) {
  const names = [];
  const mine = await hashToken(token);
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (name.startsWith("TOKEN_") && value.length >= 16 && sameDigest(await hashOfSecret(value), mine)) names.push(name.slice(6).toLowerCase());
  }
  if (names.length > 1) return { clash: names.sort() };
  return names.length ? { board: names[0], name: names[0], kind: "owner" } : null;
}

const firstName = (name) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "");
const admins = (env) => String(env.ADMINS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);

// Invited tokens are looked up in KV. The 20-second auto-sync means a phone left
// open reads /data often, so read-only requests reuse a lookup for a minute
// within the same Worker instance to halve KV reads. Anything that writes or
// deletes always reads the token fresh, so a deleted board can't be written back.
const tokenCache = new Map();
const CACHE_MS = 60_000;

// Returns { board, name, kind, admin } for a good token, { gone: true } for a token
// whose board was deleted, { clash } for duplicate owner secrets, or null.
export async function whoIs(request, env, { fresh = false } = {}) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const owner = await ownerOf(token, env);
  if (owner) return owner.clash ? owner : { ...owner, admin: admins(env).includes(owner.board) };
  // Made-up tokens are turned away before they cost a KV read.
  if (!/^n[td]_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await hashToken(token);
  const hit = tokenCache.get(hash);
  if (!fresh && hit && hit.until > Date.now()) return hit.who;
  let who = null;
  if (token.startsWith("nd_")) {
    // A device token opens the board of whoever made the device link.
    const rec = await env.NOW_AND_THEN.get("dtok:" + hash, "json");
    // An owner board's device tokens stop working if its TOKEN_* secret is removed.
    if (rec && rec.board && (rec.kind !== "owner" || env["TOKEN_" + rec.board.toUpperCase()])) {
      const kind = rec.kind === "owner" ? "owner" : "invited";
      who = { board: rec.board, name: rec.name || "", kind, admin: kind === "owner" && admins(env).includes(rec.board), device: hash };
    }
  } else {
    const rec = await env.NOW_AND_THEN.get("tok:" + hash, "json");
    if (rec && BOARD_ID.test(rec.board)) who = { board: rec.board, name: rec.name || "", kind: "invited", admin: false, hash };
  }
  if (!who && await env.NOW_AND_THEN.get("gone:" + hash)) who = { gone: true };
  if (who && !who.gone) tokenCache.set(hash, { who, until: Date.now() + CACHE_MS });
  else tokenCache.delete(hash);
  return who;
}

// Agent keys open one board, only through /mcp. Returns { board, name, kind,
// scope, label, agent } or { gone: true } or null, like whoIs. Read fresh every
// time: a removed key stops working at once.
export async function agentIs(token, env) {
  if (!AGENT_TOKEN.test(token || "")) return null;
  const hash = await hashToken(token);
  const rec = await env.NOW_AND_THEN.get("atok:" + hash, "json");
  // Same as device tokens: an owner board's keys stop if its TOKEN_* secret goes.
  if (rec && rec.board && (rec.kind !== "owner" || env["TOKEN_" + rec.board.toUpperCase()])) {
    return { board: rec.board, name: rec.name || "", kind: rec.kind === "owner" ? "owner" : "invited", admin: false, scope: rec.scope === "write" ? "write" : "read", label: rec.label || "", agent: hash };
  }
  if (await env.NOW_AND_THEN.get("gone:" + hash)) return { gone: true };
  return null;
}

// ---------- snapshots ----------

// Copies a board into a snapshot key that expires on its own. The metadata lets
// GET /snapshots describe each one without reading it.
export async function takeSnapshot(env, board, data, reason) {
  const at = new Date().toISOString();
  const live = (xs) => (xs || []).filter((x) => x && !x.deleted);
  const metadata = {
    at,
    reason,
    lists: live(data.lists).length,
    todos: live(data.todos).filter((t) => !t.archived).length,
    done: live(data.todos).filter((t) => t.archived).length,
    fp: fingerprint(data),
  };
  await env.NOW_AND_THEN.put(`snap:${board}:${at}`, JSON.stringify(data), {
    expirationTtl: SNAPSHOT_DAYS * 86400,
    metadata,
  });
  return { id: at, ...metadata };
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.NOW_AND_THEN.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function listSnapshots(env, board) {
  const prefix = `snap:${board}:`;
  return (await listKeys(env, prefix))
    .map((k) => ({ id: k.name.slice(prefix.length), ...(k.metadata || {}) }))
    .sort((a, b) => b.id.localeCompare(a.id)); // newest first
}

// A cheap fingerprint of a board as its owner sees it: every edit (a tombstone
// included) raises some updatedAt, and adding or removing anything changes a count.
function fingerprint(b) {
  let newest = (b.settings && b.settings.updatedAt) || 0;
  for (const x of b.lists) if ((x.updatedAt || 0) > newest) newest = x.updatedAt;
  for (const x of b.todos) if ((x.updatedAt || 0) > newest) newest = x.updatedAt;
  return `${newest}:${b.lists.length}:${b.todos.length}`;
}

// The daily cron: snapshot every board that has anything on it and has changed since
// its last nightly copy (or whose last copy is SNAP_EVERY_DAYS old, so copies never
// all expire). "snaplast:<board>" remembers the last one, so no snapshot is read.
// Snapshots hold the board as its owner sees it, shared lists included.
export async function snapshotAll(env) {
  const now = Date.now();
  for (const k of await listKeys(env, "board:")) {
    const board = k.name.slice(6);
    const data = await env.NOW_AND_THEN.get(k.name, "json");
    if (!data || !Array.isArray(data.lists)) continue;
    const view = await openBoard(env, board, data);
    if (!view.board.lists.length) continue;
    const fp = fingerprint(view.board);
    const last = await env.NOW_AND_THEN.get("snaplast:" + board, "json");
    if (last && last.fp === fp && now - (last.at || 0) < SNAP_EVERY_DAYS * 864e5) continue;
    await takeSnapshot(env, board, view.board, "daily");
    await env.NOW_AND_THEN.put("snaplast:" + board, JSON.stringify({ fp, at: now }), { expirationTtl: SNAPSHOT_DAYS * 86400 });
  }
}

// Removes a board and every copy of it. For an invited board the token goes too,
// and a small marker (the token's hash, nothing else) stays for GONE_DAYS so the
// person's other devices are told the board was deleted instead of "wrong token".
export async function deleteBoard(env, board, hash) {
  const stored = await env.NOW_AND_THEN.get("board:" + board, "json");
  for (const m of (stored && stored.shared) || []) await leaveShared(env, board, m.sid);
  const snaps = await listKeys(env, `snap:${board}:`);
  for (const k of snaps) await env.NOW_AND_THEN.delete(k.name);
  await env.NOW_AND_THEN.delete("board:" + board);
  await env.NOW_AND_THEN.delete("inbox:" + board);
  await env.NOW_AND_THEN.delete("snaplast:" + board);
  await env.NOW_AND_THEN.delete("old:" + board);
  // Asked from a device token: find the board's own token by its record.
  if (!hash && BOARD_ID.test(board)) {
    const k = (await listKeys(env, "tok:")).find((x) => x.metadata && x.metadata.board === board);
    if (k) hash = k.name.slice(4);
  }
  if (hash) await forgetToken(env, "tok:", hash);
  for (const d of await devicesOf(env, board)) await forgetToken(env, "dtok:", d.id);
  for (const a of await agentsOf(env, board)) await forgetToken(env, "atok:", a.id);
  return { deleted: true, board, snapshots: snaps.length };
}
// Removes a token, leaving a "gone" marker so its devices are told the board was
// deleted (or the device removed) instead of "wrong token".
async function forgetToken(env, prefix, hash) {
  await env.NOW_AND_THEN.delete(prefix + hash);
  await env.NOW_AND_THEN.put("gone:" + hash, "1", { expirationTtl: GONE_DAYS * 86400 });
  tokenCache.delete(hash);
}
async function agentsOf(env, board) {
  return (await listKeys(env, "atok:"))
    .filter((k) => k.metadata && k.metadata.board === board)
    .map((k) => ({ id: k.name.slice(5), label: k.metadata.label || "", scope: k.metadata.scope === "write" ? "write" : "read", created: k.metadata.created || "" }));
}
async function devicesOf(env, board) {
  return (await listKeys(env, "dtok:"))
    .filter((k) => k.metadata && k.metadata.board === board)
    .map((k) => ({ id: k.name.slice(5), label: k.metadata.label || "", created: k.metadata.created || "" }));
}

// ---------- merge ----------

// The rules (newest wins, tombstones, ties) live in app/core.js, shared with the app.
export function mergeBoards(a, b) {
  return mergeCore(a, b);
}

// ---------- shared lists ----------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const memberNames = (doc) => doc.members.map((x) => x.name || "Someone");
// Colors end up in the app's CSS, so only "#rrggbb" gets through. Anything else
// (from an old bug, or from someone on a shared list trying to slip in more CSS)
// becomes the plain gray.
const cleanColor = (c) => (typeof c === "string" && COLOR.test(c) ? c : DEFAULT_COLOR);
function cleanColors(x, key) {
  if (x && key in x && !(typeof x[key] === "string" && COLOR.test(x[key]))) return { ...x, [key]: cleanColor(x[key]) };
  return x;
}
const sharedKey = (sid) => "shared:" + sid;

// Reads a board's shared lists. Placements whose list is gone (the last member
// left) or that no longer name this board are dropped.
export async function openBoard(env, boardId, stored) {
  stored = stored || EMPTY();
  const docs = new Map();
  const shared = [];
  for (const m of stored.shared || []) {
    if (!m || !SHARED_ID.test(m.sid) || docs.has(m.sid)) continue;
    const doc = await env.NOW_AND_THEN.get(sharedKey(m.sid), "json");
    if (doc && doc.members.some((x) => x.board === boardId)) { docs.set(m.sid, doc); shared.push(m); }
  }
  return { stored, docs, shared, board: compose(stored, docs, shared) };
}

// The board as the app sees it: its own lists and todos plus each shared list,
// placed where this person put it. A shared list's todo whose id is also one of
// this board's own todos is ignored: someone else on the list could otherwise
// reach a private todo (to delete it, or pull it into the list) just by knowing
// its id from a time it sat on the shared list.
function compose(stored, docs, shared) {
  const lists = (stored.lists || []).map((l) => cleanColors(l, "color"));
  const own = (stored.todos || []).map((t) => cleanColors(t, "fromColor"));
  const ownIds = new Set(own.map((t) => t && t.id));
  const groups = [own];
  for (const m of shared) {
    const doc = docs.get(m.sid);
    lists.push({ ...doc.list, color: cleanColor(doc.list.color), order: m.order, updatedAt: Math.max(stamp(doc.list), stamp(m)), shared: m.sid, members: memberNames(doc) });
    groups.push(doc.todos.filter((t) => t && !ownIds.has(t.id)).map((t) => cleanColors(t, "fromColor")));
  }
  return { version: 1, settings: stored.settings || {}, lists, todos: pickNewest(groups) };
}

// ---------- quick add inbox ----------
// POST /add can't safely read, change and write the board on its own: a device
// saving at the same moment (or reading a copy KV cached a few seconds earlier)
// would write the board back without the new todo, and no device would ever have
// had it to send again. So quick adds also wait in "inbox:<board>" for a couple of
// days, and every read and save of the board folds them back in. Later edits and
// deletions are newer, so they still win.
async function readInbox(env, board) {
  const box = await env.NOW_AND_THEN.get("inbox:" + board, "json");
  const since = Date.now() - INBOX_DAYS * 864e5;
  return ((box && box.todos) || []).filter((t) => t && typeof t.id === "string" && stamp(t) > since);
}
async function addToInbox(env, board, todos) {
  const kept = await readInbox(env, board);
  await env.NOW_AND_THEN.put("inbox:" + board, JSON.stringify({ todos: pickNewest([kept, todos]) }), { expirationTtl: INBOX_DAYS * 86400 });
}
// The board for GET /data: stored board, shared lists and anything in the inbox.
export async function readBoard(env, boardId, stored) {
  const view = await openBoard(env, boardId, stored);
  const inbox = await readInbox(env, boardId);
  if (inbox.length) view.board.todos = pickNewest([view.board.todos, inbox]);
  return view.board;
}

// Merges an incoming board into the stored board and its shared lists, writes
// whatever changed, and returns the merged view.
export async function putBoard(env, who, stored, incoming, syncedAt = 0, tz = "") {
  const view = await openBoard(env, who.board, stored);
  const { docs } = view;
  let shared = view.shared.map((m) => ({ ...m }));
  // Lists whose todos never move to old: archived ones, and shared ones.
  const cut = oldCutoff(new Date(), true);
  const keepLists = new Set([...view.board.lists, ...(incoming.lists || [])].filter((l) => l && (l.archived || l.shared)).map((l) => l.id));
  for (const doc of docs.values()) keepLists.add(doc.list.id);
  // An older app still sends its old Done todos. They go straight to old, which
  // also keeps them out of the stale-item check below.
  const packing = (incoming.todos || []).filter((t) => isOld(t, cut, keepLists));
  // Older Done the device packed away before the Worker had it (see oldToSend in the app).
  for (const t of Array.isArray(incoming.old) ? incoming.old.slice(0, MAX_ITEMS.old) : []) {
    if (t && typeof t.id === "string" && t.archived === true && !t.deleted) packing.push(clampClock({ todos: [t] }).todos[0]);
  }
  if (packing.length) { const ids = new Set(packing.map((t) => t.id)); incoming = { ...incoming, todos: incoming.todos.filter((t) => !ids.has(t && t.id)) }; }
  const { lists: inLists, todos: inTodos, stale } = screenIncoming(view, docs, incoming, await readInbox(env, who.board), syncedAt);
  incoming = { ...incoming, lists: inLists, todos: inTodos };
  const merged = mergeBoards(view.board, incoming);
  merged.todos = pickNewest([view.board.todos, incoming.todos]);
  const sidOf = new Map([...docs].map(([sid, doc]) => [doc.list.id, sid]));
  const before = new Map([...docs].map(([sid, doc]) => [sid, JSON.stringify(doc)]));
  const wasIn = new Map(); // todo id -> { sid, item } as stored in a shared list
  for (const [sid, doc] of docs) for (const t of doc.todos) wasIn.set(t.id, { sid, item: t });

  const leaving = new Set();
  const lists = [];
  for (const l of merged.lists) {
    const sid = sidOf.get(l.id);
    const { shared: _s, members: _m, ...plain } = cleanColors(l, "color");
    if (!sid) { lists.push(plain); continue; }
    // Deleting a shared list (older app versions offer it) means leaving it.
    if (l.deleted) { leaving.add(sid); continue; }
    const doc = docs.get(sid), m = shared.find((x) => x.sid === sid);
    if (stamp(l) > stamp(doc.list)) {
      const { order: _o, ...rest } = plain;
      doc.list = { ...rest, role: null };
    }
    if (stamp(l) > stamp(m)) Object.assign(m, { order: l.order, updatedAt: stamp(l) });
  }

  const own = [];
  const into = new Map([...docs.keys()].map((sid) => [sid, []]));
  for (const t of merged.todos) {
    const sid = sidOf.get(t.listId);
    if (sid && leaving.has(sid)) continue;
    if (sid) into.get(sid).push(t); else own.push(t);
    // Moved out of a shared list: leave a tombstone there (or keep the one that's
    // already there) so the list's other members drop it instead of sending it back.
    const was = wasIn.get(t.id);
    if (was && was.sid !== sid && !leaving.has(was.sid)) {
      into.get(was.sid).push(was.item.deleted ? was.item : { id: t.id, listId: was.item.listId, deleted: true, updatedAt: stamp(t) });
    }
  }
  for (const [sid, doc] of docs) if (!leaving.has(sid)) doc.todos = pruneTombstones(pickNewest([into.get(sid)]));

  const archivedNow = new Set(lists.filter((l) => l.archived && !l.deleted).map((l) => l.id));
  for (const id of keepLists) if (!lists.some((l) => l.id === id && !l.archived)) archivedNow.add(id);
  const ownTodos = pruneTombstones(own);
  for (const t of ownTodos) if (isOld(t, cut, archivedNow)) packing.push(t);
  const packedIds = new Set(packing.map((t) => t.id));
  const next = { version: 1, settings: merged.settings, lists, todos: ownTodos.filter((t) => !packedIds.has(t.id) || !isOld(t, cut, archivedNow)), shared };
  // The person's time zone, from the app (X-Time-Zone), so an AI assistant's
  // "today" is theirs. Kept beside the board, not in settings, so it never syncs.
  const zone = validZone(tz) || (stored && validZone(stored.tz));
  if (zone) next.tz = zone;
  await addOld(env, who.board, packing.map((t) => cleanColors(t, "fromColor")));
  buryStale(next, stale);
  for (const sid of leaving) {
    await leaveShared(env, who.board, sid, docs.get(sid));
    tombstoneLeft(next, docs.get(sid));
  }
  for (const [sid, doc] of docs) {
    if (!leaving.has(sid) && JSON.stringify(doc) !== before.get(sid)) await env.NOW_AND_THEN.put(sharedKey(sid), JSON.stringify(doc));
  }
  if (!sameJson(next, stored)) await env.NOW_AND_THEN.put("board:" + who.board, JSON.stringify(next));
  return compose(next, docs, next.shared);
}

export function validZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch (e) { return ""; }
}

// Sorts out what a device sent before it's merged:
// - The quick add inbox is added, so a save never writes the board without it.
// - A list the device still has as shared, but that this board is no longer on
//   (someone took this person off it, or they left from another device), is
//   dropped along with its todos, and comes back as tombstones (see buryStale) so
//   the device removes them too, instead of the list turning into a private copy.
// - A device that has synced before says when (X-Synced-At). Something this board
//   has never heard of, last changed before that sync and longer ago than
//   tombstones are kept, was on the board once and has since been deleted, and
//   its tombstone has been cleaned up. It's a deletion coming back from a device
//   that was offline for months, so it's dropped. A device that has never synced
//   here sends no date, and everything it has is new to the board.
function screenIncoming(view, docs, incoming, inbox, syncedAt = 0) {
  incoming = clampClock(incoming);
  const cutoff = Math.min(Date.now() - TOMBSTONE_DAYS * 864e5, syncedAt);
  const knownLists = new Set(view.board.lists.map((l) => l.id));
  const knownTodos = new Set(view.board.todos.map((t) => t.id));
  const stale = { lists: [], todos: [] };
  const staleIds = new Set();
  const lists = (incoming.lists || []).filter((l) => {
    if (!l || typeof l.id !== "string") return false;
    if (l.shared && !docs.has(l.shared) && !knownLists.has(l.id)) { staleIds.add(l.id); stale.lists.push(l); return false; }
    return knownLists.has(l.id) || stamp(l) >= cutoff;
  });
  const todos = [...(incoming.todos || []), ...inbox].filter((t) => {
    if (!t || typeof t.id !== "string") return false;
    if (staleIds.has(t.listId) && !knownTodos.has(t.id)) { stale.todos.push(t); return false; }
    return knownTodos.has(t.id) || stamp(t) >= cutoff;
  }).map((t) => cleanColors(t, "fromColor"));
  return { lists, todos, stale };
}
function buryStale(boardDoc, stale) {
  const has = (xs, id) => xs.some((x) => x.id === id);
  for (const l of stale.lists) if (!has(boardDoc.lists, l.id)) boardDoc.lists.push({ id: l.id, deleted: true, updatedAt: Math.max(Date.now(), stamp(l)) + 1 });
  for (const t of stale.todos) if (!has(boardDoc.todos, t.id)) boardDoc.todos.push({ id: t.id, deleted: true, updatedAt: Math.max(Date.now(), stamp(t)) + 1 });
}

// A device whose clock runs fast would win every tie for as long as it's ahead.
// The app keeps its clock in step with the Worker's (X-Server-Time), so this only
// catches a clock that's badly wrong: anything stamped more than a day ahead is
// stamped now instead.
function clampClock(incoming) {
  const now = Date.now();
  const fix = (x) => {
    if (!x || typeof x !== "object") return x;
    if (stamp(x) > now + FUTURE_MS) x = { ...x, updatedAt: now };
    if (typeof x.text === "string" && x.text.length > TEXT_MAX) x = { ...x, text: x.text.slice(0, TEXT_MAX) };
    if (typeof x.name === "string" && x.name.length > NAME_MAX) x = { ...x, name: x.name.slice(0, NAME_MAX) };
    return x;
  };
  return { ...incoming, settings: fix(incoming.settings), lists: (incoming.lists || []).map(fix), todos: (incoming.todos || []).map(fix) };
}

// ---------- older Done ----------
// Done keeps everything, so a board grows forever, and every save and refresh
// carries all of it. Done todos finished more than OLD_DAYS ago move out of the
// board into "old:<board>", which the app only asks for (GET /old) when someone
// searches or looks further back. Todos on an archived list stay with the list,
// so "Use again" still has them, and shared lists keep theirs.
// The rule itself is isOld() in app/core.js, shared with the app.
export async function readOld(env, board) {
  const doc = await env.NOW_AND_THEN.get("old:" + board, "json");
  return (doc && Array.isArray(doc.todos)) ? doc.todos : [];
}
async function addOld(env, board, todos) {
  if (!todos.length) return;
  const kept = await readOld(env, board);
  const next = pickNewest([kept, todos]);
  if (!sameJson(next, kept)) await env.NOW_AND_THEN.put("old:" + board, JSON.stringify({ todos: next }));
}

// After leaving, the board keeps tombstones for the list and its todos, so this
// person's other devices remove them instead of sending them back.
function tombstoneLeft(boardDoc, doc) {
  // Newer than anything a device could still hold for this list.
  const mine = (boardDoc.shared || []).find((m) => m.sid === doc.sid);
  const t = Math.max(Date.now(), stamp(doc.list), stamp(mine), ...doc.todos.map(stamp)) + 1;
  boardDoc.shared = (boardDoc.shared || []).filter((m) => m.sid !== doc.sid);
  const gone = new Set([doc.list.id, ...doc.todos.map((x) => x.id)]);
  boardDoc.lists = boardDoc.lists.filter((x) => !gone.has(x.id));
  boardDoc.todos = boardDoc.todos.filter((x) => !gone.has(x.id));
  boardDoc.lists.push({ id: doc.list.id, deleted: true, updatedAt: t });
  for (const x of doc.todos) boardDoc.todos.push({ id: x.id, deleted: true, updatedAt: t });
}

// Takes one board off a shared list. The last member out deletes the list.
export async function leaveShared(env, boardId, sid, doc) {
  doc = doc || (await env.NOW_AND_THEN.get(sharedKey(sid), "json"));
  if (!doc) return null;
  doc.members = doc.members.filter((x) => x.board !== boardId);
  if (!doc.members.length) { await env.NOW_AND_THEN.delete(sharedKey(sid)); return doc; }
  doc.list = { ...doc.list, updatedAt: Date.now() }; // everyone's member names refresh
  await env.NOW_AND_THEN.put(sharedKey(sid), JSON.stringify(doc));
  return doc;
}

// Archived lists are off the board, so they don't count. Same rule as the app.
const liveCount = (board) => board.lists.filter((l) => !l.deleted && !l.archived).length;

async function sharedApi(request, env, who, url) {
  const [, sid, sub, item] = url.pathname.replace(/\/+$/, "").match(/\/shared(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/) || [];
  const m = request.method;
  const hdrs = boardHeaders(who);
  const KEY = "board:" + who.board;
  const stored = (await env.NOW_AND_THEN.get(KEY, "json")) || EMPTY();

  // Turn one of your lists into a shared list.
  if (m === "POST" && !sid) {
    const { value, error } = await readJson(request, 2000);
    if (error) return error;
    const list = (stored.lists || []).find((l) => l.id === value.listId && !l.deleted);
    if (!list) return json({ error: "list not found" }, 404, hdrs);
    if (UNSHAREABLE.has(list.role)) return json({ error: "can't share this list" }, 400, hdrs);
    const max = Number(env.MAX_SHARED) || 100;
    if ((await listKeys(env, "shared:")).length >= max) return json({ error: "full" }, 503, hdrs);
    const id = "s_" + hex(randomBytes(8));
    const t = Date.now();
    const doc = {
      version: 1, sid: id, created: new Date(t).toISOString(), by: who.board,
      list: { id: list.id, name: list.name, color: cleanColor(list.color), role: null, updatedAt: t },
      todos: (stored.todos || []).filter((x) => x.listId === list.id),
      members: [{ board: who.board, name: firstName(who.name), joined: new Date(t).toISOString() }],
    };
    stored.lists = stored.lists.filter((l) => l.id !== list.id);
    stored.todos = (stored.todos || []).filter((x) => x.listId !== list.id);
    stored.shared = [...(stored.shared || []), { sid: id, order: list.order, updatedAt: t }];
    await env.NOW_AND_THEN.put(sharedKey(id), JSON.stringify(doc));
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ sid: id, name: list.name }, 200, hdrs);
  }

  // Add a shared list to your board with a link someone on it sent you.
  if (m === "POST" && sid === "join") {
    const { value, error } = await readJson(request, 2000);
    if (error) return error;
    const code = String(value.code || "");
    const inv = INVITE_CODE.test(code) ? await env.NOW_AND_THEN.getWithMetadata("sinv:" + code) : { value: null };
    const meta = inv.metadata || {};
    const doc = inv.value !== null && SHARED_ID.test(meta.sid || "") ? await env.NOW_AND_THEN.get(sharedKey(meta.sid), "json") : null;
    // A link stops working once the person who made it is no longer on the list.
    if (!doc || !doc.members.some((x) => x.board === meta.by)) return json({ error: "invite not found" }, 404, hdrs);
    if (doc.members.some((x) => x.board === who.board) && (stored.shared || []).some((x) => x.sid === doc.sid)) {
      return json({ sid: doc.sid, name: doc.list.name, already: true }, 200, hdrs);
    }
    if (doc.members.length >= MAX_MEMBERS) return json({ error: "list full" }, 409, hdrs);
    if (liveCount((await openBoard(env, who.board, stored)).board) >= MAX_LISTS) return json({ error: "too many lists" }, 409, hdrs);
    await env.NOW_AND_THEN.delete("sinv:" + code);
    const t = Date.now();
    doc.members = [...doc.members.filter((x) => x.board !== who.board), { board: who.board, name: firstName(who.name), joined: new Date(t).toISOString() }];
    doc.list = { ...doc.list, updatedAt: t };
    // Clear tombstones from an earlier time on this list, or they'd hide it.
    const ids = new Set([doc.list.id, ...doc.todos.map((x) => x.id)]);
    stored.lists = (stored.lists || []).filter((x) => !ids.has(x.id));
    stored.todos = (stored.todos || []).filter((x) => !ids.has(x.id));
    const order = Math.max(0, ...stored.lists.filter((l) => !l.deleted).map((l) => l.order || 0), ...(stored.shared || []).map((x) => x.order || 0)) + 1;
    stored.shared = [...(stored.shared || []).filter((x) => x.sid !== doc.sid), { sid: doc.sid, order, updatedAt: t }];
    await env.NOW_AND_THEN.put(sharedKey(doc.sid), JSON.stringify(doc));
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ sid: doc.sid, name: doc.list.name, by: meta.byName || "" }, 200, hdrs);
  }

  if (!SHARED_ID.test(sid || "") || !(stored.shared || []).some((x) => x.sid === sid)) return json({ error: "not found" }, 404, hdrs);
  const doc = await env.NOW_AND_THEN.get(sharedKey(sid), "json");
  if (!doc || !doc.members.some((x) => x.board === who.board)) return json({ error: "not found" }, 404, hdrs);

  // Who's on it and which links are still open. The owner (whoever has been on it
  // longest) can take people off it.
  if (m === "GET" && !sub) {
    // KV's list can lag behind a delete by up to a minute, so a link that was just
    // withdrawn or used would still show. Reading each key directly sees the delete.
    // It can also miss one made a moment ago, so the app names links it just made
    // (?also=code,code) and those are looked up directly too.
    const listed = (await listKeys(env, "sinv:")).filter((k) => k.metadata && k.metadata.sid === sid);
    const still = await Promise.all(listed.map((k) => env.NOW_AND_THEN.get(k.name)));
    const found = listed.filter((k, i) => still[i] !== null).map((k) => ({ code: k.name.slice(5), meta: k.metadata }));
    const also = [...new Set((url.searchParams.get("also") || "").split(","))]
      .filter((c) => INVITE_CODE.test(c) && !found.some((f) => f.code === c)).slice(0, 20);
    for (const c of also) {
      const got = await env.NOW_AND_THEN.getWithMetadata("sinv:" + c);
      if (got.value !== null && got.metadata && got.metadata.sid === sid) found.push({ code: c, meta: got.metadata });
    }
    const invites = found.map(({ code, meta }) => ({ code, byName: meta.byName || "", mine: meta.by === who.board, expires: meta.expires }));
    return json({
      name: doc.list.name, owner: doc.members[0].board === who.board, me: who.board,
      members: doc.members.map((x) => ({ board: x.board, name: x.name || "Someone", joined: x.joined })),
      invites,
    }, 200, hdrs);
  }

  // Withdraw a link that hasn't been used yet.
  if (m === "DELETE" && sub === "invites" && item) {
    const code = decodeURIComponent(item);
    const got = INVITE_CODE.test(code) ? await env.NOW_AND_THEN.getWithMetadata("sinv:" + code) : { value: null };
    if (got.value === null || !got.metadata || got.metadata.sid !== sid) return json({ error: "not found" }, 404, hdrs);
    await env.NOW_AND_THEN.delete("sinv:" + code);
    return json({ revoked: true }, 200, hdrs);
  }

  // Take someone else off the list. Only the owner can, and it doesn't touch the
  // rest of their board: their devices drop the list on their next sync.
  if (m === "DELETE" && sub === "members" && item) {
    const target = decodeURIComponent(item);
    if (doc.members[0].board !== who.board) return json({ error: "not the owner" }, 403, hdrs);
    if (target === who.board) return json({ error: "use leave" }, 400, hdrs);
    if (!doc.members.some((x) => x.board === target)) return json({ error: "not found" }, 404, hdrs);
    await leaveShared(env, target, sid, doc);
    for (const k of await listKeys(env, "sinv:")) if (k.metadata && k.metadata.sid === sid && k.metadata.by === target) await env.NOW_AND_THEN.delete(k.name);
    return json({ removed: true, members: memberNames(doc) }, 200, hdrs);
  }

  // A one-time link for someone else to add this list to their board.
  if (m === "POST" && sub === "invites" && !item) {
    const code = b64url(randomBytes(16));
    const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
    const metadata = { sid, by: who.board, byName: firstName(who.name), created: new Date().toISOString(), expires };
    await env.NOW_AND_THEN.put("sinv:" + code, "1", { expirationTtl: INVITE_DAYS * 86400, metadata });
    return json({ code, expires }, 200, hdrs);
  }

  // Leave it. It stays on everyone else's board.
  if (m === "DELETE" && !sub) {
    // Links this person made stop working when they leave.
    for (const k of await listKeys(env, "sinv:")) if (k.metadata && k.metadata.sid === sid && k.metadata.by === who.board) await env.NOW_AND_THEN.delete(k.name);
    await leaveShared(env, who.board, sid, doc);
    tombstoneLeft(stored, doc);
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ left: true, deleted: doc.members.length === 0 }, 200, hdrs);
  }
  return json({ error: "method not allowed" }, 405, hdrs);
}

// ---------- HTTP ----------

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*", // security rests on the token
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Expect-Board, X-Synced-At, X-Time-Zone, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "X-Board, X-Board-Name, X-Board-Kind, X-Board-Admin, X-Server-Time",
    "Access-Control-Max-Age": "86400",
    "X-Server-Time": String(Date.now()), // the app keeps its clock in step with this
    ...extra,
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: cors({ "Content-Type": "application/json", ...extra }) });
}

// Tells the app whose board this is. X-Board is the board's id, which the app
// remembers to make sure a device never merges into a different board.
const boardHeaders = (who) => ({
  "X-Board": who.board,
  "X-Board-Name": encodeURIComponent(who.name || ""),
  "X-Board-Kind": who.kind,
  ...(who.admin ? { "X-Board-Admin": "1" } : {}),
});

// POST /add — see "Quick add" at the top. Where it lands is quickTarget() in
// app/core.js, shared with the app.
export async function quickAdd(request, env, who) {
  const hdrs = boardHeaders(who);
  const raw = await request.text();
  if (raw.length > 100_000) return json({ error: "too large" }, 413, hdrs);
  let text = raw, to = "";
  const url = new URL(request.url);
  if (/json/i.test(request.headers.get("Content-Type") || "") || /^\s*\{/.test(raw)) {
    let body;
    try { body = JSON.parse(raw || "{}"); } catch (e) { return json({ error: "bad json" }, 400, hdrs); }
    text = typeof body.text === "string" ? body.text : "";
    to = typeof body.to === "string" ? body.to : "";
  }
  if (!text) text = url.searchParams.get("text") || "";
  if (!to) to = url.searchParams.get("to") || "";
  const lines = quickLines(text);
  if (!lines.length) return json({ error: "no text" }, 400, hdrs);

  const KEY = "board:" + who.board;
  const stored = await env.NOW_AND_THEN.get(KEY, "json");
  const view = await openBoard(env, who.board, stored);
  const live = view.board.lists.filter((l) => !l.deleted && !l.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
  const list = quickTarget(live, to);
  if (!list) return json({ error: "no lists yet. Open the app once so it can sync." }, 409, hdrs);

  let order = Math.max(0, ...view.board.todos.filter((t) => t.listId === list.id && !t.deleted && !t.archived).map((t) => t.order || 0));
  const t = Date.now();
  const todos = lines.map((line) => ({
    id: crypto.randomUUID(), text: line, listId: list.id, order: ++order,
    done: false, doneDay: null, archived: false, updatedAt: t,
  }));
  // The inbox first: if the save below races a device's save and loses, the todos
  // still reach the board on its next read or save.
  await addToInbox(env, who.board, todos);
  await putBoard(env, who, stored, { version: 1, settings: view.board.settings, lists: [], todos });
  return json({ added: todos.length, list: list.name, todos: todos.map((x) => x.text) }, 200, hdrs);
}

async function readJson(request, max = 4_000_000) {
  const body = await request.text();
  if (body.length > max) return { error: json({ error: "too large" }, 413) };
  if (!body) return { value: {} };
  try { return { value: JSON.parse(body) }; } catch (e) { return { error: json({ error: "bad json" }, 400) }; }
}

function authError(who) {
  if (!who) return json({ error: "unauthorized" }, 401);
  if (who.gone) return json({ error: "board deleted" }, 410);
  if (who.clash) return json({ error: "token clash", boards: who.clash }, 409);
  return null;
}

// POST /join { code, name } — no token needed; the invite code is the secret.
async function join(request, env) {
  const { value, error } = await readJson(request, 2000);
  if (error) return error;
  const code = String(value.code || "");
  if (!INVITE_CODE.test(code)) return json({ error: "invite not found" }, 404);
  const invite = await env.NOW_AND_THEN.getWithMetadata("inv:" + code);
  if (invite.value === null) return json({ error: "invite not found" }, 404);
  const max = Number(env.MAX_BOARDS) || 12;
  if ((await listKeys(env, "tok:")).length >= max) return json({ error: "full" }, 503);

  // Single use: the invite is deleted before the board is made. (KV is eventually
  // consistent, so two people opening one link in the same second could both get
  // in. Invites are made one at a time for people you know, so that's acceptable.)
  await env.NOW_AND_THEN.delete("inv:" + code);
  const token = "nt_" + b64url(randomBytes(32));
  const board = "b_" + hex(randomBytes(8));
  const name = cleanName(value.name);
  const meta = invite.metadata || {};
  const rec = { board, name, created: new Date().toISOString(), invite: cleanName(meta.label), by: meta.by || "" };
  // Metadata repeats the record, so GET /boards can list boards without reading each one.
  await env.NOW_AND_THEN.put("tok:" + (await hashToken(token)), JSON.stringify(rec), { metadata: rec });
  return json({ token, board, name }, 200, boardHeaders({ board, name, kind: "invited" }));
}

// ---------- device links ----------
// POST /devices makes a one-time code for "Copy link for another device". The link
// used to carry the board's token itself, which never expired and couldn't be taken
// back. Now the new device trades the code for a token of its own.
async function devices(request, env, who, url) {
  const id = (url.pathname.replace(/\/+$/, "").match(/\/devices\/([^/]+)$/) || [])[1];
  const m = request.method;
  const hdrs = boardHeaders(who);
  if (m === "POST" && !id) {
    const code = b64url(randomBytes(16));
    const expires = new Date(Date.now() + DEVICE_HOURS * 3600e3).toISOString();
    const metadata = { board: who.board, name: who.name || "", kind: who.kind, expires };
    await env.NOW_AND_THEN.put("dlink:" + code, "1", { expirationTtl: DEVICE_HOURS * 3600, metadata });
    return json({ code, expires }, 200, hdrs);
  }
  if (m === "GET" && !id) {
    const list = (await devicesOf(env, who.board)).map((d) => ({ ...d, me: d.id === who.device }));
    return json({ devices: list.sort((a, b) => (b.created || "").localeCompare(a.created || "")) }, 200, hdrs);
  }
  if (m === "DELETE" && id) {
    if (!DEVICE_ID.test(id)) return json({ error: "not found" }, 404, hdrs);
    const got = await env.NOW_AND_THEN.getWithMetadata("dtok:" + id);
    if (got.value === null || !got.metadata || got.metadata.board !== who.board) return json({ error: "not found" }, 404, hdrs);
    await forgetToken(env, "dtok:", id);
    return json({ removed: true }, 200, hdrs);
  }
  return json({ error: "method not allowed" }, 405, hdrs);
}

// POST /devices/connect { code, label } — no token needed; the code is the secret.
async function connectDevice(request, env) {
  const { value, error } = await readJson(request, 2000);
  if (error) return error;
  const code = String(value.code || "");
  const link = DEVICE_CODE.test(code) ? await env.NOW_AND_THEN.getWithMetadata("dlink:" + code) : { value: null };
  const meta = link.metadata || {};
  if (link.value === null || !meta.board || Date.parse(meta.expires) < Date.now()) return json({ error: "link not found" }, 404);
  // The board must still be there to be joined.
  if (meta.kind !== "owner" && !(await listKeys(env, "tok:")).some((k) => k.metadata && k.metadata.board === meta.board)) {
    return json({ error: "link not found" }, 404);
  }
  await env.NOW_AND_THEN.delete("dlink:" + code); // single use
  const token = "nd_" + b64url(randomBytes(32));
  const rec = { board: meta.board, name: meta.name || "", kind: meta.kind === "owner" ? "owner" : "invited", label: cleanName(value.label), created: new Date().toISOString() };
  await env.NOW_AND_THEN.put("dtok:" + (await hashToken(token)), JSON.stringify(rec), { metadata: rec });
  return json({ token, board: rec.board }, 200, boardHeaders({ board: rec.board, name: rec.name, kind: rec.kind }));
}

// ---------- AI assistants ----------
// POST /agents { label, scope } makes an agent key for this board and returns it
// once, with the address to paste into an assistant's connector settings.
async function agents(request, env, who, url) {
  const id = (url.pathname.replace(/\/+$/, "").match(/\/agents\/([^/]+)$/) || [])[1];
  const m = request.method;
  const hdrs = boardHeaders(who);
  if (m === "POST" && !id) {
    const { value, error } = await readJson(request, 2000);
    if (error) return error;
    if ((await agentsOf(env, who.board)).length >= MAX_AGENTS) return json({ error: `There are already ${MAX_AGENTS} assistants connected. Remove one first.` }, 409, hdrs);
    const token = "na_" + b64url(randomBytes(32));
    const rec = { board: who.board, name: who.name || "", kind: who.kind, label: cleanName(value.label) || "AI assistant", scope: value.scope === "write" ? "write" : "read", created: new Date().toISOString() };
    const hash = await hashToken(token);
    await env.NOW_AND_THEN.put("atok:" + hash, JSON.stringify(rec), { metadata: rec });
    const base = url.origin + url.pathname.replace(/\/agents\/?$/, "");
    return json({ id: hash, token, url: base + "/mcp/" + token, label: rec.label, scope: rec.scope, created: rec.created }, 200, hdrs);
  }
  if (m === "GET" && !id) {
    const list = await agentsOf(env, who.board);
    return json({ agents: list.sort((a, b) => (b.created || "").localeCompare(a.created || "")) }, 200, hdrs);
  }
  if (m === "DELETE" && id) {
    if (!DEVICE_ID.test(id)) return json({ error: "not found" }, 404, hdrs);
    const got = await env.NOW_AND_THEN.getWithMetadata("atok:" + id);
    if (got.value === null || !got.metadata || got.metadata.board !== who.board) return json({ error: "not found" }, 404, hdrs);
    await forgetToken(env, "atok:", id);
    return json({ removed: true }, 200, hdrs);
  }
  return json({ error: "method not allowed" }, 405, hdrs);
}

// /mcp and /mcp/<agent key>: see worker/mcp.js.
async function mcpRoute(request, env, keyInPath) {
  if (request.method !== "POST") return json({ error: "method not allowed: this is an MCP server (Streamable HTTP, POST only)", docs: DOCS_URL }, 405, { Allow: "POST, OPTIONS" });
  const header = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const who = await agentIs(keyInPath || header, env);
  if (!who) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This assistant's key isn't valid. Make a new connection in Now or Later under Settings > Sync > Advanced. Setup: " + DOCS_URL } }, 401);
  if (who.gone) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This connection was removed." } }, 410);
  const { value, error } = await readJson(request, 200_000);
  if (error) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const KEY = "board:" + who.board;
  let stored;
  const store = {
    async read() {
      stored = await env.NOW_AND_THEN.get(KEY, "json");
      return { board: await readBoard(env, who.board, stored), tz: stored && stored.tz };
    },
    // The inbox first, as quick add does: if the save races a device's, the
    // change still reaches the board on its next read or save.
    async save(todos) {
      await addToInbox(env, who.board, todos);
      await putBoard(env, who, stored, { version: 1, settings: (stored && stored.settings) || {}, lists: [], todos });
    },
  };
  const batch = Array.isArray(value);
  const msgs = (batch ? value : [value]).slice(0, 20);
  const out = [];
  for (const msg of msgs) {
    const answer = await handleRpc(msg, who, store);
    if (answer) out.push(answer);
  }
  if (!out.length) return new Response(null, { status: 202, headers: cors() });
  return json(batch ? out : out[0], 200, { "X-Board-Kind": who.kind });
}

// Admin endpoints: create, list and revoke invites; list and remove invited boards.
async function admin(request, env, who, url) {
  if (!who.admin) return json({ error: "forbidden" }, 403);
  const [, area, id] = url.pathname.match(/\/(invites|boards)(?:\/([^/]+))?\/?$/);
  const m = request.method;

  if (area === "invites") {
    if (m === "POST" && !id) {
      const { value, error } = await readJson(request, 2000);
      if (error) return error;
      const days = Math.min(30, Math.max(1, Math.round(Number(value.days) || INVITE_DAYS)));
      const code = b64url(randomBytes(16));
      const expires = new Date(Date.now() + days * 864e5).toISOString();
      const metadata = { label: cleanName(value.label), by: who.board, created: new Date().toISOString(), expires };
      await env.NOW_AND_THEN.put("inv:" + code, "1", { expirationTtl: days * 86400, metadata });
      return json({ code, ...metadata });
    }
    if (m === "GET" && !id) {
      const keys = await listKeys(env, "inv:");
      return json({ invites: keys.map((k) => ({ code: k.name.slice(4), ...(k.metadata || {}) })).sort((a, b) => (b.created || "").localeCompare(a.created || "")) });
    }
    if (m === "DELETE" && id) {
      if (!INVITE_CODE.test(id)) return json({ error: "not found" }, 404);
      await env.NOW_AND_THEN.delete("inv:" + id);
      return json({ revoked: true });
    }
  }

  if (area === "boards") {
    const keys = await listKeys(env, "tok:");
    if (m === "GET" && !id) {
      return json({ max: Number(env.MAX_BOARDS) || 12, boards: keys.map((k) => ({ ...(k.metadata || {}) })).filter((b) => b.board) });
    }
    if (m === "DELETE" && id) {
      const k = keys.find((k) => k.metadata && k.metadata.board === id);
      if (!BOARD_ID.test(id) || !k) return json({ error: "not found" }, 404);
      return json(await deleteBoard(env, id, k.name.slice(4)));
    }
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshotAll(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // First: /shared/join and /shared/<sid>/invites aren't the board invite routes.
    if (/\/shared(\/[^/]+){0,3}$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || sharedApi(request, env, who, url);
    }

    // OAuth discovery: there is none (agent keys go in the address or a header), and
    // a 404 here tells MCP clients so instead of the plain-text note below.
    if (path.includes("/.well-known/")) return json({ error: "not found" }, 404);
    const mcp = path.match(/\/mcp(?:\/([^/]+))?$/);
    if (mcp) return mcpRoute(request, env, mcp[1] ? decodeURIComponent(mcp[1]) : "");
    if (/\/agents(\/[^/]+)?$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || agents(request, env, who, url);
    }

    if (path.endsWith("/devices/connect")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return connectDevice(request, env);
    }
    if (/\/devices(\/[^/]+)?$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || devices(request, env, who, url);
    }

    if (path.endsWith("/join")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return join(request, env);
    }

    if (/\/(invites|boards)(\/[^/]+)?$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || admin(request, env, who, url);
    }

    if (path.endsWith("/add")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || quickAdd(request, env, who);
    }

    const snap = path.match(/\/snapshots(?:\/([^/]+))?$/);
    if (path.endsWith("/old")) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const who = await whoIs(request, env);
      return authError(who) || json({ todos: await readOld(env, who.board) }, 200, boardHeaders(who));
    }
    if (path.endsWith("/data") || snap) {
      const writes = request.method !== "GET";
      const who = await whoIs(request, env, { fresh: writes });
      const bad = authError(who);
      if (bad) return bad;
      const KEY = "board:" + who.board;
      const hdrs = boardHeaders(who);

      if (snap) {
        const id = snap[1] ? decodeURIComponent(snap[1]) : null;
        if (request.method === "GET" && !id) return json({ board: who.board, days: SNAPSHOT_DAYS, snapshots: await listSnapshots(env, who.board) }, 200, hdrs);
        if (request.method === "GET" && id) {
          if (!SNAP_ID.test(id)) return json({ error: "not found" }, 404, hdrs);
          const got = await env.NOW_AND_THEN.get(`snap:${who.board}:${id}`, "json");
          return got ? json(got, 200, hdrs) : json({ error: "not found" }, 404, hdrs);
        }
        if (request.method === "POST" && !id) {
          // A leaked token or a looping device could otherwise spend the day's KV writes,
          // so an unchanged board within a few minutes of its last copy reuses that copy.
          const last = (await listSnapshots(env, who.board))[0];
          const view = await openBoard(env, who.board, await env.NOW_AND_THEN.get(KEY, "json"));
          if (last && last.fp === fingerprint(view.board) && Date.now() - Date.parse(last.at || last.id) < SNAP_GAP_MS) return json({ ...last, reused: true }, 200, hdrs);
          const reason = (url.searchParams.get("reason") || "manual").replace(/[^a-z -]/gi, "").slice(0, 30) || "manual";
          return json(await takeSnapshot(env, who.board, view.board, reason), 200, hdrs);
        }
        return json({ error: "method not allowed" }, 405, hdrs);
      }

      // A device says which board it last synced with. If this token now opens a
      // different board (for example after the secrets were changed), refuse rather
      // than merge one person's lists into another's.
      const expect = (request.headers.get("X-Expect-Board") || "").trim().toLowerCase();
      if ((request.method === "PUT" || request.method === "DELETE") && expect && expect !== who.board) {
        return json({ error: "board changed", board: who.board, expected: expect }, 409, hdrs);
      }

      // Delete this board, its backups and (for an invited board) its token.
      // Owner boards come from TOKEN_* secrets that only the Worker's owner can
      // remove, so those are deleted by hand (see the README).
      if (request.method === "DELETE") {
        if (url.searchParams.get("confirm") !== "delete") return json({ error: "confirm" }, 400, hdrs);
        if (who.kind !== "invited") return json({ error: "owner board" }, 403, hdrs);
        return json(await deleteBoard(env, who.board, who.hash), 200, hdrs);
      }

      const stored = await env.NOW_AND_THEN.get(KEY, "json");

      if (request.method === "GET") {
        return json(await readBoard(env, who.board, stored), 200, hdrs);
      }

      if (request.method === "PUT") {
        const { value: incoming, error } = await readJson(request);
        if (error) return error;
        if (!incoming || !Array.isArray(incoming.lists) || !Array.isArray(incoming.todos)) return json({ error: "not a board" }, 400, hdrs);
        for (const k of Object.keys(MAX_ITEMS)) {
          if (Array.isArray(incoming[k]) && incoming[k].length > MAX_ITEMS[k]) return json({ error: "too many " + k }, 413, hdrs);
        }
        const syncedAt = Number(request.headers.get("X-Synced-At")) || 0;
        return json(await putBoard(env, who, stored, incoming, syncedAt, request.headers.get("X-Time-Zone") || ""), 200, hdrs);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Now or Later sync is running. Your lists live at /data and need your access token.\nAI agents: see " + DOCS_URL + "\n", {
      status: 200,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
