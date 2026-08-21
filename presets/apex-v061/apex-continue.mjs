/** Continue one leased Flash worker without making the model hand-author a protocol frame. */

import {
  parseContinuationArguments,
  parseTakeoverArguments,
  renderContinuationMessage,
  TAKEOVER_REASONS,
  workItemFromEvents,
} from './work-items.mjs'
import { currentTaskEvents } from './tool-gate.mjs'
import {
  pendingWorkerIds,
  workerEvidenceFromInspection,
  workerSettlementState,
  WORKER_WAIT_META_KIND,
} from './worker-wait.mjs'
import { WEB_VALIDATION_META_KIND } from './apex-validation.mjs'

export const name = 'apex-continue-v061'
export const inject = ['tools', 'subagents', 'sessionPersistence']
export const APEX_TAKEOVER_META_KIND = 'apex-takeover-v061'

export const APEX_CONTINUE_DESCRIPTION = [
  'Continue one existing APEX Flash worker after Pro review found a concrete defect.',
  'Pass the child id, matching work-item id, 1-8 new file-inspection findings, and one bounded repair instruction once.',
  'The host validates ownership and inspection evidence, then compiles the canonical continuation message.',
].join(' ')

export const APEX_TAKEOVER_DESCRIPTION = [
  'Transfer one settled APEX worker lease to the Pro parent when host evidence shows Flash cannot safely finish the defect.',
  'Use only after apex_wait and a successful read of the leased scope.',
  'The transfer is durable, blocks later continuation of that worker, and exposes parent editing only for the transferred paths.',
].join(' ')

/** Return the durable transfer for one child in the current human task. */
export function takeoverForChild(events, childId) {
  return currentTaskEvents(events).find(event => (
    event.type === 'tool/result'
    && event.data?.meta?.kind === APEX_TAKEOVER_META_KIND
    && event.data.meta.childId === childId
  ))
}

