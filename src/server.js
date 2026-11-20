import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createCommandHandler } from './commands.js';
import { connect } from './opencode.js';
import { createService, deleteWebhook, registerWebhook, sendMessage } from './onlyorders.js';

const PORT = Number(process.env.PORT ?? 8788);
const DEFAULT_DIRECTORY = process.env.DEFAULT_DIRECTORY ?? process.cwd();
const WEBHOOK_ID_FILE = path.resolve('.webhook-id');

/** Replaces the previous webhook so re-registering a tunnel never leaves duplicates behind. */
async function replaceWebhook(serviceId, url) {
  let previous = null;
  try {
    previous = fs.readFileSync(WEBHOOK_ID_FILE, 'utf8').trim() || null;
  } catch {
    // No previous registration on this machine.
  }
  if (previous) await deleteWebhook(serviceId, previous);

  const hook = await registerWebhook(serviceId, `${url.replace(/\/+$/, '')}/webhook`);
  fs.writeFileSync(WEBHOOK_ID_FILE, hook.id);
  return hook;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

async function main() {
  const { client, endpoint } = await connect();
  console.log(`[opencode] connected to ${endpoint.url}`);

  let serviceId = process.env.ONLYORDERS_SERVICE_ID?.trim();
  if (!serviceId) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const service = await createService('Messenger OpenCode Client', `messager-opencode-${suffix}`);
    serviceId = service.id;
    console.log(`[onlyorders] created service ${serviceId}`);
  } else {
    console.log(`[onlyorders] using service ${serviceId}`);
  }

  let webhookUrl = process.env.PUBLIC_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    const hook = await replaceWebhook(serviceId, webhookUrl);
    console.log(`[onlyorders] webhook registered: ${hook.url}`);
  }

  const handle = createCommandHandler({
    client,
    defaultDirectory: DEFAULT_DIRECTORY,
    send: (text, event) => {
      const pageId = String(event?.pageId ?? '');
      const recipientId = String(event?.customerInfo?.id ?? '');
      if (!pageId || !recipientId) {
        console.error('[reply] no pageId/recipientId in event');
        return Promise.resolve();
      }
      console.log(`[reply] -> ${recipientId}: ${String(text).slice(0, 120).replace(/\s+/g, ' ')}`);
      return sendMessage(serviceId, pageId, recipientId, text);
    },
    log: (kind, detail) => console.log(`[${kind}]`, JSON.stringify(detail)),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, serviceId, webhookUrl: webhookUrl ?? null });
    }

    // Re-point the OnlyOrders webhook at a new quick-tunnel URL without a restart.
    if (req.method === 'GET' && url.pathname === '/register') {
      const next = url.searchParams.get('url');
      if (!next) return json(res, 400, { error: 'Pass ?url=https://<tunnel>' });
      try {
        const hook = await replaceWebhook(serviceId, next);
        webhookUrl = next;
        return json(res, 200, { registered: hook.url });
      } catch (err) {
        return json(res, 502, { error: String(err instanceof Error ? err.message : err) });
      }
    }

    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
      const event = await readBody(req);
      // ACK immediately: OnlyOrders times its webhook POST out after 10 seconds, while an
      // OpenCode turn can take minutes.
      json(res, 200, { received: true });
      setImmediate(() => {
        handle(event).catch((err) => console.error('[handler]', err));
      });
      return;
    }

    return json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] webhook receiver listening on http://0.0.0.0:${PORT}/webhook`);
    console.log(`[server] register new tunnel URL: GET /register?url=https://<tunnel>`);
  });
}

main().catch((err) => {
  console.error('[startup]', err);
  process.exit(1);
});
