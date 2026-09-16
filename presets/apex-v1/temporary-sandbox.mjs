export const name = 'apex-temporary-sandbox'
export const inject = ['loader', 'apexTemporaryDirectories']

const literal = path => '"' + path.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'

/** Preserve native runner configuration; narrow macOS APEX confined calls only. */
export async function apply(ctx, config) {
  const { default: NativeSandbox } = await ctx.root.loader.import('@deepseek-ai/dsh-sandbox-local')
  class TemporarySandbox extends NativeSandbox {
    async confine(argv, policy, signal) {
      if (!ctx.apexTemporaryDirectories.applies(policy)) return super.confine(argv, policy, signal)
      signal?.throwIfAborted()
      const record = ctx.apexTemporaryDirectories.directory(policy)
      const command = ['/usr/bin/env', ...['TMPDIR', 'TMP', 'TEMP'].map(key => key + '=' + record.path + '/'), ...argv]
      const result = await super.confine(command, { ...policy, mode: 'read-only' }, signal)
      const [runner, flag, profile, separator, ...actual] = result.argv
      if (!['sandbox-exec', '/usr/bin/sandbox-exec'].includes(runner) || flag !== '-p' || separator !== '--'
        || JSON.stringify(actual) !== JSON.stringify(command)) throw new Error('APEX requires the native macOS Seatbelt argv contract')
      const grants = policy.mode === 'workspace-write'
        ? ` (allow file-write* (subpath ${literal(record.workspace)}) (subpath ${literal(record.path)}))`
          + ` (deny file-write-unlink (literal ${literal(record.path)}) (literal ${literal(record.workspace)}))` : ''
      signal?.throwIfAborted()
      return { ...result, argv: [runner, flag, profile + grants, separator, ...command] }
    }
  }
  await ctx.plugin(TemporarySandbox, config).await()
}
