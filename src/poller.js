/**
 * Polling worker for one OpenCode session.
 *
 * Instead of subscribing to the live event stream, it asks the v2 API for the session's messages
 * every few seconds. It starts when a Messenger user attaches, so it reports both prompts sent
 * through the bot and work already running when the user attached. Only messages created after the
 * poll started are delivered — nothing is replayed from the beginning of the session.
 */
export function createSessionPoller({
  client,
  sessionID,
  onThinking = () => {},
  onReply = () => {},
  onError = () => {},
  onPermission = () => {},
  intervalMs = 3000,
  logger = console,
  startedAt = Date.now(),
} = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = false;

  // message id -> signature of the parts we have already forwarded
  const seen = new Map();
  const seenPermissions = new Set();
  const startedAtAdjusted = startedAt - 2000;

  const partsOf = (message) => message.content ?? [];
  const textParts = (message, type) =>
    partsOf(message)
      .filter((part) => part.type === type)
      .map((part) => String(part.text ?? ''))
      .join('\n')
      .trim();

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await client.message.list({ sessionID, limit: 100, order: 'asc' });
      const messages = (result.data ?? [])
        .filter((message) => (message.time?.created ?? 0) >= startedAtAdjusted)
        .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

      if (client.permission?.request?.list) {
        const result = await client.permission.request.list();
        const pending = result.data ?? [];
        const ids = new Set((pending ?? []).map((request) => String(request.id)));
        for (const request of pending ?? []) {
          if (seenPermissions.has(request.id)) continue;
          seenPermissions.add(request.id);
          onPermission({
            id: String(request.id),
            sessionID: request.sessionID ?? sessionID,
            action: request.action ?? 'permission',
            resources: Array.isArray(request.resources) ? request.resources.join(', ') : '',
            message: request.message ?? '',
            raw: request,
          });
        }
        for (const id of Array.from(seenPermissions)) {
          if (ids.has(id)) continue;
          seenPermissions.delete(id);
          onPermission({ resolved: true, id, sessionID, raw: {} });
        }
      }

      for (const message of messages) {
        if (stopped) break;
        if (message.type !== 'assistant') continue;

        const reasoning = textParts(message, 'reasoning');
        const text = textParts(message, 'text');
        const finished = Boolean(message.time?.completed || message.finish);
        const signature = `${reasoning}|${text}|${finished}`;
        if (seen.get(message.id) === signature) continue;

        seen.set(message.id, signature);
        if (message.error?.message || message.finish === 'error') {
          onError(message.error?.message ?? 'OpenCode step failed');
          continue;
        }
        if (reasoning) onThinking(reasoning);
        // Only deliver the answer once it is complete, so a streaming message isn't sent in pieces.
        if (text && finished) onReply(text);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // First check immediately so a reply produced just before attach isn't missed entirely.
  tick().catch((err) => logger.error('[poller]', err));

  return {
    sessionID,
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
