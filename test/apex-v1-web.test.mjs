import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { promises as fs } from 'node:fs'
import { Server } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { nativeHarness, harnessAvailable, native, textResponse, toolResponse } from './helpers/harness-v1.mjs'
import { artifactSnapshot, screenshotIdentity } from '../presets/apex-v1/artifacts.mjs'
import * as validation from '../presets/apex-v1/validation.mjs'

const signal = () => new AbortController().signal
const base = { check_id: 'fixture', assertion: 'Only the configured checks', root: '.', interaction_required: false, settle_ms: 0, sample_ms: 500 }
const options = { skip: !harnessAvailable, timeout: 30000 }
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apex-v1-files-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, agent: { session: { header: { cwd: root } } } }
}
// Use the existing native process service, without another Harness home or model adapter.
async function browserFixture(t) {
  const { Context } = await native('cordis')
  const { default: Subprocess } = await native('dsh-subprocess-local')
  const ctx = new Context(), owner = await ctx.plugin(Subprocess)
  t.after(() => owner.dispose())
  const { root, agent } = await fixture(t)
  let tool
  validation.apply({ subprocess: ctx.subprocess, tools: { register(value) { tool = value } } })
  return { root, ctx, run: (args, abort = t.signal) => tool.execute(args, { agent, signal: abort }) }
}
function removeCapture(t, result) {
  if (result.screenshotPath) {
    assert.match(dirname(result.screenshotPath).split('/').at(-1), /^dsh-apex-evidence-/)
    t.after(() => rm(dirname(result.screenshotPath), { recursive: true, force: true }))
  }
}
async function web(h, agent, args, abort = signal()) {
  const { scopeOf } = await native('dsh-scope')
  return h.ctx.tools.get('apex_validate_web', scopeOf(agent.ctx)).execute(args, { agent, signal: abort })
}

test('artifact hashes cover content, reject unsafe trees and honor cancellation', async t => {
  const { root, agent } = await fixture(t)
  await writeFile(join(root, 'index.html'), 'before')
  const first = await artifactSnapshot(agent, '.', signal())
  assert.equal((await artifactSnapshot(agent, '.', signal())).hash, first.hash)
  await writeFile(join(root, 'index.html'), 'after')
  assert.notEqual((await artifactSnapshot(agent, '.', signal())).hash, first.hash)
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules/ignored'), 'dependency')
  assert.equal((await artifactSnapshot(agent, '.', signal())).fileCount, 1)
  await assert.rejects(artifactSnapshot(agent, '..', signal()), /inside/)
  await symlink(join(root, 'index.html'), join(root, 'link'))
  await assert.rejects(artifactSnapshot(agent, '.', signal()), /non-regular/)
  const controller = new AbortController(); controller.abort(new Error('stop hash'))
  await assert.rejects(artifactSnapshot(agent, '.', controller.signal), /stop hash/)
})

for (const phase of ['before-start', 'during-listen', 'bind-failure']) {
  test(`static server cleans up ${phase} and its abort subscription`, async t => {
    const { root } = await fixture(t)
    const controller = new AbortController(), cause = new Error('stop static fixture')
    let server
    if (phase === 'before-start') controller.abort(cause)
    else {
      const listen = Server.prototype.listen
      t.mock.method(Server.prototype, 'listen', function (...args) {
        server = this
        if (phase === 'bind-failure') { queueMicrotask(() => this.emit('error', cause)); return this }
        const result = listen.apply(this, args); controller.abort(cause); return result
      })
    }
    await assert.rejects(validation.startStaticServer(root, controller.signal), e => e === cause || e.cause === cause)
    await new Promise(setImmediate)
    assert.equal(server?.listening ?? false, false)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

test('static server is read-only and cannot traverse or serve escaping symlinks', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'site'))
  await writeFile(join(root, 'outside'), 'not public')
  await writeFile(join(root, 'site/index.html'), 'public')
  await symlink(join(root, 'outside'), join(root, 'site/link'))
  const server = await validation.startStaticServer(join(root, 'site'), signal()); t.after(server.close)
  assert.equal(await (await fetch(server.origin)).text(), 'public')
  for (const path of ['/link', '/%2e%2e%2foutside', '/bad%00', '/bad%5coutside']) assert.equal((await fetch(server.origin + path)).status, 404)
  assert.equal((await fetch(server.origin, { method: 'POST' })).status, 405)
})

test('invalid parameters fail before browser or artifact I/O without rewriting arguments', async () => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  for (const patch of [{ width: 0 }, { timeout_ms: 100 }, { root: '' }, { required_selectors: ['#old'] },
    { selector_checks: Array(17).fill({ selector: '#a', state: 'present' }) },
    { interactions: [{ selector: '#a', text: 'a'.repeat(4097) }] },
    { interactions: [{ selector: '#a', text: '', click_selector: '#b' }] }]) {
    const args = { ...base, ...patch }, copy = structuredClone(args)
    await assert.rejects(tool.execute(args, {}), /apex_validate_web:/)
    assert.deepEqual(args, copy)
  }
})

