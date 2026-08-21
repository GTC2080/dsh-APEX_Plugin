/** Deny unsafe shell use, duplicate research, and conflicting APEX worker scopes. */

import {
  currentEpochEvents,
  currentTaskEvents,
  delegationPathConflictReason,
  isManagedFlashChild,
  ROOT_SHELL_HARD_LIMIT,
  shellCallAttemptsSinceEdit,
  UNLOCK_META_KIND,
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

export const BASE_WEB_SEARCH_CALLS = 3
export { ROOT_SHELL_HARD_LIMIT }

export const ROOT_SHELL_BUDGET_REASON = [
  `APEX v0.6.1 paused root shell dispatch after ${ROOT_SHELL_HARD_LIMIT} calls without a successful implementation edit.`,
  'Use the editor for the next concrete implementation change, use a purpose-built unlocked tool, or report the evidence-backed blocker.',
  'A successful implementation edit resets this shell budget; there is no task-wide step or wall-clock limit.',
].join(' ')

export const DENIAL_REASON = [
  'APEX v0.6.1 blocks broad process termination.',
  'Record the PID of the process started by this task and terminate that exact PID instead.',
].join(' ')

export const UNBOUNDED_BROWSER_REASON = [
  'APEX v0.6.1 blocked a direct headless-browser command without an OS-level deadline.',
  'On POSIX, use timeout/gtimeout or a foreground Python subprocess call with a finite timeout.',
  'On PowerShell, use Start-Process -PassThru, WaitForExit(milliseconds), and Stop-Process -Id for that exact process.',
  'Do not create a timeout shim or detach the browser; the shell tool timeout alone is not a child-process lifecycle guarantee.',
].join(' ')

export const UNMANAGED_BACKGROUND_REASON = [
  'APEX v0.6.1 blocked a raw Bash background operator in the persistent shell.',
  'Run bounded work in the foreground. For a server plus browser smoke test, use one foreground Python driver that starts exact child PIDs, applies finite waits, and terminates and waits for those children in finally.',
].join(' ')

export const DUPLICATE_INSTALL_REASON = [
  'APEX v0.6.1 blocked the same dependency-install command from running twice in one human task.',
  'Inspect the previous result and dependency manifest instead of retrying unchanged installation work.',
].join(' ')

export const INSTALL_INSPECTION_REQUIRED_REASON = [
  'APEX v0.6.1 blocked dependency installation before a successful inspection of an existing dependency manifest.',
  'Read the relevant package.json, lockfile, pyproject.toml, or requirements file first and install only when the task actually requires it.',
  'For a new no-build or single-file project, use the requested platform or CDN path instead of creating a package environment for validation.',
].join(' ')

export const CHILD_SHELL_RESTRICTION_REASON = [
  'APEX v0.6.1 keeps Flash workers on editor-only workspace implementation.',
  'Do not use Bash or PowerShell in the Worker; validation, dependency work, remote acquisition, servers, and browser checks belong to the Pro parent.',
  'Use read, glob, or grep for inspection, str_replace_editor for writes, then report the implementation result.',
].join(' ')

export const SHELL_AUTHORING_REASON = [
  'APEX v0.6.1 blocked direct implementation-file authoring through the shell.',
  'Create and modify source, markup, styles, documentation, and project configuration with str_replace_editor.',
  'Keep Bash or PowerShell for inspection, builds, tests, and bounded process control.',
].join(' ')

export const SHELL_HEREDOC_REASON = [
  'APEX v0.6.1 blocked a Bash heredoc because multiline terminators can desynchronize the persistent shell and waste a full tool timeout.',
  'Use an existing project command or a short node -e / python -c foreground check instead.',
].join(' ')

export const DUPLICATE_FETCH_REASON = [
  'APEX v0.6.1 already fetched this exact remote URL successfully in the current human task.',
  'Reuse the previous evidence; when several symbols are needed, inspect them together in one bounded acquisition instead of downloading the same resource again.',
  'Close already confirmed defects before expanding remote-source research.',
].join(' ')

export const WORKER_POLLING_REASON = [
  'APEX v0.6.1 blocked shell sleep while an APEX worker is awaiting settlement.',
  'Call apex_wait with the child id returned by apex_build; it waits on the Harness lifecycle without polling or imposing a worker wall-clock deadline.',
].join(' ')

export const DUPLICATE_RESEARCH_REASON = [
  'APEX v0.6.1 blocked a duplicate research query in the current task.',
  'Reuse the existing result or target a distinct unresolved gap.',
].join(' ')

export const RESEARCH_EXTENSION_REQUIRED_REASON = [
  `APEX v0.6.1 used its ${BASE_WEB_SEARCH_CALLS} initial direct web_search calls for the current task.`,
  'Request a one-query lease from dev_tool_search with researchGap and a distinct nextWebQuery before searching again.',
].join(' ')

export const WORK_ITEM_REQUIRED_REASON = [
  'APEX v0.6.1 rejected these structured apex_build fields.',
  'Provide one bounded description, id, paths, goal, context, non_goals, and acceptance value; the host compiles the child prompt.',
].join(' ')

export const WORKER_LIMIT_REASON = [
  `APEX v0.6.1 allows at most ${MAX_APEX_WORKERS} distinct Flash workers in one human task.`,
  'Resume an existing worker with send_message or let the Pro parent finish the remaining repair.',
].join(' ')

export const CONTINUATION_REQUIRED_REASON = [
  'APEX v0.6.1 continues only a worker started by this task.',
  'Wait for its report or settlement, inspect the actual workspace, then call apex_continue once with the child id, matching work-item id, new evidence, and one repair instruction.',
].join(' ')

export const SYSTEM_SETTING_REASON = [
  'APEX v0.6.1 blocked a system-wide setting change during project validation.',
  'Do not enable browser automation, alter OS policy, or modify global browser preferences.',
  'Use the host-owned apex_validate_web tool, which needs no system setting or browser download.',
].join(' ')

export const BROWSER_DOWNLOAD_REASON = [
  'APEX v0.6.1 blocked a browser-binary download during project validation.',
  'Use the host-owned apex_validate_web tool; it resolves an existing system Chrome, Chromium, or Edge executable outside the Workspace and never downloads a browser.',
  'If no supported system browser is available, report the environment block instead of installing one into the project.',
].join(' ')

export const TIMED_OUT_SHAPE_REASON = [
  'APEX v0.6.1 blocked a command shape that already timed out in this human task.',
  'Inspect the recorded failure and change strategy; do not retry the same executable/operation with cosmetic argument changes.',
  'For static web runtime checks, use apex_validate_web.',
].join(' ')

export const CHILD_SCOPE_REASON = [
  'APEX v0.6.1 blocked a Flash edit outside its leased paths.',
  'The Pro parent must create a separate non-overlapping work item or explicitly take over a settled lease.',
].join(' ')

export const TAKEOVER_REQUIRED_REASON = [
  'APEX v0.6.1 transfers a lease only after the worker settles and Pro reads a leased file.',
  'Call apex_wait, inspect the concrete implementation, then call apex_takeover with the matching child id, work-item id, reason, and evidence.',
].join(' ')

export const PARENT_SCOPE_REASON = [
  'APEX v0.6.1 blocked a Pro edit inside a worker-owned lease.',
  'Other workspace paths remain editable. After this worker settles, inspect its files and use apex_takeover before modifying its lease.',
].join(' ')

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const RESEARCH_TOOLS = new Set(['dev_tool_search', 'web_search'])
const MAX_PARALLEL_WORKER_STARTS = 2

const BROAD_TERMINATION = [
  /(?:^|[\n;&|()])\s*(?:sudo(?:\s+-\S+)*\s+)?(?:[^\s;&|]+\/)?(?:pkill|killall)(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*(?:[^\s;&|]+[\\/])?taskkill(?:\.exe)?\b[^\r\n;&|]*\/im(?:\s|$)/i,
  /(?:^|[\n;&|()])\s*stop-process\b[^\r\n;|]*-(?:name|inputobject)(?:\s|$)/i,
]

const HEADLESS_BROWSER = /(?:google\s+chrome|chromium|(?:^|[\\/\s"'])chrome(?:\.exe)?|firefox(?:\.exe)?)[^\r\n]*(?:--headless(?:=\w+)?|--screenshot(?:=|\s)|--dump-dom\b)/i
const POSIX_TIMEOUT_BROWSER = /(?:^|[;&|]\s*)(?:g?timeout)\s+(?:(?:--?[\w-]+(?:=\S+)?|-\w)\s+)*\d+(?:\.\d+)?(?:ms|s|m|h)?\s+[^;\r\n]*(?:google\s+chrome|chromium|chrome(?:\.exe)?|firefox(?:\.exe)?)/i
const PYTHON_SUBPROCESS_DEADLINE = /\bpython(?:3(?:\.\d+)?)?\b[\s\S]*\bsubprocess\.(?:run|check_call|check_output)\s*\([\s\S]*\btimeout\s*=\s*\d+(?:\.\d+)?/i
const POWERSHELL_PID_DEADLINE = /Start-Process\b[^\r\n]*-PassThru[\s\S]*\.WaitForExit\(\s*\d+\s*\)[\s\S]*Stop-Process\s+-Id\s+\$[\w]+\.Id/i
const DEPENDENCY_INSTALL = /(?:^|\n|;|&&|\|\|)\s*(?:(?:corepack\s+)?(?:npm|pnpm|bun)\b[^\r\n;&|]{0,256}\b(?:install|i|ci|add)\b|yarn(?:\s+(?:install|add)\b|(?=\s*(?:$|[;&|])))|(?:python(?:3(?:\.\d+)?)?\s+-m\s+pip|pip3?|uv\s+pip)\s+install\b)/im
const DEPENDENCY_MANIFEST = /(?:^|[\\/])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|uv\.lock|requirements(?:[.-][^\\/]*)?\.txt)$/i
const DEPENDENCY_MANIFEST_REFERENCE = /(?:^|[\\/\s"'`=;|&()])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|uv\.lock|requirements(?:[.-][^\\/\s"'`;|&()]*)?\.txt)(?=$|[\s"'`;&|)])/im
const MANIFEST_INSPECTION_COMMAND = /\b(?:cat|sed|head|tail|less|more|jq|rg|grep|stat|get-content|select-string|get-item)\b/i
const IMPLEMENTATION_EXTENSION = /\.(?:[cm]?[jt]sx?|html?|css|scss|sass|less|vue|svelte|jsonc?|ya?ml|toml|xml|mdx?|pyi?|rb|php|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|fs|fsx|scala|sh|bash|zsh|fish|ps1|sql|graphql|gql|wgsl|glsl|vert|frag|comp|env|ini|conf|cfg|properties|gradle|cmake)$/i
const IMPLEMENTATION_BASENAME = /^(?:readme|makefile|dockerfile|containerfile|jenkinsfile|procfile)(?:\.[a-z0-9_-]+)?$/i
const BARE_WORKER_SLEEP = /^(?:\s*(?:command\s+)?sleep\s+\d+(?:\.\d+)?(?:ms|s|m|h)?\s*|\s*start-sleep(?:\s+-(?:seconds|milliseconds))?\s+\d+(?:\.\d+)?\s*)$/i
const REMOTE_FETCH_COMMAND = /(?:^|[\s;&|()])(?:curl|wget)(?:\.exe)?(?:\s|$)|\binvoke-(?:webrequest|restmethod)\b|\brequests\.(?:get|post|put|patch|delete|head)\s*\(|\burllib\.request\.urlopen\s*\(/i
const REMOTE_URL = /https?:\/\/[^\s'"<>()[\]{}]+/gi
const SYSTEM_SETTING_COMMAND = /(?:\bsafaridriver\b[^\r\n;&|]*\s--enable\b|\bset-executionpolicy\b|\benable-windowsoptionalfeature\b|\breg(?:\.exe)?\s+add\b|\bdefaults\s+write\s+(?:com\.apple\.safari|com\.google\.chrome|com\.microsoft\.edge)\b)/i
const BROWSER_DOWNLOAD_COMMAND = /(?:\b(?:npx|bunx)\b|\b(?:npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,80}\b(?:exec|dlx)\b|\bpython(?:3(?:\.\d+)?)?\b[^\r\n;&|]{0,80}\s-m\s+)?[^\r\n;&|]{0,120}\b(?:playwright\s+install(?:-deps)?|puppeteer\s+browsers\s+install)\b/i
const TIMEOUT_RESULT = /(?:timed?\s*out|timeout|deadline\s+exceeded|exceeded[^\r\n]{0,40}\bms\b)/i

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

/** Return true only for direct headless-browser runs lacking an independent deadline. */
export function isUnboundedBrowserCommand(command) {
  if (typeof command !== 'string' || !HEADLESS_BROWSER.test(command)) return false
  return !(POSIX_TIMEOUT_BROWSER.test(command)
    || PYTHON_SUBPROCESS_DEADLINE.test(command)
    || POWERSHELL_PID_DEADLINE.test(command))
}

/** Deny project-local browser payload downloads; the host reuses a system browser. */
export function isBrowserDownloadCommand(command) {
  return typeof command === 'string' && BROWSER_DOWNLOAD_COMMAND.test(command)
}

/** Detect a real Bash control `&`, excluding quotes, escapes, `&&`, and redirections. */
export function hasUnmanagedBackgroundOperator(command) {
  if (typeof command !== 'string') return false
  let quote
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== '&') continue
    const previous = command[index - 1]
    const next = command[index + 1]
    if (next === '&') {
      index += 1
      continue
    }
    if (next === '>' || previous === '>' || previous === '<') continue
    return true
  }
  return false
}

/** Detect an unquoted Bash heredoc opener while allowing the bounded <<< here-string. */
export function hasShellHeredoc(command) {
  if (typeof command !== 'string') return false
  let quote
  let escaped = false
  for (let index = 0; index < command.length - 1; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '<' && command[index + 1] === '<') {
      if (command[index + 2] === '<') {
        index += 2
        continue
      }
      return true
    }
  }
  return false
}

/** Return a stable key only for commands that perform dependency installation. */
export function dependencyInstallKey(command) {
  if (typeof command !== 'string' || !DEPENDENCY_INSTALL.test(command)) return undefined
  return command.trim().toLowerCase().replace(/\s+/g, ' ')
}

function cleanPathToken(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^["']|["']$/g, '').replace(/[,:;)]+$/g, '')
    : ''
}

/** Return true only for a literal implementation, documentation, or config path. */
export function isImplementationPath(value) {
  const path = cleanPathToken(value).split(/[?#]/, 1)[0]
  const basename = path.split(/[\\/]/).at(-1) ?? ''
  return IMPLEMENTATION_EXTENSION.test(basename) || IMPLEMENTATION_BASENAME.test(basename)
}

function shellTokens(value) {
  return (value.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [])
    .map(cleanPathToken)
    .filter(Boolean)
}

function redirectedImplementationPath(command) {
  const pattern = />{1,2}\s*(?!&)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|]+))/g
  for (const match of command.matchAll(pattern)) {
    if (isImplementationPath(match[1] ?? match[2] ?? match[3])) return true
  }
  return false
}

function positionalWritePath(command) {
  for (const line of command.split(/\r?\n/)) {
    const tee = line.match(/\btee\b([^\r\n]*)/i)
    if (tee !== null && shellTokens(tee[1]).some(token => !token.startsWith('-') && isImplementationPath(token))) {
      return true
    }

    const direct = line.match(/(?:^|[;&|()]\s*)(touch|truncate|set-content|add-content|out-file|new-item)\b([^\r\n]*)/i)
    if (direct !== null && shellTokens(direct[2]).some(token => !token.startsWith('-') && isImplementationPath(token))) {
      return true
    }

    const copy = line.match(/(?:^|[;&|()]\s*)(?:cp|mv|install|copy-item|move-item)\b([^\r\n]*)/i)
    if (copy !== null) {
      const targets = shellTokens(copy[1]).filter(token => !token.startsWith('-'))
      if (isImplementationPath(targets.at(-1))) return true
    }

    const inPlace = line.match(/(?:^|[;&|()]\s*)(?:sed\b[^\r\n]*\s-i\b|perl\b[^\r\n]*\s-pi\b)([^\r\n]*)/i)
    if (inPlace !== null && shellTokens(line).some(isImplementationPath)) return true
  }
  return false
}

function inlineRuntimeWrite(command) {
  const literalWriters = [
    /(?:pathlib\.)?path\(\s*(["'])([^"']+)\1\s*\)\s*\.\s*write_(?:text|bytes)\b/gi,
    /\bopen\(\s*(["'])([^"']+)\1\s*,\s*(["'])[^"']*[wax+][^"']*\3/gi,
    /\b(?:writefile|appendfile)(?:sync)?\(\s*(["'])([^"']+)\1/gi,
    /\b(?:writealltext|writeallbytes|appendalltext)\(\s*(["'])([^"']+)\1/gi,
  ]
  for (const pattern of literalWriters) {
    for (const match of command.matchAll(pattern)) {
      if (isImplementationPath(match[2])) return true
    }
  }
  return false
}

/** Detect direct shell authorship of literal implementation files on POSIX or Windows. */
export function shellImplementationWrite(command) {
  if (typeof command !== 'string') return false
  return redirectedImplementationPath(command)
    || positionalWritePath(command)
    || inlineRuntimeWrite(command)
}

/** Extract normalized remote URLs only from commands that actually acquire them. */
export function remoteFetchUrls(command) {
  if (typeof command !== 'string' || !REMOTE_FETCH_COMMAND.test(command)) return []
  const urls = []
  for (const match of command.matchAll(REMOTE_URL)) {
    const raw = match[0].replace(/[.,;:]+$/g, '')
    try {
      const url = new URL(raw)
      url.hash = ''
      const hostname = url.hostname.toLowerCase()
      const loopback = hostname === 'localhost'
        || hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname)
      if (!loopback) urls.push(url.href)
    } catch {
      // A malformed literal is left to the actual fetch command.
    }
  }
  return urls
}

/** Return a stable, deliberately coarse shape for timeout-loop prevention. */
export function shellCommandShape(command) {
  if (typeof command !== 'string') return undefined
  const value = command.trim().toLowerCase()
  if (value.length === 0) return undefined
  if (HEADLESS_BROWSER.test(value)) return 'headless-browser'
  if (SYSTEM_SETTING_COMMAND.test(value)) return 'system-setting'
  if (DEPENDENCY_INSTALL.test(value)) {
    const manager = value.match(/\b(npm|pnpm|bun|yarn|pip3?|uv)\b/)?.[1] ?? 'package-manager'
    return `dependency-install:${manager}`
  }
  if (/\bnode(?:\.exe)?\s+(?:--eval|-e)\b/.test(value)) return 'node-inline-check'
  if (/\bpython(?:3(?:\.\d+)?)?(?:\.exe)?\s+(?:-c|-m)\b/.test(value)) return 'python-inline-check'
  const executable = value.match(/^(?:\s*(?:cd\s+[^;&|]+\s*&&\s*)?)([^\s;&|]+)/)?.[1]
  if (executable === undefined) return undefined
  const operation = value.match(/\s(--?[a-z][\w-]*|[a-z][\w.-]*)/i)?.[1] ?? ''
  return `${executable}:${operation}`.slice(0, 160)
}

function dependencyManifestPath(args) {
  const path = args?.path ?? args?.file_path ?? args?.filePath
  return typeof path === 'string' && DEPENDENCY_MANIFEST.test(path) ? path : undefined
}

function inspectsDependencyManifest(event) {
  if (event.type !== 'tool/call') return false
  const args = parsedArguments(event)
  if (event.data?.name === 'str_replace_editor') {
    return args.command === 'view' && dependencyManifestPath(args) !== undefined
  }
  if (event.data?.name === 'read') return dependencyManifestPath(args) !== undefined
  return SHELL_TOOLS.has(event.data?.name)
    && typeof args.command === 'string'
    && !DEPENDENCY_INSTALL.test(args.command)
    && MANIFEST_INSPECTION_COMMAND.test(args.command)
    && DEPENDENCY_MANIFEST_REFERENCE.test(args.command)
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

/** Stop one timeout from becoming a cosmetic retry loop in the persistent shell. */
export function timedOutCommandDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name) || execution?.agent?.session === undefined) return undefined
  const shape = shellCommandShape(execution.arguments?.command)
  if (shape === undefined) return undefined
  const events = currentTaskEvents(execution.agent.session.events)
  for (const call of priorToolCalls(events, execution, execution.name)) {
    if (shellCommandShape(parsedArguments(call).command) !== shape) continue
    const result = toolResultBlock(events, call.data?.callId)
    if (result?.isError === true && TIMEOUT_RESULT.test(toolResultText(result))) {
      return TIMED_OUT_SHAPE_REASON
    }
  }
  return undefined
}

function priorToolCalls(events, execution, name) {
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  return events
    .slice(0, currentIndex === -1 ? events.length : currentIndex)
    .filter(event => event.type === 'tool/call' && event.data?.name === name)
}

/** Require Pro ownership and a successful manifest read before dependency installation. */
export function installPrerequisiteDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || dependencyInstallKey(execution.arguments?.command) === undefined) return undefined
  if (isManagedFlashChild(execution.agent)) return CHILD_SHELL_RESTRICTION_REASON
  if (execution?.agent?.session === undefined) return undefined

  const events = currentTaskEvents(execution.agent.session.events)
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  const beforeIndex = currentIndex === -1 ? events.length : currentIndex
  for (const event of events.slice(0, beforeIndex)) {
    if (!inspectsDependencyManifest(event)) continue
    const result = toolResultBlock(events, event.data?.callId)
    if (result !== undefined && result.isError !== true) return undefined
  }
  return INSTALL_INSPECTION_REQUIRED_REASON
}

/** Reject an unchanged dependency-install retry already dispatched in this task. */
export function duplicateInstallDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name) || execution?.agent?.session === undefined) return undefined
  const key = dependencyInstallKey(execution.arguments?.command)
  if (key === undefined) return undefined
  const events = currentTaskEvents(execution.agent.session.events)
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  const earlier = events.slice(0, currentIndex === -1 ? events.length : currentIndex)
  const previousInstalls = []
  for (const event of earlier) {
    if (event.type !== 'tool/call' || !SHELL_TOOLS.has(event.data?.name)) continue
    if (dependencyInstallKey(parsedArguments(event).command) !== key) continue
    const result = toolResultBlock(events, event.data?.callId)
    if (result !== undefined && result.isError !== true) previousInstalls.push(event)
  }
  const previous = previousInstalls.at(-1)
  if (previous === undefined) return undefined

  const previousIndex = events.indexOf(previous)
  for (const event of events.slice(previousIndex + 1, currentIndex === -1 ? events.length : currentIndex)) {
    if (event.type !== 'tool/call'
      || !['str_replace_editor', 'write', 'edit'].includes(event.data?.name)) continue
    const args = parsedArguments(event)
    if (args.command === 'view' || dependencyManifestPath(args) === undefined) continue
    const result = toolResultBlock(events, event.data?.callId)
    if (result !== undefined && result.isError !== true) return undefined
  }
  return DUPLICATE_INSTALL_REASON
}

/** Reject a remote resource already acquired successfully in this human task. */
export function duplicateFetchDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)) return undefined
  const currentUrls = remoteFetchUrls(execution.arguments?.command)
  if (currentUrls.length === 0) return undefined
  if (new Set(currentUrls).size !== currentUrls.length) return DUPLICATE_FETCH_REASON
  if (execution?.agent?.session === undefined) return undefined

  const events = currentTaskEvents(execution.agent.session.events)
  const currentIndex = events.findIndex(event => (
    event.type === 'tool/call' && event.data?.callId === execution.callId
  ))
  const earlier = events.slice(0, currentIndex === -1 ? events.length : currentIndex)
  const acquired = new Set()
  for (const event of earlier) {
    if (event.type !== 'tool/call' || !SHELL_TOOLS.has(event.data?.name)) continue
    const result = toolResultBlock(events, event.data?.callId)
    if (result === undefined || result.isError === true) continue
    for (const url of remoteFetchUrls(parsedArguments(event).command)) acquired.add(url)
  }
  return currentUrls.some(url => acquired.has(url)) ? DUPLICATE_FETCH_REASON : undefined
}

/** Keep managed Flash workers off the shell after the Minimal-shaped first request. */
export function childShellDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name) || !isManagedFlashChild(execution.agent)) return undefined
  return CHILD_SHELL_RESTRICTION_REASON
}

/** Bound shell-only exploration while preserving editor and purpose-built tools. */
export function rootShellBudgetDenial(execution) {
  if (!SHELL_TOOLS.has(execution?.name)
    || execution?.agent?.session === undefined
    || (execution.agent.session.header?.delegationDepth ?? 0) > 0) return undefined
  return shellCallAttemptsSinceEdit(execution.agent, execution.callId) >= ROOT_SHELL_HARD_LIMIT
    ? ROOT_SHELL_BUDGET_REASON
    : undefined
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
      return 'APEX v0.6.1 starts at most two new Flash workers in one model step; wait for evidence before expanding the cluster.'
    }
  }

  const duplicate = records.find(record => record.workItem.id === parsed.value.id)
  if (duplicate !== undefined) {
    return `APEX v0.6.1 work item "${parsed.value.id}" already exists. Resume its existing worker instead of starting a replacement.`
  }
  const overlap = records.find(record => workItemsOverlap(record.workItem, parsed.value))
  if (overlap !== undefined) {
    return `APEX v0.6.1 blocked overlapping write leases between "${overlap.workItem.id}" and "${parsed.value.id}". Resume the existing worker or choose disjoint paths.`
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
    return `APEX v0.6.1 worker ${record.childId} was transferred to the Pro parent and cannot be continued.`
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
    : 'APEX v0.6.1 blocked a repeated worker continuation with no new inspection evidence.'
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
    return `APEX v0.6.1 worker ${record.childId} was already transferred to the Pro parent.`
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
  const childShellReason = childShellDenial(execution)
  if (childShellReason !== undefined) return childShellReason
  if (SHELL_TOOLS.has(execution?.name)) {
    const command = execution?.arguments?.command
    if (isBroadProcessTermination(command)) return DENIAL_REASON
    if (isBrowserDownloadCommand(command)) return BROWSER_DOWNLOAD_REASON
    if (typeof command === 'string' && SYSTEM_SETTING_COMMAND.test(command)) {
      return SYSTEM_SETTING_REASON
    }
    if (execution.name === 'bash' && hasUnmanagedBackgroundOperator(command)) {
      return UNMANAGED_BACKGROUND_REASON
    }
    if (isUnboundedBrowserCommand(command)) return UNBOUNDED_BROWSER_REASON
    if (shellImplementationWrite(command)) return SHELL_AUTHORING_REASON
    if (execution.name === 'bash' && hasShellHeredoc(command)) return SHELL_HEREDOC_REASON
  }
  return workspaceShellDenial(execution)
    ?? workspacePathDenial(execution)
    ?? rootShellBudgetDenial(execution)
    ?? timedOutCommandDenial(execution)
    ?? installPrerequisiteDenial(execution)
    ?? duplicateInstallDenial(execution)
    ?? duplicateFetchDenial(execution)
    ?? workerPollingDenial(execution)
    ?? childScopeDenial(execution)
    ?? buildDenial(execution)
    ?? continuationDenial(execution)
    ?? takeoverDenial(execution)
    ?? parentTakeoverScopeDenial(execution)
    ?? researchDenial(execution)
}

export function apply(ctx) {
  ctx.tools.guard(guardExecution)
}
