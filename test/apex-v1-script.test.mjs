import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { readExecutionEvidence } from '../presets/apex-v1/evidence.mjs'
import { harnessAvailable, native, nativeHarness, pluginRoot, systemText, textResponse, toolResponse } from './helpers/harness-v1.mjs'

const options = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }
const args = (script, extra = {}) => ({ command: 'node --input-type=module', description: 'Exercise script stdin contract', script, ...extra })
async function tool(h, agent, name = 'apex_run_script') {
  const { scopeOf } = await native('dsh-scope')
  return h.ctx.tools.get(name, scopeOf(agent.ctx))
}
async function call(h, agent, input, signal = new AbortController().signal) {
  return (await tool(h, agent)).execute(input, { agent, signal, callId: 'script-fixture' })
}
async function untilFile(file) {
  for (let i = 0; i < 250; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(20)
  }
  assert.fail('Owned script did not become ready within 5 seconds')
}

test('native API imports use the Host Loader, including scope and approval identities', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const imported = [], importModule = h.ctx.loader.import.bind(h.ctx.loader)
  h.ctx.loader.import = (specifier, ...rest) => {
    imported.push(specifier)
    return importModule(specifier, ...rest)
  }
  const agent = await h.create()
  for (const name of ['dsh-scope', 'dsh-sandbox', 'dsh-llm', 'dsh-tools']) {
    assert.ok(imported.includes(`@deepseek-ai/${name}`), `Host loader must own ${name}`)
  }
  const result = await call(h, agent, args('console.log("host-loader-ok")'))
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.text.trim(), 'host-loader-ok')
})

test('native API import failure stays a mount failure without a filesystem fallback', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const importModule = h.ctx.loader.import.bind(h.ctx.loader)
  h.ctx.loader.import = (specifier, ...rest) => {
    if (specifier === '@deepseek-ai/dsh-scope') throw new Error('fixture Host scope resolution refused')
    return importModule(specifier, ...rest)
  }
  await assert.rejects(h.create(), /fixture Host scope resolution refused/)
  assert.equal(h.adapter.requests.length, 0)
})

test('stdin preserves long Unicode, quotes, literal escapes, CRLF, NUL and EOF bytes', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  const script = '中文 🧪\r\n\'"` $(touch must-not-exist) \\n \\t\0' + 'λ中文'.repeat(30000) + 'END_WITHOUT_NEWLINE'
  const command = `node -e 'const chunks=[]; process.stdin.on("data",c=>chunks.push(c)); process.stdin.on("end",()=>{const b=Buffer.concat(chunks); console.log(JSON.stringify({bytes:b.length,sha256:require("node:crypto").createHash("sha256").update(b).digest("hex")}));});'`
  const input = args(script, { command }), before = structuredClone(input)
  const result = await call(h, agent, input)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(JSON.parse(result.stdout.text), { bytes: Buffer.byteLength(script), sha256: createHash('sha256').update(script).digest('hex') })
  assert.deepEqual(input, before, 'no source repair or newline conversion')
  await assert.rejects(access(join(h.cwd, 'must-not-exist')), { code: 'ENOENT' })
  const empty = await call(h, agent, args('', { command }))
  assert.equal(JSON.parse(empty.stdout.text).bytes, 0, 'empty stdin is closed, not left waiting')
})

