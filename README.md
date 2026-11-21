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

## Setup with `msgctrl`

Requires Node.js 22+ and both `cloudflared` and `opencode` on `PATH`.

```sh
npm install
npm link                       # makes the `msgctrl` command available
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$HOME/.opencode/bin:$PATH"

msgctrl check                  # verify cloudflared and opencode
msgctrl init                   # interactive first-time setup (see below)
```

`msgctrl init` asks for a service name and then:

1. starts a Cloudflare quick tunnel;
2. creates the OnlyOrders external service and registers `<tunnel>/webhook`;
3. prints the Facebook connect URL — open it and choose the Page(s);
4. lists the selected Pages and asks which one becomes the control panel;
5. calls `/ext-service/:id/connectChannel` for that Page (which subscribes its webhook);
6. confirms the OpenCode service and writes `~/.config/systemd/user/msgctrl.service`.

All identifiers are stored in `db.json` (service id, webhook id, page id, channel id) and runtime
events/tunnel URL changes in `state.json`. Both files are gitignored and written with `0600`.

## Running and restarts

```sh
msgctrl start                  # foreground: tunnel → webhook sync → HTTP server
msgctrl status                 # stored ids and latest state log entries
msgctrl install                # (re)install the systemd user unit
msgctrl uninstall              # remove it
```

On every start (including after a device reboot, via systemd) the service starts a **new** quick
tunnel, PUTs the new URL to the stored webhook id, and records the change in `state.json`. If the
tunnel process dies it is restarted automatically and the webhook is re-pointed again.

To run under systemd after `msgctrl init`:

```sh
systemctl --user enable --now msgctrl
```

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
