/** Discover and unlock Standard tools without placing their schemas in every request. */

export const name = 'minimal-max-dev-tool-search'
export const inject = ['tools']

const MAX_RESULTS = 20
const MAX_QUERY_CHARS = 200
const MAX_REQUESTED_TOOLS = 20
const MAX_TOOL_NAME_CHARS = 128

const CAPABILITY_INDEX = [
  'read / write / edit / glob / grep — sandboxed filesystem work',
  'web_search — internet research',
  'skill — load an available workflow skill',
  'create_goal / get_goal / update_goal — long-running goals',
  'subagent / subagent_fork — delegate work',
  'workflow / ralph — orchestrated multi-agent work',
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

/** Register the single resident discovery tool. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Search and unlock tools that are not in the current minimal catalog.',
      'Call this as soon as the task needs a capability below; do not emulate it with bash.',
      `- ${CAPABILITY_INDEX}`,
      'Use query to discover exact names and toolNames to unlock them. Accepted tools appear on the next model request and remain available until compaction.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: MAX_QUERY_CHARS,
          description: 'Keywords such as "web", "skill", or "subagent".',
        },
        toolNames: {
          type: 'array',
          maxItems: MAX_REQUESTED_TOOLS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TOOL_NAME_CHARS,
          },
          description: 'Exact tool names to unlock for the next request.',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const schemas = ctx.tools.schemas(exec.agent)
      const byName = new Map(schemas.map((schema) => [schema.name, schema]))
      const requested = requestedNames(args.toolNames)
      const accepted = requested.filter((toolName) => byName.has(toolName))
      const unknown = requested.filter((toolName) => !byName.has(toolName))
      const query = typeof args.query === 'string'
        ? args.query.trim().slice(0, MAX_QUERY_CHARS)
        : ''

      const lines = []
      if (accepted.length > 0) lines.push(`Unlocked for the next request: ${accepted.join(', ')}`)
      if (unknown.length > 0) lines.push(`Unknown or unavailable tool names: ${unknown.join(', ')}`)

      if (query.length > 0) {
        const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
        const matches = schemas
          .filter((schema) => {
            const haystack = `${schema.name} ${schema.description ?? ''}`.toLowerCase()
            return tokens.every((token) => haystack.includes(token))
          })
          .slice(0, MAX_RESULTS)
        if (matches.length === 0) {
          lines.push(`No tools match "${query}".`)
        } else {
          lines.push(`Matching tools (${matches.length}):`)
          for (const schema of matches) lines.push(`- ${schema.name}: ${firstLine(schema.description)}`)
          lines.push('Call dev_tool_search again with toolNames containing the exact names to unlock.')
        }
      }

      if (lines.length === 0) {
        lines.push('Provide query to search or toolNames to unlock tools.')
      }
      return lines.join('\n')
    },
  })
}
