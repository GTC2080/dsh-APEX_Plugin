/**
 * Keep direct Pro work on the Minimal tool pair plus one optional capability
 * broker. Worker controls appear only while their lifecycle state needs them.
 * Durable session events are the only phase state, so task changes, resume,
 * and compaction do not depend on process memory.
 */

import { readdirSync } from 'node:fs'

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
export const FLASH_MAX_REASONING_EFFORT = 'max'
export const PRO_MAX_PROVIDER = 'deepseek-official'
export const PRO_MAX_MODEL = 'deepseek-v4-pro'
export const PRO_MAX_REASONING_EFFORT = 'max'
export const APEX_CODE_CHILD_LABEL_PREFIX = 'APEX PTC code worker'
// Compatibility alias for already-persisted v0.6.3 sessions and callers.
export const FLASH_CODE_CHILD_LABEL_PREFIX = APEX_CODE_CHILD_LABEL_PREFIX
export const VISION_CHILD_LABEL_PREFIX = 'APEX visual inspection'
export const RESEARCH_CHILD_LABEL_PREFIX = 'APEX evidence research'
export const PTC_TRANSPORT_TOOL = 'run_code'
// ponytail: keep this discriminator only to quarantine already-persisted
// reviewer sessions; remove it after those sessions can no longer be resumed.
const LEGACY_REVIEW_PROVIDER = 'deepseek-official'
const LEGACY_REVIEW_MODEL = 'deepseek-v4-pro'
const LEGACY_REVIEW_CHILD_LABEL_PREFIX = 'APEX evidence review'
export const RESEARCH_SOURCE_TOOL = 'apex_research_read_source'
export const RESEARCH_SOURCE_META_KIND = 'apex-research-source-v063'
export const RESEARCH_DEFERRED_SEARCH_PREFIX = 'APEX research did not execute this search.'
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
  'structured_output',
])
export const RESEARCH_CHILD_TOOLS = Object.freeze([
  'web_search',
  RESEARCH_SOURCE_TOOL,
  'structured_output',
])
const LEGACY_REVIEW_CHILD_TOOLS = Object.freeze([
  'read',
  'glob',
  'grep',
  'web_search',
  'structured_output',
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
export const UNLOCK_META_KIND = 'apex-dev-tool-search-v063'
export const WEB_VALIDATION_META_KIND = 'apex-web-validation-v063'
export const DELIVERY_META_KIND = 'apex-delivery-verification-v063'
export const RESEARCH_META_KIND = 'apex-research-v063'
export const DELEGATION_WINDOW_CLOSED_REASON = [
  'APEX v0.6.3 will not lease a path that Pro already mutated in this task.',
  'Keep that path Pro-owned, or delegate a genuinely independent untouched path so Flash cannot repeat completed work.',
].join(' ')

const LEDGER_META_KIND = 'apex-task-ledger-v063'
const TAKEOVER_META_KIND = 'apex-takeover-v063'
const VALIDATION_META_KIND = WEB_VALIDATION_META_KIND
export const VISUAL_META_KIND = 'apex-visual-review-v063'
const WORKER_WAIT_META_KIND = 'apex-worker-wait-v063'

const AUTO_CONTEXT_SOURCES = new Set(['agent-instructions', 'skill-catalog'])
const MAX_UNLOCKED_TOOLS = 20
const MAX_TOOL_NAME_CHARS = 128

function isManagedFlashModel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) > 0
    && agent?.options?.provider === FLASH_MAX_PROVIDER
    && agent?.options?.model === FLASH_MAX_MODEL
}

function isManagedProModel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) > 0
    && agent?.options?.provider === PRO_MAX_PROVIDER
    && agent?.options?.model === PRO_MAX_MODEL
}

function isLegacyReviewModel(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) > 0
    && agent?.options?.provider === LEGACY_REVIEW_PROVIDER
    && agent?.options?.model === LEGACY_REVIEW_MODEL
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

