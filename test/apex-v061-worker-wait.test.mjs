import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  pendingWorkerIds,
  waitForWorkerSettlement,
  workerSettlementState,
} from '../presets/apex-v061/worker-wait.mjs'

function call(name, args, callId) {
  return {
    type: 'tool/call',
    data: { name, callId, arguments: JSON.stringify(args) },
  }
}

function result(callId, text = 'ok', isError = false) {
  return {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text }],
        }],
      },
    },
  }
}

function parent(events = []) {
  return { session: { events, header: { delegationDepth: 0 } } }
}

function started(childId = 'child-1') {
  return [
    call('apex_build', { prompt: 'bounded work' }, 'build-1'),
    result('build-1', `started subagent ${childId}`),
  ]
}

function settled(childId = 'child-1', summary = 'worker completed') {
  return {
    type: 'user/message',
    data: {
      source: { kind: 'subagent-settled', senderSessionId: childId, summary },
      content: [{ type: 'text', text: summary }],
    },
  }
}

function childInspection({ stopReason = 'completed', mutations = 1, outputTokens = 240 } = {}) {
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: [
            'APEX_WORK_ITEM {"id":"work","paths":["src/main.js"]}',
            'Goal: Implement the bounded work item.',
            'Context: Follow the existing architecture.',
            'Non-goals: Do not change unrelated files.',
            'Constraints: Edit only leased paths.',
            'Acceptance: Complete the requested behavior.',
            'Report: Return changed paths and blockers.',
          ].join('\n'),
        }],
      },
    },
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens } } },
  ]
  for (let index = 0; index < mutations; index += 1) {
    events.push(
      call('str_replace_editor', { command: 'create', path: '/workspace/src/main.js' }, `edit-${index}`),
      result(`edit-${index}`),
    )
  }
  events.push(
    call('report', { status: 'completed' }, 'report-1'),
    result('report-1'),
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: stopReason } } },
  )
  return { meta: { cwd: '/workspace' }, events }
}

function lifecycleContext(inspection = childInspection(), { runningUntilEnd = false } = {}) {
  const listeners = new Set()
  let ended = !runningUntilEnd
  const runningInspection = {
    ...inspection,
    events: inspection.events.filter(event => event.type !== 'turn/end'),
  }
  return {
    listeners,
    sessionPersistence: {
      async inspect() {
        return ended ? inspection : runningInspection
      },
    },
    on(name, listener, options) {
      assert.equal(name, 'subagent/end')
      assert.deepEqual(options, { global: true })
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(info) {
      if (info?.id === 'child-1') ended = true
      for (const listener of [...listeners]) listener(info)
    },
  }
}

test('worker settlement state follows the latest successful start or resume', () => {
  const agent = parent([...started(), settled()])
  assert.deepEqual(workerSettlementState(agent, 'child-1'), {
    known: true,
    settled: true,
    summary: 'worker completed',
  })
  assert.deepEqual(pendingWorkerIds(agent), [])

  agent.session.events.push(
    call('apex_continue', {
      child_id: 'child-1',
      work_item_id: 'work',
      evidence: ['verified defect'],
      instruction: 'repair it',
    }, 'send-1'),
    result('send-1', 'message queued'),
  )
  assert.deepEqual(workerSettlementState(agent, 'child-1'), {
    known: true,
    settled: false,
    summary: undefined,
  })
  assert.deepEqual(pendingWorkerIds(agent), ['child-1'])

  agent.session.events.push(settled('child-1', 'continuation completed'))
  assert.equal(workerSettlementState(agent, 'child-1').settled, true)

  const recovered = parent([
    ...started(),
    {
      type: 'tool/result',
      data: {
        meta: { kind: 'apex-worker-wait-v061', childId: 'child-1' },
        message: { content: [] },
      },
    },
  ])
  assert.equal(workerSettlementState(recovered, 'child-1').settled, true)
  assert.deepEqual(pendingWorkerIds(recovered), [])
})

test('apex_wait blocks on the matching lifecycle edge and ignores other workers', async () => {
  const ctx = lifecycleContext(childInspection(), { runningUntilEnd: true })
  const controller = new AbortController()
  const waiting = waitForWorkerSettlement(ctx, 'child-1', {
    agent: parent(started()),
    signal: controller.signal,
  })
  let resolved = false
  void waiting.then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.equal(ctx.listeners.size, 1)

  ctx.emit({ id: 'child-2', stopReason: 'completed' })
  await Promise.resolve()
  assert.equal(resolved, false)

  ctx.emit({ id: 'child-1', stopReason: 'completed' })
  const settledResult = await waiting
  assert.deepEqual(
    { childId: settledResult.childId, status: settledResult.status, outcome: settledResult.outcome },
    { childId: 'child-1', status: 'settled', outcome: 'completed' },
  )
  assert.match(settledResult.text, /leased file/)
  assert.match(settledResult.text, /Map acceptance to evidence/)
  assert.match(settledResult.text, /initial review budget/)
  assert.match(settledResult.text, /new evidence exposes a gap/)
  assert.match(settledResult.text, /apex_continue/)
  assert.match(settledResult.text, /apex_takeover/)
  assert.equal(settledResult.outputTokens, 240)
  assert.equal(settledResult.successfulMutations, 1)
  assert.deepEqual(settledResult.touchedPaths, ['src/main.js'])
  assert.equal(settledResult.recommendedOwner, 'review')
  assert.equal(ctx.listeners.size, 0)
})

test('apex_wait recovers an already-ended child from its durable log without a future event', async () => {
  const ctx = lifecycleContext()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const value = await waitForWorkerSettlement(ctx, 'child-1', {
      agent: parent(started()),
      signal: controller.signal,
    })
    assert.equal(value.status, 'settled')
    assert.equal(value.stopReason, 'completed')
    assert.equal(value.successfulMutations, 1)
    assert.equal(ctx.listeners.size, 0)
  } finally {
    clearTimeout(timeout)
  }
})

