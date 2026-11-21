# Messager OpenCode Client

A Node.js control panel that turns a **Facebook Messenger thread** into a remote console for the
local [OpenCode](https://opencode.ai) service. It uses the **OnlyOrders external-service API** for
messaging, so no Facebook Graph credentials live in this repo.

Messenger message → OnlyOrders webhook → Cloudflare tunnel → this server → OpenCode SDK →
Messenger reply.

## Features

- **Shell escape hatch:** any message starting with `!` runs locally (`!ls`, `!cd /tmp`, …) and the output is sent back.
- **Session control:** list, attach, create and detach OpenCode sessions from Messenger.
- **Model control:** list connected models and switch the attached session's model.
- **Prompt streaming:** each completed OpenCode thinking step is relayed in a compact pattern, then the final answer is sent.
- **Errors & permissions:** OpenCode failures and permission requests are forwarded; permissions can be answered from Messenger.
- **Attachment summary:** attaching a session sends a confirmation, the active model and the last 3 turns (user + final reply only).
- **Self-healing tunnel:** a Cloudflare quick tunnel is started on every run, the OnlyOrders webhook is re-pointed automatically, and restarts are logged.

## Architecture

```
 Messenger (OryzaAdmin Page)
        │  message
        ▼
 OnlyOrders external service  ──webhook POST──▶  https://<random>.trycloudflare.com/webhook
   /api2/ext-service/:id/...                              │
        │  SendMessage / SendMessageSeenReq / ...         │ local port 8788
        └───────────────────────────────────────────────  ▼
                                                   msgctrl service (Node)
                                                   ├─ HTTP receiver (/webhook, /facebook-selected)
                                                   ├─ commands.js  (command router)
                                                   ├─ opencode.js  (@opencode/client)
                                                   └─ tunnel.js    (cloudflared lifecycle)
                                                            │
                                                            ▼
                                                   OpenCode service (127.0.0.1:49374)
```

The server does **not** talk to Facebook directly. Sending text uses OnlyOrders'
`POST /ext-service/:id/SendMessage`; the Page token stays on the OnlyOrders side.

## Requirements

- **Node.js 22+** (tested on Node v24 from nvm)
- **`cloudflared`** installed and on `PATH` (Cloudflare quick tunnels)
- **`opencode` CLI v2** installed and on `PATH` (the client connects to its background service)
- An OnlyOrders external service with a connected Facebook Page (created by `msgctrl init`)

On this machine the working toolchain is:

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
```

## Install

```sh
cd /home/ubuntu/messager_opencode_client
npm install
npm link          # installs the global `msgctrl` command
msgctrl check     # verifies cloudflared + opencode
```

## First-time setup: `msgctrl init`

```sh
msgctrl init
```

Interactive flow:

1. Confirms `cloudflared` and `opencode` are present.
2. Asks for a **service name**.
3. Starts a Cloudflare quick tunnel and waits for its public URL.
4. Calls `/create` on OnlyOrders to create the external service.
5. Registers `<tunnel>/webhook` and stores the webhook UUID.
6. Calls `/getFacebookConnectOauthUrl` with `<tunnel>/facebook-selected` as the redirect, then prints the Facebook login URL.
7. **You open that URL in a browser and select Page(s).** OnlyOrders posts the selection to the tunnel; the local receiver stores it.
8. The CLI prints the selected Pages with numbers and asks which one becomes the control panel.
9. Choosing a number calls `/connectChannel` for that Page (this subscribes the Page's webhook, so OnlyOrders starts forwarding its messages) and stores `pageId`.
10. Opens an OpenCode connection and writes `~/.config/systemd/user/msgctrl.service`.

Nothing is sent to your external redirect except the Page **name** and **id** — no tokens.

## Running

```sh
msgctrl start     # foreground; used by systemd on boot
msgctrl status    # stored ids, tunnel URL and last log entries
msgctrl install   # (re)write the systemd user unit
msgctrl uninstall # remove it
```

Enable at boot:

```sh
systemctl --user enable --now msgctrl
```

Health check: `curl http://localhost:8788/health`

### What happens on every start

1. `db.json` is read for `serviceId`, `webhookId`, and `pageId`.
2. The local HTTP receiver binds first (so a port conflict fails fast).
3. `cloudflared tunnel --url http://localhost:8788` starts; the public URL is parsed from its output.
4. `PUT /ext-service/:id/webhook/:webhookId` updates the webhook URL to the **new** tunnel URL.
5. `state.json` records `tunnelUrl`, `webhookUrl`, `webhookUpdatedAt`, and appends log entries.
6. If cloudflared exits, it is restarted with backoff and the webhook is re-pointed again.

## Persistent files

| File | Contents | Protection |
|---|---|---|
| `db.json` | `serviceId`, `serviceName`, `webhookId`, `webhookUrl`, `pageId`, `pageName`, `channelId`, `defaultDirectory`, `defaultModel` | gitignored, `0600` |
| `state.json` | `tunnelUrl`, `webhookUrl`, `webhookUpdatedAt`, `selectedPages`, last 200 log entries | gitignored, `0600` |
| `~/.config/systemd/user/msgctrl.service` | systemd unit with `Restart=always` | user-managed |
| `msgctrl.log` | stdout/stderr when run under systemd | gitignored |

## Messenger command reference

| Message | Action |
|---|---|
| `!ls`, `!pwd`, `!cd /tmp` | Run a shell command; output is sent back. `!cd` changes the working directory for later `!` commands. |
| `/session` | List OpenCode sessions with numbers |
| `/session 2` | Attach to session 2; replies with confirmation, active model and last 3 turns |
| `/session new /home/oryxa` | Create and attach a session in that directory |
| `/session pwd` | Show active session title/id, directory and model |
| `/exit` | Detach from the current session |
| `/model ls` | List connected chat models with numbers |
| `/models 2` | Switch the attached session to model 2 |
| `/model pwd` | Show the active model and attached session |
| `/allow <id>` / `/always <id>` / `/reject <id>` | Answer a forwarded OpenCode permission request |
| anything else | Prompt for the attached session; if none is attached, you get the session list |

### Output behavior

- **Thinking:** 1st step is sent in full (`thinking: ...`), 2nd and 3rd are skipped, 4th is `(Thinking.....)`, then the pattern repeats (5th full, 8th compact, …). Tool-call chatter is never sent.
- **Final reply:** always sent after the turn finishes, even if a tool step failed.
- **Errors:** forwarded as `error [type]: message`, deduplicated per message.
- **Permissions:** forwarded with id/action/resources and reply instructions.
- **History on attach:** last 3 turns, separated by `#############`, user messages + final assistant text only (no reasoning, no tool calls).

## OnlyOrders API endpoints used

| Endpoint | Purpose |
|---|---|
| `POST /ext-service/create` | Create the service during init |
| `POST /ext-service/:id/webhook` | Register webhook |
| `PUT /ext-service/:id/webhook/:webhookId` | Re-point webhook on restart |
| `POST /ext-service/getFacebookConnectOauthUrl` | Build the Facebook connect URL |
| `POST /ext-service/:id/connectChannel` | Bank Page tokens, subscribe Page webhook, store channel |
| `POST /ext-service/:id/SendMessage` | Send text reply |
| `POST /ext-service/:id/SendMessageSeenReq` / `SendMessageTypingReq` | Seen / typing indicators (available via the API; not auto-sent) |
| `POST /ext-service/:id/sendCommentReply` | Available for comment replies (not auto-sent) |

Base URL is `https://onlyorders.tech/api2/ext-service` (override with `ONLYORDERS_API_BASE`).

## Project layout

```
bin/msgctrl          CLI entrypoint (init/start/status/install/uninstall/check)
src/config.js        db.json / state.json read/write, append-only log
src/tunnel.js        cloudflared quick-tunnel lifecycle + URL parsing
src/onlyorders.js    thin OnlyOrders API client
src/opencode.js      @opencode/client wrapper, history, prompt/stream handling
src/commands.js      Messenger command router
src/init.js          interactive setup flow
src/server.js        shared HTTP receiver + long-running runtime
src/systemd.js       systemd user-unit generation/install
test/                node:test suites (commands + core/config/init)
```

## Tests

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
npm test
```

20 tests cover command routing, history sorting, thinking relay, error forwarding, permission
handling, config persistence, tunnel parsing, systemd unit generation, the callback receiver, and
the full injected init flow. No live Messenger or OnlyOrders account is needed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cloudflared: missing` | Install cloudflared and re-run `msgctrl check` |
| `opencode: missing` | Install opencode CLI v2, start its service, re-run `msgctrl check` |
| `EADDRINUSE :8788` | Another msgctrl/node process is using the port; stop it with `pkill -f 'msgctrl start'` |
| No reply to a prompt | Check `state.json` logs and `msgctrl status`; ensure `pageId` is in `db.json` and the webhook is the only live one |
| Duplicate replies | Verify only one live webhook exists for the service; `msgctrl start` always PUTs the same stored webhook id |
| Webhook stopped after restart | `state.json` should show a fresh `webhookUpdatedAt`; if not, re-run `msgctrl start` |
| systemd unit not active | Run `systemctl --user daemon-reload && systemctl --user enable --now msgctrl` |

## Security

- `!` commands execute arbitrary shell commands with your user's privileges. Only give the connected
  Facebook Page to people you trust. This is a remote-control surface by design.
- `db.json` and `state.json` contain identifiers only — no Page access tokens. They are still
  written with `0600` and gitignored.
- No secrets are required in this repo. If a GitHub token or API key is ever pasted into chat, rotate it.
