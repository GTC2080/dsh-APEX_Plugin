import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_CHILD_POLICY,
  APEX_POLICY,
  apply as applyPolicy,
  CHILD_BUDGET_REASON,
  CHILD_HARD_STEP_LIMIT,
  CHILD_SOFT_STEP_LIMIT,
  CHILD_WALL_TIME_MS,
  enforceFlashMax,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  installChildWallBudget,
  isManagedFlashChild,
} from '../presets/apex-v06/apex-policy.mjs'
import { apply as applyDiscovery } from '../presets/apex-v06/dev-tool-search.mjs'
import {
  guardExecution,
  isUnboundedBrowserCommand,
  UNBOUNDED_BROWSER_REASON,
} from '../presets/apex-v06/execution-guard.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  RESIDENT_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v06/tool-gate.mjs'

const catalog = [
  { name: 'apex_build', description: 'Bounded Flash Max code implementation' },
  { name: 'apex_state', description: 'Durable task state' },
  { name: 'bash', description: 'Run shell commands' },
  { name: 'dev_tool_search', description: 'Discover tools' },
  { name: 'str_replace_editor', description: 'Edit files' },
]

function agent(events = [], delegationDepth = 0, options = {}) {
  return { options, session: { events, header: { delegationDepth } } }
}

function managedChild(events = []) {
  return agent(events, 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
}

function unlockResult(matchedTools, unlockedTools = []) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: UNLOCK_META_KIND,
        matchedTools,
        unlockedTools,
        approvedWebQueries: [],
      },
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

async function assemble(events = []) {
  return gateListener()(undefined, { agent: agent(events) }, async () => ({
    sections: [{ name: 'persona', text: 'minimal' }],
    contexts: [],
    variables: {},
    tools: catalog,
  }))
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
  assert.notEqual(tool, undefined)
  return { agent: scopedAgent, tool }
}

test('APEX v0.6 preserves the exact Minimal first-request tool pair', async () => {
  const first = await assemble()
  assert.deepEqual(first.sections, [{ name: 'persona', text: 'minimal' }])
  assert.deepEqual(first.contexts, [])
  assert.deepEqual(first.tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])
  assert.deepEqual(
    (await assemble([{ type: 'assistant/message', data: {} }])).tools
      .map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
})

test('APEX v0.6 makes the builder discoverable and unlocks it only after search', async () => {
  const first = discovery()
  const found = await first.tool.execute({ query: 'code implementation' }, { agent: first.agent })
  assert.deepEqual(found.matchedTools, ['apex_build'])
  assert.deepEqual(found.unlockedTools, [])

  const searched = discovery([unlockResult(['apex_build'])])
  const unlocked = await searched.tool.execute(
    { toolNames: ['apex_build'] },
    { agent: searched.agent },
  )
  assert.deepEqual(unlocked.unlockedTools, ['apex_build'])

  const promoted = await assemble([
    { type: 'assistant/message', data: {} },
    unlockResult(['apex_build'], ['apex_build']),
  ])
  assert.equal(promoted.tools.some((tool) => tool.name === 'apex_build'), true)
})

test('APEX v0.6 gives the parent explicit brief and independent-review duties', () => {
  assert.match(APEX_POLICY, /self-contained implementation brief/)
  assert.match(APEX_POLICY, /independently inspect the actual diff/)
  assert.match(APEX_POLICY, /Never accept the child summary as proof/)
  assert.match(APEX_POLICY, /distinct verified defect/)
  assert.doesNotMatch(APEX_POLICY, /keyword|classifier|automatic loop/i)
  assert.match(APEX_CHILD_POLICY, /dedicated persona and tool boundary/)
  assert.match(APEX_CHILD_POLICY, /Converge early/)
  assert.doesNotMatch(APEX_CHILD_POLICY, /primary sources|web_search/)
  assert.equal(CHILD_SOFT_STEP_LIMIT < CHILD_HARD_STEP_LIMIT, true)
  assert.equal(CHILD_WALL_TIME_MS, 20 * 60 * 1000)
})

test('APEX v0.6 forces only delegated official Flash requests to Max', () => {
  const rootConfig = {
    provider: FLASH_MAX_PROVIDER,
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }
  assert.equal(enforceFlashMax(agent([], 0), rootConfig), rootConfig)

  const flashConfig = {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
    reasoningEffort: 'high',
    temperature: 0.2,
  }
  assert.deepEqual(enforceFlashMax(agent([], 1), flashConfig), {
    ...flashConfig,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })

  const otherProvider = { ...flashConfig, provider: 'custom-provider' }
  assert.equal(enforceFlashMax(agent([], 1), otherProvider), otherProvider)
})

