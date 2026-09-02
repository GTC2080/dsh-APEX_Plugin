/** Inject APEX guidance, role-bounded workers, and durable task state. */

import { createHash, randomUUID } from 'node:crypto'

import { artifactSnapshot } from './apex-evidence.mjs'

import {
  currentEpochEvents,
  currentTaskEvents,
  currentWebVisualEvidenceState,
  DELIVERY_META_KIND,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  FLASH_VISION_MODEL,
  isManagedFlashChild,
  isManagedFlashProductionChild,
  isLegacyReviewChild,
  isManagedPtcCodeChild,
  isManagedResearchChild,
  isManagedVisionChild,
  phaseFor,
  hasSuccessfulImplementationMutation,
  sessionEvidenceEvents,
  VISUAL_META_KIND,
  WEB_VALIDATION_META_KIND,
} from './tool-gate.mjs'
import {
  HANDOFF_REPORT_PREFIX,
  latestHandoffRevision,
  workItemForChild,
  workspaceRelativePath,
} from './work-items.mjs'

export const name = 'apex-policy-v063'
export const inject = ['tools', 'subagents']

export const LEDGER_META_KIND = 'apex-task-ledger-v063'

export {
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  FLASH_VISION_MODEL,
  isManagedFlashChild,
  isLegacyReviewChild,
  isManagedResearchChild,
  isManagedVisionChild,
}
export const FLASH_CHILD_SANDBOX_MODE = 'workspace-write'
export const VISION_CHILD_SANDBOX_MODE = 'read-only'
export const RESEARCH_CHILD_SANDBOX_MODE = 'read-only'
const LEGACY_REVIEW_CHILD_SANDBOX_MODE = 'read-only'

