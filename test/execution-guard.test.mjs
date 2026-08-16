import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  DENIAL_REASON,
  guardExecution,
  isBroadProcessTermination,
} from '../presets/apex-v04/execution-guard.mjs'
import {
  apply as applyV041,
  BASE_WEB_SEARCH_CALLS,
  DENIAL_REASON as V041_DENIAL_REASON,
  DUPLICATE_RESEARCH_REASON,
  guardExecution as guardV041,
  MAX_DEV_TOOL_SEARCH_CALLS,
  MAX_RESEARCH_EXTENSION_CALLS,
  MAX_WEB_SEARCH_CALLS,
  RESEARCH_BUDGET_REASON,
  RESEARCH_DELEGATION_REASON,
  RESEARCH_EXTENSION_REQUIRED_REASON,
} from '../presets/apex-v041/execution-guard.mjs'

const blocked = [
  'pkill -f Chromium',
  '  pkill -f Chromium',
  'sudo -n /usr/bin/pkill node',
  'killall Google Chrome',
  '/usr/bin/killall -9 node',
  '(killall node)',
  'taskkill /IM chrome.exe /F',
  'C:\\Windows\\System32\\taskkill.exe /F /IM chrome.exe',
  'Stop-Process -Name chrome -Force',
  'Get-Process chrome | Stop-Process -Force',
  'kill $(pgrep -f chromium)',
  'pgrep node | xargs kill',
]

const allowed = [
  'kill -TERM 12345',
  'taskkill /PID 12345 /F',
  'Stop-Process -Id 12345',
  "rg 'pkill -f' README.md",
  "printf '%s\\n' killall",
]

test('execution guard detects known broad name-based termination forms', () => {
  for (const command of blocked) {
    assert.equal(isBroadProcessTermination(command), true, command)
    assert.equal(
      guardExecution({ name: 'bash', arguments: { command } }),
      DENIAL_REASON,
      command,
    )
  }
})

test('execution guard preserves exact-PID cleanup and ordinary inspection', () => {
  for (const command of allowed) {
    assert.equal(isBroadProcessTermination(command), false, command)
    assert.equal(guardExecution({ name: 'bash', arguments: { command } }), undefined, command)
  }
  assert.equal(
    guardExecution({ name: 'str_replace_editor', arguments: { command: blocked[0] } }),
    undefined,
  )
  assert.equal(guardExecution({ name: 'bash', arguments: {} }), undefined)
})

test('execution guard registers one monotonic tools guard', () => {
  let registered
  const dispose = () => {}
  apply({
    tools: {
      guard(value) {
        registered = value
        return dispose
      },
    },
  })
  assert.equal(registered, guardExecution)
  assert.equal(registered({ name: 'pwsh', arguments: { command: blocked[5] } }), DENIAL_REASON)
})

function researchCall(name, query, callId) {
  return {
    type: 'tool/call',
    data: { name, callId, arguments: JSON.stringify({ query }) },
  }
}

function researchExecution(name, query, callId, events) {
  return {
    name,
    callId,
    arguments: { query },
    agent: { session: { events, header: {} } },
  }
}

function researchLease(query) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: 'apex-dev-tool-search-v041', approvedWebQueries: [query] },
    },
  }
}

test('APEX v0.4.1 keeps broad process cleanup blocked', () => {
  assert.equal(
    guardV041({ name: 'bash', arguments: { command: 'pkill -f Chromium' } }),
    V041_DENIAL_REASON,
  )
  assert.equal(guardV041({ name: 'bash', arguments: { command: 'kill -TERM 12345' } }), undefined)
})

test('APEX v0.4.1 blocks a normalized duplicate research query', () => {
  const events = [
    researchCall('web_search', 'Official Harness repo', 'web-1'),
    researchCall('web_search', '  official   harness REPO ', 'web-2'),
  ]
  assert.equal(
    guardV041(researchExecution('web_search', '  official   harness REPO ', 'web-2', events)),
    DUPLICATE_RESEARCH_REASON,
  )
})

