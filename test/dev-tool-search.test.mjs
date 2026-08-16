import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../presets/v2/dev-tool-search.mjs'
import {
  apply as applyApexV041,
  UNLOCKABLE_TOOL_NAMES,
} from '../presets/apex-v041/dev-tool-search.mjs'
import {
  apply as applyApexV05,
  UNLOCKABLE_TOOL_NAMES as V05_UNLOCKABLE_TOOL_NAMES,
} from '../presets/apex-v05/dev-tool-search.mjs'
import { BASE_WEB_SEARCH_CALLS } from '../presets/apex-v041/execution-guard.mjs'
import { UNLOCK_META_KIND } from '../presets/apex-v041/tool-gate.mjs'
import { UNLOCK_META_KIND as V05_UNLOCK_META_KIND } from '../presets/apex-v05/tool-gate.mjs'

function registeredTool() {
  let definition
  const schemas = [
    { name: 'bash', description: 'Run a shell command' },
    { name: 'dev_tool_search', description: 'Discover tools' },
    { name: 'subagent', description: 'Delegate work to a child agent' },
    { name: 'web_search', description: 'Search the internet\nMore details' },
  ]
  apply({
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
      schemas(scope) {
        assert.equal(scope.id, 'agent')
        return schemas
      },
    },
  })
  assert.notEqual(definition, undefined)
  return definition
}

test('declares a bounded array schema for exact unlock names', () => {
  const tool = registeredTool()
  assert.equal(tool.name, 'dev_tool_search')
  assert.equal(tool.parameters.properties.query.maxLength, 200)
  assert.equal(tool.parameters.properties.toolNames.maxItems, 20)
  assert.deepEqual(tool.parameters.properties.toolNames.items, {
    type: 'string',
    minLength: 1,
    maxLength: 128,
  })
  assert.deepEqual(tool.output.schema, { type: 'string' })
})

test('searches the full scoped catalog without exposing every schema up front', async () => {
  const tool = registeredTool()
  const result = await tool.execute({ query: 'internet' }, { agent: { id: 'agent' } })
  assert.match(result, /web_search: Search the internet/)
  assert.doesNotMatch(result, /subagent:/)
})

test('reports accepted and unavailable unlock names deterministically', async () => {
  const tool = registeredTool()
  const result = await tool.execute(
    { toolNames: ['web_search', 'missing', 'web_search'] },
    { agent: { id: 'agent' } },
  )
  assert.match(result, /Unlocked for the next request: web_search/)
  assert.match(result, /Unknown or unavailable tool names: missing/)
})

test('empty input returns actionable guidance', async () => {
  const tool = registeredTool()
  assert.equal(
    await tool.execute({}, { agent: { id: 'agent' } }),
    'Provide query to search or toolNames to unlock tools.',
  )
})

function apexAgent(events = []) {
  return { id: 'apex-agent', session: { events, header: {} } }
}

function registeredApexTool(events = []) {
  let definition
  const agent = apexAgent(events)
  const schemas = [
    { name: 'bash', description: 'Run a shell command' },
    { name: 'skill', description: 'Load a workflow skill' },
    { name: 'web_search', description: 'Search the internet for current information' },
    { name: 'rogue_tool', description: 'Untrusted external capability' },
  ]
  applyApexV041({
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
      schemas(scope) {
        assert.equal(scope, agent)
        return schemas
      },
    },
  })
  assert.notEqual(definition, undefined)
  return { agent, tool: definition }
}

function discoveryMeta(matchedTools, unlockedTools = [], approvedWebQueries = []) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: UNLOCK_META_KIND, matchedTools, unlockedTools, approvedWebQueries },
    },
  }
}

function webCall(query, callId = query) {
  return {
    type: 'tool/call',
    data: { name: 'web_search', callId, arguments: JSON.stringify({ query }) },
  }
}

test('APEX v0.4.1 exposes one-tool leases with durable result metadata', () => {
  const { tool } = registeredApexTool()
  assert.equal(tool.parameters.properties.toolNames.maxItems, 1)
  assert.equal(tool.parameters.properties.researchGap.maxLength, 240)
  assert.equal(tool.parameters.properties.nextWebQuery.maxLength, 200)
  assert.deepEqual(
    tool.output.schema.required,
    ['text', 'matchedTools', 'unlockedTools', 'approvedWebQueries'],
  )
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('web_search'), true)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('rogue_tool'), false)
})

test('APEX v0.4.1 ranks a verbose natural query without requiring every token', async () => {
  const { agent, tool } = registeredApexTool()
  const value = await tool.execute(
    { query: 'web search official GitHub repository research' },
    { agent },
  )
  assert.deepEqual(value.matchedTools, ['web_search'])
  assert.match(value.text, /web_search: Search the internet/)
  assert.deepEqual(tool.output.presentationMeta({}, value), {
    kind: UNLOCK_META_KIND,
    matchedTools: ['web_search'],
    unlockedTools: [],
    approvedWebQueries: [],
  })
})

