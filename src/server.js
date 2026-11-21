import http from 'node:http';
import path from 'node:path';
import { createCommandHandler } from './commands.js';
import { connect } from './opencode.js';
import {
  registerWebhook,
  sendMessage,
  updateWebhook,
} from './onlyorders.js';
import { startTunnel, watchTunnelUrl } from './tunnel.js';
import { homeDir, loadDb, loadState, logState, saveDb, saveState } from './config.js';

const PORT = Number(process.env.PORT ?? 8788);
const DEFAULT_DIRECTORY = process.env.DEFAULT_DIRECTORY ?? process.cwd();

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/**
 * Shared HTTP surface. Used by the long-running service and by `msgctrl init` while waiting for
 * the Facebook page-selection callback.
 */
export function createHttpServer({
  serviceId,
  pageId = null,
  port = PORT,
  client = null,
  defaultDirectory = DEFAULT_DIRECTORY,
  onSelectedPages = () => {},
  onWebhookEvent = () => {},
  log = () => {},
} = {}) {
  const handle = client
    ? createCommandHandler({
        client,
        defaultDirectory,
        send: (text, event) => {
          const targetPage = String(event?.pageId ?? pageId ?? '');
          const recipientId = String(event?.customerInfo?.id ?? '');
          if (!targetPage || !recipientId) {
            console.error('[reply] no pageId/recipientId in event');
            return Promise.resolve();
          }
          log('reply', { to: recipientId, text: String(text).slice(0, 120) });
          // A failed Messenger send must never take down the webhook receiver.
          return sendMessage(serviceId, targetPage, recipientId, text).catch((err) => {
            log('reply-error', {
              to: recipientId,
              error: err instanceof Error ? err.message : String(err),
            });
            console.error('[reply] OnlyOrders send failed:', err instanceof Error ? err.message : err);
          });
        },
        log,
      })
    : null;

  let publicUrl = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        serviceId,
        pageId: pageId ?? null,
        tunnelUrl: publicUrl,
      });
    }

    // Called by OnlyOrders' internal_facebook_url after the merchant selects Pages.
    if (req.method === 'POST' && url.pathname === '/facebook-selected') {
      const body = await readBody(req);
      log('selected', { pageName: body.pageName, pageId: body.pageId });
      const state = loadState();
      const existing = (state.selectedPages ?? []).filter(
        (page) => String(page.pageId) !== String(body.pageId),
      );
      const pages = [
        ...existing,
        {
          pageId: String(body.pageId ?? ''),
          pageName: String(body.pageName ?? ''),
          businessId: String(body.businessId ?? ''),
          at: new Date().toISOString(),
        },
      ];
      saveState({ selectedPages: pages });
      onSelectedPages(pages);
      return json(res, 200, { received: true });
    }

    if (req.method === 'GET' && url.pathname === '/selected-pages') {
      return json(res, 200, { pages: loadState().selectedPages ?? [] });
    }

    // Manual re-pointing of the webhook (tunnel URL changes are handled automatically).
    if (req.method === 'GET' && url.pathname === '/register') {
      const next = url.searchParams.get('url');
      if (!next) return json(res, 400, { error: 'Pass ?url=https://<tunnel>' });
      try {
        const db = loadDb();
        const hook = db.webhookId
          ? await updateWebhook(serviceId, db.webhookId, `${next.replace(/\/+$/, '')}/webhook`)
          : await registerWebhook(serviceId, `${next.replace(/\/+$/, '')}/webhook`);
        saveDb({ webhookId: hook.id, webhookUrl: hook.url });
        publicUrl = next;
        saveState({ tunnelUrl: next, webhookUrl: hook.url, webhookUpdatedAt: new Date().toISOString() });
        return json(res, 200, { registered: hook.url });
      } catch (err) {
        return json(res, 502, { error: String(err instanceof Error ? err.message : err) });
      }
    }

    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
      const event = await readBody(req);
      // ACK immediately: OnlyOrders times its webhook POST out after 10 seconds.
      json(res, 200, { received: true });
      setImmediate(() => {
        onWebhookEvent(event);
        if (handle) handle(event).catch((err) => console.error('[handler]', err));
      });
      return;
    }

    return json(res, 404, { error: 'not found' });
  });

  server.setPublicUrl = (value) => { publicUrl = value; };
  return server;
}

