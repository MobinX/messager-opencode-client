import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'node:crypto';
import * as onlyorders from './onlyorders.js';
import { startTunnel, isInstalled as tunnelInstalled } from './tunnel.js';
import * as systemd from './systemd.js';
import { loadDb, saveDb, saveState, logState } from './config.js';
import { createHttpServer } from './server.js';
import { connect, isOpencodeAvailable } from './opencode.js';

const PORT = Number(process.env.PORT ?? 8788);

function defaultIo() {
  const rl = readline.createInterface({ input, output });
  return {
    print: (message) => console.log(message),
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'messager';
}

function printPages(pages) {
  return pages
    .map((page, index) => `${index + 1}. ${page.pageName} (${page.pageId})`)
    .join('\n');
}

/**
 * Interactive first-time setup. Every external boundary is injectable so the whole flow is
 * unit-testable without a real tunnel, OnlyOrders account or OpenCode service.
 */
export async function runInit({
  io = defaultIo(),
  api = onlyorders,
  tunnel = { startTunnel, isInstalled: tunnelInstalled },
  system = systemd,
  opencode = { isOpencodeAvailable, connect },
  port = PORT,
  waitTimeoutMs = 5 * 60 * 1000,
} = {}) {
  const print = io.print ?? console.log;
  const ask = io.ask;
  if (!ask) throw new Error('io.ask is required');

  print('=== msgctrl init ===');
  print(`cloudflared: ${tunnel.isInstalled() ? 'found' : 'MISSING — install it before continuing'}`);
  print(`opencode:    ${opencode.isOpencodeAvailable() ? 'found' : 'MISSING — install/start it before continuing'}`);
  if (!tunnel.isInstalled() || !opencode.isOpencodeAvailable()) {
    throw new Error('cloudflared and opencode are both required');
  }

  const db = loadDb();
  const serviceName = (await ask(`Service name [${db.serviceName ?? 'Messenger OpenCode Client'}]: `)).trim()
    || db.serviceName
    || 'Messenger OpenCode Client';
  const uniqueName = `${slugify(serviceName)}-${randomUUID().slice(0, 8)}`;

  print(`[onlyorders] creating service "${serviceName}"…`);
  const service = await api.createService(serviceName, uniqueName);
  saveDb({
    serviceId: service.id,
    serviceName,
    uniqueName,
    initializedAt: new Date().toISOString(),
  });
  logState('init', `created service ${service.id}`);

  print('[tunnel] starting Cloudflare quick tunnel…');
  const activeTunnel = tunnel.startTunnel({
    localPort: port,
    onLog: () => {},
  });
  const tunnelUrl = await activeTunnel.ready;

  const hook = await api.registerWebhook(service.id, `${tunnelUrl}/webhook`);
  saveDb({ webhookId: hook.id, webhookUrl: hook.url });
  saveState({ tunnelUrl, webhookUrl: hook.url, webhookUpdatedAt: new Date().toISOString() });
  print(`[onlyorders] webhook registered: ${hook.url}`);

  // Ephemeral HTTP receiver for the page-selection callback during setup. Only pages selected
  // during this run count — state.json may still hold pages from an earlier attempt.
  let resolvePages;
  const pagesReady = new Promise((resolve) => { resolvePages = resolve; });
  const selectionStartedAt = new Date().toISOString();
  const callbackServer = createHttpServer({
    serviceId: service.id,
    port,
    onSelectedPages: (pages) => {
      const fresh = pages.filter((page) => (page.at ?? '') >= selectionStartedAt);
      if (fresh.length) resolvePages(fresh);
    },
    log: (kind, detail) => logState(kind, JSON.stringify(detail)),
  });
  await new Promise((resolve) => callbackServer.listen(port, '0.0.0.0', resolve));

  try {
    const auth = await api.getFacebookConnectOauthUrl(`${tunnelUrl}/facebook-selected`);
    print('\nOpen this URL in your browser and select the Facebook Page(s) you want:');
    print(auth.url);
    print('\nWaiting for the Page selection callback…');

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for Page selection')), waitTimeoutMs),
    );
    const pages = await Promise.race([pagesReady, timeout]);
    print(`\nSelected pages:\n${printPages(pages)}`);

    const answer = (await ask('Which page number should be the control panel? ')).trim();
    const number = Number(answer);
    const chosen = pages[number - 1];
    if (!chosen) throw new Error(`No page number ${number}`);

    print(`[onlyorders] connecting ${chosen.pageName} (${chosen.pageId})…`);
    const connected = await api.connectExternalChannel(service.id, {
      pageId: chosen.pageId,
      businessId: chosen.businessId,
      platform: 'facebook',
      name: chosen.pageName,
    });
    saveDb({
      pageId: chosen.pageId,
      pageName: chosen.pageName,
      businessId: chosen.businessId,
      channelId: connected.id,
      pageConnectedAt: new Date().toISOString(),
      defaultDirectory: process.env.DEFAULT_DIRECTORY ?? process.cwd(),
    });
    saveState({ selectedPages: pages, activePageId: chosen.pageId });
    logState('page', `connected ${chosen.pageName} (${chosen.pageId})`);
    print(`[onlyorders] page connected; webhook subscribed: ${connected.webhookSubscribed}`);

    // Confirm OpenCode can actually be reached before writing the unit file.
    const { endpoint } = await opencode.connect();
    print(`[opencode] connected: ${endpoint.url}`);

    const installed = system.installUnit({
      user: process.env.USER ?? 'ubuntu',
      workdir: process.cwd(),
      nodeBin: process.execPath,
      port,
    });
    print(`[systemd] unit written: ${installed.path}`);
    if (!installed.reloaded) print('[systemd] daemon-reload failed — enable manually if needed');

    saveState({ initialized: true, initializedAt: new Date().toISOString() });
    print('\nInit complete. Start the service with:');
    print('  msgctrl start');
    return {
      serviceId: service.id,
      webhookId: hook.id,
      tunnelUrl,
      pageId: chosen.pageId,
      systemdUnit: installed.path,
    };
  } finally {
    callbackServer.close();
    activeTunnel.stop();
    io.close?.();
  }
}
