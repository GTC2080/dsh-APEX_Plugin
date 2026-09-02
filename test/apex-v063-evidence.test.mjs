import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  artifactSnapshot,
  hostEvidencePath,
  imageSnapshots,
} from '../presets/apex-v063/apex-evidence.mjs'
import {
  editorErrorRecovery,
  guardExecution,
  HOST_EVIDENCE_TRANSFORM_REASON,
  isHostEvidenceImageTransformCommand,
  normalizeShellExit,
  PRE_IMPLEMENTATION_COMPUTE_REASON,
  PROVISIONAL_IMPLEMENTATION_COMPUTE_REASON,
  preImplementationComputeDenial,
  recordImplementationMutation,
  recoverEditorError,
  redirectBrowserProbeExecution,
  resolveWorkspaceEditorPathExecution,
  stampImplementationMutation,
  WEB_VALIDATION_DISCOVERY_REASON,
  WEB_VALIDATION_PROBE_REDIRECT_PREFIX,
  workspaceMutationIntent,
} from '../presets/apex-v063/execution-guard.mjs'
import {
  APEX_COMPUTE_CHECKPOINT_PREFIX,
  APEX_FINAL_EVIDENCE_PREFIX,
  APEX_IMPLEMENTATION_TRANSITION_PREFIX,
  APEX_MODALITY_ROUTING_PREFIX,
  APEX_PROMOTION_HINT_PREFIX,
  COMPUTE_CHECKPOINT_SHORT_COMPLETIONS,
  COMPUTE_CHECKPOINT_VISUAL_EVIDENCE_COMPLETIONS,
  IMPLEMENTATION_MUTATION_MARKER,
  apply as applyPolicy,
  computeCheckpointText,
  finalEvidenceGap,
  finalEvidenceMessageText,
  implementationTransitionText,
  modalityRoutingText,
  preArtifactComputeTransition,
  promotionHintText,
  shouldInjectComputeCheckpoint,
  shouldInjectImplementationTransition,
  shouldInjectModalityRouting,
  shouldInjectPromotionHint,
  workspaceHintText,
} from '../presets/apex-v063/apex-policy.mjs'
import {
  apply as applyValidation,
  dispatchInteractions,
  inspectTextChecks,
  interactionContractDenial,
  sameNetworkUrl,
  textCheckFailures,
  validationPlan,
  validationScreenshotPath,
  validationSignature,
} from '../presets/apex-v063/apex-validation.mjs'
import {
  apply as applyVision,
  APEX_VISION_DESCRIPTION,
  DERIVED_VALIDATION_EVIDENCE_REASON,
  parseVisualReport,
  PENDING_VALIDATION_SCREENSHOT_REASON,
  SETTLED_VALIDATION_SCREENSHOT_REASON,
  STALE_VALIDATION_SCREENSHOT_REASON,
  validationScreenshotDenial,
  VISION_CHILD_PERSONA,
  VISION_OUTPUT_SCHEMA,
  VISUAL_META_KIND,
} from '../presets/apex-v063/apex-vision.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  currentWebVisualEvidenceState,
  DELIVERY_META_KIND,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  FLASH_VISION_MODEL,
  hasWorkspaceArtifact,
  UNLOCK_META_KIND,
  WEB_VALIDATION_META_KIND,
} from '../presets/apex-v063/tool-gate.mjs'
import {
  WORKSPACE_SHELL_REASON,
  workspaceShellDenial,
} from '../presets/apex-v063/workspace-boundary.mjs'

const catalog = [
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'str_replace_editor', description: 'View and edit files' },
  { name: 'dev_tool_search', description: 'Discover optional tools' },
  { name: 'apex_inspect_image', description: APEX_VISION_DESCRIPTION },
  { name: 'apex_validate_web', description: 'Validate one static web artifact' },
]

function agent(events = [], cwd = '/workspace') {
  return { session: { events, header: { delegationDepth: 0, cwd } } }
}

function human(text = 'Please repair the visible defect.') {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
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

function timedShellCall(callId, start, end, isError = false, command = 'node computation.mjs') {
  return [
    {
      type: 'tool/call',
      time: start,
      data: { name: BOOTSTRAP_TOOLS[0], callId, arguments: JSON.stringify({ command }) },
    },
    {
      type: 'tool/result',
      time: end,
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError,
            content: [{ type: 'text', text: isError ? 'failed' : 'computed' }],
          }],
        },
      },
    },
  ]
}

function computeCheckpointEvent() {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: computeCheckpointText() }],
      source: { kind: 'plugin', plugin: 'apex-policy-v063', form: 'instructions' },
    },
  }
}

function implementationMutationEvent(callId) {
  return {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: false,
          content: [{ type: 'text', text: `ok\n${IMPLEMENTATION_MUTATION_MARKER}` }],
        }],
      },
    },
  }
}

function validationEvent(args, mode, status, artifactHash, overrides = {}) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: WEB_VALIDATION_META_KIND,
        checkId: args.check_id,
        mode,
        status,
        signature: validationSignature(args),
        failureClass: status === 'failed' ? 'application-runtime' : 'none',
        diagnosticHash: '',
        defectScore: status === 'failed' ? 1 : 0,
        repairEligible: status === 'failed',
        screenshotPath: '',
        screenshotHash: '',
        artifactRoot: '.',
        artifactHash,
        ...overrides,
      },
    },
  }
}

function visualEvent(value) {
  return {
    type: 'tool/result',
    data: { meta: { kind: VISUAL_META_KIND, ...value } },
  }
}

function unlockEvent(...toolNames) {
  return {
    type: 'tool/result',
    data: { meta: { kind: UNLOCK_META_KIND, unlockedTools: toolNames } },
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

function policyPreStepListener() {
  let listener
  applyPolicy({
    tools: { register: () => () => {} },
    subagents: {},
    on(event, value) {
      if (event === 'agent/pre-step') listener = value
      return () => {}
    },
  })
  return listener
}

async function assemble(scopedAgent) {
  return gateListener()(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
}

function visionRuntime(outputs) {
  let tool
  const starts = []
  applyVision({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subagents: {
      async start(provider, request) {
        starts.push({ provider, request })
        const value = outputs[Math.min(starts.length - 1, outputs.length - 1)]
        const structured = typeof value === 'string' ? JSON.parse(value) : value
        return {
          result: Promise.resolve({
            structured,
            stopReason: 'completed',
          }),
          async dispose() {},
        }
      },
    },
  })
  return { tool, starts }
}

const passReport = JSON.stringify({
  verdict: 'pass',
  target_status: 'met',
  answered_question: 'No blocking defect is visible in the supplied state.',
  findings: [],
  resolved_issue_ids: [],
  remaining_gaps: [],
  preserved_facts: [],
  regressions: [],
})

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('browser document status matching canonicalizes Unicode entry URLs', () => {
  assert.equal(
    sameNetworkUrl(
      'http://127.0.0.1:3080/%E5%8F%8C%E5%8F%89%E8%87%82.html',
      'http://127.0.0.1:3080/双叉臂.html',
    ),
    true,
  )
  assert.equal(
    sameNetworkUrl(
      'http://127.0.0.1:3080/%E5%8F%8C%E5%8F%89%E8%87%82.html',
      'http://127.0.0.1:3080/other.html',
    ),
    false,
  )
})

test('the first workspace hint makes the exact root authoritative without alias probing', () => {
  const text = workspaceHintText(agent([], '/real/session/workspace'))
  assert.match(text, /Workspace root: "\/real\/session\/workspace"/)
  assert.match(text, /Do not probe conventional aliases such as "\/workspace"/)
})

test('the capability broker first appears with one short evidence-gap hint after Minimal promotion', async () => {
  const listener = policyPreStepListener()
  const signal = new AbortController().signal
  const enter = async () => ({ kind: 'enter', messages: [] })
  const initial = agent()

  assert.deepEqual((await assemble(initial)).tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])
  const first = await listener({ agent: initial, step: 1, signal }, enter)
  assert.equal(first.messages.some(message => message.content?.some(block => (
    block.type === 'text' && block.text.startsWith(APEX_PROMOTION_HINT_PREFIX)
  ))), false)

  const promoted = agent(successfulCall(BOOTSTRAP_TOOLS[0]))
  const secondTools = await assemble(promoted)
  assert.equal(secondTools.tools.some(tool => tool.name === 'dev_tool_search'), true)
  assert.equal(shouldInjectPromotionHint(promoted), true)

  const second = await listener({ agent: promoted, step: 2, signal }, enter)
  const hint = second.messages.find(message => message.content?.some(block => (
    block.type === 'text' && block.text.startsWith(APEX_PROMOTION_HINT_PREFIX)
  )))
  assert.ok(hint)
  assert.match(hint.content[0].text, /Capability availability changed after the Minimal anchor/i)
  assert.match(hint.content[0].text, /Re-evaluate any unmet user requirement deferred/i)
  assert.match(hint.content[0].text, /a tool or collaborator was absent/i)
  assert.match(hint.content[0].text, /concrete gap through the broker/i)
  assert.match(hint.content[0].text, /host browser/i)
  assert.match(hint.content[0].text, /never probe paths or install one/i)
  assert.match(hint.content[0].text, /Before editing an existing file, view it with str_replace_editor/i)
  assert.match(hint.content[0].text, /smallest unique old_str/i)
  assert.match(hint.content[0].text, /Mutations invalidate freshness/i)
  assert.match(hint.content[0].text, /Shell output does not restore it/i)
  assert.doesNotMatch(hint.content[0].text, /apex_research|apex_build|apex_validate_web|apex_inspect_image/)
  assert.ok(promotionHintText().length < 520)

  promoted.session.events.push({ type: 'user/message', data: hint })
  assert.equal(shouldInjectPromotionHint(promoted), false)

  promoted.session.events.push({ type: 'compaction/end', data: {} })
  assert.equal(shouldInjectPromotionHint(promoted), false)
  promoted.session.events.push(...successfulCall(BOOTSTRAP_TOOLS[0], 'bash-after-compaction'))
  assert.equal(shouldInjectPromotionHint(promoted), true)
})

test('proven visual media triggers one broker-first modality route before Shell emulation', async () => {
  const visualEvidence = [
    {
      type: 'tool/call',
      data: { name: BOOTSTRAP_TOOLS[0], callId: 'identify-reference', arguments: '{"command":"file reference"}' },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'identify-reference',
            isError: false,
            content: [{ type: 'text', text: 'reference: PNG image data, 800 x 600' }],
          }],
        },
      },
    },
  ]
  const scopedAgent = agent(visualEvidence)
  assert.equal(shouldInjectModalityRouting(scopedAgent), true)
  assert.match(modalityRoutingText(), /capability broker the next external action/i)
  assert.match(modalityRoutingText(), /do not substitute Shell OCR, pixel sampling, or image parsing/i)

  const listener = policyPreStepListener()
  const decision = await listener(
    { agent: scopedAgent, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const route = decision.messages.find(message => (
    message.content?.some(block => block.text?.startsWith(APEX_MODALITY_ROUTING_PREFIX))
  ))
  assert.ok(route)
  scopedAgent.session.events.push({ type: 'user/message', data: route })
  assert.equal(shouldInjectModalityRouting(scopedAgent), false)

  const inspected = agent([
    ...visualEvidence,
    { type: 'tool/call', data: { name: 'apex_inspect_image', callId: 'vision-1', arguments: '{}' } },
  ])
  assert.equal(shouldInjectModalityRouting(inspected), false)
})