test('validation schemas distinguish request echoes, result arrays and empty text expectations', () => {
  let tool
  const parameters = structuredClone(validation.VALIDATION_PARAMETERS)
  validation.apply({ tools: { register(value) { tool = value } } })
  const fields = value => JSON.parse(JSON.stringify(value,
    (key, child) => key === 'description' && typeof child === 'string' ? undefined : child))
  const output = tool.output.schema.properties
  assert.equal(output.checks.type, 'object')
  assert.match(output.checks.description, /request parameters.*not an array of results/)
  assert.match(output.checks.description, /status.*detail.*failedTextChecks.*failedSequenceChecks/)
  assert.deepEqual(validation.VALIDATION_PARAMETERS, parameters, 'registration must not mutate input guidance or constraints')
  assert.deepEqual(fields(validation.VALIDATION_OUTPUT.properties.checks), fields(parameters), 'retain every raw field, required key and constraint')
  assert.deepEqual(fields(output.checks), fields(tool.parameters), 'keep every public echo field and type')
  assert.doesNotMatch(JSON.stringify(validation.VALIDATION_OUTPUT.properties.checks.properties), /"description":/, 'input guidance is not duplicated in the raw echo')
  assert.match(output.checks.properties.timeout_ms.description, /minimum=5000, maximum=60000/, 'generated constraint guidance remains visible')
  assert.match(output.sequenceChecks.description, /summary strings.*not objects/)
  for (const contains of [tool.parameters.properties.text_checks.items.properties.contains,
    tool.parameters.properties.clock_steps.items.properties.checks.items.properties.contains]) {
    assert.match(contains.description, /Non-empty substring/)
    assert.match(contains.description, /complete textContent.*excerpts may be truncated/)
    assert.match(contains.description, /equals:"".*empty.*selector_checks.*existence/)
  }
  assert.match(tool.parameters.properties.clock_steps.items.properties.run_callbacks.description,
    /before.*action.*later step.*run_callbacks:true/)
})

test('validation SDK renders input guidance once without weakening typed request echoes', { skip: !harnessAvailable }, async t => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  const { renderToolsSdk, renderToolsSdkPy, validateJsonSchemaValue } = await native('dsh-tools')
  const current = { name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema }
  const previous = { ...current, output: { ...current.output, properties: { ...current.output.properties,
    checks: { ...tool.parameters, description: current.output.properties.checks.description },
  } } }
  const guidance = 'Programmatic enabled range input:'
  const inputCopies = JSON.stringify(tool.parameters).split(guidance).length - 1
  assert.equal(inputCopies, 2, 'range is available in ordinary actions and controlled checkpoints')
  for (const [language, render] of [['TypeScript', renderToolsSdk], ['Python', renderToolsSdkPy]]) {
    const before = render([previous]), after = render([current])
    assert.equal(before.split(guidance).length - 1, inputCopies * 2)
    assert.equal(after.split(guidance).length - 1, inputCopies, `${language} keeps the input guidance but omits its echo copy`)
    assert.ok(after.length < before.length, `${language} SDK must shrink`)
    t.diagnostic(`${language} SDK: ${before.length} -> ${after.length} characters`)
  }
  const echo = tool.output.schema.properties.checks
  assert.deepEqual(validateJsonSchemaValue(echo, base), [])
  for (const invalid of [[], { ...base, root: 1 }, { ...base, interaction_required: undefined },
    { ...base, unexpected: true }, { ...base, require_graphics_api: 'invalid' }]) {
    assert.ok(validateJsonSchemaValue(echo, invalid).length > 0, 'the typed echo still rejects invalid result values')
  }
  const controller = new AbortController(), reason = new Error('cancel before browser I/O')
  controller.abort(reason)
  await assert.rejects(tool.execute(base, { signal: controller.signal }), error => error === reason)
})

test('empty contains stays an input error while explicit empty-state and existence checks remain valid', async () => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  for (const args of [
    { ...base, text_checks: [{ phase: 'after', selector: '#status', contains: '' }] },
    { check_id: 'empty', assertion: 'Empty state', root: '.', interaction_required: false,
      clock_steps: [{ at_ms: 0, run_callbacks: false, checks: [{ selector: '#status', contains: '' }] }] },
  ]) {
    const original = structuredClone(args)
    await assert.rejects(tool.execute(args, {}), /(?:text_checks\.0|clock_steps\.0\.checks\.0)\.contains:/)
    assert.deepEqual(args, original, 'do not reinterpret an empty substring as a passing check')
  }
  assert.equal(validation.textContractDenial({ text_checks: [{ phase: 'after', selector: '#status', equals: '' }] }), undefined)
  assert.equal(validation.clockContractDenial({ clock_steps: [
    { at_ms: 0, run_callbacks: false, checks: [{ selector: '#status', equals: '' }] },
  ] }), undefined)
})

test('ordered control actions accept finite range values, exact option values and native navigation keys', async () => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  const controller = new AbortController(), reason = new Error('schema accepted; stop before browser')
  controller.abort(reason)
  for (const action of [{ input: { selector: '#speed', value: 0.5 } },
    { select: { selector: '#mode', value: '' } },
    ...['Tab', 'Enter', 'Escape', 'Home', 'End'].map(key => ({ key, hold_ms: 0 }))]) {
    const args = { ...base, interaction_required: true, interactions: [action] }
    assert.equal(validation.interactionContractDenial(args), undefined)
    await assert.rejects(tool.execute(args, { signal: controller.signal }), error => error === reason)
  }
  for (const action of [{ input: { selector: '#speed', value: Infinity } },
    { input: { selector: '#speed', value: '2' } }, { select: { selector: '#mode', value: 2 } },
    { select: { selector: '#mode', value: 'x'.repeat(513) } },
    { input: { selector: '', value: 2 } }, { select: { selector: '#mode' } },
    { input: { selector: '#speed', value: 2 }, click_selector: '#go' },
    { input: { selector: '#speed', value: 2 }, select: { selector: '#mode', value: 'a' } }]) {
    const args = { ...base, interactions: [action] }, before = structuredClone(args)
    await assert.rejects(tool.execute(args, {}), /apex_validate_web:/)
    assert.deepEqual(args, before)
  }
})