test('real PTC executes multiline source and retains canonical outcomes, original evidence and stable SDK', options, async t => {
  const text = '中文 "quoted" \'single\' `ticks` $(not_a_command) \\n'
  const input = args(`/* ${'long 中文 '.repeat(6000)} */\r\nimport assert from 'node:assert/strict';\r\nconst text = ${JSON.stringify(text)};\r\nassert.ok(text.includes('中文'));\r\nconsole.log(JSON.stringify({text, cwd:process.cwd()}));`)
  let step = 0
  const h = await nativeHarness(() => ++step === 1 ? toolResponse('script-ptc', 'run_code', {
    code: `return await tools.apex_run_script(${JSON.stringify(input)});`, description: 'Run source through native stdin',
  }) : textResponse('done'))
  t.after(h.close)
  const agent = await h.create()
  await h.turn(agent, 'Run the supplied source once.')
  const events = agent.session.snapshotEvents()
  const nested = events.filter(e => e.type === 'tool/ptc-dispatch')
  assert.equal(nested.length, 1); assert.equal(nested[0].data.name, 'apex_run_script')
  assert.equal(nested[0].data.isError, false)
  assert.deepEqual(events.find(e => e.type === 'tool/ptc-dispatch-start').data.arguments, input)
  const outer = events.find(e => e.type === 'tool/result').data.message.content[0]
  assert.ok(!outer.isError, JSON.stringify(outer))
  const value = JSON.parse(outer.content[0].text)
  assert.equal(value.exitCode, 0)
  assert.equal(value.workdir, await realpath(h.cwd))
  assert.deepEqual(JSON.parse(value.stdout.text), { text, cwd: value.workdir })
  assert.equal(z.fromJSONSchema((await tool(h, agent)).output.schema).safeParse(value).success, true)
  assert.equal((await tool(h, agent)).presentCall(input).rawInput, input.script)
  const evidence = readExecutionEvidence(agent)
  const row = evidence.results.find(row => row.tool === 'apex_run_script')
  assert.equal(row.toolError, false)
  assert.match(row.outputText, /\[workdir:/)
  assert.equal(row.argumentsExcerpted, true, 'long evidence remains explicitly excerpted')
  assert.equal(evidence.overallAcceptance, 'not-assessed')
  const replay = { session: {
    id: agent.session.id, header: agent.session.header, seq: agent.session.seq,
    eventAt: seq => structuredClone(events[seq]), snapshotEvents: (from = 0) => structuredClone(events.slice(from)),
  } }
  assert.deepEqual(readExecutionEvidence(replay), evidence, 'saved native event shapes replay without another execution')
  assert.equal(h.adapter.requests.length, 2)
  const system = systemText(h.adapter.requests[0])
  for (const map of ['ToolArgsMap', 'ToolOutputMap']) {
    const declaration = system.match(new RegExp(`interface ${map} \\{([\\s\\S]*?)\\n\\}`))?.[1]
    assert.ok(declaration)
    assert.equal((declaration.match(/apex_run_script:/g) ?? []).length, 1, `one entry in ${map}`)
  }
  assert.equal(systemText(h.adapter.requests[1]), system)
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
})

test('the first-request script example is executable verbatim and keeps PTC payloads literal', options, async t => {
  let example, step = 0
  const h = await nativeHarness(request => {
    const system = systemText(request)
    assert.equal(system.split(example).length - 1, 1, 'one executable example in the actual SDK')
    return ++step === 1 ? toolResponse('script-example', 'run_code', { code: example, description: 'Execute the advertised example verbatim' }) : textResponse('done')
  }); t.after(h.close)
  const agent = await h.create(), definition = await tool(h, agent)
  assert.match(definition.parameters.properties.script.description, /outer PTC string is evaluated before this tool/)
  assert.match(definition.description, /tools\.\* exists only in the calling PTC program/)
  assert.match(definition.description, /external interpreters and saved scripts do not inherit it/)
  assert.match(definition.description, /Fetch tool data in PTC, then pass values or workspace files/)
  example = definition.description.split('PTC usage: ')[1]
  assert.ok(example, 'an executable example must be visible before the first use')
  await h.turn(agent, 'Exercise the documented example.')
  const events = agent.session.snapshotEvents()
  const results = events.filter(e => e.type === 'tool/result').flatMap(e => e.data.message.content)
  assert.equal(results.length, 1); assert.ok(!results[0].isError, JSON.stringify(results))
  const result = JSON.parse(results[0].content[0].text)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text.trim(), '`ticks` ${literal}')
  assert.equal(events.filter(e => e.type === 'tool/ptc-dispatch').length, 1)
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
  assert.equal(h.adapter.requests.length, 2)
})

