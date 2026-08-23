/** Parse the small, durable work-item protocol carried by native subagent calls. */

import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

export const WORK_ITEM_PREFIX = 'APEX_WORK_ITEM '
export const WORKSPACE_PREFIX = 'APEX_WORKSPACE '
export const CONTINUE_PREFIX = 'APEX_CONTINUE '
export const MAX_APEX_WORKERS = 4
export const WORK_ITEM_SECTIONS = Object.freeze([
  'Goal',
  'Context',
  'Non-goals',
  'Constraints',
  'Acceptance',
  'Report',
])
export const BUILD_ARGUMENT_FIELDS = Object.freeze([
  'acceptance',
  'context',
  'description',
  'goal',
  'id',
  'non_goals',
  'paths',
])
export const CONTINUATION_ARGUMENT_FIELDS = Object.freeze([
  'child_id',
  'evidence',
  'instruction',
  'work_item_id',
])
export const TAKEOVER_ARGUMENT_FIELDS = Object.freeze([
  'child_id',
  'evidence',
  'reason',
  'work_item_id',
])
export const TAKEOVER_REASONS = Object.freeze([
  'worker_max_tokens',
  'worker_failed',
  'no_write_progress',
  'repeated_runtime_failure',
  'final_runtime_failure',
  'pro_only_fix',
])
export const WORK_ITEM_CONSTRAINTS = [
  'For a file lease, copy its absolute path from APEX_WORKSPACE exactly into str_replace_editor; for a directory lease, write only beneath its absolute directory. Never guess or probe alternative roots.',
  'Edit only leased paths and use str_replace_editor for every write.',
  'Do not invoke Bash or PowerShell.',
  'Do not research, install dependencies, fetch remote sources, start servers or browsers, or run tests.',
  'The Pro parent owns validation, review, and final judgment.',
].join(' ')
export const WORK_ITEM_REPORT = [
  'Call report once with status, changed paths, completed work, remaining gaps, and blockers.',
  'Do not claim checks that you did not run.',
].join(' ')
export const FLASH_BUILD_GUIDE = [
  'Work as a bounded implementation specialist, not as a second project lead.',
  'Read the leased files and their stated interfaces once, then implement the smallest complete change that satisfies Acceptance.',
  'Match reasoning depth to the actual coupling: resolve simple local changes directly, and spend extra analysis only on interfaces, state, or edge cases that affect this lease.',
  'Prioritize interface compatibility, edge cases, and integration with the Context; do not repeat an inspection unless a new edit or parent evidence changed it.',
  'End each reasoning branch with either a concrete edit decision or one specific missing fact. Once the leased scope is complete or blocked, report immediately.',
].join(' ')
export const FLASH_REPAIR_GUIDE = [
  'Treat this as a focused repair of the cited evidence, not a new design pass.',
  'Preserve correct existing work, inspect only the affected leased paths, make the smallest complete fix, then report.',
].join(' ')

const MAX_WORK_ITEM_ID_CHARS = 64
const MAX_SCOPE_PATHS = 12
const MAX_SCOPE_PATH_CHARS = 240
const MAX_DESCRIPTION_CHARS = 80
const MAX_BRIEF_CHARS = 4_000
const MAX_CONTEXT_CHARS = 8_000
const MAX_EVIDENCE_ITEMS = 8
const MAX_EVIDENCE_CHARS = 400
const MAX_CONTINUATION_INSTRUCTION_CHARS = 2_000
const MAX_CHILD_ID_CHARS = 128
const WORK_ITEM_ID = /^[a-z0-9][a-z0-9._-]*$/
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i

function error(message) {
  return { ok: false, error: message }
}

function leadingJson(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    return error(`the message must start with ${prefix.trim()} followed by one-line JSON`)
  }
  const lineEnd = value.indexOf('\n')
  const json = value.slice(prefix.length, lineEnd === -1 ? value.length : lineEnd).trim()
  try {
    const parsed = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ok: true, value: parsed, body: lineEnd === -1 ? '' : value.slice(lineEnd + 1).trim() }
      : error(`${prefix.trim()} must contain a JSON object`)
  } catch {
    return error(`${prefix.trim()} contains invalid JSON`)
  }
}

function normalizeWorkItemId(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase().replace(/\s+/g, '-')
  return id.length > 0
    && id.length <= MAX_WORK_ITEM_ID_CHARS
    && WORK_ITEM_ID.test(id)
    ? id
    : undefined
}

function normalizeBrief(value, maxChars = MAX_BRIEF_CHARS) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > 0 && text.length <= maxChars ? text : undefined
}

