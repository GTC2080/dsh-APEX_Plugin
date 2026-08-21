import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  APEX_BUILD_DESCRIPTION,
  FLASH_CHILD_PERSONA,
} from '../presets/apex-v061/apex-build.mjs'
import { APEX_VISION_DESCRIPTION } from '../presets/apex-v061/apex-vision.mjs'
import { APEX_TAKEOVER_META_KIND } from '../presets/apex-v061/apex-continue.mjs'
import {
  APEX_CAPABILITY_CARD_PREFIX,
  APEX_POLICY,
  APEX_SHELL_HARD_STEER,
  APEX_SHELL_STEER,
  APEX_SHELL_STEER_PREFIX,
  APEX_WORKSPACE_HINT_PREFIX,
  apply as applyPolicy,
  capabilityCardText,
  CHILD_STALL_INSPECTION_LIMIT,
  CHILD_STALL_REASON,
  childStallEvidence,
  enforceFlashMax,
  enforceFlashWorkspace,
  FLASH_CHILD_SANDBOX_MODE,
  FLASH_VISION_MODEL,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  name as policyName,
  policyText,
  SHELL_EXPLORATION_LIMIT,
  shellSteerText,
  stalledChildHandoffText,
  shouldInject,
  shouldInjectCapabilityCard,
  shouldInjectShellSteer,
  shouldInjectWorkspaceHint,
  successfulShellCallsSinceEdit,
  VISION_CHILD_SANDBOX_MODE,
  VISION_CHILD_HARD_STEP_LIMIT,
  workspaceHintText,
} from '../presets/apex-v061/apex-policy.mjs'
import {
  apply as applyDiscovery,
  UNLOCKABLE_TOOL_NAMES,
} from '../presets/apex-v061/dev-tool-search.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  CHILD_RESIDENT_TOOLS,
  delegationPathConflictReason,
  hasSuccessfulImplementationMutation,
  PENDING_WORKER_TOOLS,
  phaseFor,
  QUIESCENT_WORKER_TOOLS,
  RESIDENT_TOOLS,
  ROOT_SHELL_HARD_LIMIT,
  REVIEWED_WORKER_TOOLS,
  shellCallAttemptsSinceEdit,
  SETTLEMENT_EVIDENCE_TOOLS,
  VISION_CHILD_TOOLS,
} from '../presets/apex-v061/tool-gate.mjs'

const catalog = [
  { name: 'apex_build', description: APEX_BUILD_DESCRIPTION },
  { name: 'apex_inspect_image', description: APEX_VISION_DESCRIPTION },
  { name: 'apex_continue', description: 'Continue a reviewed worker' },
  { name: 'apex_takeover', description: 'Transfer a settled worker lease' },
  { name: 'apex_state', description: 'Durable task state' },
  { name: 'apex_validate_web', description: 'Finite host browser validation' },
  { name: 'apex_wait', description: 'Wait for worker settlement' },
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'dev_tool_search', description: 'Discover tools' },
  { name: 'interrupt_agent', description: 'Interrupt a child turn' },
  { name: 'list_agents', description: 'List continuable children' },
  { name: 'read', description: 'Read files' },
  { name: 'read_image', description: 'Read an image' },
  { name: 'report', description: 'Report to the parent' },
  { name: 'send_message', description: 'Continue a child' },
  { name: 'str_replace_editor', description: 'Edit files' },
  { name: 'glob', description: 'Find files' },
  { name: 'grep', description: 'Search files' },
]

function agent(events = [], delegationDepth = 0, options = {}) {
  const session = {
    events: [...events],
    header: { delegationDepth, cwd: '/workspace' },
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return { options, session }
}

function managedChild(events = []) {
  return agent([{
    type: 'subagent/descriptor',
    data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'APEX code worker' },
  }, ...events], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
}

function visionChild(events = []) {
  return agent([{
    type: 'subagent/descriptor',
    data: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'APEX visual inspection (1)' },
  }, ...events], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_VISION_MODEL })
}

function successfulCall(name, callId = `${name}-1`, args = {}) {
  return [
    { type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } },
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

function unlockResult(...toolNames) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: 'apex-dev-tool-search-v061', unlockedTools: toolNames },
      message: { content: [] },
    },
  }
}