function takeoverReasonDenial(reason, evidence, parentEvents, childId) {
  if (reason === 'worker_max_tokens' && evidence.stopReason !== 'max-tokens') {
    return `worker_max_tokens requires durable stopReason=max-tokens, not ${evidence.stopReason}.`
  }
  if (reason === 'worker_failed'
    && !['error', 'aborted', 'refusal'].includes(evidence.stopReason)) {
    return `worker_failed requires durable stopReason error, aborted, or refusal, not ${evidence.stopReason}.`
  }
  if (reason === 'no_write_progress' && evidence.successfulMutations !== 0) {
    return `no_write_progress requires zero successful mutations, not ${evidence.successfulMutations}.`
  }

  const validations = currentTaskEvents(parentEvents)
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'tool/result'
      && event.data?.meta?.kind === WEB_VALIDATION_META_KIND)
  if (reason === 'final_runtime_failure') {
    const final = validations.findLast(({ event }) => event.data.meta.mode === 'final')
    if (final?.event.data.meta.status !== 'failed'
      || final.event.data.meta.failureClass !== 'application-runtime'
      || final.event.data.meta.repairEligible !== true) {
      return 'final_runtime_failure requires a failed final host validation classified as a repair-eligible application runtime error.'
    }
  }
  if (reason === 'repeated_runtime_failure') {
    const failures = validations.filter(({ event }) => (
      event.data.meta.status === 'failed'
      && event.data.meta.failureClass === 'application-runtime'
      && typeof event.data.meta.diagnosticHash === 'string'
      && event.data.meta.diagnosticHash.length > 0
    ))
    const repeated = failures.findLast((right, rightIndex) => failures
      .slice(0, rightIndex)
      .some(left => {
        if (left.event.data.meta.diagnosticHash !== right.event.data.meta.diagnosticHash) return false
        return currentTaskEvents(parentEvents).slice(left.index + 1, right.index).some(event => (
          event.type === 'tool/result'
          && event.data?.meta?.kind === WORKER_WAIT_META_KIND
          && event.data.meta.childId === childId
          && event.data.meta.successfulMutations > 0
        ))
      }))
    if (repeated === undefined) {
      return 'repeated_runtime_failure requires the same host diagnostic hash before and after a settled worker repair with a successful mutation.'
    }
  }
  return undefined
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'apex_takeover',
    description: APEX_TAKEOVER_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        child_id: { type: 'string', minLength: 1, maxLength: 128 },
        work_item_id: { type: 'string', minLength: 1, maxLength: 64 },
        reason: {
          type: 'string',
          enum: [...TAKEOVER_REASONS],
        },
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 400 },
          description: 'Concrete findings from the Pro parent reading the leased files and relevant validation evidence.',
        },
      },
      required: ['child_id', 'work_item_id', 'reason', 'evidence'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          workItemId: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['childId', 'workItemId', 'paths', 'reason', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: APEX_TAKEOVER_META_KIND,
        childId: value.childId,
        workItemId: value.workItemId,
        paths: value.paths,
        reason: value.reason,
      }),
    },
    async execute(args, exec) {
      if (exec.agent?.session === undefined) throw new Error('apex_takeover requires a calling parent agent')
      const parsed = parseTakeoverArguments(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const state = workerSettlementState(exec.agent, parsed.value.childId)
      if (!state.known || !state.settled) {
        throw new Error('apex_takeover requires a worker started and settled in this human task')
      }
      if (pendingWorkerIds(exec.agent).length > 0) {
        throw new Error('apex_takeover waits until every current APEX worker settles before exposing parent writes')
      }
      if (takeoverForChild(exec.agent.session.events, parsed.value.childId) !== undefined) {
        throw new Error(`APEX worker ${parsed.value.childId} was already transferred to the Pro parent`)
      }

      const inspection = await ctx.sessionPersistence.inspect(parsed.value.childId, exec.signal)
      const workItem = workItemFromEvents(inspection.events)
      if (workItem === undefined || workItem.id !== parsed.value.workItemId) {
        throw new Error('apex_takeover work_item_id does not match the durable child lease')
      }
      const evidence = workerEvidenceFromInspection(inspection)
      const denial = takeoverReasonDenial(
        parsed.value.reason,
        evidence,
        exec.agent.session.events,
        parsed.value.childId,
      )
      if (denial !== undefined) throw new Error(denial)
      return {
        childId: parsed.value.childId,
        workItemId: workItem.id,
        paths: workItem.paths,
        reason: parsed.value.reason,
        text: `Lease ${workItem.id} transferred from ${parsed.value.childId} to the Pro parent for: ${workItem.paths.join(', ')}. Inspect and edit only these paths, then run the smallest failed check. This worker cannot be continued again.`,
      }
    },
  })

  ctx.tools.register({
    name: 'apex_continue',
    description: APEX_CONTINUE_DESCRIPTION,
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
        work_item_id: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'The original apex_build work-item id for this child.',
        },
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 400 },
          description: 'New concrete findings from reading files in the leased scope after the latest worker feedback.',
        },
        instruction: {
          type: 'string',
          minLength: 1,
          maxLength: 2_000,
          description: 'One bounded repair instruction addressing only those findings.',
        },
      },
      required: ['child_id', 'work_item_id', 'evidence', 'instruction'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['childId', 'messageId'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `repair queued as the next turn for APEX worker ${value.childId}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('apex_continue requires a calling parent agent')
      const parsed = parseContinuationArguments(args)
      if (!parsed.ok) throw new Error(parsed.error)
      if (takeoverForChild(exec.agent.session?.events, parsed.value.childId) !== undefined) {
        throw new Error(`APEX worker ${parsed.value.childId} was transferred to the Pro parent and cannot be continued`)
      }
      const messageId = await ctx.subagents.followup(
        exec.agent,
        parsed.value.childId,
        [{ type: 'text', text: renderContinuationMessage(parsed.value) }],
        {
          source: {
            kind: 'coordinator',
            form: 'relay',
            senderSessionId: exec.agent.id,
          },
          signal: exec.signal,
        },
      )
      return { childId: parsed.value.childId, messageId }
    },
  })
}
