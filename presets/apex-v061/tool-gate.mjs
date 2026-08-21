/**
 * Keep direct Pro work on the Minimal tool pair plus one optional capability
 * broker. Worker controls appear only while their lifecycle state needs them.
 * Durable session events are the only phase state, so task changes, resume,
 * and compaction do not depend on process memory.
 */

import {
  normalizeScopePath,
  scopesOverlap,
  workspaceRelativePath,
} from './work-items.mjs'

export const name = 'apex-tool-gate'
export const inject = []

export const BOOTSTRAP_TOOLS = Object.freeze([
  process.platform === 'win32' ? 'pwsh' : 'bash',
  'str_replace_editor',
])
export const FLASH_MAX_PROVIDER = 'deepseek-official'
export const FLASH_MAX_MODEL = 'deepseek-v4-flash-vision-exp'
export const FLASH_VISION_MODEL = FLASH_MAX_MODEL
export const VISION_CHILD_LABEL_PREFIX = 'APEX visual inspection'
export const CHILD_RESIDENT_TOOLS = Object.freeze([
  'str_replace_editor',
  'read',
  'read_image',
  'glob',
  'grep',
  'report',
])
export const VISION_CHILD_TOOLS = Object.freeze([
  'read_image',
])
export const RESIDENT_TOOLS = Object.freeze([
  ...BOOTSTRAP_TOOLS,
  'dev_tool_search',
])
export const PENDING_WORKER_TOOLS = Object.freeze([
  'apex_wait',
  'interrupt_agent',
])
export const SETTLEMENT_EVIDENCE_TOOLS = Object.freeze([
  'apex_wait',
])
export const REVIEWED_WORKER_TOOLS = Object.freeze([
  'apex_continue',
])
export const QUIESCENT_WORKER_TOOLS = Object.freeze([
  'apex_takeover',
])
export const WORKER_CONTROL_TOOLS = Object.freeze([
  ...PENDING_WORKER_TOOLS,
  ...REVIEWED_WORKER_TOOLS,
  ...QUIESCENT_WORKER_TOOLS,
])
export const UNLOCK_META_KIND = 'apex-dev-tool-search-v061'
export const ROOT_SHELL_HARD_LIMIT = 16
export const DELEGATION_WINDOW_CLOSED_REASON = [
  'APEX v0.6.1 will not lease a path that Pro already mutated in this task.',
  'Keep that path Pro-owned, or delegate a genuinely independent untouched path so Flash cannot repeat completed work.',
].join(' ')

const LEDGER_META_KIND = 'apex-task-ledger-v061'
const TAKEOVER_META_KIND = 'apex-takeover-v061'
const VALIDATION_META_KIND = 'apex-web-validation-v061'
const VISUAL_REVIEW_META_KIND = 'apex-visual-review-v061'
const WORKER_WAIT_META_KIND = 'apex-worker-wait-v061'

const AUTO_CONTEXT_SOURCES = new Set(['agent-instructions', 'skill-catalog'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const MAX_UNLOCKED_TOOLS = 20
const MAX_TOOL_NAME_CHARS = 128

function isManagedFlashModel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) > 0
    && agent?.options?.provider === FLASH_MAX_PROVIDER
    && agent?.options?.model === FLASH_MAX_MODEL
}

function childDescriptor(agent) {
  return agent?.session?.events?.findLast(event => event.type === 'subagent/descriptor')?.data
}

/** Identify only continuable APEX code workers; an unpublished child has no descriptor yet. */
export function isManagedFlashChild(agent) {
  if (!isManagedFlashModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor === undefined || descriptor.mode === 'continuable'
}

/** Identify only the official read-only vision children created by APEX. */
export function isManagedVisionChild(agent) {
  if (!isManagedFlashModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor?.mode === 'one-shot'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(VISION_CHILD_LABEL_PREFIX)
}

/** A real user message starts a new anchored task; plugin messages do not. */
export function isTaskBoundary(event) {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}

function eventsAfterLastBoundary(events, resetOnCompaction) {
  let start = 0
  const queued = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn') {
      const spliceStart = event.data.start
      const removedCount = event.data.removedCount ?? 0
      const inserted = Array.isArray(event.data.inserted) ? event.data.inserted : []
      if (Number.isInteger(spliceStart)
        && spliceStart >= 0
        && spliceStart <= queued.length
        && Number.isInteger(removedCount)
        && removedCount >= 0) {
        const removed = queued.splice(
          spliceStart,
          removedCount,
          ...inserted.map((message) => message?.source?.kind === 'user'),
        )
        // Inbox claim precedes prompt assembly; user/message is appended only
        // after assembly, so this is the earliest durable re-anchor point.
        if (inserted.length === 0
          && event.data.outcome !== 'canceled'
          && removed.some(Boolean)) start = index + 1
      }
      continue
    }
    if ((resetOnCompaction && event.type === 'compaction/end') || isTaskBoundary(event)) {
      start = index + 1
    }
  }
  return events.slice(start)
}

