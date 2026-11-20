import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSession,
  listModels,
  listSessions,
  pickRandomModel,
  promptAndWait,
  switchModel,
} from './opencode.js';

const run = promisify(exec);

function initialState(defaultDirectory) {
  return {
    sessionId: null,
    sessionList: [],
    modelList: [],
    lastModel: null,
    cwd: defaultDirectory,
  };
}

function numberedSessions(sessions) {
  if (!sessions.length) return 'No OpenCode sessions found.';
  return sessions
    .map((session, index) => {
      const title = session.title || session.id;
      const dir = session.location?.directory ? ` — ${session.location.directory}` : '';
      return `${index + 1}. ${title} (${session.id})${dir}`;
    })
    .join('\n');
}

function numberedModels(models) {
  if (!models.length) return 'No chat models are connected.';
  return models
    .map((model, index) => `${index + 1}. ${model.providerID}/${model.modelID} — ${model.name}`)
    .join('\n');
}

function parseNumber(text) {
  const match = /^\s*\d+\s*$/.exec(text);
  return match ? Number(match[0]) : null;
}

/** Optional deployment override, e.g. OPENCODE_MODEL=opencode/hy4-flash-free. */
function envModel() {
  const combined = process.env.OPENCODE_MODEL?.trim();
  if (combined?.includes('/')) {
    const [providerID, ...rest] = combined.split('/');
    return { id: rest.join('/'), providerID };
  }
  const id = process.env.OPENCODE_MODEL_ID?.trim();
  const providerID = process.env.OPENCODE_PROVIDER_ID?.trim();
  return id && providerID ? { id, providerID } : null;
}

/**
 * Builds the webhook handler. Dependencies are injected so the whole command surface can be
 * unit-tested without a live OpenCode service or Messenger connection.
 */
export function createCommandHandler({
  client,
  send,
  defaultDirectory = process.cwd(),
  log = () => {},
  execCommand = run,
}) {
  const states = new Map();

  async function refreshSessions(state) {
    state.sessionList = await listSessions(client);
    return state.sessionList;
  }

  async function refreshModels(state) {
    state.modelList = await listModels(client);
    return state.modelList;
  }

  async function runShell(body, state, reply) {
    const command = body.slice(1).trim();
    if (!command) return reply('Usage: !<command>');

    const cd = /^cd\s+(.+)$/.exec(command);
    if (cd) {
      state.cwd = cd[1].trim();
      return reply(`Working directory: ${state.cwd}`);
    }

    log('shell', { command: command.slice(0, 200), cwd: state.cwd });
    try {
      const { stdout, stderr } = await execCommand(command, {
        cwd: state.cwd ?? defaultDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      return reply(`$ ${command}\n${output || '(no output)'}`);
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim();
      return reply(`$ ${command}\nFAILED: ${err.message}\n${output}`.trim());
    }
  }

  async function handle(event) {
    const text = String(event?.payload?.text ?? '').trim();
    if (!text) return;

    const key = String(event?.customerInfo?.id ?? 'global');
    const state = states.get(key) ?? initialState(defaultDirectory);
    states.set(key, state);
    const pageId = String(event?.pageId ?? '');
    const reply = (message) => send(message, event);

    try {
      // Shell escape hatch
      if (text.startsWith('!')) return await runShell(text, state, reply);

      // Detach from current session
      if (/^\/exit$/i.test(text)) {
        state.sessionId = null;
        return reply('session exited');
      }

      // /session, /session N, /session new /path
      const sessionMatch = /^\/session(?:\s+(.+))?$/i.exec(text);
      if (sessionMatch) {
        const arg = sessionMatch[1]?.trim();
        if (!arg) {
          const sessions = await refreshSessions(state);
          return reply(`OpenCode sessions:\n${numberedSessions(sessions)}`);
        }
        if (/^new(?:\s+(.*))?$/i.test(arg)) {
          const dirMatch = /^new\s+(.+)$/i.exec(arg);
          const directory = dirMatch ? dirMatch[1].trim() : state.cwd ?? defaultDirectory;
          let model = state.lastModel ?? envModel();
          if (!model) {
            model = pickRandomModel(await refreshModels(state));
          }
          const session = await createSession(client, directory, model);
          state.sessionId = session.id;
          if (model) state.lastModel = model;
          return reply(
            `new session attached: ${session.id}\ndirectory: ${directory}\nmodel: ${model ? `${model.providerID}/${model.modelID}` : 'default'}`,
          );
        }
        const number = parseNumber(arg);
        if (!number) return reply('Usage: /session [number | new /directory]');
        if (!state.sessionList.length) await refreshSessions(state);
        const session = state.sessionList[number - 1];
        if (!session) return reply(`No session number ${number}. Send /session to see the list.`);
        state.sessionId = session.id;
        return reply(`session ${number} attached: ${session.id}\n${session.title ?? ''}`.trim());
      }

      // /model ls and /models N (both spellings accepted)
      const modelMatch = /^\/models?(?:\s+(.+))?$/i.exec(text);
      if (modelMatch) {
        const arg = modelMatch[1]?.trim();
        if (!arg || /^ls$/i.test(arg)) {
          const models = await refreshModels(state);
          return reply(`Connected models:\n${numberedModels(models)}`);
        }
        if (!state.sessionId) {
          const sessions = await refreshSessions(state);
          return reply(
            `No session attached — connect one first:\n${numberedSessions(sessions)}`,
          );
        }
        const number = parseNumber(arg);
        if (!number) return reply('Usage: /model ls | /models <number>');
        if (!state.modelList.length) await refreshModels(state);
        const model = state.modelList[number - 1];
        if (!model) return reply(`No model number ${number}. Send /model ls to see the list.`);
        await switchModel(client, state.sessionId, model);
        state.lastModel = model;
        return reply(`session ${state.sessionId} now uses ${model.providerID}/${model.modelID}`);
      }

      // Anything else is a prompt, but only when a session is attached.
      if (!state.sessionId) {
        const sessions = await refreshSessions(state);
        return reply(
          `No session currently attached. Connect one and send your message again:\n${numberedSessions(sessions)}`,
        );
      }

      log('prompt', { sessionId: state.sessionId, pageId, length: text.length });
      const answer = await promptAndWait(client, state.sessionId, text);
      return reply(answer);
    } catch (err) {
      log('error', { message: err instanceof Error ? err.message : String(err) });
      return reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return handle;
}
