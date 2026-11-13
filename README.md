# Now or Later

A notebook-style todo list, made for Tiffany. It works the way her paper notebook does:

- **Now** is today's page. **Tomorrow** is the next page. **Later** is for things to remember someday.
- Checked-off todos stay where they are for the rest of the day. The next morning they move to **Done**, grouped by date. A setting can move them to Done as soon as they are checked instead.
- Each morning, unfinished Tomorrow todos move into Now (this can be turned off in Settings).
- Lists can be renamed, recolored, reordered and added, up to 10.
- Todos move between lists by dragging the ⋮⋮ handle, or with the ••• menu.
- A list you added (not Now, Tomorrow or Later) can be archived once everything on it is checked: a toast offers **Archive list** when the last todo is checked, and the list's ••• menu has it too (it asks first). Nothing archives on its own. Archived lists sit at the top of Done, don't count toward the 10, and **Use again** brings one back unchecked. Archiving a shared list archives it for everyone on it.
- Deleting, moving or checking off a todo (or deleting a list, or putting a todo back from Done) shows a toast with **Undo** for a few seconds. Cmd+Z or Ctrl+Z works too while it's showing. Undo syncs like any other edit.
- **Done** shows the newest 100 finished todos with **Show more**. Todos finished more than 90 days ago move off the board (see *Older Done* below); searching or **Look further back** brings them in.
- **Done** can be searched and filtered by when a todo was finished (today, this week, this month) and which list it came from. The ↩ button on a finished todo puts it back, unchecked, on its list.
- Dark mode follows the system, or pick Light or Dark per device in Settings. Phones give a small buzz when a todo is picked up and dropped (Android, and iPhone on iOS 18 or later).
- On a Mac, keyboard shortcuts cover adding, moving and checking off todos. Press **?** to see them. A toggle at the top of that sheet makes the shortcuts that work anywhere (N, 1–9 and ?) need Option, for people who find single keys get in the way. Single keys are the default.
- Sync starts from an **invite link**: open it, tap **Join**, and that person has their own synced board. **Copy link for another device** in Settings adds a phone, tablet or computer to the same board with a link that works once, within a day. Settings → Sync → **Advanced** lists those devices (each can be removed), quick add, invites and **Delete synced board…**.
- Settings is grouped into Your day, Look and feel, Sync and backups (each its own page) and About. About links to **What's New**, **Support & FAQ**, **Privacy** and **Terms**. What's New is marked *New* after an update until it's opened.

It's a progressive web app: open it in Safari or Chrome and choose **Add to Home Screen** to install it. It works offline, and syncs through a small Cloudflare Worker when one is set up.

## How it's built

| Path | What it is |
| --- | --- |
| `app/` | The web app: plain HTML, CSS and JavaScript, no build step. Deployed to GitHub Pages. |
| `app/whats-new.html`, `support.html`, `privacy.html`, `terms.html` | Info pages. Each stands on its own (`pages.css`, `pages.js`), so the Support and Privacy URLs can also go on an App Store listing. Add a card to What's New whenever `APP_VERSION` is bumped. |
| `app/core.js` | The rules the app and the Worker must agree on: merging two copies of a board (newest stamp wins; on a tie a live copy beats a deleted one, otherwise the copy that arrived later wins), which Done todos are older, where a quick add lands, and what the morning moves from Tomorrow to Now. An ES module with no dependencies: the app loads it as `window.NatCore`, the Worker imports it (wrangler bundles it), and `worker/test/core.test.mjs` tests it. |
| `app/sw.js` | Service worker for offline use. Its cache name is stamped with the build on each deploy. It waits 3 seconds for the network before falling back to the saved copy, and keeps fonts in their own cache (`nat-fonts-v1`) across deploys. |
| `worker/` | Cloudflare Worker that stores each person's board in Workers KV. Tests: `npm test` in `worker/` runs the shared-rule tests and the Worker tests (they also run before every deploy, and a change to `app/core.js` redeploys the Worker). |
| `docs/self-hosting.md` | How anyone can run their own sync Worker on Cloudflare's free plan. Linked from Support. |
| `scripts/check.sh` | Fast checks: `node --check` on every script, the tests, and that `APP_VERSION` matches the *Latest* card on What's New. Runs on every pull request (`.github/workflows/checks.yml`) and before each Pages deploy. |
| `.github/workflows/pages.yml` | Deploys `app/` to GitHub Pages on every push to `main`, stamping the build number, commit and date into the app and writing `version.json`. |
| `.github/workflows/worker.yml` | Deploys the Worker to Cloudflare on pushes that change `worker/` or `app/core.js`. |

