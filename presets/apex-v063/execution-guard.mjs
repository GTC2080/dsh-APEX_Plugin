/** Enforce workspace/process safety and optional worker ownership. */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import {
  currentTaskEvents,
  delegationPathConflictReason,
  hasHtmlArtifact,
  isManagedFlashProductionChild,
  isManagedProCoreChild,
  isManagedPtcCodeChild,
  isManagedResearchChild,
  RESEARCH_DEFERRED_SEARCH_PREFIX,
  RESEARCH_SOURCE_TOOL,
  researchChildEvidenceState,
  successfulImplementationMutationPaths,
} from './tool-gate.mjs'
import {
  MAX_APEX_WORKERS,
  parseContinuationArguments,
  parseContinuationMessage,
  parseBuildArguments,
  parsePersistedBuildArguments,
  parseTakeoverArguments,
  workItemForChild,
  workItemOwnsPath,
  workItemsOverlap,
  workspaceRelativePath,
} from './work-items.mjs'
import { pendingWorkerIds } from './worker-wait.mjs'
import { takeoverForChild } from './apex-continue.mjs'
import {
  computeShellFamily,
  IMPLEMENTATION_MUTATION_MARKER,
  preArtifactComputeTransition,
} from './apex-policy.mjs'
import {
  bashCommandForPathScan,
  workspacePath,
  workspacePathDenial,
  workspaceShellDenial,
} from './workspace-boundary.mjs'

export const name = 'apex-execution-guard'
export const inject = ['tools']

export const DENIAL_REASON = [
  'APEX v0.6.3 blocks broad process termination.',
  'Record the PID of the process started by this task and terminate that exact PID instead.',
].join(' ')

export const CHILD_SHELL_RESTRICTION_REASON = [
  'APEX v0.6.3 keeps Flash workers on editor-only workspace implementation.',
  'Do not use Bash or PowerShell in the Worker; validation, dependency work, remote acquisition, servers, and browser checks belong to the Pro parent.',
  'Use read, glob, or grep for inspection, str_replace_editor for writes, then report the implementation result.',
].join(' ')

export const WORKER_POLLING_REASON = [
  'APEX v0.6.3 blocked shell sleep while an APEX worker is awaiting settlement.',
  'Call apex_wait with the child id returned by apex_build; it waits on the Harness lifecycle without polling or imposing a worker wall-clock deadline.',
].join(' ')

export const WORK_ITEM_REQUIRED_REASON = [
  'APEX v0.6.3 rejected these structured apex_build fields.',
  'Provide role, bounded lease paths, immutable inputs, named interfaces, invariants, exclusions, and acceptance assertions; the host compiles the child prompt.',
].join(' ')

export const WORKER_LIMIT_REASON = [
  `APEX v0.6.3 allows at most ${MAX_APEX_WORKERS} distinct implementation workers in one human task.`,
  'Resume an existing worker or let the Pro parent finish the remaining repair.',
].join(' ')

export const CONTINUATION_REQUIRED_REASON = [
  'APEX v0.6.3 continues only a worker started by this task.',
  'Wait for its report or settlement, inspect the actual workspace, then call apex_continue once with the child id, matching work-item id, new evidence, and one repair instruction.',
].join(' ')

export const SYSTEM_SETTING_REASON = [
  'APEX v0.6.3 blocked a system-wide setting change during project validation.',
  'Do not enable browser automation, alter OS policy, or modify global browser preferences.',
  'Call the resident dev_tool_search tool with the exact query "apex_validate_web"; that exact-name search unlocks the host validator for the next request.',
].join(' ')

export const BROWSER_DOWNLOAD_REASON = [
  'APEX v0.6.3 blocked a browser-binary download during project validation.',
  'Call the resident dev_tool_search tool with the exact query "apex_validate_web"; that exact-name search unlocks the host validator for the next request.',
  'The host validator resolves an existing system Chrome, Chromium, or Edge executable outside the Workspace and never downloads a browser.',
  'If no supported system browser is available, report the environment block instead of installing one into the project.',
].join(' ')

