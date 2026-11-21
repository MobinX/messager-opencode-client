import fs from 'node:fs';
import path from 'node:path';

/** All persistent state lives next to the CLI, in gitignored files with 0600 permissions. */
export function homeDir() {
  return path.resolve(process.env.MSGCTRL_HOME ?? process.cwd());
}

export function dbPath() {
  return path.join(homeDir(), 'db.json');
}

export function statePath() {
  return path.join(homeDir(), 'state.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  return value;
}

export function loadDb() {
  return readJson(dbPath(), {});
}

export function saveDb(patch) {
  const current = loadDb();
  const next = { ...current, ...patch };
  return writeJson(dbPath(), next);
}

export function loadState() {
  const state = readJson(statePath(), {});
  return {
    startedAt: state.startedAt ?? null,
    tunnelUrl: state.tunnelUrl ?? null,
    webhookUrl: state.webhookUrl ?? null,
    webhookUpdatedAt: state.webhookUpdatedAt ?? null,
    selectedPages: state.selectedPages ?? [],
    logs: Array.isArray(state.logs) ? state.logs : [],
    ...state,
  };
}

export function saveState(patch) {
  const current = loadState();
  return writeJson(statePath(), { ...current, ...patch });
}

export function logState(kind, message, extra = {}) {
  const state = loadState();
  const entry = {
    at: new Date().toISOString(),
    kind,
    message: String(message).slice(0, 1000),
    ...extra,
  };
  const logs = [...state.logs, entry].slice(-200);
  writeJson(statePath(), { ...state, logs });
  return entry;
}