Data lives in the browser's local storage first. When sync is set up, the app sends its whole board to the Worker after each change and whenever it's reopened. The Worker merges it with the stored board (the newest edit wins for each list, each todo and the settings) and sends the result back, so a phone and an iPad can both be used without overwriting each other. While the app is on screen it also checks for changes from other devices every 20 seconds, and right away when its tab or window comes back into focus, so a board left open on a computer keeps up with edits made on a phone. These checks only read the board (no KV writes), pause while the tab is hidden, and wait while you're typing or dragging.

The badge in the header shows where things stand: **Synced · Name** (and whose board this device syncs with), **Syncing…**, **Offline · 3 unsynced** when the Worker can't be reached, or **Sync problem** when it refuses (for example a wrong token). Unsynced changes are counted against what the Worker last confirmed, so the count survives closing the app while offline, and while offline each unsynced todo gets a small amber ring. Tap the badge to sync right away; on a phone, tapping also explains a problem. If an edit made on this device loses to a newer edit of the same todo or list from another device, a message says so (for example “Buy milk” was also changed on another device).

Each person has their own board and their own access token. There are two kinds of token:

- **Owner tokens** are Worker secrets named `TOKEN_<NAME>`, set by hand (Nate's and Tiffany's). That board is stored under the KV key `board:<name>`. Two secrets must never hold the same value.
- **Invited tokens** are made by the Worker when someone opens an invite link (see [Invites](#invites)). That board is stored under `board:b_<random id>`, and KV holds only a SHA-256 hash of the token (`tok:<hash>`), never the token itself.

To share one board, two people use the same token: **Copy link for another device** in Settings makes a link that carries it.

## Names

The app is called **Now or Later** (it was Now and Then until 1.11). The repository is `TweetingBirds/now-or-later` (renamed from `now-and-then`; GitHub redirects the old links). The Worker `now-and-then-sync`, the KV namespace `now-and-then` and the `NOW_AND_THEN` binding keep the old name, so nothing in Cloudflare had to move.

## Setup

### 1. Turn on GitHub Pages

In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**. The app is served at
`https://now-or-later.app/`, set as this repo's **Custom domain** on the same page with **Enforce HTTPS** on (a `CNAME` file isn't used, because Pages deploys from Actions). The `now-or-later.app` zone is on Cloudflare, with every record set to **DNS only** (a gray cloud), because GitHub can't issue its certificate through Cloudflare's proxy:

- `@` A: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- `@` AAAA: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
- `www` CNAME: `tweetingbirds.github.io` (GitHub redirects www to the bare domain)

### Old addresses

The app lived at `https://tweetingbirds.com/now-and-then/` until 1.12 (GitHub redirects that to the current address), then at `https://now-or-later.tweetingbirds.com/` until 1.22. GitHub serves only one custom domain per repo, so the subdomain is served by a small Worker in `mover/` (`now-or-later-old-address`, a Workers custom domain on the `tweetingbirds.com` zone):

- `/` reads that device's lists and sync settings (browsers keep storage per address, so a redirect alone would strand them) and opens `https://now-or-later.app/#move=<payload>`. The app there writes them into its own storage (`readMove` in `app/app.js`). Invite and device links keep their `#`, and quick-add links keep their `?add=`.
- `/sw.js` is a service worker that deletes the old app's offline copy and unregisters itself.
- Everything else gets a 301 to the same path on `now-or-later.app`.

It deploys from `.github/workflows/old-address.yml` when `mover/` changes. To deploy it by hand: `cd mover && npx wrangler deploy`. Delete the old `now-or-later` CNAME in the `tweetingbirds.com` zone first; Cloudflare makes the record for the Worker itself. The API token needs **Workers Scripts: Edit**, **Workers Routes: Edit** and **DNS: Edit** on that zone.

Every page has a Content Security Policy in a `<meta>` tag: scripts only from the site itself (plus a hash for the small inline theme script in `index.html`), styles from the site and Google Fonts, and network requests to the site or any `https:` address (the sync Worker can be anyone's). If you add an inline script, add its hash to the policy or move it into a file. Pages also set `referrer` to `same-origin`, so invite codes in a link never leak to another site.

### 2. Connect Cloudflare

The KV namespace `now-and-then` already exists in the Cloudflare account, and its id is in `worker/wrangler.toml`.

Add these as repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → the Account ID on the right. |

Then run **Actions → Deploy sync Worker to Cloudflare → Run workflow**. The Worker is deployed as `now-and-then-sync`, at
`https://now-and-then-sync.<your-subdomain>.workers.dev`. Opening that address in a browser shows "Now or Later sync is running."

Each person's access token is a **Worker secret**, not a repo secret. Make one long random string per person (for example `openssl rand -hex 32`) and set it from `worker/`:

```sh
npx wrangler secret put TOKEN_NATE
npx wrangler secret put TOKEN_TIFFANY
```

or in the Cloudflare dashboard under **Workers & Pages → now-and-then-sync → Settings → Variables and Secrets**. Deploys keep these secrets as they are, so changing the Worker code never changes anyone's token. To add another person, add another `TOKEN_<NAME>` secret.

Every token must be different. If two `TOKEN_*` secrets hold the same value the Worker refuses to sync with it instead of guessing whose board it is. The Worker also tells the app whose board a token opens (Settings shows "Syncing with Nate's board"), and if a device's token suddenly opens a different board than before, the app stops and warns instead of merging the two boards.

### 3. Connect each phone

Open the app, tap **Settings** → **Sync** → **Set up by hand**, and paste the Worker address and that person's token, then **Save and sync**. The first sync on a new device loads the saved board. The badge at the top stays hidden while sync is fine, and shows **Offline** or **Sync problem** (tap it to retry) when something needs attention.

## Invites

Owners listed in `ADMINS` in `worker/wrangler.toml` (now `nate`) see **Invite people** in Settings → Sync. **Create invite link** asks the Worker for a one-time code and shares a link like `https://now-or-later.app/#join=<code>&sync=<worker address>`. The code and the Worker address sit after the `#`, so GitHub Pages never sees them.

Opening the link shows **Join Now or Later sync**, with an optional name for the board and the Worker's host name. **Join** calls `POST /join`, which deletes the invite, makes a new board and a new token, and returns the token once. The app saves it like a pasted token and uploads the lists already on that device. Invites expire after 14 days (up to 30) and Settings lists open ones with **Revoke**. The note on an invite ("Mom") is only for the person inviting; it's stored with the board so `GET /boards` can say who is who.

**Copy link for another device** calls `POST /devices`, which returns a one-time code (`dlink:<code>`, 24 hours), and shares `#device=<code>&sync=<worker address>`. Opening it calls `POST /devices/connect {code, label}`, which deletes the code and makes a new `nd_` token just for that device (`dtok:<hash>`, with the board, the device kind and the date). The token itself never travels in a link. `GET /devices` lists a board's devices and `DELETE /devices/<id>` signs one out. A device token stops working when its board is deleted, or, for an owner board, when the `TOKEN_*` secret is removed. Older `#connect=<token>` links are still accepted, but nothing makes them any more.

## Shared lists

Any list except Now and Tomorrow can be shared with people on other boards of the same Worker, while the rest of each board stays private. The list's ••• menu has **Share list…**, which calls `POST /shared {listId}`. The Worker moves that list and its todos out of the board into their own KV key, `shared:s_<random>`, and leaves a small placement record (`{sid, order}`) in the board's `shared` array. Then `POST /shared/<sid>/invites` makes a one-time link like `#share=<code>&sync=<worker address>` (14 days). Opening it on a device that syncs with the same Worker shows **Add a shared list**, which calls `POST /shared/join {code}`.

`GET /data` returns the board with its shared lists mixed in. Each one carries `shared` (its id) and `members` (first names), and its `order` comes from that person's own placement. `PUT /data` splits the incoming board back apart by each todo's `listId`, so todos move freely between private and shared lists. When a todo moves out of a shared list, a tombstone stays in the shared list so the other members' devices drop it instead of sending it back. Name and color are shared; position on the board is per person. Checked todos go to Done on each board as usual.

**People and links…** in a shared list's menu calls `GET /shared/<sid>` (members, which one is you, and open links; each listed link is read back directly, because KV's list can lag a delete by a minute, and `?also=<code>,…` names links the app just made that the list may not show yet). The person who shared it (the first member) can take someone off with `DELETE /shared/<sid>/members/<board>`, and anyone can withdraw an open link with `DELETE /shared/<sid>/invites/<code>`. A removed person's devices drop the list on their next sync instead of keeping a private copy, because the Worker ignores shared lists it no longer has for that board. A link stops working once its maker has left the list.

**Leave shared list…** calls `DELETE /shared/<sid>`. The board gets tombstones for the list and its todos (so the person's other devices remove it), and the list stays for everyone else. The last member out deletes it. Deleting a board, or an older app deleting the list, also counts as leaving. Limits: 10 people per list, shared lists count toward a board's 10 lists, and `MAX_SHARED` (default 100) caps how many exist on a Worker. The nightly copies of a board include its shared lists.

A shared list is a self-contained record (list, todos, members) referenced from each member's board, which maps directly onto CloudKit's shared record zones if the app moves to iCloud.

### Keeping merges safe

- **Old devices.** Each `PUT /data` carries `X-Synced-At`, the time of that device's previous upload. The Worker drops any list or todo it has never seen that is older than both that time and the 60-day tombstone window, and answers with a tombstone, so a phone that comes back online after months can't bring back things deleted long ago. A device that has never synced sends no header, so its lists always upload.
- **Removed from a shared list.** Shared lists the Worker no longer has for that board are dropped from an upload, along with their todos, instead of becoming private copies.
- **Quick add.** `POST /add` writes the todo to `inbox:<board>` (two days) before saving the board, and every `GET /data` and `PUT /data` folds the inbox in, so a todo from a Shortcut survives a device's upload landing at the same moment.
- **AI assistants.** Each MCP tool call reads the board, changes the todos it names with a fresh `updatedAt`, and saves them the same way as a quick add (inbox first, then the normal merge), so it can't lose a race with a device either.
- **Todo ids.** If a shared list carries a todo with the same id as one on the board, the board's copy wins, so the two can't overwrite each other.
- **Colors.** List colors are checked against `#rrggbb` on the Worker and in the app; anything else becomes Pebble.
- **Owner tokens** are compared by SHA-256 digest in constant time, and anything that isn't an owner secret or a well-formed `nt_`/`nd_` (or, on `/mcp`, `na_`) token is refused without a KV read.

### Older Done

Done keeps everything, and every edit redraws the board and syncs all of it, so a year of use made a phone slow (177 ms per checkbox at 2,000 Done todos) and the board heavy. Done todos whose `archivedDay` is more than 90 days ago move off the board:

- **In the app**, `packOld()` moves them to `nat.old.v1` on the device at start-up, each morning and after each sync. Done draws at most 100 rows at first. Searching, or **Look further back**, adds the device's older todos plus the Worker's (`GET /old`, fetched once per visit). Putting one back puts it on the board again. Backups and the CSV include them.
- **On the Worker**, every `PUT /data` moves the board's own old Done todos into `old:<board>`, including ones an older app still sends. Todos the device packed before the Worker ever had them (say sync was turned on later) ride along once in the PUT body's `old` array.
- Todos on an archived list stay with the list, so **Use again** has them, and shared lists keep theirs. Keep `isOld()` in the Worker and `packOld()` in the app in step.
- Nightly copies hold the board only. `old:<board>` is deleted with the board.

### Clocks

The newest stamp wins a merge, so a device whose clock is off used to win or lose edits it shouldn't. Every Worker response carries `X-Server-Time`. The app measures its offset from it (`local.clockOffset`, ignored under 2 seconds) and stamps edits with the Worker's time, and each stamp is later than any it has seen (up to 5 minutes ahead), so an edit made after seeing another device's always wins. The Worker restamps anything more than a day in the future.

### Deleting a board

People who joined by invite see **Delete synced board…** in Settings. It calls `DELETE /data?confirm=delete`, which deletes `board:<id>`, every `snap:<id>:` copy, `old:<id>`, the token's `tok:` key and every device token made for the board, then leaves `gone:<hash>` (no other data) for 30 days. While that marker exists the token gets **410 Gone**, and the person's other devices turn sync off and say the board was deleted, instead of uploading it again. The app can also erase the lists on the device doing the delete.

Owner boards (`TOKEN_*`) can't delete themselves, because the secret would keep working. Remove those by hand: `wrangler secret delete TOKEN_<NAME>`, then delete `board:<name>` in the KV dashboard (its snapshots expire within 30 days). An admin can delete an invited board for someone who emails in: `GET /boards` lists them, `DELETE /boards/<id>` removes one just like the person's own delete.

### Worker API

| Request | Token | What it does |
| --- | --- | --- |
| `GET /data`, `PUT /data` | any | Read, or merge and save, the board. |
| `DELETE /data?confirm=delete` | invited | Delete the board, its copies and its token. |
| `POST /add` `{ text, to }` | any | Quick add: each line of `text` becomes a todo at the bottom of Now, or of the list `to` names (`tomorrow`, `later` or a list name). For iOS Shortcuts. |
| `GET /snapshots`, `GET /snapshots/<id>`, `POST /snapshots` | any | Nightly copies (see Backups). A `POST` for an unchanged board within 5 minutes of its last copy returns that copy. |
| `GET /old` | any | Done todos finished more than 90 days ago (see Older Done). |
| `POST /devices`, `GET /devices`, `DELETE /devices/<id>` | any | Make a one-time device link, list devices, sign one out. |
| `POST /devices/connect` `{code, label}` | none | Turn a device link into a device token. |
| `POST /agents` `{label, scope}`, `GET /agents`, `DELETE /agents/<id>` | any | Connect an AI assistant (`scope` is `read` or `write`), list them, remove one. The `na_` key and its `/mcp/<key>` address are returned once. |
| `POST /mcp`, `POST /mcp/<key>` | agent | MCP server (Streamable HTTP, stateless JSON). Tools: `list_todos`, `add_todos`, `check_off`, `move_todo`, `edit_todo`, `pencil_in`, `delete_todo`; read-only keys get `list_todos` only. See `worker/mcp.js`. |
| `POST /join` `{code, name}` | none | Turn an invite into a board and token. |
| `POST /invites` `{label, days}`, `GET /invites`, `DELETE /invites/<code>` | admin | Make, list and revoke invites. |
| `GET /boards`, `DELETE /boards/<id>` | admin | List invited boards (name, note, date joined) and remove one. |
| `POST /shared` `{listId}` | any | Share one of your lists. |
| `POST /shared/<sid>/invites` | member | Make a one-time link to add a shared list. |
| `POST /shared/join` `{code}` | any | Add a shared list to your board. |
| `GET /shared/<sid>` | member | Members and open links. |
| `DELETE /shared/<sid>/invites/<code>` | member | Withdraw an open link. |
| `DELETE /shared/<sid>/members/<board>` | sharer | Take someone off the list. |
| `DELETE /shared/<sid>` | member | Leave a shared list (the last one out deletes it). |

Every board response carries `X-Board` (the board id the app pins itself to), `X-Board-Name`, `X-Board-Kind` (`owner` or `invited`) and, for admins, `X-Board-Admin: 1`.

### AI assistants

Settings > Sync > Advanced > **AI assistants** calls `POST /agents`, which makes an `na_` key stored only as `atok:<hash>` (with the board, a label, `read` or `write`, and the date), and shows `https://<worker>/mcp/na_…` once. Claude's custom connector screen has nowhere to put a header, so the key rides in the address; a header (`Authorization: Bearer na_…` on `POST /mcp`) works too. Agent keys open nothing but `/mcp`: `whoIs` refuses them everywhere else, so they can't read `/data` directly, share, invite, add devices or delete the board. At most 10 per board; deleting the board, or removing an owner's `TOKEN_*` secret, ends them.

The app sends `X-Time-Zone` with each `PUT /data`, and the Worker keeps it as `tz` beside the board (not in settings), so `list_todos` and `check_off` use the person's own date. The tools follow the app's rules: steps go with their todo, the last step checks its todo, "Finished todos move to Done: Right away" archives a checked todo, and `pencil_in` refuses Now, Tomorrow, shared lists and steps.

### Costs and limits

All of this stays inside Cloudflare's free plan, with nothing to maintain:

- **KV writes (1,000 a day)** are the tight one. Each sync after an edit is one write, plus one for a shared list it changed. A board's nightly copy is two (the copy and its fingerprint), and only on nights it changed or a week after its last copy. Joining is one. Polling never writes.
- **KV reads (100,000 a day).** The 20-second refresh reads the board plus one read per shared list on it, and an invited token's lookup is cached for a minute inside the Worker, so it costs about one read per refresh, like an owner token.
- **KV deletes and lists (1,000 a day each)** are only used by joining, deleting and the nightly backup.
- `MAX_BOARDS` in `wrangler.toml` (12) caps invited boards so a forwarded invite can't run the account over. If a free limit is reached, Cloudflare refuses requests until the next day; it never bills a free account.

- A save is refused (413) above 500 lists, 30,000 todos or 20,000 older Done todos, and todo text is cut at 5,000 characters, so a leaked token or buggy device can't fill KV. A manual snapshot of an unchanged board within 5 minutes of the last one reuses it.

Anyone who would rather keep their lists in their own Cloudflare account can follow [docs/self-hosting.md](docs/self-hosting.md).

## Backups

Settings → **Backups** has three buttons:

- **Download backup** saves a JSON file with every list, todo and Done item. On a phone it opens the share sheet, so choose **Save to Files**.
- **Download CSV** saves the same todos as a spreadsheet (list, todo, status, dates) for Numbers or Excel. It can't be restored.
- **Restore from file…** reads a backup file and puts every list and todo in it back the way it was. Things added since the backup are kept unless you tick **Also remove lists and todos added since this backup**. The restore syncs to the other devices like any other edit.

The Worker also keeps its own copies. Every night at 09:00 UTC (the cron trigger in `wrangler.toml`) it copies each board that changed since its last copy (or whose last copy is a week old) to a KV key `snap:<name>:<time>`, which KV deletes by itself after 30 days. `snaplast:<name>` remembers the last copy's fingerprint (newest edit time and counts). When sync is on, Settings lists these copies and can restore or download any of them. Before any restore, the app asks the Worker for one more copy of the board as it was, labelled "before restore", so a restore can be undone the same way. The Worker's backup endpoints use the same token as `/data`, and a token only sees its own board's copies:

| Request | What it does |
| --- | --- |
| `GET /snapshots` | Lists the board's copies, newest first, with counts. |
| `GET /snapshots/<id>` | Returns one copy. |
| `POST /snapshots` | Takes a copy now. |

## Local development

Any static file server works, for example:

```sh
npx serve app
```
