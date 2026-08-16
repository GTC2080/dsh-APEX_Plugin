/** Deny broad process cleanup and enforce durable per-task research budgets. */

import {
  LEDGER_META_KIND,
  MAX_APEX_RESEARCH_CALLS,
  normalizeLedger,
} from './apex-policy.mjs'
import { currentEpochEvents, currentTaskEvents, UNLOCK_META_KIND } from './tool-gate.mjs'

export const name = 'apex-execution-guard'
export const inject = ['tools']

export const MAX_DEV_TOOL_SEARCH_CALLS = 4
export const BASE_WEB_SEARCH_CALLS = 3
export const MAX_RESEARCH_EXTENSION_CALLS = 7
export const MAX_WEB_SEARCH_CALLS = BASE_WEB_SEARCH_CALLS + MAX_RESEARCH_EXTENSION_CALLS
export const APEX_RESEARCH_TOOL = 'apex_research'

export const DENIAL_REASON = [
  'APEX v0.5 blocks broad process termination.',
  'Record the PID of the process started by this task and terminate that exact PID instead.',
].join(' ')

export const DUPLICATE_RESEARCH_REASON = [
  'APEX v0.5 blocked a duplicate research query in the current task.',
  'Reuse the existing result or change to implementation; do not retry the same query.',
].join(' ')

export const RESEARCH_BUDGET_REASON = [
  'APEX v0.5 direct research budget exhausted for the current task.',
  `The hard limit is ${MAX_DEV_TOOL_SEARCH_CALLS} catalog-discovery calls, ${MAX_RESEARCH_EXTENSION_CALLS} research extensions, and ${MAX_WEB_SEARCH_CALLS} web_search calls.`,
  'Use the evidence already collected and continue with implementation or truthful delivery.',
].join(' ')

export const RESEARCH_EXTENSION_REQUIRED_REASON = [
  `APEX v0.5 used its ${BASE_WEB_SEARCH_CALLS} default web_search calls for the current task.`,
  'Request one evidence-based continuation from dev_tool_search with researchGap and a distinct nextWebQuery before searching again.',
].join(' ')

export const RESEARCH_DELEGATION_REASON = [
  'APEX v0.5 blocks generic delegation and orchestration after the default direct web_search budget is used for the current task.',
  'Continue locally, request a scoped direct-search continuation, or use the dedicated apex_research evidence path; do not route research through a generic agent or workflow.',
].join(' ')

export const RESEARCH_AGENT_BUDGET_REASON = [
  `APEX v0.5 limits dedicated Flash research to ${MAX_APEX_RESEARCH_CALLS} rounds per human task.`,
  'Use the collected evidence and report any remaining unsupported fact.',
].join(' ')

export const RESEARCH_AGENT_REVIEW_REASON = [
  'APEX v0.5 requires the main model to judge each Flash research result before another round.',
  'Record a newer apex_state snapshot with the remaining Open evidence gap, then submit a distinct research brief.',
].join(' ')

export const DUPLICATE_RESEARCH_AGENT_REASON = [
  'APEX v0.5 blocked a duplicate Flash research brief in the current task.',
  'Reuse the prior evidence or target a different unresolved gap.',
].join(' ')

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const RESEARCH_TOOLS = new Set(['dev_tool_search', 'web_search'])
const DELEGATION_TOOLS = new Set([
  'ralph',
  'send_message',
  'subagent',
  'subagent_fork',
  'workflow',
])

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

function normalizedQuery(argumentsValue) {
  const value = isExtensionRequest(argumentsValue)
    ? argumentsValue.nextWebQuery
    : argumentsValue?.query
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : ''
}

function isExtensionRequest(argumentsValue) {
  return typeof argumentsValue?.nextWebQuery === 'string'
    || typeof argumentsValue?.researchGap === 'string'
}

function approvedWebQueries(events) {
  const approved = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) continue
    const values = event.data.meta.approvedWebQueries
    if (!Array.isArray(values)) continue
    for (const value of values.slice(0, MAX_RESEARCH_EXTENSION_CALLS)) {
      const query = normalizedQuery({ query: value })
      if (query.length > 0 && query.length <= 200) approved.add(query)
    }
  }
  return approved
}

function delegationDenial(execution, events) {
  const webAttempts = events.filter((event) => (
    event.type === 'tool/call' && event.data?.name === 'web_search'
  )).length
  if (webAttempts < BASE_WEB_SEARCH_CALLS) return undefined
  if (DELEGATION_TOOLS.has(execution.name)) return RESEARCH_DELEGATION_REASON
  if (execution.name !== 'dev_tool_search') return undefined
  const requested = Array.isArray(execution.arguments?.toolNames)
    ? execution.arguments.toolNames
    : []
  return requested.some((toolName) => DELEGATION_TOOLS.has(toolName))
    ? RESEARCH_DELEGATION_REASON
    : undefined
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
  const currentLogged = typeof execution.callId === 'string'
    && calls.some((event) => event.data?.callId === execution.callId)
  const attempts = calls.length + (currentLogged ? 0 : 1)
  if (attempts > MAX_APEX_RESEARCH_CALLS) return RESEARCH_AGENT_BUDGET_REASON

  const brief = normalizedBrief(execution.arguments?.prompt)
  const previous = calls.filter((event) => event.data?.callId !== execution.callId)
  if (brief.length > 0 && previous.some((event) => (
    normalizedBrief(parsedArguments(event).prompt) === brief
  ))) return DUPLICATE_RESEARCH_AGENT_REASON
  if (attempts <= 1) return undefined

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
  if (execution?.agent?.session === undefined) return undefined
  const taskEvents = currentTaskEvents(execution.agent.session.events)
  const delegated = delegationDenial(execution, taskEvents)
  if (delegated !== undefined) return delegated
  if (!RESEARCH_TOOLS.has(execution.name)) return undefined
  const extensionRequest = execution.name === 'dev_tool_search'
    && isExtensionRequest(execution.arguments)
  const events = execution.name === 'web_search' || extensionRequest
    ? taskEvents
    : currentEpochEvents(execution.agent.session.events)
  const allCalls = events
    .filter((event) => event.type === 'tool/call' && event.data?.name === execution.name)
  const calls = execution.name !== 'dev_tool_search'
    ? allCalls
    : allCalls.filter((event) => isExtensionRequest(parsedArguments(event)) === extensionRequest)
  const currentLogged = typeof execution.callId === 'string'
    && calls.some((event) => event.data?.callId === execution.callId)
  const attempts = calls.length + (currentLogged ? 0 : 1)
  const limit = execution.name === 'web_search'
    ? MAX_WEB_SEARCH_CALLS
    : (extensionRequest ? MAX_RESEARCH_EXTENSION_CALLS : MAX_DEV_TOOL_SEARCH_CALLS)
  if (attempts > limit) return RESEARCH_BUDGET_REASON

  const query = normalizedQuery(execution.arguments)
  if (query.length === 0) return undefined
  const duplicate = calls.some((event) => (
    event.data?.callId !== execution.callId
    && normalizedQuery(parsedArguments(event)) === query
  ))
  if (duplicate) return DUPLICATE_RESEARCH_REASON
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