/** Starts the long-running runtime: OpenCode connection, quick tunnel, webhook sync, HTTP. */
export async function startRuntime({ port = PORT, logger = console } = {}) {
  const db = loadDb();
  const serviceId = db.serviceId ?? process.env.ONLYORDERS_SERVICE_ID?.trim();
  if (!serviceId) throw new Error('No serviceId in db.json — run `msgctrl init` first');

  const { client, endpoint } = await connect();
  logger.log(`[opencode] connected to ${endpoint.url}`);

  let activeServer = null;
  const onWebhookSync = async (baseUrl) => {
    activeServer?.setPublicUrl(baseUrl);
    const url = `${baseUrl.replace(/\/+$/, '')}/webhook`;
    const current = loadDb();
    const hook = current.webhookId
      ? await updateWebhook(serviceId, current.webhookId, url)
      : await registerWebhook(serviceId, url);
    saveDb({ webhookId: hook.id, webhookUrl: hook.url });
    saveState({
      tunnelUrl: baseUrl,
      webhookUrl: hook.url,
      webhookUpdatedAt: new Date().toISOString(),
    });
    logState('webhook', `webhook synced to ${hook.url}`);
    logger.log(`[onlyorders] webhook synced: ${hook.url}`);
  };

  // Bind the HTTP receiver first so a port conflict fails fast and never leaves an orphan tunnel.
  const server = createHttpServer({
    serviceId,
    pageId: db.pageId ?? null,
    port,
    client,
    defaultDirectory: db.defaultDirectory ?? DEFAULT_DIRECTORY,
    log: (kind, detail) => logState(kind, JSON.stringify(detail)),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  logger.log(`[server] listening on http://0.0.0.0:${port}/webhook`);

  const externalTunnel =
    process.env.MSGCTRL_EXTERNAL_TUNNEL === '1' || db.externalTunnel === true;
  let tunnel;
  let tunnelUrl;

  if (externalTunnel) {
    // The tunnel runs as its own systemd unit; watch its log for URL changes.
    const logPath =
      process.env.MSGCTRL_TUNNEL_LOG ?? db.tunnelLogPath ?? path.join(homeDir(), 'msgctrl-tunnel.log');
    tunnel = watchTunnelUrl({ file: logPath, onUrl: onWebhookSync, logger });
    const deadline = Date.now() + 15_000;
    while (!tunnel.url && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    tunnelUrl = tunnel.url;
    if (!tunnelUrl) {
      logger.warn('[tunnel] no URL in service log yet — will sync when it appears');
      logState('tunnel', 'waiting for msgctrl-tunnel.service URL');
    }
  } else {
    tunnel = startTunnel({
      localPort: port,
      logger,
      onUrl: onWebhookSync,
      onLog: (text) => {
        if (text.includes('ERR') || text.includes('error')) logState('tunnel', text.slice(0, 500));
      },
    });
    try {
      tunnelUrl = await tunnel.ready;
    } catch (err) {
      tunnel.stop();
      server.close();
      throw err;
    }
  }

  server.setPublicUrl(tunnelUrl);
  logState('start', `service started on port ${port} with tunnel ${tunnelUrl ?? 'pending'}`);

  return {
    server,
    tunnel,
    tunnelUrl,
    stop() {
      tunnel.stop();
      server.close();
    },
  };
}

// Allow `npm start` / `node src/server.js` to run the long-lived service directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startRuntime().catch((err) => {
    console.error('[startup]', err);
    process.exit(1);
  });
}
