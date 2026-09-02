/** Parse the durable, role-aware handoff protocol carried by APEX workers. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

export const HANDOFF_VERSION = 1
export const HANDOFF_PREFIX = 'APEX_HANDOFF '
export const HANDOFF_REPORT_PREFIX = 'APEX_HANDOFF_REPORT '
// Persisted pre-handoff children still use this prefix. Keep parsing it until
// those sessions no longer need to resume.
export const WORK_ITEM_PREFIX = 'APEX_WORK_ITEM '
export const WORKSPACE_PREFIX = 'APEX_WORKSPACE '
export const CONTINUE_PREFIX = 'APEX_CONTINUE '
export const MAX_APEX_WORKERS = 4
export const WORKER_ROLES = Object.freeze([
  'flash-production',
  'pro-core',
])
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
  'interfaces',
  'invariants',
  'non_goals',
  'paths',
  'read_only_inputs',
  'role',
])
const LEGACY_BUILD_ARGUMENT_FIELDS = Object.freeze([
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
  'Do not research, install dependencies, fetch remote sources, start servers or browsers.',
  'The Pro parent owns validation, review, and final judgment.',
].join(' ')
export const WORK_ITEM_REPORT = [
  `Call report once with output beginning ${HANDOFF_REPORT_PREFIX.trim()} followed by one-line JSON.`,
  'From run_code, build a JavaScript object and pass JSON.stringify(object) to tools.report; never hand-escape report JSON inside a string or template literal.',
  'Copy the task-specific template in this message and change values only; never rename, add, or remove fields.',
  'Do not claim checks that you did not run.',
].join(' ')
export const FLASH_BUILD_GUIDE = [
  'Work as a bounded implementation specialist, not as a second project lead.',
  'Read the leased files and their stated interfaces once, then implement the smallest complete change that satisfies Acceptance.',
  'Match reasoning depth to the actual coupling: resolve simple local changes directly, and spend extra analysis only on interfaces, state, or edge cases that affect this lease.',
  'Prioritize interface compatibility, edge cases, and integration with the Context; do not repeat an inspection unless a new edit or parent evidence changed it.',
  'End each reasoning branch with either a concrete edit decision or one specific missing fact. Once the leased scope is complete or blocked, report immediately.',
].join(' ')
export const PRO_CORE_GUIDE = [
  'Work as the Pro core implementation specialist for the parent Pro architect.',
  'Own the difficult algorithmic and integration decisions inside the lease while preserving every declared interface and invariant.',
  'Use the PTC SDK to batch related reads, edits, and the smallest relevant checks; do not delegate again.',
  'Report uncertainty and unverified behavior explicitly instead of weakening the contract.',
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
const MAX_CONTRACT_ITEMS = 12
const MAX_CONTRACT_ITEM_CHARS = 600
const MAX_CONTRACT_ID_CHARS = 64
const MAX_REPORT_ITEMS = 12
const MAX_REPORT_ITEM_CHARS = 600
const MAX_EVIDENCE_ITEMS = 8
const MAX_EVIDENCE_CHARS = 400
const MAX_CONTINUATION_INSTRUCTION_CHARS = 2_000
const MAX_CHILD_ID_CHARS = 128
const WORK_ITEM_ID = /^[a-z0-9][a-z0-9._-]*$/
const CONTRACT_ID = /^[a-z0-9][a-z0-9._-]*$/
const SHA256 = /^[a-f0-9]{64}$/
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

function normalizeContractId(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return id.length > 0 && id.length <= MAX_CONTRACT_ID_CHARS && CONTRACT_ID.test(id)
    ? id
    : undefined
}

function normalizeStringList(value, {
  minItems = 0,
  maxItems = MAX_CONTRACT_ITEMS,
  maxChars = MAX_CONTRACT_ITEM_CHARS,
} = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return undefined
  const items = []
  const seen = new Set()
  for (const item of value) {
    const text = normalizeBrief(item, maxChars)
    if (text === undefined) return undefined
    const key = text.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      items.push(text)
    }
  }
  return items.length >= minItems ? items : undefined
}

function normalizeNamedContracts(value, valueKey, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_CONTRACT_ITEMS) {
    return undefined
  }
  const items = []
  const ids = new Set()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (Object.keys(item).sort().join(',') !== ['id', valueKey].sort().join(',')) return undefined
    const id = normalizeContractId(item.id)
    const text = normalizeBrief(item[valueKey], MAX_CONTRACT_ITEM_CHARS)
    if (id === undefined || text === undefined || ids.has(id)) return undefined
    ids.add(id)
    items.push({ id, [valueKey]: text })
  }
  return items
}

function normalizeReadOnlyInputs(value) {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_ITEMS) return undefined
  const items = []
  const paths = new Set()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (Object.keys(item).sort().join(',') !== 'path,purpose') return undefined
    const path = normalizeScopePath(item.path)
    const purpose = normalizeBrief(item.purpose, MAX_CONTRACT_ITEM_CHARS)
    if (path === undefined || path.endsWith('/**') || purpose === undefined || paths.has(path)) {
      return undefined
    }
    paths.add(path)
    items.push({ path, purpose })
  }
  return items
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
  const role = WORKER_ROLES.includes(value.role) ? value.role : undefined
  const readOnlyInputs = normalizeReadOnlyInputs(value.read_only_inputs)
  const interfaces = normalizeNamedContracts(value.interfaces, 'contract')
  const invariants = normalizeNamedContracts(value.invariants, 'statement', { minItems: 1 })
  const acceptance = normalizeNamedContracts(value.acceptance, 'assertion', { minItems: 1 })
  const nonGoals = normalizeStringList(value.non_goals, { minItems: 1 })
  if (description === undefined) return error(`apex_build description must be 1-${MAX_DESCRIPTION_CHARS} characters`)
  if (goal === undefined) return briefBoundsError('goal', value.goal, MAX_BRIEF_CHARS)
  if (context === undefined) return briefBoundsError('context', value.context, MAX_CONTEXT_CHARS)
  if (role === undefined) return error(`apex_build role must be one of: ${WORKER_ROLES.join(', ')}`)
  if (readOnlyInputs === undefined) {
    return error('apex_build read_only_inputs must contain 0-12 unique {path, purpose} file records')
  }
  if (readOnlyInputs.some(input => paths.some(scope => scopesOverlap(scope, input.path)))) {
    return error('apex_build read_only_inputs must not overlap writable paths')
  }
  if (interfaces === undefined) {
    return error('apex_build interfaces must contain 0-12 unique {id, contract} records')
  }
  if (invariants === undefined) {
    return error('apex_build invariants must contain 1-12 unique {id, statement} records')
  }
  if (acceptance === undefined) {
    return error('apex_build acceptance must contain 1-12 unique {id, assertion} records')
  }
  if (nonGoals === undefined) return error('apex_build non_goals must contain 1-12 bounded strings')
  return {
    ok: true,
    value: {
      version: HANDOFF_VERSION,
      revision: 1,
      role,
      description,
      id,
      paths,
      readOnlyInputs,
      goal,
      context,
      interfaces,
      invariants,
      nonGoals,
      acceptance,
    },
  }
}

/** Read already-persisted pre-handoff build calls without accepting them as new input. */
export function parsePersistedBuildArguments(value) {
  const current = parseBuildArguments(value)
  if (current.ok) return current
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return current
  if (Object.keys(value).sort().join(',') !== LEGACY_BUILD_ARGUMENT_FIELDS.join(',')) return current
  const id = normalizeWorkItemId(value.id)
  const paths = normalizeScopes(value.paths)
  const description = normalizeBrief(value.description, MAX_DESCRIPTION_CHARS)
  const goal = normalizeBrief(value.goal)
  const context = normalizeBrief(value.context, MAX_CONTEXT_CHARS)
  const nonGoal = normalizeBrief(value.non_goals, MAX_CONTRACT_ITEM_CHARS)
  const assertion = normalizeBrief(value.acceptance, MAX_CONTRACT_ITEM_CHARS)
  if (id === undefined
    || paths === undefined
    || description === undefined
    || goal === undefined
    || context === undefined
    || nonGoal === undefined
    || assertion === undefined) return current
  return {
    ok: true,
    value: {
      version: 0,
      revision: 1,
      role: 'flash-production',
      description,
      id,
      paths,
      readOnlyInputs: [],
      goal,
      context,
      interfaces: [],
      invariants: [{ id: 'legacy-lease', statement: 'Edit only the persisted leased paths.' }],
      nonGoals: [nonGoal],
      acceptance: [{ id: 'legacy-acceptance', assertion }],
    },
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

async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function renderHandoffReportInstructions(workItem, revision) {
  const template = {
    handoffId: workItem.id,
    revision,
    status: 'completed',
    changedPaths: workItem.paths.filter(path => !path.endsWith('/**')),
    completedAcceptance: workItem.acceptance.map(item => item.id),
    decisions: [],
    unverified: [],
    remainingGaps: [],
    blockers: [],
    recommendedOwner: 'pro',
  }
  return [
    WORK_ITEM_REPORT,
    `${HANDOFF_REPORT_PREFIX}${JSON.stringify(template)}`,
    `PTC-safe invocation: const handoffReport = ${JSON.stringify(template)}; await tools.report({ output: '${HANDOFF_REPORT_PREFIX}' + JSON.stringify(handoffReport) });`,
    'status must be exactly completed, partial, or blocked.',
    'changedPaths must contain only exact workspace-relative files with successful mutations: remove untouched file leases, replace directory /** scopes with the files actually changed, and never use absolute paths or /**.',
    'decisions must contain only {"decision":"...","reason":"..."} objects. completed requires every acceptance id and empty remainingGaps/blockers; otherwise report only evidence actually established.',
  ].join('\n')
}

/** Resolve and hash every immutable input before a worker starts. */
export async function snapshotReadOnlyInputs(workItem, workspaceRoot) {
  const descriptor = workspaceDescriptor(workItem, workspaceRoot)
  const pathApi = WINDOWS_ABSOLUTE.test(descriptor.root) ? win32 : posix
  const result = []
  for (const input of workItem.readOnlyInputs) {
    const absolute = pathApi.resolve(descriptor.root, ...input.path.split('/'))
    const info = await lstat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`apex_build read-only input must be an existing regular file: ${input.path}`)
    }
    result.push({ ...input, sha256: await fileSha256(absolute) })
  }
  return result
}