function pluginInstruction(text, id = 'plugin-instruction') {
  return {
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: policyName, form: 'instructions' },
    },
  }
}

function gateListeners() {
  const listeners = new Map()
  applyGate({
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  })
  return listeners
}

async function assemble(scopedAgent) {
  return gateListeners().get('system-prompt/assemble')(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
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

function policyListeners(reportFrom = async () => 'report-id') {
  const listeners = new Map()
  applyPolicy({
    tools: { register() { return () => {} } },
    subagents: { reportFrom },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  })
  return listeners
}

test('APEX v0.6.1 preserves the official Minimal shell descriptions on the first request', () => {
  const composition = readFileSync(
    new URL('../presets/apex-v061/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  assert.match(composition, /\* Please run long lived commands in the background, e\.g\. 'sleep 10 &' or start a server in the background\./)
  assert.match(composition, /\* Please run long lived commands in the background, e\.g\. 'Start-Job' or start a server with Start-Process\./)
  assert.doesNotMatch(composition, /\* Keep commands bounded and in the foreground/)
})

test('APEX v0.6.1 promotes only after a successful Minimal tool action', async () => {
  assert.equal(BOOTSTRAP_TOOLS[0], process.platform === 'win32' ? 'pwsh' : 'bash')
  const root = agent()
  assert.deepEqual((await assemble(root)).tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])

  const assistantOnly = agent([{ type: 'assistant/message', data: {} }])
  assert.equal(phaseFor(assistantOnly).promoted, false)
  assert.deepEqual((await assemble(assistantOnly)).tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])

  const failed = successfulCall(BOOTSTRAP_TOOLS[0])
  failed[1].data.message.content[0].isError = true
  assert.equal(phaseFor(agent(failed)).promoted, false)
  assert.deepEqual((await assemble(agent(failed))).tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])

  const successful = successfulCall(BOOTSTRAP_TOOLS[0])
  assert.deepEqual(
    (await assemble(agent(successful))).tools
      .map((tool) => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
  assert.equal((await assemble(agent(successful))).tools.some(tool => tool.name === 'apex_build'), false)

  const child = managedChild()
  assert.equal(phaseFor(child).kind, 'child')
  assert.equal(phaseFor(child).promoted, false)
  assert.deepEqual((await assemble(child)).tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])

  const promotedChild = managedChild(successfulCall('str_replace_editor', 'edit-1', {
    command: 'view', path: '/workspace/index.html',
  }))
  assert.equal(phaseFor(promotedChild).promoted, true)
  assert.deepEqual(
    (await assemble(promotedChild)).tools.map((tool) => tool.name).sort(),
    [...CHILD_RESIDENT_TOOLS].sort(),
  )
  assert.equal(CHILD_RESIDENT_TOOLS.includes(BOOTSTRAP_TOOLS[0]), false)

  const deniedShellChild = managedChild([{
    type: 'tool/call',
    data: { name: BOOTSTRAP_TOOLS[0], callId: 'denied-shell', arguments: '{}' },
  }])
  assert.equal(phaseFor(deniedShellChild).promoted, true)
  assert.equal((await assemble(deniedShellChild)).tools.some(tool => tool.name === BOOTSTRAP_TOOLS[0]), false)

  const compactedChild = managedChild([
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    { type: 'compaction/end', data: {} },
  ])
  assert.equal(phaseFor(compactedChild).promoted, false)
  assert.deepEqual((await assemble(compactedChild)).tools.map((tool) => tool.name), [...BOOTSTRAP_TOOLS])

  const unmanagedChild = agent([], 1, { provider: 'other', model: 'other' })
  assert.equal(phaseFor(unmanagedChild).kind, 'full')
  assert.deepEqual((await assemble(unmanagedChild)).tools, catalog)

  const visual = visionChild()
  assert.equal(phaseFor(visual).kind, 'vision-child')
  assert.deepEqual((await assemble(visual)).tools.map(tool => tool.name), [...VISION_CHILD_TOOLS])

  const unpublishedVision = agent([], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_VISION_MODEL,
  })
  const firstVisionAssembly = await gateListeners().get('system-prompt/assemble')(
    undefined,
    { agent: unpublishedVision },
    async () => ({
      sections: [], contexts: [], variables: {},
      tools: catalog.filter(tool => tool.name === 'read_image'),
    }),
  )
  assert.deepEqual(firstVisionAssembly.tools.map(tool => tool.name), ['read_image'])
})

test('APEX v0.6.1 strips automatic project and skill context from the Minimal child', async () => {
  const listener = gateListeners().get('agent/pre-step')
  const keep = { id: 'brief', source: { kind: 'user' } }
  const decision = await listener(
    { agent: managedChild() },
    async () => ({
      kind: 'enter',
      messages: [
        keep,
        { id: 'instructions', source: { kind: 'agent-instructions' } },
        { id: 'skills', source: { kind: 'skill-catalog' } },
      ],
    }),
  )
  assert.deepEqual(decision.messages, [keep])

  const rootDecision = await listener(
    { agent: agent(successfulCall(BOOTSTRAP_TOOLS[0])) },
    async () => ({
      kind: 'enter',
      messages: [
        keep,
        { id: 'instructions', source: { kind: 'agent-instructions' } },
        { id: 'skills', source: { kind: 'skill-catalog' } },
      ],
    }),
  )
  assert.deepEqual(rootDecision.messages, [keep])

  const skillDecision = await listener(
    { agent: agent([...successfulCall(BOOTSTRAP_TOOLS[0]), unlockResult('skill')]) },
    async () => ({
      kind: 'enter',
      messages: [
        keep,
        { id: 'instructions', source: { kind: 'agent-instructions' } },
        { id: 'skills', source: { kind: 'skill-catalog' } },
      ],
    }),
  )
  assert.deepEqual(skillDecision.messages, [keep, { id: 'skills', source: { kind: 'skill-catalog' } }])
})

test('APEX v0.6.1 keeps control tools behind one optional broker', async () => {
  assert.equal(RESIDENT_TOOLS.includes('apex_build'), false)
  assert.equal(RESIDENT_TOOLS.includes('apex_state'), false)
  assert.equal(RESIDENT_TOOLS.includes('apex_validate_web'), false)
  assert.equal(RESIDENT_TOOLS.includes('apex_inspect_image'), false)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('apex_build'), true)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('apex_inspect_image'), true)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('apex_state'), true)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes('apex_validate_web'), true)
  assert.equal(UNLOCKABLE_TOOL_NAMES.includes(BOOTSTRAP_TOOLS[0]), false)
  for (const name of ['apex_research', 'subagent', 'subagent_fork', 'workflow', 'ralph']) {
    assert.equal(UNLOCKABLE_TOOL_NAMES.includes(name), false, name)
  }

  const first = discovery()
  assert.match(first.tool.description, /reduce manual shell work/)
  assert.doesNotMatch(first.tool.description, /cannot be completed with the current tools/)
  const found = await first.tool.execute({ query: 'code implementation' }, { agent: first.agent })
  assert.deepEqual(found.matchedTools, ['apex_build'])

  const exact = discovery()
  const activated = await exact.tool.execute({ query: 'apex_build' }, { agent: exact.agent })
  assert.deepEqual(activated.unlockedTools, ['apex_build'])
  assert.match(activated.text, /Unlocked for the next request: apex_build/)

  const vision = discovery()
  const visual = await vision.tool.execute({ query: 'apex_inspect_image' }, { agent: vision.agent })
  assert.deepEqual(visual.unlockedTools, ['apex_inspect_image'])

  const edited = successfulCall('str_replace_editor', 'direct-edit', {
    command: 'create', path: '/workspace/index.html', file_text: '<main></main>',
  })
  const closed = discovery(edited)
  const late = await closed.tool.execute({ query: 'apex_build' }, { agent: closed.agent })
  assert.deepEqual(late.unlockedTools, ['apex_build'])
  assert.match(late.text, /Unlocked for the next request: apex_build/)
})