test('ordered action errors expose bounded field diagnostics without changing or accepting invalid input', async () => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  for (const [action, expected] of [
    [{ key: 'KeyW', hold_ms: 2500 }, /interactions\.0\.hold_ms:.*<=2000/],
    [{ selector: '#text', text: 'x'.repeat(4097) }, /interactions\.0\.text:.*<=4096/],
    [{ wait_ms: 10001 }, /interactions\.0\.wait_ms:.*<=10000/],
    [{ click_selector: '#start', key: 'KeyW', hold_ms: 0 }, /Unrecognized key/],
  ]) {
    const args = { ...base, interactions: [action] }, before = structuredClone(args)
    await assert.rejects(tool.execute(args, {}), error => {
      assert.match(error.message, expected)
      assert.ok(error.message.length <= 4200)
      return true
    })
    assert.deepEqual(args, before)
  }
  await assert.rejects(tool.execute({ ...base, pointer_lock_selector: '#view',
    interactions: [{ click_selector: '#start' }] }, {}), /same level.*put both fields on that action/)
  assert.equal(validation.interactionContractDenial({ ...base,
    interactions: [{ click_selector: '#start', pointer_lock_selector: '#view' }] }), undefined)
})

test('reload parameters preserve input claims and reject incompatible sampling before browser I/O', async () => {
  let tool
  validation.apply({ tools: { register(value) { tool = value } } })
  const controller = new AbortController(), reason = new Error('reload schema accepted')
  controller.abort(reason)
  const args = { ...base, interactions: [{ reload: true }] }
  await assert.rejects(tool.execute(args, { signal: controller.signal }), error => error === reason)
  assert.equal(validation.interactionContractDenial(args), undefined)
  assert.match(validation.interactionContractDenial({ ...args, interaction_required: true }), /reload.*never executes an input action/)
  for (const patch of [
    { interactions: [{ reload: false }] }, { interactions: [{ reload: 'true' }] },
    { interactions: [{ reload: true, wait_ms: 0 }] },
    { interactions: [{ reload: true, click_selector: '#save' }] },
    { interactions: Array(9).fill({ reload: true }) },
    { sequence_start: 'before-actions' },
    { clock_steps: [{ at_ms: 0, run_callbacks: false, checks: [{ selector: '#out', equals: '' }] }] },
  ]) {
    const invalid = { ...args, ...patch }, original = structuredClone(invalid)
    await assert.rejects(tool.execute(invalid, {}), /apex_validate_web:|cannot be combined/)
    assert.deepEqual(invalid, original)
  }
})

test('failed browser startup removes its profile only after confirmed process-range exit', async t => {
  const { root, agent } = await fixture(t)
  await writeFile(join(root, 'index.html'), '<!doctype html><p>Fixture</p>')
  const sentinel = join(root, 'unrelated.txt')
  await writeFile(sentinel, 'preserved')
  for (const exit of ['confirmed', 'unconfirmed', 'error']) {
    let profile, terminations = 0
    const result = await validation.runValidation({ subprocess: {
      async resolveExecutable() { return 'fixture-browser' },
      spawn(request) {
        profile = request.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
        assert.match(profile, /dsh-apex-web-/)
        t.after(() => rm(profile, { recursive: true, force: true }))
        return {
          done: Promise.resolve({ exitCode: 1 }),
          terminate() { terminations++; if (exit === 'error') throw new Error('fixture cleanup failure') },
          async waitForExit() { return exit === 'confirmed' },
        }
      },
    } }, base, { agent, signal: signal() })
    assert.equal(result.status, 'blocked')
    assert.equal(result.metricsKind, 'not-measured')
    assert.equal(result.fps, 0)
    assert.equal(result.p95FrameMs, 0)
    assert.match(result.detail, /browser exited before DevTools/)
    assert.match(result.cleanup, /server-closed/)
    assert.equal(result.overallAcceptance, 'not-assessed')
    if (exit === 'confirmed') {
      assert.match(result.cleanup, /browser-terminated,profile-removed/)
      await assert.rejects(realpath(profile), { code: 'ENOENT' })
      assert.ok(!result.warnings.some(w => w.includes('profile retained')))
    } else {
      assert.ok((await lstat(profile)).isDirectory())
      assert.match(result.cleanup, exit === 'error' ? /browser-cleanup-failed/ : /browser-still-live/)
      assert.ok(result.detail.includes(profile), 'retained path is not lost to the bounded warnings list')
      assert.ok(result.warnings.some(w => w.includes(profile) && w.includes('verifiably stopped')))
      assert.doesNotMatch(result.cleanup, /profile-removed/)
    }
    assert.equal(terminations, exit === 'unconfirmed' ? 2 : 1)
    assert.equal(await readFile(sentinel, 'utf8'), 'preserved')
  }
})

test('missing browser returns blocked evidence, never installs or reports a pass', async t => {
  const { root, agent } = await fixture(t)
  await writeFile(join(root, 'index.html'), 'empty')
  const result = await validation.runValidation({ subprocess: {
    async resolveExecutable() { throw new Error('fixture browser missing') },
    spawn() { assert.fail('No browser may start') },
  } }, base, { agent, signal: signal() })
  assert.equal(result.status, 'blocked')
  assert.equal(result.metricsKind, 'not-measured')
  assert.equal(result.fps, 0)
  assert.equal(result.p95FrameMs, 0)
  assert.equal(result.artifactStable, true)
  assert.match(result.detail, /No existing Chrome/)
  assert.match(result.detail, /rAF not measured.*unmeasured placeholders/)
  assert.equal(result.cleanup, 'nothing-started')
})

