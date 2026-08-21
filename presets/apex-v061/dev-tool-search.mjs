/** Discover and lease allowlisted Standard tools without exposing every schema. */

import {
  currentEpochEvents,
  currentTaskEvents,
  UNLOCK_META_KIND,
} from './tool-gate.mjs'
import { BASE_WEB_SEARCH_CALLS } from './execution-guard.mjs'

export const name = 'apex-dev-tool-search'
export const inject = ['tools']

const MAX_RESULTS = 20
const MAX_QUERY_CHARS = 200
const MAX_REQUESTED_TOOLS = 1
const MAX_TOOL_NAME_CHARS = 128
const MAX_RESEARCH_GAP_CHARS = 240

export const UNLOCKABLE_TOOL_NAMES = Object.freeze([
  'apex_build',
  'apex_inspect_image',
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
  'read_image',
  'skill',
  'todo_write',
  'update_goal',
  'web_search',
  'write',
])

const UNLOCKABLE = new Set(UNLOCKABLE_TOOL_NAMES)

const CAPABILITY_INDEX = [
  'apex_build — Flash code worker for an independent bounded module selected by Pro',
  'apex_inspect_image — read-only V4 Flash Vision review of workspace images',
  'apex_state — durable state for work likely to cross compaction',
  'apex_validate_web — bounded host validation after a static Web artifact exists',
  'read / write / edit / read_image / glob / grep — sandboxed filesystem work',
  'web_search — internet research',
  'skill — load an available workflow skill',
  'create_goal / get_goal / update_goal — long-running goals',
  'job_list / job_output / job_kill — background jobs',
  'todo_write / ask_user_question — task and user interaction',
].join('\n- ')

function requestedNames(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_TOOL_NAME_CHARS)
    .slice(0, MAX_REQUESTED_TOOLS))]
}

function firstLine(value) {
  return (typeof value === 'string' ? value : '').split('\n', 1)[0].slice(0, 120)
}

function previousMatches(agent) {
  const matches = new Set()
  for (const event of currentEpochEvents(agent?.session?.events)) {
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) continue
    const matchedTools = event.data.meta.matchedTools
    if (!Array.isArray(matchedTools)) continue
    for (const toolName of matchedTools) {
      if (typeof toolName === 'string' && UNLOCKABLE.has(toolName)) matches.add(toolName)
    }
  }
  return matches
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

function normalizedWebQuery(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : ''
}

function webSearchQueries(agent) {
  const queries = new Set()
  for (const event of currentTaskEvents(agent?.session?.events)) {
    if (event.type !== 'tool/call' || event.data?.name !== 'web_search') continue
    const query = normalizedWebQuery(parsedArguments(event).query)
    if (query.length > 0) queries.add(query)
  }
  return queries
}

function previousApprovedWebQueries(agent) {
  const queries = new Set()
  for (const event of currentTaskEvents(agent?.session?.events)) {
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) continue
    const values = event.data.meta.approvedWebQueries
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const query = normalizedWebQuery(value)
      if (query.length > 0 && query.length <= MAX_QUERY_CHARS) queries.add(query)
    }
  }
  return queries
}

function matchingSchemas(schemas, query) {
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))]
  if (tokens.length === 0) return []
  return schemas
    .map((schema) => {
      const haystack = `${schema.name} ${schema.description ?? ''}`.toLowerCase()
      return { schema, score: tokens.filter((token) => haystack.includes(token)).length }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.schema.name.localeCompare(right.schema.name))
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.schema)
}