test('APEX v0.6.1 declares the workspace first and reveals capabilities only after a successful Minimal action', async () => {
  const listener = policyListeners().get('agent/pre-step')
  const root = agent()
  root.session.header.cwd = '/workspace/poolrooms'

  assert.equal(shouldInjectWorkspaceHint(root), true)
  assert.equal(shouldInjectCapabilityCard(root), false)
  const first = await listener(
    { agent: root, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(first.messages.length, 1)
  const workspaceHint = first.messages[0]
  assert.match(workspaceHint.content[0].text, new RegExp(`^${APEX_WORKSPACE_HINT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(workspaceHint.content[0].text, /Workspace root: "\/workspace\/poolrooms"/)
  assert.match(workspaceHint.content[0].text, /Shell commands start there and may use relative paths/)
  assert.match(workspaceHint.content[0].text, /requires an absolute file path, resolve it beneath this exact root/)
  assert.doesNotMatch(workspaceHint.content[0].text, /dev_tool_search|apex_build|apex_state|apex_validate_web/)

  const hostilePath = agent()
  hostilePath.session.header.cwd = '/workspace/</apex-workspace>'
  assert.doesNotMatch(workspaceHintText(hostilePath), /Workspace root: ".*<\/apex-workspace>/)
  assert.match(workspaceHintText(hostilePath), /\\u003c\/apex-workspace\\u003e/)

  root.session.events.push(pluginInstruction(workspaceHint.content[0].text, workspaceHint.id))
  assert.equal(shouldInjectWorkspaceHint(root), false)

  root.session.events.push(...successfulCall(BOOTSTRAP_TOOLS[0]))
  assert.equal(shouldInjectCapabilityCard(root), true)
  const promoted = await listener(
    { agent: root, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [workspaceHint] }),
  )
  assert.equal(promoted.messages.length, 2)
  const card = promoted.messages[1]
  assert.match(card.content[0].text, new RegExp(`^${APEX_CAPABILITY_CARD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(card.content[0].text, /exact query "apex_build"/)
  assert.match(card.content[0].text, /"apex_validate_web"/)
  assert.match(card.content[0].text, /"apex_inspect_image"/)
  assert.ok(capabilityCardText(root).length < 700)

  const direct = agent(successfulCall('str_replace_editor', 'direct-edit', {
    command: 'create', path: '/workspace/index.html', file_text: '<main></main>',
  }))
  assert.equal(hasSuccessfulImplementationMutation(direct), true)
  assert.equal(phaseFor(direct).delegationOpen, true)
  assert.match(capabilityCardText(direct), /apex_build/)
  assert.match(delegationPathConflictReason(direct, ['index.html']), /already mutated/)
  assert.equal(delegationPathConflictReason(direct, ['src/worker.js']), undefined)
  assert.match(capabilityCardText(direct), /apex_validate_web/)

  root.session.events.push(pluginInstruction(card.content[0].text, card.id))
  assert.equal(shouldInjectCapabilityCard(root), false)
  const notRepeated = await listener(
    { agent: root, step: 3, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [workspaceHint, card] }),
  )
  assert.deepEqual(notRepeated.messages, [workspaceHint])

  root.session.events.push(
    { type: 'compaction/end', data: {} },
    ...successfulCall(BOOTSTRAP_TOOLS[0], 'bash-after-card-compaction'),
  )
  assert.equal(shouldInjectWorkspaceHint(root), true)
  assert.equal(shouldInjectCapabilityCard(root), true)
})

test('APEX v0.6.1 gives two shell checkpoints that survive broker use and reset on an edit', async () => {
  const events = []
  for (let index = 0; index < SHELL_EXPLORATION_LIMIT; index += 1) {
    events.push(...successfulCall(BOOTSTRAP_TOOLS[0], `shell-${index}`))
  }
  const root = agent(events)
  root.session.header.cwd = '/workspace'
  root.session.events.push(pluginInstruction(workspaceHintText(root), 'workspace-hint'))
  root.session.events.push(pluginInstruction(capabilityCardText(root), 'capability-card'))
  assert.equal(successfulShellCallsSinceEdit(root), SHELL_EXPLORATION_LIMIT)
  assert.equal(shellCallAttemptsSinceEdit(root), SHELL_EXPLORATION_LIMIT)
  assert.equal(shouldInjectShellSteer(root), true)

  const listener = policyListeners().get('agent/pre-step')
  const decision = await listener(
    { agent: root, step: SHELL_EXPLORATION_LIMIT + 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, APEX_SHELL_STEER)
  assert.match(APEX_SHELL_STEER, /second checkpoint/)

  root.session.events.push(pluginInstruction(APEX_SHELL_STEER, 'shell-steer'))
  assert.equal(shouldInjectShellSteer(root), false)

  for (let index = SHELL_EXPLORATION_LIMIT; index < ROOT_SHELL_HARD_LIMIT; index += 1) {
    root.session.events.push(...successfulCall(BOOTSTRAP_TOOLS[0], `shell-${index}`))
  }
  assert.equal(shellCallAttemptsSinceEdit(root), ROOT_SHELL_HARD_LIMIT)
  assert.equal(shouldInjectShellSteer(root), true)
  assert.equal(shellSteerText(root), APEX_SHELL_HARD_STEER)
  root.session.events.push(pluginInstruction(APEX_SHELL_HARD_STEER, 'shell-hard-steer'))
  assert.equal(shouldInjectShellSteer(root), false)
  const pausedTools = (await assemble(root)).tools.map(tool => tool.name)
  assert.equal(pausedTools.includes(BOOTSTRAP_TOOLS[0]), false)
  assert.equal(pausedTools.includes('str_replace_editor'), true)

  root.session.events.push(...successfulCall('str_replace_editor', 'implementation-edit', {
    command: 'str_replace', path: '/workspace/index.html', old_str: 'a', new_str: 'b',
  }))
  assert.equal(successfulShellCallsSinceEdit(root), 0)
  assert.equal(shellCallAttemptsSinceEdit(root), 0)
  assert.equal((await assemble(root)).tools.some(tool => tool.name === BOOTSTRAP_TOOLS[0]), true)

  const brokerUsed = agent([
    ...events,
    { type: 'tool/call', data: { name: 'dev_tool_search', callId: 'search-1', arguments: '{}' } },
  ])
  assert.equal(shouldInjectShellSteer(brokerUsed), true)
  assert.match(APEX_SHELL_STEER, new RegExp(`^${APEX_SHELL_STEER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('APEX v0.6.1 restores only explicitly activated capabilities after re-anchor', async () => {
  const base = successfulCall(BOOTSTRAP_TOOLS[0])
  const builder = agent([...base, unlockResult('apex_build')])
  const builderTools = (await assemble(builder)).tools.map(tool => tool.name)
  assert.equal(builderTools.includes('apex_build'), true)
  assert.equal(builderTools.includes('apex_state'), false)
  assert.equal(builderTools.includes('apex_validate_web'), false)

  const directEdit = successfulCall('str_replace_editor', 'direct-edit', {
    command: 'create', path: '/workspace/index.html', file_text: '<main></main>',
  })
  const lateBuilder = agent([...directEdit, unlockResult('apex_build')])
  assert.equal((await assemble(lateBuilder)).tools.some(tool => tool.name === 'apex_build'), true)

  const validation = agent([...base, unlockResult('apex_validate_web')])
  const validationTools = (await assemble(validation)).tools.map(tool => tool.name)
  assert.equal(validationTools.includes('apex_validate_web'), true)
  assert.equal(validationTools.includes('apex_state'), true)

  const vision = agent([...base, unlockResult('apex_inspect_image')])
  const visionTools = (await assemble(vision)).tools.map(tool => tool.name)
  assert.equal(visionTools.includes('apex_inspect_image'), true)
  assert.equal(visionTools.includes('apex_validate_web'), false)

  const compactedEvents = [...base, unlockResult('apex_build'), { type: 'compaction/end', data: {} }]
  assert.deepEqual((await assemble(agent(compactedEvents))).tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])
  compactedEvents.push(...successfulCall(BOOTSTRAP_TOOLS[0], 'bash-after-compaction'))
  assert.equal((await assemble(agent(compactedEvents))).tools.some(tool => tool.name === 'apex_build'), true)
})

test('APEX v0.6.1 exposes visual review only while a passed screenshot lacks review', async () => {
  const base = [
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    {
      type: 'tool/result',
      data: {
        meta: {
          kind: 'apex-web-validation-v061',
          mode: 'final',
          status: 'passed',
          screenshotPath: 'artifacts/final.png',
        },
      },
    },
  ]
  const pending = agent(base)
  assert.equal(phaseFor(pending).visualReviewPending, true)
  assert.equal((await assemble(pending)).tools.some(tool => tool.name === 'apex_inspect_image'), true)

  const reviewed = agent([...base, {
    type: 'tool/result',
    data: {
      meta: {
        kind: 'apex-visual-review-v061',
        imagePaths: ['artifacts/final.png'],
        verdict: 'pass',
      },
    },
  }])
  assert.equal(phaseFor(reviewed).visualReviewPending, false)
  assert.equal((await assemble(reviewed)).tools.some(tool => tool.name === 'apex_inspect_image'), false)
})

test('APEX v0.6.1 keeps Pro in command and delegates only independent implementation', () => {
  assert.ok(APEX_POLICY.length < 1_200, `policy is ${APEX_POLICY.length} characters`)
  assert.match(APEX_POLICY, /Pro parent owns architecture, main integration surfaces/)
  assert.match(APEX_POLICY, /Continue directly for a single-file or tightly coupled task/)
  assert.match(APEX_POLICY, /genuinely independent module/)
  assert.match(APEX_POLICY, /path already mutated by Pro stays Pro-owned/)
  assert.match(APEX_POLICY, /Never delegate the whole workspace/)
  assert.match(APEX_POLICY, /whole workspace/)
  assert.match(APEX_POLICY, /Pro keeps its editor/)
  assert.match(APEX_POLICY, /other workspace paths remain Pro-owned/)
  assert.match(APEX_POLICY, /Repeated successful inspections without a new edit/)
  assert.match(APEX_POLICY, /Use apex_state only across compaction/)
  assert.match(APEX_POLICY, /runtime pass does not prove visual quality/)
  assert.match(APEX_POLICY, /2-4 distinct acceptance checks/)
  assert.doesNotMatch(APEX_POLICY, /must start apex_build/)
  assert.doesNotMatch(APEX_POLICY, /scheduling checkpoint/i)
  assert.match(APEX_BUILD_DESCRIPTION, /structured fields once/)
  assert.doesNotMatch(APEX_POLICY, /apex_research/)

  const child = managedChild([{ type: 'assistant/message', data: {} }])
  assert.equal(policyText(child), '')
  assert.equal(shouldInject(child), false)

  const direct = agent(successfulCall(BOOTSTRAP_TOOLS[0]))
  assert.equal(shouldInject(direct), false)
  const activated = agent([...successfulCall(BOOTSTRAP_TOOLS[0]), unlockResult('apex_build')])
  assert.equal(shouldInject(activated), true)
})

test('APEX v0.6.1 pins code and vision children to their least-permissive sandbox modes', () => {
  const child = managedChild([
    { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
  ])
  assert.equal(enforceFlashWorkspace(child), true)
  assert.deepEqual(child.session.events.at(-1), {
    type: 'sandbox/mode',
    data: { mode: FLASH_CHILD_SANDBOX_MODE, source: 'delegation' },
  })
  assert.equal(enforceFlashWorkspace(child), false)
  assert.equal(enforceFlashWorkspace(agent([], 0, child.options)), false)
  assert.equal(enforceFlashWorkspace(agent([], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: 'deepseek-v4-pro',
  })), false)

  const visual = visionChild()
  assert.equal(enforceFlashWorkspace(visual), true)
  assert.equal(visual.session.events.at(-1)?.data?.mode, VISION_CHILD_SANDBOX_MODE)
})

test('APEX v0.6.1 applies the read-only visual sandbox after first-turn identity publication', async () => {
  const child = agent([], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_VISION_MODEL,
  })
  const decision = await policyListeners().get('agent/pre-step')(
    { agent: child, step: 1, signal: new AbortController().signal },
    async () => {
      child.session.events.push({
        type: 'subagent/descriptor',
        data: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'APEX visual inspection (1)' },
      })
      return { kind: 'enter', messages: [] }
    },
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(child.session.events.at(-1)?.data?.mode, VISION_CHILD_SANDBOX_MODE)
})

test('APEX v0.6.1 gives Flash its bounded brief without recurring step warnings', async () => {
  const child = managedChild()
  const listener = policyListeners().get('agent/pre-step')
  const first = await listener(
    { agent: child, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(first.messages, [])
  assert.equal(child.session.events.at(-1)?.data?.mode, FLASH_CHILD_SANDBOX_MODE)

  const ordinary = await listener(
    { agent: child, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(ordinary.messages, [])

  const late = await listener(
    { agent: child, step: 1_000, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(late.messages, [])
})

test('APEX v0.6.1 never injects a mandatory parent delegation checkpoint', async () => {
  const listener = policyListeners().get('agent/pre-step')
  const parent = agent(successfulCall(BOOTSTRAP_TOOLS[0]))
  parent.session.events.push(pluginInstruction(workspaceHintText(parent), 'workspace-hint'))
  parent.session.events.push(pluginInstruction(capabilityCardText(parent), 'capability-card'))
  const decision = await listener(
    {
      agent: parent,
      step: 8,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision.messages, [])
})

test('APEX v0.6.1 keeps Pro editing and exposes worker controls only for their state', async () => {
  const callId = 'build-1'
  const events = [
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    { type: 'tool/call', data: { name: 'apex_build', callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'started subagent child-1' }],
          }],
        },
      },
    },
  ]
  const pendingTools = (await assemble(agent(events))).tools.map(tool => tool.name)
  for (const name of PENDING_WORKER_TOOLS) assert.equal(pendingTools.includes(name), true, name)
  for (const name of [...REVIEWED_WORKER_TOOLS, ...QUIESCENT_WORKER_TOOLS]) {
    assert.equal(pendingTools.includes(name), false, name)
  }
  assert.equal(pendingTools.includes('str_replace_editor'), true)
  assert.equal(pendingTools.includes('list_agents'), false)

  events.push(
    {
      type: 'user/message',
      data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } },
    },
  )
  const awaitingEvidenceTools = (await assemble(agent(events))).tools.map(tool => tool.name)
  for (const name of SETTLEMENT_EVIDENCE_TOOLS) {
    assert.equal(awaitingEvidenceTools.includes(name), true, name)
  }
  assert.equal(awaitingEvidenceTools.includes('interrupt_agent'), false)
  for (const name of [...REVIEWED_WORKER_TOOLS, ...QUIESCENT_WORKER_TOOLS]) {
    assert.equal(awaitingEvidenceTools.includes(name), false, name)
  }

  events.push({
    type: 'tool/result',
    data: {
      meta: { kind: 'apex-worker-wait-v061', childId: 'child-1' },
      message: { content: [] },
    },
  })
  const reviewedTools = (await assemble(agent(events))).tools.map(tool => tool.name)
  for (const name of [...REVIEWED_WORKER_TOOLS, ...QUIESCENT_WORKER_TOOLS]) {
    assert.equal(reviewedTools.includes(name), true, name)
  }
  assert.equal(reviewedTools.includes('apex_wait'), false)
  assert.equal(reviewedTools.includes('str_replace_editor'), true)

  const recoveredWithoutParentSettlement = events.filter(event => (
    event.type !== 'user/message' || event.data?.source?.kind !== 'subagent-settled'
  ))
  const recoveredTools = (await assemble(agent(recoveredWithoutParentSettlement))).tools.map(tool => tool.name)
  assert.equal(recoveredTools.includes('apex_wait'), false)
  assert.equal(recoveredTools.includes('apex_continue'), true)
  assert.equal(recoveredTools.includes('apex_takeover'), true)

  const mixedEvents = [
    ...events,
    { type: 'tool/call', data: { name: 'apex_build', callId: 'build-2', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result', toolCallId: 'build-2', isError: false,
            content: [{ type: 'text', text: 'started subagent child-2' }],
          }],
        },
      },
    },
  ]
  const mixedTools = (await assemble(agent(mixedEvents))).tools.map(tool => tool.name)
  assert.equal(mixedTools.includes('apex_wait'), true)
  assert.equal(mixedTools.includes('apex_continue'), true)
  assert.equal(mixedTools.includes('apex_takeover'), false)

  events.push(
    { type: 'tool/call', data: { name: 'apex_takeover', callId: 'takeover-1', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        meta: {
          kind: APEX_TAKEOVER_META_KIND,
          childId: 'child-1',
          workItemId: 'work',
          paths: ['src/main.js'],
          reason: 'pro_only_fix',
        },
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'takeover-1',
            isError: false,
            content: [{ type: 'text', text: 'lease transferred' }],
          }],
        },
      },
    },
  )
  const afterTakeover = (await assemble(agent(events))).tools.map(tool => tool.name)
  assert.equal(afterTakeover.includes('str_replace_editor'), true)

  const failedStart = [
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    { type: 'tool/call', data: { name: 'apex_build', callId: 'failed-build', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result', toolCallId: 'failed-build', isError: true,
            content: [{ type: 'text', text: 'failed' }],
          }],
        },
      },
    },
  ]
  const failedTools = (await assemble(agent(failedStart))).tools.map(tool => tool.name)
  for (const name of [
    ...PENDING_WORKER_TOOLS,
    ...REVIEWED_WORKER_TOOLS,
    ...QUIESCENT_WORKER_TOOLS,
  ]) {
    assert.equal(failedTools.includes(name), false, name)
  }
})

test('APEX v0.6.1 hands off only after repeated successful inspections without an edit', async () => {
  const reports = []
  const cancellations = []
  const child = managedChild([
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: [
            'APEX_WORK_ITEM {"id":"renderer","paths":["src/**"]}',
            'Goal: Implement the renderer.',
            'Context: Follow the existing architecture.',
            'Non-goals: Do not change unrelated modules.',
            'Constraints: Edit only leased paths.',
            'Acceptance: Complete one module self-check.',
            'Report: Return status, files, checks, remaining work, and blockers.',
          ].join('\n'),
        }],
      },
    },
    ...successfulCall('str_replace_editor', 'create-main', {
      command: 'create', path: '/workspace/src/main.js', file_text: 'export default 1',
    }),
    ...Array.from({ length: CHILD_STALL_INSPECTION_LIMIT }, (_, index) => (
      successfulCall('str_replace_editor', `view-${index}`, {
        command: 'view', path: `/workspace/src/file-${index % 6}.js`,
      })
    )).flat(),
  ])
  child.session.header.cwd = '/workspace'
  child.cancel = cause => cancellations.push(cause)
  const listener = policyListeners(async (_agent, content, options) => {
    reports.push({ content, options })
    return 'handoff-id'
  }).get('agent/pre-step')

  const decision = await listener(
    { agent: child, step: 20, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].options.delivery, 'quiet')
  assert.match(reports[0].content[0].text, /workItemId: renderer/)
  assert.match(reports[0].content[0].text, /filesTouched: src\/main\.js/)
  assert.match(reports[0].content[0].text, /stopReason: repeated_no_progress/)
  assert.equal(childStallEvidence(child).successfulInspections, CHILD_STALL_INSPECTION_LIMIT)
  assert.deepEqual(cancellations, [{ kind: 'hook', reason: CHILD_STALL_REASON }])
  assert.doesNotMatch(stalledChildHandoffText(child), /step_budget|wall/i)
})

test('APEX v0.6.1 stops the read-only vision child at its bounded step limit', async () => {
  const cancellations = []
  const child = visionChild()
  child.cancel = cause => cancellations.push(cause)
  const decision = await policyListeners().get('agent/pre-step')(
    {
      agent: child,
      step: VISION_CHILD_HARD_STEP_LIMIT + 1,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(decision, { kind: 'reject' })
  assert.deepEqual(cancellations, [{
    kind: 'hook',
    reason: 'APEX v0.6.1 stopped the vision child at its bounded step limit.',
  }])
})

test('APEX v0.6.1 forces Max reasoning only on delegated official Flash requests', async () => {
  const flash = managedChild()
  const config = { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL, reasoningEffort: 'high' }
  assert.deepEqual(enforceFlashMax(flash, config), {
    ...config,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })
  assert.equal(enforceFlashMax(agent([], 0), config), config)

  const listener = policyListeners().get('agent/request')
  const request = await listener({ agent: flash }, async () => config)
  assert.equal(request.reasoningEffort, FLASH_MAX_REASONING_EFFORT)

  const visual = visionChild()
  const visionConfig = {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_VISION_MODEL,
    reasoningEffort: 'high',
  }
  assert.deepEqual(enforceFlashMax(visual, visionConfig), {
    ...visionConfig,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })
})
