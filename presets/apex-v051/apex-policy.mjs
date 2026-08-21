/** Inject APEX v0.5.1 guidance and expose its durable, task-scoped state tool. */

import { randomUUID } from 'node:crypto'

import { currentEpochEvents, currentTaskEvents, phaseFor } from './tool-gate.mjs'

export const name = 'apex-policy-v051'
export const inject = ['tools']

export const LEDGER_META_KIND = 'apex-task-ledger-v051'

const MAX_GOAL_CHARS = 480
const MAX_NEXT_CHARS = 320
const MAX_ITEM_CHARS = 400
const MAX_EVIDENCE_CHARS = 600
const MAX_VERIFIED_ITEMS = 12
const MAX_OPEN_ITEMS = 8
const MAX_EVIDENCE_ITEMS = 12

export const APEX_POLICY = `<apex version="0.5.1">
Fully satisfy the latest real user request while preserving its goal, acceptance criteria, verified facts, and unresolved gaps.
- Inspect enough of the existing project and call chain to act at the correct place. After the first local action, apex_state and dev_tool_search are resident; unlock only the capability required for the next concrete step.
- Keep simple tasks stateless. For work likely to cross compaction, checkpoint a complete Goal/Verified/Open/Next/Evidence snapshot after material progress, before a risky branch, or when blocked; change strategy after a stall warning.
- Use direct web_search for one exact fact. For multi-source or unfamiliar research, give apex_research a self-contained evidence brief, judge its sources and conflicts, and continue only for a distinct unresolved gap.
- Validate in proportion to risk, exercise the user-visible path, and report failures truthfully. Stop only processes whose exact PID this task recorded.
</apex>`

export const APEX_CHILD_POLICY = `<apex-subagent version="0.5.1">
Complete only the delegated scope. Use only the distinct searches needed, prefer primary sources, distinguish evidence from inference, and return a compact result with sources, conflicts, unresolved gaps, and the next best query when evidence is insufficient. Do not expand scope or delegate again.
</apex-subagent>`

const EMPTY_LEDGER = Object.freeze({
  goal: '',
  verified: Object.freeze([]),
  open: Object.freeze([]),
  next: '',
  evidence: Object.freeze([]),
})

function boundedText(value, maxChars) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= maxChars ? text : undefined
}

function boundedList(value, maxItems, maxChars) {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const result = []
  const seen = new Set()
  for (const item of value) {
    const text = boundedText(item, maxChars)
    if (text === undefined) return undefined
    if (!seen.has(text)) {
      seen.add(text)
      result.push(text)
    }
  }
  return result
}

/** Validate and bound a task-state snapshot loaded from model input or a session log. */
export function normalizeLedger(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const goal = boundedText(value.goal, MAX_GOAL_CHARS)
  const verified = boundedList(value.verified, MAX_VERIFIED_ITEMS, MAX_ITEM_CHARS)
  const open = boundedList(value.open, MAX_OPEN_ITEMS, MAX_ITEM_CHARS)
  const next = boundedText(value.next, MAX_NEXT_CHARS)
  const evidence = boundedList(value.evidence, MAX_EVIDENCE_ITEMS, MAX_EVIDENCE_CHARS)
  if (goal === undefined
    || verified === undefined
    || open === undefined
    || next === undefined
    || evidence === undefined) return undefined
  return { goal, verified, open, next, evidence }
}

function ledgerEvents(agent) {
  const result = []
  for (const event of currentTaskEvents(agent?.session?.events)) {
    if (event.type !== 'tool/result'
      || event.data?.meta?.kind !== LEDGER_META_KIND
      || event.data.meta.updated !== true) continue
    const ledger = normalizeLedger(event.data.meta.ledger)
    if (ledger !== undefined) result.push({ ledger, stalled: event.data.meta.stalled === true })
  }
  return result
}

/** Return the most recent valid state snapshot for the current human task. */
export function latestLedger(agent) {
  return ledgerEvents(agent).at(-1)?.ledger
}

