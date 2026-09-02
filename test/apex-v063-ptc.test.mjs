import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_BUILD_DESCRIPTION,
  APEX_PRESET_ID,
  apply as applyBuild,
  FLASH_PRODUCTION_WORKER_TOOLS,
  installCodeWorkerPtc,
  PRO_CORE_WORKER_TOOLS,
} from '../presets/apex-v063/apex-build.mjs'
import {
  APEX_CODE_CHILD_LABEL_PREFIX,
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  PTC_TRANSPORT_TOOL,
  PRO_MAX_MODEL,
  PRO_MAX_PROVIDER,
  PRO_MAX_REASONING_EFFORT,
} from '../presets/apex-v063/tool-gate.mjs'

function descriptor(label, mode = 'continuable') {
  return {
    type: 'subagent/descriptor',
    data: { version: 3, provider: 'spawn', mode, label },
  }
}

function flashChild(label, overrides = {}) {
  return {
    session: {
      header: {
        delegationDepth: 1,
        cwd: '/workspace',
        agentPreset: APEX_PRESET_ID,
        ...overrides.header,
      },
      events: [descriptor(label, overrides.mode)],
    },
    options: {
      provider: FLASH_MAX_PROVIDER,
      model: FLASH_MAX_MODEL,
      ...overrides.options,
    },
  }
}

function proChild(label, overrides = {}) {
  return flashChild(label, {
    ...overrides,
    options: {
      provider: PRO_MAX_PROVIDER,
      model: PRO_MAX_MODEL,
      ...overrides.options,
    },
  })
}

function buildArguments(role = 'flash-production') {
  return {
    role,
    description: 'renderer',
    id: 'renderer',
    paths: ['src/renderer.js'],
    goal: 'Implement the leased renderer module.',
    context: 'The parent owns integration and supplied the public interface.',
    read_only_inputs: [],
    interfaces: [{ id: 'renderer-api', contract: 'Export renderScene(scene).' }],
    invariants: [{ id: 'camera-state', statement: 'Do not mutate the parent camera.' }],
    non_goals: ['Do not change HTML or validation code.'],
    acceptance: [{ id: 'renderer-export', assertion: 'The renderer exports renderScene.' }],
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

async function assemble(agent, toolNames) {
  return gateListener()(
    undefined,
    { agent },
    async () => ({
      sections: [],
      contexts: [],
      variables: {},
      tools: toolNames.map(name => ({ name, description: name })),
    }),
  )
}

test('new APEX code workers opt into official PTC only in their scoped child context', () => {
  const calls = []
  const dispose = () => {}
  const managed = flashChild(`${APEX_CODE_CHILD_LABEL_PREFIX} [flash-production]: renderer`)
  assert.equal(installCodeWorkerPtc({
    agent: managed,
    tools: {
      presentAs(mode) {
        calls.push(mode)
        return dispose
      },
    },
  }), dispose)
  assert.deepEqual(calls, ['ptc'])

  for (const child of [
    flashChild('renderer'),
    flashChild(`${APEX_CODE_CHILD_LABEL_PREFIX}: renderer`, { header: { agentPreset: 'minimal' } }),
    flashChild(`${APEX_CODE_CHILD_LABEL_PREFIX}: renderer`, { options: { model: 'deepseek-v4-flash' } }),
  ]) {
    let presented = false
    const release = installCodeWorkerPtc({
      agent: child,
      tools: { presentAs() { presented = true } },
    })
    assert.equal(presented, false)
    assert.equal(typeof release, 'function')
  }

  let proPresented = false
  installCodeWorkerPtc({
    agent: proChild(`${APEX_CODE_CHILD_LABEL_PREFIX} [pro-core]: solver`),
    tools: { presentAs() { proPresented = true; return dispose } },
  })
  assert.equal(proPresented, true)
})

test('apex_build restricts only global tools and leaves child-scoped report outside the allow-list', async () => {
  let registeredTool
  let registeredSetup
  let startSpec
  applyBuild({
    tools: {
      register(tool) {
        registeredTool = tool
        return () => {}
      },
    },
    subagents: {
      registerContinuableSetup(setup) {
        registeredSetup = setup
        return () => {}
      },
      async startContinuable(spec) {
        startSpec = spec
        return { childId: 'worker-1' }
      },
    },
  })

  assert.equal(registeredSetup, installCodeWorkerPtc)
  assert.match(APEX_BUILD_DESCRIPTION, /flash-production by default for isolated single-file/i)
  assert.deepEqual(
    registeredTool.parameters.properties.role.enum,
    ['flash-production', 'pro-core'],
  )
  const parent = { session: { header: { cwd: '/workspace' }, events: [] } }
  const result = await registeredTool.execute(
    buildArguments(),
    { agent: parent, signal: undefined },
  )

  assert.deepEqual(result, {
    subagentId: 'worker-1',
    handoffId: 'renderer',
    role: 'flash-production',
  })
  assert.equal(startSpec.label, `${APEX_CODE_CHILD_LABEL_PREFIX} [flash-production]: renderer`)
  assert.equal(startSpec.request.label, startSpec.label)
  assert.deepEqual(startSpec.request.toolFilter, { allow: [...FLASH_PRODUCTION_WORKER_TOOLS] })
  assert.equal(startSpec.request.toolFilter.allow.includes('bash'), false)
  assert.equal(startSpec.request.toolFilter.allow.includes('pwsh'), false)
  assert.equal(startSpec.request.toolFilter.allow.includes('report'), false)
  assert.deepEqual(startSpec.request.agentOptions, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })

  await registeredTool.execute(
    { ...buildArguments('pro-core'), id: 'solver', description: 'solver', paths: ['src/solver.js'] },
    { agent: parent, signal: undefined },
  )
  assert.deepEqual(startSpec.request.agentOptions, {
    provider: PRO_MAX_PROVIDER,
    model: PRO_MAX_MODEL,
    reasoningEffort: PRO_MAX_REASONING_EFFORT,
  })
  assert.deepEqual(startSpec.request.toolFilter, { allow: [...PRO_CORE_WORKER_TOOLS] })
  assert.equal(startSpec.request.toolFilter.allow.includes(process.platform === 'win32' ? 'pwsh' : 'bash'), true)
  assert.equal(startSpec.request.toolFilter.allow.includes('report'), false)
})

test('PTC workers expose only run_code while legacy workers retain the native bootstrap', async () => {
  const ptc = flashChild(`${APEX_CODE_CHILD_LABEL_PREFIX} [flash-production]: renderer`)
  const assembled = await assemble(ptc, [
    PTC_TRANSPORT_TOOL,
    'str_replace_editor',
    'read',
    'bash',
  ])
  assert.deepEqual(assembled.tools.map(tool => tool.name), [PTC_TRANSPORT_TOOL])

  await assert.rejects(
    assemble(ptc, ['str_replace_editor', 'read']),
    /missing required PTC transport: run_code/,
  )

  const legacy = flashChild('renderer')
  const legacyAssembly = await assemble(legacy, [...BOOTSTRAP_TOOLS, 'read'])
  assert.deepEqual(legacyAssembly.tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])

  const pro = proChild(`${APEX_CODE_CHILD_LABEL_PREFIX} [pro-core]: solver`)
  const proAssembly = await assemble(pro, [PTC_TRANSPORT_TOOL, 'bash', 'read'])
  assert.deepEqual(proAssembly.tools.map(tool => tool.name), [PTC_TRANSPORT_TOOL])
})
