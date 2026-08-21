import assert from 'node:assert/strict'
import test from 'node:test'

import { APEX_POLICY as V05_POLICY } from '../presets/apex-v05/apex-policy.mjs'
import {
  APEX_POLICY,
  LEDGER_META_KIND,
  latestLedger,
} from '../presets/apex-v051/apex-policy.mjs'
import { apply as applyDiscovery } from '../presets/apex-v051/dev-tool-search.mjs'
import {
  APEX_RESEARCH_TOOL,
  BASE_WEB_SEARCH_CALLS,
  DENIAL_REASON,
  DUPLICATE_RESEARCH_AGENT_REASON,
  DUPLICATE_RESEARCH_REASON,
  guardExecution,
  RESEARCH_AGENT_REVIEW_REASON,
  RESEARCH_EXTENSION_REQUIRED_REASON,
} from '../presets/apex-v051/execution-guard.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  RESIDENT_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v051/tool-gate.mjs'

const catalog = [
  { name: 'apex_research', description: 'Focused V4 Flash web research' },
  { name: 'apex_state', description: 'Durable task state' },
  { name: 'bash', description: 'Run shell commands' },
  { name: 'dev_tool_search', description: 'Discover tools' },
  { name: 'str_replace_editor', description: 'Edit files' },
  { name: 'subagent', description: 'Delegate a bounded task' },
  { name: 'web_search', description: 'Search the internet' },
]

function agent(events = [], header = {}) {
  return { session: { events, header } }
}

function webCall(query, callId = query) {
  return {
    type: 'tool/call',
    data: { name: 'web_search', callId, arguments: JSON.stringify({ query }) },
  }
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

function ledgerResult(index = 0) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: LEDGER_META_KIND,
        updated: true,
        stalled: false,
        ledger: {
          goal: 'Resolve the research task',
          verified: [`Reviewed research round ${index}`],
          open: [`Evidence gap ${index + 1}`],
          next: `Research evidence gap ${index + 1}`,
          evidence: [`Research packet ${index} was reviewed`],
        },
      },
    },
  }
}

function researchLease(query) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: UNLOCK_META_KIND,
        matchedTools: [],
        unlockedTools: [],
        approvedWebQueries: [query],
      },
    },
  }
}