function briefBoundsError(field, value, maxChars) {
  const length = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').length
    : 0
  return error(`apex_build ${field} must be 1-${maxChars} characters; received ${length}`)
}

/** Normalize one workspace-relative file or trailing /** directory scope. */
export function normalizeScopePath(value) {
  if (typeof value !== 'string') return undefined
  const path = value.trim().replace(/^(?:\.\/)+/, '')
  if (path.length === 0
    || path === '**'
    || path.length > MAX_SCOPE_PATH_CHARS
    || path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('~')
    || WINDOWS_ABSOLUTE.test(path)) return undefined

  const directory = path.endsWith('/**')
  const base = directory ? path.slice(0, -3) : path
  if (base.length === 0 || /[*?[\]]/.test(base)) return undefined
  const segments = base.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return undefined
  }
  return directory ? `${segments.join('/')}/**` : segments.join('/')
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_PATHS) {
    return undefined
  }
  const paths = []
  const seen = new Set()
  for (const item of value) {
    const path = normalizeScopePath(item)
    if (path === undefined) return undefined
    if (!seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

/** Validate the model-facing structured apex_build arguments. */
export function parseBuildArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return error('apex_build arguments must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== BUILD_ARGUMENT_FIELDS.join(',')) {
    return error(`apex_build requires exactly: ${BUILD_ARGUMENT_FIELDS.join(', ')}`)
  }
  const id = normalizeWorkItemId(value.id)
  if (id === undefined) {
    return error('apex_build id must be 1-64 letters, digits, spaces, dot, dash, or underscore')
  }
  const paths = normalizeScopes(value.paths)
  if (paths === undefined) {
    return error('apex_build paths must contain 1-12 bounded workspace-relative files or non-root trailing /** directory scopes; the whole-workspace ** lease is forbidden')
  }
  const description = normalizeBrief(value.description, MAX_DESCRIPTION_CHARS)
  const goal = normalizeBrief(value.goal)
  const context = normalizeBrief(value.context, MAX_CONTEXT_CHARS)
  const nonGoals = normalizeBrief(value.non_goals)
  const acceptance = normalizeBrief(value.acceptance)
  if (description === undefined) return error(`apex_build description must be 1-${MAX_DESCRIPTION_CHARS} characters`)
  if (goal === undefined) return briefBoundsError('goal', value.goal, MAX_BRIEF_CHARS)
  if (context === undefined) return briefBoundsError('context', value.context, MAX_CONTEXT_CHARS)
  if (nonGoals === undefined) return briefBoundsError('non_goals', value.non_goals, MAX_BRIEF_CHARS)
  if (acceptance === undefined) return briefBoundsError('acceptance', value.acceptance, MAX_BRIEF_CHARS)
  return {
    ok: true,
    value: { description, id, paths, goal, context, nonGoals, acceptance },
  }
}

function workspaceDescriptor(workItem, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new Error('apex_build requires an absolute workspace root')
  }
  const path = WINDOWS_ABSOLUTE.test(workspaceRoot) ? win32 : posix
  if (!path.isAbsolute(workspaceRoot)) throw new Error('apex_build requires an absolute workspace root')
  const root = path.normalize(workspaceRoot)
  const leases = workItem.paths.map((scope) => {
    const directory = scope.endsWith('/**')
    const relativePath = directory ? scope.slice(0, -3) : scope
    return {
      scope,
      kind: directory ? 'directory' : 'file',
      absolute: path.resolve(root, ...relativePath.split('/')),
    }
  })
  return { root, leases }
}

/** Compile structured arguments and the host-known workspace into one canonical child work item. */
export function renderWorkItemPrompt(workItem, workspaceRoot) {
  return [
    `${WORK_ITEM_PREFIX}${JSON.stringify({ id: workItem.id, paths: workItem.paths })}`,
    `${WORKSPACE_PREFIX}${JSON.stringify(workspaceDescriptor(workItem, workspaceRoot))}`,
    `Goal: ${workItem.goal}`,
    `Context: ${workItem.context}`,
    `Non-goals: ${workItem.nonGoals}`,
    `Constraints: ${WORK_ITEM_CONSTRAINTS} ${FLASH_BUILD_GUIDE}`,
    `Acceptance: ${workItem.acceptance}`,
    `Report: ${WORK_ITEM_REPORT}`,
  ].join('\n')
}