test('APEX v0.4.1 compares continuation queries instead of ignored catalog fields', () => {
  const first = {
    type: 'tool/call',
    data: {
      name: 'dev_tool_search',
      callId: 'extension-1',
      arguments: JSON.stringify({
        query: 'continue research',
        researchGap: 'first gap',
        nextWebQuery: 'first official source',
      }),
    },
  }
  const second = {
    query: 'continue research',
    researchGap: 'second gap',
    nextWebQuery: 'second official source',
  }
  const agent = { session: { events: [first] } }

  assert.equal(
    guardV041({ name: 'dev_tool_search', callId: 'extension-2', arguments: second, agent }),
    undefined,
  )
  assert.equal(
    guardV041({
      name: 'dev_tool_search',
      callId: 'extension-2',
      arguments: { ...second, nextWebQuery: ' FIRST  official source ' },
      agent,
    }),
    DUPLICATE_RESEARCH_REASON,
  )
})

test('APEX v0.4.1 requires a durable continuation after three default web searches', () => {
  const base = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => researchCall('web_search', `query ${index}`, `web-${index}`),
  )
  assert.equal(
    guardV041(researchExecution('web_search', 'query 3', 'web-3', [
      ...base,
      researchCall('web_search', 'query 3', 'web-3'),
    ])),
    RESEARCH_EXTENSION_REQUIRED_REASON,
  )
  assert.equal(
    guardV041(researchExecution('web_search', 'query 3', 'web-3', [
      ...base,
      researchLease('query 3'),
      researchCall('web_search', 'query 3', 'web-3'),
    ])),
    undefined,
  )
})

test('APEX v0.4.1 ignores malformed imported research leases', () => {
  const base = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => researchCall('web_search', `query ${index}`, `web-${index}`),
  )
  const events = [
    ...base,
    {
      type: 'tool/result',
      data: { meta: { kind: 'apex-dev-tool-search-v041', approvedWebQueries: {} } },
    },
    researchCall('web_search', 'query 3', 'web-3'),
  ]
  assert.equal(
    guardV041(researchExecution('web_search', 'query 3', 'web-3', events)),
    RESEARCH_EXTENSION_REQUIRED_REASON,
  )
})

test('APEX v0.4.1 preserves an absolute ten-search circuit breaker', () => {
  const events = Array.from(
    { length: MAX_WEB_SEARCH_CALLS + 1 },
    (_value, index) => researchCall('web_search', `query ${index}`, `web-${index}`),
  )
  assert.equal(
    guardV041(researchExecution(
      'web_search',
      `query ${MAX_WEB_SEARCH_CALLS}`,
      `web-${MAX_WEB_SEARCH_CALLS}`,
      events,
    )),
    RESEARCH_BUDGET_REASON,
  )
})

test('APEX v0.4.1 allows four discovery calls and blocks the fifth', () => {
  const events = Array.from(
    { length: MAX_DEV_TOOL_SEARCH_CALLS + 1 },
    (_value, index) => researchCall('dev_tool_search', `capability ${index}`, `dev-${index}`),
  )
  assert.equal(
    guardV041(researchExecution(
      'dev_tool_search',
      `capability ${MAX_DEV_TOOL_SEARCH_CALLS - 1}`,
      `dev-${MAX_DEV_TOOL_SEARCH_CALLS - 1}`,
      events.slice(0, MAX_DEV_TOOL_SEARCH_CALLS),
    )),
    undefined,
  )
  assert.equal(
    guardV041(researchExecution(
      'dev_tool_search',
      `capability ${MAX_DEV_TOOL_SEARCH_CALLS}`,
      `dev-${MAX_DEV_TOOL_SEARCH_CALLS}`,
      events,
    )),
    RESEARCH_BUDGET_REASON,
  )
})