test('real headless browser distinguishes presence, layout and viewport; normalizes textarea newlines', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), `<!doctype html><title>Generic form fixture</title>
    <style>#outside,#offcanvas{position:absolute;top:1800px}#empty{height:0}#hidden{display:none}</style>
    <canvas id="offcanvas"></canvas><div id="empty"></div><div id="hidden">hidden</div>
    <div id="outside">offscreen</div><textarea id="input"></textarea><pre id="output"></pre>
    <script>document.querySelector('#input').addEventListener('input', e=>document.querySelector('#output').textContent=e.target.value)</script>`)
  const agent = await h.create()
  const result = await web(h, agent, { ...base, interaction_required: true,
    interactions: [{ selector: '#input', text: '中文\r\nsecond\rthird' }],
    selector_checks: [{ selector: '#empty', state: 'present' }, { selector: '#empty', state: 'hidden' },
      { selector: '#hidden', state: 'hidden' }, { selector: '#outside', state: 'visible' },
      { selector: '#input', state: 'in-viewport' }, { selector: '#missing', state: 'absent' }],
    text_checks: [{ phase: 'before', selector: '#output', equals: '' }, { phase: 'after', selector: '#output', equals: '中文\nsecond\nthird' }],
  }); removeCapture(t, result)
  assert.equal(result.status, 'passed', result.detail)
  assert.equal(result.selectorChecks.find(x => x.selector === '#outside').inViewport, false)
  assert.equal(result.visibleCanvasCount, 0, 'Array.filter index must not disable viewport checks for its first canvas')
  assert.equal(result.canvasCount, 1)
  assert.equal(result.metricsKind, 'instrumented-raf')
  assert.ok(result.fps > 0)
  assert.ok(result.p95FrameMs > 0)
  assert.match(result.detail, /rAF sample: \d+ callbacks over [\d.]+ ms; not GPU frame throughput/)
  assert.equal(result.overallAcceptance, 'not-assessed')
  assert.equal(result.artifactStable, true)
  assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
  assert.equal((await screenshotIdentity(result.screenshotPath)).hash, result.screenshotHash)
})

test('closed disclosures pass automatic scanning while hidden clicks remain failures', options, async t => {
  const { root, run } = await browserFixture(t)
  await writeFile(join(root, 'index.html'), `<!doctype html><details><summary id="toggle">Open</summary>
    <button id="target" onclick="document.querySelector('#count').textContent='1'">Click</button></details><output id="count">0</output>`)
  const closed = await run({ ...base, selector_checks: [{ selector: '#target', state: 'hidden' }] })
  removeCapture(t, closed)
  assert.equal(closed.status, 'passed', closed.detail)
  assert.deepEqual(closed.layoutErrors, [])
  const denied = await run({ ...base, click_selector: '#target', interaction_required: true })
  removeCapture(t, denied)
  assert.equal(denied.status, 'failed')
  assert.match(denied.detail, /target is hidden/)
  assert.deepEqual(denied.layoutErrors, [], 'Hidden input denial is not an occlusion defect')
  const opened = await run({ ...base, interaction_required: true,
    interactions: [{ click_selector: '#toggle' }, { click_selector: '#target' }],
    text_checks: [{ phase: 'after', selector: '#count', equals: '1' }] })
  removeCapture(t, opened)
  assert.equal(opened.status, 'passed', opened.detail)
})

test('real browser compares full text while keeping sequence and clock evidence bounded', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), `<!doctype html><button id="change">Change tail</button><p id="text"></p>
    <script>
      const output = document.querySelector('#text'), prefix = 'x'.repeat(499);
      output.textContent = prefix + '1000 目标';
      document.querySelector('#change').onclick = () => output.textContent = prefix + '1001 目标';
    </script>`)
  const agent = await h.create()
  const realtime = await web(h, agent, { ...base, interaction_required: true, click_selector: '#change',
    sequence_start: 'before-actions', text_checks: [{ phase: 'after', selector: '#text', contains: '目标' }],
    sequence_checks: [
      { id: 'stable', selector: '#text', expectation: 'stable' },
      { id: 'changed', selector: '#text', expectation: 'changes' },
      { id: 'growth', selector: '#text', expectation: 'numeric-progress', min_delta: 1 },
      { id: 'tail', selector: '#text', expectation: 'contains-throughout', contains: '目标' },
    ],
  }); removeCapture(t, realtime)
  assert.equal(realtime.status, 'failed', realtime.detail)
  assert.deepEqual(realtime.failedTextChecks, [])
  assert.equal(realtime.failedSequenceChecks.length, 1)
  assert.match(realtime.failedSequenceChecks[0], /stable.*remain stable/)
  assert.ok(realtime.sequenceChecks.slice(1).every(check => check.includes(':passed')))
  assert.match(realtime.sequenceChecks[2], /observedNumbers=\[1000,1001/)
  const clock = await web(h, agent, { check_id: 'long-clock', assertion: 'Use complete numeric tokens', root: '.', interaction_required: false,
    clock_steps: [{ at_ms: 0, run_callbacks: false, checks: [
      { selector: '#text', contains: '目标', min: 1000, max: 1000 }, { selector: '#text', max: 10 },
    ] }],
  }); removeCapture(t, clock)
  assert.equal(clock.status, 'failed', clock.detail)
  assert.equal(clock.failedSequenceChecks.length, 1)
  assert.match(clock.sequenceChecks[0], /:passed/)
  assert.match(clock.failedSequenceChecks[0], /observedNumber=1000/)
  for (const result of [realtime, clock]) {
    assert.ok(result.sequenceChecks.every(check => check.length < 2000))
    assert.equal(result.artifactStable, true)
    assert.equal(result.overallAcceptance, 'not-assessed')
    assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
  }
})

