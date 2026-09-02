/** Verify explicit, machine-checkable final-delivery constraints in the workspace. */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { posix, resolve } from 'node:path'

import { artifactSnapshot } from './apex-evidence.mjs'
import {
  DELIVERY_META_KIND,
  phaseFor,
  sessionEvidenceEvents,
  successfulImplementationMutationPaths,
} from './tool-gate.mjs'
import {
  isWorkspaceRootPath,
  workspacePath,
} from './workspace-boundary.mjs'

export const name = 'apex-delivery-v063'
export const inject = ['tools']
export { DELIVERY_META_KIND }

const MAX_EXACT_FILES = 64
const MAX_FILE_COUNT_CHECKS = 2
const MAX_TEXT_CHECKS = 8
const MAX_REQUIRED_LITERALS = 8
const MAX_PATH_CHARS = 512
const MAX_LITERAL_CHARS = 240
const MAX_CHARACTER_LIMIT = 5_000_000
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_TOTAL_BYTES = 8 * 1024 * 1024

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizedRelativeFile(value) {
  if (typeof value !== 'string') return undefined
  const portable = value.trim().replaceAll('\\', '/')
  if (portable.length === 0
    || portable.length > MAX_PATH_CHARS
    || portable.includes('\0')
    || portable.startsWith('/')
    || /^[a-z]:\//i.test(portable)) return undefined
  const normalizedValue = posix.normalize(portable)
  const normalized = normalizedValue === './' ? '.' : normalizedValue
  return normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    ? undefined
    : normalized
}

function normalizedRoot(value, agent) {
  if (typeof value !== 'string') return undefined
  const portable = value.trim().replaceAll('\\', '/')
  if (portable.length === 0
    || portable.length > MAX_PATH_CHARS
    || portable.includes('\0')) return undefined
  if (portable.startsWith('/') || /^[a-z]:\//i.test(portable)) {
    return agent !== undefined && isWorkspaceRootPath(agent, value) ? '.' : undefined
  }
  const normalizedValue = posix.normalize(portable)
  const normalized = normalizedValue === './' ? '.' : normalizedValue
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized
}

function normalizedExactFiles(value) {
  if (!Array.isArray(value) || value.length > MAX_EXACT_FILES) return undefined
  const files = value.map(normalizedRelativeFile)
  if (files.some(file => file === undefined) || new Set(files).size !== files.length) return undefined
  return files.sort()
}

function normalizedFileCountChecks(value) {
  if (!Array.isArray(value) || value.length > MAX_FILE_COUNT_CHECKS) return undefined
  const checks = []
  const relations = new Set()
  for (const item of value) {
    if (item === null
      || typeof item !== 'object'
      || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'count,relation'
      || !['at-least', 'at-most', 'exactly'].includes(item.relation)
      || relations.has(item.relation)
      || !Number.isInteger(item.count)
      || item.count < 0
      || item.count > 8_192) return undefined
    relations.add(item.relation)
    checks.push({ relation: item.relation, count: item.count })
  }
  return checks.sort((left, right) => left.relation.localeCompare(right.relation))
}

function normalizedMaximumChecks(value) {
  if (!Array.isArray(value) || value.length > MAX_TEXT_CHECKS) return undefined
  const checks = []
  const paths = new Set()
  for (const item of value) {
    if (item === null
      || typeof item !== 'object'
      || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'maximum,path') return undefined
    const path = normalizedRelativeFile(item.path)
    if (path === undefined
      || paths.has(path)
      || !Number.isInteger(item.maximum)
      || item.maximum < 0
      || item.maximum > MAX_CHARACTER_LIMIT) return undefined
    paths.add(path)
    checks.push({ path, maximum: item.maximum })
  }
  return checks.sort((left, right) => left.path.localeCompare(right.path))
}

function normalizedLiteralChecks(value) {
  if (!Array.isArray(value) || value.length > MAX_TEXT_CHECKS) return undefined
  const checks = []
  const paths = new Set()
  for (const item of value) {
    if (item === null
      || typeof item !== 'object'
      || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'literals,path') return undefined
    const path = normalizedRelativeFile(item.path)
    if (path === undefined
      || paths.has(path)
      || !Array.isArray(item.literals)
      || item.literals.length === 0
      || item.literals.length > MAX_REQUIRED_LITERALS) return undefined
    const literals = item.literals.map(value => (
      typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_LITERAL_CHARS
        ? value
        : undefined
    ))
    if (literals.some(literal => literal === undefined)
      || new Set(literals).size !== literals.length) return undefined
    paths.add(path)
    checks.push({ path, literals: literals.sort() })
  }
  return checks.sort((left, right) => left.path.localeCompare(right.path))
}

/** Normalize one caller-supplied contract without inferring unstated requirements. */
export function normalizeDeliveryContract(value, agent) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).sort().join(',') !== [
    'content_unconstrained_files',
    'exact_files',
    'file_count_checks',
    'max_character_checks',
    'required_literal_checks',
    'root',
  ].join(',')) return undefined
  const root = normalizedRoot(value.root, agent)
  const exactFiles = normalizedExactFiles(value.exact_files)
  const contentUnconstrainedFiles = normalizedExactFiles(value.content_unconstrained_files)
  const fileCountChecks = normalizedFileCountChecks(value.file_count_checks)
  const maximumChecks = normalizedMaximumChecks(value.max_character_checks)
  const literalChecks = normalizedLiteralChecks(value.required_literal_checks)
  if (root === undefined
    || exactFiles === undefined
    || contentUnconstrainedFiles === undefined
    || fileCountChecks === undefined
    || maximumChecks === undefined
    || literalChecks === undefined) return undefined
  if (exactFiles.length === 0
    && fileCountChecks.length === 0
    && maximumChecks.length === 0
    && literalChecks.length === 0) {
    throw new Error('apex_verify_delivery requires at least one explicit check')
  }
  const exactSet = new Set(exactFiles)
  const constrained = new Set([
    ...maximumChecks.map(check => check.path),
    ...literalChecks.map(check => check.path),
  ])
  const unconstrained = new Set(contentUnconstrainedFiles)
  if (contentUnconstrainedFiles.some(path => constrained.has(path))) {
    throw new Error('apex_verify_delivery content_unconstrained_files cannot overlap text checks')
  }
  if (exactFiles.length === 0) {
    if (contentUnconstrainedFiles.length > 0) {
      throw new Error('apex_verify_delivery content_unconstrained_files requires a complete exact_files set')
    }
  } else if ([...constrained, ...unconstrained].some(path => !exactSet.has(path))
    || exactFiles.some(path => !constrained.has(path) && !unconstrained.has(path))) {
    throw new Error('apex_verify_delivery requires every exact_files path to be covered by a text check or content_unconstrained_files')
  }
  return {
    root,
    exactFiles,
    contentUnconstrainedFiles,
    fileCountChecks,
    maximumChecks,
    literalChecks,
  }
}

