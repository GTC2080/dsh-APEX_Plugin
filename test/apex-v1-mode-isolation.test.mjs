import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { harnessAvailable, native, nativeHarness, systemText } from './helpers/harness-v1.mjs'

const options = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }
let sequence = 0
async function execute(h, agent, name, args) {
  const reply = await h.ctx.tools.execute({ agent, name, arguments: args,
    callId: 'mode-isolation-' + ++sequence, signal: new AbortController().signal })
  assert.equal(reply.isError, false, reply.error?.message)
  return reply.value
}
const run = (h, agent, code) => execute(h, agent, 'run_code', { code, description: 'Mode coexistence regression' })

test('one Host switches blank sessions between APEX, PTC and Minimal while preserving native providers', options, async t => {
  const h = await nativeHarness(undefined, { shippedPresets: true }); t.after(h.close)
  for (const [service, module] of [['fs', 'dsh-fs-sandbox'], ['sandbox', 'dsh-sandbox-local'], ['subprocess', 'dsh-subprocess-local']]) {
    const { default: Native } = await native(module)
    assert.equal(Object.getPrototypeOf(h.ctx[service]), Native.prototype, service)
    assert.notEqual(Object.getPrototypeOf(h.apexRuntime[service]), Native.prototype, service)
  }
  const { default: NativeRuntime } = await native('dsh-ptc-runtime-node')
  const original = h.ctx.apexNativePtcExecution.runtime()
  const isolated = h.ctx.apexPtcExecution.runtime()
  assert.equal(Object.getPrototypeOf(original), NativeRuntime.prototype)
  assert.equal(Object.getPrototypeOf(isolated), NativeRuntime.prototype)
  assert.deepEqual(isolated.timeout, original.timeout, 'native user configuration survives isolation')
  assert.equal(isolated.timeout.defaultMs, 20000)

  const agent = await h.create('switchable', 'ptc')
  const pid = process.pid
  const roots = new Map()
  for (const preset of ['standard', 'ptc', 'apex-v1', 'minimal', 'ptc', 'apex-v1', 'minimal']) {
    assert.equal(await h.ctx.agentPresets.select(agent, preset), preset)
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, 'agentPreset'), preset)
    assert.equal(h.ctx.agentPresets.composedPreset(agent.ctx), preset)
    const names = h.ctx.tools.schemas(agent).map(tool => tool.name)
    if (preset === 'standard') {
      assert.ok(names.includes('bash'))
      assert.ok(names.includes('write'))
      assert.equal(names.includes('run_code'), false)
      assert.equal(h.ctx.tools.get('apex_validate_web', agent), undefined)
      assert.equal(h.ctx.tools.get('spawn_teammate', agent), undefined)
      const direct = await execute(h, agent, 'bash', { command: 'printf standard', description: 'Standard provider fixture' })
      assert.equal(direct.stdout.text, 'standard')
    } else if (preset === 'minimal') {
      assert.deepEqual(names, ['bash'])
      assert.match(await execute(h, agent, 'bash', { command: 'export APEX_SWITCH_SENTINEL=retained' }), /exit code 0/)
      assert.match(await execute(h, agent, 'bash', { command: 'echo "$APEX_SWITCH_SENTINEL"' }), /retained/)
    } else {
      assert.ok(names.includes('run_code'))
      const direct = await h.ctx.tools.execute({ agent, name: 'bash', arguments: { command: 'true', description: 'PTC direct tool fixture' },
        callId: 'forbidden-direct-' + ++sequence, signal: new AbortController().signal })
      assert.equal(direct.isError, true, 'PTC keeps the native model-direct tool collapse')
      assert.equal(Boolean(h.ctx.tools.get('apex_validate_web', agent)), preset === 'apex-v1')
      const value = await run(h, agent, "return (await import('node:os')).tmpdir();")
      const path = await realpath(value.result)
      if (roots.has(preset)) assert.equal(path, roots.get(preset))
      roots.set(preset, path)
    }
    assert.equal(process.pid, pid)
  }
  assert.notEqual(roots.get('apex-v1'), roots.get('ptc'))
  assert.equal(h.apexRuntime.apexTemporaryDirectories.records.size, 1)
  assert.equal(h.adapter.requests.length, 0, 'switching and direct tool checks make no model requests')
  await h.turn(agent, 'Reply without tools.')
  assert.doesNotMatch(systemText(h.adapter.requests.at(-1)), /APEX|apex_/)
  await assert.rejects(h.ctx.agentPresets.select(agent, 'apex-v1'), /already started/)
  assert.equal(h.ctx.agentPresets.composedPreset(agent.ctx), 'minimal')
})

test('APEX and native PTC run concurrently with separate filesystem and process providers', options, async t => {
  const h = await nativeHarness(undefined, { shippedPresets: true }); t.after(h.close)
  const a = await h.create('parallel-apex', 'apex-v1')
  const b = await h.create('parallel-ptc', 'ptc')
  const observed = { native: [], apex: [] }
  for (const [label, runtime] of [['native', h.ctx], ['apex', h.apexRuntime]]) {
    const original = runtime.subprocess.spawn.bind(runtime.subprocess)
    t.mock.method(runtime.subprocess, 'spawn', spec => {
      observed[label].push(spec.argv)
      return original(spec)
    })
  }
  const program = label => `const os=await import('node:os');
    await new Promise(resolve=>setTimeout(resolve,75));
    await tools.write({file_path:${JSON.stringify(join(h.cwd, label + '.txt'))},content:${JSON.stringify(label)}});
    return {root:os.tmpdir(),label:${JSON.stringify(label)}};`
  const [apex, ptc] = await Promise.all([run(h, a, program('apex')), run(h, b, program('ptc'))])
  const privateRoot = h.apexRuntime.apexTemporaryDirectories.directory(h.ctx.sandboxPolicy.resolve({ session: a.session })).path
  assert.equal(await realpath(apex.result.root), privateRoot)
  assert.notEqual(await realpath(ptc.result.root), privateRoot)
  assert.equal(await readFile(join(h.cwd, 'apex.txt'), 'utf8'), 'apex')
  assert.equal(await readFile(join(h.cwd, 'ptc.txt'), 'utf8'), 'ptc')
  assert.equal(h.apexRuntime.apexTemporaryDirectories.records.has(b.id), false)
  assert.ok(observed.apex.some(argv => argv.some(arg => arg.includes('temporary-fs-worker.mjs'))))
  assert.ok(observed.apex.some(argv => argv.some(arg => arg.includes('TMPDIR=' + privateRoot))))
  assert.ok(observed.native.length > 0)
  assert.ok(observed.native.every(argv => !argv.some(arg => arg.includes('apex-sessions-') || arg.includes('temporary-fs-worker.mjs'))))
  assert.equal(h.ctx.tools.get('apex_run_script', b), undefined)
  assert.equal(h.adapter.requests.length, 0)
})
