/** Discover and lease allowlisted Standard tools without exposing every schema. */

import {
  currentEpochEvents,
  UNLOCK_META_KIND,
} from './tool-gate.mjs'

export const name = 'apex-dev-tool-search'
export const inject = ['tools']

const MAX_RESULTS = 20
const MAX_QUERY_CHARS = 200
const MAX_REQUESTED_TOOLS = 1
const MAX_TOOL_NAME_CHARS = 128

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'one', 'or', 'the', 'this', 'to', 'use',
  'with',
])

const SEARCH_ALIASES = Object.freeze({
  apex_build: [
    'code', 'collaborator', 'delegate', 'implement', 'implementation', 'programming', 'worker',
  ],
  apex_inspect_image: ['image', 'read_image', 'reference', 'screenshot', 'visual'],
  apex_research: ['api', 'documentation', 'evidence', 'research', 'source'],
  apex_state: ['checkpoint', 'compaction', 'invariant', 'state'],
  apex_validate_web: ['browser', 'fps', 'html', 'interaction', 'runtime'],
})

export const CAPABILITY_DIRECTORY = [
  '- apex_research: retrieve primary-source evidence for one consequential external fact and return constraints for Pro judgment.',
  '- apex_build: lease one untouched bounded implementation scope through a versioned handoff; Vision Flash Production is the default for isolated single-file or mechanical work, while Pro Core is reserved for genuinely difficult algorithms or tightly coupled integration.',
  '- apex_validate_web: validate an existing HTML artifact with a host-bounded, already-installed browser; do not probe application paths or install one.',
  '- apex_inspect_image: answer one focused visual evidence gap; identical evidence is cached, while changed evidence remains inspectable.',
  '- apex_state: preserve task invariants and evidence only across genuinely multi-step work or compaction.',
].join('\n')

export const UNLOCKABLE_TOOL_NAMES = Object.freeze([
  'apex_build',
  'apex_inspect_image',
  'apex_research',
  'apex_state',
  'apex_validate_web',
  'ask_user_question',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'job_kill',
  'job_list',
  'job_output',
  'read',
  'skill',
  'todo_write',
  'update_goal',
  'web_search',
  'write',
])

const UNLOCKABLE = new Set(UNLOCKABLE_TOOL_NAMES)

function requestedNames(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_TOOL_NAME_CHARS)
    .slice(0, MAX_REQUESTED_TOOLS))]
}

function firstLine(value) {
  return (typeof value === 'string' ? value : '').split('\n', 1)[0].slice(0, 120)
}

function previousDiscovery(agent) {
  const matches = new Set()
  const unlocked = new Set()
  for (const event of currentEpochEvents(agent?.session?.events)) {
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) continue
    const matchedTools = event.data.meta.matchedTools
    if (Array.isArray(matchedTools)) {
      for (const toolName of matchedTools) {
        if (typeof toolName === 'string' && UNLOCKABLE.has(toolName)) matches.add(toolName)
      }
    }
    const unlockedTools = event.data.meta.unlockedTools
    if (Array.isArray(unlockedTools)) {
      for (const toolName of unlockedTools) {
        if (typeof toolName === 'string' && UNLOCKABLE.has(toolName)) unlocked.add(toolName)
      }
    }
  }
  return { matches, unlocked }
}

function normalizedSearchToken(value) {
  if (value.length > 5 && value.endsWith('ly')) return value.slice(0, -2)
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

function searchTokens(value) {
  return new Set(value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizedSearchToken)
    .filter(token => token.length >= 2 && !SEARCH_STOP_WORDS.has(token)))
}

function isExplicitChineseBuildDelegation(query) {
  const hasCodingActor = [
    '编程协作者', '代码协作者', '开发协作者',
    '编程子代理', '编码子代理', '开发子代理',
    '编程工作者', '编码工作者', '开发工作者',
  ].some(term => query.includes(term))
  const hasDelegationAction = ['交给', '委派', '让', '负责', '实现', '编写']
    .some(term => query.includes(term))
  const asksForResearch = ['查找', '搜索', '调研', '研究', '文档', '资料', '证据']
    .some(term => query.includes(term))
  return hasCodingActor && hasDelegationAction && !asksForResearch
}