test('two completed expensive Shell calls trigger one durable pre-artifact checkpoint', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = [
    ...timedShellCall('compute-1', 1_000, 12_000),
    ...timedShellCall('compute-2', 20_000, 31_000),
  ]
  writeFileSync(join(root, '.DS_Store'), 'Finder metadata is not a deliverable')
  assert.equal(shouldInjectComputeCheckpoint(agent(calls.slice(0, 2), root)), false)
  assert.equal(shouldInjectComputeCheckpoint(agent(calls, root)), true)
  assert.match(computeCheckpointText(), /not a wall-clock, task-wide tool, or internal-reasoning limit/i)
  assert.match(computeCheckpointText(), /primary user-visible outcome/i)
  assert.match(computeCheckpointText(), /one further computation-only Shell call/i)
  assert.match(computeCheckpointText(), /Each such mutation grants one provisional computation-only lease/i)
  assert.match(computeCheckpointText(), /No-op rewrites do not renew the lease/i)
  assert.match(computeCheckpointText(), /Shell that directly writes the implementation remain available/i)

  const alreadyInjected = {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: `${APEX_COMPUTE_CHECKPOINT_PREFIX}\nalready shown` }],
      source: { kind: 'plugin', plugin: 'apex-policy-v063', form: 'instructions' },
    },
  }
  assert.equal(shouldInjectComputeCheckpoint(agent([...calls, alreadyInjected], root)), false)
})

test('the compute checkpoint allows one focused blocker result then requires implementation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-transition-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const checkpoint = computeCheckpointEvent()
  const beforeResult = agent([checkpoint], root)
  const firstCompute = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py' },
    agent: beforeResult,
  }
  assert.equal(preArtifactComputeTransition(beforeResult).implementationRequired, false)
  assert.equal(preImplementationComputeDenial(firstCompute), undefined)
  assert.equal(guardExecution(firstCompute), undefined)

  const afterResult = agent([
    checkpoint,
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  const repeatedCompute = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py --refine' },
    agent: afterResult,
  }
  assert.deepEqual(preArtifactComputeTransition(afterResult), {
    checkpointed: true,
    blockerCompletions: 1,
    implementationMutations: 0,
    leaseCompletions: 0,
    implementationRequired: true,
  })
  assert.equal(preImplementationComputeDenial(repeatedCompute), PRE_IMPLEMENTATION_COMPUTE_REASON)
  assert.equal(guardExecution(repeatedCompute), PRE_IMPLEMENTATION_COMPUTE_REASON)
  assert.equal(shouldInjectImplementationTransition(afterResult), true)
  assert.match(implementationTransitionText(), /focused blocking computation has completed/i)
  assert.match(implementationTransitionText(), /Internal reasoning remains unrestricted/i)
  assert.match(implementationTransitionText(), /next external action must make a content-changing Workspace implementation mutation/i)
  assert.match(implementationTransitionText(), /Temporary helper files.*do not satisfy this transition/i)
})

test('the implementation transition is injected once and clears after a real mutation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-implementation-transition-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const afterResult = agent([
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  const listener = policyPreStepListener()
  const signal = new AbortController().signal
  const decision = await listener(
    { agent: afterResult, step: 3, signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const transition = decision.messages.find(message => (
    message.content?.some(block => block.text?.startsWith(APEX_IMPLEMENTATION_TRANSITION_PREFIX))
  ))
  assert.ok(transition)

  afterResult.session.events.push({ type: 'user/message', data: transition })
  assert.equal(shouldInjectImplementationTransition(afterResult), false)

  const mutated = agent([
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
    implementationMutationEvent('write-1'),
  ], root)
  assert.equal(shouldInjectImplementationTransition(mutated), false)
})

test('failed blocker computation does not consume the post-checkpoint result', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-failure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([
    computeCheckpointEvent(),
    ...timedShellCall('failed-blocker', 1_000, 1_200, true, 'python3 candidate.py'),
  ], root)
  const execution = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py --corrected' },
    agent: scopedAgent,
  }
  assert.equal(preArtifactComputeTransition(scopedAgent).blockerCompletions, 0)
  assert.equal(guardExecution(execution), undefined)
})

test('switching interpreter families cannot bypass the implementation transition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-family-switch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([
    computeCheckpointEvent(),
    ...timedShellCall('python-blocker', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'node candidate.mjs' },
    agent: scopedAgent,
  }), PRE_IMPLEMENTATION_COMPUTE_REASON)
})

test('the implementation transition permits explicit Workspace writes from Shell and heredoc scripts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-write-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  const directWrite = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: {
      command: process.platform === 'win32'
        ? "Set-Content -LiteralPath index.html -Value '<!doctype html><title>Model</title>'"
        : "printf '%s' '<!doctype html><title>Model</title>' > index.html",
    },
    agent: scopedAgent,
  }
  const scriptWrite = {
    name: 'bash',
    arguments: {
      command: "python3 - <<'PY'\nfrom pathlib import Path\nPath('index.html').write_text('<!doctype html>')\nPY",
    },
    agent: scopedAgent,
  }
  assert.equal(workspaceMutationIntent(directWrite), true)
  assert.equal(guardExecution(directWrite), undefined)
  assert.equal(workspaceMutationIntent(scriptWrite), true)
  assert.equal(guardExecution(scriptWrite), undefined)
})

test('a temporary solver script is not mistaken for Workspace implementation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-temp-script-'))
  const scratch = join(tmpdir(), 'apex-v063-searchsa.py')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  const execution = {
    name: 'bash',
    arguments: {
      command: `cat > '${scratch}' <<'PY'\nprint('another grid search')\nPY\npython3 '${scratch}'`,
    },
    agent: scopedAgent,
  }
  assert.equal(workspaceMutationIntent(execution), false)
  assert.equal(guardExecution(execution), PRE_IMPLEMENTATION_COMPUTE_REASON)

  const inlineComparison = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'node -e "console.log(2 > 1)"' },
    agent: scopedAgent,
  }
  assert.equal(workspaceMutationIntent(inlineComparison), false)
  assert.equal(guardExecution(inlineComparison), PRE_IMPLEMENTATION_COMPUTE_REASON)
})

test('a bare artifact cannot permanently release the post-checkpoint gate', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prior = [
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ]
  writeFileSync(join(root, 'index.html'), '<!doctype html>')
  const artifactAgent = agent(prior, root)
  assert.equal(preArtifactComputeTransition(artifactAgent).implementationRequired, true)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'node verify.mjs' },
    agent: artifactAgent,
  }), PRE_IMPLEMENTATION_COMPUTE_REASON)
})

