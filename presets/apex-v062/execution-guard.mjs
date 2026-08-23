/** Enforce workspace/process safety and optional worker ownership. */

import {
  currentTaskEvents,
  delegationPathConflictReason,
  hasHtmlArtifact,
  isManagedFlashChild,
  successfulImplementationMutationPaths,
} from './tool-gate.mjs'
import {
  MAX_APEX_WORKERS,
  parseContinuationArguments,
  parseContinuationMessage,
  parseBuildArguments,
  parseTakeoverArguments,
  workItemForChild,
  workItemOwnsPath,
  workItemsOverlap,
  workspaceRelativePath,
} from './work-items.mjs'
import { pendingWorkerIds } from './worker-wait.mjs'
import { takeoverForChild } from './apex-continue.mjs'
import { workspacePathDenial, workspaceShellDenial } from './workspace-boundary.mjs'

export const name = 'apex-execution-guard'
export const inject = ['tools']

export const DENIAL_REASON = [
  'APEX v0.6.2 blocks broad process termination.',
  'Record the PID of the process started by this task and terminate that exact PID instead.',
].join(' ')

export const CHILD_SHELL_RESTRICTION_REASON = [
  'APEX v0.6.2 keeps Flash workers on editor-only workspace implementation.',
  'Do not use Bash or PowerShell in the Worker; validation, dependency work, remote acquisition, servers, and browser checks belong to the Pro parent.',
  'Use read, glob, or grep for inspection, str_replace_editor for writes, then report the implementation result.',
].join(' ')

export const WORKER_POLLING_REASON = [
  'APEX v0.6.2 blocked shell sleep while an APEX worker is awaiting settlement.',
  'Call apex_wait with the child id returned by apex_build; it waits on the Harness lifecycle without polling or imposing a worker wall-clock deadline.',
].join(' ')

export const WORK_ITEM_REQUIRED_REASON = [
  'APEX v0.6.2 rejected these structured apex_build fields.',
  'Provide one bounded description, id, paths, goal, context, non_goals, and acceptance value; the host compiles the child prompt.',
].join(' ')

export const WORKER_LIMIT_REASON = [
  `APEX v0.6.2 allows at most ${MAX_APEX_WORKERS} distinct Flash workers in one human task.`,
  'Resume an existing worker with send_message or let the Pro parent finish the remaining repair.',
].join(' ')

export const CONTINUATION_REQUIRED_REASON = [
  'APEX v0.6.2 continues only a worker started by this task.',
  'Wait for its report or settlement, inspect the actual workspace, then call apex_continue once with the child id, matching work-item id, new evidence, and one repair instruction.',
].join(' ')

export const SYSTEM_SETTING_REASON = [
  'APEX v0.6.2 blocked a system-wide setting change during project validation.',
  'Do not enable browser automation, alter OS policy, or modify global browser preferences.',
  'Call the resident dev_tool_search tool with the exact query "apex_validate_web"; that exact-name search unlocks the host validator for the next request.',
].join(' ')

export const BROWSER_DOWNLOAD_REASON = [
  'APEX v0.6.2 blocked a browser-binary download during project validation.',
  'Call the resident dev_tool_search tool with the exact query "apex_validate_web"; that exact-name search unlocks the host validator for the next request.',
  'The host validator resolves an existing system Chrome, Chromium, or Edge executable outside the Workspace and never downloads a browser.',
  'If no supported system browser is available, report the environment block instead of installing one into the project.',
].join(' ')

export const WEB_VALIDATION_DISCOVERY_REASON = [
  'APEX v0.6.2 detected a browser-validation fallback after an HTML artifact was written.',
  'Do not search for browser binaries or install or emulate browser dependencies.',
  'The host has already exposed apex_validate_web for this HTML artifact; call it directly.',
].join(' ')

export const CHILD_SCOPE_REASON = [
  'APEX v0.6.2 blocked a Flash edit outside its leased paths.',
  'The Pro parent must create a separate non-overlapping work item or explicitly take over a settled lease.',
].join(' ')