function workItemSectionContent(body) {
  const labels = WORK_ITEM_SECTIONS
    .map(section => section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const inline = new RegExp(`^\\s{0,3}(?:#{1,6}\\s+|[-*+]\\s+)?(${labels})\\s*[:：]\\s*(.*)$`, 'i')
  const heading = new RegExp(`^\\s{0,3}(?:#{1,6}\\s+)?(${labels})\\s*$`, 'i')
  const canonical = new Map(WORK_ITEM_SECTIONS.map(section => [section.toLowerCase(), section]))
  const content = new Map(WORK_ITEM_SECTIONS.map(section => [section, []]))
  let current
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(inline) ?? line.match(heading)
    if (match !== null) {
      current = canonical.get(match[1].toLowerCase())
      if (match[2]?.trim()) content.get(current).push(match[2].trim())
    } else if (current !== undefined) {
      content.get(current).push(line)
    }
  }
  return content
}

function missingWorkItemSections(body) {
  const content = workItemSectionContent(body)
  return WORK_ITEM_SECTIONS.filter(section => content.get(section).join('\n').trim().length === 0)
}

/** Parse the mandatory first-line header of one fresh apex_build prompt. */
export function parseWorkItemPrompt(prompt) {
  const parsed = leadingJson(prompt, WORK_ITEM_PREFIX)
  if (!parsed.ok) return parsed
  const keys = Object.keys(parsed.value).sort()
  if (keys.join(',') !== 'id,paths') {
    return error('APEX_WORK_ITEM allows exactly the id and paths fields')
  }
  const id = normalizeWorkItemId(parsed.value.id)
  if (id === undefined) return error('APEX_WORK_ITEM id must be 1-64 lowercase letters, digits, dot, dash, or underscore')
  const paths = normalizeScopes(parsed.value.paths)
  if (paths === undefined) {
    return error('APEX_WORK_ITEM paths must contain 1-12 bounded workspace-relative files or non-root trailing /** directory scopes')
  }
  if (parsed.body.length === 0) return error('APEX_WORK_ITEM must be followed by a self-contained implementation brief')
  const missing = missingWorkItemSections(parsed.body)
  if (missing.length > 0) {
    return error(`APEX_WORK_ITEM brief requires non-empty sections: ${missing.join(', ')}`)
  }
  return { ok: true, value: { id, paths }, body: parsed.body }
}

/** Parse the evidence header required before continuing an existing worker. */
export function parseContinuationMessage(message) {
  const parsed = leadingJson(message, CONTINUE_PREFIX)
  if (!parsed.ok) return parsed
  const keys = Object.keys(parsed.value).sort()
  if (keys.join(',') !== 'evidence,workItemId') {
    return error('APEX_CONTINUE allows exactly the workItemId and evidence fields')
  }
  const workItemId = normalizeWorkItemId(parsed.value.workItemId)
  if (workItemId === undefined) return error('APEX_CONTINUE workItemId is invalid')
  if (!Array.isArray(parsed.value.evidence)
    || parsed.value.evidence.length === 0
    || parsed.value.evidence.length > MAX_EVIDENCE_ITEMS) {
    return error(`APEX_CONTINUE evidence must contain 1-${MAX_EVIDENCE_ITEMS} concrete inspection findings`)
  }
  const evidence = []
  const seen = new Set()
  for (const item of parsed.value.evidence) {
    if (typeof item !== 'string') return error('APEX_CONTINUE evidence items must be strings')
    const text = item.trim()
    if (text.length === 0 || text.length > MAX_EVIDENCE_CHARS) {
      return error(`APEX_CONTINUE evidence items must be 1-${MAX_EVIDENCE_CHARS} characters`)
    }
    const normalized = text.toLowerCase().replace(/\s+/g, ' ')
    if (!seen.has(normalized)) {
      seen.add(normalized)
      evidence.push(text)
    }
  }
  if (parsed.body.length === 0) return error('APEX_CONTINUE must be followed by one bounded repair instruction')
  return { ok: true, value: { workItemId, evidence }, body: parsed.body }
}

