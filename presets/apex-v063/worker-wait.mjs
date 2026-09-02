/** Wait for one APEX continuable worker without shell polling or a wall-clock cap. */

import { currentTaskEvents } from './tool-gate.mjs'
import {
  CONTINUE_PREFIX,
  HANDOFF_PREFIX,
  latestHandoffRevision,
  parseHandoffReportOutput,
  verifyReadOnlyInputHashes,
  WORK_ITEM_PREFIX,
  workItemFromEvents,
  workspaceRelativePathFromRoot,
} from './work-items.mjs'

export const name = 'apex-worker-wait'
export const inject = ['tools', 'sessionPersistence']
export const WORKER_WAIT_META_KIND = 'apex-worker-wait-v063'

function parsedArguments(event) {
  if (event.data?.arguments !== null
    && typeof event.data?.arguments === 'object'
    && !Array.isArray(event.data.arguments)) return event.data.arguments
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
    return text.startsWith(HANDOFF_PREFIX)
      || text.startsWith(WORK_ITEM_PREFIX)
      || text.startsWith(CONTINUE_PREFIX)
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
  const allEvents = Array.isArray(inspection?.events) ? inspection.events : []
  const events = latestActivationEvents(allEvents)
  const results = successfulResults(events)
  const workItem = workItemFromEvents(allEvents)
  const handoffRevision = latestHandoffRevision(allEvents)
  const touchedPaths = new Set()
  const reports = []
  let successfulMutations = 0
  let outputTokens = 0

  for (const event of events) {
    if (event.type === 'assistant/message') {
      const value = event.data?.usage?.outputTokens
      if (Number.isFinite(value) && value >= 0) outputTokens += value
      continue
    }
    const successful = (event.type === 'tool/call' && results.has(event.data?.callId))
      || (event.type === 'tool/code-dispatch' && event.data?.isError === false)
    if (!successful) continue
    if (event.data?.name === 'report') {
      const output = parsedArguments(event).output
      if (typeof output === 'string') reports.push(output)
      continue
    }
    if (!['write', 'edit', 'str_replace_editor'].includes(event.data?.name)) continue
    const args = parsedArguments(event)
    if (event.data.name === 'str_replace_editor' && args.command === 'view') continue
    successfulMutations += 1
    const path = workspaceRelativePathFromRoot(
      inspection?.meta?.cwd,
      args.path ?? args.file_path,
    )
    if (path !== undefined && touchedPaths.size < 20) touchedPaths.add(path)
  }

  const reportErrors = []
  let handoffReport
  if (workItem === undefined || handoffRevision === undefined) {
    reportErrors.push('durable handoff contract was not found')
  } else if (reports.length === 0) {
    reportErrors.push('worker did not submit APEX_HANDOFF_REPORT')
  } else {
    if (reports.length > 1) reportErrors.push('worker submitted more than one report in this activation')
    const parsed = parseHandoffReportOutput(reports.at(-1), workItem, handoffRevision)
    if (!parsed.ok) reportErrors.push(parsed.error)
    else handoffReport = parsed.value
  }
  if (handoffReport !== undefined) {
    const actual = [...touchedPaths].sort()
    const claimed = [...handoffReport.changedPaths].sort()
    if (actual.join('\0') !== claimed.join('\0')) {
      reportErrors.push('reported changedPaths do not match durable successful mutations')
    }
  }
  const reportValid = handoffReport !== undefined && reportErrors.length === 0
  const terminal = stopReason(events)
  const fatal = terminal === 'max-tokens'
    || terminal === 'error'
    || terminal === 'aborted'
    || terminal === 'refusal'
  const recommendedOwner = fatal || successfulMutations === 0 || !reportValid
    ? 'pro'
    : handoffReport.status === 'completed'
      ? 'review'
      : handoffReport.recommendedOwner
  return {
    handoffId: workItem?.id ?? 'unknown',
    handoffRevision: handoffRevision ?? 0,
    workerRole: workItem?.role ?? 'unknown',
    stopReason: terminal,
    outputTokens,
    steps: events.filter(event => event.type === 'step/end').length,
    toolCalls: events.filter(event => event.type === 'tool/call').length,
    ptcDispatches: events.filter(event => event.type === 'tool/code-dispatch').length,
    successfulMutations,
    touchedPaths: [...touchedPaths],
    reported: reports.length > 0,
    reportStatus: reportValid ? handoffReport.status : reports.length > 0 ? 'invalid' : 'missing',
    reportValid,
    reportRecommendedOwner: handoffReport?.recommendedOwner ?? 'pro',
    completedAcceptance: handoffReport?.completedAcceptance ?? [],
    decisions: handoffReport?.decisions ?? [],
    unverified: handoffReport?.unverified ?? [],
    remainingGaps: handoffReport?.remainingGaps ?? [],
    blockers: handoffReport?.blockers ?? [],
    reportErrors,
    inputDriftedPaths: [],
    meaningfulProgress: successfulMutations > 0 || reportValid,
    recommendedOwner,
  }
}