test('apex_wait returns recorded settlement, rejects unknown ids, and cleans up on cancellation', async () => {
  const recordedCtx = lifecycleContext()
  const recorded = await waitForWorkerSettlement(recordedCtx, 'child-1', {
    agent: parent([...started(), settled()]),
    signal: new AbortController().signal,
  })
  assert.equal(recorded.outcome, 'completed')
  assert.match(recorded.text, /worker completed/)
  assert.equal(recordedCtx.listeners.size, 0)

  await assert.rejects(
    waitForWorkerSettlement(recordedCtx, 'unknown', {
      agent: parent(started()),
      signal: new AbortController().signal,
    }),
    /only wait for an APEX worker started in this human task/,
  )

  const cancelledCtx = lifecycleContext(childInspection(), { runningUntilEnd: true })
  const controller = new AbortController()
  const waiting = waitForWorkerSettlement(cancelledCtx, 'child-1', {
    agent: parent(started()),
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(cancelledCtx.listeners.size, 0)
})

test('apex_wait recommends Pro ownership after max-tokens or no write progress', async () => {
  const value = await waitForWorkerSettlement(
    lifecycleContext(childInspection({ stopReason: 'max-tokens', mutations: 0, outputTokens: 8192 })),
    'child-1',
    {
      agent: parent([...started(), settled()]),
      signal: new AbortController().signal,
    },
  )
  assert.equal(value.stopReason, 'max-tokens')
  assert.equal(value.successfulMutations, 0)
  assert.equal(value.meaningfulProgress, false)
  assert.equal(value.recommendedOwner, 'pro')
  assert.match(value.text, /No successful file mutation/)
})

test('the registered apex_wait tool has no polling interval or wall-clock parameter', () => {
  let tool
  apply({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    on() {
      return () => {}
    },
  })
  assert.equal(tool.name, 'apex_wait')
  assert.deepEqual(tool.parameters.required, ['child_id'])
  assert.deepEqual(Object.keys(tool.parameters.properties), ['child_id'])
  assert.doesNotMatch(tool.description, /timeout|polling interval/i)
  assert.match(tool.description, /does not poll/)
  assert.match(tool.description, /replays durable child terminal evidence/)
  assert.match(tool.description, /does not.*wall-clock deadline/)
  assert.match(tool.description, /risk-scaled review template/)
})
