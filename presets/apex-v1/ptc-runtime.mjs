export const name = 'apex-mode-ptc-runtime'
export const inject = ['loader', 'sessions', 'sessionProjections', 'apexNativePtcExecution', 'apexPtcExecution']

/** Route the shared Host transport without changing native execution for other presets. */
export async function apply(ctx) {
  const { PtcRuntime } = await ctx.root.loader.import('@deepseek-ai/dsh-ptc-runtime')
  const native = ctx.apexNativePtcExecution.runtime()
  const apex = ctx.apexPtcExecution.runtime()

  class ModeRoutedRuntime extends PtcRuntime {
    get language() { return native.language }
    get isolation() { return native.isolation }
    get executionInstructions() { return native.executionInstructions }
    get sandboxMode() { return native.sandboxMode }
    get timeout() { return native.timeout }
    resolve(request) { return native.resolve(request) }
    run(spec) {
      const id = spec.sandboxPolicy?.sessionId
      const session = id === undefined ? undefined : ctx.sessions.get(id)
      const preset = session === undefined ? undefined : ctx.sessionProjections.stateOf(session, 'agentPreset')
      return (preset === 'apex-v1' ? apex : native).run(spec)
    }
  }
  await ctx.plugin(ModeRoutedRuntime).await()
}
