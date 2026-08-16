import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  BOOTSTRAP_TOOLS,
  phaseFor,
  RESIDENT_TOOLS,
} from '../presets/v2/tool-gate.mjs'

const tools = [
  { name: 'ask_user_question' },
  { name: 'bash' },
  { name: 'dev_tool_search' },
  { name: 'skill' },
  { name: 'str_replace_editor' },
  { name: 'web_search' },
]

function agent(events = [], header = {}, id = 'session') {
  return { session: { id, events, header } }
}

function register() {
  const listeners = {}
  const options = {}
  apply({
    on(event, listener, hookOptions) {
      listeners[event] = listener
      options[event] = hookOptions
      return () => {}
    },
  })
  return { listeners, options }
}

async function assemble(listener, events = [], header = {}, catalog = tools) {
  const original = {
    sections: [{ name: 'persona', text: 'minimal' }],
    contexts: [],
    tools: catalog,
  }
  return listener(undefined, { agent: agent(events, header) }, async () => original)
}

function names(assembly) {
  return assembly.tools.map((tool) => tool.name)
}

test('first top-level request exposes exactly the Minimal pair', async () => {
  const { listeners, options } = register()
  const result = await assemble(listeners['system-prompt/assemble'])
  assert.deepEqual(names(result), [...BOOTSTRAP_TOOLS])
  assert.deepEqual(options['system-prompt/assemble'], { prepend: true })
})

test('a durable text-only reply promotes to the resident catalog', async () => {
  const { listeners } = register()
  const result = await assemble(listeners['system-prompt/assemble'], [
    { type: 'assistant/message', data: {} },
  ])
  assert.deepEqual(names(result).sort(), [...RESIDENT_TOOLS].sort())
})

test('dev_tool_search arguments unlock available tools from the next request', async () => {
  const { listeners } = register()
  const events = [
    { type: 'assistant/message', data: {} },
    {
      type: 'tool/call',
      data: {
        name: 'dev_tool_search',
        arguments: JSON.stringify({ toolNames: ['web_search', 'skill', 'missing'] }),
      },
    },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], events)
  assert.deepEqual(names(result).sort(), [...RESIDENT_TOOLS, 'skill', 'web_search'].sort())
})

test('malformed unlock arguments are ignored', () => {
  const state = phaseFor(agent([
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{bad' } },
  ]))
  assert.equal(state.promoted, true)
  assert.deepEqual([...state.unlocked], [])
})

test('durable unlock reconstruction bounds names even for imported session logs', () => {
  const requested = Array.from({ length: 25 }, (_value, index) => `tool_${index}`)
  requested[0] = 'x'.repeat(129)
  const state = phaseFor(agent([
    {
      type: 'tool/call',
      data: {
        name: 'dev_tool_search',
        arguments: JSON.stringify({ toolNames: requested }),
      },
    },
  ]))
  assert.equal(state.unlocked.has(requested[0]), false)
  assert.equal(state.unlocked.has('tool_20'), false)
  assert.equal(state.unlocked.size, 19)
})

test('compaction starts a new controlled epoch and clears earlier unlocks', async () => {
  const { listeners } = register()
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
    { type: 'compaction/end', data: {} },
  ]
  const controlled = await assemble(listeners['system-prompt/assemble'], events)
  assert.deepEqual(names(controlled), [...BOOTSTRAP_TOOLS])

  const rePromoted = await assemble(listeners['system-prompt/assemble'], [
    ...events,
    { type: 'assistant/message', data: {} },
  ])
  assert.deepEqual(names(rePromoted).sort(), [...RESIDENT_TOOLS].sort())
})

test('the durable log reconstructs the same promoted state after resume', () => {
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
  ]
  assert.deepEqual([...phaseFor(agent(events)).unlocked], ['web_search'])
  assert.deepEqual([...phaseFor(agent(structuredClone(events))).unlocked], ['web_search'])
})

test('subagents keep the complete catalog so reporting and delegation cannot be hidden', async () => {
  const { listeners } = register()
  const result = await assemble(
    listeners['system-prompt/assemble'],
    [],
    { delegationDepth: 1 },
  )
  assert.deepEqual(result.tools, tools)
})

test('automatic context is absent during bootstrap and skill catalog waits for unlock', async () => {
  const { listeners, options } = register()
  const messages = [
    { id: 'user', source: { kind: 'user' } },
    { id: 'instructions', source: { kind: 'agent-instructions' } },
    { id: 'skills', source: { kind: 'skill-catalog' } },
    { id: 'gesture', source: { kind: 'skill-invocation' } },
  ]
  const preStep = listeners['agent/pre-step']
  const first = await preStep({ agent: agent([]) }, async () => ({ kind: 'enter', messages }))
  assert.deepEqual(first.messages.map((message) => message.id), ['user', 'gesture'])

  const promoted = await preStep(
    { agent: agent([{ type: 'assistant/message', data: {} }]) },
    async () => ({ kind: 'enter', messages }),
  )
  assert.deepEqual(promoted.messages.map((message) => message.id), ['user', 'instructions', 'gesture'])

  const unlocked = await preStep(
    {
      agent: agent([
        { type: 'assistant/message', data: {} },
        { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["skill"]}' } },
      ]),
    },
    async () => ({ kind: 'enter', messages }),
  )
  assert.deepEqual(unlocked.messages, messages)
  assert.deepEqual(options['agent/pre-step'], { prepend: true })
})

test('missing required bootstrap tools fails loudly', async () => {
  const { listeners } = register()
  await assert.rejects(
    assemble(listeners['system-prompt/assemble'], [], {}, [{ name: 'bash' }]),
    /missing required Minimal tool\(s\): str_replace_editor/,
  )
})