test('external scripts do not inherit the PTC SDK; programmatic values preserve exact text', options, async t => {
  const literal = '中文 🧪 é|e\u0301\r\n"\'` ${literal} \\n\0END'
  let step = 0
  const code = [
    `const payload = ${JSON.stringify(literal)};`,
    'const probe = await tools.apex_run_script({command:"node --input-type=module",description:"Inspect external bindings",script:"console.log(typeof tools);"});',
    'const value = {text:payload};',
    'const forwarded = await tools.apex_run_script({command:"node --input-type=module",description:"Consume plain data",script:"const value = " + JSON.stringify(value) + "; console.log(JSON.stringify(value));"});',
    'const misuse = await tools.apex_run_script({command:"node --input-type=module",description:"Keep SDK misuse as a failure",script:"await tools.apex_read_input({});"});',
    'return {probe,forwarded,misuse};',
  ].join('\n')
  const h = await nativeHarness(() => ++step === 1
    ? toolResponse('script-bindings', 'run_code', { code, description: 'Check interpreter boundaries' })
    : textResponse('done'))
  t.after(h.close)
  const agent = await h.create()
  await h.turn(agent, 'Check the interpreter boundary without adding a tool SDK to it.')
  const events = agent.session.snapshotEvents()
  const outer = events.find(e => e.type === 'tool/result').data.message.content[0]
  assert.ok(!outer.isError, JSON.stringify(outer))
  const { probe, forwarded, misuse } = JSON.parse(outer.content[0].text)
  assert.equal(probe.exitCode, 0); assert.equal(probe.stdout.text.trim(), 'undefined')
  assert.equal(forwarded.exitCode, 0)
  assert.deepEqual(JSON.parse(forwarded.stdout.text), { text: literal })
  assert.equal(misuse.exitCode, 1); assert.match(misuse.stderr.text, /tools is not defined/)
  assert.deepEqual(events.filter(e => e.type === 'tool/ptc-dispatch').map(e => [e.data.name, e.data.isError]),
    Array.from({ length: 3 }, () => ['apex_run_script', false]))
  assert.doesNotMatch(systemText(h.adapter.requests[0]), /^  apex_read_input:/m)
  assert.equal(systemText(h.adapter.requests[1]), systemText(h.adapter.requests[0]))
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
})

test('session-relative imports, explicit directories and concurrent calls never use or mutate Host cwd', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const roots = [join(h.cwd, '项目 A'), join(h.cwd, 'project B')]
  for (const [index, root] of roots.entries()) {
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'artifact.mjs'), `export default ${index}`)
  }
  const agents = await Promise.all(roots.map((root, i) => h.create(`dir-${i}`, 'apex-v1', root)))
  const hostCwd = process.cwd()
  const results = await Promise.all(agents.map(agent => call(h, agent, args(
    'import value from "./artifact.mjs"; await new Promise(r=>setTimeout(r,20)); console.log(JSON.stringify({value,cwd:process.cwd(),env:process.env.DSH_CWD}));',
  ))))
  for (const [index, result] of results.entries()) {
    assert.equal(result.exitCode, 0)
    const cwd = await realpath(roots[index])
    assert.equal(result.workdir, cwd)
    const output = JSON.parse(result.stdout.text)
    assert.equal(output.value, index); assert.equal(output.cwd, cwd)
  }
  const sub = await call(h, agents[0], args('console.log(process.cwd()); process.chdir("..");', { workdir: 'sub' }))
  assert.equal(sub.workdir, await realpath(join(roots[0], 'sub')))
  assert.equal(sub.stdout.text.trim(), sub.workdir)
  const next = await call(h, agents[0], args('console.log(process.cwd());'))
  assert.equal(next.workdir, await realpath(roots[0])); assert.equal(next.stdout.text.trim(), next.workdir)
  const absolute = await call(h, agents[1], args('console.log(process.cwd());', { workdir: roots[0] }))
  assert.equal(absolute.workdir, next.workdir)
  assert.equal(process.cwd(), hostCwd)
  const definition = await tool(h, agents[0])
  await assert.rejects(definition.execute(args('console.log("must not run")'), { signal: new AbortController().signal }), /refusing Host cwd fallback/)
})

test('disposable stdin checks avoid the extra module directory and preserve shell statement separators', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  await mkdir(join(h.cwd, 'src'))
  await mkdir(join(h.cwd, 'verify'))
  await writeFile(join(h.cwd, 'src/value.mjs'), 'export const value = 42;')
  const source = "import assert from 'node:assert/strict';\nimport {value} from './src/value.mjs';\nassert.equal(value, 42);\nassert.match('ok (1.5ms)', / \\([0-9.]+ms\\)$/);\nconsole.log('verified');"
  await writeFile(join(h.cwd, 'verify/check.mjs'), source)
  const bash = await tool(h, agent, 'bash')
  const execute = command => bash.execute({ command, description: 'Exercise module and command boundaries' }, { agent, signal: new AbortController().signal })
  const misplaced = await execute('node verify/check.mjs')
  assert.equal(misplaced.exitCode, 1)
  assert.match(misplaced.stderr.text, /ERR_MODULE_NOT_FOUND/)
  assert.match(misplaced.stderr.text, /verify\/src\/value\.mjs/)
  const stdin = await call(h, agent, args(source))
  assert.equal(stdin.exitCode, 0); assert.equal(stdin.stdout.text.trim(), 'verified')
  assert.equal(await readFile(join(h.cwd, 'verify/check.mjs'), 'utf8'), source, 'the tool does not repair saved modules')
  const statements = ['(printf first)', '(printf second)']
  const broken = await execute(statements.join(' '))
  assert.equal(broken.exitCode, 2); assert.match(broken.stderr.text, /syntax error/)
  const lines = await call(h, agent, args(statements.join('\n'), { command: 'bash -s' }))
  assert.equal(lines.exitCode, 0); assert.equal(lines.stdout.text, 'firstsecond')
})

