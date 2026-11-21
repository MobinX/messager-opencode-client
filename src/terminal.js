import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * A persistent shell for one Messenger caller.
 *
 * Commands are written to one long-lived bash process, so `cd`, exports and other shell state
 * survive between messages. Each command is followed by a uniquely tokened printf marker, which
 * lets us know when it finished and what the current directory is. Output lines are forwarded as
 * they arrive, so long-running commands (tail -f, a log stream, a server) keep reporting.
 */
export function createTerminal({
  cwd = '/home',
  shell = '/bin/bash',
  onOutput = () => {},
  onExit = () => {},
  env = process.env,
} = {}) {
  const token = randomBytes(6).toString('hex');
  const markerRe = new RegExp(`@@MSGCTRL_${token}_(\\d+)_(\\d+)__(.*)@@`);
  const child = spawn(shell, ['--noprofile', '--norc'], {
    cwd,
    env: { ...env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let pending = '';
  let nextId = 1;
  let currentCwd = cwd;
  let closed = false;
  const waiting = new Map();

  const consume = (chunk) => {
    pending += String(chunk);
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);

      const match = markerRe.exec(line);
      if (match) {
        const [, id, code, where] = match;
        const entry = waiting.get(Number(id));
        currentCwd = where || currentCwd;
        waiting.delete(Number(id));
        if (entry) {
          clearTimeout(entry.timer);
          entry.resolve({ code: Number(code), cwd: currentCwd });
        }
        continue;
      }
      if (line.length) onOutput(`${line}\n`);
    }
  };

  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);

  const finishAll = (code) => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`terminal exited before command finished (code ${code})`));
    }
    waiting.clear();
  };

  child.on('exit', (code) => {
    if (closed) return;
    closed = true;
    finishAll(code ?? 0);
    onExit(code ?? 0);
  });
  child.on('error', (err) => {
    if (closed) return;
    closed = true;
    finishAll(1);
    onExit(1, err.message);
  });

  const killOnParentExit = () => {
    if (!closed && child && !child.killed) child.kill('SIGTERM');
  };
  process.once('exit', killOnParentExit);

  return {
    get cwd() { return currentCwd; },
    get alive() { return !closed; },

    /** Sends one command and resolves when its completion marker arrives. */
    run(command, timeoutMs = 120_000) {
      if (closed) return Promise.reject(new Error('terminal is closed'));
      const id = nextId++;
      const script =
        `${String(command)}\n` +
        `printf '\\n@@MSGCTRL_${token}_${id}_%d__%s@@\\n' "$?" "$PWD"\n`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        child.stdin.write(script, (err) => {
          if (err) {
            clearTimeout(timer);
            waiting.delete(id);
            reject(err);
          }
        });
      });
    },

    /** Raw write, used for `exit` where no completion marker is printed. */
    send(text) {
      if (!closed) child.stdin.write(`${text}\n`);
    },

    kill() {
      if (closed) return;
      closed = true;
      finishAll(0);
      if (!child.killed) child.kill('SIGTERM');
      process.removeListener('exit', killOnParentExit);
    },
  };
}
