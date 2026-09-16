import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { harnessAvailable, native, nativeHarness } from './helpers/harness-v1.mjs'

const onlyMac = { skip: !harnessAvailable || process.platform !== 'darwin' }
const deferred = () => Promise.withResolvers()
async function fixture(t) {
  const h = await nativeHarness()
  t.after(h.close)
  const agent = await h.create('lifecycle-check', 'apex-v1')
  const policy = h.ctx.sandboxPolicy.resolve({ session: agent.session })
  const directories = h.ctx.apexTemporaryDirectories
  const record = directories.directory(policy)
  return { h, policy, directories, record, root: directories.root.path }
}
async function waitUntil(fn) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(10) }
  assert.fail('Fixture did not become ready')
}
function diagnostics(t) {
  const messages = [], original = fsSync.writeSync
  const mock = t.mock.method(fsSync, 'writeSync', function(fd, data, ...args) {
    if (fd === 2 && typeof data === 'string' && data.startsWith('APEX temporary cleanup: ')) {
      messages.push(JSON.parse(data.slice('APEX temporary cleanup: '.length)))
      return Buffer.byteLength(data)
    }
    return original(fd, data, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  return messages
}

test('cancelled queued writes return before A finishes, while C retains the same FIFO barrier', onlyMac, async t => {
  const { h, policy } = await fixture(t)
  const target = await h.ctx.fs.resolve(join(h.cwd, 'queue.txt'))
  const entered = deferred(), release = deferred(), original = h.ctx.fs.resolve.bind(h.ctx.fs)
  let blocked = false
  t.mock.method(h.ctx.fs, 'resolve', async function(...args) {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise }
    return original(...args)
  })
  const a = h.ctx.fs.writeText(target, 'A', undefined, undefined, policy)
  await entered.promise
  const controller = new AbortController()
  const b = h.ctx.fs.writeText(target, 'B', undefined, controller.signal, policy)
  let cFinished = false
  const c = h.ctx.fs.writeText(target, 'C', undefined, undefined, policy).finally(() => { cFinished = true })
  const rejected = assert.rejects(b, { code: 'FS_ABORTED' })
  controller.abort()
  try {
    assert.equal(await Promise.race([rejected.then(() => 'cancelled'), delay(150).then(() => 'still-waiting')]), 'cancelled')
    assert.equal(cFinished, false)
    assert.equal(existsSync(target.targetKey), false)
  } finally { release.resolve(); await Promise.all([a, rejected, c]) }
  assert.equal(await fs.readFile(target.targetKey, 'utf8'), 'C')
  assert.equal(h.ctx.fs.mutationTails.size, 0)
})

test('pre-abort and cancellation at dequeue skip writes without losing the next operation', onlyMac, async t => {
  const { h, policy } = await fixture(t)
  const target = await h.ctx.fs.resolve(join(h.cwd, 'dequeue.txt'))
  const before = new AbortController(); before.abort()
  await assert.rejects(h.ctx.fs.writeText(target, 'forbidden', undefined, before.signal, policy), { code: 'FS_ABORTED' })
  const controller = new AbortController()
  const cancelled = h.ctx.fs.writeText(target, 'forbidden', undefined, controller.signal, policy)
  controller.abort()
  await assert.rejects(cancelled, { code: 'FS_ABORTED' })
  await h.ctx.fs.writeText(target, 'after', { kind: 'createIfAbsent' }, undefined, policy)
  assert.equal(await fs.readFile(target.targetKey, 'utf8'), 'after')
})

test('cancelling a running file worker waits for its managed process to stop', onlyMac, async t => {
  const { h, policy } = await fixture(t)
  const target = await h.ctx.fs.resolve(join(h.cwd, 'running.txt'))
  const marker = join(h.cwd, 'worker-pid'), wrapper = join(h.cwd, 'slow-provider.mjs')
  const original = h.ctx.subprocess.spawn.bind(h.ctx.subprocess)
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('package.json', h.ctx.baseUrl))
  const local = createRequire(require.resolve('@deepseek-ai/dsh-fs-sandbox')).resolve('@deepseek-ai/dsh-fs-local')
  await fs.writeFile(wrapper, `import Native from ${JSON.stringify(pathToFileURL(local).href)};import{writeFile}from'node:fs/promises';
    export default class extends Native{async writeText(...args){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(r=>setTimeout(r,60000));return super.writeText(...args)}}`)
  t.mock.method(h.ctx.subprocess, 'spawn', function(spec) {
    const index = spec.argv.findIndex(arg => arg.endsWith('/temporary-fs-worker.mjs'))
    if (index < 0) return original(spec)
    const argv = [...spec.argv]; argv[index + 2] = pathToFileURL(wrapper).href
    return original({ ...spec, argv })
  })
  const controller = new AbortController()
  const write = h.ctx.fs.writeText(target, 'forbidden', undefined, controller.signal, policy)
  const rejected = assert.rejects(write, { code: 'FS_ABORTED' })
  try { await waitUntil(() => existsSync(marker)) } finally { controller.abort() }
  const pid = Number(await fs.readFile(marker, 'utf8'))
  await rejected
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(existsSync(target.targetKey), false)
})

test('close is reentrant and idempotent, blocks new starts, and emits completion only after removal', onlyMac, async t => {
  const messages = diagnostics(t)
  const { h, directories, root } = await fixture(t)
  const release = deferred(), entered = deferred()
  let attempts = 0, reentrant
  directories.handles.add({ terminate() { attempts++; reentrant = directories.close(); entered.resolve() }, waitForExit: () => release.promise })
  const closing = directories.close()
  assert.equal(closing, directories.close())
  assert.throws(() => h.ctx.subprocess.spawn({}), /closing/)
  await entered.promise
  assert.equal(reentrant, closing); assert.equal(attempts, 1)
  assert.equal(existsSync(root), true)
  assert.deepEqual(messages.map(item => item.outcome), ['started'])
  release.resolve(true); await closing
  assert.equal(existsSync(root), false)
  assert.equal(messages.at(-1).outcome, 'completed')
  assert.equal(messages.at(-1).managedProcessExit, 'confirmed')
  assert.equal(messages.at(-1).directoryCleanup, 'removed')
})

test('a reentrant close during native synchronous spawn includes the accepted process before cleanup', onlyMac, async t => {
  const messages = diagnostics(t)
  const { h, directories, root } = await fixture(t)
  const { default: NativeSubprocess } = await native('dsh-subprocess-local')
  const original = NativeSubprocess.prototype.spawn
  let closing, terminateCalls = 0
  t.mock.method(NativeSubprocess.prototype, 'spawn', function(spec) {
    const handle = original.call(this, spec), terminate = handle.terminate.bind(handle)
    t.mock.method(handle, 'terminate', () => { terminateCalls++; return terminate() })
    closing = directories.close()
    return handle
  })
  const handle = h.ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},60000)'], cwd: h.cwd, graceMs: 500,
    stdio: { stdin: { data: '' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  await closing
  assert(terminateCalls >= 1)
  assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true)
  assert.equal(existsSync(root), false)
  assert.equal(messages.at(-1).outcome, 'completed')
})

