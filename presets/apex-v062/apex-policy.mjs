/** Inject activated APEX guidance, bounded Flash workers, and durable task state. */

import { randomUUID } from 'node:crypto'

import {
  currentEpochEvents,
  currentTaskEvents,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_VISION_MODEL,
  isManagedFlashChild,
  isManagedVisionChild,
  phaseFor,
} from './tool-gate.mjs'
import { CAPABILITY_DIRECTORY } from './dev-tool-search.mjs'
import { workItemForChild, workspaceRelativePath } from './work-items.mjs'

export const name = 'apex-policy-v062'
export const inject = ['tools', 'subagents']

export const LEDGER_META_KIND = 'apex-task-ledger-v062'

export {
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_VISION_MODEL,
  isManagedFlashChild,
  isManagedVisionChild,
}
export const FLASH_MAX_REASONING_EFFORT = 'max'
export const FLASH_CHILD_SANDBOX_MODE = 'workspace-write'
export const VISION_CHILD_SANDBOX_MODE = 'read-only'

export const VISION_CHILD_HARD_STEP_LIMIT = 12
export const CHILD_STALL_INSPECTION_LIMIT = 12
export const CHILD_STALL_REPEAT_WINDOW = 6
export const CHILD_STALL_REASON = [
  'APEX v0.6.2 stopped this Flash Max child after durable evidence of repeated inspection without a successful implementation edit.',
  'The parent must inspect the leased files as they stand, preserve useful edits, and decide whether to repair directly or provide one concrete continuation.',
].join(' ')

const MAX_GOAL_CHARS = 480
const MAX_NEXT_CHARS = 320
const MAX_ITEM_CHARS = 400
const MAX_EVIDENCE_CHARS = 600
const MAX_VERIFIED_ITEMS = 12
const MAX_OPEN_ITEMS = 8
const MAX_EVIDENCE_ITEMS = 12
const MAX_ACCEPTANCE_CHECKS = 16
const MAX_CHECK_ID_CHARS = 64
const MAX_CHECK_ASSERTION_CHARS = 320
const MAX_CHECK_EVIDENCE_CHARS = 600
const MAX_WORKSPACE_DISPLAY_CHARS = 1_024
const CHECK_ID = /^[a-z0-9][a-z0-9._-]*$/
const CHECK_STATUS = new Set(['pending', 'failed', 'passed'])
export const APEX_WORKSPACE_HINT_PREFIX = '<apex-workspace version="0.6.2">'
export const APEX_CAPABILITY_DIRECTORY_PREFIX = '<apex-capability-directory version="0.6.2">'
export const APEX_RESEARCH_CONVERGENCE_PREFIX = '<apex-research-convergence version="0.6.2">'
export const RESEARCH_CONVERGENCE_THRESHOLD = 12

const RESEARCH_SHELL_COMMAND = /\b(?:curl|wget|grep|rg|sed|head|tail|find|ls|which|where(?:\.exe)?)\b|\bnpm\s+(?:ls|view)\b|\b(?:npx|bunx)\b[^\r\n;&|]*\s--version\b/i
const RESEARCH_TOOLS = new Set(['glob', 'grep', 'read', 'read_image', 'web_search'])

export const APEX_POLICY = `<apex version="0.6.2" profile="general">
The Pro parent owns the task model, integration, evidence, and final judgment.
- Work directly by default. Before activating an optional capability, identify the concrete gap it closes and the task-specific invariants that must remain true.
- Build checks only from explicit user or project requirements, local contracts, or observed defects. For measurable constraints, use the cheapest direct evidence for the relevant state; reuse still-valid evidence and repair the root-cause path. Never invent thresholds or domain benchmarks, or repeat passed work without a later mutation or new failure.
- Treat runtime, visual, research, and worker evidence as separate surfaces; passing one never proves domain correctness on another.
- Delegate only a genuinely independent code module with explicit untouched, non-overlapping paths. Never delegate the whole workspace, task model, research, validation, or final judgment.
- A worker owns its leased paths until it settles and apex_takeover transfers them; other workspace paths remain Pro-owned.
- Use apex_state only when work may cross compaction; encode task-specific invariants and observable completion checks there.
</apex>`