test('APEX v0.4.1 grants one durable continuation for a concrete evidence gap', async () => {
  const baseEvents = Array.from(
    { length: BASE_WEB_SEARCH_CALLS },
    (_value, index) => webCall(`source ${index}`, `web-${index}`),
  )
  const beforeBase = registeredApexTool(baseEvents.slice(0, -1))
  const early = await beforeBase.tool.execute(
    { researchGap: 'canonical repository URL', nextWebQuery: 'official clone URL' },
    { agent: beforeBase.agent },
  )
  assert.deepEqual(early.approvedWebQueries, [])
  assert.match(early.text, /default web_search calls/)

  const ready = registeredApexTool(baseEvents)
  const approved = await ready.tool.execute(
    { researchGap: 'canonical repository URL', nextWebQuery: 'official clone URL' },
    { agent: ready.agent },
  )
  assert.deepEqual(approved.approvedWebQueries, ['official clone URL'])
  assert.match(approved.text, /Approved one additional web_search query/)
  assert.deepEqual(ready.tool.output.presentationMeta({}, approved), {
    kind: UNLOCK_META_KIND,
    matchedTools: [],
    unlockedTools: [],
    approvedWebQueries: ['official clone URL'],
  })

  const outstanding = registeredApexTool([
    ...baseEvents,
    discoveryMeta([], [], ['official clone URL']),
  ])
  const second = await outstanding.tool.execute(
    { researchGap: 'page title', nextWebQuery: 'official GitHub page title' },
    { agent: outstanding.agent },
  )
  assert.deepEqual(second.approvedWebQueries, [])
  assert.match(second.text, /previously approved web_search query/)
})

test('APEX v0.4.1 requires a prior durable discovery before unlock', async () => {
  const first = registeredApexTool()
  const denied = await first.tool.execute({ toolNames: ['web_search'] }, { agent: first.agent })
  assert.deepEqual(denied.unlockedTools, [])
  assert.match(denied.text, /Search before unlocking/)

  const discovered = registeredApexTool([discoveryMeta(['web_search'])])
  const accepted = await discovered.tool.execute(
    { toolNames: ['web_search'] },
    { agent: discovered.agent },
  )
  assert.deepEqual(accepted.unlockedTools, ['web_search'])
  assert.match(accepted.text, /Unlocked for the next request: web_search/)
})

test('APEX v0.4.1 never discovers or unlocks tools outside its Standard allowlist', async () => {
  const { agent, tool } = registeredApexTool([discoveryMeta(['rogue_tool'])])
  const search = await tool.execute({ query: 'untrusted external' }, { agent })
  assert.deepEqual(search.matchedTools, [])

  const unlock = await tool.execute({ toolNames: ['rogue_tool'] }, { agent })
  assert.deepEqual(unlock.unlockedTools, [])
  assert.match(unlock.text, /Not permitted by the APEX allowlist/)
})

test('APEX v0.4.1 ignores malformed imported discovery metadata', async () => {
  const malformed = registeredApexTool([{
    type: 'tool/result',
    data: { meta: { kind: UNLOCK_META_KIND, matchedTools: {} } },
  }])
  const value = await malformed.tool.execute(
    { toolNames: ['web_search'] },
    { agent: malformed.agent },
  )
  assert.deepEqual(value.unlockedTools, [])
  assert.match(value.text, /Search before unlocking/)
})

function registeredV05Tool(events = []) {
  let definition
  const agent = apexAgent(events)
  const schemas = [
    { name: 'apex_research', description: 'Delegate focused web research to V4 Flash' },
    { name: 'bash', description: 'Run a shell command' },
    { name: 'web_search', description: 'Search the internet for current information' },
  ]
  applyApexV05({
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
      schemas(scope) {
        assert.equal(scope, agent)
        return schemas
      },
    },
  })
  assert.notEqual(definition, undefined)
  return { agent, tool: definition }
}

test('APEX v0.5 discovers and leases only its dedicated research tool', async () => {
  assert.equal(V05_UNLOCKABLE_TOOL_NAMES.includes('apex_research'), true)
  const first = registeredV05Tool()
  const found = await first.tool.execute({ query: 'focused Flash research' }, { agent: first.agent })
  assert.deepEqual(found.matchedTools, ['apex_research'])

  const discovered = registeredV05Tool([{
    type: 'tool/result',
    data: {
      meta: {
        kind: V05_UNLOCK_META_KIND,
        matchedTools: ['apex_research'],
        unlockedTools: [],
        approvedWebQueries: [],
      },
    },
  }])
  const leased = await discovered.tool.execute(
    { toolNames: ['apex_research'] },
    { agent: discovered.agent },
  )
  assert.deepEqual(leased.unlockedTools, ['apex_research'])
})