/** Identify new code workers that use the official child-scoped PTC surface. */
export function isManagedPtcFlashChild(agent) {
  if (!isManagedFlashChild(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor?.mode === 'continuable'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(FLASH_CODE_CHILD_LABEL_PREFIX)
}

/** Identify either role of continuable APEX code worker using official PTC. */
export function isManagedPtcCodeChild(agent) {
  if (!isManagedFlashModel(agent) && !isManagedProModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor?.mode === 'continuable'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(APEX_CODE_CHILD_LABEL_PREFIX)
}

/** Identify the bounded Vision Flash production role. */
export function isManagedFlashProductionChild(agent) {
  return isManagedFlashModel(agent) && isManagedPtcCodeChild(agent)
}

/** Identify the Pro Max core implementation role. */
export function isManagedProCoreChild(agent) {
  return isManagedProModel(agent) && isManagedPtcCodeChild(agent)
}

/** Identify only the official read-only vision children created by APEX. */
export function isManagedVisionChild(agent) {
  if (!isManagedFlashModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor?.mode === 'one-shot'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(VISION_CHILD_LABEL_PREFIX)
}

/** Identify only the retrieval-only Vision Flash researchers created by APEX. */
export function isManagedResearchChild(agent) {
  if (!isManagedFlashModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor?.mode === 'one-shot'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(RESEARCH_CHILD_LABEL_PREFIX)
}

/** Keep old reviewer sessions read-only without exposing any way to create new ones. */
export function isLegacyReviewChild(agent) {
  if (!isLegacyReviewModel(agent)) return false
  const descriptor = childDescriptor(agent)
  return descriptor === undefined || (
    descriptor.mode === 'one-shot'
    && typeof descriptor.label === 'string'
    && descriptor.label.startsWith(LEGACY_REVIEW_CHILD_LABEL_PREFIX)
  )
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

/** Return the session-wide evidence stream used by follow-up repair rounds. */
export function sessionEvidenceEvents(events = []) {
  return events
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

/** Hide discovery for the one request immediately following a successful unlock. */
function hasFreshCapabilityUnlock(events) {
  const epochEvents = currentEpochEvents(events)
  const index = epochEvents.findLastIndex(event => unlockedTools(event).length > 0)
  if (index < 0) return false
  return !epochEvents.slice(index + 1).some(event => event.type === 'tool/call')
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

function normalizedResearchUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return undefined
    }
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

function successfulResultBlocks(event) {
  if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) return []
  return event.data.message.content.filter(block => (
    block?.type === 'tool-result'
    && block.isError !== true
    && typeof block.toolCallId === 'string'
  ))
}

const TERMINAL_RESEARCH_SEARCH_CODES = new Set([
  'WEB_DUPLICATE_PROVIDER',
  'WEB_PROVIDER_AMBIGUOUS',
  'WEB_PROVIDER_CONFIGURED_MISSING',
  'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  'WEB_PROVIDER_CREDENTIAL_MISSING',
  'WEB_PROVIDER_UNAVAILABLE',
])
const RETRYABLE_RESEARCH_HTTP_STATUSES = new Set([408, 409, 425, 429])

function failedResultBlocks(event) {
  if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) return []
  return event.data.message.content.filter(block => (
    block?.type === 'tool-result'
    && block.isError === true
    && typeof block.toolCallId === 'string'
  ))
}

function toolResultText(block) {
  if (typeof block?.content === 'string') return block.content
  if (!Array.isArray(block?.content)) return ''
  return block.content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
}

function researchSearchFailure(event, block) {
  const rawCode = event.data?.error?.code
  const code = typeof rawCode === 'string' && rawCode.length > 0 && rawCode.length <= 128
    ? rawCode
    : 'UNKNOWN'
  if (code === 'WEB_ABORTED') return undefined

  const text = toolResultText(block)
  const statusMatch = text.match(/\bHTTP\s+(\d{3})\b/i)
  const status = statusMatch === null ? undefined : Number.parseInt(statusMatch[1], 10)
  const endpointMatch = text.match(/web search request used endpoint\s+("(?:\\.|[^"\\])*")\./i)
  let endpoint
  if (endpointMatch !== null) {
    try {
      const value = JSON.parse(endpointMatch[1])
      if (typeof value === 'string') endpoint = value.slice(0, 2_048)
    } catch {
      // The endpoint is diagnostic evidence only; malformed prose stays untrusted.
    }
  }
  const message = text
    .replace(/^Error:\s*/i, '')
    .split(/\n\s*\n/, 1)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512)
  const terminal = TERMINAL_RESEARCH_SEARCH_CODES.has(code)
    || (status !== undefined
      && status >= 400
      && status < 500
      && !RETRYABLE_RESEARCH_HTTP_STATUSES.has(status))
  return {
    code,
    endpoint,
    status,
    terminal,
    fingerprint: JSON.stringify([code, endpoint ?? '', status ?? '', message]),
  }
}

/**
 * Derive the research child's evidence progress from durable tool results.
 * Search is paused while a newly discovered URL still needs one direct read,
 * after two searches add no URL, after a deterministic provider failure, or
 * after one recovery attempt repeats the same provider failure. A successful
 * search, new URL, or content hash restores progress without imposing a
 * task-wide research count.
 */
export function researchChildEvidenceState(agent) {
  const calls = new Map()
  const discovered = new Map()
  const readUrls = new Set()
  const contentHashes = new Set()
  const pendingReadUrls = new Set()
  let consecutiveNoNewSearches = 0
  let searchFailure

  for (const event of sessionEvidenceEvents(agent?.session?.events)) {
    if (event.type === 'tool/call'
      && typeof event.data?.callId === 'string'
      && typeof event.data?.name === 'string') {
      calls.set(event.data.callId, event.data.name)
      continue
    }
    for (const block of failedResultBlocks(event)) {
      if (calls.get(block.toolCallId) !== 'web_search') continue
      const failure = researchSearchFailure(event, block)
      if (failure === undefined) continue
      searchFailure = searchFailure?.fingerprint === failure.fingerprint
        ? { ...failure, attempts: searchFailure.attempts + 1 }
        : { ...failure, attempts: 1 }
    }
    for (const block of successfulResultBlocks(event)) {
      const toolName = calls.get(block.toolCallId)
      if (toolName === 'web_search') {
        if (typeof event.data?.meta?.answer === 'string'
          && event.data.meta.answer.startsWith(RESEARCH_DEFERRED_SEARCH_PREFIX)) continue
        searchFailure = undefined
        const added = []
        const sources = Array.isArray(event.data?.meta?.sources) ? event.data.meta.sources : []
        for (const source of sources) {
          const url = normalizedResearchUrl(source?.url)
          if (url === undefined || discovered.has(url)) continue
          discovered.set(url, {
            url,
            title: typeof source?.title === 'string' && source.title.trim().length > 0
              ? source.title.trim().slice(0, 300)
              : url,
          })
          added.push(url)
        }
        if (added.length === 0) {
          consecutiveNoNewSearches += 1
        } else {
          consecutiveNoNewSearches = 0
          for (const url of added) pendingReadUrls.add(url)
        }
        continue
      }
      if (toolName !== RESEARCH_SOURCE_TOOL
        || event.data?.meta?.kind !== RESEARCH_SOURCE_META_KIND) continue
      const url = normalizedResearchUrl(event.data.meta.url)
      if (url === undefined || !discovered.has(url)) continue
      readUrls.add(url)
      pendingReadUrls.delete(url)
      const contentHash = event.data.meta.contentHash
      if (event.data.meta.available === true
        && typeof contentHash === 'string'
        && /^[a-f0-9]{64}$/.test(contentHash)
        && !contentHashes.has(contentHash)) {
        contentHashes.add(contentHash)
        pendingReadUrls.clear()
        consecutiveNoNewSearches = 0
      }
    }
  }

  const searchFailureBlocked = searchFailure !== undefined
    && (searchFailure.terminal || searchFailure.attempts >= 2)

  return {
    discoveredSources: [...discovered.values()],
    unreadSources: [...discovered.values()].filter(source => !readUrls.has(source.url)),
    readUrls: [...readUrls],
    contentHashes: [...contentHashes],
    awaitingSourceRead: pendingReadUrls.size > 0,
    consecutiveNoNewSearches,
    searchFailure: searchFailure === undefined ? undefined : {
      code: searchFailure.code,
      endpoint: searchFailure.endpoint,
      status: searchFailure.status,
      attempts: searchFailure.attempts,
      terminal: searchFailure.terminal,
    },
    searchFailureBlocked,
  }
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

export function hasHtmlArtifact(agent) {
  if (successfulImplementationMutationPaths(agent).paths.some(path => /\.html?$/i.test(path))) return true
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .some(entry => entry.isFile() && /\.html?$/i.test(entry.name))
  } catch {
    return false
  }
}

/** Detect an existing bounded project surface without walking the workspace tree. */
export function hasWorkspaceArtifact(agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  try {
    return readdirSync(cwd, { withFileTypes: true }).some(entry => (
      !['.DS_Store', '.apex-evidence', '.git', '.cache', 'coverage', 'node_modules'].includes(entry.name)
      && (entry.isFile() || entry.isDirectory())
    ))
  } catch {
    return false
  }
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

function latestValidationCapture(events) {
  return events
    .map((event, index) => ({ event, index }))
    .findLast(({ event }) => (
      event.type === 'tool/result'
      && event.data?.meta?.kind === WEB_VALIDATION_META_KIND
      && typeof event.data.meta.screenshotPath === 'string'
      && event.data.meta.screenshotPath.length > 0
  ))
}

function visualReviewForPath(event, path) {
  return event.type === 'tool/result'
    && event.data?.meta?.kind === VISUAL_META_KIND
    && Array.isArray(event.data.meta.imagePaths)
    && event.data.meta.imagePaths.includes(path)
}

export function pendingValidationScreenshot(agent) {
  const events = sessionEvidenceEvents(agent?.session?.events)
  const capture = latestValidationCapture(events)
  if (capture === undefined) return undefined
  const path = capture.event.data.meta.screenshotPath
  const review = events.slice(capture.index + 1).findLast(event => visualReviewForPath(event, path))
  if (review !== undefined && review.data.meta.verdict !== 'inconclusive') return undefined
  return {
    index: capture.index,
    path,
  }
}

/**
 * Reduce the latest host screenshot to one task-local evidence state.
 *
 * An older settled capture must not hide Vision for an unrelated new human
 * task. An older still-pending capture remains reviewable across that boundary,
 * and a review performed in the new task owns its resulting state.
 */
export function currentWebVisualEvidenceState(agent) {
  const events = sessionEvidenceEvents(agent?.session?.events)
  const capture = latestValidationCapture(events)
  if (capture === undefined) return { kind: 'none' }

  const path = capture.event.data.meta.screenshotPath
  const taskEvents = currentTaskEvents(events)
  const taskReviews = taskEvents.filter(event => visualReviewForPath(event, path))
  const pending = pendingValidationScreenshot(agent)
  const belongsToCurrentTask = taskEvents.includes(capture.event) || taskReviews.length > 0
  if (!belongsToCurrentTask) {
    return pending?.path === path
      ? { kind: 'pending', path }
      : { kind: 'none' }
  }

  const reviews = events.slice(capture.index + 1).filter(event => visualReviewForPath(event, path))
  const latest = reviews.at(-1)
  if (latest === undefined || latest.data.meta.verdict === 'inconclusive') {
    return { kind: 'pending', path }
  }

  const openIssueIds = new Set()
  for (const review of reviews) {
    const meta = review.data.meta
    for (const issueId of Array.isArray(meta.resolvedIssueIds) ? meta.resolvedIssueIds : []) {
      if (typeof issueId === 'string') openIssueIds.delete(issueId)
    }
    for (const finding of Array.isArray(meta.findings) ? meta.findings : []) {
      if (finding?.severity === 'blocking' && typeof finding.issueId === 'string') {
        openIssueIds.add(finding.issueId)
      }
    }
  }
  const remainingGaps = (Array.isArray(latest.data.meta.remainingGaps)
    ? latest.data.meta.remainingGaps
    : []).filter(value => typeof value === 'string' && value.length > 0)
  const common = {
    path,
    artifactHash: typeof capture.event.data.meta.artifactHash === 'string'
      ? capture.event.data.meta.artifactHash
      : '',
    openIssueIds: [...openIssueIds],
    remainingGaps,
  }
  if (latest.data.meta.verdict === 'repair' || openIssueIds.size > 0) {
    return { kind: 'repair', ...common }
  }
  if (latest.data.meta.verdict !== 'pass') return { kind: 'pending', ...common }
  if (remainingGaps.length > 0) return { kind: 'unresolved', ...common }
  const latestReviewIndex = events.findLastIndex(event => visualReviewForPath(event, path))
  const explicitlyReopened = events.slice(latestReviewIndex + 1).some(event => (
    unlockedTools(event).includes('apex_inspect_image')
  ))
  if (explicitlyReopened) return { kind: 'reopened', ...common }
  return { kind: 'closed', ...common }
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
    if (isLegacyReviewChild(agent)) {
      return {
        kind: 'legacy-review-child', promoted: true, unlocked: new Set(), workerStarted: false,
        workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
        workerReviewed: false, proTakeover: false, activated: false,
      }
    }
    if (isManagedVisionChild(agent)) {
      return {
        kind: 'vision-child', promoted: true, unlocked: new Set(), workerStarted: false,
        workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
        workerReviewed: false, proTakeover: false, activated: false,
      }
    }
    if (isManagedResearchChild(agent)) {
      return {
        kind: 'research-child', promoted: true, unlocked: new Set(), workerStarted: false,
        workerPending: false, workerSettled: false, workerAwaitingEvidence: false,
        workerReviewed: false, proTakeover: false, activated: false,
      }
    }
    if (isManagedPtcCodeChild(agent)) {
      return {
        kind: 'child', promoted: true, unlocked: new Set(), workerStarted: false,
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
  const validationActive = sessionEvidenceEvents(session.events).some(event => (
    event.type === 'tool/result' && event.data?.meta?.kind === VALIDATION_META_KIND
  ))
  const deliveryActive = taskEvents.some(event => (
    event.type === 'tool/result' && event.data?.meta?.kind === DELIVERY_META_KIND
  ))
  return {
    kind: 'controlled',
    promoted,
    unlocked,
    delegationOpen: true,
    workerStarted: worker.started,
    workerPending: worker.pending,
    workerSettled: worker.settled,
    workerAwaitingEvidence: worker.awaitingEvidence,
    workerReviewed: worker.reviewed,
    proTakeover: taskEvents.some(event => (
      event.type === 'tool/result' && event.data?.meta?.kind === TAKEOVER_META_KIND
    )),
    activated: worker.started
      || ledgerActive
      || validationActive
      || deliveryActive
      || [...unlocked].some(toolName => toolName.startsWith('apex_')),
  }
}

function filterMessages(decision, phase) {
  if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  const kept = decision.messages.filter((message) => {
    const source = message?.source?.kind
    if (!AUTO_CONTEXT_SOURCES.has(source)) return true
    if (phase.kind === 'child'
      || phase.kind === 'ptc-child'
      || phase.kind === 'vision-child'
      || phase.kind === 'research-child'
      || phase.kind === 'legacy-review-child') return false
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
    const expectsPtcChild = derived.kind === 'child' && isManagedPtcCodeChild(context.agent)
    // A one-shot descriptor is appended during the first pre-step, after its
    // first prompt assembly. Its Vision-only restriction is the durable,
    // host-owned discriminator for that one assembly.
    const childBootstrapMissing = derived.kind === 'child'
      && !expectsPtcChild
      && !BOOTSTRAP_TOOLS.some(toolName => available.has(toolName))
    const phase = expectsPtcChild
      ? { ...derived, kind: 'ptc-child', promoted: true }
      : childBootstrapMissing && available.has('read_image')
        ? { ...derived, kind: 'vision-child' }
        : childBootstrapMissing && available.has('web_search')
          ? { ...derived, kind: 'research-child' }
          : derived
    if (phase.kind === 'full') return assembled

    if (phase.kind === 'ptc-child' && !available.has(PTC_TRANSPORT_TOOL)) {
      throw new Error(`${name}: missing required PTC transport: ${PTC_TRANSPORT_TOOL}`)
    }

    if (phase.kind !== 'ptc-child'
      && phase.kind !== 'vision-child'
      && phase.kind !== 'research-child'
      && phase.kind !== 'legacy-review-child') {
      const missing = BOOTSTRAP_TOOLS.filter((toolName) => !available.has(toolName))
      if (missing.length > 0) {
        throw new Error(`${name}: missing required Minimal tool(s): ${missing.join(', ')}`)
      }
    }

    const researchEvidence = phase.kind === 'research-child'
      ? researchChildEvidenceState(context.agent)
      : undefined
    const researchTools = new Set(['structured_output'])
    if (researchEvidence !== undefined) {
      if (!researchEvidence.awaitingSourceRead
        && researchEvidence.consecutiveNoNewSearches < 2
        && !researchEvidence.searchFailureBlocked) researchTools.add('web_search')
      if (researchEvidence.unreadSources.length > 0) researchTools.add(RESEARCH_SOURCE_TOOL)
    }
    const visualEvidence = phase.kind === 'controlled'
      ? currentWebVisualEvidenceState(context.agent)
      : { kind: 'none' }
    const keep = new Set(phase.kind === 'vision-child'
      ? VISION_CHILD_TOOLS
      : phase.kind === 'research-child'
        ? researchTools
        : phase.kind === 'legacy-review-child'
          ? LEGACY_REVIEW_CHILD_TOOLS
          : phase.kind === 'ptc-child'
            ? [PTC_TRANSPORT_TOOL]
            : phase.kind === 'child'
              ? (phase.promoted ? CHILD_RESIDENT_TOOLS : BOOTSTRAP_TOOLS)
              : (phase.promoted ? RESIDENT_TOOLS : BOOTSTRAP_TOOLS))
    if (phase.kind === 'controlled' && phase.promoted) {
      if (hasHtmlArtifact(context.agent) && available.has('apex_validate_web')) {
        keep.add('apex_validate_web')
      }
      if (!phase.workerPending
        && !phase.workerAwaitingEvidence
        && hasWorkspaceArtifact(context.agent)
        && available.has('apex_verify_delivery')) {
        keep.add('apex_verify_delivery')
      }
      if (['unresolved', 'reopened'].includes(visualEvidence.kind)
        && available.has('apex_inspect_image')) {
        keep.add('apex_inspect_image')
      }
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
        // The Pro parent is text-only. Visual bytes must cross the bounded
        // apex_inspect_image bridge, including when an older session leased
        // read_image before this rule existed.
        if (toolName === 'read_image') continue
        if (toolName === 'apex_build' && !phase.delegationOpen) continue
        if (toolName === 'apex_inspect_image'
          && ['closed', 'repair'].includes(visualEvidence.kind)) continue
        if (available.has(toolName)) keep.add(toolName)
      }
      if (hasFreshCapabilityUnlock(context.agent?.session?.events)) {
        keep.delete('dev_tool_search')
      }
    }
    return { ...assembled, tools: assembled.tools.filter((tool) => keep.has(tool.name)) }
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    return filterMessages(decision, phaseFor(agent))
  }, { prepend: true })
}
