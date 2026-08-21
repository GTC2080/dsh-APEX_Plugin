/** Inject APEX v0.6 guidance, Flash Max delegation, and durable task state. */

import { randomUUID } from 'node:crypto'

import { currentEpochEvents, currentTaskEvents, phaseFor } from './tool-gate.mjs'

export const name = 'apex-policy-v06'
export const inject = ['tools']

export const LEDGER_META_KIND = 'apex-task-ledger-v06'

export const FLASH_MAX_PROVIDER = 'deepseek-official'
export const FLASH_MAX_MODEL = 'deepseek-v4-flash'
export const FLASH_MAX_REASONING_EFFORT = 'max'

export const CHILD_SOFT_STEP_LIMIT = 36
export const CHILD_HARD_STEP_LIMIT = 48
export const CHILD_WALL_TIME_MS = 20 * 60 * 1000
export const CHILD_BUDGET_REASON = [
  'APEX v0.6 stopped this Flash Max child at its bounded execution limit.',
  'The parent must inspect the workspace as it stands, preserve useful edits, and choose the smallest remaining repair.',
].join(' ')

const CHILD_BUDGET_WARNING = [
  'APEX budget checkpoint: stop expanding the implementation.',
  'Complete only the critical path, run the smallest decisive check, and return a concise result now.',
].join(' ')

const MAX_GOAL_CHARS = 480
const MAX_NEXT_CHARS = 320
const MAX_ITEM_CHARS = 400
const MAX_EVIDENCE_CHARS = 600
const MAX_VERIFIED_ITEMS = 12
const MAX_OPEN_ITEMS = 8
const MAX_EVIDENCE_ITEMS = 12

export const APEX_POLICY = `<apex version="0.6">
Fully satisfy the latest real user request while preserving its goal, acceptance criteria, verified facts, and unresolved gaps.
- Inspect enough of the existing project and call chain to act at the correct place. After the first local action, apex_state and dev_tool_search are resident; unlock only the capability required for the next concrete step.
- For non-trivial coding work, define a self-contained implementation brief with the goal, exact scope and non-goals, constraints, relevant facts or paths, and acceptance checks; then unlock apex_build for the primary edit.
- After apex_build returns, independently inspect the actual diff and affected call chain, run the critical checks, and repair any verified defect. If its budget expires, treat the workspace as a partial delivery and recover from evidence instead of restarting blindly. Never accept the child summary as proof; delegate another bounded repair only for a distinct verified defect, and fix tiny review findings directly.
- Keep simple tasks stateless. For work likely to cross compaction, checkpoint a complete Goal/Verified/Open/Next/Evidence snapshot after material progress, before a risky branch, or when blocked; change strategy after a stall warning.
- Use direct web_search for one exact fact. For multi-source or unfamiliar research, give apex_research a self-contained evidence brief, judge its sources and conflicts, and continue only for a distinct unresolved gap.
- Validate in proportion to risk, exercise the user-visible path, and report failures truthfully. A browser or GUI smoke command must have an OS-level deadline plus exact task-owned PID cleanup; a tool timeout alone is not proof that the process will stop. Stop only processes whose exact PID this task recorded.
</apex>`

export const APEX_CHILD_POLICY = `<apex-subagent version="0.6">
Complete only the delegated scope under the dedicated persona and tool boundary. Inspect the relevant evidence, make the smallest complete contribution, validate what you changed or concluded, and report the actual result, checks, failures, and unresolved gaps. Converge early: do not keep polishing after the acceptance checks are met, and when warned about the execution budget, stop new work and return the best verified state immediately. Do not expand scope, broaden authority, or delegate again.
</apex-subagent>`

/** Identify only the official Flash children that APEX itself manages. */
export function isManagedFlashChild(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) > 0
    && agent?.options?.provider === FLASH_MAX_PROVIDER
    && agent?.options?.model === FLASH_MAX_MODEL
}

function childBudgetMessage() {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text: CHILD_BUDGET_WARNING }]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'instructions' }),
  })
}

/** Start one exact timer per active managed child and clear it at quiescence. */
export function installChildWallBudget(ctx, wallTimeMs = CHILD_WALL_TIME_MS) {
  const timers = new Map()
  const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
    const previous = timers.get(agent)
    if (previous !== undefined) {
      clearTimeout(previous)
      timers.delete(agent)
    }
    if (status !== 'running' || !isManagedFlashChild(agent)) return

    const timer = setTimeout(() => {
      timers.delete(agent)
      if (agent.status === 'running') {
        agent.cancel({ kind: 'hook', reason: CHILD_BUDGET_REASON })
      }
    }, wallTimeMs)
    timer.unref?.()
    timers.set(agent, timer)
  })

  return () => {
    stopStatus()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}

/** Force only configured in-process Flash children to Max; preserve the parent request. */
export function enforceFlashMax(agent, config) {
  if ((agent?.session?.header?.delegationDepth ?? 0) <= 0
    || config?.provider !== FLASH_MAX_PROVIDER
    || config?.model !== FLASH_MAX_MODEL) return config
  return config.reasoningEffort === FLASH_MAX_REASONING_EFFORT
    ? config
    : { ...config, reasoningEffort: FLASH_MAX_REASONING_EFFORT }
}

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
    && (text.startsWith('<apex version="0.6">') || text.startsWith('<apex-subagent version="0.6">'))
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
  ctx.effect(
    () => installChildWallBudget(ctx),
    'apex-policy-v06: Flash child wall budget',
  )
  ctx.on('agent/request', async ({ agent }, next) => enforceFlashMax(agent, await next()))
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    if (isManagedFlashChild(agent) && step > CHILD_HARD_STEP_LIMIT) {
      agent.cancel({ kind: 'hook', reason: CHILD_BUDGET_REASON })
      signal.throwIfAborted()
      return { kind: 'reject' }
    }
    const currentPolicyIds = policyMessageIdsInCurrentEpoch(agent?.session?.events)
    const decision = filterStalePolicyMessages(await next(), currentPolicyIds)
    if (decision.kind === 'reject' || signal.aborted) return decision
    const addPolicy = shouldInject(agent)
    const addBudgetWarning = isManagedFlashChild(agent) && step === CHILD_SOFT_STEP_LIMIT
    if (!addPolicy && !addBudgetWarning) return decision
    signal.throwIfAborted()
    const messages = [...decision.messages]
    if (addPolicy) messages.push(policyMessage(agent))
    if (addBudgetWarning) messages.push(childBudgetMessage())
    return { kind: 'enter', messages }
  })
}
