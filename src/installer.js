import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OPENCODE_INSTALL_SCRIPT = 'https://opencode.ai/v2/install';
const CLOUDFLARED_RELEASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download';

function defaultRunner(cmd, args, options = {}) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 180_000,
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd,
    });
    return {
      ok: result.status === 0,
      code: result.status,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      error: result.error?.message ?? null,
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Version + path of a CLI, without assuming it is on PATH. */
export function toolStatus(name, binary, { runner = defaultRunner } = {}) {
  if (!binary) return { name, found: false, version: null, path: null, raw: '' };
  const result = runner(binary, ['--version']);
  const raw = result.stdout || result.stderr || '';
  return {
    name,
    found: result.ok,
    version: parseVersion(raw),
    path: binary,
    raw,
  };
}

export function parseVersion(text) {
  const match = String(text ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match[0] : null;
}

export function majorVersion(version) {
  const match = String(version ?? '').match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

export function isOpencodeV2(status) {
  const major = majorVersion(status?.version);
  return major === null ? false : major >= 2;
}

/** Official OpenCode v2 installer; also the supported upgrade path. */
export function installOpencode({ runner = defaultRunner } = {}) {
  const script = `curl -fsSL ${OPENCODE_INSTALL_SCRIPT} | bash`;
  const result = runner('bash', ['-c', script], {
    env: { HOME: process.env.HOME ?? os.homedir() },
    timeoutMs: 300_000,
  });
  return {
    ok: result.ok,
    action: 'install/upgrade',
    error: result.ok ? null : (result.stderr || result.error || 'installer failed'),
  };
}

export const upgradeOpencode = installOpencode;

function cloudflaredAsset(arch = process.arch) {
  const map = {
    x64: 'amd64',
    arm64: 'arm64',
    arm: 'arm',
    ia32: '386',
  };
  return `cloudflared-linux-${map[arch] ?? 'amd64'}`;
}

/**
 * Installs/upgrades cloudflared from the official GitHub release into /usr/local/bin.
 * Uses passwordless sudo; no interactive password prompt is ever attempted.
 */
export function installCloudflared({
  runner = defaultRunner,
  sudoAvailable = true,
  arch = process.arch,
} = {}) {
  if (!sudoAvailable) {
    return { ok: false, error: 'passwordless sudo unavailable — cannot write /usr/local/bin' };
  }
  const asset = cloudflaredAsset(arch);
  const tmp = path.join(os.tmpdir(), `cloudflared-${process.pid}-${Date.now()}`);
  const download = runner('curl', ['-fL', '--output', tmp, `${CLOUDFLARED_RELEASE}/${asset}`], {
    timeoutMs: 300_000,
  });
  if (!download.ok) {
    return { ok: false, error: download.stderr || download.error || 'download failed' };
  }
  const installed = runner('sudo', ['-n', 'install', '-m', '755', tmp, '/usr/local/bin/cloudflared']);
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  return {
    ok: installed.ok,
    path: '/usr/local/bin/cloudflared',
    error: installed.ok ? null : (installed.stderr || installed.error || 'install failed'),
  };
}

/** Makes ~/.opencode/bin available in future login shells (systemd units set PATH explicitly). */
export function ensureShellPath(directory, { home = process.env.HOME ?? os.homedir() } = {}) {
  const line = `export PATH="${directory}:$PATH"`;
  const files = [path.join(home, '.bashrc'), path.join(home, '.profile')];
  const changed = [];
  for (const file of files) {
    try {
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (!content.includes(directory)) {
        fs.appendFileSync(file, `\n# Added by msgctrl\n${line}\n`, { mode: 0o644 });
        changed.push(file);
      }
    } catch {
      // A missing or unwritable rc file is not fatal — systemd has its own PATH.
    }
  }
  return changed;
}
