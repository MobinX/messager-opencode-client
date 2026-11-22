import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHandler } from '../src/commands.js';
import { splitText } from '../src/onlyorders.js';

function makeClient({
  sessions,
  models,
  thoughts = ['Let me check the answer.'],
  failStep = false,
  permission = false,
  active = false,
} = {}) {
  const sessionList = sessions ?? [
    { id: 's1', title: 'Session One', location: { directory: '/home/ubuntu/Oryxa' } },
    { id: 's2', title: 'Session Two', location: { directory: '/tmp' } },
  ];
  const modelList = models ?? [
    { providerID: 'opencode', modelID: 'm1', name: 'Model One', type: 'chat', enabled: true },
    { providerID: 'anthropic', modelID: 'm2', name: 'Model Two', type: 'chat', enabled: true },
  ];
  const calls = { create: [], switchModel: [], prompt: [], permissionReply: [] };

  const client = {
    session: {
      list: async () => ({ data: sessionList }),
      create: async (input) => {
        calls.create.push(input);
        const created = { id: 'new-1', title: input.title, location: input.location };
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
    message: {
      // SDK returns newest-first; timestamps are explicit so sorting is verifiable.
      list: async () => ({
        data: [
          { type: 'assistant', time: { created: 400 }, content: [{ type: 'text', text: 'third answer' }] },
          { type: 'user', time: { created: 399 }, text: 'third question' },
          { type: 'assistant', time: { created: 300 }, content: [{ type: 'text', text: 'second answer' }] },
          { type: 'user', time: { created: 299 }, text: 'second question' },
          {
            type: 'assistant',
            time: { created: 200 },
            content: [
              { type: 'reasoning', text: 'thinking...' },
              { type: 'text', text: 'first answer' },
              { type: 'tool', name: 'write' },
            ],
          },
          { type: 'user', time: { created: 199 }, text: 'first question' },
          { type: 'assistant', time: { created: 100 }, content: [{ type: 'text', text: 'old answer' }] },
          { type: 'user', time: { created: 99 }, text: 'old question' },
        ],
      }),
    },
    model: { list: async () => ({ data: modelList }) },
    permission: {
      reply: async (input) => calls.permissionReply.push(input),
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
  const handle = createCommandHandler({
    client,
    execCommand,
    defaultDirectory: '/default',
    send: async (text, event) => replies.push({ text, event }),
  });
  const incoming = (text) => handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text } });
  return { replies, calls, sessionList, modelList, incoming };
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

test('attaching to a running session reports and streams from that moment', async () => {
  const replies = [];
  const { client } = makeClient({ active: true });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  assert.match(replies[0], /Operation running and reporting from now/);
  await new Promise((r) => setTimeout(r, 500));
  const joined = replies.join('\n');
  assert.match(joined, /^thinking: Let me check the answer\./m);
  assert.match(joined, /Hello from OpenCode/);
});

test('permission requests are forwarded and can be answered from Messenger', async () => {
  const replies = [];
  const { client, calls } = makeClient({ permission: true });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hi' } });
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
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hi' } });
  assert.equal(replies.at(-1), 'Hello from OpenCode');
  assert.match(replies.join('\n'), /error \[session.step.failed\]: one tool failed/);
});

test('thinking relay sends 1st full, skips 2, sends compact 4th, then full 5th', async () => {
  const replies = [];
  const { client } = makeClient({
    thoughts: ['step one', 'step two', 'step three', 'step four', 'step five'],
  });
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: '/session 1' } });
  replies.length = 0;
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hi' } });
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
  const handle = createCommandHandler({
    client,
    defaultDirectory: '/default',
    defaultSessionId: 's1',
    send: async (text) => replies.push(text),
  });
  await handle({ pageId: 'PAGE', customerInfo: { id: 'USER' }, payload: { text: 'hello' } });
  assert.equal(calls.prompt.at(-1).sessionID, 's1');
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

test('prompt streams thinking updates then the final answer, without tool chatter', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/session 1');
  await incoming('what is 2+2?');
  assert.equal(calls.prompt.at(-1).text, 'what is 2+2?');
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

test('/session new creates a session in the given directory and remembers the chosen model', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/session new /home/oryxa');
  assert.match(replies.at(-1).text, /Attached successfully to new session/);
  assert.equal(calls.create.at(-1).location.directory, '/home/oryxa');
  assert.ok(calls.create.at(-1).model, 'a default model was chosen');

  // Choose a model, exit, then create another session: it must reuse the last model.
  await incoming('/model ls');
  await incoming('/models 2');
  await incoming('/exit');
  await incoming('/session new /tmp');
  assert.equal(calls.create.at(-1).model.id, 'm2');
});

test('splitText chunks long replies and never returns an empty reply', () => {
  assert.deepEqual(splitText(''), ['(no output)']);
  const chunks = splitText('x'.repeat(3200), 1500);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1500));
  assert.equal(chunks.join(''), 'x'.repeat(3200));
});
