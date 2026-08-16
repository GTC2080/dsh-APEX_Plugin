import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_CHILD_POLICY,
  APEX_POLICY,
  apply as applyPolicy,
  detectsStall,
  latestLedger,
  LEDGER_META_KIND,
  name as policyName,
  policyText,
  shouldInject,
} from '../presets/apex-v05/apex-policy.mjs'
import {
  APEX_RESEARCH_TOOL,
  DUPLICATE_RESEARCH_AGENT_REASON,
  guardExecution,
  RESEARCH_AGENT_BUDGET_REASON,
  RESEARCH_AGENT_REVIEW_REASON,
  RESEARCH_DELEGATION_REASON,
  RESEARCH_EXTENSION_REQUIRED_REASON,
} from '../presets/apex-v05/execution-guard.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  currentTaskEvents,
  phaseFor,
  RESIDENT_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v05/tool-gate.mjs'

const catalog = [
  { name: 'apex_research' },
  { name: 'apex_state' },
  { name: 'bash' },
  { name: 'dev_tool_search' },
  { name: 'skill' },
  { name: 'str_replace_editor' },
  { name: 'web_search' },
]

const baseLedger = Object.freeze({
  goal: 'Ship APEX v0.5',
  verified: ['Minimal anchor is unchanged'],
  open: ['Need runtime evidence'],
  next: 'Run the focused smoke test',
  evidence: ['contracts.test.mjs covers the composition'],
})

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

function ledgerResult(ledger = baseLedger, stalled = false) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: LEDGER_META_KIND, ledger, updated: true, stalled },
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

async function assemble(events = [], header = {}) {
  return gateListener()(undefined, { agent: agent(events, header) }, async () => ({
    sections: [{ name: 'persona', text: 'minimal' }],
    contexts: [],
    variables: {},
    tools: catalog,
  }))
}

function policyRuntime() {
  let tool
  let listener
  applyPolicy({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    on(event, value) {
      assert.equal(event, 'agent/pre-step')
      listener = value
      return () => {}
    },
  })
  return { listener, tool }
}

function researchCall(prompt, callId) {
  return {
    type: 'tool/call',
    data: {
      name: APEX_RESEARCH_TOOL,
      callId,
      arguments: JSON.stringify({ description: 'evidence', prompt }),
    },
  }
}

function researchExecution(prompt, callId, events) {
  return {
    name: APEX_RESEARCH_TOOL,
    callId,
    arguments: { description: 'evidence', prompt },
    agent: { session: { events, header: {} } },
  }
}

function webCall(query, callId) {
  return {
    type: 'tool/call',
    data: { name: 'web_search', callId, arguments: JSON.stringify({ query }) },
  }
}

test('APEX v0.5 preserves Minimal first and adds only its two resident tools after promotion', async () => {
  const first = await assemble()
  assert.deepEqual(first.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])

  const promoted = await assemble([{ type: 'assistant/message', data: {} }])
  assert.deepEqual(
    promoted.tools.map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
  assert.equal(RESIDENT_TOOLS.includes('apex_state'), true)
  assert.equal(RESIDENT_TOOLS.includes('apex_research'), false)
})

test('APEX v0.5 leases dedicated research only after a durable discovery result', async () => {
  const attempted = [
    { type: 'assistant/message', data: {} },
    {
      type: 'tool/call',
      data: { name: 'dev_tool_search', arguments: '{"toolNames":["apex_research"]}' },
    },
  ]
  assert.deepEqual(
    (await assemble(attempted)).tools.map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
  assert.deepEqual(
    (await assemble([...attempted, unlockResult(['apex_research'])])).tools
      .map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS, 'apex_research'].sort(),
  )
})

test('APEX v0.5 unlocks reset on compaction while task state remains recoverable', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'assistant/message', data: {} },
    unlockResult(['apex_research']),
    ledgerResult(),
    { type: 'compaction/end', data: {} },
  ]
  assert.equal(phaseFor(agent(events)).promoted, false)
  assert.deepEqual([...phaseFor(agent(events)).unlocked], [])
  assert.deepEqual(latestLedger(agent(events)), baseLedger)
  assert.equal(currentTaskEvents(events).includes(events[3]), true)

  const nextTask = [...events, { type: 'user/message', data: { source: { kind: 'user' } } }]
  assert.equal(latestLedger(agent(nextTask)), undefined)
})