test('explicit ready test files avoid premature discovery without hiding missing imports or assertion failures', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create(), bash = await tool(h, agent, 'bash')
  await mkdir(join(h.cwd, 'test'))
  await writeFile(join(h.cwd, 'test/ready.test.mjs'), "import assert from 'node:assert/strict'; import {test} from 'node:test'; test('ready',()=>assert.equal(2+2,4));")
  await writeFile(join(h.cwd, 'test/pending.test.mjs'), "import './pending.mjs';")
  // Only this nested test fixture removes the outer runner's marker; otherwise
  // node:test skips the inner suite as recursive and exits zero without tests.
  const execute = command => bash.execute({ command: `env -u NODE_TEST_CONTEXT ${command}`, description: 'Exercise native test selection' }, { agent, signal: new AbortController().signal })
  const directory = await execute('node --test test/')
  assert.equal(directory.exitCode, 1, directory.stdout.text + directory.stderr.text)
  assert.match(directory.stdout.text + directory.stderr.text, /MODULE_NOT_FOUND/)
  const discovered = await execute('node --test')
  assert.equal(discovered.exitCode, 1); assert.match(discovered.stdout.text + discovered.stderr.text, /ERR_MODULE_NOT_FOUND/)
  const selected = await execute('node --test test/ready.test.mjs')
  assert.equal(selected.exitCode, 0); assert.match(selected.stdout.text, /ready/)
  // A file now being present does not prove its assertions: a real failure stays nonzero.
  await writeFile(join(h.cwd, 'test/pending.mjs'), "import assert from 'node:assert/strict'; assert.equal(2+2,5);")
  const failed = await execute('node --test')
  assert.equal(failed.exitCode, 1); assert.match(failed.stdout.text + failed.stderr.text, /ERR_ASSERTION/)
})

test('nonzero, assertion text, missing runtime, syntax errors and truncated output are independent facts', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create(), definition = await tool(h, agent)
  const outcomes = [
    [args('console.error("failed fixture"); process.exitCode=7;'), 7, /failed fixture/],
    [args('console.log("tests: 10 pass, 2 fail");'), 0, /2 fail/],
    [args('console.log(1);\\nconsole.log(2);'), 1, /SyntaxError/],
    [args('', { command: 'apex_nonexistent_interpreter_fixture_39d5' }), 127, /command not found/],
    [args('ignored input'.repeat(60000), { command: 'false' }), 1, /^$/],
  ]
  for (const [input, exit, expected] of outcomes) {
    const value = await call(h, agent, input)
    assert.equal(value.exitCode, exit); assert.equal(value.timedOut, false)
    assert.match(value.stdout.text + value.stderr.text, expected)
    assert.equal(Object.hasOwn(value, 'passed'), false)
    assert.equal(Object.hasOwn(value, 'isError'), false)
    const content = definition.output.render(input, value)
    const ui = definition.presentResult(input, { content, isError: false })
    assert.equal(ui.card, 'terminal')
    if (exit !== 0) assert.match(content[0].text, new RegExp(`\\[exit code: ${exit}\\]`))
    assert.match(content[0].text, /\[workdir:/)
  }
  const long = await call(h, agent, args('process.stdout.write("x".repeat(80000));'))
  assert.equal(long.stdout.truncated, true); assert.ok(long.stdout.spillPath)
  assert.equal((await readFile(long.stdout.spillPath)).length, 80000)
  // Executor-owned spill files are test artifacts; do not leave this fixture's output behind.
  await rm(long.stdout.spillPath)
  for (const invalid of [
    args('1', { command: '  ' }), args('1', { description: '' }), args('1', { timeoutMs: 0 }),
    args('1', { timeoutMs: Infinity }), args('1', { run_in_background: true }), args('1', { env: { EXTRA: 'not exposed' } }),
    args('\ud800'), args('1', { sandbox_permissions: 'danger-full-access' }), args('1', { justification: 'orphan' }),
  ]) await assert.rejects(call(h, agent, invalid))
  assert.equal(h.adapter.requests.length, 0)
})