/** Keep the managed Flash editor inside its inherited session workspace. */
export function enforceFlashWorkspace(agent) {
  const mode = isManagedVisionChild(agent)
    ? VISION_CHILD_SANDBOX_MODE
    : isManagedFlashChild(agent)
      ? FLASH_CHILD_SANDBOX_MODE
      : undefined
  if (mode === undefined || typeof agent?.session?.append !== 'function') return false
  const current = agent.session.events.findLast((event) => event.type === 'sandbox/mode')
  if (current?.data?.mode === mode) return false
  agent.session.append('sandbox/mode', {
    mode,
    source: 'delegation',
  })
  return true
}

function instructionMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'instructions' }),
  })
}

function parsedToolArguments(event) {
  if (typeof event.data?.arguments !== 'string') return {}
  try {
    const value = JSON.parse(event.data.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Derive a bounded, workspace-relative list from the child's actual editor calls. */
export function touchedPathsForChild(agent) {
  const paths = new Set()
  const successful = successfulCallIds(agent?.session?.events ?? [])
  for (const event of agent?.session?.events ?? []) {
    if (event.type !== 'tool/call'
      || event.data?.name !== 'str_replace_editor'
      || !successful.has(event.data?.callId)) continue
    const args = parsedToolArguments(event)
    if (args.command === 'view') continue
    const path = workspaceRelativePath(agent, args.path)
    if (path !== undefined) paths.add(path)
    if (paths.size >= 20) break
  }
  return [...paths]
}

function childInspectionSignature(agent, event) {
  if (event.type !== 'tool/call') return undefined
  const args = parsedToolArguments(event)
  let value
  if (event.data?.name === 'str_replace_editor' && args.command === 'view') value = args.path
  else if (event.data?.name === 'read') value = args.file_path ?? args.path
  else if (event.data?.name === 'read_image') value = args.file_path
  else if (event.data?.name === 'glob' || event.data?.name === 'grep') value = args.path ?? args.cwd ?? '.'
  else return undefined
  const path = workspaceRelativePath(agent, value)
  if (path === undefined) return undefined
  const selector = args.pattern ?? args.glob_pattern ?? args.query ?? ''
  return `${event.data.name}:${path}:${String(selector).slice(0, 240)}`
}

/** Detect only repeated successful inspection calls since the latest successful edit. */
export function childStallEvidence(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const successful = successfulCallIds(events)
  let latestMutation = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'tool/call'
      && successful.has(event.data?.callId)
      && isImplementationEdit(event)) latestMutation = index
  }
  const inspections = events
    .slice(latestMutation + 1)
    .filter(event => event.type === 'tool/call' && successful.has(event.data?.callId))
    .map(event => childInspectionSignature(agent, event))
    .filter(value => value !== undefined)
  if (inspections.length < CHILD_STALL_INSPECTION_LIMIT) return undefined
  const recent = inspections.slice(-CHILD_STALL_REPEAT_WINDOW)
  const earlier = new Set(inspections.slice(0, -CHILD_STALL_REPEAT_WINDOW))
  if (!recent.every(signature => earlier.has(signature))) return undefined
  return {
    successfulInspections: inspections.length,
    repeated: [...new Set(recent)].slice(0, CHILD_STALL_REPEAT_WINDOW),
  }
}

export function stalledChildHandoffText(agent, evidence = childStallEvidence(agent)) {
  const workItem = workItemForChild(agent)
  const files = touchedPathsForChild(agent)
  return [
    'APEX host handoff:',
    'status: partial',
    'stopReason: repeated_no_progress',
    `workItemId: ${workItem?.id ?? 'unknown'}`,
    `filesTouched: ${files.length === 0 ? '(none recorded)' : files.join(', ')}`,
    `successfulInspectionsSinceEdit: ${evidence?.successfulInspections ?? 0}`,
    `repeatedInspections: ${evidence?.repeated?.join(', ') || '(none recorded)'}`,
    'completed: not inferred by the host; inspect the actual workspace',
    'remaining: the worker repeated prior inspections without a new successful edit',
    'next: inspect the leased files once, then transfer to Pro or resume this same worker only with one new concrete defect',
  ].join('\n')
}

async function deliverStallHandoff(ctx, agent, evidence) {
  try {
    await ctx.subagents.reportFrom(
      agent,
      [{ type: 'text', text: stalledChildHandoffText(agent, evidence) }],
      { delivery: 'quiet', signal: new AbortController().signal },
    )
  } catch (error) {
    ctx.logger?.warn?.(`APEX v0.6.2 could not deliver the evidence-stall handoff: ${String(error)}`)
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
  checks: Object.freeze([]),
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

function boundedChecks(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ACCEPTANCE_CHECKS) return undefined
  const checks = []
  const ids = new Set()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (Object.keys(item).sort().join(',') !== 'assertion,evidence,id,status') return undefined
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : ''
    const assertion = boundedText(item.assertion, MAX_CHECK_ASSERTION_CHARS)
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : undefined
    if (id.length === 0
      || id.length > MAX_CHECK_ID_CHARS
      || !CHECK_ID.test(id)
      || ids.has(id)
      || assertion === undefined
      || !CHECK_STATUS.has(item.status)
      || evidence === undefined
      || evidence.length > MAX_CHECK_EVIDENCE_CHARS
      || (item.status !== 'pending' && evidence.length === 0)) return undefined
    ids.add(id)
    checks.push({ id, assertion, status: item.status, evidence })
  }
  return checks
}

/** Validate and bound a task-state snapshot loaded from model input or a session log. */
export function normalizeLedger(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const goal = boundedText(value.goal, MAX_GOAL_CHARS)
  const verified = boundedList(value.verified, MAX_VERIFIED_ITEMS, MAX_ITEM_CHARS)
  const open = boundedList(value.open, MAX_OPEN_ITEMS, MAX_ITEM_CHARS)
  const next = boundedText(value.next, MAX_NEXT_CHARS)
  const evidence = boundedList(value.evidence, MAX_EVIDENCE_ITEMS, MAX_EVIDENCE_CHARS)
  const checks = boundedChecks(value.checks)
  if (goal === undefined
    || verified === undefined
    || open === undefined
    || next === undefined
    || evidence === undefined
    || checks === undefined) return undefined
  return { goal, verified, open, next, evidence, checks }
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
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return ''
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
    && text.startsWith('<apex version="0.6.2" profile="general">')
}

function messageHasText(message, predicate) {
  return Array.isArray(message?.content)
    && message.content.some((block) => block?.type === 'text' && predicate(block.text))
}

function hasPluginText(events, predicate) {
  return events.some((event) => (
    event.type === 'user/message'
    && isPolicyMessage(event.data)
    && messageHasText(event.data, predicate)
  ))
}

function successfulCallIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type === 'tool-result'
        && block.isError !== true
        && typeof block.toolCallId === 'string') ids.add(block.toolCallId)
    }
  }
  return ids
}