test('each content mutation grants one provisional compute lease', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-lease-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prior = [
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
  ]
  const firstMutation = agent([
    ...prior,
    implementationMutationEvent('create-1'),
  ], root)
  assert.deepEqual(preArtifactComputeTransition(firstMutation), {
    checkpointed: true,
    blockerCompletions: 1,
    implementationMutations: 1,
    leaseCompletions: 0,
    implementationRequired: false,
  })
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'node verify.mjs' },
    agent: firstMutation,
  }), undefined)

  const consumed = agent([
    ...firstMutation.session.events,
    ...timedShellCall('lease-1', 2_000, 2_200, false, 'node verify.mjs'),
  ], root)
  assert.equal(preArtifactComputeTransition(consumed).leaseCompletions, 1)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py --again' },
    agent: consumed,
  }), PROVISIONAL_IMPLEMENTATION_COMPUTE_REASON)

  const noOpToolSuccess = agent([
    ...consumed.session.events,
    ...successfulCall('str_replace_editor', 'noop-edit'),
  ], root)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py --still-blocked' },
    agent: noOpToolSuccess,
  }), PROVISIONAL_IMPLEMENTATION_COMPUTE_REASON)

  const renewed = agent([
    ...noOpToolSuccess.session.events,
    implementationMutationEvent('edit-2'),
  ], root)
  assert.equal(preArtifactComputeTransition(renewed).implementationMutations, 2)
  assert.equal(preArtifactComputeTransition(renewed).leaseCompletions, 0)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 candidate.py --new-gap' },
    agent: renewed,
  }), undefined)
})

test('a computation call that directly changes the deliverable does not consume its own lease', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-write-lease-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const call = timedShellCall(
    'write-1',
    2_000,
    2_200,
    false,
    "python3 -c \"open('index.html','w').write('implemented')\"",
  )
  call[1] = { ...implementationMutationEvent('write-1'), time: 2_200 }
  const scopedAgent = agent([
    computeCheckpointEvent(),
    ...timedShellCall('blocker-1', 1_000, 1_200, false, 'python3 candidate.py'),
    ...call,
  ], root)
  const transition = preArtifactComputeTransition(scopedAgent)
  assert.equal(transition.implementationMutations, 1)
  assert.equal(transition.leaseCompletions, 0)
  assert.equal(transition.implementationRequired, false)
})

test('mutation recording requires a successful target byte change', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-mutation-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([], root)
  const execution = {
    name: 'str_replace_editor',
    callId: 'create-1',
    arguments: { command: 'create', path: 'index.html' },
    agent: scopedAgent,
  }
  const success = { isError: false, value: null, content: [] }

  await recordImplementationMutation(execution, async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    return success
  })
  const created = await stampImplementationMutation(execution, success, async () => ({ kind: 'accept' }))
  assert.deepEqual(created.content, [{ type: 'text', text: IMPLEMENTATION_MUTATION_MARKER }])

  execution.callId = 'noop-2'
  await recordImplementationMutation(execution, async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    return success
  })
  assert.deepEqual(
    await stampImplementationMutation(execution, success, async () => ({ kind: 'accept' })),
    { kind: 'accept' },
  )

  execution.callId = 'edit-3'
  await recordImplementationMutation(execution, async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><main>real slice</main>')
    return success
  })
  assert.deepEqual(
    (await stampImplementationMutation(execution, success, async () => ({ kind: 'accept' }))).content,
    [{ type: 'text', text: IMPLEMENTATION_MUTATION_MARKER }],
  )

  const heredocExecution = {
    name: BOOTSTRAP_TOOLS[0],
    callId: 'heredoc-4',
    arguments: { command: "cat > index.html <<'EOF'\n<!doctype html><main>larger slice</main>\nEOF" },
    agent: scopedAgent,
  }
  await recordImplementationMutation(heredocExecution, async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><main>larger slice</main>\n')
    return success
  })
  assert.deepEqual(
    (await stampImplementationMutation(heredocExecution, success, async () => ({ kind: 'accept' }))).content,
    [{ type: 'text', text: IMPLEMENTATION_MUTATION_MARKER }],
  )

  execution.callId = 'failed-5'
  const failure = { isError: true, error: { message: 'failed' }, content: [] }
  await recordImplementationMutation(execution, async () => {
    writeFileSync(join(root, 'index.html'), '<!doctype html><main>partial failure</main>')
    return failure
  })
  assert.deepEqual(
    await stampImplementationMutation(execution, failure, async () => ({ kind: 'accept' })),
    { kind: 'accept' },
  )
})

test('compaction does not reset the durable compute transition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-compaction-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([
    computeCheckpointEvent(),
    { type: 'compaction/end', data: {} },
    ...timedShellCall('blocker-after-compaction', 1_000, 1_200, false, 'python3 candidate.py'),
  ], root)
  assert.equal(preArtifactComputeTransition(scopedAgent).implementationRequired, true)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'ruby candidate.rb' },
    agent: scopedAgent,
  }), PRE_IMPLEMENTATION_COMPUTE_REASON)
})

test('repeated short interpreter calculations trigger the same pre-artifact checkpoint', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-short-compute-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = Array.from({ length: COMPUTE_CHECKPOINT_SHORT_COMPLETIONS }, (_, index) => (
    timedShellCall(`short-compute-${index}`, index * 1_000, index * 1_000 + 200)
  )).flat()

  assert.equal(shouldInjectComputeCheckpoint(agent(calls.slice(0, -2), root)), false)
  assert.equal(shouldInjectComputeCheckpoint(agent(calls, root)), true)
})

test('satisfied Vision evidence accelerates only later repeated computation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-visual-compute-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const evidence = visualEvent({ verdict: 'pass', targetStatus: 'met' })
  const calls = Array.from(
    { length: COMPUTE_CHECKPOINT_VISUAL_EVIDENCE_COMPLETIONS },
    (_, index) => timedShellCall(`visual-compute-${index}`, index * 1_000, index * 1_000 + 200),
  ).flat()

  assert.equal(shouldInjectComputeCheckpoint(agent([evidence, ...calls.slice(0, -2)], root)), false)
  assert.equal(shouldInjectComputeCheckpoint(agent([evidence, ...calls], root)), true)
  assert.equal(shouldInjectComputeCheckpoint(agent([...calls, evidence], root)), false)
  assert.equal(shouldInjectComputeCheckpoint(agent([
    visualEvent({ verdict: 'pass', targetStatus: 'uncertain' }),
    ...calls,
  ], root)), false)
})

test('short calculations from different interpreter families do not look like one repeated solver loop', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-mixed-compute-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = Array.from({ length: COMPUTE_CHECKPOINT_SHORT_COMPLETIONS }, (_, index) => (
    timedShellCall(
      `mixed-compute-${index}`,
      index * 1_000,
      index * 1_000 + 200,
      false,
      index % 2 === 0 ? 'node candidate.mjs' : 'ruby candidate.rb',
    )
  )).flat()

  assert.equal(shouldInjectComputeCheckpoint(agent(calls, root)), false)
})

test('the compute checkpoint ignores failed calls and successful edits, but not pre-existing inputs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-compute-checkpoint-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const oneSuccessOneFailure = [
    ...timedShellCall('compute-1', 1_000, 12_000),
    ...timedShellCall('compute-2', 20_000, 31_000, true),
  ]
  assert.equal(shouldInjectComputeCheckpoint(agent(oneSuccessOneFailure, root)), false)

  const calls = [
    ...timedShellCall('compute-1', 1_000, 12_000),
    ...timedShellCall('compute-2', 20_000, 31_000),
  ]
  writeFileSync(join(root, 'reference'), 'pre-existing task input')
  assert.equal(shouldInjectComputeCheckpoint(agent(calls, root)), true)

  const edit = [
    { type: 'tool/call', data: { name: 'write', callId: 'write-1', arguments: JSON.stringify({ file_path: 'candidate.txt' }) } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'write-1',
            isError: false,
            content: [{ type: 'text', text: 'ok' }],
          }],
        },
      },
    },
  ]
  assert.equal(shouldInjectComputeCheckpoint(agent([...calls, ...edit], root)), false)
})

test('Shell cannot redraw a host browser screenshot but may inspect its immutable bytes', () => {
  const scopedAgent = agent([
    validationEvent(
      { check_id: 'visual', assertion: 'The page renders.', root: '.' },
      'final',
      'passed',
      digest('artifact'),
      { screenshotPath: '.apex-evidence/web-visual-01.png' },
    ),
  ])
  const redraw = `python3 - <<'PY'\nfrom PIL import Image\nimage = Image.open('.apex-evidence/web-visual-01.png')\nimage.crop((0, 0, 640, 480)).save('.apex-evidence/crop.png')\nPY`

  assert.equal(isHostEvidenceImageTransformCommand(redraw, scopedAgent), true)
  assert.equal(
    guardExecution({ name: 'bash', arguments: { command: redraw }, agent: scopedAgent }),
    HOST_EVIDENCE_TRANSFORM_REASON,
  )
  assert.match(HOST_EVIDENCE_TRANSFORM_REASON, /immutable browser evidence/i)
  assert.equal(
    isHostEvidenceImageTransformCommand('shasum .apex-evidence/web-visual-01.png', scopedAgent),
    false,
  )
  assert.equal(
    isHostEvidenceImageTransformCommand('python3 -c "print(sum(range(100)))"', scopedAgent),
    false,
  )
})

