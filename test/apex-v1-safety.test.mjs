import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { native, nativeHarness, harnessAvailable, systemText, textResponse } from './helpers/harness-v1.mjs'

const options = { skip: !harnessAvailable, timeout: 30000 }
async function call(h, agent, name, args, signal = new AbortController().signal) {
  const { scopeOf } = await native('dsh-scope')
  return h.ctx.tools.get(name, scopeOf(agent.ctx)).execute(args, { agent, signal })
}
async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(20) }
  assert.fail('Fixture did not settle within 5 seconds')
}

test('macOS Bash cannot signal an outside sentinel, but can stop its own child', {
  ...options, skip: !harnessAvailable || process.platform !== 'darwin',
}, async t => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(sentinel, 'spawn')
  t.after(async () => {
    if (sentinel.exitCode !== null || sentinel.signalCode !== null) return
    const exited = once(sentinel, 'exit'); sentinel.kill('SIGTERM'); await exited
  })
  const h = await nativeHarness(); t.after(h.close)
  const parent = await h.create()
  const source = `
    try { process.kill(${sentinel.pid}, 'SIGTERM'); console.log('OUTSIDE_SIGNAL_ALLOWED'); }
    catch (error) { console.log('outside:' + error.code); }
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.on('spawn',()=>child.kill('SIGTERM'));
    child.on('exit',()=>console.log('owned-child-stopped'));
  `
  const result = await call(h, parent, 'bash', {
    command: `node <<'APEX_SENTINEL'\n${source}\nAPEX_SENTINEL`, description: 'Check owned sentinel signal boundary',
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout.text, /outside:EPERM/)
  assert.match(result.stdout.text, /owned-child-stopped/)
  assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null)
  const { setSandboxMode } = await native('dsh-sandbox-policy')
  for (const mode of ['read-only', 'danger-full-access']) {
    setSandboxMode(parent.session, mode)
    const job = await call(h, parent, 'bash', {
      command: "node -e '" + source.replaceAll("'", "'\"'\"'") + "'",
      description: 'Check background sentinel signal boundary', run_in_background: true,
    })
    const output = await call(h, parent, 'job_output', { job_id: job.jobId, wait: true, timeout_ms: 5000 })
    assert.equal(output.job.status, 'completed')
    assert.match(output.text, /outside:EPERM/); assert.match(output.text, /owned-child-stopped/)
    assert.equal(sentinel.signalCode, null)
  }
})

test('native job cancellation and foreground timeout retain owned cleanup and real exit semantics', {
  ...options, skip: !harnessAvailable || process.platform !== 'darwin',
}, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const parent = await h.create(), other = await h.create('other')
  const job = await call(h, parent, 'bash', {
    command: "node -e 'console.log(process.pid); setInterval(()=>{},1000)'", description: 'Owned cancellation fixture', run_in_background: true,
  })
  let pid
  for (let i = 0; i < 50 && !pid; i++) {
    const output = await call(h, parent, 'job_output', { job_id: job.jobId })
    pid = Number(output.text.trim()) || undefined
    if (!pid) await delay(20)
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  const foreignSignal = await call(h, other, 'bash', {
    command: `node -e 'try { process.kill(${pid},0); console.log("UNSAFE"); } catch(e) { console.log(e.code); }'`,
    description: 'Separate invocation signal boundary',
  })
  assert.match(foreignSignal.stdout.text, /EPERM/)
  await assert.rejects(call(h, other, 'job_kill', { job_id: job.jobId }), /belong|access|owner/i)
  await call(h, parent, 'job_kill', { job_id: job.jobId })
  const output = await call(h, parent, 'job_output', { job_id: job.jobId, wait: true, timeout_ms: 5000 })
  assert.equal(output.job.status, 'killed')
  const timed = await call(h, parent, 'bash', { command: 'sleep 30', description: 'Short deadline fixture', timeoutMs: 80 })
  assert.equal(timed.timedOut, true); assert.equal(timed.signal, 'SIGTERM')
  assert.equal(timed.exitCode, null)
  const controller = new AbortController()
  controller.abort(new Error('pre-aborted fixture'))
  await assert.rejects(call(h, parent, 'bash', { command: 'echo should-not-run', description: 'Pre-aborted fixture' }, controller.signal))
})