test('native policy and approval remain per-session and one-shot; full file access retains signal isolation', options, async t => {
  let pending, serial = 0
  const h = await nativeHarness(() => {
    if (!pending) return textResponse('done')
    const input = pending; pending = undefined
    return toolResponse(`approval-${++serial}`, 'run_code', {
      code: `return await tools.apex_run_script(${JSON.stringify(input)});`, description: 'Request native script approval',
    })
  }); t.after(h.close)
  // Outside the system temp root, which the native workspace-write mode also permits.
  const root = await mkdtemp(join(pluginRoot, '.apex-script-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); await mkdir(workspace)
  const agent = await h.create('policy-script', 'apex-v1', workspace)
  async function inTurn(input) {
    const seq = agent.session.seq; pending = input
    await h.turn(agent, 'Exercise one native approval path.')
    const events = agent.session.snapshotEvents(seq)
    const nested = events.find(e => e.type === 'tool/ptc-dispatch').data
    const outer = events.find(e => e.type === 'tool/result').data.message.content[0]
    return { nested, value: outer.isError ? undefined : JSON.parse(outer.content[0].text), events }
  }
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(sentinel, 'spawn')
  t.after(async () => {
    if (sentinel.exitCode !== null || sentinel.signalCode !== null) return
    const exited = once(sentinel, 'exit'); sentinel.kill(); await exited
  })
  const outside = join(root, 'outside.txt'), inside = join(workspace, 'inside.txt')
  const write = file => args(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(file)}, 'fixture');`)
  const denied = await call(h, agent, write(outside))
  assert.notEqual(denied.exitCode, 0); assert.equal(denied.sandbox.denied, true)
  await assert.rejects(access(outside), { code: 'ENOENT' })
  const { setSandboxMode } = await native('dsh-sandbox-policy')
  setSandboxMode(agent.session, 'read-only')
  const readOnly = await call(h, agent, write(inside))
  assert.notEqual(readOnly.exitCode, 0); assert.equal(readOnly.sandbox.mode, 'read-only')
  const rejected = await inTurn({ ...write(outside), sandbox_permissions: 'danger-full-access', justification: 'Fixture approval must be refused' })
  assert.equal(rejected.nested.isError, true)
  assert.match(JSON.stringify(rejected.nested.content), /rejected/)
  assert.deepEqual(rejected.events.filter(e => e.type.startsWith('approval/')).map(e => e.type), ['approval/asked', 'approval/decided'])
  assert.equal(rejected.events.find(e => e.type === 'approval/decided').data.outcome, 'rejected')
  const requests = []
  const { setApprovalPolicy } = await native('dsh-user-approval')
  setApprovalPolicy(agent.session, 'ask')
  const stopAnswering = h.ctx.on('approval/request', async request => { requests.push(request); return 'allowed-once' })
  const allowed = await inTurn({ ...write(inside), sandbox_permissions: 'workspace-write', justification: 'Allow only this fixture write' })
  assert.equal(allowed.nested.isError, false)
  assert.equal(allowed.value.exitCode, 0); assert.equal(allowed.value.sandbox.mode, 'workspace-write')
  assert.equal(allowed.events.find(e => e.type === 'approval/decided').data.outcome, 'allowed-once')
  assert.equal(requests.length, 1); assert.equal(requests[0].toolName, 'apex_run_script')
  assert.equal(requests[0].agent.id, agent.id); assert.equal(requests[0].callId, allowed.nested.subCallId)
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only')
  const again = await call(h, agent, write(inside)); assert.notEqual(again.exitCode, 0)
  setSandboxMode(agent.session, 'workspace-write')
  await assert.rejects(call(h, agent, { ...write(inside), sandbox_permissions: 'workspace-write', justification: 'Not a widening request' }), /not strictly wider/)
  assert.equal(requests.length, 1, 'invalid escalation does not reach approval')
  stopAnswering()
  setSandboxMode(agent.session, 'danger-full-access')
  const signal = await call(h, agent, args(`try { process.kill(${sentinel.pid}, 'SIGTERM'); console.log('UNSAFE'); } catch(e) {console.log(e.code);}`))
  assert.equal(signal.sandbox.mode, 'danger-full-access'); assert.match(signal.stdout.text, /EPERM/)
  assert.equal(sentinel.signalCode, null)
})

test('pre-abort, active cancellation, timeout and owned descendants retain native cleanup semantics', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create(), canary = join(h.cwd, 'must-not-run')
  const stopped = new AbortController(); stopped.abort(new Error('pre-aborted script'))
  await assert.rejects(call(h, agent, args(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(canary)}, 'wrong');`), stopped.signal), /pre-aborted script/)
  await assert.rejects(access(canary), { code: 'ENOENT' })
  const ready = join(h.cwd, 'owned-pids.json'), controller = new AbortController()
  const running = call(h, agent, args(`
    import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    child.on('spawn',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid])));
    setInterval(()=>{},1000);
  `), controller.signal)
  const cancelled = assert.rejects(running, error => error.name === 'AbortError')
  const pids = await untilFile(ready); controller.abort(new Error('cancel active script'))
  await cancelled
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const timed = await call(h, agent, args('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);', { timeoutMs: 1000 }))
  assert.equal(timed.exitCode, 0, 'the fixture deliberately traps SIGTERM and exits zero')
  assert.equal(timed.timedOut, true); assert.equal(timed.timeoutMs, 1000)
  const rendered = (await tool(h, agent)).output.render({}, timed)[0].text
  assert.match(rendered, /timed out after 1000ms/)
})

