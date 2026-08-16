import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_POLICY,
  apply,
  name,
  policyMessage,
  shouldInject,
} from '../presets/apex-v03/apex-policy.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
} from '../presets/apex-v03/tool-gate.mjs'

function agent(events = [], header = {}) {
  return { session: { events, header } }
}

function policyEvent() {
  return {
    type: 'user/message',
    data: {
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

test('APEX first top-level request remains the exact Minimal tool pair', async () => {
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

test('APEX policy is absent before promotion and injected once after promotion', async () => {
  const listener = registerPolicy()
  const signal = new AbortController().signal
  const original = { id: 'user', role: 'user', content: [], source: { kind: 'user' } }

  const bootstrap = await listener(
    { agent: agent(), signal },
    async () => ({ kind: 'enter', messages: [original] }),
  )
  assert.deepEqual(bootstrap.messages, [original])

  const promotedAgent = agent([{ type: 'assistant/message', data: {} }])
  const promoted = await listener(
    { agent: promotedAgent, signal },
    async () => ({ kind: 'enter', messages: [original] }),
  )
  assert.equal(promoted.messages.length, 2)
  assert.equal(promoted.messages[1].source.plugin, name)
  assert.equal(promoted.messages[1].content[0].text, APEX_POLICY)

  assert.equal(shouldInject(agent([
    { type: 'assistant/message', data: {} },
    policyEvent(),
  ])), false)
})

test('compaction starts a fresh anchor and policy epoch', () => {
  const events = [
    { type: 'assistant/message', data: {} },
    policyEvent(),
    { type: 'compaction/end', data: {} },
  ]
  assert.equal(shouldInject(agent(events)), false)
  assert.equal(shouldInject(agent([
    ...events,
    { type: 'assistant/message', data: {} },
  ])), true)
})

test('subagents receive the lean policy without losing their full catalog', async () => {
  assert.equal(shouldInject(agent([], { delegationDepth: 1 })), true)
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
  const assembly = await listener(
    undefined,
    { agent: agent([], { delegationDepth: 1 }) },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
  assert.equal(assembly.tools, catalog)
})

test('policy message is a frozen, source-attributed user instruction', () => {
  const message = policyMessage()
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.form, 'instructions')
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
  assert.match(APEX_POLICY, /smallest reliable path/)
  assert.match(APEX_POLICY, /Never skip safety/)
})

test('policy hook preserves rejection and active-mode messages', async () => {
  const listener = registerPolicy()
  const signal = new AbortController().signal
  const promoted = agent([{ type: 'assistant/message', data: {} }])
  const planNarration = { id: 'plan', source: { kind: 'plugin', plugin: 'plan-mode' } }

  assert.deepEqual(
    await listener({ agent: promoted, signal }, async () => ({ kind: 'reject' })),
    { kind: 'reject' },
  )
  const entered = await listener(
    { agent: promoted, signal },
    async () => ({ kind: 'enter', messages: [planNarration] }),
  )
  assert.equal(entered.messages[0], planNarration)
  assert.equal(entered.messages[1].source.plugin, name)
})