function normalizedStep(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function gainedItem(first, last, key) {
  const before = new Set(first[key].map(normalizedStep))
  return last[key].some((item) => !before.has(normalizedStep(item)))
}

/** Detect three consecutive checkpoints that keep the same next step without new evidence. */
export function detectsStall(ledgers) {
  const recent = ledgers.slice(-3)
  if (recent.length < 3) return false
  const [first, middle, last] = recent
  const step = normalizedStep(first.next)
  const sameStep = normalizedStep(middle.next) === step && normalizedStep(last.next) === step
  // ponytail: this bounded heuristic catches repeated checkpoints without a
  // semantic classifier; replace it only if benchmark traces show systematic misses.
  return sameStep
    && !gainedItem(first, last, 'verified')
    && !gainedItem(first, last, 'evidence')
    && last.open.length >= first.open.length
}

function safeStateJson(ledger) {
  return JSON.stringify(ledger, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}

/** Build the post-anchor instruction, including the latest state after compaction. */
export function policyText(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return APEX_CHILD_POLICY
  const latest = ledgerEvents(agent).at(-1)
  if (latest === undefined) return APEX_POLICY
  const warning = latest.stalled
    ? '\nThe last checkpoint was stalled. Change strategy before repeating the recorded Next action.'
    : ''
  return `${APEX_POLICY}\n<apex-task-state data-only="true">\n${safeStateJson(latest.ledger)}${warning}\n</apex-task-state>`
}

function isPolicyMessage(message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === name
}

function isCurrentPolicyText(text) {
  return typeof text === 'string'
    && (text.startsWith('<apex version="0.5.1">') || text.startsWith('<apex-subagent version="0.5.1">'))
}

function policyMessageIdsInCurrentEpoch(events = []) {
  const ids = new Set()
  for (const event of currentEpochEvents(events)) {
    if (event.type === 'user/message'
      && isPolicyMessage(event.data)
      && Array.isArray(event.data.content)
      && event.data.content.some((block) => block?.type === 'text' && isCurrentPolicyText(block.text))
      && typeof event.data.id === 'string') ids.add(event.data.id)
  }
  return ids
}

function filterStalePolicyMessages(decision, allowedIds) {
  if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  const messages = decision.messages.filter((message) => (
    !isPolicyMessage(message) || allowedIds.has(message.id)
  ))
  return messages.length === decision.messages.length ? decision : { ...decision, messages }
}

export function shouldInject(agent) {
  const phase = phaseFor(agent)
  return phase.promoted && policyMessageIdsInCurrentEpoch(agent?.session?.events).size === 0
}

export function policyMessage(agent) {
  const block = Object.freeze({ type: 'text', text: policyText(agent) })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'instructions' }),
  })
}

function ledgerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      goal: { type: 'string' },
      verified: { type: 'array', items: { type: 'string' } },
      open: { type: 'array', items: { type: 'string' } },
      next: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['goal', 'verified', 'open', 'next', 'evidence'],
  }
}

function registerStateTool(ctx) {
  ctx.tools.register({
    name: 'apex_state',
    description: [
      'Read or replace the bounded, durable state snapshot for the current human task.',
      'Use action=get to inspect it. Use action=set only for a multi-step task and provide the complete current Goal, Verified, Open, Next, and Evidence fields.',
      'The newest valid snapshot survives compaction and resets on the next real user task. Do not checkpoint every tool call.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        goal: { type: 'string', minLength: 1, maxLength: MAX_GOAL_CHARS },
        verified: {
          type: 'array',
          maxItems: MAX_VERIFIED_ITEMS,
          items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        },
        open: {
          type: 'array',
          maxItems: MAX_OPEN_ITEMS,
          items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        },
        next: { type: 'string', minLength: 1, maxLength: MAX_NEXT_CHARS },
        evidence: {
          type: 'array',
          maxItems: MAX_EVIDENCE_ITEMS,
          items: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE_CHARS },
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          ledger: ledgerSchema(),
          updated: { type: 'boolean' },
          stalled: { type: 'boolean' },
        },
        required: ['text', 'ledger', 'updated', 'stalled'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: LEDGER_META_KIND,
        ledger: value.ledger,
        updated: value.updated,
        stalled: value.stalled,
      }),
    },
    async execute(args, exec) {
      const history = ledgerEvents(exec.agent).map((entry) => entry.ledger)
      if (args.action === 'get') {
        const ledger = history.at(-1) ?? EMPTY_LEDGER
        return {
          text: history.length === 0
            ? 'No APEX task state is recorded. Keep a simple task stateless, or set one complete snapshot for a multi-step task.'
            : `Current APEX task state:\n${safeStateJson(ledger)}`,
          ledger,
          updated: false,
          stalled: false,
        }
      }
      if (args.action !== 'set') throw new Error('apex_state action must be "get" or "set"')
      const ledger = normalizeLedger(args)
      if (ledger === undefined) {
        throw new Error('apex_state set requires bounded goal, verified, open, next, and evidence fields')
      }
      const stalled = detectsStall([...history, ledger])
      return {
        text: stalled
          ? `APEX task state recorded. Stall detected across three checkpoints: change strategy before repeating Next.\n${safeStateJson(ledger)}`
          : `APEX task state recorded.\n${safeStateJson(ledger)}`,
        ledger,
        updated: true,
        stalled,
      }
    },
  })
}

export function apply(ctx) {
  registerStateTool(ctx)
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const currentPolicyIds = policyMessageIdsInCurrentEpoch(agent?.session?.events)
    const decision = filterStalePolicyMessages(await next(), currentPolicyIds)
    if (decision.kind === 'reject' || signal.aborted || !shouldInject(agent)) return decision
    signal.throwIfAborted()
    return { kind: 'enter', messages: [...decision.messages, policyMessage(agent)] }
  })
}