/** Return durable events from the current human task, including earlier compaction epochs. */
export function currentTaskEvents(events = []) {
  return eventsAfterLastBoundary(events, false)
}

/** Return only durable events after the latest human-task or compaction boundary. */
export function currentEpochEvents(events = []) {
  return eventsAfterLastBoundary(events, true)
}

function unlockedTools(event) {
  if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) return []
  if (!Array.isArray(event.data.meta.unlockedTools)) return []
  return event.data.meta.unlockedTools
    .slice(0, MAX_UNLOCKED_TOOLS)
    .filter((value) => (
      typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_TOOL_NAME_CHARS
    ))
}

function successfulToolCalls(events, name) {
  const calls = new Set(events
    .filter(event => event.type === 'tool/call' && event.data?.name === name)
    .map(event => event.data?.callId)
    .filter(callId => typeof callId === 'string'))
  for (const event of events) {
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type === 'tool-result'
        && block.isError !== true
        && calls.has(block.toolCallId)) return true
    }
  }
  return false
}

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
      if (block?.type === 'tool-result' && block.isError !== true) {
        results.set(block.toolCallId, { block, index })
      }
    }
  }
  return results
}

function isImplementationMutation(event) {
  if (event.data?.name === 'write' || event.data?.name === 'edit') return true
  return event.data?.name === 'str_replace_editor'
    && parsedArguments(event).command !== 'view'
}

function implementationMutationPath(agent, event) {
  const args = parsedArguments(event)
  const value = args.path ?? args.file_path
  return normalizeScopePath(workspaceRelativePath(agent, value))
}

/** Return successful Pro mutation paths, plus whether any could not be resolved safely. */
export function successfulImplementationMutationPaths(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const results = successfulResults(events)
  const paths = new Set()
  let unresolved = false
  for (const event of events) {
    if (event.type !== 'tool/call'
      || !results.has(event.data?.callId)
      || !isImplementationMutation(event)) continue
    const path = implementationMutationPath(agent, event)
    if (path === undefined) unresolved = true
    else paths.add(path)
  }
  return { paths: [...paths], unresolved }
}

/** Reject only leases that overlap a successful Pro edit, not unrelated late modules. */
export function delegationPathConflictReason(agent, proposedPaths) {
  const mutations = successfulImplementationMutationPaths(agent)
  if (mutations.unresolved) {
    return `${DELEGATION_WINDOW_CLOSED_REASON} A prior successful mutation has no safely resolved workspace-relative path.`
  }
  const conflicts = mutations.paths.filter(path => (
    proposedPaths.some(scope => scopesOverlap(path, scope))
  ))
  return conflicts.length === 0
    ? undefined
    : `${DELEGATION_WINDOW_CLOSED_REASON} Conflicting Pro-owned path(s): ${conflicts.join(', ')}.`
}

/** Return whether Pro has already committed this task to direct implementation. */
export function hasSuccessfulImplementationMutation(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const results = successfulResults(events)
  return events.some(event => (
    event.type === 'tool/call'
    && results.has(event.data?.callId)
    && isImplementationMutation(event)
  ))
}

/** Count dispatched root-shell calls since the latest successful implementation edit. */
export function shellCallAttemptsSinceEdit(agent, excludedCallId) {
  const events = currentTaskEvents(agent?.session?.events)
  const results = successfulResults(events)
  let calls = 0
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (results.has(event.data?.callId) && isImplementationMutation(event)) calls = 0
    else if (SHELL_TOOLS.has(event.data?.name) && event.data?.callId !== excludedCallId) calls += 1
  }
  return calls
}