test('real controlled clock and native PTC output keep evidence identities and image delivery', options, async t => {
  const args = { check_id: 'clock', assertion: 'Callback receives controlled time', root: '.', interaction_required: false,
    clock_steps: [{ at_ms: 500, run_callbacks: true, checks: [{ selector: '#time', equals: '500' }] }] }
  let step = 0
  const h = await nativeHarness(() => ++step === 1 ? toolResponse('clock', 'run_code', {
    description: 'Controlled clock fixture', code: `const result = await tools.apex_validate_web(${JSON.stringify(args)}); await tools.read_image({file_path: result.screenshotPath}); return {status: result.status, checkId: result.checks.check_id, failures: [...result.failedTextChecks, ...result.failedSequenceChecks].map(message => String(message))};`,
  }) : textResponse('Evidence recorded, not a visual quality verdict.')); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), '<!doctype html><p id="time">0</p><script>requestAnimationFrame(now=>document.querySelector("#time").textContent=String(now))</script>')
  const a = await h.create(); await h.turn(a, 'Run controlled timing fixture.')
  const event = a.session.snapshotEvents().find(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'apex_validate_web')
  assert.equal(event.data.isError, false, JSON.stringify(event.data.content))
  const result = JSON.parse(event.data.content[0].text); removeCapture(t, result)
  assert.equal(result.status, 'passed', result.detail)
  assert.equal(result.timingMode, 'controlled-clock')
  assert.equal(result.metricsKind, 'not-measured')
  assert.deepEqual(result.checks, args)
  assert.match(result.detail, /rAF not measured.*unmeasured placeholders/)
  const image = a.session.snapshotEvents().find(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'read_image')
  assert.equal(image.data.isError, false, JSON.stringify(image.data.content))
  assert.equal(h.adapter.requests.length, 2)
  assert.ok(a.session.snapshotEvents().filter(e => e.type === 'tool/result')
    .every(e => e.data.message.content.every(block => !block.isError)), 'reading the documented fields must complete through native PTC')
  assert.equal(h.adapter.requests[1].messages.filter(m => m.role === 'user' && m.content.some(b => b.type === 'image')).length, 1,
    'native PTC forwards image attachments as a separate user message')
})

test('clock input commits input/change once and reports deferred DOM updates without retrying failed checks', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), `<!doctype html>
    <input id="control" type="range" min="0" max="10" step="1" value="1" aria-label="Value">
    <p id="live">1</p><p id="committed">1</p><p id="frame">1</p><p id="timer">1</p><p id="events"></p>
    <script>
      const control = document.querySelector('#control'), events = [];
      control.addEventListener('input', event => {
        events.push('input:' + event.isTrusted);
        document.querySelector('#live').textContent = control.value;
      });
      control.addEventListener('change', event => {
        events.push('change:' + event.isTrusted);
        document.querySelector('#events').textContent = events.join(',');
        document.querySelector('#committed').textContent = control.value;
        requestAnimationFrame(() => document.querySelector('#frame').textContent = control.value);
        setTimeout(() => document.querySelector('#timer').textContent = control.value, 100);
      });
    </script>`)
  const agent = await h.create()
  for (const immediate of ['2', '1']) {
    const args = { check_id: 'clock-events', assertion: 'Immediate commits and deferred display updates', root: '.', interaction_required: true,
      clock_steps: [
        { at_ms: 100, run_callbacks: true, input: { selector: '#control', value: 2 }, checks: [
          { selector: '#live', equals: '2' }, { selector: '#committed', equals: '2' },
          { selector: '#frame', equals: immediate }, { selector: '#timer', equals: '1' },
        ] },
        { at_ms: 100, run_callbacks: true, checks: [{ selector: '#frame', equals: '2' }, { selector: '#timer', equals: '1' }] },
        { at_ms: 200, run_callbacks: true, checks: [{ selector: '#timer', equals: '2' }, { selector: '#events', equals: 'input:false,change:false' }] },
      ] }
    const result = await web(h, agent, args); removeCapture(t, result)
    assert.deepEqual(result.checks, args)
    assert.equal(result.status, immediate === '2' ? 'failed' : 'passed', result.detail)
    assert.equal(result.failedSequenceChecks.length, immediate === '2' ? 1 : 0)
    assert.ok(result.sequenceChecks.slice(4).every(check => check.includes(':passed')), 'later callbacks update the DOM without changing earlier failures')
    assert.equal(result.interactions.length, 1, 'no automatic repeat of the action')
    assert.equal(result.metricsKind, 'not-measured')
    assert.equal(result.overallAcceptance, 'not-assessed')
    assert.equal(result.artifactStable, true)
    assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
    if (immediate === '2') {
      assert.match(result.detail, /Controlled-clock checks run immediately after each action/)
      assert.match(result.detail, /later step with run_callbacks:true/)
    } else assert.doesNotMatch(result.detail, /Controlled-clock checks run immediately/)
  }
})

test('real page errors and unavailable required graphics are failures with captures', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), '<!doctype html><canvas></canvas><script>console.error("shader fixture failure");throw Error("runtime fixture failure")</script>')
  const a = await h.create()
  const result = await web(h, a, { ...base, require_graphics_api: 'webgpu' }); removeCapture(t, result)
  assert.equal(result.status, 'failed')
  assert.ok(result.consoleErrors.some(e => e.includes('shader fixture failure')))
  assert.ok(result.pageErrors.some(e => e.includes('runtime fixture failure')))
  assert.match(result.detail, /webgpu.*not observed/)
  assert.ok(result.warnings.some(e => e.includes('no fallback')))
  assert.ok(result.screenshotHash)
  assert.equal(result.metricsKind, 'instrumented-raf', 'page errors do not erase completed sampling')
})

