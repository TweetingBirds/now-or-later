# Run your own sync Worker

Now or Later keeps your lists on your device. Sync copies them to a small program, a Cloudflare Worker, so your phone, tablet and computer show the same board. You can use the Worker run by Tweeting Birds (by invite), or run your own in your own free Cloudflare account. Then your lists are stored only in your account.

This takes about fifteen minutes. You need a computer with [Node.js](https://nodejs.org) 20 or later, and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

## 1. Get the code

```sh
git clone https://github.com/TweetingBirds/now-or-later.git
cd now-or-later/worker
```

(Or download the repository as a ZIP from GitHub and open the `worker` folder in a terminal.)

## 2. Sign in to Cloudflare

```sh
npx wrangler login
```

A browser window asks you to allow Wrangler, Cloudflare's command-line tool, into your account.

## 3. Make a place to store boards

```sh
npx wrangler kv namespace create now-and-then
```

It prints an `id`. Open `wrangler.toml` and put your id in place of the one there:

```toml
[[kv_namespaces]]
binding = "NOW_AND_THEN"
id = "paste-your-id-here"
```

While `wrangler.toml` is open, set `ADMINS` to the name you'll use in step 5, in lowercase (for example `ADMINS = "sam"`). Leave it empty (`ADMINS = ""`) if you don't want to invite anyone.

## 4. Put the Worker online

```sh
npx wrangler deploy
```

It prints your Worker's address, something like `https://now-and-then-sync.your-name.workers.dev`. Open it in a browser and you should see "Now or Later sync is running."

## 5. Make your access token

Your token is the password for your board. Make a long random one:

```sh
openssl rand -hex 32
```

Copy what it prints, then save it as a Worker secret, using your name in capitals:

```sh
npx wrangler secret put TOKEN_SAM
```

Paste the token when it asks. Each `TOKEN_<NAME>` secret is one board. Every token must be different.

## 6. Connect the app

Open [Now or Later](https://now-or-later.app/), tap **Settings**, then **Sync**, tap **Set up sync by hand…**, and paste your Worker's address and your token. Tap **Save and sync**.

To add your other devices, tap **Add a device** in Settings → Sync and open that link on each one. Each link works once, within a day, and gives that device its own token. **Your devices** lists them so you can sign out one you've lost. Removing a `TOKEN_<NAME>` secret signs out every device added from it, too.

## Inviting family

If your name is in `ADMINS`, Settings → Sync shows **People**, with **Invite someone**. Each invite link gives one person their own board on your Worker, with a token made for them. They open it, tap **Join**, and they're syncing. Invites work once and expire after 14 days. Settings lists open invites, so you can revoke one.

People who joined by invite can delete their own board from Settings at any time. Boards you made with `TOKEN_<NAME>` secrets are deleted by hand (below).

## Backups

Every night at 09:00 UTC the Worker copies each board that changed since its last copy (and any board whose last copy is a week old), and keeps each copy for 30 days. Settings can restore or download those copies. To change the time, edit `crons` in `wrangler.toml`.

## Costs

Cloudflare's free plan covers a household easily. The tightest limit is 1,000 KV writes a day: each sync after an edit is one write, and a board's nightly backup is two more on nights it changed. Reads (the 20-second refresh while the app is open) have a 100,000-a-day limit. `MAX_BOARDS` in `wrangler.toml` (12 by default) caps how many people can join by invite. If you go over a free limit, Cloudflare refuses requests until the next day; it never charges you on the free plan.

## Updating

Pull the latest code and deploy again:

```sh
git pull
npx wrangler deploy
```

Deploying never changes your secrets, so tokens keep working.

## Deleting everything

- One invited board: delete it from the app, or as an admin run
  `curl -X DELETE -H "Authorization: Bearer <your token>" https://<your worker>/boards/<board id>`
  (`GET /boards` lists board ids).
- A `TOKEN_<NAME>` board: `npx wrangler secret delete TOKEN_SAM`, then in the Cloudflare dashboard under **Storage & Databases → KV → now-and-then** delete `board:sam` and the `snap:sam:` keys (they also expire on their own after 30 days).
- All of it: `npx wrangler delete` removes the Worker, and deleting the KV namespace in the dashboard removes every board.
