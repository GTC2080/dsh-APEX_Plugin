import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contains } from './temporary-runtime.mjs'

export const name = 'apex-temporary-filesystem'
export const inject = ['loader', 'apexTemporaryDirectories', 'subprocess', 'sandbox', 'sandboxPolicy']

/** Keep native file tools, version semantics and publication mechanics; confine APEX writes in a managed worker. */
export async function apply(ctx, config) {
  const [{ default: NativeFileSystem }, { FsError }] = await Promise.all([
    '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-fs',
  ].map(name => ctx.root.loader.import(name)))
  const require = createRequire(new URL('package.json', ctx.baseUrl))
  const nativeRequire = createRequire(require.resolve('@deepseek-ai/dsh-fs-sandbox'))
  const localModule = nativeRequire.resolve('@deepseek-ai/dsh-fs-local')
  const cordisModule = createRequire(localModule).resolve('@deepseek-ai/cordis')
  const worker = fileURLToPath(new URL('./temporary-fs-worker.mjs', import.meta.url))
  class TemporaryFileSystem extends NativeFileSystem {
    mutationTails = new Map()
    async mutation(method, target, body, expected, signal, policy = ctx.sandboxPolicy.resolve()) {
      const cancelledBeforeExecution = () => new FsError('File mutation cancelled before execution; no write was started', 'FS_ABORTED')
      if (signal?.aborted) throw cancelledBeforeExecution()
      // All callers share this FIFO, including ordinary presets; workers retain the native guarded publication.
      const prior = this.mutationTails.get(target.targetKey) ?? Promise.resolve()
      let onQueuedAbort
      const cancelled = signal && new Promise((_, reject) => {
        onQueuedAbort = () => reject(cancelledBeforeExecution())
        signal.addEventListener('abort', onQueuedAbort, { once: true })
      })
      const operation = prior.then(async () => {
        if (onQueuedAbort) signal.removeEventListener('abort', onQueuedAbort)
        if (signal?.aborted) throw cancelledBeforeExecution()
        if (policy.mode !== 'workspace-write' || !ctx.apexTemporaryDirectories.applies(policy)) {
          return super[method](target, body, expected, signal, policy)
        }
        const record = ctx.apexTemporaryDirectories.directory(policy)
        const fresh = await this.resolve(target.displayPath, { signal })
        const path = this.processPath(fresh)
        if (![record.workspace, record.path].some(root => contains(root, path))) {
          throw new FsError('Target is outside the workspace and private temporary directory', 'FS_SANDBOX_DENIED')
        }
        const deadline = AbortSignal.timeout(30000)
        const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
        const command = [process.execPath, worker, pathToFileURL(cordisModule).href, pathToFileURL(localModule).href]
        const confined = await ctx.sandbox.confine(command, policy, abort)
        const size = (await this.stat(fresh, abort))?.size ?? 0
        const expanded = method === 'editText' ? size * (1 + body.newString.length) : Buffer.byteLength(body)
        const outputLimit = Math.min(2 ** 31 - 1, 6 * (this.config.diffBasisMaxBytes + size + expanded) + 65536)
        const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: record.workspace, signal: abort, graceMs: 500,
          stdio: { stdin: { data: JSON.stringify({ method, target: { ...fresh, displayPath: path }, body, expected, config: this.config }) },
            stdout: { maxBytes: outputLimit }, stderr: { maxBytes: 8192 } } })
        try {
          const result = await handle.done
          abort.throwIfAborted()
          const stdout = handle.collected.stdout.readFrom(0)
          if (result.exitCode !== 0 || stdout.lossy) throw new Error('File worker did not return a complete result; reread the target before retrying')
          const reply = JSON.parse(stdout.text)
          if (!reply.ok) throw new FsError(reply.message, reply.code)
          return reply.value
        } catch (error) {
          if (abort.aborted) throw new FsError('File mutation interrupted; reread the target before retrying', 'FS_ABORTED', { cause: error })
          if (error instanceof FsError) throw error
          throw new FsError('File worker failed; reread the target before retrying: ' + String(error.message), 'FS_IO_ERROR', { cause: error })
        } finally {
          handle.terminate()
          await handle.waitForExit()
        }
      })
      // A cancelled caller may return early, but its FIFO barrier must remain until the prior operation settles.
      const tail = operation.then(() => {}, () => {}).finally(() => {
        if (this.mutationTails.get(target.targetKey) === tail) this.mutationTails.delete(target.targetKey)
      })
      this.mutationTails.set(target.targetKey, tail)
      try { return await (cancelled ? Promise.race([operation, cancelled]) : operation) }
      finally { if (onQueuedAbort) signal.removeEventListener('abort', onQueuedAbort) }
    }
    writeText(target, body, expected, signal, policy) { return this.mutation('writeText', target, body, expected, signal, policy) }
    editText(target, body, expected, signal, policy) { return this.mutation('editText', target, body, expected, signal, policy) }
  }
  await ctx.plugin(TemporaryFileSystem, config).await()
}