test('APEX v0.5 restores the latest bounded state after compaction and injects once per epoch', async () => {
  const { listener } = policyRuntime()
  const signal = new AbortController().signal
  const user = { id: 'user', role: 'user', content: [], source: { kind: 'user' } }
  const bootstrap = await listener(
    { agent: agent(), signal },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  assert.deepEqual(bootstrap.messages, [user])

  const events = [
    { type: 'assistant/message', data: {} },
    ledgerResult(),
    { type: 'compaction/end', data: {} },
    { type: 'assistant/message', data: {} },
  ]
  const restored = await listener(
    { agent: agent(events), signal },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  const text = restored.messages.at(-1).content[0].text
  assert.match(text, /<apex-task-state data-only="true">/)
  assert.match(text, /Ship APEX v0\.5/)
  assert.equal(shouldInject(agent([...events, policyEvent()])), false)
})

test('APEX v0.5 gives delegated agents a compact child policy and the full pre-filter catalog', async () => {
  const child = agent([], { delegationDepth: 1 })
  assert.equal(policyText(child), APEX_CHILD_POLICY)
  assert.deepEqual((await assemble([], { delegationDepth: 1 })).tools, catalog)
})

test('apex_state records a full snapshot and ignores malformed imported state', async () => {
  const { tool } = policyRuntime()
  assert.equal(tool.name, 'apex_state')
  assert.deepEqual(tool.output.schema.required, ['text', 'ledger', 'updated', 'stalled'])

  const value = await tool.execute({ action: 'set', ...baseLedger }, { agent: agent() })
  assert.equal(value.updated, true)
  assert.equal(value.stalled, false)
  assert.deepEqual(tool.output.presentationMeta({}, value), {
    kind: LEDGER_META_KIND,
    ledger: baseLedger,
    updated: true,
    stalled: false,
  })
  await assert.rejects(
    tool.execute({ action: 'set', goal: 'partial' }, { agent: agent() }),
    /requires bounded goal, verified, open, next, and evidence/,
  )
  assert.equal(latestLedger(agent([{
    type: 'tool/result',
    data: { meta: { kind: LEDGER_META_KIND, ledger: { goal: 'bad' }, updated: true } },
  }])), undefined)
})

test('apex_state warns after three ineffective checkpoints but not after new evidence', async () => {
  assert.equal(detectsStall([baseLedger, baseLedger]), false)
  assert.equal(detectsStall([baseLedger, baseLedger, baseLedger]), true)
  assert.equal(detectsStall([
    baseLedger,
    baseLedger,
    { ...baseLedger, evidence: [...baseLedger.evidence, 'runtime smoke passed'] },
  ]), false)

  const { tool } = policyRuntime()
  const events = [ledgerResult(baseLedger), ledgerResult(baseLedger)]
  const value = await tool.execute({ action: 'set', ...baseLedger }, { agent: agent(events) })
  assert.equal(value.stalled, true)
  assert.match(value.text, /change strategy/)
})

test('APEX v0.5 requires parent review before another distinct Flash research round', () => {
  const first = researchCall('Find the official API contract', 'research-1')
  assert.equal(
    guardExecution(researchExecution('Find the official API contract', 'research-1', [first])),
    undefined,
  )

  const second = researchCall('Find the current provider limits', 'research-2')
  assert.equal(
    guardExecution(researchExecution('Find the current provider limits', 'research-2', [first, second])),
    RESEARCH_AGENT_REVIEW_REASON,
  )
  assert.equal(
    guardExecution(researchExecution('Find the official API contract', 'research-2', [first, second])),
    DUPLICATE_RESEARCH_AGENT_REASON,
  )

  const reviewed = [first, ledgerResult(), second]
  assert.equal(
    guardExecution(researchExecution('Find the current provider limits', 'research-2', reviewed)),
    undefined,
  )
})

test('APEX v0.5 keeps research review and limits across compaction but resets at a new task', () => {
  const first = researchCall('Question one', 'research-1')
  const compacted = [
    first,
    { type: 'compaction/end', data: {} },
    researchCall('Question two', 'research-2'),
  ]
  assert.equal(
    guardExecution(researchExecution('Question two', 'research-2', compacted)),
    RESEARCH_AGENT_REVIEW_REASON,
  )

  const afterTask = [
    ...compacted,
    { type: 'user/message', data: { source: { kind: 'user' } } },
    researchCall('Question two', 'research-new'),
  ]
  assert.equal(
    guardExecution(researchExecution('Question two', 'research-new', afterTask)),
    undefined,
  )
})

test('APEX v0.5 enforces the dedicated research ceiling', () => {
  const events = Array.from({ length: 5 }, (_value, index) => (
    researchCall(`Distinct question ${index}`, `research-${index}`)
  ))
  assert.equal(
    guardExecution(researchExecution('Distinct question 4', 'research-4', events)),
    RESEARCH_AGENT_BUDGET_REASON,
  )
})

test('APEX v0.5 keeps direct research task-scoped and permits only its dedicated route after three calls', () => {
  const direct = [
    webCall('source zero', 'web-0'),
    webCall('source one', 'web-1'),
    webCall('source two', 'web-2'),
    { type: 'compaction/end', data: {} },
    webCall('source three', 'web-3'),
  ]
  const webExecution = {
    name: 'web_search',
    callId: 'web-3',
    arguments: { query: 'source three' },
    agent: { session: { events: direct, header: {} } },
  }
  assert.equal(guardExecution(webExecution), RESEARCH_EXTENSION_REQUIRED_REASON)

  const parent = { session: { events: direct.slice(0, 3), header: {} } }
  assert.equal(
    guardExecution({ name: 'subagent', callId: 'generic', arguments: {}, agent: parent }),
    RESEARCH_DELEGATION_REASON,
  )
  assert.equal(
    guardExecution({
      name: APEX_RESEARCH_TOOL,
      callId: 'focused',
      arguments: { prompt: 'Find the remaining evidence' },
      agent: parent,
    }),
    undefined,
  )
})