test('APEX v0.6 installs the Flash Max request hook through the policy plugin', async () => {
  const listeners = new Map()
  applyPolicy({
    tools: { register() { return () => {} } },
    effect(register) {
      register()
      return () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  })
  const listener = listeners.get('agent/request')
  assert.equal(typeof listener, 'function')
  const request = await listener(
    { agent: agent([], 1) },
    async () => ({ provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL }),
  )
  assert.equal(request.reasoningEffort, FLASH_MAX_REASONING_EFFORT)
})

test('APEX v0.6 warns a managed child before the hard step boundary', async () => {
  const listeners = new Map()
  applyPolicy({
    tools: { register() { return () => {} } },
    effect(register) {
      register()
      return () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  })
  const child = managedChild()
  assert.equal(isManagedFlashChild(child), true)
  assert.equal(isManagedFlashChild(agent([], 0, child.options)), false)

  const decision = await listeners.get('agent/pre-step')(
    {
      agent: child,
      step: CHILD_SOFT_STEP_LIMIT,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.some((message) => (
    message.content?.some((block) => /budget checkpoint/i.test(block.text))
  )), true)
})

test('APEX v0.6 cancels a managed child beyond the hard step boundary', async () => {
  const listeners = new Map()
  applyPolicy({
    tools: { register() { return () => {} } },
    effect(register) {
      register()
      return () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  })
  const controller = new AbortController()
  const child = managedChild()
  let cause
  child.cancel = (value) => {
    cause = value
    controller.abort(value)
  }

  let rejection
  try {
    await listeners.get('agent/pre-step')(
      { agent: child, step: CHILD_HARD_STEP_LIMIT + 1, signal: controller.signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
  } catch (error) {
    rejection = error
  }
  assert.deepEqual(cause, { kind: 'hook', reason: CHILD_BUDGET_REASON })
  assert.equal(rejection, cause)
})

test('APEX v0.6 wall budget cancels only the exact managed child', async () => {
  let statusListener
  let dispose
  let rootCancelled = false
  const cancelled = new Promise((resolve) => {
    const child = managedChild()
    child.status = 'running'
    child.cancel = resolve
    dispose = installChildWallBudget({
      on(event, listener) {
        assert.equal(event, 'agent/status')
        statusListener = listener
        return () => {}
      },
    }, 5)
    const root = agent([], 0, child.options)
    root.status = 'running'
    root.cancel = () => { rootCancelled = true }
    statusListener({ agent: root, status: 'running' })
    statusListener({ agent: child, status: 'running' })
  })
  try {
    assert.deepEqual(await cancelled, { kind: 'hook', reason: CHILD_BUDGET_REASON })
    assert.equal(rootCancelled, false)
  } finally {
    dispose()
  }
})

test('APEX v0.6 clears a child wall timer when the child becomes idle', async () => {
  let statusListener
  let cancelled = false
  const child = managedChild()
  child.status = 'running'
  child.cancel = () => { cancelled = true }
  const dispose = installChildWallBudget({
    on(_event, listener) {
      statusListener = listener
      return () => {}
    },
  }, 5)
  try {
    statusListener({ agent: child, status: 'running' })
    child.status = 'idle'
    statusListener({ agent: child, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(cancelled, false)
  } finally {
    dispose()
  }
})

test('APEX v0.6 blocks unbounded headless browser validation but permits exact deadlines', () => {
  const unbounded = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/pool.png http://127.0.0.1:5173'
  assert.equal(isUnboundedBrowserCommand(unbounded), true)
  assert.equal(
    guardExecution({ name: 'bash', arguments: { command: unbounded } }),
    UNBOUNDED_BROWSER_REASON,
  )

  const bounded = `${unbounded} & apex_browser_pid=$!\n(sleep 45; kill -TERM "$apex_browser_pid" 2>/dev/null) &\nwait "$apex_browser_pid"`
  assert.equal(isUnboundedBrowserCommand(bounded), false)
  assert.equal(guardExecution({ name: 'bash', arguments: { command: bounded } }), undefined)
  assert.equal(
    isUnboundedBrowserCommand(`timeout 45s chromium --headless --dump-dom https://example.com`),
    false,
  )
  assert.equal(isUnboundedBrowserCommand('npm run build'), false)
})