function displayPaths(paths) {
  const shown = paths.slice(0, 12).map(path => JSON.stringify(path)).join(', ')
  return paths.length <= 12 ? shown : `${shown}, ... (+${paths.length - 12})`
}

function previousEvidence(agent, contractHash, artifactHash) {
  return sessionEvidenceEvents(agent?.session?.events).findLast(event => (
    event.type === 'tool/result'
    && event.data?.meta?.kind === DELIVERY_META_KIND
    && event.data.meta.contractHash === contractHash
    && event.data.meta.artifactHash === artifactHash
  ))
}

function exactFileCheck(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter(path => !actualSet.has(path))
  const unexpected = actual.filter(path => !expectedSet.has(path))
  const details = []
  if (missing.length > 0) details.push(`missing: ${displayPaths(missing)}`)
  if (unexpected.length > 0) details.push(`unexpected: ${displayPaths(unexpected)}`)
  return {
    id: 'exact-files',
    kind: 'exact-files',
    path: '.',
    passed: missing.length === 0 && unexpected.length === 0,
    expected: `${expected.length} exact file(s): ${displayPaths(expected)}`,
    actual: details.length === 0 ? `${actual.length} exact file(s)` : details.join('; '),
  }
}

function taskBoundaryTime(agent) {
  const event = sessionEvidenceEvents(agent?.session?.events).findLast(item => (
    item.type === 'user/message'
    && item.data?.source?.kind === 'user'
    && Number.isFinite(item.time)
  ))
  return event?.time
}

