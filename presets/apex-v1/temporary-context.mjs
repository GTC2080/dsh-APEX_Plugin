export const name = 'apex-temporary-context'
export const inject = ['apexTemporaryDirectories', 'systemPrompt', 'sandboxPolicy']

export function apply(ctx) {
  ctx.systemPrompt.context({
    name: 'apex:temporary-files', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text({ agent }) {
      if (!agent || process.platform !== 'darwin') return ''
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
      if (!ctx.apexTemporaryDirectories.applies(policy)) return ''
      if (policy.mode === 'danger-full-access') return 'APEX private temporary-write restrictions are inactive in danger-full-access mode. Any configured workspaceOnly restriction is also inactive; this mode cannot enforce workspace-only writes.'
      const record = ctx.apexTemporaryDirectories.directory(policy)
      if (record.workspaceOnly) return `APEX workspaceOnly is enabled. Under workspace-write, Bash, apex_run_script, direct PTC and file write/edit may write only inside this session workspace: ${JSON.stringify(record.workspace)}. TMPDIR/TMP/TEMP and Node os.tmpdir() point to the workspace; private and shared temporary directories are not writable. Under read-only, workspace writes are also denied. Explicit danger-full-access bypasses these file restrictions. This is a write policy; reads and Host-managed storage are not confined to the workspace. Keep task fixtures here and clean only exact children you created; never remove the workspace itself. Workspace fixtures are not automatically removed on Host shutdown.`
        + ' On macOS, bare mktemp -d may ignore TMPDIR. When writes are allowed, use `apex_tmp=$(mktemp -d "${TMPDIR%/}/apex.XXXXXX") || exit 1`; if preparation fails, stop before running checks.'
      return `APEX temporary directory for this session: ${JSON.stringify(record.path)}. Confined processes use it for TMPDIR/TMP/TEMP and Node os.tmpdir(). Under workspace-write, write only within the workspace or this private directory; shared temporary directories and other sessions are not writable. Under read-only, neither area is writable. This directory survives turns and agent resume within this Host lifetime, but not a clean Host restart. Treat earlier temporary paths as expired after restart; keep durable work in the workspace. Do not remove the private directory itself; clean only exact children you created.`
        + ' On macOS, bare mktemp -d can choose the system temporary directory despite TMPDIR. Only when the task and sandbox permit temporary writes: for private temporary files use `apex_tmp=$(mktemp -d "${TMPDIR%/}/apex.XXXXXX") || exit 1`; for workspace-only files use `apex_tmp=$(mktemp -d "./.apex.XXXXXX") || exit 1` from the workspace. Sandbox permission does not override a narrower task scope.'
    },
  })
}