/** Preserve the historical successful-call metric used by policy tests and telemetry. */
export function successfulShellCallsSinceEdit(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const results = successfulResults(events)
  let calls = 0
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (results.has(event.data?.callId) && isImplementationMutation(event)) calls = 0
    else if (SHELL_TOOLS.has(event.data?.name) && results.has(event.data?.callId)) calls += 1
  }
  return calls
}

function resultText(block) {
  return Array.isArray(block?.content)
    ? block.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('')
    : ''
}

function workerLifecycle(events) {
  const results = successfulResults(events)
  const activations = new Map()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const result = results.get(event.data?.callId)
    if (result === undefined) continue
    if (event.data?.name === 'apex_build') {
      const childId = resultText(result.block).match(/^started subagent (\S+)$/m)?.[1]
      if (childId !== undefined) activations.set(childId, result.index)
      continue
    }
    if (event.data?.name !== 'apex_continue') continue
    const childId = parsedArguments(event).child_id
    if (typeof childId === 'string' && activations.has(childId)) {
      activations.set(childId, result.index)
    }
  }

  let pending = false
  let awaitingEvidence = false
  let reviewed = false
  let settled = false
  for (const [childId, activationIndex] of activations) {
    const afterActivation = events.slice(activationIndex + 1)
    const hasSettlementMessage = afterActivation.some(event => (
      event.type === 'user/message'
      && event.data?.source?.kind === 'subagent-settled'
      && event.data.source.senderSessionId === childId
    ))
    const hasEvidence = afterActivation.some(event => (
      event.type === 'tool/result'
      && event.data?.meta?.kind === WORKER_WAIT_META_KIND
      && event.data.meta.childId === childId
    ))
    if (!hasSettlementMessage && !hasEvidence) {
      pending = true
      continue
    }
    settled = true
    if (hasEvidence) reviewed = true
    else awaitingEvidence = true
  }
  return { started: activations.size > 0, pending, settled, awaitingEvidence, reviewed }
}

/**
 * Derive the current phase from one session's durable log.
 *
 * ponytail: the O(n) scan keeps resume and compaction correct without a second
 * state store; add an incremental cache only if real session logs make prompt
 * assembly measurably slow.
 */
export function phaseFor(agent) {
  const session = agent?.session
  if (session === undefined) {
    return {
      kind: 'full', promoted: true, unlocked: new Set(), workerStarted: false,
      workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
      workerReviewed: false, proTakeover: false, activated: false,
    }
  }
  if ((session.header?.delegationDepth ?? 0) > 0) {
    if (isManagedVisionChild(agent)) {
      return {
        kind: 'vision-child', promoted: true, unlocked: new Set(), workerStarted: false,
        workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
        workerReviewed: false, proTakeover: false, activated: false,
      }
    }
    if (!isManagedFlashChild(agent)) {
      return {
        kind: 'full', promoted: true, unlocked: new Set(), workerStarted: false,
        workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
        workerReviewed: false, proTakeover: false, activated: false,
      }
    }
    const promoted = currentEpochEvents(session.events).some(event => (
      event.type === 'tool/call' && BOOTSTRAP_TOOLS.includes(event.data?.name)
    ))
    return {
      kind: 'child', promoted, unlocked: new Set(), workerStarted: false,
      workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
      workerReviewed: false, proTakeover: false, activated: false,
    }
  }

  const events = currentEpochEvents(session.events)
  const taskEvents = currentTaskEvents(session.events)
  const unlocked = new Set()
  for (const event of taskEvents) {
    for (const toolName of unlockedTools(event)) unlocked.add(toolName)
  }
  const worker = workerLifecycle(taskEvents)
  const promoted = BOOTSTRAP_TOOLS.some(name => successfulToolCalls(events, name))
  const ledgerActive = taskEvents.some(event => (
    event.type === 'tool/result' && event.data?.meta?.kind === LEDGER_META_KIND
  ))
  const validationActive = taskEvents.some(event => (
    event.type === 'tool/result' && event.data?.meta?.kind === VALIDATION_META_KIND
  ))
  const screenshot = taskEvents
    .map((event, index) => ({ event, index }))
    .findLast(({ event }) => (
      event.type === 'tool/result'
      && event.data?.meta?.kind === VALIDATION_META_KIND
      && event.data.meta.status === 'passed'
      && typeof event.data.meta.screenshotPath === 'string'
      && event.data.meta.screenshotPath.length > 0
    ))
  const visualReviewPending = screenshot !== undefined
    && !taskEvents.slice(screenshot.index + 1).some(event => (
      event.type === 'tool/result'
      && event.data?.meta?.kind === VISUAL_REVIEW_META_KIND
      && Array.isArray(event.data.meta.imagePaths)
      && event.data.meta.imagePaths.includes(screenshot.event.data.meta.screenshotPath)
    ))
  return {
    kind: 'controlled',
    promoted,
    unlocked,
    delegationOpen: true,
    shellPaused: shellCallAttemptsSinceEdit(agent) >= ROOT_SHELL_HARD_LIMIT,
    workerStarted: worker.started,
    workerPending: worker.pending,
    workerSettled: worker.settled,
    workerAwaitingEvidence: worker.awaitingEvidence,
    workerReviewed: worker.reviewed,
    visualReviewPending,
    proTakeover: taskEvents.some(event => (
      event.type === 'tool/result' && event.data?.meta?.kind === TAKEOVER_META_KIND
    )),
    activated: worker.started
      || ledgerActive
      || validationActive
      || [...unlocked].some(toolName => toolName.startsWith('apex_')),
  }
}