export const HOST_EVIDENCE_TRANSFORM_REASON = [
  'APEX v0.6.3 keeps host Web screenshots as immutable browser evidence.',
  'Inspect the original host screenshot directly and name the relevant region in the Vision question; do not use Shell, PIL, Canvas, ImageMagick, ffmpeg, sips, sharp, or other code to crop, resize, redraw, or replace it.',
].join(' ')

export const WEB_VALIDATION_DISCOVERY_REASON = [
  'APEX v0.6.3 detected a browser-validation fallback after an HTML artifact was written.',
  'Do not search for browser binaries or install or emulate browser dependencies.',
  'The host has already exposed apex_validate_web for this HTML artifact; call it directly.',
].join(' ')

export const WEB_VALIDATION_PROBE_REDIRECT_PREFIX = 'APEX_BROWSER_PROBE_REDIRECTED:'

export const PRE_IMPLEMENTATION_COMPUTE_REASON = [
  'APEX v0.6.3 completed the one focused post-checkpoint computation.',
  'Preserve that result and create the first Workspace implementation slice now.',
  'A content-changing Workspace mutation grants one provisional computation-only lease; internal reasoning and Shell that directly writes the implementation remain available.',
].join(' ')

export const PROVISIONAL_IMPLEMENTATION_COMPUTE_REASON = [
  'APEX v0.6.3 consumed the provisional computation lease granted by the latest deliverable mutation.',
  'Preserve that result and continue modifying the Workspace implementation before another computation-only interpreter round.',
  'A later content-changing mutation renews one lease; no-op rewrites do not. Internal reasoning and Shell that directly writes the implementation remain available.',
].join(' ')

export const CHILD_SCOPE_REASON = [
  'APEX v0.6.3 blocked a worker edit outside its leased paths.',
  'The Pro parent must create a separate non-overlapping work item or explicitly take over a settled lease.',
].join(' ')

export const PRO_CORE_SHELL_WRITE_REASON = [
  'APEX v0.6.3 keeps Pro Core shell calls read-only or check-only.',
  'Use str_replace_editor for Workspace writes so lease ownership and changed-path evidence remain exact.',
].join(' ')

export const TAKEOVER_REQUIRED_REASON = [
  'APEX v0.6.3 transfers a lease only after the worker settles and Pro reads a leased file.',
  'Call apex_wait, inspect the concrete implementation, then call apex_takeover with the matching child id, work-item id, reason, and evidence.',
].join(' ')

export const PARENT_SCOPE_REASON = [
  'APEX v0.6.3 blocked a Pro edit inside a worker-owned lease.',
  'Other workspace paths remain editable. After this worker settles, inspect its files and use apex_takeover before modifying its lease.',
].join(' ')

export const RESEARCH_SEARCH_PAUSED_REASON = [
  'APEX research paused external search because at least one newly discovered source still needs direct reading.',
  'Use one currently exposed unread source, or submit partial or conflicted structured evidence.',
].join(' ')

export const RESEARCH_SEARCH_STAGNANT_REASON = [
  'APEX research stopped another external search because two consecutive searches added no new source URL.',
  'Read an exposed unread source, or submit partial or conflicted structured evidence with the remaining gap.',
].join(' ')

export const RESEARCH_SEARCH_FAILURE_REASON = [
  'APEX research stopped another external search because the provider failure is deterministic or one recovery attempt repeated the same endpoint and error.',
  'Do not change credentials or endpoint settings; submit partial or conflicted structured evidence and name the exact remaining configuration or evidence gap for the Pro parent.',
].join(' ')

export const RESEARCH_SOURCE_UNAVAILABLE_REASON = [
  'APEX research has no unread source URL authorized for direct reading.',
  'Use the tools exposed in the current request or submit structured evidence instead of guessing a URL.',
].join(' ')

const EDITOR_COMMAND_FIELDS = new Map([
  ['view', 'command and path; optionally view_range=[start,-1]'],
  ['create', 'command, path, and file_text'],
  ['str_replace', 'command, path, old_str, and new_str'],
  ['insert', 'command, path, insert_line, and new_str'],
])

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const SHELL_EXIT_MARKER = /(?:^|\n)\[exit code:\s*(-?\d+)\]\s*$/iu
const MAX_PARALLEL_WORKER_STARTS = 2
const MAX_EDITOR_RECOVERY_BYTES = 4 * 1024 * 1024
// ponytail: bounded target hashing is enough for normal source artifacts; raise
// these caps only if real large deliverables cannot renew a computation lease.
const MAX_MUTATION_EVIDENCE_BYTES = 16 * 1024 * 1024
const MAX_MUTATION_EVIDENCE_ENTRIES = 256
const implementationMutations = new WeakSet()