test('workspace shell scanning distinguishes awk regexes from external file operands', () => {
  const scopedAgent = agent()
  const reportCount = String.raw`wc -l RESEARCH_REPORT.md; awk '{n+=gsub(/[^\x00-\x7F]/,""); ascii+=gsub(/[ -~]/,""); total+=length($0)} END{print "chars",total,"non_ascii",n,"ascii",ascii}' RESEARCH_REPORT.md; python3 - <<'PY'
from pathlib import Path
text = Path('RESEARCH_REPORT.md').read_text()
print(len(text))
PY`

  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: reportCount }, agent: scopedAgent,
  }), undefined)
  for (const command of [
    "awk '{ print $1 }' /etc/passwd",
    `awk 'BEGIN { print "/etc/passwd" }'`,
  ]) {
    assert.equal(workspaceShellDenial({
      name: 'bash', arguments: { command }, agent: scopedAgent,
    }), WORKSPACE_SHELL_REASON, command)
  }
})

test('workspace shell scanning permits sed address regexes without hiding file operands', () => {
  const scopedAgent = agent()
  const extraction = String.raw`sed -n '/<script>/,/<\/script>/p' double-wishbone-suspension.html | sed '1d;$d' > script_check.js`
  const generatedThenExtracted = String.raw`cat > double-wishbone-suspension.html <<'EOF'
<script>const example = "/not/a/filesystem-target";</script>
EOF
sed -n '/<script>/,/<\/script>/p' double-wishbone-suspension.html | sed '1d;$d' > script_check.js`

  for (const command of [extraction, generatedThenExtracted]) {
    assert.equal(workspaceShellDenial({
      name: 'bash', arguments: { command }, agent: scopedAgent,
    }), undefined, command)
  }
  for (const command of [
    String.raw`sed -n '/token/r /etc/passwd' local.txt`,
    'sed -f /etc/sed-script local.txt',
    String.raw`sed -e '/token/w /etc/output' local.txt`,
    String.raw`sed '/outside/' local.txt; cat /outside/`,
  ]) {
    assert.equal(workspaceShellDenial({
      name: 'bash', arguments: { command }, agent: scopedAgent,
    }), WORKSPACE_SHELL_REASON, command)
  }
})

test('workspace shell scanning recognizes environment-prefixed interpreter heredocs', () => {
  const scopedAgent = agent()
  const scratch = join(tmpdir(), 'apex-v063-scipkg')
  const calculation = `PYTHONPATH=${scratch} python3 - <<'PY'
import numpy as np
e = (left - right) / np.linalg.norm(left - right)
print(e)
PY`

  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: calculation }, agent: scopedAgent,
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash',
    arguments: {
      command: `PYTHONPATH=${scratch} python3 - <<'PY'\nopen('/etc/passwd').read()\nPY`,
    },
    agent: scopedAgent,
  }), WORKSPACE_SHELL_REASON)
})

test('workspace shell permits trusted absolute executables only in command position', () => {
  const scopedAgent = agent()
  const runtime = JSON.stringify(process.execPath)
  const calculation = `${runtime} --input-type=module - <<'JS'
console.log(1 / Math.max(1, 2))
JS`

  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: calculation }, agent: scopedAgent,
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: `${runtime} /etc/passwd` }, agent: scopedAgent,
  }), WORKSPACE_SHELL_REASON)
})

test('persistent shell nonzero markers become canonical tool failures', async () => {
  const success = {
    isError: false,
    value: 'failed check',
    content: [{ type: 'text', text: 'failed check\n[exit code: 1]' }],
  }
  const failed = await normalizeShellExit({ name: 'bash' }, async () => success)
  assert.equal(failed.isError, true)
  assert.equal(failed.error.info.code, 'SHELL_EXIT_NONZERO')
  assert.equal(failed.error.message, 'Shell command exited with code 1.')
  assert.equal(failed.content, success.content)

  const zero = { ...success, content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] }
  assert.equal(await normalizeShellExit({ name: 'bash' }, async () => zero), zero)
  assert.equal(await normalizeShellExit({ name: 'read' }, async () => success), success)
})

test('harmless browser probes are redirected without a failed Shell result', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-browser-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  const scopedAgent = agent([], root)
  const execution = {
    name: BOOTSTRAP_TOOLS[0],
    arguments: {
      command: `python3 -c "import importlib.util; print(importlib.util.find_spec('playwright'))"; command -v chromium; node -e "console.log('separate check')"`,
    },
    agent: scopedAgent,
  }
  assert.equal(guardExecution(execution), undefined)
  let delegated = false
  const redirected = await redirectBrowserProbeExecution(execution, async () => {
    delegated = true
    return { isError: false }
  })
  assert.equal(delegated, false)
  assert.equal(redirected.isError, false)
  assert.equal(typeof redirected.value, 'string')
  assert.match(redirected.content[0].text, new RegExp(WEB_VALIDATION_PROBE_REDIRECT_PREFIX))
  assert.match(redirected.content[0].text, /non-browser checks bundled into it also did not run/i)
  assert.match(redirected.content[0].text, /call apex_validate_web directly/i)

  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'python3 -m pip install playwright -q' },
    agent: scopedAgent,
  }), WEB_VALIDATION_DISCOVERY_REASON)
})

test('relative editor paths resolve beneath the declared Workspace without a retry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-editor-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([], root)
  const token = Object.freeze({})
  const execution = {
    name: 'str_replace_editor',
    callId: 'editor-relative',
    rootCallId: 'editor-relative',
    token,
    arguments: { command: 'create', path: 'index.html', file_text: '<main>ok</main>' },
    agent: scopedAgent,
    signal: new AbortController().signal,
  }
  let delegated = false
  const result = await resolveWorkspaceEditorPathExecution(async nested => {
    assert.equal(nested.name, 'str_replace_editor')
    assert.equal(nested.callId, 'editor-relative:apex-workspace-path')
    assert.equal(nested.parent, token)
    assert.equal(nested.arguments.path, join(root, 'index.html'))
    return { isError: false, value: 'created', content: [] }
  }, execution, async () => {
    delegated = true
    return { isError: false, value: 'unexpected', content: [] }
  })
  assert.equal(delegated, false)
  assert.equal(result.value, 'created')

  const absolute = { ...execution, arguments: { ...execution.arguments, path: join(root, 'index.html') } }
  await resolveWorkspaceEditorPathExecution(async () => {
    throw new Error('absolute paths must not be redispatched')
  }, absolute, async () => {
    delegated = true
    return { isError: false, value: 'direct', content: [] }
  })
  assert.equal(delegated, true)
})

test('artifact hashes exclude only exact evidence paths and detect workspace pollution', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-artifact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<canvas></canvas>')
  writeFileSync(join(root, 'proof.png'), 'first-proof')
  const scopedAgent = agent([], root)

  const first = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  writeFileSync(join(root, 'proof.png'), 'second-proof')
  const screenshotOnly = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  assert.equal(screenshotOnly.hash, first.hash)

  mkdirSync(join(root, '.apex-evidence'))
  writeFileSync(join(root, '.apex-evidence', 'automatic.png'), 'host-captured-proof')
  const automaticEvidence = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  assert.notEqual(automaticEvidence.hash, first.hash)
  assert.equal(automaticEvidence.files.some(file => file.path === '.apex-evidence/automatic.png'), true)

  writeFileSync(join(root, 'index.html'), '<canvas data-version="2"></canvas>')
  const changed = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  assert.notEqual(changed.hash, first.hash)
})

test('the host selects validation stages across human repair turns from artifact hashes', () => {
  const args = {
    check_id: 'runtime',
    assertion: 'The page loads with one visible canvas and no runtime errors.',
    root: '.',
    require_canvas: true,
  }
  assert.deepEqual(validationPlan(args, agent(), 'artifact-a'), { mode: 'baseline' })

  const baseline = validationEvent(args, 'baseline', 'passed', 'artifact-a')
  assert.deepEqual(validationPlan(args, agent([baseline, human()]), 'artifact-a'), {
    mode: 'none',
    denial: 'Reuse the latest passed Web evidence while the artifact hash is unchanged.',
  })
  assert.deepEqual(validationPlan(args, agent([baseline, human()]), 'artifact-b'), { mode: 'final' })

  const final = validationEvent(args, 'final', 'passed', 'artifact-b')
  assert.deepEqual(
    validationPlan(args, agent([baseline, final, human('The camera clips through the frame.')]), 'artifact-c'),
    { mode: 'repair-proof' },
  )

  let tool
  applyValidation({
    tools: { register(value) { tool = value; return () => {} } },
    subprocess: {},
  })
  assert.equal(tool.parameters.properties.mode, undefined)
  assert.deepEqual(tool.parameters.required.sort(), ['assertion', 'check_id', 'interaction_required', 'root'])
  assert.match(tool.description, /host selects the stage/i)
  assert.match(tool.description, /assertion is a descriptive label, not executable automation/i)
  assert.deepEqual(tool.parameters.properties.text_checks.items.required, ['phase', 'selector', 'contains'])
})

test('repair proof admission follows changed evidence instead of a fixed round cap', () => {
  const args = {
    check_id: 'runtime-open-ended',
    assertion: 'The page remains usable after each evidence-backed repair.',
    root: '.',
  }
  const events = [validationEvent(args, 'final', 'passed', 'artifact-0')]
  for (let index = 1; index <= 4; index += 1) {
    events.push(human(`Repair evidence ${index}.`))
    events.push(...successfulCall('str_replace_editor', `repair-${index}`))
    events.push(validationEvent(args, 'repair-proof', 'passed', `artifact-${index}`))
  }
  events.push(human('A fifth concrete defect is visible.'))
  events.push(...successfulCall('str_replace_editor', 'repair-5'))

  assert.deepEqual(
    validationPlan(args, agent(events), 'artifact-5'),
    { mode: 'repair-proof' },
  )
})

