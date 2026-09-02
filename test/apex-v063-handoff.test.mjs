import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HANDOFF_REPORT_PREFIX,
  latestHandoffRevision,
  parseBuildArguments,
  parseContinuationMessage,
  parseHandoffReportOutput,
  parsePersistedBuildArguments,
  parseWorkItemPrompt,
  renderContinuationMessage,
  renderWorkItemPrompt,
  snapshotReadOnlyInputs,
  verifyReadOnlyInputHashes,
} from '../presets/apex-v063/work-items.mjs'
import { apply as applyContinue } from '../presets/apex-v063/apex-continue.mjs'
import {
  waitForWorkerSettlement,
  workerEvidenceFromInspection,
} from '../presets/apex-v063/worker-wait.mjs'
import {
  CHILD_SCOPE_REASON,
  CHILD_SHELL_RESTRICTION_REASON,
  childScopeDenial,
  childShellDenial,
  PRO_CORE_SHELL_WRITE_REASON,
} from '../presets/apex-v063/execution-guard.mjs'
import {
  APEX_CODE_CHILD_LABEL_PREFIX,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  PRO_MAX_MODEL,
  PRO_MAX_PROVIDER,
} from '../presets/apex-v063/tool-gate.mjs'

let dispatchIndex = 0

function buildArguments(role = 'flash-production') {
  return {
    role,
    description: 'bounded solver',
    id: 'bounded-solver',
    paths: ['src/solver.js'],
    goal: 'Implement the bounded solver without changing its public API.',
    context: 'The parent owns architecture, integration, and final validation.',
    read_only_inputs: [{ path: 'src/api.js', purpose: 'Frozen public API.' }],
    interfaces: [{ id: 'solver-api', contract: 'Export solve(input).' }],
    invariants: [{ id: 'finite-output', statement: 'Every returned number is finite.' }],
    non_goals: ['Do not edit the UI or install dependencies.'],
    acceptance: [{ id: 'solver-export', assertion: 'src/solver.js exports solve(input).' }],
  }
}

function user(text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    data: { source, content: [{ type: 'text', text }] },
  }
}

function dispatch(name, argumentsValue, isError = false) {
  return {
    type: 'tool/code-dispatch',
    data: {
      rootCallId: 'run-code-1',
      parentCallId: 'run-code-1',
      subCallId: `run-code-1:${name}:${++dispatchIndex}`,
      name,
      arguments: argumentsValue,
      isError,
      content: [],
    },
  }
}

function managedChild(prompt, role) {
  const pro = role === 'pro-core'
  return {
    session: {
      header: {
        delegationDepth: 1,
        cwd: '/workspace',
        agentPreset: 'apex-v063',
      },
      events: [
        {
          type: 'subagent/descriptor',
          data: {
            version: 3,
            provider: 'spawn',
            mode: 'continuable',
            label: `${APEX_CODE_CHILD_LABEL_PREFIX} [${role}]: solver`,
          },
        },
        user(prompt),
      ],
    },
    options: {
      provider: pro ? PRO_MAX_PROVIDER : FLASH_MAX_PROVIDER,
      model: pro ? PRO_MAX_MODEL : FLASH_MAX_MODEL,
    },
  }
}

function reportOutput(workItem, revision, changedPaths, overrides = {}) {
  return `APEX_HANDOFF_REPORT ${JSON.stringify({
    handoffId: workItem.id,
    revision,
    status: 'completed',
    changedPaths,
    completedAcceptance: workItem.acceptance.map(item => item.id),
    decisions: [{ decision: 'Preserve the public API.', reason: 'The interface is frozen.' }],
    unverified: [],
    remainingGaps: [],
    blockers: [],
    recommendedOwner: 'pro',
    ...overrides,
  })}`
}

function reportTemplateLine(message) {
  const line = message.split('\n').find(value => value.startsWith(HANDOFF_REPORT_PREFIX))
  assert.notEqual(line, undefined)
  return line
}

