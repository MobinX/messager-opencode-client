import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHandler } from '../src/commands.js';
import { splitText } from '../src/onlyorders.js';

function makeClient({
  sessions,
  models,
  thoughts = ['Let me check the answer.'],
  failStep = false,
  permission = false,
  active = false,
  projects = [],
  worktrees = {},
  worktreeError = null,
  sessionCreateError = null,
} = {}) {
  const sessionList = sessions ?? [
    { id: 's1', title: 'Session One', location: { directory: '/home/ubuntu/Oryxa' } },
    { id: 's2', title: 'Session Two', location: { directory: '/tmp' } },
  ];
  const modelList = models ?? [
    { providerID: 'opencode', modelID: 'm1', name: 'Model One', type: 'chat', enabled: true },
    { providerID: 'anthropic', modelID: 'm2', name: 'Model Two', type: 'chat', enabled: true },
  ];
  const calls = { create: [], switchModel: [], prompt: [], permissionReply: [], worktree: [] };

  const client = {
    session: {
      list: async () => ({ data: sessionList }),
      create: async (input) => {
        if (sessionCreateError) throw new Error(sessionCreateError);
        calls.create.push(input);
        const created = { id: `new-${calls.create.length}`, title: input.title, location: input.location };
        sessionList.push(created);
        return created;
      },
      switchModel: async (input) => calls.switchModel.push(input),
      prompt: async (input) => {
        calls.prompt.push(input);
      },
      get: async ({ sessionID }) =>
        sessionList.find((s) => s.id === sessionID) ?? sessionList[0],
      active: async () => (active ? { s1: { type: 'running' } } : {}),
    },
    permission: {
      request: {
        list: async () => ({
          data: permission
            ? [{ id: 'perm-1', sessionID: 's1', action: 'write', resources: ['/tmp/file.txt'], message: 'Allow writing the file?' }]
            : [],
        }),
      },
      reply: async (input) => calls.permissionReply.push(input),
    },
    message: {
      // SDK returns newest-first; timestamps are explicit so sorting is verifiable.
      list: async () => ({
        data: [
          { id: 'm3', type: 'assistant', time: { created: 400, completed: 401 }, content: [{ type: 'text', text: 'third answer' }] },
          { id: 'u3', type: 'user', time: { created: 399 }, text: 'third question' },
          { id: 'm2', type: 'assistant', time: { created: 300, completed: 301 }, content: [{ type: 'text', text: 'second answer' }] },
          { type: 'user', time: { created: 299 }, text: 'second question' },
          {
            id: 'm1',
            type: 'assistant',
            time: { created: 200, completed: 201 },
            content: [
              { type: 'reasoning', text: 'thinking...' },
              { type: 'text', text: 'first answer' },
              { type: 'tool', name: 'write' },
            ],
          },
          { type: 'user', time: { created: 199 }, text: 'first question' },
          { id: 'm0', type: 'assistant', time: { created: 100, completed: 101 }, content: [{ type: 'text', text: 'old answer' }] },
          { type: 'user', time: { created: 99 }, text: 'old question' },
        ],
      }),
    },
    model: { list: async () => ({ data: modelList }) },
    project: { list: async () => projects },
    worktree: {
      list: async ({ projectID }) => worktrees[projectID] ?? [],
      create: async (input) => {
        if (worktreeError) throw new Error(worktreeError);
        calls.worktree.push(input);
        return { directory: `/worktrees/${input.name}` };
      },
    },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: 'server.connected', data: {} };
          for (const thought of thoughts) {
            yield {
              type: 'session.reasoning.ended',
              data: { sessionID: 's1', text: thought },
            };
          }
          // Tool chatter must NOT reach Messenger. A failed tool step must not abort the reply.
          yield { type: 'session.tool.called', data: { sessionID: 's1', tool: 'write' } };
          if (failStep) {
            yield {
              type: 'session.step.failed',
              data: { sessionID: 's1', error: { message: 'one tool failed' } },
            };
          }
          if (permission) {
            yield {
              type: 'permission.asked',
              data: {
                id: 'perm-1',
                sessionID: 's1',
                action: 'write',
                resources: ['/tmp/file.txt'],
                message: 'Allow writing the file?',
              },
            };
          }
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's1', assistantMessageID: 'a1', delta: 'Hello ' },
          };
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's1', assistantMessageID: 'a1', delta: 'from OpenCode' },
          };
          yield { type: 'session.idle', data: { sessionID: 's1' } };
        })(),
    },
  };
  return { client, calls, sessionList, modelList };
}

