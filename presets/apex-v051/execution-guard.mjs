/** Deny broad process cleanup and require evidence-scoped research renewal. */

import { LEDGER_META_KIND, normalizeLedger } from './apex-policy.mjs'
import { currentEpochEvents, currentTaskEvents, UNLOCK_META_KIND } from './tool-gate.mjs'

export const name = 'apex-execution-guard'
export const inject = ['tools']

export const BASE_WEB_SEARCH_CALLS = 3
export const APEX_RESEARCH_TOOL = 'apex_research'

export const DENIAL_REASON = [
  'APEX v0.5.1 blocks broad process termination.',
  'Record the PID of the process started by this task and terminate that exact PID instead.',
].join(' ')

export const DUPLICATE_RESEARCH_REASON = [
  'APEX v0.5.1 blocked a duplicate research query in the current task.',
  'Reuse the existing result or target a distinct unresolved gap.',
].join(' ')

export const RESEARCH_EXTENSION_REQUIRED_REASON = [
  `APEX v0.5.1 used its ${BASE_WEB_SEARCH_CALLS} initial direct web_search calls for the current task.`,
  'Request a one-query lease from dev_tool_search with researchGap and a distinct nextWebQuery before searching again.',
].join(' ')

export const RESEARCH_AGENT_REVIEW_REASON = [
  'APEX v0.5.1 requires the main model to judge each Flash research result before another round.',
  'Record a newer apex_state snapshot with the remaining Open evidence gap, then submit a distinct research brief.',
].join(' ')

export const DUPLICATE_RESEARCH_AGENT_REASON = [
  'APEX v0.5.1 blocked a duplicate Flash research brief in the current task.',
  'Reuse the prior evidence or target a different unresolved gap.',
].join(' ')

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const RESEARCH_TOOLS = new Set(['dev_tool_search', 'web_search'])

const BROAD_TERMINATION = [
  /(?:^|[\n;&|()])\s*(?:sudo(?:\s+-\S+)*\s+)?(?:[^\s;&|]+\/)?(?:pkill|killall)(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*(?:[^\s;&|]+[\\/])?taskkill(?:\.exe)?\b[^\r\n;&|]*\/im(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*stop-process\b[^\r\n;|]*-(?:name|inputobject)(?:\s|$)/i,
]

/** Return true for the known name-based process termination forms APEX denies. */
export function isBroadProcessTermination(command) {
  if (typeof command !== 'string') return false
  if (BROAD_TERMINATION.some((pattern) => pattern.test(command))) return true

  return command.split(/\r?\n/).some((line) => (
    /\bpgrep\b/i.test(line) && /\b(?:xargs\s+)?kill\b/i.test(line)
  ) || (
    /\bget-process\b/i.test(line) && /\|\s*stop-process\b/i.test(line)
  ))
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

function isExtensionRequest(value) {
  return typeof value?.nextWebQuery === 'string'
    || typeof value?.researchGap === 'string'
}

function normalizedQuery(value) {
  const query = isExtensionRequest(value) ? value.nextWebQuery : value?.query
  return typeof query === 'string'
    ? query.trim().toLowerCase().replace(/\s+/g, ' ')
    : ''
}

function approvedWebQueries(events) {
  const approved = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) continue
    const values = event.data.meta.approvedWebQueries
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const query = normalizedQuery({ query: value })
      if (query.length > 0 && query.length <= 200) approved.add(query)
    }
  }
  return approved
}

function normalizedBrief(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : ''
}

function hasReviewedGapAfter(events, index) {
  return events.slice(index + 1).some((event) => {
    if (event.type !== 'tool/result'
      || event.data?.meta?.kind !== LEDGER_META_KIND
      || event.data.meta.updated !== true) return false
    const ledger = normalizeLedger(event.data.meta.ledger)
    return ledger !== undefined && ledger.open.length > 0
  })
}

function researchAgentDenial(execution, events) {
  if (execution.name !== APEX_RESEARCH_TOOL) return undefined
  const calls = events.filter((event) => (
    event.type === 'tool/call' && event.data?.name === APEX_RESEARCH_TOOL
  ))
  const previous = calls.filter((event) => event.data?.callId !== execution.callId)
  const brief = normalizedBrief(execution.arguments?.prompt)
  if (brief.length > 0 && previous.some((event) => (
    normalizedBrief(parsedArguments(event).prompt) === brief
  ))) return DUPLICATE_RESEARCH_AGENT_REASON
  if (previous.length === 0) return undefined

  const previousCall = events.findLastIndex((event) => (
    event.type === 'tool/call'
    && event.data?.name === APEX_RESEARCH_TOOL
    && event.data?.callId !== execution.callId
  ))
  return previousCall >= 0 && hasReviewedGapAfter(events, previousCall)
    ? undefined
    : RESEARCH_AGENT_REVIEW_REASON
}

function researchDenial(execution) {
  if (execution?.agent?.session === undefined || !RESEARCH_TOOLS.has(execution.name)) {
    return undefined
  }
  const taskEvents = currentTaskEvents(execution.agent.session.events)
  const extensionRequest = execution.name === 'dev_tool_search'
    && isExtensionRequest(execution.arguments)
  const events = execution.name === 'web_search' || extensionRequest
    ? taskEvents
    : currentEpochEvents(execution.agent.session.events)
  const calls = events.filter((event) => (
    event.type === 'tool/call'
    && event.data?.name === execution.name
    && (execution.name !== 'dev_tool_search'
      || isExtensionRequest(parsedArguments(event)) === extensionRequest)
  ))

  const query = normalizedQuery(execution.arguments)
  if (query.length === 0) return undefined
  const duplicate = calls.some((event) => (
    event.data?.callId !== execution.callId
    && normalizedQuery(parsedArguments(event)) === query
  ))
  if (duplicate) return DUPLICATE_RESEARCH_REASON

  const currentLogged = typeof execution.callId === 'string'
    && calls.some((event) => event.data?.callId === execution.callId)
  const attempts = calls.length + (currentLogged ? 0 : 1)
  if (execution.name === 'web_search'
    && attempts > BASE_WEB_SEARCH_CALLS
    && !approvedWebQueries(events).has(query)) {
    return RESEARCH_EXTENSION_REQUIRED_REASON
  }
  return undefined
}

/** Monotonic tool guard: it can deny an unsafe call but never force an allow. */
export function guardExecution(execution) {
  if (SHELL_TOOLS.has(execution?.name)) {
    const command = execution?.arguments?.command
    if (isBroadProcessTermination(command)) return DENIAL_REASON
  }
  if (execution?.agent?.session !== undefined) {
    const denial = researchAgentDenial(
      execution,
      currentTaskEvents(execution.agent.session.events),
    )
    if (denial !== undefined) return denial
  }
  return researchDenial(execution)
}

export function apply(ctx) {
  ctx.tools.guard(guardExecution)
}
