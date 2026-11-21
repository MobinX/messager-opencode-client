import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const RUN = (cmd, args) => {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      error: result.error?.message ?? null,
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
};

/** Locates a binary even when it is installed outside PATH (e.g. opencode in ~/.opencode/bin). */
export function findBinary(name, extraPaths = []) {
  const direct = RUN('which', [name]);
  if (direct.ok && direct.stdout) return direct.stdout.split('\n')[0].trim();
  const candidates = [
    ...extraPaths,
    path.join(os.homedir(), '.opencode', 'bin', name),
    path.join(os.homedir(), '.local', 'bin', name),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  for (const candidate of candidates) {
    const full = candidate.includes('/') && !candidate.endsWith(name)
      ? path.join(candidate, name)
      : candidate;
    if (fs.existsSync(full)) {
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export function opencodeBinary() {
  return findBinary('opencode', [path.join(os.homedir(), '.opencode', 'bin')]);
}

export function cloudflaredBinary() {
  return findBinary('cloudflared');
}

/** Whether a systemd instance is reachable at user or system scope. */
export function systemdAvailable(scope = 'system') {
  const args = scope === 'user' ? ['--user', 'is-system-running'] : ['is-system-running'];
  const result = RUN('systemctl', args);
  return result.ok || /^running|degraded/.test(result.stdout);
}

/** State of one unit; never throws when systemd is unavailable. */
export function systemdUnit(unit, scope = 'system') {
  const prefix = scope === 'user' ? ['--user'] : [];
  const active = RUN('systemctl', [...prefix, 'is-active', unit]);
  const show = RUN('systemctl', [...prefix, 'show', unit, '-p', 'SubState', '-p', 'FragmentPath', '-p', 'ExecStart']);
  const field = (key) => {
    const line = show.stdout.split('\n').find((row) => row.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : null;
  };
  return {
    unit,
    scope,
    available: systemdAvailable(scope),
    active: active.ok ? active.stdout : 'not-found',
    subState: field('SubState') ?? null,
    fragmentPath: field('FragmentPath') || null,
    execStart: field('ExecStart') || null,
  };
}

/** Runtime OpenCode endpoint from `opencode service status`, independent of systemd. */
export function opencodeRuntime(binary = opencodeBinary()) {
  if (!binary) return { url: null, error: 'opencode binary not found' };
  const result = RUN(binary, ['service', 'status']);
  const url = result.stdout.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
  return { url, error: result.ok ? null : (result.stderr || result.error || 'service status failed') };
}

/** Full picture used by `msgctrl check` and `msgctrl init`. */
export function detectServices() {
  const opencodeBin = opencodeBinary();
  const cloudflaredBin = cloudflaredBinary();
  return {
    binaries: {
      opencode: opencodeBin,
      cloudflared: cloudflaredBin,
    },
    systemd: {
      availableSystem: systemdAvailable('system'),
      availableUser: systemdAvailable('user'),
      opencode: [
        systemdUnit('opencode-server.service', 'system'),
        systemdUnit('opencode.service', 'user'),
      ],
      cloudflared: [
        systemdUnit('cloudflared-quick.service', 'system'),
        systemdUnit('cloudflared.service', 'user'),
      ],
      msgctrl: [
        systemdUnit('msgctrl.service', 'system'),
        systemdUnit('msgctrl.service', 'user'),
      ],
      msgctrlTunnel: [systemdUnit('msgctrl-tunnel.service', 'system')],
      msgctrlOpencode: [systemdUnit('msgctrl-opencode.service', 'system')],
    },
    runtime: {
      opencode: opencodeRuntime(opencodeBin),
    },
  };
}

export function activeSystemdUnit(units) {
  return units.find((unit) => unit.active === 'active') ?? null;
}
