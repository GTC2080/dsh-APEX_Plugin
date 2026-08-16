import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../presets/v2/dev-tool-search.mjs'

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