/** Re-hash immutable inputs after a worker settles and name every drifted path. */
export async function verifyReadOnlyInputHashes(workItem, workspaceRoot) {
  if (!Array.isArray(workItem?.readOnlyInputs) || workItem.readOnlyInputs.length === 0) return []
  const descriptor = workspaceDescriptor(workItem, workspaceRoot)
  const pathApi = WINDOWS_ABSOLUTE.test(descriptor.root) ? win32 : posix
  const drifted = []
  for (const input of workItem.readOnlyInputs) {
    const absolute = pathApi.resolve(descriptor.root, ...input.path.split('/'))
    let current
    try {
      const info = await lstat(absolute)
      if (!info.isFile() || info.isSymbolicLink()) {
        drifted.push(input.path)
        continue
      }
      current = await fileSha256(absolute)
    } catch {
      drifted.push(input.path)
      continue
    }
    if (current !== input.sha256) drifted.push(input.path)
  }
  return drifted
}

/** Compile structured arguments and the host-known workspace into one canonical child work item. */
export function renderWorkItemPrompt(workItem, workspaceRoot, readOnlyInputs = []) {
  const handoff = {
    version: HANDOFF_VERSION,
    handoffId: workItem.id,
    revision: workItem.revision,
    role: workItem.role,
    description: workItem.description,
    goal: workItem.goal,
    leases: workItem.paths,
    readOnlyInputs,
    context: workItem.context,
    interfaces: workItem.interfaces,
    invariants: workItem.invariants,
    acceptance: workItem.acceptance,
    nonGoals: workItem.nonGoals,
  }
  const guide = workItem.role === 'pro-core' ? PRO_CORE_GUIDE : FLASH_BUILD_GUIDE
  return [
    `${HANDOFF_PREFIX}${JSON.stringify(handoff)}`,
    `${WORKSPACE_PREFIX}${JSON.stringify(workspaceDescriptor(workItem, workspaceRoot))}`,
    `Constraints: ${WORK_ITEM_CONSTRAINTS} ${guide}`,
    `Report:\n${renderHandoffReportInstructions(workItem, workItem.revision)}`,
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

function normalizeSnapshotInputs(value) {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_ITEMS) return undefined
  const items = []
  const paths = new Set()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (Object.keys(item).sort().join(',') !== 'path,purpose,sha256') return undefined
    const path = normalizeScopePath(item.path)
    const purpose = normalizeBrief(item.purpose, MAX_CONTRACT_ITEM_CHARS)
    if (path === undefined
      || path.endsWith('/**')
      || purpose === undefined
      || typeof item.sha256 !== 'string'
      || !SHA256.test(item.sha256)
      || paths.has(path)) return undefined
    paths.add(path)
    items.push({ path, purpose, sha256: item.sha256 })
  }
  return items
}

