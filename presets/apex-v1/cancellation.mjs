import { z } from 'zod'

export const name = 'apex-cancellation-boundary'
export const inject = ['agentTeams', 'sessionProjections']

export function apply(ctx) {
  // The native registry replays/checkpoints this host-only state and owns its
  // lifetime. Do not read arbitrary session history on the request path.
  const key = 'apexCancellation'
  ctx.sessionProjections.register({
    key, stateVersion: 1,
    stateSchema: z.object({ stopped: z.boolean(), userSeq: z.number().int().min(-1) }).strict(),
    init: () => ({ stopped: false, userSeq: -1 }),
    apply(state, event) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        return { stopped: false, userSeq: event.seq }
      }
      if (event.type === 'turn/end' && event.data.reason.kind === 'aborted'
        && event.data.reason.reason.kind === 'user') return { ...state, stopped: true }
      return state
    },
  })
  // Cover only the window before the native aborted turn is committed.
  const abortedAt = new WeakMap()
  const observedSignals = new WeakSet()
  function stopped(agent) {
    const state = ctx.sessionProjections.stateOf(agent.session, key)
    const at = abortedAt.get(agent)
    if (at !== undefined && state.userSeq < at) return true
    abortedAt.delete(agent)
    return state.stopped
  }
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (!observedSignals.has(signal)) {
      observedSignals.add(signal)
      signal.addEventListener('abort', () => {
        if (signal.reason?.kind !== 'user') return
        abortedAt.set(agent, agent.session.seq)
      }, { once: true })
    }
    const root = ctx.agentTeams.tryMembership(agent)?.root ?? agent
    if (!stopped(root) || (root === agent && messages.some(message => message.source.kind === 'user'))) {
      return next()
    }
    // Cancel this automatic wake BEFORE any model request. keepInbox leaves a
    // racing user prompt intact, and the native aborted-driver wake latch runs
    // that prompt after convergence. Notices stay in the durable inbox log.
    agent.cancel({ kind: 'hook', reason: 'APEX: user cancelled; waiting for a new user instruction' }, { keepInbox: true })
    if (root === agent) {
      // A user may have queued input BEFORE this hook aborted the notice turn.
      // Re-admit the last user item to latch its wake; moving the last one keeps
      // the relative order of user prompts and preserves its message identity.
      const queued = agent.inbox.nextTurn.findLast(message => message.source.kind === 'user')
        ?? agent.inbox.nextStep.findLast(message => message.source.kind === 'user')
      if (queued) { agent.inbox.remove(queued.id); agent.followup(queued) }
    }
    return { kind: 'reject' }
  })
}
