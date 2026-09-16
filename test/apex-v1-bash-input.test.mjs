import assert from 'node:assert/strict'
import { access, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { harnessAvailable, native, nativeHarness, systemText, textResponse, toolResponse } from './helpers/harness-v1.mjs'

const options = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }

test('APEX rejects undeclared Bash fields through PTC before foreground or background dispatch', options, async t => {
  const secret = 'fixture-value-must-not-be-echoed-in-an-error'
  const inputs = [
    { stdin: secret }, { cwd: secret }, { env: { FIXTURE: secret } }, { timeout: 1 },
    { run_in_background: true, stdin: secret }, { ['__proto__']: secret },
    Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`unknown_${i}_${'x'.repeat(400)}`, secret])),
  ].map(extra => ({ command: 'printf ran > unexpected-input-ran', description: 'Undeclared argument fixture', ...extra }))
  const code = `const results=[]; for (const input of JSON.parse(${JSON.stringify(JSON.stringify(inputs))})) {
    try { results.push(await tools.bash(input)); } catch (error) { results.push({error:error.message}); }
  } return results;`
  const h = await nativeHarness((_request, n) => n === 1
    ? toolResponse('bash-invalid-input', 'run_code', { description: 'Check declared fields', code }) : textResponse('done'))
  t.after(h.close)
  const agent = await h.create(), leaves = [], dispatched = []
  t.after(h.ctx.on('tools/result', (exec, result) => {
    if (exec.agent === agent && exec.name === 'bash') leaves.push({ exec, result })
  }))
  t.after(h.ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === agent && exec.name === 'bash') dispatched.push(exec)
    return next()
  }))
  await h.turn(agent, 'Execute only the fixed input-validation fixture.')
  assert.equal(leaves.length, inputs.length)
  assert.equal(dispatched.length, 0, 'invalid arguments must stop before the official Bash body and job creation')
  await assert.rejects(access(join(h.cwd, 'unexpected-input-ran')), { code: 'ENOENT' })
  for (const [i, { exec, result }] of leaves.entries()) {
    assert.deepEqual(exec.arguments, inputs[i], 'do not strip, reinterpret or retry arguments')
    assert.equal(result.isError, true)
    assert.deepEqual(result.error.info, { name: 'ToolArgsError', code: 'INVALID_ARGS' })
    assert.match(result.error.message, /not a declared property/)
    assert.match(result.error.message, /command was not executed/i)
    assert.doesNotMatch(result.error.message, new RegExp(secret))
    assert.ok(result.error.message.length < 2500, 'bound diagnostics even for numerous long field names')
  }
  const starts = agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch-start')
  assert.deepEqual(starts.map(e => e.data.arguments), inputs, 'durable evidence keeps the original input')
  assert.equal(h.adapter.requests.length, 2, 'no automatic repair or retry')
  assert.equal(systemText(h.adapter.requests[0]), systemText(h.adapter.requests[1]))
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'system/message').length, 1)
})

test('valid PTC Bash calls retain workdir, literal source, exit, timeout and background semantics', options, async t => {
  const literal = '中文 "quoted" \'single\' `ticks` ${literal} \\n\r\n' + 'λ'.repeat(6000)
  const input = {
    command: `node <<'APEX_BASH_INPUT'\nprocess.stdout.write(JSON.stringify({text:${JSON.stringify(literal)},cwd:process.cwd()}));\nAPEX_BASH_INPUT`,
    description: 'Native heredoc and workdir', workdir: '子 目录', timeoutMs: 5000, run_in_background: false,
  }
  const code = `
    const foreground = await tools.bash(${JSON.stringify(input)});
    const nonzero = await tools.bash({command:"printf actual-stderr >&2\\nexit 7",description:"Real exit status"});
    const timed = await tools.bash({command:"sleep 30",description:"Native deadline",timeoutMs:80});
    const job = await tools.bash({command:"printf background-ok",description:"Native background job",run_in_background:true});
    const output = await tools.job_output({job_id:job.jobId,wait:true,timeout_ms:5000});
    const script = await tools.apex_run_script({command:"node --input-type=module",description:"Existing stdin tool",script:"console.log('stdin-ok')"});
    return {foreground, nonzero, timed, job, output, script};`
  let sent = false
  const h = await nativeHarness(() => {
    if (sent) return textResponse('done')
    sent = true
    return toolResponse('bash-valid-input', 'run_code', { description: 'Check native execution', code })
  })
  t.after(h.close)
  await mkdir(join(h.cwd, input.workdir))
  const agent = await h.create(), outer = [], leaves = []
  t.after(h.ctx.on('tools/result', (exec, result) => {
    if (exec.agent !== agent) return
    if (exec.name === 'run_code') outer.push(result)
    if (exec.name === 'bash') leaves.push(result)
  }))
  await h.turn(agent, 'Execute only the fixed native-behavior fixture.')
  assert.equal(outer.length, 1)
  assert.equal(outer[0].isError, false, JSON.stringify(outer[0].content))
  const value = outer[0].value.result
  assert.deepEqual(JSON.parse(value.foreground.stdout.text), { text: literal, cwd: await realpath(join(h.cwd, input.workdir)) })
  assert.equal(value.foreground.exitCode, 0)
  assert.equal(value.nonzero.exitCode, 7)
  assert.equal(value.nonzero.stderr.text, 'actual-stderr')
  assert.equal(value.timed.timedOut, true)
  assert.equal(value.timed.signal, 'SIGTERM')
  assert.equal(value.job.kind, 'background')
  assert.equal(value.output.job.status, 'completed')
  assert.match(value.output.text, /background-ok/)
  assert.equal(value.script.stdout.text, 'stdin-ok\n')
  assert.equal(leaves.length, 4)
  assert.ok(leaves.every(result => !result.isError), 'nonzero and timeout are real command outcomes, not argument errors')
})

