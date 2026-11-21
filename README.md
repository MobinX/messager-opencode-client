# Messager OpenCode Client

A Node.js webhook server that turns a Facebook Messenger thread into a control panel for the
local OpenCode service, using the OnlyOrders external-service messaging API.

Messages arriving on the OnlyOrders webhook are parsed:
- `!command` runs a shell command locally and returns its output.
- `/session`, `/session 2`, `/session new /path` manage OpenCode sessions. Attaching replies with
  a confirmation, the active model and the last 3 turns (user messages + final replies only).
- `/session pwd` shows the active session and model; `/model pwd` shows the active model.
- `/exit` detaches from the current session.
- `/model ls`, `/models 2` list and switch models.
- Anything else is sent as a prompt to the attached session (or asks you to attach one first).

For a prompt, thinking is relayed in a compact pattern: the 1st step is sent in full as
`thinking: ...`, the next 2 are skipped, the 4th becomes `(Thinking.....)`, then the pattern
repeats (5th full, 8th compact, ...). The assistant's final answer is always sent. Tool-call
chatter is ignored. OpenCode errors (step failures, retries, execution failures/interruptions and
prompt/stream failures) are forwarded to Messenger as `error [type]: message`; each distinct error
is sent once. OpenCode permission requests are forwarded with their id/action/resources and can be
answered from Messenger with `/allow <id>`, `/always <id>`, or `/reject <id>`. Attachment history
separates each of the last 3 turns with `#############`.

## Setup

Requires Node.js 22+ (tested on the nvm v24 toolchain) and the `opencode` CLI on `PATH`.

```sh
npm install
cp .env.example .env
```

Set `ONLYORDERS_SERVICE_ID` to an existing service that already has a connected Facebook channel.
If it is empty, the server creates a new service on boot (you will then need to connect a channel
before replies can be sent).

## Run behind a Cloudflare quick tunnel

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
cd /home/ubuntu/messager_opencode_client

node --env-file=.env src/server.js &
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://<name>.trycloudflare.com` URL, then register it as the OnlyOrders webhook:

```sh
curl "http://localhost:8788/register?url=https://<name>.trycloudflare.com"
```

Or set `PUBLIC_WEBHOOK_URL` in `.env` before starting. The server registers
`<url>/webhook` on startup.

Health check: `curl http://localhost:8788/health`

## Commands (from Messenger)

| Message | Action |
|---|---|
| `!ls`, `!cd /tmp`, … | Run a shell command and reply with its output |
| `/session` | List OpenCode sessions with numbers |
| `/session 2` | Attach to session 2 |
| `/session new /home/oryxa` | Create and attach a session in that directory |
| `/exit` | Detach from the current session |
| `/model ls` | List connected models with numbers |
| `/models 2` | Switch the attached session to model 2 |
| any other text | Send as a prompt to the attached session |

If no session is attached, a normal message returns the session list and asks you to connect first.
A newly created session uses the last selected model (or a random chat model on first use).

## Tests

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"
npm test
```

The tests exercise the full command surface with a fake OpenCode client, so no live Messenger,
OnlyOrders or OpenCode turn is needed.

## Security note

The `!` prefix executes arbitrary shell commands on the machine running this server. Restrict who
can message the connected Facebook Page; this is a remote-control surface by design.
