export const name = 'apex-execution-status'
export const inject = ['tools', 'loader', 'agentPresets']

/** Optional APEX-only observations; canonical results and execution policy stay authoritative. */
export async function apply(ctx) {
  const { createUserMessage } = await ctx.root.loader.import('@deepseek-ai/dsh-llm')
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || result.isError
      || !['bash', 'apex_run_script'].includes(exec.name) || !exec.parent || !exec.agent
      || exec.signal.aborted || ctx.agentPresets.composedPreset(exec.agent.ctx) !== 'apex-v1') return decision

    const value = result.value
    let status, explanation
    if (value?.kind === 'promoted') {
      status = { kind: value.kind, jobId: value.jobId, timeoutMs: value.timeoutMs }
      explanation = 'Foreground wait expired; query this job for current state. Promotion does not mean command failure.'
    } else if (value?.kind === 'foreground'
      && (value.exitCode !== 0 || value.signal !== null || value.timedOut || value.aborted)) {
      status = { kind: value.kind, exitCode: value.exitCode, signal: value.signal,
        timedOut: value.timedOut, aborted: value.aborted, timeoutMs: value.timeoutMs }
      explanation = 'Execution status only; output markers do not override these facts or establish task acceptance or cleanup.'
    } else return decision

    // ponytail: one observation per abnormal dispatch; measure context growth before adding aggregation.
    return { ...decision, additionalContexts: [
      ...decision.additionalContexts ?? [],
      createUserMessage({ source: { kind: name }, content: [{ type: 'text', text:
        'APEX tool status at return:\n'
        + JSON.stringify({ callId: exec.callId, tool: exec.name, ...status }) + '\n' + explanation }],
      }),
    ] }
  })
}