const BROAD_TERMINATION = [
  /(?:^|[\n;&|()])\s*(?:sudo(?:\s+-\S+)*\s+)?(?:[^\s;&|]+\/)?(?:pkill|killall)(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*(?:[^\s;&|]+[\\/])?taskkill(?:\.exe)?\b[^\r\n;&|]*\/im(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*stop-process\b[^\r\n;|]*-(?:name|inputobject)(?:\s|$)/i,
]

const BARE_WORKER_SLEEP = /^(?:\s*(?:command\s+)?sleep\s+\d+(?:\.\d+)?(?:ms|s|m|h)?\s*|\s*start-sleep(?:\s+-(?:seconds|milliseconds))?\s+\d+(?:\.\d+)?\s*)$/i
const SYSTEM_SETTING_COMMAND = /(?:\bsafaridriver\b[^\r\n;&|]*\s--enable\b|\bset-executionpolicy\b|\benable-windowsoptionalfeature\b|\breg(?:\.exe)?\s+add\b|\bdefaults\s+write\s+(?:com\.apple\.safari|com\.google\.chrome|com\.microsoft\.edge)\b)/i
const BROWSER_DOWNLOAD_COMMAND = /(?:\b(?:npx|bunx)\b|\b(?:npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,80}\b(?:exec|dlx)\b|\bpython(?:3(?:\.\d+)?)?\b[^\r\n;&|]{0,80}\s-m\s+)?[^\r\n;&|]{0,120}(?:(?:\bplaywright|@playwright\/test)(?:@[^\s;&|]+)?\s+install(?:-deps)?|\bpuppeteer(?:@[^\s;&|]+)?\s+browsers\s+install)\b/i
const WEB_VALIDATION_INSTALL_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b[^\r\n;&|]{0,160}(?:playwright|puppeteer|jsdom|selenium-webdriver|@napi-rs\/canvas|(?:^|\s)canvas(?:\s|$))/i,
  /\b(?:(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?pip(?:3)?)\s+install\b[^\r\n;&|]{0,160}\b(?:playwright|selenium)\b/i,
]
const WEB_VALIDATION_PROBE_COMMANDS = [
  /\b(?:require(?:\.resolve)?|import)\s*\(\s*['"](?:playwright|puppeteer|jsdom|selenium-webdriver|@napi-rs\/canvas|canvas)['"]\s*\)/i,
  /\bfind_spec\s*\(\s*['"](?:playwright|selenium)['"]\s*\)/i,
  /\b(?:which|where(?:\.exe)?|get-command)\b[^\r\n;&|]{0,120}\b(?:chrome|chromium|firefox|msedge|safari)\b/i,
  /\bcommand\s+-v\b[^\r\n;&|]{0,120}\b(?:chrome|chromium|firefox|msedge|safari)\b/i,
  /\/Applications\b[^\r\n]{0,160}\b(?:chrome|chromium|firefox|edge|safari)\b/i,
]
const HOST_EVIDENCE_PATH = /(?:^|[\s'"`=:(])\.apex-evidence[\\/][^\s'"`;&|)]+/i
const IMAGE_TRANSFORM_COMMAND = /(?:\bfrom\s+PIL\b|\bimport\s+PIL\b|\bImage\s*\.\s*open\b|\.\s*(?:crop|resize|thumbnail)\s*\(|\b(?:magick|convert|ffmpeg|sips|sharp)\b|\bcreateCanvas\b|\bdrawImage\s*\()/i
const LITERAL_PATH = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|<>(){},]+)`
const WORKSPACE_WRITE_PATTERNS = [
  new RegExp(String.raw`\btee(?:\s+-[a-z]+)*\s+(?<target>${LITERAL_PATH})`, 'giu'),
  new RegExp(String.raw`\b(?:touch|truncate|mkdir)(?:\s+-[^\s]+)*\s+(?<target>${LITERAL_PATH})`, 'giu'),
  new RegExp(String.raw`\bPath\(\s*(?<target>${LITERAL_PATH})\s*\)\s*\.\s*write_(?:text|bytes)\s*\(`, 'giu'),
  new RegExp(String.raw`\bopen\(\s*(?<target>${LITERAL_PATH})\s*,\s*['"][wax+]`, 'giu'),
  new RegExp(String.raw`\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync)\(\s*(?<target>${LITERAL_PATH})`, 'giu'),
  new RegExp(String.raw`\b(?:Set-Content|Add-Content|New-Item|Out-File)\b[^\r\n;|]*?-(?:Path|LiteralPath|FilePath)\s+(?<target>${LITERAL_PATH})`, 'giu'),
  new RegExp(String.raw`\b(?:Copy-Item|Move-Item)\b[^\r\n;|]*?-Destination\s+(?<target>${LITERAL_PATH})`, 'giu'),
]
const COPY_OR_MOVE_COMMAND = /\b(?:cp|mv|install)\b(?<arguments>[^\r\n;&|]*)/giu
const SHELL_LITERAL_TOKEN = /"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+/gu

function isBrowserProbeExecution(execution) {
  const command = execution?.arguments?.command
  return SHELL_TOOLS.has(execution?.name)
    && (execution?.agent?.session?.header?.delegationDepth ?? 0) === 0
    && typeof command === 'string'
    && hasHtmlArtifact(execution.agent)
    && WEB_VALIDATION_PROBE_COMMANDS.some(pattern => pattern.test(command))
}

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

/** Deny only image transformations that consume a recorded host screenshot. */
export function isHostEvidenceImageTransformCommand(command, agent) {
  if (typeof command !== 'string' || !IMAGE_TRANSFORM_COMMAND.test(command)) return false
  if (HOST_EVIDENCE_PATH.test(command)) return true
  const normalizedCommand = command.replaceAll('\\', '/')
  const paths = (agent?.session?.events ?? [])
    .filter(event => (
      event.type === 'tool/result'
      && typeof event.data?.meta?.screenshotPath === 'string'
      && event.data.meta.screenshotPath.length > 0
    ))
    .map(event => event.data.meta.screenshotPath)
  return paths.some(path => normalizedCommand.includes(path.replaceAll('\\', '/')))
}

/** Redirect proven Web-validation setup churn to the now-visible host validator. */
export function webValidationDiscoveryDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || (execution?.agent?.session?.header?.delegationDepth ?? 0) > 0
    || typeof execution.arguments?.command !== 'string'
    || !hasHtmlArtifact(execution.agent)) return undefined
  return isBrowserDownloadCommand(execution.arguments.command)
    || WEB_VALIDATION_INSTALL_COMMANDS.some(pattern => pattern.test(execution.arguments.command))
    ? WEB_VALIDATION_DISCOVERY_REASON
    : undefined
}

function literalWorkspacePath(agent, raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  const value = ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed
  if (value.length === 0 || /[$`*?{}]/u.test(value)) return undefined
  return workspacePath(agent, value)
}

function shellRedirectionTargets(command) {
  const targets = []
  let quote
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote !== undefined) {
      if (char === '\\' && quote !== "'") escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char !== '>') continue

    let cursor = command[index + 1] === '>' ? index + 2 : index + 1
    while (/\s/u.test(command[cursor] ?? '')) cursor += 1
    if (command[cursor] === '&') continue
    const targetQuote = ['"', "'"].includes(command[cursor]) ? command[cursor] : undefined
    if (targetQuote !== undefined) {
      const start = ++cursor
      while (cursor < command.length && command[cursor] !== targetQuote) cursor += 1
      if (cursor < command.length) targets.push(command.slice(start, cursor))
      index = cursor
      continue
    }
    const start = cursor
    while (cursor < command.length && !/[\s;&|<>]/u.test(command[cursor])) cursor += 1
    if (cursor > start) targets.push(command.slice(start, cursor))
    index = cursor - 1
  }
  return targets
}

/** Return explicit, literal mutation targets beneath the selected Workspace. */
export function workspaceMutationPaths(execution) {
  if (['write', 'edit', 'str_replace_editor'].includes(execution?.name)) {
    if (execution.name === 'str_replace_editor' && execution.arguments?.command === 'view') return []
    const path = workspacePath(
      execution.agent,
      execution.arguments?.path ?? execution.arguments?.file_path,
    )
    return path === undefined ? [] : [path]
  }
  if (!SHELL_TOOLS.has(execution?.name)
    || typeof execution.arguments?.command !== 'string') return []
  const inspected = execution.name === 'bash'
    ? bashCommandForPathScan(execution.arguments.command)
    : { ok: true, command: execution.arguments.command }
  if (!inspected.ok) return []

  const paths = new Set()

  for (const target of shellRedirectionTargets(inspected.command)) {
    const path = literalWorkspacePath(execution.agent, target)
    if (path !== undefined) paths.add(path)
  }

  for (const pattern of WORKSPACE_WRITE_PATTERNS) {
    for (const match of inspected.command.matchAll(pattern)) {
      const path = literalWorkspacePath(execution.agent, match.groups?.target)
      if (path !== undefined) paths.add(path)
    }
  }
  for (const match of inspected.command.matchAll(COPY_OR_MOVE_COMMAND)) {
    const tokens = match.groups?.arguments?.match(SHELL_LITERAL_TOKEN) ?? []
    const target = tokens.findLast(token => !token.startsWith('-'))
    const path = literalWorkspacePath(execution.agent, target)
    if (path !== undefined) paths.add(path)
  }
  return [...paths]
}

/** Recognize only explicit, literal writes into the selected Workspace. */
export function workspaceMutationIntent(execution) {
  return workspaceMutationPaths(execution).length > 0
}

async function hashMutationPath(path, hash, state, label) {
  if (state.entries >= MAX_MUTATION_EVIDENCE_ENTRIES) return false
  state.entries += 1
  let info
  try {
    info = await fs.lstat(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
    hash.update(`missing\0${label}\0`)
    return true
  }
  if (info.isSymbolicLink()) {
    hash.update(`link\0${label}\0${await fs.readlink(path)}\0`)
    return true
  }
  if (info.isDirectory()) {
    hash.update(`directory\0${label}\0`)
    const entries = await fs.readdir(path)
    entries.sort()
    for (const entry of entries) {
      if (!await hashMutationPath(join(path, entry), hash, state, `${label}/${entry}`)) return false
    }
    return true
  }
  if (!info.isFile() || state.bytes + info.size > MAX_MUTATION_EVIDENCE_BYTES) return false
  state.bytes += info.size
  hash.update(`file\0${label}\0${info.size}\0`)
  hash.update(await fs.readFile(path))
  return true
}

async function mutationDigest(paths) {
  if (paths.length === 0) return undefined
  const hash = createHash('sha256')
  const state = { bytes: 0, entries: 0 }
  try {
    for (const [index, path] of [...new Set(paths)].sort().entries()) {
      if (!await hashMutationPath(path, hash, state, String(index))) return undefined
    }
  } catch {
    return undefined
  }
  return hash.digest('hex')
}

/** Record only successful mutations whose target bytes actually changed. */
export async function recordImplementationMutation(execution, next) {
  if ((execution?.agent?.session?.header?.delegationDepth ?? 0) > 0
    || typeof execution?.callId !== 'string') return next()
  const paths = workspaceMutationPaths(execution)
  if (paths.length === 0) return next()
  const before = await mutationDigest(paths)
  const result = await next()
  if (result?.isError !== false || before === undefined) return result
  const after = await mutationDigest(paths)
  if (after === undefined || after === before) return result
  implementationMutations.add(execution)
  return result
}

/** Persist changed-byte evidence inside the owning, Harness-known tool/result. */
export async function stampImplementationMutation(execution, result, next) {
  const decision = await next()
  if (!implementationMutations.delete(execution)
    || result?.isError !== false
    || decision.kind !== 'accept'
    || Object.hasOwn(decision, 'value')) return decision
  const content = decision.content ?? result.content
  if (!Array.isArray(content)) return decision
  return {
    kind: 'accept',
    content: [
      ...content,
      { type: 'text', text: IMPLEMENTATION_MUTATION_MARKER },
    ],
    ...(decision.additionalContexts === undefined
      ? {}
      : { additionalContexts: decision.additionalContexts }),
  }
}

/** Require a first implementation slice after the durable compute transition. */
export function preImplementationComputeDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || (execution?.agent?.session?.header?.delegationDepth ?? 0) > 0
    || typeof execution.arguments?.command !== 'string'
    || computeShellFamily(execution.arguments.command) === undefined
    || workspaceMutationIntent(execution)) return undefined
  const transition = preArtifactComputeTransition(execution.agent)
  if (!transition.implementationRequired) return undefined
  return transition.implementationMutations === 0
    ? PRE_IMPLEMENTATION_COMPUTE_REASON
    : PROVISIONAL_IMPLEMENTATION_COMPUTE_REASON
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

/** Keep the bounded Flash Production role off shell. */
export function childShellDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || !isManagedFlashProductionChild(execution.agent)) return undefined
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
    const parsed = parsePersistedBuildArguments(args)
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
      return 'APEX v0.6.3 starts at most two new implementation workers in one model step; wait for evidence before expanding the cluster.'
    }
  }

  const duplicate = records.find(record => record.workItem.id === parsed.value.id)
  if (duplicate !== undefined) {
    return `APEX v0.6.3 work item "${parsed.value.id}" already exists. Resume its existing worker instead of starting a replacement.`
  }
  const overlap = records.find(record => workItemsOverlap(record.workItem, parsed.value))
  if (overlap !== undefined) {
    return `APEX v0.6.3 blocked overlapping write leases between "${overlap.workItem.id}" and "${parsed.value.id}". Resume the existing worker or choose disjoint paths.`
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
    return `APEX v0.6.3 worker ${record.childId} was transferred to the Pro parent and cannot be continued.`
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
    : 'APEX v0.6.3 blocked a repeated worker continuation with no new inspection evidence.'
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
    return `APEX v0.6.3 worker ${record.childId} was already transferred to the Pro parent.`
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

/** Keep every managed PTC worker mutation inside its immutable write lease. */
export function childScopeDenial(execution) {
  if (execution?.agent?.session === undefined || !isManagedPtcCodeChild(execution.agent)) {
    return undefined
  }
  if (execution.name === 'str_replace_editor' && execution.arguments?.command === 'view') {
    return undefined
  }
  if (SHELL_TOOLS.has(execution.name)) {
    return isManagedProCoreChild(execution.agent) && workspaceMutationIntent(execution)
      ? PRO_CORE_SHELL_WRITE_REASON
      : undefined
  }
  if (execution.name !== 'str_replace_editor') return undefined
  const workItem = workItemForChild(execution.agent)
  const targets = workspaceMutationPaths(execution)
    .map(path => workspaceRelativePath(execution.agent, path))
  if (workItem === undefined
    || targets.length === 0
    || targets.some(path => path === undefined || !workItemOwnsPath(workItem, path))) {
    return CHILD_SCOPE_REASON
  }
  return undefined
}

/** Enforce the research state machine at dispatch, not only in the next tool schema. */
export function researchPhaseDenial(execution) {
  if (!isManagedResearchChild(execution?.agent)) return undefined
  const evidence = researchChildEvidenceState(execution.agent)
  if (execution.name === 'web_search') {
    if (evidence.awaitingSourceRead) return RESEARCH_SEARCH_PAUSED_REASON
    if (evidence.searchFailureBlocked) return RESEARCH_SEARCH_FAILURE_REASON
    if (evidence.consecutiveNoNewSearches >= 2) return RESEARCH_SEARCH_STAGNANT_REASON
  }
  if (execution.name === RESEARCH_SOURCE_TOOL && evidence.unreadSources.length === 0) {
    return RESEARCH_SOURCE_UNAVAILABLE_REASON
  }
  return undefined
}

/**
 * Contain a recalled hidden search without touching the network or charging a
 * failed tool result. The normal web_search renderer presents the unread URLs
 * again, while the durable evidence reducer ignores this synthetic answer.
 */
export async function deferResearchSearchExecution(execution, next) {
  if (execution?.name !== 'web_search' || !isManagedResearchChild(execution?.agent)) {
    return next()
  }
  const reason = researchPhaseDenial(execution)
  if (reason === undefined) return next()
  const evidence = researchChildEvidenceState(execution.agent)
  return {
    isError: false,
    value: {
      content: `${RESEARCH_DEFERRED_SEARCH_PREFIX} No network request was made. ${reason}`,
      sources: evidence.unreadSources.map(source => ({
        url: source.url,
        title: source.title,
      })),
      truncated: false,
    },
    content: [],
  }
}

/** Redirect harmless browser discovery without charging a failed Shell result. */
export async function redirectBrowserProbeExecution(execution, next) {
  if (!isBrowserProbeExecution(execution)) return next()
  const text = [
    WEB_VALIDATION_PROBE_REDIRECT_PREFIX,
    'No Shell command ran, so any non-browser checks bundled into it also did not run.',
    'The host validator resolves the existing system browser itself; call apex_validate_web directly.',
    'Rerun any still-needed non-browser check as a separate bounded command.',
  ].join(' ')
  return {
    isError: false,
    value: text,
    content: [{ type: 'text', text: `${text}\n[exit code: 0]` }],
  }
}

/** Resolve an editor path beneath the declared Workspace without a model retry. */
export async function resolveWorkspaceEditorPathExecution(dispatch, execution, next) {
  if (execution?.name !== 'str_replace_editor'
    || typeof execution.arguments?.path !== 'string') return next()
  const path = workspacePath(execution.agent, execution.arguments.path)
  if (path === undefined || path === execution.arguments.path) return next()
  return dispatch({
    name: execution.name,
    callId: `${execution.callId}:apex-workspace-path`,
    rootCallId: execution.rootCallId,
    parent: execution.token,
    arguments: { ...execution.arguments, path },
    agent: execution.agent,
    signal: execution.signal,
  })
}

/** Monotonic tool guard: it can deny an unsafe call but never force an allow. */
export function guardExecution(execution) {
  const researchReason = researchPhaseDenial(execution)
  if (execution?.name === RESEARCH_SOURCE_TOOL && researchReason !== undefined) return researchReason
  const childShellReason = childShellDenial(execution)
  if (childShellReason !== undefined) return childShellReason
  if (SHELL_TOOLS.has(execution?.name)) {
    const command = execution?.arguments?.command
    if (isHostEvidenceImageTransformCommand(command, execution.agent)) {
      return HOST_EVIDENCE_TRANSFORM_REASON
    }
    if (isBroadProcessTermination(command)) return DENIAL_REASON
    const validationDiscoveryReason = webValidationDiscoveryDenial(execution)
    if (validationDiscoveryReason !== undefined) return validationDiscoveryReason
    if (isBrowserDownloadCommand(command)) return BROWSER_DOWNLOAD_REASON
    if (typeof command === 'string' && SYSTEM_SETTING_COMMAND.test(command)) {
      return SYSTEM_SETTING_REASON
    }
    // This command will be replaced with an explicit non-executing result by
    // redirectBrowserProbeExecution, including absolute browser probe paths.
    if (isBrowserProbeExecution(execution)) return undefined
  }
  return workspaceShellDenial(execution)
    ?? workspacePathDenial(execution)
    ?? preImplementationComputeDenial(execution)
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
      return 'Editor arguments must be one JSON object. Retry once with the command\'s required fields and valid JSON value types.'
    }
    const fields = EDITOR_COMMAND_FIELDS.get(args.command)
      ?? 'command, path, and only the fields required by that command'
    return `Editor arguments were rejected. Retry once with valid types for ${fields}; unused optional null placeholders are allowed.`
  }
  if (code === 'FS_NOT_OBSERVED' || code === 'FS_STALE_VERSION') {
    return `Editor error: ${message}\nRecovery: view the same path with str_replace_editor immediately before retrying; copy the smallest unique old_str from that view. Any intervening mutation makes the view stale.`
  }
  if (/Invalid `view_range`.*second element/is.test(message)) {
    return `Editor error: ${message}\nRecovery: retry the view with [start,-1] to read through EOF.`
  }
  if (/already exists/i.test(message) && execution.arguments?.command === 'create') {
    return `Editor error: ${message}\nRecovery: view the existing path, then use str_replace instead of create.`
  }
  return undefined
}

async function editorMismatchRecovery(execution, result) {
  if (execution?.name !== 'str_replace_editor'
    || execution.arguments?.command !== 'str_replace'
    || result?.isError !== true
    || !/No replacement was performed/i.test(errorMessage(result))) return undefined
  const generic = 'Editor replacement did not match. Retry once with the smallest unique old_str copied exactly from the latest editor view; omit leading indentation unless it is needed for uniqueness, and do not use Shell only to inspect whitespace.'
  const oldString = execution.arguments?.old_str
  if (typeof oldString !== 'string' || oldString.length === 0) return generic
  const oldLines = oldString.split(/\r?\n/)
  const newString = execution.arguments?.new_str
  const newLines = typeof newString === 'string' ? newString.split(/\r?\n/) : []
  const changedLines = oldLines.length === newLines.length
    ? oldLines.flatMap((line, index) => (
        line.trim() === newLines[index].trim() ? [] : [index]
      ))
    : []
  const candidateIndex = oldLines.length === 1
    ? 0
    : changedLines.length === 1
      ? changedLines[0]
      : undefined
  if (candidateIndex === undefined || oldLines[candidateIndex].trim().length === 0) return generic
  const path = workspacePath(execution.agent, execution.arguments?.path)
  if (path === undefined) return generic
  try {
    const info = await fs.stat(path)
    if (!info.isFile() || info.size > MAX_EDITOR_RECOVERY_BYTES) return generic
    const lines = (await fs.readFile(path, 'utf8')).split('\n')
    const matches = lines.filter(line => line.trim() === oldLines[candidateIndex].trim())
    if (matches.length !== 1) return generic
    const exactOld = matches[0]
    const exactNew = newLines[candidateIndex] === undefined
      ? undefined
      : exactOld.match(/^\s*/)[0] + newLines[candidateIndex].trimStart()
    return `${generic} Exact single-line old_str: ${JSON.stringify(exactOld)}`
      + (exactNew === undefined ? '' : ` Corresponding single-line new_str: ${JSON.stringify(exactNew)}`)
  } catch {
    return generic
  }
}

/** Preserve downstream decisions while replacing only recognized editor error text. */
export async function recoverEditorError(execution, result, next) {
  const decision = await next()
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || decision.content !== undefined) {
    return decision
  }
  const recovery = await editorMismatchRecovery(execution, result)
    ?? editorErrorRecovery(execution, result)
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

function resultContentText(result) {
  return Array.isArray(result?.content)
    ? result.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('')
    : ''
}

/** Convert the persistent shell's textual exit marker into canonical failure semantics. */
export async function normalizeShellExit(execution, next) {
  const result = await next()
  if (!SHELL_TOOLS.has(execution?.name) || result?.isError !== false) return result
  const match = resultContentText(result).match(SHELL_EXIT_MARKER)
  const exitCode = match === null ? 0 : Number(match[1])
  if (!Number.isInteger(exitCode) || exitCode === 0) return result
  return {
    isError: true,
    error: {
      message: `Shell command exited with code ${exitCode}.`,
      info: { name: 'ShellExitError', code: 'SHELL_EXIT_NONZERO' },
    },
    content: result.content,
    ...(result.meta === undefined ? {} : { meta: result.meta }),
    ...(result.additionalContexts === undefined
      ? {}
      : { additionalContexts: result.additionalContexts }),
  }
}

export function apply(ctx) {
  ctx.tools.guard(guardExecution)
  ctx.on('tools/execute', deferResearchSearchExecution)
  ctx.on('tools/execute', redirectBrowserProbeExecution)
  ctx.on('tools/execute', recordImplementationMutation)
  ctx.on('tools/execute', (execution, next) => (
    resolveWorkspaceEditorPathExecution(input => ctx.tools.execute(input), execution, next)
  ))
  ctx.on('tools/execute', normalizeShellExit)
  ctx.on('tools/post-execute', recoverEditorError)
  ctx.on('tools/post-execute', stampImplementationMutation)
}