test('cancelled Lead stays stopped after real child settlement, late notices and cold resume', options, async t => {
  let waiting = true, started = 0
  const h = await nativeHarness(request => {
    if (!waiting) return textResponse('explicit continuation completed')
    started++
    return new Promise(resolve => {
      if (request.signal.aborted) resolve([])
      else request.signal.addEventListener('abort', () => resolve([]), { once: true })
    })
  }); t.after(h.close)
  let parent = await h.create()
  const child = (await call(h, parent, 'spawn_teammate', {
    name: 'waiting', description: 'Cancelable child', prompt: 'Wait for cancellation.',
  })).member
  const turn = h.turn(parent, 'Wait for the teammate.')
  await until(() => started === 2)
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  await call(h, parent, 'interrupt_agent', { target: 'waiting' })
  waiting = false
  await turn
  await until(() => !h.ctx.agents.get(child.id))
  await parent.whenIdle()
  assert.equal(h.adapter.requests.length, 2, 'child settlement must not spend another model request')
  assert.ok(parent.session.snapshotEvents().some(e => e.type === 'agent/inbox/spliced'
    && e.data.inserted.some(m => m.source.kind === 'subagent-settled')), 'use the real settlement path')
  const { createUserMessage } = await native('dsh-llm')
  const late = () => createUserMessage({ content: [{ type: 'text', text: 'Late child notice' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Late settlement', senderSessionId: child.id } })
  parent.followup(late()); await parent.whenIdle()
  assert.equal(h.adapter.requests.length, 2, 'late notice must stay stopped')
  await h.dispose(parent); parent = await h.resume(parent.id)
  parent.followup(late()); await parent.whenIdle()
  assert.equal(h.adapter.requests.length, 2, 'cancellation must be reconstructed from native history')
  await h.turn(parent, 'Continue now.')
  assert.equal(h.adapter.requests.length, 3)
  parent.followup(late()); await parent.whenIdle()
  assert.equal(h.adapter.requests.length, 4, 'normal notification delivery resumes after real user input')
  assert.ok(systemText(h.adapter.requests.at(-1)).includes('APEX'))
})

test('late native job notices cannot resume cancellation, and a racing real user prompt is not lost', options, async t => {
  let active = false, hold = true
  const h = await nativeHarness(request => {
    if (!hold) return textResponse('done')
    active = true
    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve([]), { once: true }))
  }); t.after(h.close)
  const parent = await h.create()
  let finishJob
  h.ctx.jobs.start({ kind: 'fixture', label: 'Delayed settlement', owner: parent, run: () => ({
    cancel() { finishJob({ status: 'killed' }) },
    done: new Promise(resolve => { finishJob = resolve }),
  }) })
  const turn = h.turn(parent, 'Wait for cancellation.')
  await until(() => active)
  parent.cancel({ kind: 'user' }, { keepInbox: true }); hold = false
  await turn
  finishJob({ status: 'completed' }); await delay(20); await parent.whenIdle()
  assert.equal(h.adapter.requests.length, 1)
  assert.ok(parent.session.snapshotEvents().some(e => e.type === 'agent/inbox/spliced'
    && e.data.inserted.some(m => m.source.kind === 'plugin' && m.source.plugin === 'tool-jobs')))
  const { createUserMessage } = await native('dsh-llm')
  const notice = createUserMessage({ content: [{ type: 'text', text: 'Another delayed notice' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Done', senderSessionId: 'fixture-child' } })
  parent.followup(notice)
  const userTurn = h.turn(parent, 'Resume with this user instruction.')
  await userTurn
  assert.equal(h.adapter.requests.length, 2)
  assert.match(JSON.stringify(h.adapter.requests.at(-1)), /Resume with this user instruction/)
})

test('APEX preserves native Bash schema and does not pause an official PTC session', options, async t => {
  let started = false, hold = true
  const h = await nativeHarness(request => {
    if (!hold) return textResponse('official notification processed')
    started = true
    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve([]), { once: true }))
  }, { shippedPresets: true }); t.after(h.close)
  const official = await h.create('official', 'ptc'), apex = await h.create('apex')
  const { scopeOf } = await native('dsh-scope')
  const definition = agent => h.ctx.tools.get('bash', scopeOf(agent.ctx))
  assert.deepEqual(definition(apex).parameters, definition(official).parameters)
  assert.deepEqual(definition(apex).output.schema, definition(official).output.schema)
  const turn = h.turn(official, 'Wait.')
  await until(() => started)
  official.cancel({ kind: 'user' }, { keepInbox: true }); hold = false; await turn
  const { createUserMessage } = await native('dsh-llm')
  official.followup(createUserMessage({ content: [{ type: 'text', text: 'Native notice' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Done', senderSessionId: 'fixture' } }))
  await official.whenIdle()
  assert.equal(h.adapter.requests.length, 2, 'APEX must not change official notification policy')
})

test('unexpected macOS runner fails closed without changing the original command', {
  ...options, skip: !harnessAvailable || process.platform !== 'darwin',
}, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  t.mock.method(h.ctx.sandbox, 'confine', () => ({ argv: ['unexpected-runner', 'bash', '-c', 'false'] }))
  const args = { command: 'echo must-not-run', description: 'Unsupported runner fixture' }, original = structuredClone(args)
  await assert.rejects(call(h, agent, 'bash', args), /refusing unprotected execution/)
  assert.deepEqual(args, original)
})

test('async confinement stays inside native Bash and stdin deadlines and cancellation before spawn', {
  ...options, skip: !harnessAvailable || process.platform !== 'darwin',
}, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  const original = h.ctx.sandbox.confine.bind(h.ctx.sandbox)
  let preparationSignal, preparationDelay = 10
  t.mock.method(h.ctx.sandbox, 'confine', async (argv, policy, signal) => {
    preparationSignal = signal
    await delay(preparationDelay, undefined, { signal })
    return original(argv, policy, signal)
  })
  for (const [name, args] of [
    ['bash', { command: 'printf prepared', description: 'Async Bash preparation' }],
    ['apex_run_script', { command: 'node', script: 'process.stdout.write("prepared")', description: 'Async stdin preparation' }],
  ]) {
    preparationDelay = 10
    const result = await call(h, agent, name, args)
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.text, 'prepared')
    preparationDelay = 1000
    const spawn = t.mock.method(h.ctx.subprocess, 'spawn')
    const timed = await call(h, agent, name, { ...args, timeoutMs: 20 })
    assert.equal(timed.timedOut, true); assert.equal(timed.aborted, false)
    assert.equal(preparationSignal.aborted, true)
    assert.equal(spawn.mock.callCount(), 0, 'timed-out preparation must not start a process')
    const controller = new AbortController()
    const pending = call(h, agent, name, args, controller.signal)
    await delay(10); controller.abort(new Error('cancel preparation'))
    await assert.rejects(pending, /cancel preparation/)
    assert.equal(preparationSignal.aborted, true)
    assert.equal(spawn.mock.callCount(), 0, 'cancelled preparation must not start a process')
    spawn.mock.restore()
  }
})

test('multiple APEX sessions reuse one native Shell settings namespace and its live updates', {
  ...options, skip: !harnessAvailable || process.platform !== 'darwin',
}, async () => {
  const h = await nativeHarness()
  let settings
  try {
    settings = h.ctx.plugin((await native('dsh-settings-file')).default, { path: join(h.root, 'settings.yaml'), watch: false })
    await settings.await()
    const parent = await h.create(); await h.create('second-apex')
    assert.equal(h.ctx.settings.describe().filter(row => row.ns === 'shell').length, 1)
    await h.ctx.settings.update('shell', { timeoutMs: 70 })
    const result = await call(h, parent, 'bash', { command: 'sleep 30', description: 'Inherited native timeout setting' })
    assert.equal(result.timeoutMs, 70); assert.equal(result.timedOut, true)
    assert.equal(h.adapter.requests.length, 0)
  } finally {
    if (settings) await settings.dispose()
    await h.close()
  }
})
