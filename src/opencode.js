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
 * Sends a prompt and returns ONLY the assistant's final text.
 *
 * Reasoning deltas and tool-call events are deliberately not collected: the panel must not
 * forward "thinking..." or "calling tool write" chatter to Messenger. Text deltas are grouped by
 * assistantMessageID so a streamed answer is returned once, in order.
 */
export async function promptAndWait(client, sessionID, text, timeoutMs = 180_000) {
  const controller = new AbortController();
  const chunks = new Map();
  let done = false;
  let failed = null;

  const subscription = (async () => {
    try {
      for await (const event of client.event.subscribe({
        types: [
          'session.text.delta',
          'session.idle',
          'session.execution.failed',
          'session.execution.interrupted',
        ],
        signal: controller.signal,
      })) {
        const data = event.data ?? {};
        if (event.type === 'session.text.delta' && data.sessionID === sessionID) {
          const id = data.assistantMessageID ?? 'default';
          chunks.set(id, (chunks.get(id) ?? '') + (data.delta ?? ''));
        } else if (
          (event.type === 'session.idle' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted') &&
          data.sessionID === sessionID
        ) {
          if (event.type !== 'session.idle') failed = event.type;
          done = true;
          break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) failed = err instanceof Error ? err.message : String(err);
    }
  })();

  try {
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