function isImplementationEdit(event) {
  if (event.data?.name === 'write' || event.data?.name === 'edit') return true
  return event.data?.name === 'str_replace_editor'
    && parsedToolArguments(event).command !== 'view'
}

function safeWorkspaceJson(agent) {
  const cwd = typeof agent?.session?.header?.cwd === 'string'
    ? agent.session.header.cwd.slice(0, MAX_WORKSPACE_DISPLAY_CHARS)
    : '(current workspace)'
  return JSON.stringify(cwd)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}

/** Declare the host-selected workspace before the first model action. */
export function workspaceHintText(agent) {
  return `${APEX_WORKSPACE_HINT_PREFIX}
Workspace root: ${safeWorkspaceJson(agent)}. Shell commands start there and may use relative paths. When an operation requires an absolute file path, resolve it beneath this exact root. Use an external path only when the user explicitly provides it.
</apex-workspace>`
}

export function capabilityDirectoryText() {
  return `${APEX_CAPABILITY_DIRECTORY_PREFIX}
Optional APEX capabilities are available on demand but are not yet in the tool schema. When one condition below exists, call the resident dev_tool_search with that exact name or one concise capability gap before manual Bash setup; one unique match unlocks the tool for the next request.
${CAPABILITY_DIRECTORY}
Do not search speculatively when the resident shell and editor already provide sufficient direct evidence.
</apex-capability-directory>`
}

