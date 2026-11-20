import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

/** Discovers (or starts) the local OpenCode service and returns a typed client. */
export async function connect() {
  const endpoint = await Service.ensure();
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return { client, endpoint };
}

export async function listSessions(client, limit = 50) {
  const result = await client.session.list({ limit, order: 'desc' });
  return result.data ?? [];
}

export async function getSession(client, sessionID) {
  return client.session.get({ sessionID });
}

/**
 * Last conversation turns: user messages paired with the assistant's final text only.
 * Reasoning and tool-call content is filtered out.
 */
export async function getSessionHistory(client, sessionID, turns = 3) {
  const result = await client.message.list({ sessionID, limit: 100, order: 'asc' });
  const messages = result.data ?? [];
  const history = [];

  for (const message of messages) {
    if (message.type === 'user') {
      history.push({ user: String(message.text ?? ''), assistant: null });
    } else if (message.type === 'assistant' && history.length) {
      const text = (message.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => String(part.text ?? ''))
        .join('\n')
        .trim();
      if (text) history[history.length - 1].assistant = text;
    }
  }

  return history.slice(-turns);
}

export async function listModels(client) {
  const result = await client.model.list();
  return (result.data ?? []).filter((model) => model.enabled !== false && model.type !== 'image' && model.type !== 'video');
}

export function modelRef(model) {
  return { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) };
}

export function pickRandomModel(models) {
  const chat = models.filter((model) => !model.type || model.type === 'chat');
  const pool = chat.length ? chat : models;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function createSession(client, directory, model) {
  return client.session.create({
    location: { directory },
    ...(model ? { model: modelRef(model) } : {}),
    title: 'Messenger control panel',
  });
}

export async function switchModel(client, sessionID, model) {
  await client.session.switchModel({ sessionID, model: modelRef(model) });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a prompt, streams each completed reasoning (thinking) step through `onThinking`, and
 * returns ONLY the assistant's final text.
 *
 * Tool-call chatter is intentionally not forwarded. Text deltas are grouped by assistantMessageID
 * so a streamed answer is returned once, in order.
 */
export async function promptAndWait(
  client,
  sessionID,
  text,
  onThinking = () => {},
  timeoutMs = 180_000,
) {
  const controller = new AbortController();
  const chunks = new Map();
  let done = false;
  let failed = null;
  let markConnected;
  const connected = new Promise((resolve) => { markConnected = resolve; });

  const subscription = (async () => {
    try {
      for await (const event of client.event.subscribe({
        types: [
          'server.connected',
          'session.reasoning.ended',
          'session.text.delta',
          'session.idle',
          'session.execution.succeeded',
          'session.execution.failed',
          'session.execution.interrupted',
          'session.step.failed',
        ],
        signal: controller.signal,
      })) {
        if (event.type === 'server.connected') {
          markConnected();
          continue;
        }
        const data = event.data ?? {};
        if (event.type === 'session.reasoning.ended' && data.sessionID === sessionID) {
          const thought = String(data.text ?? '').trim();
          if (thought) onThinking(thought);
        } else if (event.type === 'session.text.delta' && data.sessionID === sessionID) {
          const id = data.assistantMessageID ?? 'default';
          chunks.set(id, (chunks.get(id) ?? '') + (data.delta ?? ''));
        } else if (
          (event.type === 'session.idle' ||
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted' ||
            event.type === 'session.step.failed') &&
          data.sessionID === sessionID
        ) {
          if (
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted' ||
            event.type === 'session.step.failed'
          ) {
            failed = data.error?.message ?? event.type;
          }
          done = true;
          break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) failed = err instanceof Error ? err.message : String(err);
    }
  })();

  try {
    // The event stream is live-only. Wait for the server.connected marker before sending the
    // prompt, otherwise the fast execution.failed / text events are missed entirely.
    await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await client.session.prompt({ sessionID, text });

    const deadline = Date.now() + timeoutMs;
    while (!done && Date.now() < deadline) await sleep(250);
    if (!done) failed = 'timeout waiting for OpenCode reply';
  } finally {
    controller.abort();
    await Promise.race([subscription.catch(() => {}), sleep(1000)]);
  }

  if (failed) throw new Error(String(failed));
  return Array.from(chunks.values()).join('\n').trim() || '(OpenCode returned no text)';
}