function parseHandoffPrompt(prompt) {
  const parsed = leadingJson(prompt, HANDOFF_PREFIX)
  if (!parsed.ok) return parsed
  const expected = [
    'acceptance', 'context', 'description', 'goal', 'handoffId', 'interfaces',
    'invariants', 'leases', 'nonGoals', 'readOnlyInputs', 'revision', 'role', 'version',
  ]
  if (Object.keys(parsed.value).sort().join(',') !== expected.sort().join(',')) {
    return error(`APEX_HANDOFF requires exactly: ${expected.join(', ')}`)
  }
  const id = normalizeWorkItemId(parsed.value.handoffId)
  const paths = normalizeScopes(parsed.value.leases)
  const readOnlyInputs = normalizeSnapshotInputs(parsed.value.readOnlyInputs)
  const interfaces = normalizeNamedContracts(parsed.value.interfaces, 'contract')
  const invariants = normalizeNamedContracts(parsed.value.invariants, 'statement', { minItems: 1 })
  const acceptance = normalizeNamedContracts(parsed.value.acceptance, 'assertion', { minItems: 1 })
  const nonGoals = normalizeStringList(parsed.value.nonGoals, { minItems: 1 })
  const description = normalizeBrief(parsed.value.description, MAX_DESCRIPTION_CHARS)
  const goal = normalizeBrief(parsed.value.goal)
  const context = normalizeBrief(parsed.value.context, MAX_CONTEXT_CHARS)
  if (parsed.value.version !== HANDOFF_VERSION || parsed.value.revision !== 1) {
    return error(`APEX_HANDOFF requires version=${HANDOFF_VERSION} and revision=1`)
  }
  if (!WORKER_ROLES.includes(parsed.value.role)
    || id === undefined
    || paths === undefined
    || readOnlyInputs === undefined
    || interfaces === undefined
    || invariants === undefined
    || acceptance === undefined
    || nonGoals === undefined
    || description === undefined
    || goal === undefined
    || context === undefined) {
    return error('APEX_HANDOFF contains an invalid or unbounded contract field')
  }
  if (readOnlyInputs.some(input => paths.some(scope => scopesOverlap(scope, input.path)))) {
    return error('APEX_HANDOFF read-only inputs overlap writable leases')
  }
  return {
    ok: true,
    value: {
      version: HANDOFF_VERSION,
      revision: 1,
      role: parsed.value.role,
      description,
      id,
      paths,
      readOnlyInputs,
      goal,
      context,
      interfaces,
      invariants,
      nonGoals,
      acceptance,
    },
    body: parsed.body,
  }
}

