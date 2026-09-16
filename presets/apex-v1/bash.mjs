import * as script from './script.mjs'

export const name = 'apex-bash-signal-boundary'
export const inject = ['shell', 'subprocess', 'sandbox', 'sandboxPolicy', 'loader', 'tools']

// Additional process-signal policy only; the native executor still owns file
// confinement, approval, argv, deadlines, output and managed-process cleanup.
const SIGNAL_POLICY = '(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))'
function confined(argv, mode) {
  if (mode === 'danger-full-access') return ['/usr/bin/sandbox-exec', '-p', SIGNAL_POLICY, ...argv]
  const [runner, flag, profile, ...command] = argv
  if (!['sandbox-exec', '/usr/bin/sandbox-exec'].includes(runner) || flag !== '-p' || typeof profile !== 'string') {
    throw new Error('APEX: expected the native macOS Seatbelt provider; refusing unprotected execution')
  }
  // macOS rejects nested sandbox_apply; extend the native profile once.
  return [runner, flag, profile + '(deny signal)(allow signal (target same-sandbox))', ...command]
}

export async function apply(ctx) {
  if (process.platform !== 'darwin') throw new Error('APEX signal confinement requires macOS')
  const nativeShell = ctx.shell, NativeShell = nativeShell.constructor
  if (nativeShell.sandboxMode === undefined || typeof NativeShell.prototype.runArgv !== 'function'
    || typeof NativeShell.prototype.startArgv !== 'function' || !nativeShell.config) {
    throw new Error('APEX: incompatible native macOS Bash provider')
  }
  class SignalBoundBash extends NativeShell {
    get config() { return nativeShell.config }
    runArgv(spec, argv) {
      // Keep native preparation inside its deadline and cancellation boundary.
      return super.runArgv(spec, async signal => {
        const prepared = typeof argv === 'function' ? await argv(signal) : argv
        signal.throwIfAborted()
        return confined(prepared, spec.sandboxPolicy.mode)
      })
    }
    startArgv(spec, argv) { return super.startArgv(spec, confined(argv, spec.sandboxPolicy.mode)) }
  }
  // Inherit the Host's live settings instead of registering its namespace a
  // second time. The isolated optional settings service is intentionally absent.
  const scoped = ctx.isolate('shell').isolate('settings')
  await scoped.plugin(SignalBoundBash, nativeShell.config).await()
  const nativeTool = await ctx.root.loader.import('@deepseek-ai/dsh-tool-bash')
  await scoped.plugin(nativeTool).await()
  const { ToolArgsError, validateJsonSchemaValue } = await ctx.root.loader.import('@deepseek-ai/dsh-tools')
  scoped.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'bash') return next()
    // Close only the argument root at dispatch, without changing the native SDK.
    // PTC uses its binding-time declaration; other callers use the visible tool.
    const schema = exec.schema ?? scoped.tools.get('bash', exec.agent)
    if (!schema) return next()
    const violations = validateJsonSchemaValue({ ...schema.parameters, additionalProperties: false }, exec.arguments, 'bash')
    if (violations.length) throw new ToolArgsError([
      ...violations.slice(0, 8).map(message => message.length > 256 ? message.slice(0, 160) + '…' + message.slice(-80) : message),
      'APEX: command was not executed. Use only fields declared by the current Bash SDK.',
    ])
    return next()
  })
  await scoped.plugin(script).await()
}
