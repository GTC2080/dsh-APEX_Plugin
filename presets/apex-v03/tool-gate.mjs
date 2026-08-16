/**
 * Keep each top-level session on the official Minimal tool pair for its first
 * model request, then expose a small resident set and tools explicitly
 * requested through dev_tool_search. Durable session events are the only
 * phase state, so resume and compaction do not depend on process memory.
 */

export const name = 'apex-tool-gate'
export const inject = []

export const BOOTSTRAP_TOOLS = Object.freeze(['bash', 'str_replace_editor'])
export const RESIDENT_TOOLS = Object.freeze([...BOOTSTRAP_TOOLS, 'dev_tool_search'])

const AUTO_CONTEXT_SOURCES = new Set(['agent-instructions', 'skill-catalog'])
const TOOL_SEARCH_NAME = 'dev_tool_search'
const MAX_REQUESTED_TOOLS = 20
const MAX_TOOL_NAME_CHARS = 128

function requestedTools(event) {
  if (event.type !== 'tool/call' || event.data?.name !== TOOL_SEARCH_NAME) return []
  if (typeof event.data.arguments !== 'string') return []
  try {
    const args = JSON.parse(event.data.arguments)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
    if (!Array.isArray(args.toolNames)) return []
    return args.toolNames
      .slice(0, MAX_REQUESTED_TOOLS)
      .filter((value) => (
        typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_TOOL_NAME_CHARS
      ))
  } catch {
    return []
  }
}

/**
 * Derive the current phase from one session's durable log.
 *
 * ponytail: the O(n) scan keeps resume and compaction correct without a second
 * state store; add an incremental cache only if real session logs make prompt
 * assembly measurably slow.
 */
export function phaseFor(agent) {
  const session = agent?.session
  if (session === undefined) return { kind: 'full', promoted: true, unlocked: new Set() }
  if ((session.header?.delegationDepth ?? 0) > 0) {
    return { kind: 'full', promoted: true, unlocked: new Set() }
  }

  let promoted = false
  const unlocked = new Set()
  for (const event of session.events ?? []) {
    if (event.type === 'compaction/end') {
      promoted = false
      unlocked.clear()
      continue
    }
    if (event.type === 'tool/call' || event.type === 'assistant/message') promoted = true
    for (const toolName of requestedTools(event)) unlocked.add(toolName)
  }
  return { kind: 'controlled', promoted, unlocked }
}

function filterMessages(decision, phase) {
  if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  const kept = decision.messages.filter((message) => {
    const source = message?.source?.kind
    if (!AUTO_CONTEXT_SOURCES.has(source)) return true
    if (!phase.promoted) return false
    return source !== 'skill-catalog' || phase.unlocked.has('skill')
  })
  return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
}

/** Register the request-time tool and automatic-context filters. */
export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const phase = phaseFor(context.agent)
    if (phase.kind === 'full') return assembled

    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = BOOTSTRAP_TOOLS.filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      throw new Error(`${name}: missing required Minimal tool(s): ${missing.join(', ')}`)
    }

    const keep = new Set(phase.promoted ? RESIDENT_TOOLS : BOOTSTRAP_TOOLS)
    if (phase.promoted) {
      for (const toolName of phase.unlocked) {
        if (available.has(toolName)) keep.add(toolName)
      }
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    return filterMessages(decision, phaseFor(agent))
  }, { prepend: true })
}