test('interaction validation requires a concrete action and reports failed DOM text checks', () => {
  assert.match(
    interactionContractDenial({ interaction_required: true }),
    /needs click_selector, click_canvas=true, or at least one bounded key interaction/i,
  )
  assert.equal(
    interactionContractDenial({ interaction_required: true, click_selector: '#finish-button' }),
    undefined,
  )
  assert.equal(interactionContractDenial({ interaction_required: false }), undefined)
  assert.deepEqual(textCheckFailures([
    { phase: 'before', selector: '#status', contains: '待机', observed: '待机', passed: true },
    { phase: 'after', selector: '#status', contains: '已完成', observed: '待机', passed: false },
  ]), ['after:#status expected text containing "已完成"'])
})

test('selector clicks and phased DOM text checks use bounded DevTools actions', async () => {
  const calls = []
  const client = {
    async send(method, params) {
      calls.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { value: { x: 40, y: 30 } } }
      return {}
    },
  }
  const interactions = await dispatchInteractions(client, {
    click_selector: '#finish-button',
    interactions: [{ key: 'Space', hold_ms: 0 }],
  }, new AbortController().signal)
  assert.deepEqual(interactions, ['click_selector:#finish-button', 'Space:0ms'])
  assert.deepEqual(calls.map(call => call.method), [
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
  ])

  const observations = [{
    phase: 'after', selector: '#status', contains: '已完成', observed: '已完成', passed: true,
  }]
  const textClient = {
    async send(method, params) {
      assert.equal(method, 'Runtime.evaluate')
      assert.match(params.expression, /#status/)
      return { result: { value: observations } }
    },
  }
  assert.deepEqual(await inspectTextChecks(textClient, [{
    phase: 'after', selector: '#status', contains: '已完成',
  }], 'after'), observations)
})

test('Web validation allocates a fresh automatic real-browser evidence path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-auto-screenshot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scopedAgent = agent([], root)
  const args = { check_id: 'runtime view', assertion: 'The page renders.', root: '.' }

  const first = '.apex-evidence/web-runtime-view-01.png'
  assert.equal(await validationScreenshotPath(scopedAgent, args), first)
  const physical = hostEvidencePath(scopedAgent, first)
  assert.ok(physical)
  assert.equal(physical.startsWith(root), false)
  t.after(() => rmSync(dirname(physical), { recursive: true, force: true }))
  mkdirSync(dirname(physical), { recursive: true })
  writeFileSync(physical, 'host capture')
  assert.equal(
    await validationScreenshotPath(scopedAgent, args),
    '.apex-evidence/web-runtime-view-02.png',
  )
  assert.equal(hasWorkspaceArtifact(scopedAgent), false)
  assert.equal(
    await validationScreenshotPath(scopedAgent, {
      ...args,
      screenshot_path: '.apex-evidence/custom.png',
    }),
    '.apex-evidence/custom.png',
  )
  assert.equal(
    await validationScreenshotPath(scopedAgent, {
      ...args,
      screenshot_path: 'custom.png',
    }),
    '.apex-evidence/custom.png',
  )
  const custom = hostEvidencePath(scopedAgent, '.apex-evidence/custom.png')
  assert.ok(custom)
  writeFileSync(custom, 'first custom capture')
  assert.equal(
    await validationScreenshotPath(scopedAgent, {
      ...args,
      screenshot_path: 'custom.png',
    }),
    '.apex-evidence/custom-02.png',
  )
  await assert.rejects(
    validationScreenshotPath(scopedAgent, { ...args, screenshot_path: 'proof/custom.png' }),
    /\.apex-evidence\/\*\.png/,
  )
  await assert.rejects(
    validationScreenshotPath(scopedAgent, { ...args, screenshot_path: '..\\custom.png' }),
    /\.apex-evidence\/\*\.png/,
  )
})

test('validation screenshots become stale after a Bash-like file mutation without editor events', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-stale-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>version one</main>')
  const screenshot = Buffer.from('captured-image')
  writeFileSync(join(root, 'proof.png'), screenshot)
  const scopedAgent = agent([], root)
  const artifact = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  const screenshotHash = createHash('sha256').update(screenshot).digest('hex')
  const args = { check_id: 'visual', assertion: 'The page renders.', root: '.' }
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', artifact.hash, {
    screenshotPath: 'proof.png',
    screenshotHash,
  }))

  assert.equal(await validationScreenshotDenial(scopedAgent, ['proof.png']), undefined)
  writeFileSync(join(root, 'index.html'), '<main>version two</main>')
  assert.equal(
    await validationScreenshotDenial(scopedAgent, ['proof.png']),
    STALE_VALIDATION_SCREENSHOT_REASON,
  )
})

test('a pending host capture accepts only itself plus an unchanged earlier-inspected reference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-host-capture-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<canvas></canvas>')
  writeFileSync(join(root, 'proof.png'), 'real-browser-capture')
  writeFileSync(join(root, 'reference.png'), 'original-reference')
  writeFileSync(join(root, 'repaint.png'), 'synthetic-preview')
  const scopedAgent = agent([], root)
  const [referenceSnapshot] = await imageSnapshots(scopedAgent, ['reference.png'])
  scopedAgent.session.events.push(visualEvent({
    artifactHash: digest(JSON.stringify([referenceSnapshot])),
    imagePaths: ['reference.png'],
    verdict: 'pass',
  }))
  const artifact = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  const args = { check_id: 'visual', assertion: 'The page renders.', root: '.' }
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', artifact.hash, {
    screenshotPath: 'proof.png',
    screenshotHash: digest('real-browser-capture'),
  }))

  assert.match(
    await validationScreenshotDenial(scopedAgent, ['repaint.png']),
    new RegExp(PENDING_VALIDATION_SCREENSHOT_REASON.split('.')[0]),
  )
  assert.match(
    await validationScreenshotDenial(scopedAgent, ['missing-repaint.png']),
    /fresh host-captured Web screenshot awaiting inspection/i,
  )
  assert.match(
    await validationScreenshotDenial(scopedAgent, ['proof.png', 'repaint.png']),
    /unreviewed, recreated, synthetic, or repainted preview/i,
  )
  assert.equal(await validationScreenshotDenial(scopedAgent, ['proof.png']), undefined)
  assert.equal(
    await validationScreenshotDenial(scopedAgent, ['reference.png', 'proof.png']),
    undefined,
  )
  writeFileSync(join(root, 'reference.png'), 'changed-after-review')
  assert.match(
    await validationScreenshotDenial(scopedAgent, ['reference.png', 'proof.png']),
    /paired only with an unchanged workspace reference/i,
  )
})

test('Vision gives its read-only child the host evidence path without workspace pollution', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-host-evidence-view-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  const scopedAgent = agent([], root)
  scopedAgent.session.header.id = 'host-evidence-materialization'
  const logicalPath = '.apex-evidence/web-visual-01.png'
  const physicalPath = hostEvidencePath(scopedAgent, logicalPath)
  assert.ok(physicalPath)
  t.after(() => rmSync(dirname(physicalPath), { recursive: true, force: true }))
  mkdirSync(dirname(physicalPath), { recursive: true })
  writeFileSync(physicalPath, 'immutable-host-capture')
  const artifact = await artifactSnapshot(scopedAgent, '.')
  const args = { check_id: 'visual', assertion: 'The page renders.', root: '.' }
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', artifact.hash, {
    screenshotPath: logicalPath,
    screenshotHash: digest('immutable-host-capture'),
  }))

  let tool
  let observedInput
  applyVision({
    tools: { register(value) { tool = value; return () => {} } },
    subagents: {
      async start(_provider, request) {
        const line = request.prompt[0].text
          .split('\n')
          .find(value => value.startsWith('Image inputs: '))
        observedInput = JSON.parse(line.slice('Image inputs: '.length))[0]
        return {
          result: Promise.resolve({ structured: JSON.parse(passReport), stopReason: 'completed' }),
          async dispose() {},
        }
      },
    },
  })
  const result = await tool.execute({
    image_paths: [logicalPath],
    question: 'Is the primary page content visibly present?',
  }, { agent: scopedAgent, signal: new AbortController().signal })

  assert.equal(result.verdict, 'pass')
  assert.deepEqual(observedInput, {
    read_path: physicalPath,
    report_path: logicalPath,
    role: 'current',
  })
  assert.equal(readFileSync(physicalPath, 'utf8'), 'immutable-host-capture')
  assert.equal(existsSync(join(root, logicalPath)), false)
  assert.equal(existsSync(join(root, '.apex-evidence')), false)
  assert.equal((await artifactSnapshot(scopedAgent, '.')).fileCount, 1)
})