function setup(overrides = {}) {
  const replies = [];
  const { client, calls, sessionList, modelList } = makeClient(overrides);
  const execCommand = async (command) => ({ stdout: `output of ${command}`, stderr: '' });
  let poller = null;
  const handle = createCommandHandler({
    client,
    execCommand,
    defaultDirectory: '/default',
    send: async (text, event) => replies.push({ text, event }),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stopped: false,
        tick: () => {
          options.onThinking?.('Let me check the answer.');
          options.onReply?.('Hello from OpenCode');
        },
        stop() { this.stopped = true; },
      };
      return poller;
    },
  });
  const incoming = (text) => handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text } });
  return {
    replies,
    calls,
    sessionList,
    modelList,
    incoming,
    get poller() { return poller; },
  };
}

test('/session pwd and /model pwd show active session and model', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  await incoming('/session pwd');
  assert.match(replies.at(-1).text, /Active session: Session One \(s1\)/);
  assert.match(replies.at(-1).text, /active model:/);
  await incoming('/model pwd');
  assert.match(replies.at(-1).text, /Active model:/);
  assert.match(replies.at(-1).text, /session: s1/);
});

test('attaching to the control session is allowed (guardrail removed)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msgctrl-control-'));
  const previousHome = process.env.MSGCTRL_HOME;
  process.env.MSGCTRL_HOME = tmp;
  try {
    fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ controlSessionId: 's-control' }));
    const replies = [];
    const { client } = makeClient({
      sessions: [{ id: 's-control', title: 'Control session', location: { directory: '/tmp' } }],
    });
    const handle = createCommandHandler({
      client,
      defaultDirectory: '/default',
      send: async (text) => replies.push(text),
      createSessionPoller: () => ({ stop() {}, tick() {} }),
    });
    await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session' } });
    assert.doesNotMatch(replies.join('\n'), /do not attach/);
    replies.length = 0;
    await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
    assert.match(replies[0], /Attached successfully to session 1: s-control/);
    assert.doesNotMatch(replies.join('\n'), /control session running this assistant/);
  } finally {
    if (previousHome === undefined) delete process.env.MSGCTRL_HOME;
    else process.env.MSGCTRL_HOME = previousHome;
  }
});

test('attaching to a session sends confirmation, model and last turns without tool chatter', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  const text = replies.at(-1).text;
  assert.match(text, /Attached successfully to session 1/);
  assert.match(text, /active model:/);
  assert.match(text, /You: first question/);
  assert.match(text, /OpenCode: first answer/);
  assert.match(text, /You: second question/);
  assert.match(text, /OpenCode: second answer/);
  assert.match(text, /You: third question/);
  assert.match(text, /OpenCode: third answer/);
  assert.match(text, /#############/);
  assert.doesNotMatch(text, /old question|old answer|thinking\.\.\.|write_tool/);
});