/** Validate the structured fields used by the host-owned continuation tool. */
export function parseContinuationArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return error('apex_continue arguments must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== CONTINUATION_ARGUMENT_FIELDS.join(',')) {
    return error(`apex_continue requires exactly: ${CONTINUATION_ARGUMENT_FIELDS.join(', ')}`)
  }
  const childId = typeof value.child_id === 'string' ? value.child_id.trim() : ''
  if (childId.length === 0 || childId.length > MAX_CHILD_ID_CHARS || /\s/.test(childId)) {
    return error(`apex_continue child_id must be 1-${MAX_CHILD_ID_CHARS} non-whitespace characters`)
  }
  const workItemId = normalizeWorkItemId(value.work_item_id)
  if (workItemId === undefined) return error('apex_continue work_item_id is invalid')
  if (!Array.isArray(value.evidence)
    || value.evidence.length === 0
    || value.evidence.length > MAX_EVIDENCE_ITEMS) {
    return error(`apex_continue evidence must contain 1-${MAX_EVIDENCE_ITEMS} concrete inspection findings`)
  }
  const evidence = []
  const seen = new Set()
  for (const item of value.evidence) {
    if (typeof item !== 'string') return error('apex_continue evidence items must be strings')
    const text = item.trim()
    if (text.length === 0 || text.length > MAX_EVIDENCE_CHARS) {
      return error(`apex_continue evidence items must be 1-${MAX_EVIDENCE_CHARS} characters`)
    }
    const normalized = text.toLowerCase().replace(/\s+/g, ' ')
    if (!seen.has(normalized)) {
      seen.add(normalized)
      evidence.push(text)
    }
  }
  const instruction = normalizeBrief(value.instruction, MAX_CONTINUATION_INSTRUCTION_CHARS)
  if (instruction === undefined) {
    return error(`apex_continue instruction must be 1-${MAX_CONTINUATION_INSTRUCTION_CHARS} characters`)
  }
  return { ok: true, value: { childId, workItemId, evidence, instruction } }
}

/** Validate one explicit lease transfer from a settled worker to the Pro parent. */
export function parseTakeoverArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return error('apex_takeover arguments must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== TAKEOVER_ARGUMENT_FIELDS.join(',')) {
    return error(`apex_takeover requires exactly: ${TAKEOVER_ARGUMENT_FIELDS.join(', ')}`)
  }
  if (!TAKEOVER_REASONS.includes(value.reason)) {
    return error(`apex_takeover reason must be one of: ${TAKEOVER_REASONS.join(', ')}`)
  }
  const parsed = parseContinuationArguments({
    child_id: value.child_id,
    work_item_id: value.work_item_id,
    evidence: value.evidence,
    instruction: 'Transfer this settled lease to the Pro parent.',
  })
  if (!parsed.ok) return { ok: false, error: parsed.error.replaceAll('apex_continue', 'apex_takeover') }
  const { instruction: _instruction, ...fields } = parsed.value
  return { ok: true, value: { ...fields, reason: value.reason } }
}

/** Compile structured continuation fields into the child's durable protocol. */
export function renderContinuationMessage(value) {
  return `${CONTINUE_PREFIX}${JSON.stringify({
    workItemId: value.workItemId,
    evidence: value.evidence,
  })}\n${value.instruction}\n${FLASH_REPAIR_GUIDE}`
}

function directoryRoot(scope) {
  return scope.endsWith('/**') ? scope.slice(0, -3) : undefined
}

/** True when two write leases could name the same path. */
export function scopesOverlap(left, right) {
  if (left === right) return true
  const leftRoot = directoryRoot(left)
  const rightRoot = directoryRoot(right)
  if (leftRoot !== undefined && (right === leftRoot || right.startsWith(`${leftRoot}/`))) return true
  if (rightRoot !== undefined && (left === rightRoot || left.startsWith(`${rightRoot}/`))) return true
  return false
}

export function workItemsOverlap(left, right) {
  return left.paths.some(leftPath => right.paths.some(rightPath => scopesOverlap(leftPath, rightPath)))
}

/** Extract the initial work item from an immutable child event log. */
export function workItemFromEvents(events = []) {
  const message = events.find(event => (
    event.type === 'user/message' && event.data?.source?.kind === 'user'
  ))
  const text = Array.isArray(message?.data?.content)
    ? message.data.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    : ''
  const parsed = parseWorkItemPrompt(text)
  return parsed.ok ? parsed.value : undefined
}

/** Extract the initial work item from a continuable child's own first prompt. */
export function workItemForChild(agent) {
  return workItemFromEvents(agent?.session?.events)
}

/** Convert a model path into a non-leaking path relative to an immutable workspace root. */
export function workspaceRelativePathFromRoot(cwd, value) {
  if (typeof cwd !== 'string' || typeof value !== 'string' || value.length === 0) return undefined
  const target = isAbsolute(value) || WINDOWS_ABSOLUTE.test(value) ? value : resolve(cwd, value)
  const result = relative(cwd, target).split(sep).join('/')
  return result.length > 0 && result !== '..' && !result.startsWith('../') && !isAbsolute(result)
    ? result
    : undefined
}

/** Convert an editor argument into a non-leaking path relative to the child workspace. */
export function workspaceRelativePath(agent, value) {
  return workspaceRelativePathFromRoot(agent?.session?.header?.cwd, value)
}

/** True when one normalized workspace path belongs to a work item's lease. */
export function workItemOwnsPath(workItem, path) {
  return workItem.paths.some((scope) => {
    if (scope === path) return true
    const root = directoryRoot(scope)
    return root !== undefined && path.startsWith(`${root}/`)
  })
}
