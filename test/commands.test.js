import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHandler } from '../src/commands.js';
import { splitText } from '../src/onlyorders.js';

function makeClient({ sessions, models } = {}) {
  const sessionList = sessions ?? [
    { id: 's1', title: 'Session One', location: { directory: '/home/ubuntu/Oryxa' } },
    { id: 's2', title: 'Session Two', location: { directory: '/tmp' } },
  ];
  const modelList = models ?? [
    { providerID: 'opencode', modelID: 'm1', name: 'Model One', type: 'chat', enabled: true },
    { providerID: 'anthropic', modelID: 'm2', name: 'Model Two', type: 'chat', enabled: true },
  ];
  const calls = { create: [], switchModel: [], prompt: [] };

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
    },
    model: { list: async () => ({ data: modelList }) },
    event: {
      subscribe: () =>
        (async function* () {
          yield { type: 'server.connected', data: {} };
          // Chatter that must NOT reach Messenger.
          yield { type: 'session.reasoning.delta', data: { sessionID: 's1', delta: 'thinking...' } };
          yield { type: 'session.tool.called', data: { sessionID: 's1', tool: 'write' } };
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
  assert.match(replies.at(-1).text, /session 2 attached: s2/);
});

test('prompt returns only the final assistant text, not thinking or tool chatter', async () => {
  const { replies, calls, incoming } = setup();
  await incoming('/session 1');
  await incoming('what is 2+2?');
  assert.equal(calls.prompt.at(-1).text, 'what is 2+2?');
  assert.equal(replies.at(-1).text, 'Hello from OpenCode');
  assert.doesNotMatch(replies.at(-1).text, /thinking|write_tool|calling tool/);
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