test('the APEX-only guard leaves official PTC Bash behavior and both SDK declarations unchanged', options, async t => {
  const code = 'return await tools.bash({command:"node --input-type=module",description:"Native control",stdin:"console.log(123)"});'
  const h = await nativeHarness((_request, n) => n % 2 === 1
    ? toolResponse('bash-scope-' + n, 'run_code', { description: 'Check scoped behavior', code }) : textResponse('done'),
  { shippedPresets: true })
  t.after(h.close)
  const apex = await h.create('apex'), official = await h.create('official', 'ptc')
  const definition = agent => h.ctx.tools.get('bash', agent)
  assert.deepEqual(definition(apex).parameters, definition(official).parameters)
  assert.deepEqual(definition(apex).output.schema, definition(official).output.schema)
  const outcomes = new Map()
  t.after(h.ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'bash') outcomes.set(exec.agent.id, result)
  }))
  await h.turn(apex, 'Run the fixed APEX check.')
  await h.turn(official, 'Run the fixed official control.')
  assert.equal(outcomes.get(apex.id).error?.info?.code, 'INVALID_ARGS')
  assert.equal(outcomes.get(official.id).isError, false)
  assert.equal(outcomes.get(official.id).value.exitCode, 0)
  assert.equal(outcomes.get(official.id).value.stdout.text, '', 'the official executor is not patched')
  assert.deepEqual(definition(apex).parameters, definition(official).parameters, 'validation must not mutate the shared schema')
  for (const request of h.adapter.requests) {
    const system = systemText(request)
    for (const map of ['ToolArgsMap', 'ToolOutputMap']) {
      const declaration = system.match(new RegExp(`interface ${map} \\{([\\s\\S]*?)\\n\\}`))?.[1]
      assert.ok(declaration)
      assert.equal((declaration.match(/\bbash:/g) ?? []).length, 1)
    }
  }
})

test('non-PTC dispatch validates the visible declaration and preserves cancellation and native guards', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  // A host-side caller without a PTC binding must receive the same protection.
  t.after(agent.ctx.tools.presentAs('native'))
  let callId = 0, dispatched = 0
  const call = (args, signal = new AbortController().signal) => h.ctx.tools.execute({
    agent, name: 'bash', callId: 'bash-native-' + ++callId, arguments: args, signal,
  })
  t.after(h.ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === agent && exec.name === 'bash') dispatched++
    return next()
  }))
  const input = { command: 'printf reached > native-input-ran', description: 'Native boundary fixture' }
  for (const args of [null, [], {}, { ...input, command: 3 }, { ...input, stdin: 'ignored' }]) {
    const result = await call(args)
    assert.equal(result.error?.info?.code, 'INVALID_ARGS')
  }
  const controller = new AbortController(); controller.abort(new Error('cancel fixture'))
  const cancelled = await call({ ...input, stdin: 'invalid but cancelled first' }, controller.signal)
  assert.equal(cancelled.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  const unguard = agent.ctx.tools.guard(exec => exec.name === 'bash' ? 'Fixture native policy denial' : undefined)
  t.after(unguard)
  const denied = await call(input)
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /Fixture native policy denial/)
  assert.equal(dispatched, 0)
  await assert.rejects(access(join(h.cwd, 'native-input-ran')), { code: 'ENOENT' })
  unguard()

  const { setSandboxMode } = await native('dsh-sandbox-policy')
  setSandboxMode(agent.session, 'read-only')
  const escalation = await call({ ...input, sandbox_permissions: 'workspace-write', justification: 'Approval-disabled fixture' })
  assert.equal(escalation.isError, true)
  assert.notEqual(escalation.error.info?.code, 'INVALID_ARGS', 'declared permissions must reach the native approval boundary')
  await assert.rejects(access(join(h.cwd, 'native-input-ran')), { code: 'ENOENT' })
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only')
  assert.equal(h.adapter.requests.length, 0)
})

test('declared extensions are accepted without a hardcoded key list or closing nested objects', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  t.after(agent.ctx.tools.presentAs('native'))
  const original = h.ctx.tools.get('bash', agent)
  const extension = { type: 'object', properties: {} }
  let received
  t.after(agent.ctx.tools.register({
    ...original,
    parameters: { ...original.parameters, properties: { ...original.parameters.properties, fixture_option: extension } },
    async execute(args, exec) {
      received = args.fixture_option
      return original.execute(args, exec)
    },
  }))
  const args = { command: 'printf native-ok', description: 'Declared extension fixture', fixture_option: { arbitrary_nested_field: 'kept' } }
  const result = await h.ctx.tools.execute({ name: 'bash', arguments: args, agent, callId: 'bash-extension', signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.stdout.text, 'native-ok')
  assert.deepEqual(received, args.fixture_option)
  assert.equal(h.adapter.requests.length, 0)
})
