import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msgctrl-test-'));
process.env.MSGCTRL_HOME = tmp;

const { loadDb, saveDb, loadState, saveState, logState, dbPath, statePath } = await import('../src/config.js');
const { extractTunnelUrl, watchTunnelUrl } = await import('../src/tunnel.js');
const {
  msgctrlUnitContent,
  opencodeUnitContent,
  tunnelUnitContent,
} = await import('../src/systemd.js');
const { findBinary, activeSystemdUnit, detectServices } = await import('../src/services.js');
const { runInit } = await import('../src/init.js');
const { createTerminal } = await import('../src/terminal.js');
const installerLib = await import('../src/installer.js');
const { createSessionPoller: makePoller } = await import('../src/poller.js');
const { createHttpServer } = await import('../src/server.js');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('config persists db.json and state.json with 0600 permissions', () => {
  saveDb({ serviceId: 'svc-1', webhookId: 'hook-1' });
  saveDb({ pageId: 'page-1' });
  assert.equal(loadDb().serviceId, 'svc-1');
  assert.equal(loadDb().pageId, 'page-1');
  logState('test', 'hello');
  const state = loadState();
  assert.equal(state.logs.at(-1).message, 'hello');
  assert.equal(fs.statSync(dbPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(statePath()).mode & 0o777, 0o600);
});

test('extractTunnelUrl finds the quick tunnel URL', () => {
  const text = 'something\n+---------------------------------------------------+\n| https://abcdefg-try.trycloudflare.com              |\n';
  assert.equal(extractTunnelUrl(text), 'https://abcdefg-try.trycloudflare.com');
  assert.equal(extractTunnelUrl('no url here'), null);
});

test('systemd unit contains restart and executable path', () => {
  const unit = msgctrlUnitContent({ user: 'ubuntu', workdir: '/home/ubuntu/app', nodeBin: '/usr/bin/node', port: 9999 });
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=PORT=9999/);
  assert.match(unit, /\/usr\/bin\/node \/home\/ubuntu\/app\/bin\/msgctrl start/);
});

test('systemd units wire OpenCode, tunnel and msgctrl services together', () => {
  const msgctrl = msgctrlUnitContent({
    user: 'ubuntu',
    workdir: '/home/ubuntu/messager_opencode_client',
    nodeBin: '/usr/bin/node',
    port: 8788,
    tunnelLogPath: '/tmp/tunnel.log',
  });
  assert.match(msgctrl, /Wants=network-online.target msgctrl-tunnel.service/);
  assert.match(msgctrl, /Environment=MSGCTRL_EXTERNAL_TUNNEL=1/);
  assert.match(msgctrl, /Environment=MSGCTRL_TUNNEL_LOG=\/tmp\/tunnel.log/);
  assert.match(msgctrl, /WantedBy=multi-user.target/);

  const opencode = opencodeUnitContent({
    user: 'ubuntu',
    binary: '/home/ubuntu/.opencode/bin/opencode',
    port: 4096,
  });
  assert.match(opencode, /serve --hostname 127.0.0.1 --port 4096/);
  assert.match(opencode, /Restart=always/);

  const tunnel = tunnelUnitContent({
    user: 'ubuntu',
    binary: '/usr/local/bin/cloudflared',
    port: 8788,
    logPath: '/tmp/tunnel.log',
  });
  assert.match(tunnel, /cloudflared tunnel --no-autoupdate --url http:\/\/127.0.0.1:8788/);
  assert.match(tunnel, /tee -a \/tmp\/tunnel.log/);
});

test('watchTunnelUrl reports new URLs written by the tunnel service', async () => {
  const logPath = path.join(tmp, 'tunnel-service.log');
  fs.writeFileSync(logPath, 'starting...\n');
  const seen = [];
  const watcher = watchTunnelUrl({
    file: logPath,
    intervalMs: 20,
    onUrl: (url) => seen.push(url),
    logger: { log() {}, error() {} },
  });
  fs.appendFileSync(logPath, '| https://new-tunnel-1.trycloudflare.com |\n');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ['https://new-tunnel-1.trycloudflare.com']);
  // A restart appends a second URL; the watcher must pick the newest one, not the first.
  fs.appendFileSync(logPath, '| https://new-tunnel-2.trycloudflare.com |\n');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [
    'https://new-tunnel-1.trycloudflare.com',
    'https://new-tunnel-2.trycloudflare.com',
  ]);
  watcher.stop();
});