/** Inspect the durable child log instead of trusting a summary message. */
export async function workerSettlementEvidence(ctx, childId, signal) {
  const inspection = await ctx.sessionPersistence.inspect(childId, signal)
  const evidence = workerEvidenceFromInspection(inspection)
  const workItem = workItemFromEvents(inspection.events)
  if (workItem === undefined || workItem.readOnlyInputs.length === 0) return evidence
  const inputDriftedPaths = await verifyReadOnlyInputHashes(workItem, inspection?.meta?.cwd)
  if (inputDriftedPaths.length === 0) return evidence
  return {
    ...evidence,
    inputDriftedPaths,
    reportValid: false,
    reportStatus: 'invalid',
    reportErrors: [
      ...evidence.reportErrors,
      `immutable read-only input changed: ${inputDriftedPaths.join(', ')}`,
    ],
    recommendedOwner: 'pro',
  }
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
  const takeoverReason = evidence.stopReason === 'max-tokens'
    ? 'worker_max_tokens'
    : ['error', 'aborted', 'refusal'].includes(evidence.stopReason)
      ? 'worker_failed'
      : evidence.successfulMutations === 0
        ? 'no_write_progress'
        : 'pro_only_fix'
  const owner = evidence.recommendedOwner === 'pro'
    ? `Host evidence recommends Pro takeover. Inspect a leased file, then call apex_takeover with the matching work-item id and reason ${takeoverReason} if the defect still needs implementation.`
    : evidence.recommendedOwner === 'worker'
      ? 'The verified handoff recommends one evidence-backed apex_continue repair after Pro inspects the leased file.'
      : 'The verified handoff is ready for Pro review against the named acceptance assertions.'
  return {
    childId,
    status: 'settled',
    outcome: evidence.stopReason === 'unknown' ? outcome : evidence.stopReason,
    ...evidence,
    text: [
      `Worker ${childId} settled.${detail}`,
      `Durable evidence: handoff=${evidence.handoffId}@${evidence.handoffRevision}; role=${evidence.workerRole}; stop=${evidence.stopReason}; outputTokens=${evidence.outputTokens}; steps=${evidence.steps}; toolCalls=${evidence.toolCalls}; ptcDispatches=${evidence.ptcDispatches}; successfulMutations=${evidence.successfulMutations}; report=${evidence.reportStatus}.`,
      evidence.touchedPaths.length > 0 ? `Touched paths: ${evidence.touchedPaths.join(', ')}.` : 'No successful file mutation was recorded in this activation.',
      evidence.reportErrors.length > 0 ? `Handoff issue: ${evidence.reportErrors.join('; ')}.` : 'The structured report matches durable mutation evidence.',
      evidence.remainingGaps.length > 0 ? `Remaining gaps: ${evidence.remainingGaps.join('; ')}.` : '',
      evidence.blockers.length > 0 ? `Blockers: ${evidence.blockers.join('; ')}.` : '',
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
          handoffId: { type: 'string' },
          handoffRevision: { type: 'number' },
          workerRole: { type: 'string' },
          outputTokens: { type: 'number' },
          steps: { type: 'number' },
          toolCalls: { type: 'number' },
          ptcDispatches: { type: 'number' },
          successfulMutations: { type: 'number' },
          touchedPaths: { type: 'array', items: { type: 'string' } },
          reported: { type: 'boolean' },
          reportStatus: { type: 'string', enum: ['missing', 'invalid', 'completed', 'partial', 'blocked'] },
          reportValid: { type: 'boolean' },
          reportRecommendedOwner: { type: 'string', enum: ['pro', 'worker'] },
          completedAcceptance: { type: 'array', items: { type: 'string' } },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decision: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['decision', 'reason'],
            },
          },
          unverified: { type: 'array', items: { type: 'string' } },
          remainingGaps: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          reportErrors: { type: 'array', items: { type: 'string' } },
          inputDriftedPaths: { type: 'array', items: { type: 'string' } },
          meaningfulProgress: { type: 'boolean' },
          recommendedOwner: { type: 'string', enum: ['pro', 'worker', 'review'] },
          text: { type: 'string' },
        },
        required: [
          'childId', 'status', 'outcome', 'handoffId', 'handoffRevision',
          'workerRole', 'stopReason', 'outputTokens', 'steps',
          'toolCalls', 'ptcDispatches', 'successfulMutations', 'touchedPaths', 'reported',
          'reportStatus', 'reportValid', 'reportRecommendedOwner',
          'completedAcceptance', 'decisions', 'unverified', 'remainingGaps',
          'blockers', 'reportErrors', 'inputDriftedPaths', 'meaningfulProgress',
          'recommendedOwner', 'text',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: WORKER_WAIT_META_KIND,
        childId: value.childId,
        stopReason: value.stopReason,
        successfulMutations: value.successfulMutations,
        ptcDispatches: value.ptcDispatches,
        touchedPaths: value.touchedPaths,
        recommendedOwner: value.recommendedOwner,
      }),
    },
    execute(args, exec) {
      return waitForWorkerSettlement(ctx, args.child_id, exec)
    },
  })
}