test('APEX v0.4.1 bounds research-continuation requests separately from discovery', () => {
  const events = Array.from(
    { length: MAX_RESEARCH_EXTENSION_CALLS + 1 },
    (_value, index) => ({
      type: 'tool/call',
      data: {
        name: 'dev_tool_search',
        callId: `extension-${index}`,
        arguments: JSON.stringify({
          researchGap: `gap ${index}`,
          nextWebQuery: `next ${index}`,
        }),
      },
    }),
  )
  assert.equal(
    guardV041({
      name: 'dev_tool_search',
      callId: `extension-${MAX_RESEARCH_EXTENSION_CALLS}`,
      arguments: {
        researchGap: `gap ${MAX_RESEARCH_EXTENSION_CALLS}`,
        nextWebQuery: `next ${MAX_RESEARCH_EXTENSION_CALLS}`,
      },
      agent: { session: { events } },
    }),
    RESEARCH_BUDGET_REASON,
  )
})

test('APEX v0.4.1 closes delegation routes after the web budget is exhausted', () => {
  const events = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => researchCall('web_search', `source ${index}`, `web-${index}`),
  )
  const agent = { session: { events, header: {} } }
  assert.equal(
    guardV041({
      name: 'dev_tool_search',
      callId: 'unlock-subagent',
      arguments: { query: 'subagent', toolNames: ['subagent'] },
      agent,
    }),
    RESEARCH_DELEGATION_REASON,
  )
  assert.equal(
    guardV041({ name: 'subagent', callId: 'delegate', arguments: {}, agent }),
    RESEARCH_DELEGATION_REASON,
  )
  assert.equal(
    guardV041({ name: 'bash', callId: 'local', arguments: { command: 'ls' }, agent }),
    undefined,
  )
})

test('APEX v0.4.1 research budgets reset at human tasks and compaction', () => {
  const oldWeb = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => researchCall('web_search', `old ${index}`, `old-${index}`),
  )
  const afterTask = [
    ...oldWeb,
    { type: 'user/message', data: { source: { kind: 'user' } } },
    researchCall('web_search', 'new task', 'new-task'),
  ]
  assert.equal(
    guardV041(researchExecution('web_search', 'new task', 'new-task', afterTask)),
    undefined,
  )
  assert.equal(
    guardV041({ name: 'subagent', arguments: {}, agent: { session: { events: afterTask } } }),
    undefined,
  )

  const afterCompaction = [
    ...oldWeb,
    { type: 'compaction/end', data: {} },
    researchCall('web_search', 'after compact', 'after-compact'),
  ]
  assert.equal(
    guardV041(researchExecution('web_search', 'after compact', 'after-compact', afterCompaction)),
    undefined,
  )

  const queuedMessage = { id: 'next', role: 'user', content: [], source: { kind: 'user' } }
  const afterInboxClaim = [
    ...oldWeb,
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [queuedMessage] },
    },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    },
    researchCall('web_search', 'after claim', 'after-claim'),
  ]
  assert.equal(
    guardV041(researchExecution('web_search', 'after claim', 'after-claim', afterInboxClaim)),
    undefined,
  )

  for (const boundary of [
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'compaction/end', data: {} },
  ]) {
    const currentBase = Array.from(
      { length: BASE_WEB_SEARCH_CALLS },
      (_value, index) => researchCall('web_search', `current ${index}`, `current-${index}`),
    )
    const staleLease = [
      ...oldWeb,
      researchLease('stale approved query'),
      boundary,
      ...currentBase,
      researchCall('web_search', 'stale approved query', 'stale-current'),
    ]
    assert.equal(
      guardV041(researchExecution(
        'web_search',
        'stale approved query',
        'stale-current',
        staleLease,
      )),
      RESEARCH_EXTENSION_REQUIRED_REASON,
    )
  }
})

test('APEX v0.4.1 research guard ignores direct calls without an agent', () => {
  assert.equal(
    guardV041({ name: 'web_search', callId: 'direct', arguments: { query: 'q' } }),
    undefined,
  )
})

test('APEX v0.4.1 registers its combined monotonic guard', () => {
  let registered
  applyV041({ tools: { guard(value) { registered = value } } })
  assert.equal(registered, guardV041)
})
