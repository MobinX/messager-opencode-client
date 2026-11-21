import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { homeDir } from './config.js';

function detectedPath(nodeBin) {
  const extra = [];
  const found = spawnSync('which', ['opencode'], { encoding: 'utf8' });
  if (found.status === 0 && found.stdout.trim()) {
    extra.push(path.dirname(found.stdout.trim()));
  }
  return [path.dirname(nodeBin), ...extra, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

export function unitContent({ user, workdir, nodeBin, port = 8788, defaultDirectory = workdir }) {
  return `[Unit]
Description=Messenger OpenCode control panel (OnlyOrders external service)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workdir}
Environment=PATH=${detectedPath(nodeBin)}
Environment=PORT=${port}
Environment=DEFAULT_DIRECTORY=${defaultDirectory}
Environment=OPENCODE_MODEL=${process.env.OPENCODE_MODEL ?? 'opencode/hy4-flash-free'}
ExecStart=${nodeBin} ${path.join(workdir, 'bin', 'msgctrl')} start
Restart=always
RestartSec=5
StandardOutput=append:${path.join(homeDir(), 'msgctrl.log')}
StandardError=append:${path.join(homeDir(), 'msgctrl.log')}

[Install]
WantedBy=default.target
`;
}

/** Writes a user-level systemd unit. Returns the path; daemon-reload is best-effort. */
export function installUnit({ user, workdir, nodeBin, port, defaultDirectory, system = false } = {}) {
  const targetDir = system
    ? '/etc/systemd/system'
    : path.join(process.env.HOME ?? '/root', '.config', 'systemd', 'user');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'msgctrl.service');
  fs.writeFileSync(
    target,
    unitContent({ user, workdir, nodeBin, port, defaultDirectory: defaultDirectory ?? workdir }),
    { mode: 0o644 },
  );

  const cmd = system ? 'systemctl' : 'systemctl';
  const args = system
    ? ['daemon-reload']
    : ['--user', 'daemon-reload'];
  const reloaded = spawnSync(cmd, args, { encoding: 'utf8' });
  return { path: target, reloaded: reloaded.status === 0, error: reloaded.error?.message ?? null };
}

export function uninstallUnit({ system = false } = {}) {
  const target = system
    ? '/etc/systemd/system/msgctrl.service'
    : path.join(process.env.HOME ?? '/root', '.config', 'systemd', 'user', 'msgctrl.service');
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const args = system ? ['daemon-reload'] : ['--user', 'daemon-reload'];
  spawnSync('systemctl', args, { encoding: 'utf8' });
  return { path: target };
}
