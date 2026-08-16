/** Inject the compact APEX v0.4 execution policy once per task/compaction epoch. */

import { randomUUID } from 'node:crypto'

import { isTaskBoundary, phaseFor } from './tool-gate.mjs'

export const name = 'apex-policy-v04'

export const APEX_POLICY = `<apex>
Use the smallest reliable path that fully satisfies the user's request.
- Inspect enough of the existing project and call chain to change the correct place.
- Reuse existing code, platform capabilities, the standard library, and current dependencies before adding machinery.
- Keep tools locked until a concrete next step needs them; use dev_tool_search instead of imitating a missing capability.
- Default to one relevant static check and one runtime or smoke check. Add more only after a concrete failure or risk; do not repeat screenshots, probes, installs, builds, or broad scans.
- Reuse the current browser, runtime, test framework, and installed dependencies. Install only when a required capability is genuinely missing, and never repeat the same install.
- Track processes started by the task and stop only their recorded PIDs. Broad name-based termination is blocked.
- Before finishing, enforce the requested deliverable shape and run the user-visible path. A page error, black screen, broken core interaction, extra required-output violation, or failed check means the task is not complete; test file:// when a single local HTML is requested.
- Avoid speculative abstractions, dependencies, configuration, scaffolding, repeated exploration, and unnecessary tests. Never skip safety, error handling, compatibility, or truthful reporting.
</apex>`

function isPolicyMessage(message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === name
}

function policyMessageIdsInCurrentEpoch(events = []) {
  const ids = new Set()
  for (const event of events) {
    if (event.type === 'compaction/end' || isTaskBoundary(event)) {
      ids.clear()
      continue
    }
    if (event.type === 'user/message'
      && isPolicyMessage(event.data)
      && Array.isArray(event.data.content)
      && event.data.content.some((block) => block?.type === 'text' && block.text === APEX_POLICY)) {
      if (typeof event.data.id === 'string') ids.add(event.data.id)
    }
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

export function policyMessage() {
  const block = Object.freeze({ type: 'text', text: APEX_POLICY })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'instructions' }),
  })
}

export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const currentPolicyIds = policyMessageIdsInCurrentEpoch(agent?.session?.events)
    const decision = filterStalePolicyMessages(await next(), currentPolicyIds)
    if (decision.kind === 'reject' || signal.aborted || !shouldInject(agent)) return decision
    signal.throwIfAborted()
    return { kind: 'enter', messages: [...decision.messages, policyMessage()] }
  })
}
