import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_POLICY,
  apply as applyPolicy,
  name as policyName,
  shouldInject,
} from '../presets/apex-v041/apex-policy.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  phaseFor,
  RESIDENT_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v041/tool-gate.mjs'

const catalog = [
  { name: 'bash' },
  { name: 'dev_tool_search' },
  { name: 'skill' },
  { name: 'str_replace_editor' },
  { name: 'web_search' },
]

function agent(events = [], header = {}) {
  return { session: { events, header } }
}

function unlockResult(unlockedTools, matchedTools = unlockedTools) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: UNLOCK_META_KIND, matchedTools, unlockedTools },
    },
  }
}

function policyEvent(id = 'policy') {
  return {
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text: APEX_POLICY }],
      source: { kind: 'plugin', plugin: policyName, form: 'instructions' },
    },
  }
}

function queuedUserBoundary(id = 'next-task') {
  const message = { id, role: 'user', content: [], source: { kind: 'user' } }
  return [
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [message] },
    },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    },
  ]
}

function gateListener() {
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  return listener
}

async function assemble(listener, events = [], header = {}) {
  return listener(undefined, { agent: agent(events, header) }, async () => ({
    sections: [{ name: 'persona', text: 'minimal' }],
    contexts: [],
    variables: {},
    tools: catalog,
  }))
}

test('APEX v0.4.1 preserves the exact Minimal first-request tool pair', async () => {
  const result = await assemble(gateListener())
  assert.deepEqual(result.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
})

test('APEX v0.4.1 unlocks only from a successful durable tool result', async () => {
  const listener = gateListener()
  const attempted = [
    { type: 'assistant/message', data: {} },
    {
      type: 'tool/call',
      data: {
        name: 'dev_tool_search',
        arguments: '{"toolNames":["web_search"]}',
      },
    },
  ]
  const beforeResult = await assemble(listener, attempted)
  assert.deepEqual(
    beforeResult.tools.map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )

  const afterResult = await assemble(listener, [...attempted, unlockResult(['web_search'])])
  assert.deepEqual(
    afterResult.tools.map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS, 'web_search'].sort(),
  )
})

test('APEX v0.4.1 durable unlocks survive resume and reset at both boundaries', () => {
  const active = [
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    unlockResult(['web_search']),
  ]
  assert.deepEqual([...phaseFor(agent(structuredClone(active))).unlocked], ['web_search'])

  const nextTask = [
    ...active,
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]
  assert.equal(phaseFor(agent(nextTask)).promoted, false)
  assert.deepEqual([...phaseFor(agent(nextTask)).unlocked], [])

  const compacted = [...active, { type: 'compaction/end', data: {} }]
  assert.equal(phaseFor(agent(compacted)).promoted, false)
  assert.deepEqual([...phaseFor(agent(compacted)).unlocked], [])

  const claimedTask = [...active, ...queuedUserBoundary()]
  assert.equal(phaseFor(agent(claimedTask)).promoted, false)
  assert.deepEqual([...phaseFor(agent(claimedTask)).unlocked], [])
})

test('APEX v0.4.1 re-anchors before the claimed user message is appended', async () => {
  const previousTask = [
    { type: 'assistant/message', data: {} },
    unlockResult(['web_search']),
    ...queuedUserBoundary(),
  ]
  const result = await assemble(gateListener(), previousTask)
  assert.deepEqual(result.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
})

test('APEX v0.4.1 policy remains post-anchor and once per epoch', async () => {
  let listener
  applyPolicy({
    on(event, value) {
      assert.equal(event, 'agent/pre-step')
      listener = value
      return () => {}
    },
  })
  const signal = new AbortController().signal
  const user = { id: 'user', role: 'user', content: [], source: { kind: 'user' } }

  const bootstrap = await listener(
    { agent: agent(), signal },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  assert.deepEqual(bootstrap.messages, [user])

  const promoted = await listener(
    { agent: agent([{ type: 'assistant/message', data: {} }]), signal },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  assert.equal(promoted.messages.at(-1).source.plugin, policyName)
  assert.equal(shouldInject(agent([
    { type: 'assistant/message', data: {} },
    policyEvent(),
  ])), false)
  assert.equal(shouldInject(agent([
    { type: 'assistant/message', data: {} },
    policyEvent('old-policy'),
    ...queuedUserBoundary(),
    { type: 'assistant/message', data: {} },
  ])), true)
})

test('APEX v0.4.1 policy names the enforced research limits', () => {
  assert.match(APEX_POLICY, /dev_tool_search is now resident/)
  assert.match(APEX_POLICY, /at most four catalog-discovery calls/)
  assert.match(APEX_POLICY, /starts with three web_search calls/)
  assert.match(APEX_POLICY, /absolute limit of ten web searches/)
  assert.match(APEX_POLICY, /researchGap and one distinct nextWebQuery/)
  assert.match(APEX_POLICY, /Never infer an official URL/)
  assert.match(APEX_POLICY, /owner\/repository casing shown by the authoritative page heading/)
  assert.match(APEX_POLICY, /delegation and orchestration cannot replace the continuation path/)
  assert.match(APEX_POLICY, /unlock at most one allowlisted tool/)
  assert.match(APEX_POLICY, /stop only their recorded PIDs/)
})

test('APEX v0.4.1 keeps subagents on the complete catalog', async () => {
  const result = await assemble(gateListener(), [], { delegationDepth: 1 })
  assert.deepEqual(result.tools, catalog)
})