function execution(name, argumentsValue, callId, events) {
  return {
    name,
    callId,
    arguments: argumentsValue,
    agent: { session: { events, header: {} } },
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

async function assemble(events = []) {
  return gateListener()(undefined, { agent: agent(events) }, async () => ({
    sections: [{ name: 'persona', text: 'minimal' }],
    contexts: [],
    variables: {},
    tools: catalog,
  }))
}

function registeredDiscovery(events = []) {
  let tool
  const scopedAgent = { id: 'apex-v051', session: { events, header: {} } }
  applyDiscovery({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
      schemas(value) {
        assert.equal(value, scopedAgent)
        return catalog
      },
    },
  })
  assert.notEqual(tool, undefined)
  return { agent: scopedAgent, tool }
}

test('APEX v0.5.1 preserves the Minimal first request and its two-tool resident upgrade', async () => {
  assert.deepEqual((await assemble()).tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
  assert.deepEqual(
    (await assemble([{ type: 'assistant/message', data: {} }])).tools
      .map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
})

test('APEX v0.5.1 policy is thin and contains no fixed research ceiling', () => {
  assert.equal(APEX_POLICY.length < V05_POLICY.length / 2, true)
  assert.doesNotMatch(APEX_POLICY, /up to ten|four research rounds|Default to one/i)
  assert.match(APEX_POLICY, /distinct unresolved gap/)
})

test('APEX v0.5.1 renews direct research one distinct query at a time beyond v0.5 limits', () => {
  const events = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => webCall(`base query ${index}`, `web-${index}`),
  )

  for (let index = BASE_WEB_SEARCH_CALLS; index < 18; index += 1) {
    const query = `renewed query ${index}`
    events.push(researchLease(query), webCall(query, `web-${index}`))
    assert.equal(
      guardExecution(execution('web_search', { query }, `web-${index}`, events)),
      undefined,
      query,
    )
  }

  assert.equal(
    guardExecution(execution('web_search', { query: 'unleased query' }, 'unleased', [
      ...events,
      webCall('unleased query', 'unleased'),
    ])),
    RESEARCH_EXTENSION_REQUIRED_REASON,
  )
  assert.equal(
    guardExecution(execution('web_search', { query: ' renewed   query 17 ' }, 'duplicate', events)),
    DUPLICATE_RESEARCH_REASON,
  )
})

test('APEX v0.5.1 issues another lease only after the previous lease is used', async () => {
  const base = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => webCall(`source ${index}`, `base-${index}`),
  )
  const firstRuntime = registeredDiscovery(base)
  const first = await firstRuntime.tool.execute(
    { researchGap: 'Need the canonical contract', nextWebQuery: 'official contract source' },
    { agent: firstRuntime.agent },
  )
  assert.deepEqual(first.approvedWebQueries, ['official contract source'])

  const outstandingRuntime = registeredDiscovery([...base, researchLease('official contract source')])
  const blocked = await outstandingRuntime.tool.execute(
    { researchGap: 'Need the current limit', nextWebQuery: 'official limit source' },
    { agent: outstandingRuntime.agent },
  )
  assert.deepEqual(blocked.approvedWebQueries, [])
  assert.match(blocked.text, /previously approved web_search query/)

  const usedRuntime = registeredDiscovery([
    ...base,
    researchLease('official contract source'),
    webCall('official contract source', 'leased-1'),
  ])
  const renewed = await usedRuntime.tool.execute(
    { researchGap: 'Need the current limit', nextWebQuery: 'official limit source' },
    { agent: usedRuntime.agent },
  )
  assert.deepEqual(renewed.approvedWebQueries, ['official limit source'])
})

test('APEX v0.5.1 leaves ordinary delegation available after initial web research', () => {
  const events = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => webCall(`source ${index}`, `web-${index}`),
  )
  assert.equal(
    guardExecution(execution('subagent', { prompt: 'Implement the isolated module' }, 'child', events)),
    undefined,
  )
  assert.equal(
    guardExecution(execution(
      'dev_tool_search',
      { query: 'subagent', toolNames: ['subagent'] },
      'discover-child',
      events,
    )),
    undefined,
  )
})

test('APEX v0.5.1 permits renewable Flash rounds only after parent review', () => {
  const events = []
  for (let index = 0; index < 8; index += 1) {
    if (index > 0) events.push(ledgerResult(index - 1))
    const call = researchCall(`Distinct evidence brief ${index}`, `research-${index}`)
    events.push(call)
    assert.equal(
      guardExecution(execution(
        APEX_RESEARCH_TOOL,
        { prompt: `Distinct evidence brief ${index}` },
        `research-${index}`,
        events,
      )),
      undefined,
      `round ${index + 1}`,
    )
  }

  const noReview = [
    researchCall('First brief', 'first'),
    researchCall('Second brief', 'second'),
  ]
  assert.equal(
    guardExecution(execution(APEX_RESEARCH_TOOL, { prompt: 'Second brief' }, 'second', noReview)),
    RESEARCH_AGENT_REVIEW_REASON,
  )
  assert.equal(
    guardExecution(execution(
      APEX_RESEARCH_TOOL,
      { prompt: 'Distinct evidence brief 0' },
      'duplicate',
      events,
    )),
    DUPLICATE_RESEARCH_AGENT_REASON,
  )
})

test('APEX v0.5.1 preserves state across compaction, resets it by human task, and keeps PID safety', () => {
  const state = ledgerResult(0)
  const compacted = agent([state, { type: 'compaction/end', data: {} }])
  assert.notEqual(latestLedger(compacted), undefined)
  assert.equal(
    latestLedger(agent([
      state,
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ])),
    undefined,
  )
  assert.equal(
    guardExecution({ name: 'bash', arguments: { command: 'pkill -f Chromium' } }),
    DENIAL_REASON,
  )
  assert.equal(
    guardExecution({ name: 'bash', arguments: { command: 'kill -TERM 12345' } }),
    undefined,
  )
})