test('unestablished Pointer Lock never dispatches dependent input or claims acceptance', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), '<!doctype html><button id="start">Does not request lock</button><canvas id="view"></canvas><p>Pointer fixture</p>')
  const a = await h.create()
  const result = await web(h, a, { ...base, interaction_required: true, interactions: [
    { click_selector: '#start', pointer_lock_selector: '#view' }, { key: 'KeyW', hold_ms: 0 },
  ] }); removeCapture(t, result)
  assert.equal(result.status, 'failed')
  assert.equal(result.metricsKind, 'not-measured')
  assert.equal(result.fps, 0)
  assert.equal(result.p95FrameMs, 0)
  assert.match(result.detail, /Pointer Lock.*dependent actions were not dispatched/)
  assert.ok(result.warnings.some(e => e.includes('Headless support varies')))
  assert.ok(!result.interactions.some(e => e.includes('KeyW')))
})

test('screenshot storage failure preserves completed rAF measurements without claiming acceptance', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), '<!doctype html><p>Measured before capture</p>')
  const mkdtemp = fs.mkdtemp
  let captureAttempts = 0
  t.mock.method(fs, 'mkdtemp', function (prefix, ...args) {
    if (prefix.endsWith('dsh-apex-evidence-')) {
      captureAttempts++
      return Promise.reject(new Error('fixture screenshot storage failure'))
    }
    return mkdtemp.call(this, prefix, ...args)
  })
  const agent = await h.create()
  const result = await web(h, agent, base)
  assert.ok(captureAttempts > 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.overallAcceptance, 'not-assessed')
  assert.match(result.detail, /fixture screenshot storage failure/)
  assert.equal(result.metricsKind, 'instrumented-raf')
  assert.ok(result.fps > 0, 'a later screenshot failure must not replace a completed sample with zero')
  assert.ok(result.p95FrameMs > 0)
  assert.match(result.detail, /rAF sample: \d+ callbacks over [\d.]+ ms; not GPU frame throughput/)
  assert.equal(result.screenshotPath, '')
  assert.equal(result.screenshotHash, '')
  assert.equal(result.artifactStable, true)
  assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
})

test('post-action diagnostics failure preserves a completed before-actions rAF sample', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), `<!doctype html><p>Measured before diagnostics</p>
    <script>const queryAll = document.querySelectorAll.bind(document);
    document.querySelectorAll = selector => {
      if (selector === 'canvas') throw Error('fixture post-sample diagnostic failure');
      return queryAll(selector);
    };</script>`)
  const agent = await h.create()
  const result = await web(h, agent, { ...base, sequence_start: 'before-actions' }); removeCapture(t, result)
  assert.equal(result.status, 'failed')
  assert.equal(result.overallAcceptance, 'not-assessed')
  assert.match(result.detail, /fixture post-sample diagnostic failure/)
  assert.equal(result.metricsKind, 'instrumented-raf')
  assert.ok(result.fps > 0)
  assert.ok(result.p95FrameMs > 0)
  assert.match(result.detail, /rAF sample: \d+ callbacks over [\d.]+ ms; not GPU frame throughput/)
  assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
})

test('completed sampling with no callbacks reports measured zero and an unmeasured interval, not a pass', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'index.html'), '<!doctype html><p>No callbacks</p><script>window.requestAnimationFrame = () => 0;</script>')
  const agent = await h.create()
  const result = await web(h, agent, { ...base, min_fps: 1 }); removeCapture(t, result)
  assert.equal(result.status, 'failed')
  assert.equal(result.overallAcceptance, 'not-assessed')
  assert.equal(result.metricsKind, 'instrumented-raf')
  assert.equal(result.fps, 0)
  assert.equal(result.p95FrameMs, 0)
  assert.match(result.detail, /sampled rAF rate 0\.0 was below 1/)
  assert.match(result.detail, /rAF sample: 0 callbacks over [\d.]+ ms; not GPU frame throughput/)
  assert.match(result.detail, /p95FrameMs is an unmeasured placeholder: fewer than two callbacks/)
  assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
})

test('artifact mutation during an actual run invalidates its certification', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const file = join(h.cwd, 'index.html'); await writeFile(file, '<!doctype html><p>before</p>')
  const spawn = h.ctx.subprocess.spawn
  let mutation
  t.mock.method(h.ctx.subprocess, 'spawn', function (request) {
    mutation = writeFile(file, '<!doctype html><p>after</p>')
    return spawn.call(this, request)
  })
  const a = await h.create(), result = await web(h, a, base); await mutation; removeCapture(t, result)
  assert.equal(result.status, 'blocked')
  assert.equal(result.artifactStable, false)
  assert.equal(result.metricsKind, 'instrumented-raf', 'artifact invalidation does not erase observed timing')
  assert.notEqual(result.artifactHashAfter, result.artifactHash)
  assert.match(result.detail, /Artifact changed during/)
})

