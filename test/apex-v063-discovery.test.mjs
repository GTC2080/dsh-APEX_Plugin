import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply as applyDiscovery,
  UNLOCKABLE_TOOL_NAMES,
} from '../presets/apex-v063/dev-tool-search.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v063/tool-gate.mjs'

const catalog = [
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'str_replace_editor', description: 'View and edit UTF-8 text files' },
  { name: 'dev_tool_search', description: 'Discover optional tools' },
  { name: 'apex_build', description: 'Start one bounded implementation worker' },
  { name: 'apex_inspect_image', description: 'Inspect workspace screenshots or reference images with Flash Vision' },
  { name: 'apex_research', description: 'Resolve one concrete external evidence gap from primary sources' },
  { name: 'apex_state', description: 'Read or replace durable task state and invariants' },
  { name: 'apex_validate_web', description: 'Run one host browser acceptance check against a static web directory' },
  { name: 'edit', description: 'Edit an existing UTF-8 text file' },
  { name: 'glob', description: 'Find files whose paths match a glob pattern' },
  { name: 'read', description: 'Read a UTF-8 text file' },
  { name: 'read_image', description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself' },
  { name: 'web_search', description: 'Search the web for current information' },
  { name: 'write', description: 'Create or replace a UTF-8 text file' },
]

function agent(events = []) {
  return { session: { events, header: { delegationDepth: 0, cwd: '/workspace' } } }
}

function discovery(events = []) {
  let tool
  const scopedAgent = agent(events)
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
  return { agent: scopedAgent, tool }
}

function successfulCall(name, callId = `${name}-1`) {
  return [
    { type: 'tool/call', data: { name, callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'ok' }],
          }],
        },
      },
    },
  ]
}

function discoveryResult(matchedTools, unlockedTools = matchedTools) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: UNLOCK_META_KIND, matchedTools, unlockedTools },
    },
  }
}

test('a natural visual evidence gap uniquely leases the Vision facade', async () => {
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: 'inspect the reference image visually to identify its layout, text, colors, and button states',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_inspect_image'])
  assert.deepEqual(result.unlockedTools, ['apex_inspect_image'])
  assert.doesNotMatch(result.text, /Call dev_tool_search again/)
})

test('an explicit Chinese implementation delegation leases the builder in one call', async () => {
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: '编程协作者：把接口边界清晰的前端 theme.js 实现交给可用的子代理/工作者工具',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_build'])
  assert.deepEqual(result.unlockedTools, ['apex_build'])
  assert.doesNotMatch(result.text, /Call dev_tool_search again/)
})

test('an English programming collaborator gap leases the builder in one call', async () => {
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: 'programming collaborator that can implement a small, boundary-clear JavaScript file given an explicit interface contract',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_build'])
  assert.deepEqual(result.unlockedTools, ['apex_build'])
  assert.doesNotMatch(result.text, /Call dev_tool_search again/)
})

test('English research wording about implementation does not unlock the builder', async () => {
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: 'research API documentation about how to implement a programming collaborator',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_research'])
  assert.deepEqual(result.unlockedTools, ['apex_research'])
})

test('Chinese research wording about collaborators does not unlock the builder', async () => {
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: '查找编程协作者 API 文档作为研究资料',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_research'])
  assert.deepEqual(result.unlockedTools, ['apex_research'])
})

test('the text-only Pro parent redirects the raw image name to the Vision facade', async () => {
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('read_image'), false)
  const { agent: scopedAgent, tool } = discovery()
  const result = await tool.execute({
    query: 'read_image',
    toolNames: ['read_image'],
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_inspect_image'])
  assert.deepEqual(result.unlockedTools, ['apex_inspect_image'])
  assert.match(result.text, /Not permitted by the APEX allowlist: read_image/)
})

test('an already exposed capability is idempotent for exact and equivalent searches', async () => {
  const events = [discoveryResult(['apex_build'])]
  const { agent: scopedAgent, tool } = discovery(events)
  const equivalent = await tool.execute({
    query: 'delegate one bounded implementation worker',
  }, { agent: scopedAgent })
  const exact = await tool.execute({
    toolNames: ['apex_build'],
  }, { agent: scopedAgent })

  for (const result of [equivalent, exact]) {
    assert.deepEqual(result.unlockedTools, [])
    assert.match(result.text, /Already available in this task: apex_build/)
    assert.doesNotMatch(result.text, /Unlocked for the next request/)
    assert.doesNotMatch(result.text, /Call dev_tool_search again/)
  }
})

test('an earlier unlock does not block discovery of a different capability', async () => {
  const { agent: scopedAgent, tool } = discovery([discoveryResult(['apex_build'])])
  const result = await tool.execute({
    query: 'inspect a browser screenshot for one visual evidence gap',
  }, { agent: scopedAgent })

  assert.deepEqual(result.matchedTools, ['apex_inspect_image'])
  assert.deepEqual(result.unlockedTools, ['apex_inspect_image'])
})

test('a successful unlock hides discovery for one request, then restores it', async () => {
  const events = [
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    discoveryResult(['apex_build']),
  ]
  const scopedAgent = agent(events)
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  const assemble = () => listener(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )

  const immediate = await assemble()
  assert.equal(immediate.tools.some(tool => tool.name === 'apex_build'), true)
  assert.equal(immediate.tools.some(tool => tool.name === 'dev_tool_search'), false)

  scopedAgent.session.events.push(...successfulCall(BOOTSTRAP_TOOLS[0], 'bash-2'))
  const later = await assemble()
  assert.equal(later.tools.some(tool => tool.name === 'apex_build'), true)
  assert.equal(later.tools.some(tool => tool.name === 'dev_tool_search'), true)
})

test('old parent leases cannot re-expose raw image input after promotion', async () => {
  const scopedAgent = agent([
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    discoveryResult(['read_image']),
  ])
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })

  const assembled = await listener(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
  assert.equal(assembled.tools.some(tool => tool.name === 'read_image'), false)
})