/** Parse the mandatory first-line header of one fresh apex_build prompt. */
export function parseWorkItemPrompt(prompt) {
  if (typeof prompt === 'string' && prompt.startsWith(HANDOFF_PREFIX)) {
    return parseHandoffPrompt(prompt)
  }
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
  return {
    ok: true,
    value: {
      version: 0,
      revision: 1,
      role: 'flash-production',
      id,
      paths,
      readOnlyInputs: [],
      interfaces: [],
      invariants: [],
      acceptance: [],
      nonGoals: [],
    },
    body: parsed.body,
  }
}

/** Parse the evidence header required before continuing an existing worker. */
export function parseContinuationMessage(message) {
  const parsed = leadingJson(message, CONTINUE_PREFIX)
  if (!parsed.ok) return parsed
  const keys = Object.keys(parsed.value).sort()
  const current = keys.join(',') === 'evidence,handoffId,revision,version'
  const legacy = keys.join(',') === 'evidence,workItemId'
  if (!current && !legacy) {
    return error('APEX_CONTINUE allows exactly version, handoffId, revision, and evidence')
  }
  const workItemId = normalizeWorkItemId(current ? parsed.value.handoffId : parsed.value.workItemId)
  if (workItemId === undefined) return error('APEX_CONTINUE workItemId is invalid')
  const revision = current ? parsed.value.revision : 2
  if ((current && parsed.value.version !== HANDOFF_VERSION)
    || !Number.isSafeInteger(revision)
    || revision < 2) {
    return error(`APEX_CONTINUE requires version=${HANDOFF_VERSION} and revision>=2`)
  }
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
  return { ok: true, value: { workItemId, evidence, revision }, body: parsed.body }
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
export function renderContinuationMessage(value, revision = 2, workItem) {
  const report = workItem === undefined
    ? WORK_ITEM_REPORT
    : renderHandoffReportInstructions(workItem, revision)
  return `${CONTINUE_PREFIX}${JSON.stringify({
    version: HANDOFF_VERSION,
    handoffId: value.workItemId,
    revision,
    evidence: value.evidence,
  })}\n${value.instruction}\n${FLASH_REPAIR_GUIDE}\nReport:\n${report}`
}

function userMessageText(event) {
  return Array.isArray(event?.data?.content)
    ? event.data.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    : ''
}

/** Return the latest accepted revision in one child's durable handoff log. */
export function latestHandoffRevision(events = []) {
  const workItem = workItemFromEvents(events)
  if (workItem === undefined) return undefined
  let revision = workItem.revision
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = userMessageText(event)
    if (!text.startsWith(CONTINUE_PREFIX)) continue
    const parsed = parseContinuationMessage(text)
    if (parsed.ok
      && parsed.value.workItemId === workItem.id
      && parsed.value.revision === revision + 1) {
      revision = parsed.value.revision
    }
  }
  return revision
}