test('host screenshot evidence has explicit pending, repair, unresolved, closed, and task-reset states', () => {
  const args = { check_id: 'visual-state', assertion: 'The page renders.', root: '.' }
  const capture = validationEvent(args, 'final', 'passed', digest('artifact'), {
    screenshotPath: '.apex-evidence/web-visual-state-01.png',
  })
  const base = [human('Build the artifact.'), capture]
  assert.equal(currentWebVisualEvidenceState(agent(base)).kind, 'pending')

  const repair = visualEvent({
    imagePaths: ['.apex-evidence/web-visual-state-01.png'],
    verdict: 'repair',
    findings: [{ issueId: 'vision-layout', severity: 'blocking' }],
    resolvedIssueIds: [],
    remainingGaps: [],
  })
  const repairState = currentWebVisualEvidenceState(agent([...base, repair]))
  assert.equal(repairState.kind, 'repair')
  assert.deepEqual(repairState.openIssueIds, ['vision-layout'])

  const inconclusive = visualEvent({
    imagePaths: ['.apex-evidence/web-visual-state-01.png'],
    verdict: 'inconclusive',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: ['A second interaction state is missing.'],
  })
  assert.equal(currentWebVisualEvidenceState(agent([...base, inconclusive])).kind, 'pending')
  assert.equal(currentWebVisualEvidenceState(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-visual-state-01.png'],
    verdict: 'imported-invalid-value',
  })])).kind, 'pending')

  const unresolved = visualEvent({
    imagePaths: ['.apex-evidence/web-visual-state-01.png'],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: ['A second interaction state is missing.'],
  })
  assert.equal(currentWebVisualEvidenceState(agent([...base, unresolved])).kind, 'unresolved')

  const passed = visualEvent({
    imagePaths: ['.apex-evidence/web-visual-state-01.png'],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
  })
  assert.equal(currentWebVisualEvidenceState(agent([...base, passed])).kind, 'closed')
  assert.equal(
    currentWebVisualEvidenceState(agent([...base, passed, human('Inspect a separate reference.')])).kind,
    'none',
  )
})

test('the final evidence gate binds Web and requested Vision proof to the current artifact hash', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-final-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>generation one</main>')
  const scopedAgent = agent([
    human('Build and visually verify the page.'),
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    unlockEvent('apex_validate_web', 'apex_inspect_image'),
  ], root)
  const args = { check_id: 'final-evidence', assertion: 'The page renders.', root: '.' }
  const first = await artifactSnapshot(scopedAgent, '.')
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', first.hash))

  writeFileSync(join(root, 'index.html'), '<main>generation two</main>')
  const stale = await finalEvidenceGap(scopedAgent)
  assert.equal(stale.kind, 'web-evidence-stale')
  assert.match(finalEvidenceMessageText(stale), new RegExp(APEX_FINAL_EVIDENCE_PREFIX))

  const current = await artifactSnapshot(scopedAgent, '.')
  const screenshotPath = '.apex-evidence/web-final-evidence.png'
  scopedAgent.session.events.push(validationEvent(args, 'repair-proof', 'passed', current.hash, {
    screenshotPath,
    screenshotHash: digest('current-capture'),
  }))
  const pending = await finalEvidenceGap(scopedAgent)
  assert.equal(pending.kind, 'visual-evidence-pending')

  scopedAgent.session.events.push(visualEvent({
    imagePaths: [screenshotPath],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
  }))
  assert.equal(await finalEvidenceGap(scopedAgent), undefined)
})

test('the stop hook requests one continuation for an unchanged evidence gap', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-stop-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>validated</main>')
  const scopedAgent = agent([
    human('Build the page.'),
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    unlockEvent('apex_validate_web'),
  ], root)
  const args = { check_id: 'stop-evidence', assertion: 'The page renders.', root: '.' }
  const first = await artifactSnapshot(scopedAgent, '.')
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', first.hash))
  writeFileSync(join(root, 'index.html'), '<main>changed after validation</main>')

  let stopListener
  let preStepListener
  applyPolicy({
    tools: { register: () => () => {} },
    subagents: {},
    on(event, listener) {
      if (event === 'agent/turn-stopping') stopListener = listener
      if (event === 'agent/pre-step') preStepListener = listener
      return () => {}
    },
  })
  const steered = []
  scopedAgent.steer = (message) => {
    steered.push(message)
    scopedAgent.session.events.push({ type: 'user/message', data: message })
  }
  const signal = new AbortController().signal
  await stopListener({ agent: scopedAgent, signal })
  await stopListener({ agent: scopedAgent, signal })
  const retained = await preStepListener(
    { agent: scopedAgent, step: 2, signal },
    async () => ({ kind: 'enter', messages: [steered[0]] }),
  )

  assert.equal(steered.length, 1)
  assert.equal(retained.messages.includes(steered[0]), true)
  assert.match(steered[0].content[0].text, /web-evidence|workspace changed|current artifact generation/i)
})

test('the final evidence gate also invalidates an opened delivery contract after mutation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>checked delivery</main>')
  const scopedAgent = agent([
    human('Create the exact requested deliverable.'),
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    unlockEvent('apex_verify_delivery'),
  ], root)
  const checked = await artifactSnapshot(scopedAgent, '.')
  scopedAgent.session.events.push({
    type: 'tool/result',
    data: {
      meta: {
        kind: DELIVERY_META_KIND,
        contractHash: digest('contract'),
        artifactHash: checked.hash,
        artifactRoot: '.',
        status: 'passed',
        failedCheckIds: [],
      },
    },
  })
  writeFileSync(join(root, 'index.html'), '<main>changed after delivery proof</main>')

  const gap = await finalEvidenceGap(scopedAgent)
  assert.equal(gap.kind, 'delivery-evidence-stale')
})

test('unrecorded derivatives and settled host captures cannot become new visual evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-immutable-host-capture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.apex-evidence'))
  writeFileSync(join(root, 'index.html'), '<main>stable artifact</main>')
  writeFileSync(join(root, '.apex-evidence', 'web-visual-01.png'), 'host-capture')
  writeFileSync(join(root, '.apex-evidence', 'cropped.png'), 'derived-crop')
  const args = { check_id: 'visual', assertion: 'The page renders.', root: '.' }
  const screenshotPath = '.apex-evidence/web-visual-01.png'
  const scopedAgent = agent([
    human('Build the artifact.'),
    validationEvent(args, 'final', 'passed', digest('artifact'), {
      screenshotPath,
      screenshotHash: digest('host-capture'),
    }),
    visualEvent({
      imagePaths: [screenshotPath],
      verdict: 'pass',
      findings: [],
      resolvedIssueIds: [],
      remainingGaps: [],
    }),
  ], root)

  assert.equal(
    await validationScreenshotDenial(scopedAgent, ['.apex-evidence/cropped.png']),
    DERIVED_VALIDATION_EVIDENCE_REASON,
  )
  assert.equal(
    await validationScreenshotDenial(scopedAgent, [screenshotPath]),
    SETTLED_VALIDATION_SCREENSHOT_REASON,
  )
})

test('Vision caches exact evidence across compaction but permits every new question or artifact generation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-vision-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'view.png'), 'visual-state-one')
  const scopedAgent = agent([], root)
  const runtime = visionRuntime([passReport])
  const args = { image_paths: ['view.png'], question: 'Are the suspension links aligned?' }

  const first = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  scopedAgent.session.events.push(visualEvent(runtime.tool.output.presentationMeta(args, first)))
  scopedAgent.session.events.push({ type: 'compaction/end', data: {} })
  const duplicate = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(first.cached, false)
  assert.equal(duplicate.cached, true)
  assert.equal(runtime.starts.length, 1)
  assert.deepEqual(runtime.starts[0].request.agentOptions, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_VISION_MODEL,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })
  assert.equal(runtime.starts[0].request.persona, VISION_CHILD_PERSONA)
  assert.doesNotMatch(runtime.starts[0].request.persona, /inspect thoroughly/i)
  assert.deepEqual(runtime.starts[0].request.toolFilter.allow, ['read_image'])
  assert.deepEqual(runtime.starts[0].request.outputSchema, VISION_OUTPUT_SCHEMA)
  assert.deepEqual(
    runtime.starts[0].request.outputSchema.properties.findings.items.properties.severity_note,
    { type: 'string' },
  )
  assert.doesNotMatch(
    runtime.starts[0].request.outputSchema.properties.findings.items.required.join(','),
    /severity_note/,
  )
  assert.match(runtime.starts[0].request.prompt[0].text, /call read_image once for every read_path/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /call structured_output exactly once/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /nonblank render or present selector is not a pass/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /hides, clips, or dwarfs the primary subject/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /one root visible defect is one finding/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /do not report correct, normal, or unaffected UI and background as findings/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /normally return no more than 4 findings and 3 remaining gaps/i)
  assert.match(runtime.starts[0].request.prompt[0].text, /preserved_facts and regressions must both be empty arrays/i)
  assert.doesNotMatch(first.report, /Resolved issue ids:|Remaining evidence gaps:|Preserved visual facts:|New visual regressions:/)

  writeFileSync(join(root, 'view.png'), 'visual-state-two')
  const changed = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(changed.cached, false)
  assert.equal(changed.reviewMode, 'recheck')
  assert.equal(runtime.starts.length, 2)

  for (let index = 0; index < 6; index += 1) {
    await runtime.tool.execute({
      image_paths: ['view.png'],
      question: `Check independent visual state ${index}.`,
    }, { agent: scopedAgent, signal: new AbortController().signal })
  }
  assert.equal(runtime.starts.length, 8)
  assert.match(runtime.tool.description, /no session-wide Vision call limit/i)
  assert.match(runtime.tool.description, /not a visual-quality pass/i)
})