export function researchConvergenceText() {
  return `${APEX_RESEARCH_CONVERGENCE_PREFIX}
Repeated read-only research has not yet produced an implementation edit. This is not a fixed research limit: continue only when one specific unresolved API, algorithm, or domain fact still blocks a correct design, and make the next lookup answer only that fact. Otherwise implement the smallest end-to-end slice now and let concrete build/runtime evidence identify any remaining gap; do not keep reading source merely to reduce uncertainty.
</apex-research-convergence>`
}

function consecutiveResearchCalls(agent) {
  const events = currentTaskEvents(agent?.session?.events)
  const successful = successfulCallIds(events)
  if (events.some(event => (
    event.type === 'tool/call'
    && successful.has(event.data?.callId)
    && isImplementationEdit(event)
  ))) return 0
  const calls = events.filter(event => (
    event.type === 'tool/call' && successful.has(event.data?.callId)
  ))
  let count = 0
  for (const event of calls.reverse()) {
    const args = parsedToolArguments(event)
    const research = RESEARCH_TOOLS.has(event.data?.name)
      || (['bash', 'pwsh'].includes(event.data?.name)
        && typeof args.command === 'string'
        && RESEARCH_SHELL_COMMAND.test(args.command))
    if (!research) break
    count += 1
  }
  return count
}

/** Inject one non-blocking convergence reminder only after durable repeated research. */
export function shouldInjectResearchConvergence(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0 || phaseFor(agent).kind !== 'controlled') {
    return false
  }
  const events = currentEpochEvents(agent?.session?.events)
  return consecutiveResearchCalls(agent) >= RESEARCH_CONVERGENCE_THRESHOLD
    && !hasPluginText(events, text => (
      typeof text === 'string' && text.startsWith(APEX_RESEARCH_CONVERGENCE_PREFIX)
    ))
}

export function shouldInjectWorkspaceHint(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0 || phaseFor(agent).kind !== 'controlled') {
    return false
  }
  return !hasPluginText(currentEpochEvents(agent?.session?.events), text => (
    typeof text === 'string' && text.startsWith(APEX_WORKSPACE_HINT_PREFIX)
  ))
}

/** Show the post-anchor directory once, without changing the first Minimal request. */
export function shouldInjectCapabilityDirectory(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return false
  const phase = phaseFor(agent)
  return phase.kind === 'controlled'
    && phase.promoted
    && !hasPluginText(currentEpochEvents(agent?.session?.events), text => (
      typeof text === 'string' && text.startsWith(APEX_CAPABILITY_DIRECTORY_PREFIX)
    ))
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

function retainedInstructionIdsInCurrentEpoch(events = []) {
  const ids = policyMessageIdsInCurrentEpoch(events)
  for (const event of currentEpochEvents(events)) {
    if (event.type === 'user/message'
      && isPolicyMessage(event.data)
      && messageHasText(event.data, text => (
        typeof text === 'string'
        && (text.startsWith(APEX_WORKSPACE_HINT_PREFIX)
          || text.startsWith(APEX_CAPABILITY_DIRECTORY_PREFIX)
          || text.startsWith(APEX_RESEARCH_CONVERGENCE_PREFIX))
      ))
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
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return false
  const phase = phaseFor(agent)
  return phase.promoted
    && phase.activated
    && policyMessageIdsInCurrentEpoch(agent?.session?.events).size === 0
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

function workspaceHintMessage(agent) {
  return instructionMessage(workspaceHintText(agent))
}

function capabilityDirectoryMessage() {
  return instructionMessage(capabilityDirectoryText())
}

function researchConvergenceMessage() {
  return instructionMessage(researchConvergenceText())
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
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            assertion: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'failed', 'passed'] },
            evidence: { type: 'string' },
          },
          required: ['id', 'assertion', 'status', 'evidence'],
        },
      },
    },
    required: ['goal', 'verified', 'open', 'next', 'evidence', 'checks'],
  }
}