test('a broken diagnostic sink does not prevent attempting resource termination and removal', onlyMac, async t => {
  const { directories, root } = await fixture(t)
  let attempts = 0
  directories.handles.add({ terminate() { attempts++ }, waitForExit: async () => true })
  const original = fsSync.writeSync
  const mock = t.mock.method(fsSync, 'writeSync', function(fd, data, ...args) {
    if (fd === 2 && String(data).startsWith('APEX temporary cleanup: ')) throw new Error('injected stderr failure')
    return original(fd, data, ...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(directories.close(), /cleanup failed/)
    assert.equal(attempts, 1)
    assert.equal(existsSync(root), false)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})

test('close failures report their scope and never turn an incomplete cleanup into success', onlyMac, async t => {
  for (const mode of ['terminate', 'false', 'identity', 'budget', 'partial-remove']) await t.test(mode, async sub => {
    const messages = diagnostics(sub)
    const { h, directories, record, root } = await fixture(sub)
    const first = join(record.path, 'first'), second = join(record.path, 'second')
    await fs.writeFile(first, 'one'); await fs.writeFile(second, 'two')
    let attempts = 0
    if (mode === 'terminate' || mode === 'false') {
      directories.handles.add({ terminate() { attempts++; if (mode === 'terminate') throw new Error('termination rejected') }, waitForExit: async () => false })
      directories.handles.add({ terminate() { attempts++ }, waitForExit: async () => true })
    } else if (mode === 'identity') {
      await fs.rename(record.path, record.path + '-original'); await fs.mkdir(record.path)
    } else if (mode === 'budget') {
      let calls = 0
      sub.mock.method(performance, 'now', () => calls++ === 0 ? 0 : 2999)
    } else {
      const original = fs.rm
      sub.mock.method(fs, 'rm', async function(path, ...args) {
        if (path !== root) return original(path, ...args)
        await fs.unlink(first)
        throw Object.assign(new Error('injected partial removal failure'), { code: 'EACCES' })
      })
      syncBuiltinESMExports()
    }
    try {
      await assert.rejects(directories.close(), /cleanup failed/)
      assert.equal(existsSync(root), true)
      if (mode === 'terminate' || mode === 'false') assert.equal(attempts, 2)
      const last = messages.at(-1)
      assert.equal(last.outcome, 'failed'); assert.equal(last.root, root)
      assert.equal(last.managedProcessExit, ['terminate', 'false'].includes(mode) ? 'unknown' : 'confirmed')
      assert.equal(last.directoryCleanup, mode === 'partial-remove' ? 'incomplete' : 'not-started')
      if (mode === 'partial-remove') { assert.equal(existsSync(first), false); assert.equal(await fs.readFile(second, 'utf8'), 'two') }
      else if (mode !== 'identity') assert.equal(await fs.readFile(first, 'utf8'), 'one')
    } finally {
      sub.mock.restoreAll(); syncBuiltinESMExports()
      await h.close(); await fs.rm(root, { recursive: true })
    }
  })
})