test('handoff v1 snapshots immutable inputs and round-trips the canonical prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apex-handoff-'))
  try {
    writeFileSync(join(root, 'api.js'), 'export const version = 1\n')
    const args = {
      ...buildArguments('pro-core'),
      paths: ['solver.js'],
      read_only_inputs: [{ path: 'api.js', purpose: 'Frozen public API.' }],
    }
    const parsed = parseBuildArguments(args)
    assert.equal(parsed.ok, true)
    const snapshots = await snapshotReadOnlyInputs(parsed.value, root)
    assert.match(snapshots[0].sha256, /^[a-f0-9]{64}$/)

    const prompt = renderWorkItemPrompt(parsed.value, root, snapshots)
    assert.match(prompt, /JSON\.stringify\(handoffReport\)/)
    assert.match(prompt, /never hand-escape report JSON/)
    const roundTrip = parseWorkItemPrompt(prompt)
    assert.equal(roundTrip.ok, true)
    assert.equal(roundTrip.value.role, 'pro-core')
    assert.deepEqual(roundTrip.value.interfaces, args.interfaces)
    assert.deepEqual(roundTrip.value.invariants, args.invariants)
    assert.deepEqual(roundTrip.value.acceptance, args.acceptance)
    assert.deepEqual(roundTrip.value.readOnlyInputs, snapshots)
    assert.deepEqual(await verifyReadOnlyInputHashes(roundTrip.value, root), [])
    const initialReport = parseHandoffReportOutput(reportTemplateLine(prompt), parsed.value, 1)
    assert.equal(initialReport.ok, true)
    assert.deepEqual(initialReport.value.changedPaths, ['solver.js'])
    assert.deepEqual(initialReport.value.completedAcceptance, ['solver-export'])
    assert.deepEqual(initialReport.value.decisions, [])

    writeFileSync(join(root, 'api.js'), 'export const version = 2\n')
    assert.deepEqual(await verifyReadOnlyInputHashes(roundTrip.value, root), ['api.js'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('handoff contracts reject ambiguous ownership and false completion claims', () => {
  const overlap = parseBuildArguments({
    ...buildArguments(),
    read_only_inputs: [{ path: 'src/solver.js', purpose: 'Conflicting input.' }],
  })
  assert.equal(overlap.ok, false)
  assert.match(overlap.error, /must not overlap writable paths/)

  const workItem = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const incomplete = reportOutput(workItem, 1, ['src/solver.js'], {
    completedAcceptance: [],
  })
  assert.match(parseHandoffReportOutput(incomplete, workItem, 1).error, /requires every acceptance id/)
  assert.match(
    parseHandoffReportOutput(`${reportOutput(workItem, 1, ['src/solver.js'])}\nextra`, workItem, 1).error,
    /one JSON line/,
  )
})

test('persisted pre-handoff build calls remain readable but cannot be submitted anew', () => {
  const legacy = {
    description: 'legacy worker',
    id: 'legacy-worker',
    paths: ['src/legacy.js'],
    goal: 'Finish the old bounded module.',
    context: 'This call already exists in a persisted parent log.',
    non_goals: 'Do not change other files.',
    acceptance: 'The old module remains resumable.',
  }
  assert.equal(parseBuildArguments(legacy).ok, false)
  const persisted = parsePersistedBuildArguments(legacy)
  assert.equal(persisted.ok, true)
  assert.equal(persisted.value.version, 0)
  assert.equal(persisted.value.role, 'flash-production')
  assert.deepEqual(persisted.value.paths, ['src/legacy.js'])
})

test('worker evidence recognizes nested PTC edits and verifies the structured report', () => {
  const workItem = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const prompt = renderWorkItemPrompt(workItem, '/workspace', [])
  const inspection = {
    meta: { cwd: '/workspace' },
    events: [
      user(prompt),
      { type: 'assistant/message', data: { usage: { outputTokens: 320 } } },
      dispatch('str_replace_editor', {
        command: 'create',
        path: '/workspace/src/solver.js',
        file_text: 'export const solve = value => value\n',
      }),
      dispatch('report', { output: reportOutput(workItem, 1, ['src/solver.js']) }),
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const evidence = workerEvidenceFromInspection(inspection)
  assert.equal(evidence.workerRole, 'flash-production')
  assert.equal(evidence.successfulMutations, 1)
  assert.deepEqual(evidence.touchedPaths, ['src/solver.js'])
  assert.equal(evidence.reportValid, true)
  assert.equal(evidence.reportStatus, 'completed')
  assert.deepEqual(evidence.completedAcceptance, ['solver-export'])
  assert.equal(evidence.recommendedOwner, 'review')
  assert.equal(evidence.toolCalls, 0)
  assert.equal(evidence.ptcDispatches, 2)
})

test('continuation revisions are monotonic and changed-path mismatches return to Pro', () => {
  const workItem = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const prompt = renderWorkItemPrompt(workItem, '/workspace', [])
  const continuation = renderContinuationMessage({
    workItemId: workItem.id,
    evidence: ['The first implementation used the wrong coefficient.'],
    instruction: 'Correct only the coefficient and preserve the API.',
  }, 2, workItem)
  const continuationReport = parseHandoffReportOutput(reportTemplateLine(continuation), workItem, 2)
  assert.equal(continuationReport.ok, true)
  assert.equal(continuationReport.value.status, 'completed')
  const inspection = {
    meta: { cwd: '/workspace' },
    events: [
      user(prompt),
      user(continuation, { kind: 'coordinator' }),
      dispatch('str_replace_editor', {
        command: 'str_replace',
        path: '/workspace/src/solver.js',
        old_str: '1',
        new_str: '2',
      }),
      dispatch('report', { output: reportOutput(workItem, 2, []) }),
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  }
  assert.equal(latestHandoffRevision(inspection.events), 2)
  const evidence = workerEvidenceFromInspection(inspection)
  assert.equal(evidence.handoffRevision, 2)
  assert.equal(evidence.reportValid, false)
  assert.equal(evidence.reportStatus, 'invalid')
  assert.match(evidence.reportErrors.join(' '), /changedPaths/)
  assert.equal(evidence.recommendedOwner, 'pro')
})

test('invalid completed report names the exact Pro takeover reason', async () => {
  const childId = 'child-invalid-report'
  const workItem = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const prompt = renderWorkItemPrompt(workItem, '/workspace', [])
  const inspection = {
    meta: { cwd: '/workspace' },
    events: [
      user(prompt),
      dispatch('str_replace_editor', {
        command: 'create',
        path: '/workspace/src/solver.js',
        file_text: 'export const solve = value => value\n',
      }),
      dispatch('report', { output: 'APEX_HANDOFF_REPORT {"broken":"nested "quote""}' }),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const agent = {
    session: {
      events: [
        {
          type: 'tool/call',
          data: { name: 'apex_build', callId: 'build-1', arguments: '{}' },
        },
        {
          type: 'tool/result',
          data: {
            message: {
              content: [{
                type: 'tool-result',
                toolCallId: 'build-1',
                isError: false,
                content: [{ type: 'text', text: `started subagent ${childId}` }],
              }],
            },
          },
        },
        user('settled', { kind: 'subagent-settled', senderSessionId: childId }),
      ],
    },
  }
  const value = await waitForWorkerSettlement({
    sessionPersistence: { async inspect() { return inspection } },
  }, childId, { agent, signal: new AbortController().signal })
  assert.equal(value.reportStatus, 'invalid')
  assert.equal(value.recommendedOwner, 'pro')
  assert.match(value.text, /reason pro_only_fix/)
  assert.doesNotMatch(value.text, /reason worker_failed/)
})

test('apex_continue derives the next revision from the durable child log', async () => {
  const workItem = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const prompt = renderWorkItemPrompt(workItem, '/workspace', [])
  const registered = []
  let followup
  applyContinue({
    tools: { register(value) { registered.push(value); return () => {} } },
    subagents: {
      async followup(...args) {
        followup = args
        return 'message-2'
      },
    },
    sessionPersistence: {
      async inspect() {
        return { meta: { cwd: '/workspace' }, events: [user(prompt)] }
      },
    },
  })
  const tool = registered.find(value => value.name === 'apex_continue')
  const parent = { id: 'parent-1', session: { events: [] } }
  const value = await tool.execute({
    child_id: 'child-1',
    work_item_id: workItem.id,
    evidence: ['The coefficient is inconsistent with the frozen interface.'],
    instruction: 'Correct the coefficient only.',
  }, { agent: parent, signal: undefined })
  assert.deepEqual(value, { childId: 'child-1', messageId: 'message-2', revision: 2 })
  const parsed = parseContinuationMessage(followup[2][0].text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.revision, 2)
})

test('role enforcement keeps Flash off shell and Pro shell check-only', () => {
  const flashWork = parseBuildArguments({ ...buildArguments(), read_only_inputs: [] }).value
  const flash = managedChild(renderWorkItemPrompt(flashWork, '/workspace', []), 'flash-production')
  assert.equal(childShellDenial({ name: 'bash', agent: flash }), CHILD_SHELL_RESTRICTION_REASON)

  const proWork = parseBuildArguments({
    ...buildArguments('pro-core'),
    read_only_inputs: [],
  }).value
  const pro = managedChild(renderWorkItemPrompt(proWork, '/workspace', []), 'pro-core')
  assert.equal(childShellDenial({ name: 'bash', agent: pro }), undefined)
  assert.equal(childScopeDenial({
    name: 'bash',
    arguments: { command: 'node --check src/solver.js' },
    agent: pro,
  }), undefined)
  assert.equal(childScopeDenial({
    name: 'bash',
    arguments: { command: 'node -e "console.log(1)" > src/solver.js' },
    agent: pro,
  }), PRO_CORE_SHELL_WRITE_REASON)
  assert.equal(childScopeDenial({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: '/workspace/src/outside.js', file_text: '' },
    agent: pro,
  }), CHILD_SCOPE_REASON)
})