function registerStateTool(ctx) {
  ctx.tools.register({
    name: 'apex_state',
    description: [
      'Read or replace the bounded, durable state snapshot for the current human task.',
      'Use action=get to inspect it. Use action=set only for a multi-step task and provide the complete current Goal, Verified, Open, Next, Evidence, and acceptance Checks fields.',
      'Checks encode only explicit user or project requirements, local contracts, and concrete observed defects; do not invent thresholds or domain benchmarks.',
      'For a measurable requirement, preserve its stated threshold and use the cheapest direct evidence for the relevant state. Reuse one evidence item across every check it directly proves, while keeping distinct evidence surfaces separate.',
      'Give every assertion a stable id and pending/failed/passed status. Passed or failed checks require concrete evidence; never reopen passed checks without a new failure.',
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
        checks: {
          type: 'array',
          maxItems: MAX_ACCEPTANCE_CHECKS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: MAX_CHECK_ID_CHARS },
              assertion: { type: 'string', minLength: 1, maxLength: MAX_CHECK_ASSERTION_CHARS },
              status: { type: 'string', enum: ['pending', 'failed', 'passed'] },
              evidence: { type: 'string', maxLength: MAX_CHECK_EVIDENCE_CHARS },
            },
            required: ['id', 'assertion', 'status', 'evidence'],
          },
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
        throw new Error('apex_state set requires bounded goal, verified, open, next, evidence, and optional checks fields')
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
  ctx.on('agent/request', async ({ agent }, next) => enforceFlashMax(agent, await next()))
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    if (isManagedVisionChild(agent) && step > VISION_CHILD_HARD_STEP_LIMIT) {
      agent.cancel({ kind: 'hook', reason: 'APEX v0.6.2 stopped the vision child at its bounded step limit.' })
      signal.throwIfAborted()
      return { kind: 'reject' }
    }
    const stall = isManagedFlashChild(agent) ? childStallEvidence(agent) : undefined
    if (stall !== undefined) {
      await deliverStallHandoff(ctx, agent, stall)
      agent.cancel({ kind: 'hook', reason: CHILD_STALL_REASON })
      signal.throwIfAborted()
      return { kind: 'reject' }
    }
    const retainedInstructionIds = retainedInstructionIdsInCurrentEpoch(agent?.session?.events)
    const decision = filterStalePolicyMessages(await next(), retainedInstructionIds)
    enforceFlashWorkspace(agent)
    if (decision.kind === 'reject' || signal.aborted) return decision
    const addWorkspaceHint = shouldInjectWorkspaceHint(agent)
    const addCapabilityDirectory = shouldInjectCapabilityDirectory(agent)
    const addPolicy = shouldInject(agent)
    const addResearchConvergence = shouldInjectResearchConvergence(agent)
    if (!addWorkspaceHint && !addCapabilityDirectory && !addPolicy && !addResearchConvergence) {
      return decision
    }
    signal.throwIfAborted()
    const messages = [...decision.messages]
    if (addWorkspaceHint) messages.push(workspaceHintMessage(agent))
    if (addCapabilityDirectory) messages.push(capabilityDirectoryMessage())
    if (addPolicy) messages.push(policyMessage(agent))
    if (addResearchConvergence) messages.push(researchConvergenceMessage())
    return { kind: 'enter', messages }
  })
}
