/** Wait for one APEX continuable worker without shell polling or a wall-clock cap. */

import { currentTaskEvents } from './tool-gate.mjs'
import {
  CONTINUE_PREFIX,
  WORK_ITEM_PREFIX,
  workspaceRelativePathFromRoot,
} from './work-items.mjs'

export const name = 'apex-worker-wait'
export const inject = ['tools', 'sessionPersistence']
export const WORKER_WAIT_META_KIND = 'apex-worker-wait-v061'

function parsedArguments(event) {
  if (typeof event.data?.arguments !== 'string') return {}
  try {
    const value = JSON.parse(event.data.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function successfulResults(events) {
  const results = new Map()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type !== 'tool-result' || block.isError === true) continue
      results.set(block.toolCallId, { block, index })
    }
  }
  return results
}

function resultText(block) {
  return Array.isArray(block?.content)
    ? block.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('')
    : ''
}

function messageText(event) {
  return Array.isArray(event?.data?.content)
    ? event.data.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    : ''
}

function latestActivationEvents(events) {
  const boundary = events.findLastIndex(event => {
    if (event.type !== 'user/message') return false
    const text = messageText(event)
    return text.startsWith(WORK_ITEM_PREFIX) || text.startsWith(CONTINUE_PREFIX)
  })
  return boundary === -1 ? events : events.slice(boundary)
}

function stopReason(events) {
  const end = events.findLast(event => event.type === 'turn/end')
  const kind = end?.data?.reason?.kind
  if (kind === 'blocked') return 'refusal'
  if (kind === 'interrupted') return 'aborted'
  return typeof kind === 'string' ? kind : 'unknown'
}

/** Derive bounded, host-verifiable evidence from the latest worker activation. */
export function workerEvidenceFromInspection(inspection) {
  const events = latestActivationEvents(Array.isArray(inspection?.events) ? inspection.events : [])
  const results = successfulResults(events)
  const touchedPaths = new Set()
  let successfulMutations = 0
  let reported = false
  let outputTokens = 0

  for (const event of events) {
    if (event.type === 'assistant/message') {
      const value = event.data?.usage?.outputTokens
      if (Number.isFinite(value) && value >= 0) outputTokens += value
      continue
    }
    if (event.type !== 'tool/call' || !results.has(event.data?.callId)) continue
    if (event.data?.name === 'report') {
      reported = true
      continue
    }
    if (event.data?.name !== 'str_replace_editor') continue
    const args = parsedArguments(event)
    if (args.command === 'view') continue
    successfulMutations += 1
    const path = workspaceRelativePathFromRoot(inspection?.meta?.cwd, args.path)
    if (path !== undefined && touchedPaths.size < 20) touchedPaths.add(path)
  }

  const terminal = stopReason(events)
  const recommendedOwner = terminal === 'max-tokens'
    || terminal === 'error'
    || terminal === 'aborted'
    || terminal === 'refusal'
    || successfulMutations === 0
    ? 'pro'
    : 'review'
  return {
    stopReason: terminal,
    outputTokens,
    steps: events.filter(event => event.type === 'step/end').length,
    toolCalls: events.filter(event => event.type === 'tool/call').length,
    successfulMutations,
    touchedPaths: [...touchedPaths],
    reported,
    meaningfulProgress: successfulMutations > 0,
    recommendedOwner,
  }
}

/** Inspect the durable child log instead of trusting a summary message. */
export async function workerSettlementEvidence(ctx, childId, signal) {
  const inspection = await ctx.sessionPersistence.inspect(childId, signal)
  return workerEvidenceFromInspection(inspection)
}

