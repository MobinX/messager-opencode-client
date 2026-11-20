const DEFAULT_BASE = 'https://onlyorders.tech/api2/ext-service';

export function apiBase() {
  return (process.env.ONLYORDERS_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

async function call(path, body, method = 'POST') {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`OnlyOrders ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

export async function createService(name, uniqueName) {
  return call('/create', { name, uniqueName });
}

export async function registerWebhook(serviceId, url) {
  return call(`/${serviceId}/webhook`, { url });
}

/**
 * Sends a Messenger reply. Splits long answers because Meta caps a single text bubble.
 */
export async function sendMessage(serviceId, pageId, recipientId, text) {
  const chunks = splitText(String(text ?? ''), 1500);
  for (const chunk of chunks) {
    await call(`/${serviceId}/SendMessage`, {
      pageId,
      recipientId,
      platformType: 'facebook',
      message: chunk,
    });
  }
  return chunks.length;
}

export function splitText(text, max = 1500) {
  if (!text) return ['(no output)'];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}