export const VISION_CHILD_HARD_STEP_LIMIT = 12
export const CHILD_STALL_INSPECTION_LIMIT = 12
export const CHILD_STALL_REPEAT_WINDOW = 6
export const CHILD_STALL_REASON = [
  'APEX v0.6.3 stopped this Flash Max child after durable evidence of repeated inspection without a successful implementation edit.',
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
export const APEX_WORKSPACE_HINT_PREFIX = '<apex-workspace version="0.6.3">'
export const APEX_PROMOTION_HINT_PREFIX = '<apex-promotion version="0.6.3">'
export const APEX_MODALITY_ROUTING_PREFIX = '<apex-modality-routing version="0.6.3">'
export const APEX_RESEARCH_CONVERGENCE_PREFIX = '<apex-research-convergence version="0.6.3">'
export const APEX_COMPUTE_CHECKPOINT_PREFIX = '<apex-compute-checkpoint version="0.6.3">'
export const APEX_IMPLEMENTATION_TRANSITION_PREFIX = '<apex-implementation-transition version="0.6.3">'
export const APEX_FINAL_EVIDENCE_PREFIX = '<apex-final-evidence version="0.6.3"'
export const IMPLEMENTATION_MUTATION_MARKER = '<apex-implementation-mutation version="0.6.3"/>'
export const RESEARCH_CONVERGENCE_THRESHOLD = 12
export const COMPUTE_CHECKPOINT_MIN_DURATION_MS = 10_000
export const COMPUTE_CHECKPOINT_COMPLETIONS = 2
export const COMPUTE_CHECKPOINT_SHORT_COMPLETIONS = 6
export const COMPUTE_CHECKPOINT_VISUAL_EVIDENCE_COMPLETIONS = 2
export const COMPUTE_BLOCKER_COMPLETIONS_AFTER_CHECKPOINT = 1

const RESEARCH_SHELL_COMMAND = /\b(?:curl|wget|grep|rg|sed|head|tail|find|ls|which|where(?:\.exe)?)\b|\bnpm\s+(?:ls|view)\b|\b(?:npx|bunx)\b[^\r\n;&|]*\s--version\b/i
const COMPUTE_SHELL_COMMAND = /(?:^|[\r\n;&|()])\s*(?:(?:command|exec|nohup|time)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:[^\s;&|()]+[\\/])?(bun|deno|julia|matlab|node|octave|perl|python(?:3)?|ruby|rscript)\b/i
const RESEARCH_TOOLS = new Set(['apex_research', 'glob', 'grep', 'read', 'read_image', 'web_search'])
const IMAGE_FILE_EVIDENCE = /\b(?:GIF|JPEG|PNG|WebP) image data\b/iu

export const APEX_POLICY = `<apex version="0.6.3" profile="general">
The Pro parent owns the task model, integration, evidence, and final judgment.
- Work directly by default. Before activating an optional capability, identify the concrete gap it closes and the task-specific invariants that must remain true.
- Build checks only from explicit user or project requirements, local contracts, or observed defects. For measurable constraints, use the cheapest direct evidence for the relevant state; reuse still-valid evidence and repair the root-cause path. Never invent thresholds or domain benchmarks, or repeat passed work without a later mutation or new failure.
- Before final delivery, or before reporting an inspection-only turn, when the user or project explicitly names a complete deliverable file set, file count, text character maximum, or exact required wording, copy every supported stated constraint from every named deliverable into apex_verify_delivery, never a representative subset. Explicit titles, labels, and body messages count as required literals even when they also need runtime or visual evidence. Account for every exact file in a text check or content_unconstrained_files; use the latter only when no supported text constraint was stated for that file. Prefer that single bounded check over rebuilding the same checks in Bash. After a failure, repair every failed item and rerun the identical complete contract only after the artifact changes; do not treat this as runtime, visual, or domain proof.
- Treat runtime, visual, research, and worker evidence as separate surfaces; passing one never proves domain correctness on another.
- Once runtime, visual, or explicit delivery evidence is opened, bind any success claim to the current artifact generation. A later mutation invalidates that surface until the unchanged contract is rechecked; compare a fresh visual capture with its compatible reviewed predecessor so improvement cannot hide a new regression.
- When local evidence cannot establish a consequential external fact, give apex_research one exact question and the engineering decision it informs. Vision Flash retrieves traceable sources and constraints; the parent Pro checks applicability and owns the decision. Refine a remaining gap instead of repeating an identical request. Use direct web_search only for one already identified canonical source or to resolve a focused conflict.
- Treat Vision like targeted research: state one visual evidence gap per call, reuse cached identical evidence, and continue when a changed artifact, view, state, unresolved issue, or contradiction can add evidence. Do not impose a task-wide Vision call count.
- Delegate through one immutable handoff contract with explicit untouched, non-overlapping paths, interfaces, invariants, and acceptance IDs. Vision Flash Production is the default for isolated single-file or mechanical implementation behind frozen interfaces; use Pro Core only for a genuinely difficult bounded algorithm or tightly coupled integration whose reasoning cannot remain with the parent. Never delegate the whole workspace, task model, research, validation, or final judgment.
- A worker owns its leased paths until it settles and apex_takeover transfers them; other workspace paths remain Pro-owned.
- Use apex_state only when work may cross compaction; encode task-specific invariants and observable completion checks there.
</apex>`

/** Keep every managed child inside the least-privilege sandbox for its role. */
export function enforceFlashWorkspace(agent) {
  const mode = isManagedVisionChild(agent)
    ? VISION_CHILD_SANDBOX_MODE
    : isManagedResearchChild(agent)
      ? RESEARCH_CHILD_SANDBOX_MODE
      : isLegacyReviewChild(agent)
        ? LEGACY_REVIEW_CHILD_SANDBOX_MODE
        : isManagedPtcCodeChild(agent)
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
  if (event.data?.arguments !== null
    && typeof event.data?.arguments === 'object'
    && !Array.isArray(event.data.arguments)) return event.data.arguments
  if (typeof event.data?.arguments !== 'string') return {}
  try {
    const value = JSON.parse(event.data.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function isSuccessfulToolEvent(event, successful) {
  return (event.type === 'tool/call' && successful.has(event.data?.callId))
    || (event.type === 'tool/code-dispatch' && event.data?.isError === false)
}

/** Derive a bounded, workspace-relative list from the child's actual editor calls. */
export function touchedPathsForChild(agent) {
  const paths = new Set()
  const successful = successfulCallIds(agent?.session?.events ?? [])
  for (const event of agent?.session?.events ?? []) {
    if (!isSuccessfulToolEvent(event, successful)
      || event.data?.name !== 'str_replace_editor') continue
    const args = parsedToolArguments(event)
    if (args.command === 'view') continue
    const path = workspaceRelativePath(agent, args.path)
    if (path !== undefined) paths.add(path)
    if (paths.size >= 20) break
  }
  return [...paths]
}

function childInspectionSignature(agent, event) {
  if (event.type !== 'tool/call' && event.type !== 'tool/code-dispatch') return undefined
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
    if (isSuccessfulToolEvent(event, successful)
      && isImplementationEdit(event)) latestMutation = index
  }
  const inspections = events
    .slice(latestMutation + 1)
    .filter(event => isSuccessfulToolEvent(event, successful))
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
  return `${HANDOFF_REPORT_PREFIX}${JSON.stringify({
    handoffId: workItem?.id ?? 'unknown',
    revision: latestHandoffRevision(agent?.session?.events) ?? 1,
    status: 'partial',
    changedPaths: files,
    completedAcceptance: [],
    decisions: [],
    unverified: [
      `Host did not infer acceptance after ${evidence?.successfulInspections ?? 0} inspections.`,
    ],
    remainingGaps: ['Worker repeated prior inspections without a successful edit.'],
    blockers: [],
    recommendedOwner: 'pro',
  })}`
}

async function deliverStallHandoff(ctx, agent, evidence) {
  try {
    await ctx.subagents.reportFrom(
      agent,
      [{ type: 'text', text: stalledChildHandoffText(agent, evidence) }],
      { delivery: 'quiet', signal: new AbortController().signal },
    )
  } catch (error) {
    ctx.logger?.warn?.(`APEX v0.6.3 could not deliver the evidence-stall handoff: ${String(error)}`)
  }
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
    && text.startsWith('<apex version="0.6.3" profile="general">')
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

function latestEvidenceRecord(events, kind) {
  return events
    .map((event, index) => ({ event, index }))
    .findLast(({ event }) => event.type === 'tool/result' && event.data?.meta?.kind === kind)
}

function finalEvidenceSignature(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function finalEvidenceResult(kind, detail, action, facts) {
  return {
    kind,
    detail,
    action,
    signature: finalEvidenceSignature({ kind, ...facts }),
  }
}

async function currentArtifactForEvidence(agent, root, events, excludeWebScreenshots = false) {
  const screenshots = excludeWebScreenshots
    ? events
      .filter(event => event.type === 'tool/result'
        && event.data?.meta?.kind === WEB_VALIDATION_META_KIND
        && typeof event.data.meta.screenshotPath === 'string')
      .map(event => event.data.meta.screenshotPath)
      .filter(Boolean)
    : []
  return await artifactSnapshot(agent, root, screenshots)
}

function visualEvidenceWasRequested(agent, events, capture) {
  if (phaseFor(agent).unlocked.has('apex_inspect_image')) return true
  const path = capture?.event?.data?.meta?.screenshotPath
  if (typeof path !== 'string' || path.length === 0) return false
  const captureMeta = capture.event.data.meta
  const relatedPaths = new Set(events
    .filter(event => (
      event.type === 'tool/result'
      && event.data?.meta?.kind === WEB_VALIDATION_META_KIND
      && event.data.meta.checkId === captureMeta.checkId
      && event.data.meta.signature === captureMeta.signature
      && typeof event.data.meta.screenshotPath === 'string'
    ))
    .map(event => event.data.meta.screenshotPath))
  return events.some(event => (
    event.type === 'tool/result'
    && event.data?.meta?.kind === 'apex-visual-review-v063'
    && Array.isArray(event.data.meta.imagePaths)
    && event.data.meta.imagePaths.some(imagePath => relatedPaths.has(imagePath))
  ))
}

/**
 * Find one current-hash evidence gap before a top-level turn stops.
 *
 * The hook only applies to evidence surfaces the task actually opened. It does
 * not make browser, Vision, or delivery checks mandatory for every task.
 */
export async function finalEvidenceGap(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return undefined
  const phase = phaseFor(agent)
  if (phase.kind !== 'controlled' || !phase.promoted) return undefined
  const events = sessionEvidenceEvents(agent?.session?.events)
  const web = latestEvidenceRecord(events, WEB_VALIDATION_META_KIND)
  if (web !== undefined) {
    const meta = web.event.data.meta
    const root = typeof meta.artifactRoot === 'string' ? meta.artifactRoot : ''
    const recordedHash = typeof meta.artifactHash === 'string' ? meta.artifactHash : ''
    if (root.length > 0 && recordedHash.length > 0) {
      let current
      try {
        current = await currentArtifactForEvidence(agent, root, events, true)
      } catch (error) {
        return finalEvidenceResult(
          'web-artifact-unavailable',
          `The host could not re-hash the Web artifact at ${JSON.stringify(root)}: ${String(error)}`,
          'Inspect or repair the artifact root, then run the unchanged Web-validation contract. If the root is intentionally unavailable, report that limitation explicitly.',
          { root, recordedHash },
        )
      }
      if (current.hash !== recordedHash) {
        return finalEvidenceResult(
          'web-evidence-stale',
          'The workspace changed after the latest Web evidence, so its runtime, screenshot, and visual conclusions no longer describe the deliverable.',
          'Run apex_validate_web with the exact existing contract to capture the current artifact generation before claiming success.',
          { currentHash: current.hash, recordedHash, root },
        )
      }
      if (meta.status !== 'passed') {
        return finalEvidenceResult(
          'web-evidence-failed',
          `The latest current-hash Web evidence is ${String(meta.status ?? 'unknown')} (${String(meta.failureClass ?? 'unknown')}).`,
          meta.repairEligible === true
            ? 'Repair the concrete diagnostic and rerun the unchanged Web-validation contract; otherwise report the unresolved failure honestly.'
            : 'Do not claim the runtime passed. Report the unresolved or external failure honestly unless new evidence makes it repairable.',
          { currentHash: current.hash, failureClass: meta.failureClass, status: meta.status },
        )
      }
      if (typeof meta.screenshotPath === 'string'
        && meta.screenshotPath.length > 0
        && visualEvidenceWasRequested(agent, events, web)) {
        const visual = currentWebVisualEvidenceState(agent)
        if (visual.kind !== 'closed') {
          const repair = visual.kind === 'repair'
          return finalEvidenceResult(
            `visual-evidence-${visual.kind}`,
            repair
              ? `The current browser capture still has blocking visual issue(s): ${JSON.stringify(visual.openIssueIds ?? [])}.`
              : `The current browser capture has not closed its requested visual evidence (${visual.kind}); remaining gaps: ${JSON.stringify(visual.remainingGaps ?? [])}.`,
            repair
              ? 'Pro must repair the artifact, then rerun the unchanged Web-validation contract and inspect the fresh host capture.'
              : 'Inspect the current host capture for the already identified evidence gap, or report the specifically missing view/state without claiming visual success.',
            {
              artifactHash: current.hash,
              kind: visual.kind,
              openIssueIds: visual.openIssueIds ?? [],
              path: meta.screenshotPath,
              remainingGaps: visual.remainingGaps ?? [],
            },
          )
        }
      }
    }
  }

  const delivery = latestEvidenceRecord(events, DELIVERY_META_KIND)
  if (delivery !== undefined) {
    const meta = delivery.event.data.meta
    const root = typeof meta.artifactRoot === 'string' ? meta.artifactRoot : ''
    const recordedHash = typeof meta.artifactHash === 'string' ? meta.artifactHash : ''
    if (root.length > 0 && recordedHash.length > 0) {
      let current
      try {
        current = await currentArtifactForEvidence(agent, root, events)
      } catch (error) {
        return finalEvidenceResult(
          'delivery-artifact-unavailable',
          `The host could not re-hash the delivery artifact at ${JSON.stringify(root)}: ${String(error)}`,
          'Inspect the artifact root, then rerun the unchanged delivery contract or report the limitation explicitly.',
          { root, recordedHash },
        )
      }
      if (current.hash !== recordedHash) {
        return finalEvidenceResult(
          'delivery-evidence-stale',
          'The workspace changed after the latest explicit delivery check.',
          'Rerun apex_verify_delivery with the exact existing contract against the current artifact generation.',
          { currentHash: current.hash, recordedHash, root },
        )
      }
      if (meta.status !== 'passed') {
        return finalEvidenceResult(
          'delivery-evidence-failed',
          `The current-hash delivery contract still fails: ${JSON.stringify(meta.failedCheckIds ?? [])}.`,
          'Repair every failed explicit item and rerun the identical delivery contract before claiming success.',
          { currentHash: current.hash, failedCheckIds: meta.failedCheckIds ?? [], status: meta.status },
        )
      }
    }
  }
  return undefined
}

export function finalEvidenceMessageText(gap) {
  return [
    `${APEX_FINAL_EVIDENCE_PREFIX} signature="${gap.signature}">`,
    'The previous response attempted to stop with an open current-artifact evidence gap.',
    `Gap: ${gap.detail}`,
    `Required next action: ${gap.action}`,
    'This host checkpoint runs once for an unchanged evidence state. Close the gap when possible; otherwise state the limitation precisely and do not claim success.',
    '</apex-final-evidence>',
  ].join('\n')
}

function hasFinalEvidenceCheckpoint(agent, signature) {
  return hasPluginText(currentTaskEvents(agent?.session?.events), text => (
    typeof text === 'string'
    && text.startsWith(APEX_FINAL_EVIDENCE_PREFIX)
    && text.includes(`signature="${signature}"`)
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
Workspace root: ${safeWorkspaceJson(agent)}. Shell commands start there and may use relative paths. When an operation requires an absolute file path, resolve it beneath this exact root. Do not probe conventional aliases such as "/workspace", "/app", or a home directory. Use an external path only when the user explicitly provides it.
</apex-workspace>`
}

export function promotionHintText() {
  return `${APEX_PROMOTION_HINT_PREFIX}
Capability availability changed after the Minimal anchor. Re-evaluate any unmet user requirement deferred because a tool or collaborator was absent; resolve concrete gap through the broker. HTML automatically exposes Web validation in host browser; don't broker it early; never probe paths or install one. Before editing an existing file, view it with str_replace_editor; use smallest unique old_str. Mutations invalidate freshness; Shell output does not restore it.
</apex-promotion>`
}

export function modalityRoutingText() {
  return `${APEX_MODALITY_ROUTING_PREFIX}
A successful Minimal result confirmed a referenced visual-media input. Make the capability broker the next external action for visual inspection; do not substitute Shell OCR, pixel sampling, or image parsing. Internal reasoning remains unrestricted.
</apex-modality-routing>`
}

export function researchConvergenceText() {
  return `${APEX_RESEARCH_CONVERGENCE_PREFIX}
Repeated read-only research has not yet produced an implementation edit. This is not a fixed research limit: continue only when one specific unresolved API, algorithm, or domain fact still blocks a correct design, and make the next lookup answer only that fact. Otherwise implement the smallest end-to-end slice now and let concrete build/runtime evidence identify any remaining gap; do not keep reading source merely to reduce uncertainty.
</apex-research-convergence>`
}

export function computeCheckpointText() {
  return `${APEX_COMPUTE_CHECKPOINT_PREFIX}
Repeated same-kind Shell computation completed before any Workspace artifact or successful implementation mutation. This is not a wall-clock, task-wide tool, or internal-reasoning limit. Preserve the current best candidate and any reusable result. Freeze the primary user-visible outcome, its core relationships or invariants, and the smallest representation that makes them observable. The host now permits one further computation-only Shell call for one specifically named blocking invariant. After that successful result, computation-only interpreter calls pause until a content-changing Workspace implementation mutation. Each such mutation grants one provisional computation-only lease; consuming it requires another real deliverable mutation before the next computation round. No-op rewrites do not renew the lease. Internal reasoning and Shell that directly writes the implementation remain available.
</apex-compute-checkpoint>`
}

export function implementationTransitionText() {
  return `${APEX_IMPLEMENTATION_TRANSITION_PREFIX}
The focused blocking computation has completed. Preserve its result. Internal reasoning remains unrestricted, but the next external action must make a content-changing Workspace implementation mutation; do not request another computation-only Shell call first. Temporary helper files, including system temporary paths, do not satisfy this transition. Direct implementation writes remain available.
</apex-implementation-transition>`
}

/** Return the interpreter family used by a computation-oriented Shell call. */
export function computeShellFamily(command) {
  if (typeof command !== 'string') return undefined
  const family = command.match(COMPUTE_SHELL_COMMAND)?.[1]?.toLowerCase()
  return family === 'python3' ? 'python' : family
}

function computeCheckpointIndex(events) {
  return events.findLastIndex(event => (
    event.type === 'user/message'
    && isPolicyMessage(event.data)
    && messageHasText(event.data, text => (
      typeof text === 'string' && text.startsWith(APEX_COMPUTE_CHECKPOINT_PREFIX)
    ))
  ))
}

function implementationMutationCallIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type !== 'tool-result'
        || block.isError === true
        || typeof block.toolCallId !== 'string'
        || !Array.isArray(block.content)) continue
      if (block.content.some(item => (
        item?.type === 'text'
        && typeof item.text === 'string'
        && item.text.includes(IMPLEMENTATION_MUTATION_MARKER)
      ))) ids.add(block.toolCallId)
    }
  }
  return ids
}

/** Derive the durable computation/implementation lease from session evidence. */
export function preArtifactComputeTransition(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) {
    return {
      checkpointed: false,
      blockerCompletions: 0,
      implementationMutations: 0,
      leaseCompletions: 0,
      implementationRequired: false,
    }
  }

  const events = currentTaskEvents(agent?.session?.events)
  const checkpointIndex = computeCheckpointIndex(events)
  if (checkpointIndex === -1) {
    return {
      checkpointed: false,
      blockerCompletions: 0,
      implementationMutations: 0,
      leaseCompletions: 0,
      implementationRequired: false,
    }
  }

  const afterCheckpoint = events.slice(checkpointIndex + 1)
  const successful = successfulCallIds(afterCheckpoint)
  const mutationCallIds = implementationMutationCallIds(afterCheckpoint)
  let blockerCompletions = 0
  let implementationMutations = 0
  let leaseCompletions = 0

  for (const event of afterCheckpoint) {
    if (event.type === 'tool/result'
      && event.data?.message?.content?.some(block => mutationCallIds.has(block?.toolCallId))) {
      implementationMutations += 1
      leaseCompletions = 0
      continue
    }
    if (event.type !== 'tool/call'
      || !['bash', 'pwsh'].includes(event.data?.name)
      || !successful.has(event.data?.callId)
      || mutationCallIds.has(event.data?.callId)
      || computeShellFamily(parsedToolArguments(event).command) === undefined) continue
    if (implementationMutations === 0) blockerCompletions += 1
    else leaseCompletions += 1
  }

  return {
    checkpointed: true,
    blockerCompletions,
    implementationMutations,
    leaseCompletions,
    implementationRequired: implementationMutations === 0
      ? blockerCompletions >= COMPUTE_BLOCKER_COMPLETIONS_AFTER_CHECKPOINT
      : leaseCompletions >= COMPUTE_BLOCKER_COMPLETIONS_AFTER_CHECKPOINT,
  }
}

/** Prompt exactly when the post-checkpoint blocker result makes implementation mandatory. */
export function shouldInjectImplementationTransition(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0
    || !preArtifactComputeTransition(agent).implementationRequired) return false
  return !hasPluginText(currentEpochEvents(agent?.session?.events), text => (
    typeof text === 'string' && text.startsWith(APEX_IMPLEMENTATION_TRANSITION_PREFIX)
  ))
}

function hasSuccessfulShellImageEvidence(events) {
  const shellCalls = new Set(events
    .filter(event => event.type === 'tool/call' && ['bash', 'pwsh'].includes(event.data?.name))
    .map(event => event.data?.callId)
    .filter(callId => typeof callId === 'string'))
  return events.some(event => (
    event.type === 'tool/result'
    && event.data?.message?.content?.some(block => (
      block?.type === 'tool-result'
      && block.isError !== true
      && shellCalls.has(block.toolCallId)
      && block.content?.some(item => (
        item?.type === 'text'
        && typeof item.text === 'string'
        && IMAGE_FILE_EVIDENCE.test(item.text)
      ))
    ))
  ))
}

/** Route a proven visual input before the parent builds a Shell-based substitute. */
export function shouldInjectModalityRouting(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0
    || phaseFor(agent).kind !== 'controlled'
    || hasSuccessfulImplementationMutation(agent)) return false
  const taskEvents = currentTaskEvents(agent?.session?.events)
  return hasSuccessfulShellImageEvidence(taskEvents)
    && !taskEvents.some(event => (
      event.type === 'tool/call' && event.data?.name === 'apex_inspect_image'
    ))
    && !hasPluginText(currentEpochEvents(agent?.session?.events), text => (
      typeof text === 'string' && text.startsWith(APEX_MODALITY_ROUTING_PREFIX)
    ))
}

function completedShellCalls(events) {
  const started = new Map()
  const families = new Map()
  for (const event of events) {
    if (event.type === 'tool/call'
      && ['bash', 'pwsh'].includes(event.data?.name)
      && typeof event.data?.callId === 'string'
      && Number.isSafeInteger(event.time)) {
      const command = parsedToolArguments(event).command
      const family = computeShellFamily(command)
      started.set(event.data.callId, {
        family,
        time: event.time,
      })
      continue
    }
    if (event.type !== 'tool/result'
      || !Number.isSafeInteger(event.time)
      || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type !== 'tool-result'
        || block.isError === true
        || typeof block.toolCallId !== 'string') continue
      const start = started.get(block.toolCallId)
      started.delete(block.toolCallId)
      if (start?.family === undefined) continue
      const counts = families.get(start.family) ?? { completed: 0, expensive: 0 }
      counts.completed += 1
      if (Number.isSafeInteger(start.time)
        && event.time - start.time >= COMPUTE_CHECKPOINT_MIN_DURATION_MS) counts.expensive += 1
      families.set(start.family, counts)
    }
  }
  return [...families.values()].reduce((maximum, counts) => ({
    completed: Math.max(maximum.completed, counts.completed),
    expensive: Math.max(maximum.expensive, counts.expensive),
  }), { completed: 0, expensive: 0 })
}

function satisfiedVisualEvidenceIndex(events) {
  return events.findLastIndex(event => (
    event.type === 'tool/result'
    && event.data?.meta?.kind === VISUAL_META_KIND
    && event.data.meta.verdict === 'pass'
    && event.data.meta.targetStatus === 'met'
  ))
}

/** Prompt once after durable expensive computation without blocking further reasoning or tools. */
export function shouldInjectComputeCheckpoint(agent) {
  const phase = phaseFor(agent)
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0
    || phase.kind !== 'controlled'
    || !phase.promoted
    || hasSuccessfulImplementationMutation(agent)
    || consecutiveResearchCalls(agent) >= RESEARCH_CONVERGENCE_THRESHOLD) return false
  const events = currentTaskEvents(agent?.session?.events)
  const visualEvidenceIndex = satisfiedVisualEvidenceIndex(events)
  const completed = completedShellCalls(events.slice(visualEvidenceIndex + 1))
  const completionThreshold = visualEvidenceIndex === -1
    ? COMPUTE_CHECKPOINT_SHORT_COMPLETIONS
    : COMPUTE_CHECKPOINT_VISUAL_EVIDENCE_COMPLETIONS
  return (completed.expensive >= COMPUTE_CHECKPOINT_COMPLETIONS
      || completed.completed >= completionThreshold)
    && !hasPluginText(events, text => (
      typeof text === 'string' && text.startsWith(APEX_COMPUTE_CHECKPOINT_PREFIX)
    ))
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

/** Pair the broker's first appearance in an anchored epoch with one short routing hint. */
export function shouldInjectPromotionHint(agent) {
  const phase = phaseFor(agent)
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0
    || phase.kind !== 'controlled'
    || !phase.promoted) return false
  return !hasPluginText(currentEpochEvents(agent?.session?.events), text => (
    typeof text === 'string' && text.startsWith(APEX_PROMOTION_HINT_PREFIX)
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
          || text.startsWith(APEX_PROMOTION_HINT_PREFIX)
          || text.startsWith(APEX_MODALITY_ROUTING_PREFIX)
          || text.startsWith(APEX_COMPUTE_CHECKPOINT_PREFIX)
          || text.startsWith(APEX_IMPLEMENTATION_TRANSITION_PREFIX)
          || text.startsWith(APEX_FINAL_EVIDENCE_PREFIX)
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

function promotionHintMessage() {
  return instructionMessage(promotionHintText())
}

function modalityRoutingMessage() {
  return instructionMessage(modalityRoutingText())
}

function researchConvergenceMessage() {
  return instructionMessage(researchConvergenceText())
}

function computeCheckpointMessage() {
  return instructionMessage(computeCheckpointText())
}

function implementationTransitionMessage() {
  return instructionMessage(implementationTransitionText())
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
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (signal.aborted) return
    const gap = await finalEvidenceGap(agent)
    if (gap === undefined || hasFinalEvidenceCheckpoint(agent, gap.signature)) return
    signal.throwIfAborted()
    agent.steer(instructionMessage(finalEvidenceMessageText(gap)))
  })
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    if (isManagedVisionChild(agent) && step > VISION_CHILD_HARD_STEP_LIMIT) {
      agent.cancel({ kind: 'hook', reason: 'APEX v0.6.3 stopped the vision child at its bounded step limit.' })
      signal.throwIfAborted()
      return { kind: 'reject' }
    }
    const stall = isManagedFlashProductionChild(agent) ? childStallEvidence(agent) : undefined
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
    const addPromotionHint = shouldInjectPromotionHint(agent)
    const addModalityRouting = shouldInjectModalityRouting(agent)
    const addPolicy = shouldInject(agent)
    const addResearchConvergence = shouldInjectResearchConvergence(agent)
    const addComputeCheckpoint = shouldInjectComputeCheckpoint(agent)
    const addImplementationTransition = shouldInjectImplementationTransition(agent)
    if (!addWorkspaceHint
      && !addPromotionHint
      && !addModalityRouting
      && !addPolicy
      && !addResearchConvergence
      && !addComputeCheckpoint
      && !addImplementationTransition) {
      return decision
    }
    signal.throwIfAborted()
    const messages = [...decision.messages]
    if (addWorkspaceHint) messages.push(workspaceHintMessage(agent))
    if (addPromotionHint) messages.push(promotionHintMessage())
    if (addModalityRouting) messages.push(modalityRoutingMessage())
    if (addPolicy) messages.push(policyMessage(agent))
    if (addResearchConvergence) messages.push(researchConvergenceMessage())
    if (addComputeCheckpoint) messages.push(computeCheckpointMessage())
    if (addImplementationTransition) messages.push(implementationTransitionMessage())
    return { kind: 'enter', messages }
  })
}