export const TAKEOVER_REQUIRED_REASON = [
  'APEX v0.6.2 transfers a lease only after the worker settles and Pro reads a leased file.',
  'Call apex_wait, inspect the concrete implementation, then call apex_takeover with the matching child id, work-item id, reason, and evidence.',
].join(' ')

export const PARENT_SCOPE_REASON = [
  'APEX v0.6.2 blocked a Pro edit inside a worker-owned lease.',
  'Other workspace paths remain editable. After this worker settles, inspect its files and use apex_takeover before modifying its lease.',
].join(' ')

const EDITOR_COMMAND_FIELDS = new Map([
  ['view', 'command and path; optionally view_range=[start,-1]'],
  ['create', 'command, path, and file_text'],
  ['str_replace', 'command, path, old_str, and new_str'],
  ['insert', 'command, path, insert_line, and new_str'],
])

const OPTIONAL_EDITOR_FIELDS = new Set([
  'file_text',
  'insert_line',
  'new_str',
  'old_str',
  'view_range',
])

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const MAX_PARALLEL_WORKER_STARTS = 2

const BROAD_TERMINATION = [
  /(?:^|[\n;&|()])\s*(?:sudo(?:\s+-\S+)*\s+)?(?:[^\s;&|]+\/)?(?:pkill|killall)(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*(?:[^\s;&|]+[\\/])?taskkill(?:\.exe)?\b[^\r\n;&|]*\/im(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*stop-process\b[^\r\n;|]*-(?:name|inputobject)(?:\s|$)/i,
]

const BARE_WORKER_SLEEP = /^(?:\s*(?:command\s+)?sleep\s+\d+(?:\.\d+)?(?:ms|s|m|h)?\s*|\s*start-sleep(?:\s+-(?:seconds|milliseconds))?\s+\d+(?:\.\d+)?\s*)$/i
const SYSTEM_SETTING_COMMAND = /(?:\bsafaridriver\b[^\r\n;&|]*\s--enable\b|\bset-executionpolicy\b|\benable-windowsoptionalfeature\b|\breg(?:\.exe)?\s+add\b|\bdefaults\s+write\s+(?:com\.apple\.safari|com\.google\.chrome|com\.microsoft\.edge)\b)/i
const BROWSER_DOWNLOAD_COMMAND = /(?:\b(?:npx|bunx)\b|\b(?:npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,80}\b(?:exec|dlx)\b|\bpython(?:3(?:\.\d+)?)?\b[^\r\n;&|]{0,80}\s-m\s+)?[^\r\n;&|]{0,120}(?:(?:\bplaywright|@playwright\/test)(?:@[^\s;&|]+)?\s+install(?:-deps)?|\bpuppeteer(?:@[^\s;&|]+)?\s+browsers\s+install)\b/i
const WEB_VALIDATION_FALLBACK_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b[^\r\n;&|]{0,160}(?:playwright|puppeteer|jsdom|selenium-webdriver|@napi-rs\/canvas|(?:^|\s)canvas(?:\s|$))/i,
  /\b(?:(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?pip(?:3)?)\s+install\b[^\r\n;&|]{0,160}\b(?:playwright|selenium)\b/i,
  /\b(?:require(?:\.resolve)?|import)\s*\(\s*['"](?:playwright|puppeteer|jsdom|selenium-webdriver|@napi-rs\/canvas|canvas)['"]\s*\)/i,
  /\bfind_spec\s*\(\s*['"](?:playwright|selenium)['"]\s*\)/i,
  /\b(?:which|where(?:\.exe)?|get-command)\b[^\r\n;&|]{0,120}\b(?:chrome|chromium|firefox|msedge|safari)\b/i,
  /\bcommand\s+-v\b[^\r\n;&|]{0,120}\b(?:chrome|chromium|firefox|msedge|safari)\b/i,
  /\/Applications\b[^\r\n]{0,160}\b(?:chrome|chromium|firefox|edge|safari)\b/i,
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

/** Deny project-local browser payload downloads; the host reuses a system browser. */
export function isBrowserDownloadCommand(command) {
  return typeof command === 'string' && BROWSER_DOWNLOAD_COMMAND.test(command)
}

/** Redirect proven Web-validation setup churn to the now-visible host validator. */
export function webValidationDiscoveryDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || (execution?.agent?.session?.header?.delegationDepth ?? 0) > 0
    || typeof execution.arguments?.command !== 'string'
    || !hasHtmlArtifact(execution.agent)) return undefined
  return isBrowserDownloadCommand(execution.arguments.command)
    || WEB_VALIDATION_FALLBACK_COMMANDS.some(pattern => pattern.test(execution.arguments.command))
    ? WEB_VALIDATION_DISCOVERY_REASON
    : undefined
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

function toolResultBlock(events, callId) {
  for (const event of events) {
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    const block = event.data.message.content.find(item => (
      item?.type === 'tool-result' && item.toolCallId === callId
    ))
    if (block !== undefined) return block
  }
  return undefined
}

function toolResultText(block) {
  return Array.isArray(block?.content)
    ? block.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('')
    : ''
}

function priorToolCalls(events, execution, name) {
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  return events
    .slice(0, currentIndex === -1 ? events.length : currentIndex)
    .filter(event => event.type === 'tool/call' && event.data?.name === name)
}

/** Keep managed Flash workers off the shell after the Minimal-shaped first request. */
export function childShellDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name) || !isManagedFlashChild(execution.agent)) return undefined
  return CHILD_SHELL_RESTRICTION_REASON
}

/** Replace bare sleep polling with the lifecycle-backed apex_wait tool. */
export function workerPollingDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || typeof execution.arguments?.command !== 'string'
    || !BARE_WORKER_SLEEP.test(execution.arguments.command)
    || execution?.agent?.session === undefined) return undefined
  return pendingWorkerIds(execution.agent).length > 0 ? WORKER_POLLING_REASON : undefined
}

function buildRecords(events, execution) {
  const records = []
  for (const call of priorToolCalls(events, execution, 'apex_build')) {
    const result = toolResultBlock(events, call.data?.callId)
    if (result?.isError === true) continue
    const args = parsedArguments(call)
    const parsed = parseBuildArguments(args)
    if (!parsed.ok) continue
    const childMatch = toolResultText(result).match(/^started subagent (\S+)$/m)
    records.push({
      call,
      workItem: parsed.value,
      childId: childMatch?.[1],
    })
  }
  return records
}

function currentCallEvent(events, execution) {
  return events.find(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
}

/** Reject malformed, overlapping, synchronous, or excessive fresh worker starts. */
export function buildDenial(execution) {
  if (execution?.name !== 'apex_build' || execution?.agent?.session === undefined) return undefined
  const parsed = parseBuildArguments(execution.arguments)
  if (!parsed.ok) return `${WORK_ITEM_REQUIRED_REASON}\nReason: ${parsed.error}`
  const conflict = delegationPathConflictReason(execution.agent, parsed.value.paths)
  if (conflict !== undefined) return conflict

  const events = currentTaskEvents(execution.agent.session.events)
  const records = buildRecords(events, execution)
  if (records.length >= MAX_APEX_WORKERS) return WORKER_LIMIT_REASON
  const current = currentCallEvent(events, execution)
  if (current !== undefined) {
    const sameStep = records.filter(record => (
      record.call.data?.turn === current.data?.turn && record.call.data?.step === current.data?.step
    ))
    if (sameStep.length >= MAX_PARALLEL_WORKER_STARTS) {
      return 'APEX v0.6.2 starts at most two new Flash workers in one model step; wait for evidence before expanding the cluster.'
    }
  }

  const duplicate = records.find(record => record.workItem.id === parsed.value.id)
  if (duplicate !== undefined) {
    return `APEX v0.6.2 work item "${parsed.value.id}" already exists. Resume its existing worker instead of starting a replacement.`
  }
  const overlap = records.find(record => workItemsOverlap(record.workItem, parsed.value))
  if (overlap !== undefined) {
    return `APEX v0.6.2 blocked overlapping write leases between "${overlap.workItem.id}" and "${parsed.value.id}". Resume the existing worker or choose disjoint paths.`
  }
  return undefined
}

function childFeedbackIndex(events, childId) {
  return events.findLastIndex(event => (
    event.type === 'user/message'
    && (event.data?.source?.kind === 'subagent-report' || event.data?.source?.kind === 'subagent-settled')
    && event.data.source.senderSessionId === childId
  ))
}

function inspectedPath(event) {
  if (event.type !== 'tool/call') return undefined
  const args = parsedArguments(event)
  if (event.data?.name === 'str_replace_editor' && args.command === 'view') return args.path
  if (event.data?.name === 'read') return args.file_path
  if (event.data?.name === 'glob' || event.data?.name === 'grep') return args.path
  return undefined
}

function hasSuccessfulScopeInspection(events, afterIndex, beforeIndex, agent, workItem) {
  for (const event of events.slice(afterIndex + 1, beforeIndex)) {
    const path = workspaceRelativePath(agent, inspectedPath(event))
    if (path === undefined || !workItemOwnsPath(workItem, path)) continue
    const result = toolResultBlock(events, event.data?.callId)
    if (result !== undefined && result.isError !== true) return true
  }
  return false
}

function continuationInput(execution) {
  if (execution?.name === 'apex_continue') {
    const parsed = parseContinuationArguments(execution.arguments)
    return parsed.ok
      ? { ok: true, childId: parsed.value.childId, value: parsed.value }
      : parsed
  }
  if (execution?.name !== 'send_message') return undefined
  const parsed = parseContinuationMessage(execution.arguments?.message)
  return parsed.ok
    ? {
        ok: true,
        childId: execution.arguments?.subagent_id,
        value: { ...parsed.value, instruction: parsed.body },
      }
    : parsed
}

function priorContinuationCalls(events, execution) {
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  return events
    .slice(0, currentIndex === -1 ? events.length : currentIndex)
    .filter(event => event.type === 'tool/call'
      && (event.data?.name === 'send_message' || event.data?.name === 'apex_continue'))
}

function parsedContinuationCall(call) {
  const args = parsedArguments(call)
  if (call.data?.name === 'apex_continue') {
    const parsed = parseContinuationArguments(args)
    return parsed.ok ? parsed.value : undefined
  }
  const parsed = parseContinuationMessage(args.message)
  return parsed.ok
    ? { childId: args.subagent_id, ...parsed.value, instruction: parsed.body }
    : undefined
}

/** Require feedback, actual inspection, and new evidence before resuming one known worker. */
export function continuationDenial(execution) {
  const input = continuationInput(execution)
  if (input === undefined || execution?.agent?.session === undefined) return undefined
  if (!input.ok) return `${CONTINUATION_REQUIRED_REASON} ${input.error}`
  const events = currentTaskEvents(execution.agent.session.events)
  const records = buildRecords(events, execution)
  const record = records.find(item => item.childId === input.childId)
  if (record === undefined) return CONTINUATION_REQUIRED_REASON
  if (takeoverForChild(events, record.childId) !== undefined) {
    return `APEX v0.6.2 worker ${record.childId} was transferred to the Pro parent and cannot be continued.`
  }

  if (input.value.workItemId !== record.workItem.id) {
    return `${CONTINUATION_REQUIRED_REASON} work_item_id does not match the target worker.`
  }

  const feedbackIndex = childFeedbackIndex(events, record.childId)
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  const beforeIndex = currentIndex === -1 ? events.length : currentIndex
  if (feedbackIndex === -1
    || !hasSuccessfulScopeInspection(events, feedbackIndex, beforeIndex, execution.agent, record.workItem)) {
    return `${CONTINUATION_REQUIRED_REASON} No successful read or str_replace_editor view of this worker's leased paths was recorded after its latest feedback; shell output alone is not review evidence.`
  }

  const usedEvidence = new Set()
  for (const call of priorContinuationCalls(events, execution)) {
    const result = toolResultBlock(events, call.data?.callId)
    if (result?.isError === true) continue
    const earlier = parsedContinuationCall(call)
    if (earlier?.childId !== record.childId) continue
    for (const item of earlier.evidence) {
      usedEvidence.add(item.toLowerCase().replace(/\s+/g, ' '))
    }
  }
  const hasNewEvidence = input.value.evidence.some(item => (
    !usedEvidence.has(item.toLowerCase().replace(/\s+/g, ' '))
  ))
  return hasNewEvidence
    ? undefined
    : 'APEX v0.6.2 blocked a repeated worker continuation with no new inspection evidence.'
}

/** Require a settled known worker, no concurrent writer, and fresh Pro inspection before transfer. */
export function takeoverDenial(execution) {
  if (execution?.name !== 'apex_takeover' || execution?.agent?.session === undefined) return undefined
  const parsed = parseTakeoverArguments(execution.arguments)
  if (!parsed.ok) return `${TAKEOVER_REQUIRED_REASON} ${parsed.error}`
  const events = currentTaskEvents(execution.agent.session.events)
  const records = buildRecords(events, execution)
  const record = records.find(item => item.childId === parsed.value.childId)
  if (record === undefined || record.workItem.id !== parsed.value.workItemId) {
    return `${TAKEOVER_REQUIRED_REASON} The child id or work-item id does not match a worker from this task.`
  }
  if (takeoverForChild(events, record.childId) !== undefined) {
    return `APEX v0.6.2 worker ${record.childId} was already transferred to the Pro parent.`
  }
  if (pendingWorkerIds(execution.agent).length > 0) {
    return `${TAKEOVER_REQUIRED_REASON} Every current APEX worker must settle before parent writes are exposed.`
  }
  const feedbackIndex = childFeedbackIndex(events, record.childId)
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  const beforeIndex = currentIndex === -1 ? events.length : currentIndex
  if (feedbackIndex === -1
    || !hasSuccessfulScopeInspection(events, feedbackIndex, beforeIndex, execution.agent, record.workItem)) {
    return `${TAKEOVER_REQUIRED_REASON} No successful read or str_replace_editor view of this worker's leased paths was recorded after its latest feedback.`
  }
  return undefined
}

/** Block Pro only on worker leases that have not been explicitly transferred. */
export function parentTakeoverScopeDenial(execution) {
  if (execution?.name !== 'str_replace_editor'
    || execution?.arguments?.command === 'view'
    || execution?.agent?.session === undefined
    || (execution.agent.session.header?.delegationDepth ?? 0) > 0) return undefined
  const events = currentTaskEvents(execution.agent.session.events)
  const path = workspaceRelativePath(execution.agent, execution.arguments?.path)
  if (path === undefined) return undefined
  const owner = buildRecords(events, execution)
    .find(record => workItemOwnsPath(record.workItem, path))
  if (owner === undefined || takeoverForChild(events, owner.childId) !== undefined) return undefined
  return PARENT_SCOPE_REASON
}

/** Keep every mutating Flash editor call inside the work item's leased paths. */
export function childScopeDenial(execution) {
  if (execution?.name !== 'str_replace_editor' || execution?.agent?.session === undefined) return undefined
  if ((execution.agent.session.header?.delegationDepth ?? 0) <= 0) return undefined
  if (execution.arguments?.command === 'view') return undefined
  const workItem = workItemForChild(execution.agent)
  const path = workspaceRelativePath(execution.agent, execution.arguments?.path)
  if (workItem === undefined || path === undefined || !workItemOwnsPath(workItem, path)) {
    return CHILD_SCOPE_REASON
  }
  return undefined
}

/** Monotonic tool guard: it can deny an unsafe call but never force an allow. */
export function guardExecution(execution) {
  const childShellReason = childShellDenial(execution)
  if (childShellReason !== undefined) return childShellReason
  if (SHELL_TOOLS.has(execution?.name)) {
    const command = execution?.arguments?.command
    if (isBroadProcessTermination(command)) return DENIAL_REASON
    const validationDiscoveryReason = webValidationDiscoveryDenial(execution)
    if (validationDiscoveryReason !== undefined) return validationDiscoveryReason
    if (isBrowserDownloadCommand(command)) return BROWSER_DOWNLOAD_REASON
    if (typeof command === 'string' && SYSTEM_SETTING_COMMAND.test(command)) {
      return SYSTEM_SETTING_REASON
    }
  }
  return workspaceShellDenial(execution)
    ?? workspacePathDenial(execution)
    ?? workerPollingDenial(execution)
    ?? childScopeDenial(execution)
    ?? buildDenial(execution)
    ?? continuationDenial(execution)
    ?? takeoverDenial(execution)
    ?? parentTakeoverScopeDenial(execution)
}

function errorMessage(result) {
  const message = result?.error?.message
  if (typeof message === 'string' && message.length > 0) return message.slice(0, 600)
  return Array.isArray(result?.content)
    ? result.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('')
      .slice(0, 600)
    : ''
}

/** Return one concise retry shape for recurrent editor protocol errors. */
export function editorErrorRecovery(execution, result) {
  if (execution?.name !== 'str_replace_editor' || result?.isError !== true) return undefined
  const code = result.error?.info?.code
  const message = errorMessage(result)
  if (code === 'INVALID_ARGS') {
    const args = execution.arguments
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return 'Editor arguments must be one JSON object. Retry once with quoted string values and omit unused fields instead of sending null placeholders.'
    }
    const fields = EDITOR_COMMAND_FIELDS.get(args.command)
      ?? 'command, path, and only the fields required by that command'
    return `Editor arguments were rejected. Retry once with only ${fields}; omit every unused or null field.`
  }
  if (code === 'FS_NOT_OBSERVED' || code === 'FS_STALE_VERSION') {
    return `Editor error: ${message}\nRecovery: view the same path once with str_replace_editor, then retry the edit against the observed text.`
  }
  if (/Invalid `view_range`.*second element/is.test(message)) {
    return `Editor error: ${message}\nRecovery: retry the view with [start,-1] to read through EOF.`
  }
  if (/already exists/i.test(message) && execution.arguments?.command === 'create') {
    return `Editor error: ${message}\nRecovery: view the existing path, then use str_replace instead of create.`
  }
  return undefined
}

/** Preserve downstream decisions while replacing only recognized editor error text. */
export async function recoverEditorError(execution, result, next) {
  const decision = await next()
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || decision.content !== undefined) {
    return decision
  }
  const recovery = editorErrorRecovery(execution, result)
  return recovery === undefined
    ? decision
    : {
        kind: 'accept',
        content: [{ type: 'text', text: recovery }],
        ...(decision.additionalContexts === undefined
          ? {}
          : { additionalContexts: decision.additionalContexts }),
      }
}

/** Remove only schema-optional editor null placeholders before typed validation. */
export function normalizeEditorNullArguments(argumentsValue) {
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return argumentsValue
  }
  const nullFields = Object.keys(argumentsValue)
    .filter(field => OPTIONAL_EDITOR_FIELDS.has(field) && argumentsValue[field] === null)
  if (nullFields.length === 0) return argumentsValue
  const normalized = { ...argumentsValue }
  for (const field of nullFields) delete normalized[field]
  return Object.freeze(normalized)
}

/** Normalize known editor placeholders at the last hook before its schema validator. */
export async function normalizeEditorCall(execution, next) {
  if (execution?.name === 'str_replace_editor') {
    execution.arguments = normalizeEditorNullArguments(execution.arguments)
  }
  return next()
}

export function apply(ctx) {
  ctx.tools.guard(guardExecution)
  ctx.on('tools/execute', normalizeEditorCall)
  ctx.on('tools/post-execute', recoverEditorError)
}