function normalizeReportPaths(value) {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_PATHS) return undefined
  const paths = []
  const seen = new Set()
  for (const item of value) {
    const path = normalizeScopePath(item)
    if (path === undefined || path.endsWith('/**') || seen.has(path)) return undefined
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function normalizeCompletedAcceptance(value) {
  if (!Array.isArray(value) || value.length > MAX_CONTRACT_ITEMS) return undefined
  const ids = []
  const seen = new Set()
  for (const item of value) {
    const id = normalizeContractId(item)
    if (id === undefined || seen.has(id)) return undefined
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function normalizeDecisions(value) {
  if (!Array.isArray(value) || value.length > MAX_REPORT_ITEMS) return undefined
  const decisions = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (Object.keys(item).sort().join(',') !== 'decision,reason') return undefined
    const decision = normalizeBrief(item.decision, MAX_REPORT_ITEM_CHARS)
    const reason = normalizeBrief(item.reason, MAX_REPORT_ITEM_CHARS)
    if (decision === undefined || reason === undefined) return undefined
    decisions.push({ decision, reason })
  }
  return decisions
}

/** Parse and validate one child-to-parent report against its immutable work order. */
export function parseHandoffReportOutput(output, workItem, expectedRevision = 1) {
  const parsed = leadingJson(output, HANDOFF_REPORT_PREFIX)
  if (!parsed.ok) return parsed
  if (parsed.body.length > 0) return error('APEX_HANDOFF_REPORT must be one JSON line with no trailing prose')
  const expected = [
    'blockers', 'changedPaths', 'completedAcceptance', 'decisions', 'handoffId',
    'recommendedOwner', 'remainingGaps', 'revision', 'status', 'unverified',
  ]
  if (Object.keys(parsed.value).sort().join(',') !== expected.join(',')) {
    return error(`APEX_HANDOFF_REPORT requires exactly: ${expected.join(', ')}`)
  }
  const handoffId = normalizeWorkItemId(parsed.value.handoffId)
  const changedPaths = normalizeReportPaths(parsed.value.changedPaths)
  const completedAcceptance = normalizeCompletedAcceptance(parsed.value.completedAcceptance)
  const decisions = normalizeDecisions(parsed.value.decisions)
  const unverified = normalizeStringList(parsed.value.unverified, {
    maxItems: MAX_REPORT_ITEMS,
    maxChars: MAX_REPORT_ITEM_CHARS,
  })
  const remainingGaps = normalizeStringList(parsed.value.remainingGaps, {
    maxItems: MAX_REPORT_ITEMS,
    maxChars: MAX_REPORT_ITEM_CHARS,
  })
  const blockers = normalizeStringList(parsed.value.blockers, {
    maxItems: MAX_REPORT_ITEMS,
    maxChars: MAX_REPORT_ITEM_CHARS,
  })
  if (handoffId === undefined
    || !Number.isSafeInteger(parsed.value.revision)
    || parsed.value.revision !== expectedRevision
    || !['completed', 'partial', 'blocked'].includes(parsed.value.status)
    || !['pro', 'worker'].includes(parsed.value.recommendedOwner)
    || changedPaths === undefined
    || completedAcceptance === undefined
    || decisions === undefined
    || unverified === undefined
    || remainingGaps === undefined
    || blockers === undefined) {
    return error('APEX_HANDOFF_REPORT contains an invalid or unbounded field')
  }
  if (workItem !== undefined && handoffId !== workItem.id) {
    return error('APEX_HANDOFF_REPORT handoffId does not match the immutable work order')
  }
  if (workItem !== undefined) {
    const accepted = new Set(workItem.acceptance.map(item => item.id))
    if (completedAcceptance.some(id => !accepted.has(id))) {
      return error('APEX_HANDOFF_REPORT completedAcceptance contains an unknown acceptance id')
    }
    if (changedPaths.some(path => !workItemOwnsPath(workItem, path))) {
      return error('APEX_HANDOFF_REPORT changedPaths contains a path outside the write lease')
    }
    if (parsed.value.status === 'completed'
      && workItem.acceptance.some(item => !completedAcceptance.includes(item.id))) {
      return error('APEX_HANDOFF_REPORT status=completed requires every acceptance id')
    }
  }
  if (parsed.value.status === 'completed' && (remainingGaps.length > 0 || blockers.length > 0)) {
    return error('APEX_HANDOFF_REPORT status=completed cannot include remaining gaps or blockers')
  }
  if (parsed.value.status === 'blocked' && blockers.length === 0) {
    return error('APEX_HANDOFF_REPORT status=blocked requires at least one blocker')
  }
  return {
    ok: true,
    value: {
      handoffId,
      revision: parsed.value.revision,
      status: parsed.value.status,
      changedPaths,
      completedAcceptance,
      decisions,
      unverified,
      remainingGaps,
      blockers,
      recommendedOwner: parsed.value.recommendedOwner,
    },
  }
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