test('attaching to an idle session says no operation is running', async () => {
  const replies = [];
  const { client } = makeClient({ active: false });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  assert.match(replies[0], /Attached successfully to session 1/);
  assert.match(replies[0], /No operation is currently running on this session/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(replies.length, 1);
});

test('attaching to a running session starts polling and streams from that moment', async () => {
  const replies = [];
  const { client } = makeClient({ active: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          options.onThinking?.('Let me check the answer.');
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  assert.match(replies[0], /Operation running and reporting from now/);
  assert.equal(poller.sessionID, 's1');
  poller.tick();
  const joined = replies.join('\n');
  assert.match(joined, /^thinking: Let me check the answer\./m);
  assert.match(joined, /Hello from OpenCode/);
});

test('permission requests are forwarded and can be answered from Messenger', async () => {
  const replies = [];
  const { client, calls } = makeClient({ permission: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => options.onPermission?.({
          id: 'perm-1',
          sessionID: 's1',
          action: 'write',
          resources: ['/tmp/file.txt'],
          message: 'Allow writing the file?',
        }),
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  const forwarded = replies.find((r) => r.startsWith('permission asked'));
  assert.match(forwarded, /permission asked \[perm-1\]: write/);
  assert.match(forwarded, /resources: \/tmp\/file\.txt/);
  assert.match(forwarded, /\/allow perm-1/);

  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/allow perm-1' } });
  assert.deepEqual(calls.permissionReply, [
    { sessionID: 's1', requestID: 'perm-1', decision: 'once' },
  ]);
  assert.equal(replies.at(-1), 'permission once: perm-1');
});

test('a failed tool step does not prevent the final reply', async () => {
  const replies = [];
  const { client } = makeClient({ failStep: true });
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          options.onError?.('one tool failed');
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  assert.equal(replies.at(-1), 'Hello from OpenCode');
  assert.match(replies.join('\n'), /error \[poll\]: one tool failed/);
});

test('thinking relay sends 1st full, skips 2, sends compact 4th, then full 5th', async () => {
  const replies = [];
  const { client } = makeClient();
  let poller;
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = {
        ...options,
        stop() {},
        tick: () => {
          for (const thought of ['step one', 'step two', 'step three', 'step four', 'step five']) {
            options.onThinking?.(thought);
          }
          options.onReply?.('Hello from OpenCode');
        },
      };
      return poller;
    },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  poller.tick();
  assert.deepEqual(replies, [
    'thinking: step one',
    '(Thinking.....)',
    'thinking: step five',
    'Hello from OpenCode',
  ]);
});

test('/bash opens a stateful terminal, streams output and /exit closes it', async () => {
  const replies = [];
  const commands = [];
  let killed = false;
  let options;

  const terminal = {
    cwd: '/home',
    alive: true,
    run: async (command) => {
      commands.push(command);
      if (command.startsWith('cd ')) terminal.cwd = command.slice(3).trim();
    },
    send: () => {},
    kill: () => { killed = true; },
  };
  const { client } = makeClient();
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createTerminal: (opts) => { options = opts; return terminal; },
  });
  const incoming = (text) =>
    handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text } });

  await incoming('/bash');
  assert.equal(options.cwd, '/home');
  assert.match(replies.at(-1), /terminal opened at \/home/);

  await incoming('cd /sbin');
  assert.deepEqual(commands, ['cd /sbin']);
  assert.equal(terminal.cwd, '/sbin');
  assert.equal(replies.at(-1), 'cwd: /sbin');

  options.onOutput('first log line\n');
  assert.equal(replies.at(-1), 'first log line\n');
  options.onOutput('still running...\n');
  assert.equal(replies.at(-1), 'still running...\n');

  await incoming('ls');
  assert.deepEqual(commands, ['cd /sbin', 'ls']);

  await incoming('/exit');
  assert.equal(killed, true);
  assert.equal(replies.at(-1), 'terminal closed');

  replies.length = 0;
  await incoming('hello');
  assert.match(replies.at(-1), /No session currently attached/);
});

test('typing exit inside the terminal closes terminal mode', async () => {
  const replies = [];
  let options;
  const terminal = {
    cwd: '/home',
    alive: true,
    run: async () => {},
    send: () => options.onExit(0),
    kill: () => {},
  };
  const { client } = makeClient();
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createTerminal: (opts) => { options = opts; return terminal; },
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/bash' } });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'exit' } });
  assert.match(replies.at(-1), /terminal exited \(code 0\)/);

  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'pwd' } });
  assert.match(replies.at(-1), /No session currently attached/);
});

