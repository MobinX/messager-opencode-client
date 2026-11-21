import { spawn, spawnSync } from 'node:child_process';

const URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;

/** Extracts the first quick-tunnel URL from arbitrary cloudflared output. */
export function extractTunnelUrl(text) {
  const match = String(text ?? '').match(URL_RE);
  return match ? match[0] : null;
}

export function isInstalled(command = 'cloudflared') {
  try {
    return spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Starts a Cloudflare quick tunnel and resolves when its public URL appears in the output.
 * If the process exits unexpectedly, it is restarted with a short backoff and `onUrl` is called
 * again with the new URL so the OnlyOrders webhook can be re-pointed.
 */
export function startTunnel({ localPort = 8788, onUrl = () => {}, onLog = () => {}, logger = console } = {}) {
  let child = null;
  let stopped = false;
  let currentUrl = null;
  let resolveUrl;
  let rejectUrl;
  const ready = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  let notifiedUrl = null;

  function launch(backoffMs = 0) {
    if (stopped) return;
    if (backoffMs) setTimeout(spawnTunnel, backoffMs);
    else spawnTunnel();
  }

  function spawnTunnel() {
    if (stopped) return;
    child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const consume = (chunk) => {
      const text = String(chunk);
      onLog(text);
      const url = extractTunnelUrl(text);
      if (url && url !== notifiedUrl) {
        notifiedUrl = url;
        currentUrl = url;
        logger.log(`[tunnel] public URL: ${url}`);
        resolveUrl(url);
        Promise.resolve(onUrl(url)).catch((err) => logger.error('[tunnel] onUrl failed', err));
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('error', (err) => {
      logger.error('[tunnel] spawn error', err);
      rejectUrl(err);
    });
    child.on('exit', (code, signal) => {
      if (stopped) return;
      logger.warn(`[tunnel] exited (code=${code}, signal=${signal}) — restarting in 3s`);
      currentUrl = null;
      setTimeout(() => launch(), 3000);
    });
  }

  launch();

  return {
    ready,
    get url() { return currentUrl; },
    stop() {
      stopped = true;
      if (child && !child.killed) child.kill('SIGTERM');
    },
  };
}