/** Register the single resident discovery tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Unlock one optional capability when it would reduce manual shell work, orchestration, research, or validation.',
      'An exact capability name unlocks it in this call; a broader query only lists matches for a later exact toolNames call.',
      `- ${CAPABILITY_INDEX}`,
      `A task starts with ${BASE_WEB_SEARCH_CALLS} direct web_search calls. For each additional distinct query, provide researchGap and nextWebQuery; only one unused lease can exist at a time.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: MAX_QUERY_CHARS,
          description: 'An exact capability such as "apex_build" or "apex_validate_web", or broader search keywords.',
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
        researchGap: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RESEARCH_GAP_CHARS,
          description: 'The exact required fact not supported by evidence collected so far.',
        },
        nextWebQuery: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_QUERY_CHARS,
          description: 'One distinct next web_search query that directly targets researchGap.',
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
          approvedWebQueries: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'matchedTools', 'unlockedTools', 'approvedWebQueries'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: UNLOCK_META_KIND,
        matchedTools: value.matchedTools,
        unlockedTools: value.unlockedTools,
        approvedWebQueries: value.approvedWebQueries,
      }),
    },
    async execute(args, exec) {
      const schemas = ctx.tools.schemas(exec.agent)
      const unlockableSchemas = schemas.filter((schema) => (
        UNLOCKABLE.has(schema.name)
      ))
      const byName = new Map(unlockableSchemas.map((schema) => [schema.name, schema]))
      const researchGap = typeof args.researchGap === 'string'
        ? args.researchGap.trim().slice(0, MAX_RESEARCH_GAP_CHARS)
        : ''
      const nextWebQuery = typeof args.nextWebQuery === 'string'
        ? args.nextWebQuery.trim().slice(0, MAX_QUERY_CHARS)
        : ''
      const extensionRequested = researchGap.length > 0 || nextWebQuery.length > 0
      const requested = extensionRequested ? [] : requestedNames(args.toolNames)
      const discovered = previousMatches(exec.agent)
      const disallowed = requested.filter((toolName) => !UNLOCKABLE.has(toolName))
      const unavailable = requested.filter((toolName) => (
        UNLOCKABLE.has(toolName)
        && !byName.has(toolName)
      ))
      const notDiscovered = requested.filter((toolName) => byName.has(toolName) && !discovered.has(toolName))
      const accepted = requested.filter((toolName) => byName.has(toolName) && discovered.has(toolName))
      const query = !extensionRequested && typeof args.query === 'string'
        ? args.query.trim().slice(0, MAX_QUERY_CHARS)
        : ''
      const matches = query.length > 0 ? matchingSchemas(unlockableSchemas, query) : []
      const exactMatch = matches.find(schema => schema.name.toLowerCase() === query.toLowerCase())
      const autoUnlocked = exactMatch === undefined ? [] : [exactMatch.name]
      const approvedWebQueries = []

      const lines = []
      if (extensionRequested) {
        if (typeof args.query === 'string' || Array.isArray(args.toolNames)) {
          lines.push('Research continuation is separate from catalog search and tool unlock; catalog fields were ignored.')
        }
        const used = webSearchQueries(exec.agent)
        const previouslyApproved = previousApprovedWebQueries(exec.agent)
        const unused = [...previouslyApproved].filter((approved) => !used.has(approved))
        const normalizedNext = normalizedWebQuery(nextWebQuery)
        if (researchGap.length === 0 || normalizedNext.length === 0) {
          lines.push('Provide both researchGap and nextWebQuery to request one continuation.')
        } else if (used.size < BASE_WEB_SEARCH_CALLS) {
          lines.push(`Use the ${BASE_WEB_SEARCH_CALLS} default web_search calls before requesting a continuation.`)
        } else if (unused.length > 0) {
          lines.push('Use the previously approved web_search query before requesting another continuation.')
        } else if (used.has(normalizedNext) || previouslyApproved.has(normalizedNext)) {
          lines.push('nextWebQuery must be distinct from every used or previously approved query in this task.')
        } else {
          approvedWebQueries.push(nextWebQuery)
          lines.push(`Approved one additional web_search query for this task: ${nextWebQuery}`)
          lines.push(`Research gap: ${researchGap}`)
        }
      }
      if (accepted.length > 0) lines.push(`Unlocked for the next request: ${accepted.join(', ')}`)
      if (disallowed.length > 0) lines.push(`Not permitted by the APEX allowlist: ${disallowed.join(', ')}`)
      if (unavailable.length > 0) lines.push(`Allowlisted but unavailable tools: ${unavailable.join(', ')}`)
      if (notDiscovered.length > 0) {
        lines.push(`Search before unlocking in this task: ${notDiscovered.join(', ')}`)
      }

      if (query.length > 0) {
        if (matches.length === 0) {
          lines.push(`No allowlisted tools match "${query}".`)
        } else {
          lines.push(`Matching tools (${matches.length}):`)
          for (const schema of matches) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
          if (autoUnlocked.length > 0) lines.push(`Unlocked for the next request: ${autoUnlocked[0]}`)
          else lines.push('Call dev_tool_search again with toolNames containing one exact name above.')
        }
      }

      if (lines.length === 0) lines.push('Provide query to search or one previously discovered toolName to unlock.')
      return {
        text: lines.join('\n'),
        matchedTools: matches.map((schema) => schema.name),
        unlockedTools: [...new Set([...accepted, ...autoUnlocked])],
        approvedWebQueries,
      }
    },
  })
}