test('native execution guard blocks stdin scripts before spawn and official scopes have no new tool', options, async t => {
  const canaryName = 'guard-must-not-run'
  let step = 0
  const h = await nativeHarness(() => ++step === 1 ? toolResponse('guard-script', 'run_code', {
    code: `return await tools.apex_run_script(${JSON.stringify(args(`import {writeFileSync} from 'node:fs'; writeFileSync('${canaryName}', 'wrong');`))});`,
    description: 'Probe native execution guard',
  }) : textResponse('denied'), { shippedPresets: true })
  t.after(h.close)
  const official = await h.create('official', 'ptc'), agent = await h.create()
  assert.equal(await tool(h, official), undefined)
  agent.ctx.tools.guard(exec => exec.name === 'apex_run_script' ? 'Fixture native policy denial' : undefined)
  await h.turn(agent, 'Attempt one guarded call.')
  await assert.rejects(access(join(h.cwd, canaryName)), { code: 'ENOENT' })
  const result = agent.session.snapshotEvents().find(e => e.type === 'tool/ptc-dispatch')
  assert.equal(result.data.isError, true)
  assert.match(JSON.stringify(result.data.content), /Fixture native policy denial/)
  const bash = await tool(h, agent, 'bash'), nativeBash = await tool(h, official, 'bash')
  assert.deepEqual(bash.parameters, nativeBash.parameters)
  assert.deepEqual(bash.output.schema, nativeBash.output.schema)
  assert.equal(h.adapter.requests.length, 2, 'a denied script is not automatically retried')
})

test('cancelling an actual approval turn cannot execute the script after a late grant', options, async t => {
  let requested = false, answer
  const h = await nativeHarness(() => {
    if (requested) return textResponse('stopped')
    requested = true
    return toolResponse('cancel-approval', 'run_code', {
      code: `return await tools.apex_run_script(${JSON.stringify(args('import {writeFileSync} from "node:fs"; writeFileSync("approval-must-not-run", "wrong");', {
        sandbox_permissions: 'workspace-write', justification: 'Cancelable fixture question',
      }))});`, description: 'Exercise cancellation while awaiting approval',
    })
  }); t.after(h.close)
  const agent = await h.create()
  const { setSandboxMode } = await native('dsh-sandbox-policy')
  const { setApprovalPolicy } = await native('dsh-user-approval')
  setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'ask')
  h.ctx.on('approval/request', async () => new Promise(resolve => { answer = resolve }))
  const turn = h.turn(agent, 'Run one cancellation fixture.')
  for (let i = 0; i < 250 && !answer; i++) await delay(20)
  assert.equal(typeof answer, 'function')
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await turn
  answer('allowed-once'); await delay(20); await agent.whenIdle()
  await assert.rejects(access(join(h.cwd, 'approval-must-not-run')), { code: 'ENOENT' })
  assert.equal(agent.session.snapshotEvents().find(e => e.type === 'approval/decided').data.outcome, 'cancelled')
  assert.equal(h.adapter.requests.length, 1, 'late approval cannot restart a cancelled model turn')
})
