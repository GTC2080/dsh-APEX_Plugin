import { sliceText } from './text.mjs'
import { lstatSync, mkdtempSync, realpathSync, writeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export const name = 'apex-temporary-runtime'
export const inject = ['loader', 'sessions', 'sessionProjections']
export const Config = z.object({
  privateTemp: z.boolean().default(true),
  workspaceOnly: z.union([z.boolean(), z.array(z.string().refine(value => isAbsolute(value) && !value.includes('\0') && value.isWellFormed(), {
    message: 'workspaceOnly entries must be absolute directory paths',
  })).min(1)]).default(false),
}).strict()
  .refine(config => !config.workspaceOnly || config.privateTemp, { message: 'workspaceOnly requires privateTemp: true' })
  .default({ privateTemp: true, workspaceOnly: false })

export function contains(root, path) {
  const tail = relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail))
}

export function directoryIdentity(path) {
  const stat = lstatSync(path)
  if (!isAbsolute(path) || realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('APEX temporary storage requires unchanged canonical directories')
  }
  return `${stat.dev}:${stat.ino}`
}

/** Host-owned directories survive agent unload/resume, and are reclaimed only after managed execution drains. */
export async function apply(ctx, input) {
  const config = Config.parse(input ?? {})
  if (config.workspaceOnly && process.platform !== 'darwin') throw new Error('APEX workspaceOnly requires the macOS Seatbelt backend')
  const selectedWorkspaces = new Map(Array.isArray(config.workspaceOnly)
    ? config.workspaceOnly.map(path => [path, directoryIdentity(path)]) : [])
  const [{ Service }, { default: NativeSubprocess }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-subprocess-local',
  ].map(name => ctx.root.loader.import(name)))
  let directories
  class TemporaryDirectories extends Service {
    static inject = ['sessions', 'sessionProjections']
    records = new Map()
    handles = new Set()
    closing = false
    shutdown = undefined
    root = undefined
    constructor(inner) {
      super(inner, 'apexTemporaryDirectories')
      directories = this
      inner.effect(() => () => this.close(), 'APEX temporary directory cleanup')
    }
    applies(policy) {
      if (!config.privateTemp || process.platform !== 'darwin' || policy.sessionId === undefined) return false
      const session = this.ctx.sessions.get(policy.sessionId)
      return session === undefined ? this.records.has(policy.sessionId)
        : this.ctx.sessionProjections.stateOf(session, 'agentPreset') === 'apex-v1'
    }
    directory(policy) {
      if (this.closing) throw new Error('APEX execution is closing; temporary storage is unavailable')
      if (!this.applies(policy)) throw new Error('APEX temporary storage requires an APEX session')
      const workspace = realpathSync(policy.workspaceRoot)
      const workspaceIdentity = directoryIdentity(workspace)
      const requested = resolve(this.ctx.sessions.get(policy.sessionId)?.header.cwd ?? policy.workspaceRoot)
      const selected = selectedWorkspaces.has(requested) ? requested : workspace
      const selectedIdentity = selectedWorkspaces.get(selected)
      if (selectedIdentity !== undefined && (workspace !== selected || directoryIdentity(selected) !== selectedIdentity)) {
        throw new Error('APEX configured workspace identity changed; refusing execution')
      }
      const shared = [realpathSync('/tmp'), realpathSync(tmpdir())]
      if (shared.some(path => contains(workspace, path))) throw new Error('APEX workspace must not contain a shared temporary root')
      if (!this.root) {
        const path = realpathSync(mkdtempSync(join(tmpdir(), 'apex-sessions-')))
        this.root = { path, identity: directoryIdentity(path) }
      }
      if (directoryIdentity(this.root.path) !== this.root.identity) throw new Error('APEX temporary container identity changed')
      if (contains(workspace, this.root.path) || contains(this.root.path, workspace)) {
        throw new Error('APEX workspace and temporary container must be disjoint')
      }
      let record = this.records.get(policy.sessionId)
      if (!record) {
        const path = realpathSync(mkdtempSync(join(this.root.path, 'session-')))
        record = { path, identity: directoryIdentity(path), workspace, workspaceIdentity,
          workspaceOnly: config.workspaceOnly === true || selectedIdentity !== undefined }
        this.records.set(policy.sessionId, record)
      }
      if (record.workspace !== workspace || record.workspaceIdentity !== workspaceIdentity || directoryIdentity(record.path) !== record.identity) {
        throw new Error('APEX workspace or temporary directory identity changed; refusing execution')
      }
      return record
    }
    close() {
      this.closing = true
      if (!this.shutdown) {
        // One local deadline from close entry; the pinned CLI's remaining global shutdown time is unavailable.
        const deadline = performance.now() + 3000
        this.shutdown = Promise.resolve().then(() => this.finishClose(deadline))
      }
      return this.shutdown
    }
    async finishClose(deadline) {
      const handles = [...this.handles], root = this.root?.path ?? null
      if (root === null && handles.length === 0) return
      let managedProcessExit = 'unknown', directoryCleanup = root === null ? 'not-allocated' : 'not-started'
      let phase = 'drain', logError
      const report = (outcome, error) => {
        try {
          writeSync(2, 'APEX temporary cleanup: ' + JSON.stringify({ outcome, phase, managedProcessExit, directoryCleanup, root,
            ...error ? { error: sliceText(String(error), 0, 1024) } : {} }) + '\n')
          return true
        } catch (error) {
          // A broken diagnostic sink must not prevent resource cleanup; surface its failure after cleanup is attempted.
          logError ??= error
          return false
        }
      }
      report('started')
      try {
        const signal = AbortSignal.timeout(Math.max(0, Math.floor(deadline - performance.now())))
        const outcomes = await Promise.allSettled(handles.map(async handle => {
          handle.terminate()
          if (!await handle.waitForExit(signal)) throw new Error('Managed range exit observation timed out')
        }))
        const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
        if (failures.length) throw new AggregateError(failures, 'Managed process exit was not confirmed')
        managedProcessExit = 'confirmed'
        if (root !== null) {
          phase = 'identity'
          if (directoryIdentity(root) !== this.root.identity) throw new Error('Temporary container identity changed')
          for (const record of this.records.values()) {
            if (directoryIdentity(record.path) !== record.identity) throw new Error('Temporary directory identity changed')
          }
          // Do not begin an unabortable recursive removal with an exhausted local budget.
          if (performance.now() + 250 >= deadline) throw new Error('Insufficient local cleanup budget to start removal')
          phase = 'remove'
          directoryCleanup = 'incomplete'
          await rm(root, { recursive: true, force: false })
          directoryCleanup = 'removed'
          this.records.clear()
        }
        phase = 'finished'
        if (!report('completed')) throw new Error('Temporary cleanup diagnostics could not be written', { cause: logError })
      } catch (error) {
        report('failed', error)
        throw new Error(`APEX temporary cleanup failed during ${phase}; directory state ${directoryCleanup}; exact container ${JSON.stringify(root)}`, { cause: error })
      }
    }
  }
  await ctx.plugin(TemporaryDirectories).await()
  class TrackedSubprocess extends NativeSubprocess {
    spawn(spec) {
      if (directories.closing) throw new Error('APEX execution runtime is closing')
      // Native ordinary spawn and registration are synchronous; deferred close also captures a reentrant accepted start.
      const handle = super.spawn(spec)
      directories.handles.add(handle)
      // Native handles own process signalling and range observation; retain unconfirmed ranges for teardown.
      void handle.waitForExit().then(() => directories.handles.delete(handle), error => {
        ctx.logger.warn('APEX managed range observation failed: ' + String(error))
      })
      return handle
    }
  }
  await ctx.plugin(TrackedSubprocess).await()
}