function mutationCoversFile(scope, path) {
  if (scope === path) return true
  return scope.endsWith('/**') && path.startsWith(`${scope.slice(0, -3)}/`)
}

/** Keep task-start inputs outside delivery-set checks unless this task changed them. */
async function deliveryFiles(agent, contract, snapshot) {
  const boundary = taskBoundaryTime(agent)
  const mutations = successfulImplementationMutationPaths(agent)
  if (boundary === undefined || mutations.unresolved) return snapshot.files.map(file => file.path).sort()
  const expected = new Set(contract.exactFiles)
  const rootPath = workspacePath(agent, contract.root)
  if (rootPath === undefined) return snapshot.files.map(file => file.path).sort()
  const prefix = contract.root === '.' ? '' : `${contract.root}/`
  const files = []
  for (const file of snapshot.files) {
    const workspaceRelative = `${prefix}${file.path}`
    if (expected.has(file.path)
      || mutations.paths.some(scope => mutationCoversFile(scope, workspaceRelative))) {
      files.push(file.path)
      continue
    }
    const info = await fs.stat(resolve(rootPath, ...file.path.split('/')))
    if (info.ctimeMs >= boundary) files.push(file.path)
  }
  return files.sort()
}

function fileCountCheck(check, actual) {
  const passed = check.relation === 'exactly'
    ? actual === check.count
    : check.relation === 'at-most'
      ? actual <= check.count
      : actual >= check.count
  return {
    id: `file-count-${check.relation}`,
    kind: 'file-count',
    path: '.',
    passed,
    expected: `${check.relation} ${check.count} file(s)`,
    actual: `${actual} file(s)`,
  }
}

function characterCount(value) {
  return Array.from(value.trim()).length
}

async function textReader(agent, root, snapshot) {
  const rootPath = workspacePath(agent, root)
  if (rootPath === undefined) throw new Error('root must resolve inside the current session workspace')
  const files = new Map(snapshot.files.map(file => [file.path, file]))
  const cache = new Map()
  let totalBytes = 0
  return async (path) => {
    if (!files.has(path)) return undefined
    if (cache.has(path)) return cache.get(path)
    const file = files.get(path)
    if (file.size > MAX_TEXT_FILE_BYTES || totalBytes + file.size > MAX_TEXT_TOTAL_BYTES) {
      throw new Error(`text delivery evidence exceeds its bounded read budget at ${path}`)
    }
    const absolute = workspacePath(agent, resolve(rootPath, ...path.split('/')))
    if (absolute === undefined) throw new Error(`text check path escapes the artifact root: ${path}`)
    totalBytes += file.size
    const text = await fs.readFile(absolute, 'utf8')
    cache.set(path, text)
    return text
  }
}

function resultText(result) {
  const lines = [
    `APEX delivery verification: ${result.status}${result.cached ? ' (unchanged evidence reused)' : ''}`,
    `Artifact: ${JSON.stringify(result.artifactRoot)}; ${result.fileCount} file(s); sha256 ${result.artifactHash}`,
  ]
  if (result.contentUnconstrainedFiles.length > 0) {
    lines.push(`Caller declared no supported character/literal constraint for: ${displayPaths(result.contentUnconstrainedFiles)}. This declaration does not prove that the user stated none.`)
  }
  for (const check of result.checks) {
    lines.push(`- ${check.passed ? 'PASS' : 'FAIL'} ${check.id}: expected ${check.expected}; actual ${check.actual}`)
  }
  lines.push(result.status === 'passed'
    ? 'All supplied explicit delivery constraints pass. Do not infer that this proves runtime, visual, or domain correctness.'
    : 'Repair every failed delivery check, then rerun the same contract after the artifact changes.')
  return lines.join('\n')
}

function outputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      status: { type: 'string', enum: ['passed', 'failed'] },
      cached: { type: 'boolean' },
      contractHash: { type: 'string' },
      artifactRoot: { type: 'string' },
      artifactHash: { type: 'string' },
      fileCount: { type: 'integer' },
      contentUnconstrainedFiles: { type: 'array', items: { type: 'string' } },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['exact-files', 'file-count', 'max-characters', 'required-literal'] },
            path: { type: 'string' },
            passed: { type: 'boolean' },
            expected: { type: 'string' },
            actual: { type: 'string' },
          },
          required: ['id', 'kind', 'path', 'passed', 'expected', 'actual'],
        },
      },
    },
    required: [
      'text',
      'status',
      'cached',
      'contractHash',
      'artifactRoot',
      'artifactHash',
      'fileCount',
      'contentUnconstrainedFiles',
      'checks',
    ],
  }
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'apex_verify_delivery',
    description: [
      'Verify only explicit, machine-checkable final-delivery constraints against the current workspace artifact.',
      'Call before reporting an inspection-only audit, and once before final delivery, when the user or project contract explicitly names a complete deliverable file set, file count, maximum text character count, or exact required wording.',
      'Copy every supported explicit constraint from every named deliverable, never a representative subset. Prefer this single bounded host check over reconstructing the same represented checks in Bash. Do not infer, translate, weaken, or invent constraints.',
      'Always provide all five arrays; use an empty array for a constraint class that was not explicitly stated. exact_files is the complete delivered root-relative file set, not merely files that should exist; untouched files already present when the human task began are inputs rather than unexpected deliverables. file_count_checks handles an explicit delivered-file count when names are not a complete set.',
      'When exact_files is non-empty, account for every file exactly once: put each path with a stated character maximum or exact wording in the corresponding text checks, and put only the remaining paths in content_unconstrained_files. Runtime or visual checks do not make an explicit wording constraint optional.',
      'Character counts use Unicode code points after trimming leading and trailing whitespace. Required literals are exact and case-sensitive. An explicitly stated page title, heading, label, or body message is required wording and belongs in required_literal_checks even when separate runtime or visual evidence is also needed.',
      'A failed result is repair evidence, not a tool error. Repair every failed item and rerun the identical complete contract only after the artifact changes. An unchanged contract and artifact reuses prior evidence.',
      'This bounded read-only check does not prove runtime behavior, visual quality, physical correctness, or unstated requirements.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: `Workspace-local artifact directory, normally ".". The exact absolute current workspace root is normalized to "."; every other absolute path is rejected. At most ${MAX_PATH_CHARS} characters.`,
        },
        exact_files: {
          type: 'array',
          items: { type: 'string' },
          description: `Complete root-relative final file set with at most ${MAX_EXACT_FILES} unique non-empty paths, or [] when no complete set was explicitly required.`,
        },
        content_unconstrained_files: {
          type: 'array',
          items: { type: 'string' },
          description: `Every exact_files path with no explicitly stated character maximum or exact required wording; at most ${MAX_EXACT_FILES} unique paths. Must not overlap text checks. Use [] when exact_files is empty or every exact file has a supported text constraint.`,
        },
        file_count_checks: {
          type: 'array',
          description: `At most ${MAX_FILE_COUNT_CHECKS} explicit count checks, or [] when no file count was stated.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              relation: { type: 'string', enum: ['exactly', 'at-most', 'at-least'] },
              count: { type: 'integer', description: 'File count from 0 through 8192.' },
            },
            required: ['relation', 'count'],
          },
        },
        max_character_checks: {
          type: 'array',
          description: `At most ${MAX_TEXT_CHECKS} unique path checks.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: `Non-empty root-relative path, at most ${MAX_PATH_CHARS} characters.` },
              maximum: { type: 'integer', description: `Inclusive character maximum from 0 through ${MAX_CHARACTER_LIMIT}.` },
            },
            required: ['path', 'maximum'],
          },
        },
        required_literal_checks: {
          type: 'array',
          description: `At most ${MAX_TEXT_CHECKS} unique path checks.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: `Non-empty root-relative path, at most ${MAX_PATH_CHARS} characters.` },
              literals: {
                type: 'array',
                description: `Between 1 and ${MAX_REQUIRED_LITERALS} unique, non-empty, case-sensitive strings; each at most ${MAX_LITERAL_CHARS} characters.`,
                items: { type: 'string' },
              },
            },
            required: ['path', 'literals'],
          },
        },
      },
      required: ['root', 'exact_files', 'content_unconstrained_files', 'file_count_checks', 'max_character_checks', 'required_literal_checks'],
    },
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: DELIVERY_META_KIND,
        contractHash: value.contractHash,
        artifactHash: value.artifactHash,
        artifactRoot: value.artifactRoot,
        status: value.status,
        failedCheckIds: value.checks.filter(check => !check.passed).map(check => check.id),
      }),
    },
    async execute(args, exec) {
      if (exec.agent?.session === undefined) throw new Error('apex_verify_delivery requires a calling parent agent')
      const phase = phaseFor(exec.agent)
      if (phase.workerPending || phase.workerAwaitingEvidence) {
        throw new Error('apex_verify_delivery requires every workspace worker to settle and report evidence first')
      }
      const contract = normalizeDeliveryContract(args, exec.agent)
      if (contract === undefined) {
        throw new Error('apex_verify_delivery requires root to be workspace-relative or the exact current workspace root, every file path to be a bounded workspace-relative file path, every explicit check to be well formed, and complete per-file content coverage')
      }
      const snapshot = await artifactSnapshot(exec.agent, contract.root)
      const contractHash = hashJson(contract)
      const checks = []
      const actualFiles = await deliveryFiles(exec.agent, contract, snapshot)
      if (contract.exactFiles.length > 0) {
        checks.push(exactFileCheck(contract.exactFiles, actualFiles))
      }
      for (const check of contract.fileCountChecks) {
        checks.push(fileCountCheck(check, actualFiles.length))
      }

      const readText = await textReader(exec.agent, contract.root, snapshot)
      for (const [index, check] of contract.maximumChecks.entries()) {
        const text = await readText(check.path)
        const count = text === undefined ? undefined : characterCount(text)
        checks.push({
          id: `max-characters-${index + 1}`,
          kind: 'max-characters',
          path: check.path,
          passed: count !== undefined && count <= check.maximum,
          expected: `at most ${check.maximum} Unicode code point(s) after outer whitespace trim`,
          actual: count === undefined ? 'file missing' : `${count} Unicode code point(s)`,
        })
      }
      for (const [checkIndex, check] of contract.literalChecks.entries()) {
        const text = await readText(check.path)
        for (const [literalIndex, literal] of check.literals.entries()) {
          const present = text !== undefined && text.includes(literal)
          checks.push({
            id: `required-literal-${checkIndex + 1}-${literalIndex + 1}`,
            kind: 'required-literal',
            path: check.path,
            passed: present,
            expected: `contains ${JSON.stringify(literal)}`,
            actual: text === undefined ? 'file missing' : present ? 'present' : 'missing',
          })
        }
      }

      const result = {
        text: '',
        status: checks.every(check => check.passed) ? 'passed' : 'failed',
        cached: previousEvidence(exec.agent, contractHash, snapshot.hash) !== undefined,
        contractHash,
        artifactRoot: snapshot.root,
        artifactHash: snapshot.hash,
        fileCount: actualFiles.length,
        contentUnconstrainedFiles: contract.contentUnconstrainedFiles,
        checks,
      }
      result.text = resultText(result)
      return result
    },
  })
}
