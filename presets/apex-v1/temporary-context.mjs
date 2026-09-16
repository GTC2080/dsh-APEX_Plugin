export const name = 'apex-temporary-context'
export const inject = ['apexTemporaryDirectories', 'systemPrompt', 'sandboxPolicy']

export function apply(ctx) {
  ctx.systemPrompt.context({
    name: 'apex:temporary-files', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text({ agent }) {
      if (!agent || process.platform !== 'darwin') return ''
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
      if (!ctx.apexTemporaryDirectories.applies(policy)) return ''
      if (policy.mode === 'danger-full-access') return 'APEX private temporary-write restrictions are inactive in danger-full-access mode.'
      const record = ctx.apexTemporaryDirectories.directory(policy)
      return `APEX temporary directory for this session: ${JSON.stringify(record.path)}. Confined processes use it for TMPDIR/TMP/TEMP and Node os.tmpdir(). Under workspace-write, write only within the workspace or this private directory; shared temporary directories and other sessions are not writable. Under read-only, neither area is writable. This directory survives turns and agent resume within this Host lifetime, but not a clean Host restart. Treat earlier temporary paths as expired after restart; keep durable work in the workspace. Do not remove the private directory itself; clean only exact children you created.`
    },
  })
}