test('defaultSessionId makes normal messages prompts without attaching first', async () => {
  const replies = [];
  const { client, calls } = makeClient();
  let poller;
  const handleWithPoller = createCommandHandler({
    client,
    defaultDirectory: '/default',
    defaultSessionId: 's1',
    send: async (text) => replies.push(text),
    createSessionPoller: (options) => {
      poller = { ...options, stop() {}, tick: () => options.onReply?.('Hello from OpenCode') };
      return poller;
    },
  });
  await handleWithPoller({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hello' } });
  assert.equal(calls.prompt.at(-1).sessionID, 's1');
  poller.tick();
  assert.equal(replies.at(-1), 'Hello from OpenCode');
  assert.doesNotMatch(replies.join('\n'), /No session currently attached/);
});

test('promptAndWait returns streamed text instead of a timeout error when text exists', async () => {
  const { promptAndWait } = await import('../src/opencode.js');
  const errors = [];
  const client = {
    session: { prompt: async () => {} },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: 'server.connected', data: {} };
          yield {
            type: 'session.text.delta',
            data: { sessionID: 's9', assistantMessageID: 'a9', delta: 'Partial answer' },
          };
          await new Promise(() => {});
        })(),
    },
  };
  const answer = await promptAndWait(
    client,
    's9',
    'hi',
    () => {},
    (error) => errors.push(error),
    () => {},
    300,
  );
  assert.equal(answer, 'Partial answer');
  assert.deepEqual(errors, []);
});

test('!command runs directly and returns its output', async () => {
  const { replies, incoming } = setup();
  await incoming('!ls -la');
  assert.match(replies.at(-1).text, /\$ ls -la/);
  assert.match(replies.at(-1).text, /output of ls -la/);
});

test('!cd updates the working directory used by later shell commands', async () => {
  const { replies, incoming } = setup();
  await incoming('!cd /tmp');
  assert.match(replies.at(-1).text, /Working directory: \/tmp/);
  await incoming('!pwd');
  assert.match(replies.at(-1).text, /output of pwd/);
});

test('a normal message with no session sends the numbered session list', async () => {
  const { replies, incoming } = setup();
  await incoming('hello');
  const text = replies.at(-1).text;
  assert.match(text, /No session currently attached/);
  assert.match(text, /1\. Session One/);
  assert.match(text, /2\. Session Two/);
});

test('/session lists then /session 2 attaches', async () => {
  const { replies, incoming } = setup();
  await incoming('/session');
  assert.match(replies.at(-1).text, /1\. Session One/);
  await incoming('/session 2');
  assert.match(replies.at(-1).text, /Attached successfully to session 2: s2/);
});

test('prompt is enqueued and the poller delivers thinking then the final answer', async () => {
  const ctx = setup();
  const { replies, calls, incoming } = ctx;
  await incoming('/session 1');
  await incoming('what is 2+2?');
  assert.equal(calls.prompt.at(-1).text, 'what is 2+2?');
  ctx.poller.tick();
  assert.equal(replies.at(-2).text, 'thinking: Let me check the answer.');
  assert.equal(replies.at(-1).text, 'Hello from OpenCode');
  assert.doesNotMatch(replies.at(-1).text, /calling tool|write_tool/);
});

test('/exit detaches and the next prompt asks for a session again', async () => {
  const { replies, incoming } = setup();
  await incoming('/session 1');
  await incoming('/exit');
  assert.equal(replies.at(-1).text, 'session exited');
  await incoming('another question');
  assert.match(replies.at(-1).text, /No session currently attached/);
});

test('/model ls lists models and /models 2 switches the attached session', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/model ls');
  assert.match(replies.at(-1).text, /1\. opencode\/m1/);
  await incoming('/session 1');
  await incoming('/models  2');
  assert.equal(calls.switchModel.at(-1).sessionID, 's1');
  assert.equal(calls.switchModel.at(-1).model.id, 'm2');
  assert.match(replies.at(-1).text, /anthropic\/m2/);
});

