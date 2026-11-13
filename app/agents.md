# Now or Later: connecting an AI agent

This page is written for AI agents and the people setting them up. It explains how to connect to a Now or Later board over MCP (Model Context Protocol) and what the tools do.

Now or Later is a simple todo app that works like a paper notebook. A board usually has the lists **Now** (today), **Tomorrow** and **Later** (someday), plus any the person added. Each morning, unfinished Tomorrow todos move into Now. Checked todos stay on their list for the rest of the day, then move to **Done**. There are no due dates, reminders or overdue todos, on purpose.

## 1. Get a connection address (a person does this)

An agent can't create its own key. The person whose lists these are makes one in the app:

1. Open Now or Later with sync turned on.
2. Go to **Settings > Sync > Advanced > AI assistants**.
3. Choose **Can only read** or **Can read and change**, optionally name it, and tap **Connect an assistant**.
4. Copy the address it shows. It's shown only once.

The address looks like this:

```
https://<sync-service>/mcp/na_<43 characters>
```

`<sync-service>` is the person's sync Worker, for example `now-and-then-sync.nates-account-d16.workers.dev`. The `na_…` part is the key. Treat the whole address as a secret: anyone who has it can reach the lists. Don't write it into files that get committed or shared.

If you were given only this page, ask the person for the address.

## 2. Add the server to your client

The server speaks MCP over **Streamable HTTP**. It's stateless and answers every request with plain JSON (no SSE stream, no sessions). It needs no OAuth: the key is in the address. You can also send the key as a header to `https://<sync-service>/mcp` with `Authorization: Bearer na_…`.

**Claude Code**

```sh
claude mcp add --transport http now-or-later "https://<sync-service>/mcp/na_…"
```

Add `--scope user` to make it available in every project. With the key in a header instead:

```sh
claude mcp add --transport http now-or-later "https://<sync-service>/mcp" --header "Authorization: Bearer na_…"
```

**Claude (web, desktop and mobile apps)**

In Claude, go to **Settings > Connectors > Add custom connector**. Name it "Now or Later", paste the address as the URL, and leave the OAuth fields empty. The person has to do this step in the Claude app.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{ "mcpServers": { "now-or-later": { "url": "https://<sync-service>/mcp/na_…" } } }
```

**VS Code** (`.vscode/mcp.json` or the user `mcp.json`)

```json
{ "servers": { "now-or-later": { "type": "http", "url": "https://<sync-service>/mcp/na_…" } } }
```

**Any other MCP client:** use the address as a remote (Streamable HTTP) server URL.

### Check that it works

```sh
curl -s "https://<sync-service>/mcp/na_…" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_todos","arguments":{}}}'
```

If it works, you get back `{"jsonrpc":"2.0","id":1,"result":{...}}` with today's date and the lists. HTTP 401 means the key is wrong. 410 means the connection was removed in the app, so ask the person for a new one.

## 3. Tools

A read-only connection gets only `list_todos`. A read-and-change connection gets all seven. Todo ids come from `list_todos`. When a tool can't do something (a list name that doesn't exist, a todo already in Done), the result has `isError: true` and a sentence saying why.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_todos` | `list?`, `include_done?` | Returns `today` (YYYY-MM-DD in the person's time zone), then the lists in order with their todos. A todo has `id`, `text` and `done`, plus `pencil` when it's penciled in and `steps` when it has them. Shared lists include `shared_with`. With `include_done`, it also returns up to 50 recent Done todos. |
| `add_todos` | `text`, `list?`, `under?` | Each line of `text` becomes a todo at the bottom of the list (Now by default; up to 50 lines, 500 characters each). Leading `- ` or `* ` bullets are dropped. With `under` set to a todo id, the lines become that todo's steps. |
| `check_off` | `id`, `done?` | Checks a todo and its steps, or unchecks it with `done: false`. Checking a todo's last open step checks the todo too. If the person set "Finished todos move to Done" to **Right away** in Settings, a checked todo moves straight to Done. |
| `move_todo` | `id`, `list?`, `position?` | Moves a todo, steps and all, to another list (or within its own list), at the `top` or `bottom` (the default). A step moved this way becomes an ordinary todo. Moving to Now or Tomorrow takes off its penciled-in date. |
| `edit_todo` | `id`, `text` | Replaces the todo's text. |
| `pencil_in` | `id`, `date` | Pencils a todo in for a day (`YYYY-MM-DD`; an empty string clears it). The app moves it to Tomorrow the morning before and into Now on the day. It only works on lists other than Now and Tomorrow, not on shared lists or steps, and not for a day that has passed. |
| `delete_todo` | `id` | Deletes a todo and its steps. |

A `list` argument takes a list's name (case doesn't matter) or a role: `now`, `tomorrow` or `later`.

Agents can't create, rename, archive or delete lists, change settings, share lists, or reach backups. Those stay in the app.

## 4. Working with the lists

- Call `list_todos` first. Use its `today`, not your own clock, for anything about dates.
- Put things for today on Now, tomorrow on Tomorrow, and someday on Later. For a particular day further out, add the todo to Later and `pencil_in` the date.
- Keep todo text short, the way someone would jot it in a notebook.
- When something is finished, check it off. Delete only when the person asks.
- Don't reorganize or rewrite todos the person didn't ask about.
- Changes show up in the app at its next sync, within about 20 seconds while it's open. They're saved like edits from another device, so the nightly backups cover them.

## Running your own sync service

If you run your own copy of the sync Worker (see [docs/self-hosting.md](https://github.com/TweetingBirds/now-or-later/blob/main/docs/self-hosting.md)), the same `/mcp` and `/agents` routes come with it. The protocol details are in [worker/mcp.js](https://github.com/TweetingBirds/now-or-later/blob/main/worker/mcp.js).
