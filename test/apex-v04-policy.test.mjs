import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_POLICY,
  apply,
  name,
  policyMessage,
  shouldInject,
} from '../presets/apex-v04/apex-policy.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  phaseFor,
  RESIDENT_TOOLS,
} from '../presets/apex-v04/tool-gate.mjs'

function agent(events = [], header = {}) {
  return { session: { events, header } }
}

function policyEvent(id = 'policy') {
  return {
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text: APEX_POLICY }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    },
  }
}

function registerPolicy() {
  let listener
  apply({
    on(event, value) {
      assert.equal(event, 'agent/pre-step')
      listener = value
      return () => {}
    },
  })
  return listener
}

test('APEX v0.4 first human-task request remains the exact Minimal tool pair', async () => {
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  const assembly = await listener(
    undefined,
    { agent: agent() },
    async () => ({
      sections: [{ name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' }],
      contexts: [],
      variables: {},
      tools: [
        { name: 'bash' },
        { name: 'dev_tool_search' },
        { name: 'str_replace_editor' },
        { name: 'web_search' },
      ],
    }),
  )
  assert.deepEqual(assembly.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
})

test('APEX v0.4 policy is absent before promotion and injected once per epoch', async () => {
  const listener = registerPolicy()
  const signal = new AbortController().signal
  const original = { id: 'user', role: 'user', content: [], source: { kind: 'user' } }

  const bootstrap = await listener(
    { agent: agent(), signal },
    async () => ({ kind: 'enter', messages: [original] }),
  )
  assert.deepEqual(bootstrap.messages, [original])

  const promoted = await listener(
    { agent: agent([{ type: 'assistant/message', data: {} }]), signal },
    async () => ({ kind: 'enter', messages: [original] }),
  )
  assert.equal(promoted.messages.length, 2)
  assert.equal(promoted.messages[1].source.plugin, name)
  assert.equal(shouldInject(agent([
    { type: 'assistant/message', data: {} },
    policyEvent(),
  ])), false)

  assert.equal(shouldInject(agent([
    { type: 'assistant/message', data: {} },
    policyEvent(),
    { type: 'compaction/end', data: {} },
    { type: 'assistant/message', data: {} },
  ])), true)
})

test('each human task re-anchors before dynamically promoting again', async () => {
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  const catalog = [
    { name: 'bash' },
    { name: 'dev_tool_search' },
    { name: 'str_replace_editor' },
    { name: 'web_search' },
  ]
  const previousTask = [
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    {
      type: 'tool/call',
      data: {
        name: 'dev_tool_search',
        arguments: '{"toolNames":["web_search"]}',
      },
    },
  ]
  assert.equal(phaseFor(agent(previousTask)).promoted, true)

  const nextTask = [
    ...previousTask,
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]
  const anchored = await listener(undefined, { agent: agent(nextTask) }, async () => ({
    sections: [],
    contexts: [],
    variables: {},
    tools: catalog,
  }))
  assert.deepEqual(anchored.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
  assert.deepEqual([...phaseFor(agent(nextTask)).unlocked], [])

  const promoted = await listener(
    undefined,
    { agent: agent([...nextTask, { type: 'tool/call', data: { name: 'bash', arguments: '{}' } }]) },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
  assert.deepEqual(
    promoted.tools.map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
})

test('plugin policy messages do not create false task boundaries', () => {
  const state = phaseFor(agent([
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    policyEvent(),
  ]))
  assert.equal(state.promoted, true)
})

test('APEX policy is eligible again after a new human task promotes', () => {
  assert.equal(shouldInject(agent([
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    policyEvent(),
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
  ])), true)
})

test('a new task drops stale policy history and keeps its first request unmodified', async () => {
  const listener = registerPolicy()
  const signal = new AbortController().signal
  const user = { id: 'user-2', role: 'user', content: [], source: { kind: 'user' } }
  const stalePolicy = {
    id: 'policy-1',
    role: 'user',
    content: [{ type: 'text', text: APEX_POLICY }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  }
  const events = [
    { type: 'user/message', data: { id: 'user-1', source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    policyEvent('policy-1'),
    { type: 'user/message', data: { id: 'user-2', source: { kind: 'user' } } },
  ]

  const anchored = await listener(
    { agent: agent(events), signal },
    async () => ({ kind: 'enter', messages: [stalePolicy, user] }),
  )
  assert.deepEqual(anchored.messages, [user])

  const promoted = await listener(
    {
      agent: agent([...events, { type: 'tool/call', data: { name: 'bash', arguments: '{}' } }]),
      signal,
    },
    async () => ({ kind: 'enter', messages: [stalePolicy, user] }),
  )
  assert.equal(promoted.messages.length, 2)
  assert.equal(promoted.messages[0], user)
  assert.equal(promoted.messages[1].source.plugin, name)
  assert.notEqual(promoted.messages[1].id, stalePolicy.id)
})

test('APEX v0.4 policy pins the observed validation and process-safety constraints', () => {
  assert.match(APEX_POLICY, /one relevant static check and one runtime or smoke check/)
  assert.match(APEX_POLICY, /stop only their recorded PIDs/)
  assert.match(APEX_POLICY, /page error, black screen/)
  assert.match(APEX_POLICY, /test file:\/\//)
  assert.match(APEX_POLICY, /dev_tool_search/)

  const message = policyMessage()
  assert.equal(message.role, 'user')
  assert.equal(message.source.plugin, name)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
})