test('native controls commit real-time values and retain controlled-clock ordering', options, async t => {
  const h = await browserFixture(t), optionValue = 'β"\\水'
  await writeFile(join(h.root, 'index.html'), `<!doctype html><meta charset="utf-8">
    <input id="speed" type="range" min="0" max="4" step="0.5" value="1">
    <select id="mode"><option value="">Empty</option><option id="alternate">Alternate</option></select>
    <p id="values">1|</p><p id="events"></p><p id="next-frame">1</p>
    <script>
      const speed=document.querySelector('#speed'), mode=document.querySelector('#mode');
      document.querySelector('#alternate').value=${JSON.stringify(optionValue)};
      const observed=[];
      for(const type of ['input','change']) for(const control of [speed,mode]) control.addEventListener(type,event=>{
        observed.push(control.id+':'+type+':'+event.isTrusted);
        document.querySelector('#events').textContent=observed.join(',');
        document.querySelector('#values').textContent=speed.value+'|'+mode.value;
        requestAnimationFrame(()=>document.querySelector('#next-frame').textContent=speed.value);
      });
    </script>`)
  const real = await h.run({ ...base, interaction_required: true, interactions: [
    { input: { selector: '#speed', value: 2.5 } }, { select: { selector: '#mode', value: optionValue } },
    { select: { selector: '#mode', value: '' } },
  ], text_checks: [
    { phase: 'after', selector: '#values', equals: '2.5|' },
    { phase: 'after', selector: '#events', equals: 'speed:input:false,speed:change:false,mode:input:false,mode:change:false,mode:input:false,mode:change:false' },
    { phase: 'after', selector: '#next-frame', equals: '2.5' },
  ] }); removeCapture(t, real)
  assert.equal(real.status, 'passed', real.detail)
  assert.deepEqual(real.interactions, ['programmatic-range:#speed=2.5', `programmatic-select:#mode=${optionValue}`, 'programmatic-select:#mode='])
  assert.equal(real.timingMode, 'real-time')
  assert.equal(real.metricsKind, 'instrumented-raf')
  assert.equal(real.overallAcceptance, 'not-assessed')
  assert.equal(real.artifactStable, true)
  assert.equal((await screenshotIdentity(real.screenshotPath)).hash, real.screenshotHash)
  assert.match(real.cleanup, /server-closed,browser-terminated,profile-removed/)

  const clock = await h.run({ check_id: 'clock-control', assertion: 'Actions precede the next animation callback', root: '.',
    interaction_required: true, clock_steps: [
      { at_ms: 0, run_callbacks: true, input: { selector: '#speed', value: 2.5 },
        checks: [{ selector: '#values', equals: '2.5|' }, { selector: '#next-frame', equals: '1' }] },
      { at_ms: 16, run_callbacks: true, checks: [{ selector: '#next-frame', equals: '2.5' }] },
    ] }); removeCapture(t, clock)
  assert.equal(clock.status, 'passed', clock.detail)
  assert.match(clock.interactions[0], /programmatic-input.*#speed/)
  assert.equal(clock.timingMode, 'controlled-clock')
  assert.equal(clock.metricsKind, 'not-measured')
  assert.equal(clock.failedSequenceChecks.length, 0)
  assert.match(clock.cleanup, /server-closed,browser-terminated,profile-removed/)
})

test('reload verifies retained data in a new document, detects memory-only storage and isolates calls', options, async t => {
  const h = await browserFixture(t), entry = join(h.root, 'index.html'), text = '<b>中文笔记</b>'
  for (const persists of [true, false]) {
    await writeFile(entry, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <form id="form"><input id="name" aria-label="Name"><button>Save</button></form>
      <p id="items"></p><p id="volatile"></p><p id="navigation"></p><script>
        const output = document.querySelector('#items'), input = document.querySelector('#name');
        output.textContent = localStorage.getItem('entry') || '';
        document.querySelector('#navigation').textContent = performance.getEntriesByType('navigation')[0].type;
        document.querySelector('#form').onsubmit = event => {
          event.preventDefault(); output.textContent = input.value;
          document.querySelector('#volatile').textContent = 'only in the old document';
          ${persists ? "localStorage.setItem('entry', input.value);" : ''}
        };
      </script>`)
    const result = await h.run({ ...base, width: 390, interaction_required: true,
      interactions: [{ selector: '#name', text }, { key: 'Enter', hold_ms: 0 }, { reload: true }],
      text_checks: [{ phase: 'before', selector: '#items', equals: '' },
        { phase: 'after', selector: '#items', equals: text },
        { phase: 'after', selector: '#volatile', equals: '' },
        { phase: 'after', selector: '#navigation', equals: 'reload' }],
      selector_checks: [{ selector: '#items b', state: 'absent' }],
      sequence_checks: [{ id: 'retained', selector: '#items', expectation: 'stable' }],
    }); removeCapture(t, result)
    assert.equal(result.status, persists ? 'passed' : 'failed', result.detail)
    assert.deepEqual(result.interactions, ['fill:#name', 'Enter:0ms', 'reload:new-document'])
    assert.equal(result.failedTextChecks.length, persists ? 0 : 1, result.detail)
    if (!persists) assert.match(result.failedTextChecks[0], /#items/)
    assert.deepEqual(result.failedSequenceChecks, [])
    assert.equal(result.metricsKind, 'instrumented-raf')
    assert.equal(result.artifactStable, true)
    assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
    assert.equal((await screenshotIdentity(result.screenshotPath)).hash, result.screenshotHash)
    if (persists) {
      const fresh = await h.run({ ...base, text_checks: [{ phase: 'before', selector: '#items', equals: '' }] })
      removeCapture(t, fresh)
      assert.equal(fresh.status, 'passed', 'a separate call must not inherit stored data: ' + fresh.detail)
    }
  }
})

test('reload HTTP failure and cancellation in a real browser preserve failure and clean owned resources', options, async t => {
  for (const outcome of ['http-error', 'cancel']) await t.test(outcome, async t => {
    const h = await browserFixture(t), controller = new AbortController()
    await writeFile(join(h.root, 'reload-fixture.html'), '<!doctype html><p id="state">Loaded</p>')
    let requests = 0, server, handle, profile
    const emit = Server.prototype.emit, spawn = h.ctx.subprocess.spawn
    t.mock.method(h.ctx.subprocess, 'spawn', function (request) {
      profile = request.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
      handle = spawn.call(this, request)
      return handle
    })
    t.mock.method(Server.prototype, 'emit', function (event, ...args) {
      if (event === 'request' && args[0].url === '/reload-fixture.html') {
        server = this
        if (++requests === 2) {
          if (outcome === 'cancel') controller.abort(new Error('cancel actual reload'))
          else { args[1].writeHead(503, { 'Content-Type': 'text/html' }).end('<!doctype html><p id="state">Loaded</p>'); return true }
        }
      }
      return emit.call(this, event, ...args)
    })
    const execution = h.run({ ...base, entry: 'reload-fixture.html', interactions: [{ reload: true }],
      text_checks: [{ phase: 'after', selector: '#state', equals: 'Loaded' }],
    }, controller.signal)
    if (outcome === 'cancel') await assert.rejects(execution, /cancel actual reload/)
    else {
      const result = await execution; removeCapture(t, result)
      assert.equal(result.status, 'failed', 'a matching DOM cannot hide a failed HTTP reload: ' + result.detail)
      assert.ok(result.httpErrors.some(error => error.startsWith('503 ')), result.detail)
      assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
    }
    assert.equal(requests, 2)
    assert.equal(server.listening, false)
    assert.ok(await handle.waitForExit(AbortSignal.timeout(1000)))
    await assert.rejects(realpath(profile), { code: 'ENOENT' })
  })
})

test('native navigation keys change range limits, focus, activation and dialog state', options, async t => {
  const h = await browserFixture(t)
  await writeFile(join(h.root, 'index.html'), `<!doctype html>
    <input id="speed" type="range" min="0" max="10" step="1" value="5">
    <button id="open" onclick="document.querySelector('dialog').showModal()">Open</button>
    <dialog>Dialog<button>Close</button></dialog><p id="events"></p><p id="state"></p>
    <script>const observed=[];
      document.addEventListener('keyup',event=>{
        observed.push(event.key+':'+document.querySelector('#speed').value+':'+event.isTrusted+':'+document.querySelector('dialog').open);
        document.querySelector('#events').textContent=observed.join(',');
        document.querySelector('#state').textContent=document.activeElement.id+'|'+document.querySelector('dialog').open;
      });
    </script>`)
  const result = await h.run({ ...base, interaction_required: true, interactions: [
    { click_selector: '#speed' }, ...['Home', 'End', 'Tab', 'Enter', 'Escape'].map(key => ({ key, hold_ms: 0 })),
  ], text_checks: [
    { phase: 'after', selector: '#events', equals: 'Home:0:true:false,End:10:true:false,Tab:10:true:false,Enter:10:true:true,Escape:10:true:false' },
    { phase: 'after', selector: '#state', equals: 'open|false' },
  ] }); removeCapture(t, result)
  assert.equal(result.status, 'passed', result.detail)
  assert.equal(result.interactions.length, 6)
  assert.equal(result.metricsKind, 'instrumented-raf')
  assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
})

test('native controls refuse invalid values and report handler rejection or replacement', options, async t => {
  const h = await browserFixture(t)
  for (const [markup, action, expected] of [
    ['<input id="target" type="range" min="0" max="4" step="0.5" value="1">', { input: { selector: '#target', value: 2.25 } }, /min\/max\/step/],
    ['<select id="target"><option value="a">A</option><option value="b" disabled>B</option></select>', { select: { selector: '#target', value: 'b' } }, /option is disabled or hidden/],
    ['<select id="target" multiple><option value="b">B</option></select>', { select: { selector: '#target', value: 'b' } }, /expected single select/],
    ['<select id="target"><option value="b">B1</option><option value="b">B2</option></select>', { select: { selector: '#target', value: 'b' } }, /option value is missing or ambiguous/],
    ['<input id="target" type="range" value="1" onchange="this.value=1">', { input: { selector: '#target', value: 2 } }, /not retained after input\/change/],
    ['<select id="target" oninput="this.remove()"><option value="a">A</option><option value="b">B</option></select>', { select: { selector: '#target', value: 'b' } }, /replaced or detached after input/],
  ]) {
    await writeFile(join(h.root, 'index.html'), `<!doctype html>${markup}
      <button id="later" onclick="console.error('unexpected later action')">Later</button>
      <script>document.addEventListener('input',()=>console.warn('control input dispatched'));</script>`)
    const result = await h.run({ ...base, interaction_required: true, interactions: [action, { click_selector: '#later' }] })
    removeCapture(t, result)
    assert.equal(result.status, 'failed', result.detail)
    assert.match(result.detail, expected)
    assert.equal(result.interactions.length, 0, 'a failed sequence cannot be reported as completed')
    assert.ok(!result.consoleErrors.some(error => error.includes('unexpected later action')))
    if (!markup.includes('onchange=') && !markup.includes('oninput=')) {
      assert.ok(!result.warnings.some(warning => warning.includes('control input dispatched')), 'invalid values are rejected before input events')
    }
    assert.ok(result.screenshotHash)
    assert.equal(result.metricsKind, 'not-measured')
    assert.equal(result.overallAcceptance, 'not-assessed')
    assert.match(result.cleanup, /server-closed,browser-terminated,profile-removed/)
  }
})

test('cancellation after native browser launch propagates and removes owned resources', options, async t => {
  const h = await browserFixture(t)
  await writeFile(join(h.root, 'index.html'), '<!doctype html><p>Cancel</p>')
  const controller = new AbortController(), spawn = h.ctx.subprocess.spawn
  let handle, profile
  t.mock.method(h.ctx.subprocess, 'spawn', function (request) {
    profile = request.argv.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
    handle = spawn.call(this, request)
    controller.abort(new Error('cancel launched browser'))
    return handle
  })
  await assert.rejects(h.run(base, controller.signal), /cancel launched browser/)
  assert.ok(handle)
  assert.ok(await handle.waitForExit(AbortSignal.timeout(1000)))
  await assert.rejects(readFile(join(profile, 'DevToolsActivePort')), { code: 'ENOENT' })
  await assert.rejects(realpath(profile), { code: 'ENOENT' })
})