/** Map every current-task APEX worker to its latest successful start or resume. */
export function workerRequestPositions(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const results = successfulResults(events)
  const positions = new Map()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const result = results.get(event.data?.callId)
    if (result === undefined) continue
    if (event.data?.name === 'apex_build') {
      const childId = resultText(result.block).match(/^started subagent (\S+)$/m)?.[1]
      if (childId !== undefined) positions.set(childId, result.index)
      continue
    }
    if (event.data?.name !== 'send_message' && event.data?.name !== 'apex_continue') continue
    const args = parsedArguments(event)
    const childId = event.data.name === 'apex_continue' ? args.child_id : args.subagent_id
    if (typeof childId === 'string' && positions.has(childId)) {
      positions.set(childId, result.index)
    }
  }
  return { events, positions }
}

function settlementAfter(events, childId, afterIndex) {
  return events.slice(afterIndex + 1).find(event => (
    (event.type === 'user/message'
      && event.data?.source?.kind === 'subagent-settled'
      && event.data.source.senderSessionId === childId)
    || (event.type === 'tool/result'
      && event.data?.meta?.kind === WORKER_WAIT_META_KIND
      && event.data.meta.childId === childId)
  ))
}

/** Describe whether this task knows a worker and still owes its latest settlement. */
export function workerSettlementState(agent, childId) {
  const { events, positions } = workerRequestPositions(agent)
  const requestIndex = positions.get(childId)
  if (requestIndex === undefined) return { known: false, settled: false }
  const settlement = settlementAfter(events, childId, requestIndex)
  return {
    known: true,
    settled: settlement !== undefined,
    summary: settlement?.type === 'user/message' ? settlement.data?.source?.summary : undefined,
  }
}

/** Return current-task workers whose latest accepted activation has not settled. */
export function pendingWorkerIds(agent) {
  const { events, positions } = workerRequestPositions(agent)
  return [...positions]
    .filter(([childId, requestIndex]) => settlementAfter(events, childId, requestIndex) === undefined)
    .map(([childId]) => childId)
}

function abortError() {
  const error = new Error('apex_wait was cancelled with its parent session')
  error.name = 'AbortError'
  return error
}

async function settledValue(ctx, childId, outcome, summary, signal, durableEvidence) {
  const evidence = durableEvidence ?? await workerSettlementEvidence(ctx, childId, signal)
  const detail = typeof summary === 'string' && summary.length > 0
    ? ` ${summary}`
    : ''
  const owner = evidence.recommendedOwner === 'pro'
    ? 'Host evidence recommends Pro takeover. Inspect a leased file, then call apex_takeover with the matching work-item id if the defect still needs implementation.'
    : 'Host evidence recorded writes. Pro must inspect the leased file and choose either one evidence-backed apex_continue repair or apex_takeover for a Pro-only fix.'
  return {
    childId,
    status: 'settled',
    outcome: evidence.stopReason === 'unknown' ? outcome : evidence.stopReason,
    ...evidence,
    text: [
      `Worker ${childId} settled.${detail}`,
      `Durable evidence: stop=${evidence.stopReason}; outputTokens=${evidence.outputTokens}; steps=${evidence.steps}; toolCalls=${evidence.toolCalls}; successfulMutations=${evidence.successfulMutations}; reported=${evidence.reported}.`,
      evidence.touchedPaths.length > 0 ? `Touched paths: ${evidence.touchedPaths.join(', ')}.` : 'No successful file mutation was recorded in this activation.',
      owner,
      'Inspect at least one leased file with read; shell output alone is not continuation evidence.',
      'Map acceptance to evidence and batch the smallest relevant validation. For a small single-file task with no dependencies, one file read plus one static or runtime check is the initial review budget. A successful zero-output tool result is evidence; do not repeat it merely to print an exit code.',
      'Expand into call chains, boundaries, lifecycle, user-path, or performance checks only when this task makes that risk relevant or new evidence exposes a gap.',
      'After any repair settles, read the changed file and retest only the failed assertion instead of repeating equivalent probes.',
    ].join(' '),
  }
}