test('alpha.3 extensionless image paths defer media detection to the host read_image tool', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-extensionless-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'attachment'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  const runtime = visionRuntime([passReport])

  const result = await runtime.tool.execute({
    image_paths: ['attachment'],
    question: 'Is the supplied image visually readable?',
  }, {
    agent: agent([], root),
    signal: new AbortController().signal,
  })

  assert.equal(result.cached, false)
  assert.equal(runtime.starts.length, 1)
  assert.match(runtime.starts[0].request.prompt[0].text, /"read_path":"attachment"/)
  assert.match(runtime.starts[0].request.prompt[0].text, /"report_path":"attachment"/)
})

test('editor recovery follows the current host optional-null contract', () => {
  const invalid = { isError: true, error: { info: { code: 'INVALID_ARGS' } } }
  const objectRecovery = editorErrorRecovery({
    name: 'str_replace_editor',
    arguments: { command: 'view', path: 'index.html', view_range: null },
  }, invalid)
  assert.match(objectRecovery, /unused optional null placeholders are allowed/i)
  assert.doesNotMatch(objectRecovery, /omit.*null/i)

  const scalarRecovery = editorErrorRecovery({
    name: 'str_replace_editor',
    arguments: null,
  }, invalid)
  assert.match(scalarRecovery, /one JSON object/i)
  assert.match(scalarRecovery, /valid JSON value types/i)
})

test('editor whitespace mismatch returns the one exact matching source line', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-editor-whitespace-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<script>\n    const status = "ready";\n</script>\n')
  const result = {
    isError: true,
    error: { message: 'No replacement was performed, old_str did not appear verbatim.' },
    content: [],
  }
  const decision = await recoverEditorError({
    name: 'str_replace_editor',
    arguments: {
      command: 'str_replace',
      path: 'index.html',
      old_str: '      const status = "ready";',
      new_str: '    const status = "done";',
    },
    agent: agent([], root),
  }, result, async () => ({ kind: 'accept' }))

  assert.equal(decision.kind, 'accept')
  assert.match(decision.content[0].text, /smallest unique old_str/i)
  assert.match(decision.content[0].text, /omit leading indentation unless it is needed for uniqueness/i)
  assert.match(decision.content[0].text, /"    const status = \\"ready\\";"/)
  assert.match(decision.content[0].text, /do not use Shell/i)
  assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /const status = "ready"/)
})

test('editor multiline mismatch returns the one exact changed-line retry pair', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-editor-multiline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), [
    '#assembly {',
    '      left: calc(100% + 420px);',
    '      width: 760px;',
    '}',
    '',
  ].join('\n'))
  const result = {
    isError: true,
    error: { message: 'No replacement was performed, old_str did not appear verbatim.' },
    content: [],
  }
  const decision = await recoverEditorError({
    name: 'str_replace_editor',
    arguments: {
      command: 'str_replace',
      path: 'index.html',
      old_str: '    left: calc(100% + 420px);\n    width: 760px;',
      new_str: '    left: 50%;\n    width: 760px;',
    },
    agent: agent([], root),
  }, result, async () => ({ kind: 'accept' }))

  assert.equal(decision.kind, 'accept')
  assert.match(decision.content[0].text, /Exact single-line old_str: "      left: calc\(100% \+ 420px\);"/)
  assert.match(decision.content[0].text, /Corresponding single-line new_str: "      left: 50%;"/)
  assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /left: calc\(100% \+ 420px\)/)
})

test('a changed Web artifact permits fresh Vision evidence when screenshot bytes match', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-vision-generation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>generation one</main>')
  writeFileSync(join(root, 'proof.png'), 'same-visible-proof')
  const scopedAgent = agent([], root)
  const args = { check_id: 'visual-generation', assertion: 'The page renders.', root: '.' }
  const screenshotHash = digest('same-visible-proof')
  const firstArtifact = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', firstArtifact.hash, {
    screenshotPath: 'proof.png',
    screenshotHash,
  }))
  const runtime = visionRuntime([passReport])
  const query = { image_paths: ['proof.png'], question: 'Is the current layout visibly coherent?' }
  const first = await runtime.tool.execute(query, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.match(first.report, /Host evidence closure/i)
  assert.match(first.report, /stop calling tools and deliver/i)
  scopedAgent.session.events.push(visualEvent(runtime.tool.output.presentationMeta(query, first)))

  writeFileSync(join(root, 'index.html'), '<main>generation two</main>')
  const secondArtifact = await artifactSnapshot(scopedAgent, '.', ['proof.png'])
  scopedAgent.session.events.push(validationEvent(args, 'repair-proof', 'passed', secondArtifact.hash, {
    screenshotPath: 'proof.png',
    screenshotHash,
  }))
  const second = await runtime.tool.execute(query, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })

  assert.notEqual(second.artifactHash, first.artifactHash)
  assert.equal(second.cached, false)
  assert.equal(runtime.starts.length, 2)
})

test('a fresh host capture is compared with the latest reviewed compatible capture', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-vision-comparison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>generation one</main>')
  const scopedAgent = agent([human('Build and inspect the page.')], root)
  const args = { check_id: 'visual-comparison', assertion: 'The page renders.', root: '.' }
  const firstPath = '.apex-evidence/web-visual-comparison-01.png'
  const secondPath = '.apex-evidence/web-visual-comparison-02.png'
  let evidenceDirectory
  for (const [path, body] of [[firstPath, 'first-capture'], [secondPath, 'second-capture']]) {
    const physical = hostEvidencePath(scopedAgent, path)
    evidenceDirectory = dirname(physical)
    mkdirSync(dirname(physical), { recursive: true })
    writeFileSync(physical, body)
  }
  t.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }))

  const firstArtifact = await artifactSnapshot(scopedAgent, '.')
  scopedAgent.session.events.push(validationEvent(args, 'final', 'passed', firstArtifact.hash, {
    screenshotPath: firstPath,
    screenshotHash: digest('first-capture'),
  }))
  const comparisonPass = JSON.stringify({
    verdict: 'pass',
    target_status: 'met',
    answered_question: 'The current target remains legible without a new regression.',
    findings: [],
    resolved_issue_ids: [],
    remaining_gaps: [],
    preserved_facts: ['The primary subject remains centered and readable.'],
    regressions: [],
  })
  const runtime = visionRuntime([passReport, comparisonPass])
  const query = { image_paths: [firstPath], question: 'Is the primary subject visually coherent?' }
  const first = await runtime.tool.execute(query, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  scopedAgent.session.events.push(visualEvent(runtime.tool.output.presentationMeta(query, first)))

  writeFileSync(join(root, 'index.html'), '<main>generation two</main>')
  const secondArtifact = await artifactSnapshot(scopedAgent, '.')
  scopedAgent.session.events.push(validationEvent(args, 'repair-proof', 'passed', secondArtifact.hash, {
    screenshotPath: secondPath,
    screenshotHash: digest('second-capture'),
  }))
  const secondQuery = { ...query, image_paths: [secondPath] }
  const second = await runtime.tool.execute(secondQuery, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })

  assert.equal(second.comparisonBasePath, firstPath)
  assert.deepEqual(second.preservedFacts, ['The primary subject remains centered and readable.'])
  assert.equal(runtime.starts[1].request.prompt[0].text.includes('comparison-baseline'), true)
  assert.equal(runtime.starts[1].request.prompt[0].text.includes(firstPath), true)
  assert.equal(runtime.starts[1].request.prompt[0].text.includes(secondPath), true)
  assert.match(runtime.starts[1].request.prompt[0].text, /normally no more than 8/i)
  assert.doesNotMatch(runtime.starts[1].request.prompt[0].text, /preserved_facts and regressions must both be empty arrays/i)
})

test('Vision carries stable blocking issue ids into a focused repair recheck', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-vision-ledger-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'detail.png'), 'misaligned-state')
  const repair = JSON.stringify({
    verdict: 'repair',
    target_status: 'not-met',
    answered_question: 'The lower control arm visibly misses its chassis pickup.',
    findings: [{
      issue_id: '',
      image_path: 'detail.png',
      region: 'front lower pickup',
      severity: 'blocking',
      confidence: 0.96,
      observation: 'The control arm endpoint is separated from the chassis node.',
      inference: 'The kinematic linkage is visually disconnected.',
    }],
    resolved_issue_ids: [],
    remaining_gaps: [],
    preserved_facts: [],
    regressions: [],
  })
  const runtime = visionRuntime([repair, passReport])
  const scopedAgent = agent([], root)
  const args = { image_paths: ['detail.png'], question: 'Is the lower control arm connected correctly?' }
  const first = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  const issueId = first.findings[0].issueId
  scopedAgent.session.events.push(visualEvent(runtime.tool.output.presentationMeta(args, first)))
  writeFileSync(join(root, 'detail.png'), 'repaired-state')
  const resolved = JSON.stringify({
    verdict: 'pass',
    target_status: 'met',
    answered_question: 'The lower control arm now meets the chassis pickup.',
    findings: [],
    resolved_issue_ids: [issueId],
    remaining_gaps: [],
    preserved_facts: ['The chassis and wheel framing remain readable.'],
    regressions: [],
  })
  runtime.starts.length = 1
  const originalStart = runtime.starts
  let replacementTool
  applyVision({
    tools: { register(value) { replacementTool = value; return () => {} } },
    subagents: {
      async start(provider, request) {
        originalStart.push({ provider, request })
        return {
          result: Promise.resolve({ structured: JSON.parse(resolved), stopReason: 'completed' }),
          async dispose() {},
        }
      },
    },
  })
  const second = await replacementTool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(second.reviewMode, 'recheck')
  assert.deepEqual(second.resolvedIssueIds, [issueId])
  assert.match(originalStart.at(-1).request.prompt[0].text, new RegExp(issueId))
  assert.match(originalStart.at(-1).request.prompt[0].text, /reuse an earlier issue_id only for the same root defect/i)
})

