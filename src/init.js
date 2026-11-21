import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as onlyorders from './onlyorders.js';
import { startTunnel, isInstalled as tunnelInstalled } from './tunnel.js';
import * as systemd from './systemd.js';
import { homeDir, loadDb, saveDb, saveState, logState } from './config.js';
import { createHttpServer } from './server.js';
import { connect, isOpencodeAvailable } from './opencode.js';
import { detectServices, activeSystemdUnit } from './services.js';

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
  services = { detectServices, activeSystemdUnit },
  port = PORT,
  waitTimeoutMs = 5 * 60 * 1000,
} = {}) {
  const print = io.print ?? console.log;
  const ask = io.ask;
  if (!ask) throw new Error('io.ask is required');

  print('=== msgctrl init ===');
  const info = services.detectServices?.() ?? null;
  print(`cloudflared binary: ${info?.binaries?.cloudflared ?? (tunnel.isInstalled() ? 'found' : 'MISSING')}`);
  print(`opencode binary:    ${info?.binaries?.opencode ?? 'unknown'}`);
  print(`opencode runtime:   ${info?.runtime?.opencode?.url ?? (opencode.isOpencodeAvailable() ? 'available' : 'MISSING')}`);
  if (info) {
    const fmt = (units) => {
      const active = services.activeSystemdUnit?.(units);
      if (active) return `${active.active} (${active.scope}: ${active.unit})`;
      if (!info.systemd.availableSystem && !info.systemd.availableUser) return 'systemd bus unavailable';
      return units.map((u) => `${u.scope}:${u.active}`).join(', ');
    };
    print(`systemd opencode:  ${fmt(info.systemd.opencode)}`);
    print(`systemd cloudflared: ${fmt(info.systemd.cloudflared)}`);
    print(`systemd msgctrl:   ${fmt(info.systemd.msgctrl)}`);
    if (!services.activeSystemdUnit?.(info.systemd.opencode) && info.runtime?.opencode?.url) {
      print('[warn] OpenCode is reachable but not via a systemd unit — it may stop on reboot.');
    }
    if (!services.activeSystemdUnit?.(info.systemd.cloudflared)) {
      print('[info] No system cloudflared unit is active; msgctrl starts its own quick tunnel at start.');
    }
  }
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
      defaultModel: process.env.OPENCODE_MODEL ?? 'opencode/hy4-flash-free',
    });
    saveState({ selectedPages: pages, activePageId: chosen.pageId });
    logState('page', `connected ${chosen.pageName} (${chosen.pageId})`);
    print(`[onlyorders] page connected; webhook subscribed: ${connected.webhookSubscribed}`);

    // Confirm OpenCode can actually be reached before writing the unit file.
    const { endpoint } = await opencode.connect();
    print(`[opencode] connected: ${endpoint.url}`);

    // Free the port before systemd starts the real receiver, then install/enable everything.
    callbackServer.close();
    activeTunnel.stop();

    const tunnelLogPath = path.join(homeDir(), 'msgctrl-tunnel.log');
    const info = services.detectServices?.() ?? null;
    const boot = system.bootstrapSystemServices
      ? await system.bootstrapSystemServices({
          user: process.env.USER ?? 'ubuntu',
          workdir: process.cwd(),
          nodeBin: process.execPath,
          port,
          defaultDirectory: process.env.DEFAULT_DIRECTORY ?? process.cwd(),
          tunnelLogPath,
          opencodeBinary: info?.binaries?.opencode,
          cloudflaredBinary: info?.binaries?.cloudflared,
          runtimeUrl: info?.runtime?.opencode?.url,
        })
      : {
          sudo: false,
          fallback: system.installUnit({
            user: process.env.USER ?? 'ubuntu',
            workdir: process.cwd(),
            nodeBin: process.execPath,
            port,
          }),
        };

    saveDb({
      externalTunnel: boot.sudo === true,
      tunnelLogPath,
    });
    saveState({
      initialized: true,
      initializedAt: new Date().toISOString(),
      systemd: boot,
    });

    print(`[systemd] sudo: ${boot.sudo ? 'yes' : 'no'}`);
    for (const [name, result] of Object.entries(boot)) {
      if (name === 'sudo' || name === 'fallback' || !result) continue;
      print(`[systemd] ${name}: ${result.ok ? 'ok' : `failed (${result.error ?? 'unknown'})`}`);
    }
    if (!boot.sudo) {
      print('[systemd] no passwordless sudo — install/enable manually with: msgctrl install --system');
    }

    print('\nInit complete. Everything is installed and started.');
    print('  msgctrl status   — inspect state');
    return {
      serviceId: service.id,
      webhookId: hook.id,
      tunnelUrl,
      pageId: chosen.pageId,
      systemd: boot,
    };
  } finally {
    callbackServer.close();
    activeTunnel.stop();
    io.close?.();
  }
}
