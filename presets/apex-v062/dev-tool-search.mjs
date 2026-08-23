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

export const CAPABILITY_DIRECTORY = [
  '- web_search: resolve one consequential API, algorithm, or domain fact that local evidence cannot establish; prefer primary sources and convert the result into an implementation constraint or test.',
  '- apex_build: delegate one genuinely independent, untouched code module to a bounded Flash worker.',
  '- apex_validate_web: run bounded browser validation after an HTML artifact exists; it appears automatically after a successful HTML write.',
  '- apex_inspect_image: inspect a reference image or the latest host-captured screenshot with Flash Vision.',
  '- apex_state: preserve multi-step invariants and evidence across compaction.',
  '- read, glob, grep, read_image, edit, write, skill, ask_user_question, create_goal, get_goal, update_goal, todo_write, job_list, job_output, job_kill, and exit_plan_mode: unlock only for the matching concrete gap.',
].join('\n')

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
      'Search optional tools only after the current task exposes a concrete capability gap.',
      'Compact capability index (search one exact name only when its condition exists):',
      CAPABILITY_DIRECTORY,
      'Worker lifecycle tools apex_wait, apex_continue, and apex_takeover are state-gated and appear automatically; do not search for them.',
      'Describe the missing capability with one concise query. A unique match unlocks immediately; ambiguous results require one exact returned name.',
      'If lexical matching finds nothing, inspect the bounded catalog and submit one exact returned name.',
      'When a consequential domain decision cannot be derived from Workspace evidence or checked invariants, state one missing fact, discover on-demand research, prefer primary sources, and turn the finding into an implementation constraint or test.',
      'Do not research ordinary path discovery, local code inspection, or routine debugging.',
      'Before locating or installing browser automation, DOM/canvas emulation, research, or collaborators, search here because an equivalent host tool may already be available.',
      'Use the first suitable result; do not repeat a catalog query that already exposed the required capability.',
      'Do not browse the catalog speculatively when the resident shell and editor already cover the task.',
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
      const discovered = previousMatches(exec.agent)
      const disallowed = requested.filter((toolName) => !UNLOCKABLE.has(toolName))
      const unavailable = requested.filter((toolName) => (
        UNLOCKABLE.has(toolName)
        && !byName.has(toolName)
      ))
      const notDiscovered = requested.filter((toolName) => byName.has(toolName) && !discovered.has(toolName))
      const accepted = requested.filter((toolName) => byName.has(toolName) && discovered.has(toolName))
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
      const autoUnlocked = accepted.length > 0 || uniqueMatch === undefined ? [] : [uniqueMatch.name]

      const lines = []
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
          } else if (accepted.length === 0) {
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