function filterMessages(decision, phase) {
  if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  const kept = decision.messages.filter((message) => {
    const source = message?.source?.kind
    if (!AUTO_CONTEXT_SOURCES.has(source)) return true
    if (phase.kind === 'child' || phase.kind === 'vision-child') return false
    if (phase.kind === 'full') return true
    if (source === 'agent-instructions') return false
    return phase.promoted && phase.unlocked.has('skill')
  })
  return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
}

/** Register the request-time tool and automatic-context filters. */
export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const derived = phaseFor(context.agent)
    // A one-shot descriptor is appended during the first pre-step, after its
    // first prompt assembly. Its read_image-only restriction is the durable,
    // host-owned discriminator for that one assembly.
    const phase = derived.kind === 'child'
      && available.has('read_image')
      && !BOOTSTRAP_TOOLS.some(toolName => available.has(toolName))
      ? { ...derived, kind: 'vision-child' }
      : derived
    if (phase.kind === 'full') return assembled

    if (phase.kind !== 'vision-child') {
      const missing = BOOTSTRAP_TOOLS.filter((toolName) => !available.has(toolName))
      if (missing.length > 0) {
        throw new Error(`${name}: missing required Minimal tool(s): ${missing.join(', ')}`)
      }
    }

    const keep = new Set(phase.kind === 'vision-child'
      ? VISION_CHILD_TOOLS
      : phase.kind === 'child'
        ? (phase.promoted ? CHILD_RESIDENT_TOOLS : BOOTSTRAP_TOOLS)
        : (phase.promoted ? RESIDENT_TOOLS : BOOTSTRAP_TOOLS))
    if (phase.kind === 'controlled' && phase.promoted) {
      if (phase.shellPaused) keep.delete(BOOTSTRAP_TOOLS[0])
      if (phase.workerStarted && phase.delegationOpen) {
        keep.add('apex_build')
      }
      if (phase.workerPending) {
        for (const toolName of PENDING_WORKER_TOOLS) {
          if (available.has(toolName)) keep.add(toolName)
        }
      }
      if (phase.workerAwaitingEvidence) {
        for (const toolName of SETTLEMENT_EVIDENCE_TOOLS) {
          if (available.has(toolName)) keep.add(toolName)
        }
      }
      if (phase.workerReviewed) {
        for (const toolName of REVIEWED_WORKER_TOOLS) {
          if (available.has(toolName)) keep.add(toolName)
        }
      }
      if (phase.workerReviewed && !phase.workerPending && !phase.workerAwaitingEvidence) {
        for (const toolName of QUIESCENT_WORKER_TOOLS) {
          if (available.has(toolName)) keep.add(toolName)
        }
      }
      for (const toolName of phase.unlocked) {
        if (toolName === 'apex_build' && !phase.delegationOpen) continue
        if (available.has(toolName)) keep.add(toolName)
      }
      if (phase.unlocked.has('apex_validate_web') && available.has('apex_state')) {
        keep.add('apex_state')
      }
      if (phase.visualReviewPending && available.has('apex_inspect_image')) {
        keep.add('apex_inspect_image')
      }
    }
    return { ...assembled, tools: assembled.tools.filter((tool) => keep.has(tool.name)) }
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    return filterMessages(decision, phaseFor(agent))
  }, { prepend: true })
}
