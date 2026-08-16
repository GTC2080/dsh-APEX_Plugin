/**
 * Keep every human task on the official Minimal tool pair for its first model
 * request, then expose a small resident set and successful allowlisted unlocks.
 * Durable session events are the only phase state, so task changes, resume,
 * and compaction do not depend on process memory.
 */

export const name = 'apex-tool-gate'
export const inject = []

export const BOOTSTRAP_TOOLS = Object.freeze(['bash', 'str_replace_editor'])
export const RESIDENT_TOOLS = Object.freeze([
  ...BOOTSTRAP_TOOLS,
  'apex_state',
  'dev_tool_search',
])
export const UNLOCK_META_KIND = 'apex-dev-tool-search-v05'

const AUTO_CONTEXT_SOURCES = new Set(['agent-instructions', 'skill-catalog'])
const MAX_UNLOCKED_TOOLS = 20
const MAX_TOOL_NAME_CHARS = 128

/** A real user message starts a new anchored task; plugin messages do not. */
export function isTaskBoundary(event) {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}

function eventsAfterLastBoundary(events, resetOnCompaction) {
  let start = 0
  const queued = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn') {
      const spliceStart = event.data.start
      const removedCount = event.data.removedCount ?? 0
      const inserted = Array.isArray(event.data.inserted) ? event.data.inserted : []
      if (Number.isInteger(spliceStart)
        && spliceStart >= 0
        && spliceStart <= queued.length
        && Number.isInteger(removedCount)
        && removedCount >= 0) {
        const removed = queued.splice(
          spliceStart,
          removedCount,
          ...inserted.map((message) => message?.source?.kind === 'user'),
        )
        // Inbox claim precedes prompt assembly; user/message is appended only
        // after assembly, so this is the earliest durable re-anchor point.
        if (inserted.length === 0
          && event.data.outcome !== 'canceled'
          && removed.some(Boolean)) start = index + 1
      }
      continue
    }
    if ((resetOnCompaction && event.type === 'compaction/end') || isTaskBoundary(event)) {
      start = index + 1
    }
  }
  return events.slice(start)
}

/** Return durable events from the current human task, including earlier compaction epochs. */
export function currentTaskEvents(events = []) {
  return eventsAfterLastBoundary(events, false)
}

/** Return only durable events after the latest human-task or compaction boundary. */
export function currentEpochEvents(events = []) {
  return eventsAfterLastBoundary(events, true)
}

function unlockedTools(event) {
  if (event.type !== 'tool/result' || event.data?.meta?.kind !== UNLOCK_META_KIND) return []
  if (!Array.isArray(event.data.meta.unlockedTools)) return []
  return event.data.meta.unlockedTools
    .slice(0, MAX_UNLOCKED_TOOLS)
    .filter((value) => (
      typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_TOOL_NAME_CHARS
    ))
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

  const events = currentEpochEvents(session.events)
  const unlocked = new Set()
  let promoted = false
  for (const event of events) {
    if (event.type === 'tool/call' || event.type === 'assistant/message') promoted = true
    for (const toolName of unlockedTools(event)) unlocked.add(toolName)
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
