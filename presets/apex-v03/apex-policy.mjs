/** Inject the compact APEX execution policy once per anchored session epoch. */

import { randomUUID } from 'node:crypto'

import { phaseFor } from './tool-gate.mjs'

export const name = 'apex-policy'

export const APEX_POLICY = `<apex>
Use the smallest reliable path that fully satisfies the user's request.
- Inspect enough of the existing project and call chain to change the correct place.
- Reuse existing code, platform capabilities, the standard library, and current dependencies before adding machinery.
- Keep tools locked until a concrete next step needs them; use dev_tool_search instead of imitating a missing capability.
- Avoid speculative abstractions, dependencies, configuration, scaffolding, repeated exploration, and unnecessary tests.
- Never skip safety, error handling, compatibility, or proportionate validation. Finish with the working result and the smallest relevant check.
</apex>`

function injectedInCurrentEpoch(events = []) {
  let injected = false
  for (const event of events) {
    if (event.type === 'compaction/end') {
      injected = false
      continue
    }
    if (event.type === 'user/message'
      && event.data?.source?.kind === 'plugin'
      && event.data.source.plugin === name
      && Array.isArray(event.data.content)
      && event.data.content.some((block) => block?.type === 'text' && block.text === APEX_POLICY)) {
      injected = true
    }
  }
  return injected
}

export function shouldInject(agent) {
  const phase = phaseFor(agent)
  return phase.promoted && !injectedInCurrentEpoch(agent?.session?.events)
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
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || !shouldInject(agent)) return decision
    signal.throwIfAborted()
    return { kind: 'enter', messages: [...decision.messages, policyMessage()] }
  })
}