test('/models 1 with no session asks the user to connect first', async () => {
  const { replies, incoming } = setup();
  await incoming('/models 1');
  const text = replies.at(-1).text;
  assert.match(text, /No session attached|connect one first/);
  assert.match(text, /1\. Session One/);
});

test('/session new requires a session name and creates the session with that title', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/session new /home/oryxa');
  assert.match(replies.at(-1).text, /Usage: \/session new <directory> <session-name>/);

  await incoming('/session new /home/oryxa feather-3');
  const text = replies.at(-1).text;
  assert.match(text, /Attached successfully to new session/);
  assert.equal(calls.create.at(-1).location.directory, '/home/oryxa');
  assert.equal(calls.create.at(-1).title, 'feather-3');
  assert.ok(calls.create.at(-1).model, 'a default model was chosen');
  assert.match(text, /session name: feather-3/);
  assert.match(text, /\nmodel: [^\n]+\/[^\n]+/);
  assert.match(text, /path: \/home\/oryxa/);
  assert.match(text, /worktree: none/);

  // Choose a model, exit, then create another session: it must reuse the last model.
  await incoming('/model ls');
  await incoming('/models 2');
  await incoming('/exit');
  await incoming('/session new /tmp feather-4');
  assert.equal(calls.create.at(-1).model.id, 'm2');
  assert.equal(calls.create.at(-1).title, 'feather-4');
});

test('/session new --wk creates a worktree for the owning project and a session inside it', async () => {
  const replies = [];
  const { client, calls } = makeClient({
    projects: [{ id: 'proj-1', canonical: '/home/ubuntu/Oryxa' }],
    worktrees: { 'proj-1': [{ directory: '/home/ubuntu/Oryxa' }] },
  });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  const incoming = (text) =>
    handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text } });

  await incoming('/session new /home/ubuntu/Oryxa feather-3 --wk');
  assert.deepEqual(calls.worktree, [{ projectID: 'proj-1', name: 'feather-3' }]);
  assert.equal(calls.create.at(-1).location.directory, '/worktrees/feather-3');
  assert.equal(calls.create.at(-1).title, 'feather-3');
  const text = replies.at(-1);
  assert.match(text, /session name: feather-3/);
  assert.match(text, /path: \/worktrees\/feather-3/);
  assert.match(text, /worktree path: \/worktrees\/feather-3/);
});

test('/session new --wk with no matching project creates the session directly', async () => {
  const replies = [];
  const { client, calls } = makeClient({ projects: [] });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session new /tmp plain-1 --wk' } });
  assert.equal(calls.worktree.length, 0);
  assert.equal(calls.create.at(-1).location.directory, '/tmp');
  const text = replies.at(-1);
  assert.match(text, /no OpenCode project found at \/tmp/);
  assert.match(text, /session created directly/);
  assert.match(text, /worktree: none/);
});

test('/session new reports worktree and session creation errors immediately', async () => {
  const replies = [];
  const { client, calls } = makeClient({ projects: [{ id: 'proj-1', canonical: '/home/ubuntu/Oryxa' }], worktreeError: 'worktree boom' });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session new /home/ubuntu/Oryxa broken --wk' } });
  assert.match(replies.at(-1), /Error creating worktree and session "broken"/);
  assert.match(replies.at(-1), /worktree boom/);
  assert.equal(calls.create.length, 0);

  const replies2 = [];
  const failing = makeClient({ sessionCreateError: 'session boom' });
  const handle2 = createCommandHandler({
    client: failing.client,
    defaultDirectory: '/default',
    send: async (text) => replies2.push(text),
    createSessionPoller: () => ({ stop() {}, tick() {} }),
  });
  await handle2({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session new /tmp broken2' } });
  assert.match(replies2.at(-1), /Error creating session "broken2"/);
  assert.match(replies2.at(-1), /session boom/);
});

test('splitText chunks long replies and never returns an empty reply', () => {
  assert.deepEqual(splitText(''), ['(no output)']);
  const chunks = splitText('x'.repeat(3200), 1500);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1500));
  assert.equal(chunks.join(''), 'x'.repeat(3200));
});