function matchingSchemas(schemas, query) {
  const normalizedQuery = query.trim().toLowerCase()
  const exact = schemas.find(schema => schema.name.toLowerCase() === normalizedQuery)
  if (exact !== undefined) return [exact]

  if (isExplicitChineseBuildDelegation(normalizedQuery)) {
    const build = schemas.find(schema => schema.name === 'apex_build')
    if (build !== undefined) return [build]
  }

  const tokens = searchTokens(query)
  if (tokens.size === 0) return []
  const ranked = schemas
    .map((schema) => {
      const nameTokens = searchTokens(schema.name)
      const descriptionTokens = searchTokens(schema.description ?? '')
      const aliases = new Set((SEARCH_ALIASES[schema.name] ?? [])
        .flatMap(alias => [...searchTokens(alias)]))
      let score = 0
      for (const token of tokens) {
        if (nameTokens.has(token)) score += 4
        if (aliases.has(token)) score += 3
        if (descriptionTokens.has(token)) score += 1
      }
      return { schema, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.schema.name.localeCompare(right.schema.name))
  const highest = ranked[0]?.score
  return ranked
    .filter(entry => entry.score === highest)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.schema)
}

/** Register the single resident discovery tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Discover one optional tool only after the task exposes a concrete capability gap.',
      'Compact APEX capability index:',
      CAPABILITY_DIRECTORY,
      'Worker lifecycle tools apex_wait, apex_continue, and apex_takeover are state-gated and appear automatically; do not search for them.',
      'Use one concise gap or one exact returned name. A unique match unlocks immediately; an ambiguous result may be submitted once by exact name.',
      'Prefer apex_research for multi-source or unfamiliar-domain retrieval and direct web_search for one known canonical source or focused conflict.',
      'Do not use research for path discovery, local inspection, or routine debugging. Do not repeat a query whose capability was already exposed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: MAX_QUERY_CHARS,
          description: 'A concise capability description or one exact tool name returned by an earlier search.',
        },
        toolNames: {
          type: 'array',
          maxItems: MAX_REQUESTED_TOOLS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TOOL_NAME_CHARS,
          },
          description: 'One exact allowlisted name returned by an earlier search in this task.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          matchedTools: { type: 'array', items: { type: 'string' } },
          unlockedTools: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'matchedTools', 'unlockedTools'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: UNLOCK_META_KIND,
        matchedTools: value.matchedTools,
        unlockedTools: value.unlockedTools,
      }),
    },
    async execute(args, exec) {
      const schemas = ctx.tools.schemas(exec.agent)
      const unlockableSchemas = schemas.filter((schema) => (
        UNLOCKABLE.has(schema.name)
      ))
      const byName = new Map(unlockableSchemas.map((schema) => [schema.name, schema]))
      const requested = requestedNames(args.toolNames)
      const { matches: discovered, unlocked } = previousDiscovery(exec.agent)
      const disallowed = requested.filter((toolName) => !UNLOCKABLE.has(toolName))
      const unavailable = requested.filter((toolName) => (
        UNLOCKABLE.has(toolName)
        && !byName.has(toolName)
      ))
      const notDiscovered = requested.filter((toolName) => byName.has(toolName) && !discovered.has(toolName))
      const alreadyUnlocked = requested.filter((toolName) => byName.has(toolName) && unlocked.has(toolName))
      const accepted = requested.filter((toolName) => (
        byName.has(toolName) && discovered.has(toolName) && !unlocked.has(toolName)
      ))
      const query = typeof args.query === 'string'
        ? args.query.trim().slice(0, MAX_QUERY_CHARS)
        : ''
      const lexicalMatches = query.length > 0 ? matchingSchemas(unlockableSchemas, query) : []
      const catalogFallback = query.length > 0 && lexicalMatches.length === 0
      const matches = catalogFallback
        ? [...unlockableSchemas]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_RESULTS)
        : lexicalMatches
      const uniqueMatch = !catalogFallback && matches.length === 1 ? matches[0] : undefined
      const uniqueAlreadyUnlocked = uniqueMatch !== undefined && unlocked.has(uniqueMatch.name)
      const autoUnlocked = accepted.length > 0 || uniqueMatch === undefined || uniqueAlreadyUnlocked
        ? []
        : [uniqueMatch.name]
      const alreadyAvailable = [...new Set([
        ...alreadyUnlocked,
        ...(uniqueAlreadyUnlocked ? [uniqueMatch.name] : []),
      ])]

      const lines = []
      if (alreadyAvailable.length > 0) {
        lines.push(`Already available in this task: ${alreadyAvailable.join(', ')}. Call it directly; use dev_tool_search only for a different capability gap.`)
      }
      if (accepted.length > 0) {
        lines.push(`Unlocked for the next request: ${accepted.join(', ')}`)
        lines.push(`Use ${accepted.join(', ')} in the next request; do not call dev_tool_search again for this capability.`)
      }
      if (disallowed.length > 0) lines.push(`Not permitted by the APEX allowlist: ${disallowed.join(', ')}`)
      if (unavailable.length > 0) lines.push(`Allowlisted but unavailable tools: ${unavailable.join(', ')}`)
      if (notDiscovered.length > 0) {
        lines.push(`Search before unlocking in this task: ${notDiscovered.join(', ')}`)
      }

      if (query.length > 0) {
        if (catalogFallback && matches.length === 0) {
          lines.push('No allowlisted optional tools are available.')
        } else {
          lines.push(catalogFallback
            ? `No lexical match for "${query}"; showing bounded optional tool catalog (${matches.length}):`
            : `Matching tools (${matches.length}):`)
          for (const schema of matches) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
          if (autoUnlocked.length > 0) {
            lines.push(`Unlocked for the next request: ${autoUnlocked[0]}`)
            lines.push(`Use ${autoUnlocked[0]} in the next request; do not call dev_tool_search again for this capability.`)
          } else if (accepted.length === 0 && alreadyAvailable.length === 0) {
            lines.push('Call dev_tool_search again with toolNames containing one exact name above.')
          }
        }
      }

      if (lines.length === 0) lines.push('Provide query to search or one previously discovered toolName to unlock.')
      return {
        text: lines.join('\n'),
        matchedTools: matches.map((schema) => schema.name),
        unlockedTools: [...new Set([...accepted, ...autoUnlocked])],
      }
    },
  })
}