test('Vision cannot pass while silently dropping an earlier blocking issue', () => {
  const prior = [{
    issueId: 'vision-0123456789ab',
    imagePath: 'detail.png',
    region: 'front lower pickup',
    severity: 'blocking',
    confidence: 0.9,
    observation: 'The endpoint is disconnected.',
    inference: 'The linkage is open.',
  }]
  const report = parseVisualReport(passReport, { imagePaths: ['detail.png'] }, prior)
  assert.equal(report.verdict, 'inconclusive')
  assert.match(report.remainingGaps[0], /did not explicitly resolve/i)
})

test('Vision preserves one issue id across fresh host screenshot paths', () => {
  const prior = [{
    issueId: 'vision-0123456789ab',
    imagePath: '.apex-evidence/web-old.png',
    region: 'accretion disk centerline',
    severity: 'blocking',
    confidence: 0.9,
    observation: 'A bright seam splits the disk.',
    inference: 'The current composite is discontinuous.',
  }]
  const report = parseVisualReport(JSON.stringify({
    verdict: 'repair',
    target_status: 'not-met',
    answered_question: 'The same seam remains in the new capture.',
    findings: [{
      issue_id: prior[0].issueId,
      image_path: '.apex-evidence/web-current.png',
      region: 'accretion disk centerline',
      severity: 'blocking',
      confidence: 0.95,
      observation: 'The bright seam is still visible.',
      inference: 'The attempted repair did not close the original defect.',
    }],
    resolved_issue_ids: [],
    remaining_gaps: [],
    preserved_facts: ['The black-hole silhouette remains centered.'],
    regressions: [],
  }), { imagePaths: ['.apex-evidence/web-current.png'] }, prior)

  assert.equal(report.verdict, 'repair')
  assert.equal(report.findings[0].issueId, prior[0].issueId)
})

test('Vision bounds verbose but otherwise valid evidence instead of discarding it', () => {
  const report = parseVisualReport(JSON.stringify({
    verdict: 'pass',
    target_status: 'met',
    answered_question: 'a'.repeat(700),
    findings: [{
      issue_id: '',
      image_path: 'detail.png',
      region: 'r'.repeat(300),
      severity: 'quality',
      confidence: 0.9,
      observation: 'o'.repeat(700),
      inference: 'i'.repeat(700),
    }],
    resolved_issue_ids: [],
    remaining_gaps: ['g'.repeat(700)],
    preserved_facts: ['p'.repeat(700)],
    regressions: [],
  }), { imagePaths: ['detail.png'] })

  assert.equal(report.verdict, 'pass')
  assert.equal(report.answeredQuestion.length, 600)
  assert.equal(report.findings[0].region.length, 240)
  assert.equal(report.findings[0].observation.length, 600)
  assert.equal(report.findings[0].inference.length, 600)
  assert.equal(report.remainingGaps[0].length, 600)
})

test('contradictory visual evidence selects a focused resolver query', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-vision-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'view.png'), 'same-artifact-view')
  const args = { image_paths: ['view.png'], question: 'Is the wheel visibly aligned?' }
  const seedRuntime = visionRuntime([passReport])
  const seedAgent = agent([], root)
  const seed = await seedRuntime.tool.execute(args, {
    agent: seedAgent,
    signal: new AbortController().signal,
  })
  const common = {
    imagePaths: ['view.png'],
    answeredQuestion: 'Prior evidence.',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
    questionKey: seed.questionKey,
    artifactHash: seed.artifactHash,
    reviewMode: 'inspect',
    cached: false,
  }
  const blockingFinding = {
    issueId: 'vision-abcdef012345',
    imagePath: 'view.png',
    region: 'front wheel',
    severity: 'blocking',
    confidence: 0.91,
    observation: 'The wheel is visibly offset from the fork.',
    inference: 'The assembly alignment is incorrect.',
  }
  const scopedAgent = agent([
    visualEvent({ ...common, evidenceKey: digest('prior-pass'), report: 'pass', verdict: 'pass' }),
    visualEvent({
      ...common,
      evidenceKey: digest('prior-repair'),
      findings: [blockingFinding],
      report: 'repair',
      verdict: 'repair',
    }),
  ], root)
  const runtime = visionRuntime([passReport])
  const result = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(result.reviewMode, 'resolve')
  assert.match(runtime.starts[0].request.prompt[0].text, /Review mode: resolve/)
})

test('a pending validation screenshot waits for a concrete visual gap before exposing Vision', async () => {
  const args = { check_id: 'runtime', assertion: 'The page renders.', root: '.' }
  const capture = validationEvent(args, 'final', 'passed', 'artifact-a', {
    screenshotPath: 'proof.png',
    screenshotHash: 'proof-hash',
  })
  const promoted = agent([
    capture,
    human(),
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
  ])
  const pending = await assemble(promoted)
  assert.equal(pending.tools.some(tool => tool.name === 'apex_inspect_image'), false)

  promoted.session.events.push(visualEvent({
    imagePaths: ['proof.png'],
    verdict: 'inconclusive',
  }))
  const stillPending = await assemble(promoted)
  assert.equal(stillPending.tools.some(tool => tool.name === 'apex_inspect_image'), false)

  promoted.session.events.push(visualEvent({
    imagePaths: ['proof.png'],
    report: 'one state still missing',
    verdict: 'pass',
    answeredQuestion: 'the current state passed',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: ['The active interaction state is not visible.'],
    evidenceKey: 'evidence-gap',
    questionKey: 'question-gap',
    artifactHash: 'artifact-a',
    reviewMode: 'inspect',
    cached: false,
  }))
  const gapRemains = await assemble(promoted)
  assert.equal(gapRemains.tools.some(tool => tool.name === 'apex_inspect_image'), true)

  promoted.session.events.push(visualEvent({
    imagePaths: ['proof.png'],
    report: 'reviewed',
    verdict: 'pass',
    answeredQuestion: 'reviewed',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
    evidenceKey: 'evidence',
    questionKey: 'question',
    artifactHash: 'artifact-a',
    reviewMode: 'inspect',
    cached: false,
  }))
  const reviewed = await assemble(promoted)
  assert.equal(reviewed.tools.some(tool => tool.name === 'apex_inspect_image'), false)
})

test('an unlocked visual tool follows host evidence state instead of a call-count budget', async () => {
  const args = { check_id: 'runtime', assertion: 'The page renders.', root: '.' }
  const capture = validationEvent(args, 'final', 'passed', digest('artifact-a'), {
    screenshotPath: '.apex-evidence/web-runtime-01.png',
    screenshotHash: digest('capture-a'),
  })
  const base = [
    human('Build the artifact.'),
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    unlockEvent('apex_inspect_image'),
    capture,
  ]

  const pending = await assemble(agent(base))
  assert.equal(pending.tools.some(tool => tool.name === 'apex_inspect_image'), true)

  const unresolved = await assemble(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-runtime-01.png'],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: ['The active interaction state is not visible.'],
  })]))
  assert.equal(unresolved.tools.some(tool => tool.name === 'apex_inspect_image'), true)

  const closed = await assemble(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-runtime-01.png'],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
  })]))
  assert.equal(closed.tools.some(tool => tool.name === 'apex_inspect_image'), false)

  const reopened = await assemble(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-runtime-01.png'],
    verdict: 'pass',
    findings: [],
    resolvedIssueIds: [],
    remainingGaps: [],
  }), unlockEvent('apex_inspect_image')]))
  assert.equal(reopened.tools.some(tool => tool.name === 'apex_inspect_image'), true)

  const repair = await assemble(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-runtime-01.png'],
    verdict: 'repair',
    findings: [{ issueId: 'vision-runtime', severity: 'blocking' }],
    resolvedIssueIds: [],
    remainingGaps: [],
  })]))
  assert.equal(repair.tools.some(tool => tool.name === 'apex_inspect_image'), false)

  const changedCapture = validationEvent(args, 'repair-proof', 'passed', digest('artifact-b'), {
    screenshotPath: '.apex-evidence/web-runtime-02.png',
    screenshotHash: digest('capture-b'),
  })
  const changed = await assemble(agent([...base, visualEvent({
    imagePaths: ['.apex-evidence/web-runtime-01.png'],
    verdict: 'repair',
    findings: [{ issueId: 'vision-runtime', severity: 'blocking' }],
    resolvedIssueIds: [],
    remainingGaps: [],
  }), changedCapture]))
  assert.equal(changed.tools.some(tool => tool.name === 'apex_inspect_image'), true)
})
