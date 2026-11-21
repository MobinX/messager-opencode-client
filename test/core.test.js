import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msgctrl-test-'));
process.env.MSGCTRL_HOME = tmp;

const { loadDb, saveDb, loadState, saveState, logState, dbPath, statePath } = await import('../src/config.js');
const { extractTunnelUrl } = await import('../src/tunnel.js');
const { unitContent } = await import('../src/systemd.js');
const { findBinary, activeSystemdUnit, detectServices } = await import('../src/services.js');
const { runInit } = await import('../src/init.js');
const { createTerminal } = await import('../src/terminal.js');
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
  const unit = unitContent({ user: 'ubuntu', workdir: '/home/ubuntu/app', nodeBin: '/usr/bin/node', port: 9999 });
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=PORT=9999/);
  assert.match(unit, /\/usr\/bin\/node \/home\/ubuntu\/app\/bin\/msgctrl start/);
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