/** Block until the selected worker's current activation has durable terminal evidence. */
export async function waitForWorkerSettlement(ctx, childId, exec) {
  const agent = exec?.agent
  if (agent?.session === undefined) {
    throw new Error('apex_wait requires a calling parent agent')
  }
  const initial = workerSettlementState(agent, childId)
  if (!initial.known) {
    throw new Error(`apex_wait can only wait for an APEX worker started in this human task: ${childId}`)
  }
  if (initial.settled) return await settledValue(ctx, childId, 'recorded', initial.summary, exec.signal)
  if (exec.signal?.aborted) throw abortError()

  return await new Promise((resolve, reject) => {
    let finished = false
    let inspecting = false
    let probing = true
    let terminalEvent
    let dispose = () => {}
    const onAbort = () => finish(undefined, abortError())
    const finish = (value, error) => {
      if (finished) return
      finished = true
      exec.signal?.removeEventListener('abort', onAbort)
      try {
        dispose()
      } catch (disposeError) {
        reject(disposeError)
        return
      }
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const inspectAndFinish = (outcome, summary, evidence) => {
      if (finished || inspecting) return
      inspecting = true
      void settledValue(ctx, childId, outcome, summary, exec.signal, evidence)
        .then(value => finish(value), error => finish(undefined, error))
    }

    dispose = ctx.on('subagent/end', (info) => {
      if (info?.id !== childId) return
      terminalEvent = info
      if (!probing) inspectAndFinish(String(info.stopReason ?? 'settled'))
    }, { global: true })
    exec.signal?.addEventListener('abort', onAbort, { once: true })

    // Subscribe first, then inspect the child log. This closes both races: an
    // end edge during setup and an end edge that happened before apex_wait.
    void workerSettlementEvidence(ctx, childId, exec.signal).then((evidence) => {
      probing = false
      if (evidence.stopReason !== 'unknown') {
        inspectAndFinish(evidence.stopReason, undefined, evidence)
        return
      }
      if (terminalEvent !== undefined) {
        inspectAndFinish(String(terminalEvent.stopReason ?? 'settled'))
        return
      }
      const refreshed = workerSettlementState(agent, childId)
      if (refreshed.settled) inspectAndFinish('recorded', refreshed.summary)
      else if (exec.signal?.aborted) finish(undefined, abortError())
    }, error => finish(undefined, error))
  })
}

/** Register the parent-only settlement wait tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'apex_wait',
    description: [
      'Wait until one APEX continuable worker started in this human task fully settles.',
      'Use this immediately after apex_build or apex_continue when you need that worker before integration.',
      'The call replays durable child terminal evidence and otherwise blocks on Harness subagent lifecycle events; it does not poll, interrupt, extend, or impose a plugin wall-clock deadline.',
      'Do not use shell sleep or list_agents to poll worker completion.',
      'After settlement, follow the risk-scaled review template in the returned text.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        child_id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'The durable child id returned by apex_build.',
        },
      },
      required: ['child_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          status: { type: 'string', enum: ['settled'] },
          outcome: { type: 'string' },
          stopReason: { type: 'string' },
          outputTokens: { type: 'number' },
          steps: { type: 'number' },
          toolCalls: { type: 'number' },
          successfulMutations: { type: 'number' },
          touchedPaths: { type: 'array', items: { type: 'string' } },
          reported: { type: 'boolean' },
          meaningfulProgress: { type: 'boolean' },
          recommendedOwner: { type: 'string', enum: ['pro', 'review'] },
          text: { type: 'string' },
        },
        required: [
          'childId', 'status', 'outcome', 'stopReason', 'outputTokens', 'steps',
          'toolCalls', 'successfulMutations', 'touchedPaths', 'reported',
          'meaningfulProgress', 'recommendedOwner', 'text',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: WORKER_WAIT_META_KIND,
        childId: value.childId,
        stopReason: value.stopReason,
        successfulMutations: value.successfulMutations,
        touchedPaths: value.touchedPaths,
        recommendedOwner: value.recommendedOwner,
      }),
    },
    execute(args, exec) {
      return waitForWorkerSettlement(ctx, args.child_id, exec)
    },
  })
}