test('service detection locates binaries and reports systemd state without throwing', () => {
  assert.equal(findBinary('definitely-not-a-real-binary-xyz'), null);
  assert.equal(
    activeSystemdUnit([
      { unit: 'a.service', scope: 'user', active: 'inactive' },
      { unit: 'b.service', scope: 'system', active: 'active' },
    ])?.unit,
    'b.service',
  );
  const info = detectServices();
  assert.ok('binaries' in info && 'systemd' in info && 'runtime' in info);
  assert.ok(Array.isArray(info.systemd.opencode));
  assert.ok(Array.isArray(info.systemd.cloudflared));
});

test('callback server records selected pages from OnlyOrders', async () => {
  const port = await freePort();
  let received = null;
  const server = createHttpServer({
    serviceId: 'svc',
    port,
    onSelectedPages: (pages) => { received = pages; },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${port}/facebook-selected`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pageId: '123', pageName: 'My Page', businessId: 'biz' }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received[0].pageId, '123');
  assert.equal(loadState().selectedPages[0].pageName, 'My Page');
  server.close();
});

test('terminal buffers fast output into one message but streams long-running output', async () => {
  const chunks = [];
  const terminal = createTerminal({
    cwd: '/tmp',
    streamAfterMs: 80,
    onOutput: (text) => chunks.push(text),
  });

  await terminal.run("printf 'one\\ntwo\\nthree\\n'");
  assert.deepEqual(chunks, ['one\ntwo\nthree\n']);

  chunks.length = 0;
  await terminal.run("printf 'slow1\\n'; sleep 0.25; printf 'slow2\\n'");
  assert.ok(chunks.length >= 2, `expected streaming chunks, got ${JSON.stringify(chunks)}`);
  assert.equal(chunks[0], 'slow1\n');
  assert.match(chunks.join(''), /slow2/);
  terminal.kill();
});

test('session poller forwards new assistant messages and permissions', async () => {
  const now = Date.now();
  const messages = [
    {
      id: 'a1',
      type: 'assistant',
      time: { created: now, completed: now + 1 },
      content: [
        { type: 'reasoning', text: 'considering' },
        { type: 'text', text: 'polled answer' },
        { type: 'tool', name: 'write' },
      ],
    },
  ];
  const client = {
    message: { list: async () => ({ data: messages }) },
    permission: {
      request: {
        list: async () => ({ data: [{ id: 'p1', sessionID: 's1', action: 'write', resources: [] }] }),
      },
    },
  };
  const thinking = [];
  const replies = [];
  const permissions = [];
  const poller = makePoller({
    client,
    sessionID: 's1',
    intervalMs: 20,
    onThinking: (text) => thinking.push(text),
    onReply: (text) => replies.push(text),
    onPermission: (request) => permissions.push(request),
    logger: { error() {} },
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(thinking, ['considering']);
  assert.deepEqual(replies, ['polled answer']);
  assert.equal(permissions[0]?.id, 'p1');
  poller.stop();
});

test('installer parses versions and reports v2 correctly', () => {
  assert.equal(installerLib.parseVersion('opencode v2.2.0'), '2.2.0');
  assert.equal(installerLib.majorVersion('2026.10.7'), 2026);
  const v2 = installerLib.toolStatus('opencode', '/bin/opencode', {
    runner: () => ({ ok: true, stdout: 'opencode v2.2.0', stderr: '' }),
  });
  assert.equal(installerLib.isOpencodeV2(v2), true);
  const v1 = installerLib.toolStatus('opencode', '/bin/opencode', {
    runner: () => ({ ok: true, stdout: 'opencode v1.0.0', stderr: '' }),
  });
  assert.equal(installerLib.isOpencodeV2(v1), false);
  const missing = installerLib.toolStatus('cloudflared', null);
  assert.equal(missing.found, false);
});

test('init asks before installing a missing tool and honours a no answer', async () => {
  const printed = [];
  let asked = null;
  let installed = false;
  const fakeInfo = {
    binaries: { opencode: '/bin/opencode', cloudflared: null },
    runtime: { opencode: { url: 'http://127.0.0.1:4096' } },
    systemd: {
      availableSystem: true,
      availableUser: false,
      opencode: [],
      cloudflared: [],
      msgctrl: [],
    },
  };
  const installer = {
    toolStatus: (name, binary) => ({
      name,
      found: Boolean(binary),
      version: name === 'opencode' ? '2.2.0' : null,
      path: binary,
    }),
    isOpencodeV2: (status) => status.version === '2.2.0',
    installCloudflared: async () => { installed = true; return { ok: true }; },
    upgradeOpencode: async () => ({ ok: true }),
  };
  const io = {
    print: (m) => printed.push(m),
    ask: async (question) => { asked = question; return 'n'; },
    close: () => {},
  };

  await assert.rejects(
    runInit({
      io,
      installer,
      services: {
        detectServices: () => fakeInfo,
        activeSystemdUnit: () => null,
      },
      tunnel: { isInstalled: () => false, startTunnel: () => ({ ready: Promise.resolve('https://x') }) },
      system: { sudoAvailable: () => true },
      opencode: { isOpencodeAvailable: () => true, connect: async () => ({ endpoint: {} }) },
    }),
    /cloudflared is required/,
  );
  assert.match(asked, /Install it now/);
  assert.equal(installed, false);
  assert.match(printed.join('\n'), /cloudflared: MISSING/);
});

test('init flow creates service, webhook, connects chosen page and stores ids', async () => {
  // Fresh db for this test.
  fs.writeFileSync(dbPath(), '{}');
  const port = await freePort();
  const answers = ['Test Service', '1'];
  const printed = [];
  const io = {
    print: (m) => printed.push(m),
    ask: async () => answers.shift(),
    close: () => {},
  };
  const api = {
    createService: async (name, uniqueName) => {
      assert.equal(name, 'Test Service');
      assert.match(uniqueName, /^test-service-/);
      return { id: 'svc-new' };
    },
    registerWebhook: async (id, url) => {
      assert.equal(id, 'svc-new');
      assert.match(url, /\/webhook$/);
      return { id: 'hook-new', url };
    },
    getFacebookConnectOauthUrl: async (redirectUrl) => {
      assert.match(redirectUrl, /\/facebook-selected$/);
      // Simulate OnlyOrders posting the selected page to our callback receiver.
      setTimeout(async () => {
        await fetch(`http://127.0.0.1:${port}/facebook-selected`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId: 'PAGE_X', pageName: 'Page X', businessId: 'biz-1' }),
        });
      }, 60);
      return { url: 'https://facebook.example/oauth' };
    },
    connectExternalChannel: async (id, body) => {
      assert.equal(id, 'svc-new');
      assert.equal(body.pageId, 'PAGE_X');
      return { id: 'channel-new', webhookSubscribed: true };
    },
  };
  const tunnel = {
    isInstalled: () => true,
    startTunnel: () => ({
      ready: Promise.resolve('https://test-tunnel.trycloudflare.com'),
      stop: () => {},
    }),
  };
  const system = {
    installUnit: () => ({ path: '/tmp/msgctrl.service', reloaded: true }),
  };
  const opencode = {
    isOpencodeAvailable: () => true,
    connect: async () => ({ endpoint: { url: 'http://127.0.0.1:4096' } }),
  };

  const result = await runInit({ io, api, tunnel, system, opencode, port, waitTimeoutMs: 5000 });
  assert.equal(result.serviceId, 'svc-new');
  assert.equal(result.pageId, 'PAGE_X');
  const db = loadDb();
  assert.equal(db.webhookId, 'hook-new');
  assert.equal(db.pageId, 'PAGE_X');
  assert.equal(db.channelId, 'channel-new');
  assert.match(printed.join('\n'), /Selected pages:\n1\. Page X/);
  assert.equal(loadState().initialized, true);
});
