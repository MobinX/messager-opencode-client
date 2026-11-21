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
  // Fetch newest-first (the SDK default) and sort by the message timestamp. Using order:'asc'
  // with a limit would return the OLDEST N messages on a long session, not the latest turns.
  const result = await client.message.list({ sessionID, limit: 100, order: 'desc' });
  const messages = (result.data ?? [])
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
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
  onError = () => {},
  onPermission = () => {},
  timeoutMs = 180_000,
) {
  const controller = new AbortController();
  const chunks = new Map();
  let done = false;
  let failed = null;
  let markConnected;
  const connected = new Promise((resolve) => { markConnected = resolve; });

  // One failure is often reported as a step failure and then an execution failure with the same
  // message. Forward each distinct error once, but never swallow a different one.
  const emittedErrors = new Set();
  const errorSends = [];
  const emitError = (message, type) => {
    const text = String(message ?? '').trim();
    if (!text || emittedErrors.has(text)) return;
    emittedErrors.add(text);
    const label = type ? `error [${type}]: ${text}` : `error: ${text}`;
    errorSends.push(Promise.resolve(onError(label)).catch((err) => {
      console.error('[opencode] failed to forward error', err);
    }));
  };
  const fail = (message, type) => {
    emitError(message, type);
    failed = message;
    done = true;
  };

  const subscription = (async () => {
    try {
      for await (const event of client.event.subscribe({
        types: [
          'server.connected',
          'permission.asked',
          'permission.replied',
          'session.reasoning.ended',
          'session.text.delta',
          'session.idle',
          'session.execution.succeeded',
          'session.step.failed',
          'session.retry.scheduled',
          'session.execution.failed',
          'session.execution.interrupted',
        ],
        signal: controller.signal,
      })) {
        if (event.type === 'server.connected') {
          markConnected();
          continue;
        }
        const data = event.data ?? {};
        if (event.type === 'permission.asked' && data.sessionID === sessionID) {
          const id = String(data.id ?? '');
          const action = String(data.action ?? 'permission');
          const resources = Array.isArray(data.resources) ? data.resources.join(', ') : '';
          const message = String(data.message ?? '').trim();
          onPermission({
            id,
            sessionID,
            action,
            resources,
            message,
            raw: data,
          });
        } else if (
          event.type === 'permission.replied' &&
          data.sessionID === sessionID &&
          data.requestID
        ) {
          onPermission({ resolved: true, id: String(data.requestID), sessionID, raw: data });
        } else if (event.type === 'session.reasoning.ended' && data.sessionID === sessionID) {
          const thought = String(data.text ?? '').trim();
          if (thought) onThinking(thought);
        } else if (event.type === 'session.text.delta' && data.sessionID === sessionID) {
          const id = data.assistantMessageID ?? 'default';
          chunks.set(id, (chunks.get(id) ?? '') + (data.delta ?? ''));
        } else if (
          (event.type === 'session.step.failed' ||
            event.type === 'session.retry.scheduled' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted') &&
          data.sessionID === sessionID
        ) {
          const message =
            data.error?.message ??
            (event.type === 'session.execution.interrupted'
              ? `execution interrupted (${data.reason ?? 'unknown'})`
              : event.type);
          emitError(message, event.type);
          if (
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            failed = message;
            done = true;
            break;
          }
        } else if (
          (event.type === 'session.idle' || event.type === 'session.execution.succeeded') &&
          data.sessionID === sessionID
        ) {
          done = true;
          break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        failed = err instanceof Error ? err.message : String(err);
        emitError(failed, 'subscription');
      }
    }
  })();

  const startedAt = Date.now();
  try {
    // The event stream is live-only. Wait for the server.connected marker before sending the
    // prompt, otherwise the fast execution.failed / text events are missed entirely.
    await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await client.session.prompt({ sessionID, text });

    const deadline = Date.now() + timeoutMs;
    while (!done && Date.now() < deadline) await sleep(250);
    if (!done) {
      failed = 'timeout waiting for OpenCode reply';
      emitError(failed, 'timeout');
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    emitError(failed, 'prompt');
  } finally {
    controller.abort();
    await Promise.race([subscription.catch(() => {}), sleep(1000)]);
  }

  await Promise.allSettled(errorSends);
  if (failed) {
    const error = new Error(String(failed));
    error.forwarded = true;
    throw error;
  }

  let replyText = Array.from(chunks.values()).join('\n').trim();
  if (!replyText) {
    // Fallback: a streamed text delta can be missed on a busy event source. Read the newest
    // assistant message created by this prompt directly from the session history.
    try {
      const messages = await client.message.list({ sessionID, limit: 10, order: 'desc' });
      const assistant = (messages.data ?? []).find(
        (message) =>
          message.type === 'assistant' &&
          (message.time?.created ?? 0) >= startedAt - 2000 &&
          (message.content ?? []).some((part) => part.type === 'text'),
      );
      if (assistant) {
        replyText = (assistant.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => String(part.text ?? ''))
          .join('\n')
          .trim();
      }
    } catch {
      // The streamed text is the primary source; history is only a safety net.
    }
  }
  return replyText || '(OpenCode returned no text)';
}
