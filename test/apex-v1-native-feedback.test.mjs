import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Config, createFeedbackReport, feedbackReportPath } from '../presets/apex-v1/native-feedback.mjs'
import { harnessAvailable, harnessRoot, nativeHarness, pluginRoot, textResponse, toolResponse, native } from './helpers/harness-v1.mjs'

const real = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }
const cases = [0, 1, 2, 3].map(input => ({ input, expected: input * 2, expectedSource: 'Fixture specification: double the input' }))
const correct = 'export const solve = x => x * 2;'
const wrong = 'export const solve = x => x === 0 ? 0 : 9;'
const ptc = (id, code) => toolResponse(id, 'run_code', { code, description: 'Native feedback integration check' })
const write = source => ptc('write-' + source.length,
  'return await tools.write({file_path:"solver.mjs", content:' + JSON.stringify(source) + '});')

async function fixture(t, script, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'apex-native-feedback-preset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'apex-v1'))
  const reportDirectory = join(dir, 'reports')
  await mkdir(reportDirectory)
  const { entryListSchema } = await native('cordis-plugin-include')
  const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const rows = load(await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
  const preset = rows.find(row => Array.isArray(row.insert))?.insert?.find(row => row.id === 'preset-apex-v1')
  const session = preset?.config?.plugins?.find(row => row.id === 'apex-session')
  assert.ok(session && Array.isArray(session.config), 'fixture must have an apex-session group')
  session.config.push({ id: 'native-feedback-test', name: join(pluginRoot, 'presets/apex-v1/native-feedback.mjs'), config: { mode: 'repair', reportDirectory, ...config } })
  const presetYaml = dump(rows, { schema: entryListSchema, noRefs: true })
  await writeFile(join(dir, 'apex-v1/agent.cordis.yml'), presetYaml)
  const h = await nativeHarness(script, { presetRoot: dir }); t.after(h.close)
  await writeFile(join(h.cwd, 'public-cases.json'), JSON.stringify(cases))
  const agent = await h.create()
  const report = async () => {
    try { return JSON.parse(await readFile(await feedbackReportPath(reportDirectory, h.cwd), 'utf8')) }
    catch (error) { throw new Error(JSON.stringify(agent.session.snapshotEvents().filter(e => e.type === 'turn/end')), { cause: error }) }
  }
  return { ...h, agent, report, reportDirectory }
}

test('native feedback defaults off and rejects invalid budgets', () => {
  assert.equal(Config.parse({}).mode, 'off')
  assert.equal(Config.parse({}).requestsPerPhase, null)
  assert.equal(Config.parse({}).maxTokens, null)
  assert.equal(Config.parse({ requestsPerPhase: null, maxTokens: null }).maxTokens, null)
  for (const config of [{ requestsPerPhase: 0 }, { maxTokens: Infinity }, { mode: 'automatic' }]) {
    assert.throws(() => Config.parse(config))
  }
  for (const config of [{ mode: 'repair' }, { mode: 'observe', reportDirectory: 'relative' }]) {
    assert.throws(() => Config.parse(config), /reportDirectory/)
  }
  assert.equal(Config.parse({ mode: 'repair', reportDirectory: '/host/reports' }).mode, 'repair')
})

test('host reports reserve a workspace once and publish complete private files outside it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apex-feedback-report-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), reports = join(root, 'reports')
  await mkdir(workspace); await mkdir(reports)
  await writeFile(join(workspace, 'source.txt'), 'unchanged')
  const report = await createFeedbackReport(reports, workspace)
  await report.write({ status: 'running', evidence: 'initial' })
  await report.write({ status: 'public-pass' })
  const invalid = {}; invalid.self = invalid
  await assert.rejects(report.write(invalid), /circular/i)
  assert.deepEqual(JSON.parse(await readFile(report.path, 'utf8')), { status: 'public-pass' })
  assert.deepEqual(await readdir(workspace), ['source.txt'])
  assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'unchanged')
  const run = join(report.path, '..')
  if (process.platform !== 'win32') {
    assert.equal((await lstat(report.path)).mode & 0o777, 0o600)
    assert.equal((await lstat(run)).mode & 0o777, 0o700)
  }
  assert.deepEqual(await readdir(run), ['report.json'])
  await assert.rejects(createFeedbackReport(reports, workspace), /reservation already exists/)
  await assert.rejects(feedbackReportPath(workspace, workspace), /disjoint/)
  await assert.rejects(feedbackReportPath(root, workspace), /disjoint/)
  const nested = join(workspace, 'reports'), alias = join(root, 'alias')
  await mkdir(nested); await symlink(nested, alias)
  await assert.rejects(feedbackReportPath(alias, workspace), /disjoint/)
  const moved = run + '-moved'
  await rename(run, moved)
  await symlink(workspace, run)
  await assert.rejects(report.write({ status: 'must-not-write' }), /identity changed/)
  assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'unchanged')
  await assert.rejects(readFile(join(workspace, 'report.json')), /ENOENT/)
  assert.deepEqual(JSON.parse(await readFile(join(moved, 'report.json'), 'utf8')), { status: 'public-pass' })
})

test('simultaneous controllers cannot reserve the same workspace twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apex-feedback-reservation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), reports = join(root, 'reports')
  await mkdir(workspace); await mkdir(reports)
  const attempts = await Promise.allSettled([createFeedbackReport(reports, workspace), createFeedbackReport(reports, workspace)])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(attempts.find(result => result.status === 'rejected').reason.message, /reservation already exists/)
})

test('a legacy workspace report stops before the first model request without deleting evidence', real, async t => {
  const h = await fixture(t, () => textResponse('Must not run.'))
  const path = join(h.cwd, '.apex-native-feedback.json')
  await writeFile(path, '{"old":"evidence"}')
  await h.turn(h.agent, 'Implement the task.')
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(await readFile(path, 'utf8'), '{"old":"evidence"}')
  assert.deepEqual(await readdir(h.reportDirectory), [])
})

test('a host report publication failure stops provider retries and later model spending', real, async t => {
  let h
  h = await fixture(t, async (_, n) => {
    if (n === 1) {
      const run = join(await feedbackReportPath(h.reportDirectory, h.cwd), '..')
      await rename(run, run + '-moved')
    }
    return textResponse('No artifact.')
  }, { requestsPerPhase: 3 })
  h.ctx.on('agent/request-error', () => ({ kind: 'retry' }), { global: true })
  await h.turn(h.agent, 'Finish once.')
  assert.equal(h.adapter.requests.length, 1, 'persistence failure must close the controller before another provider retry')
  await h.turn(h.agent, 'Try continuing.')
  assert.equal(h.adapter.requests.length, 1)
  await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
})

test('native tools write, self-test, receive facts in the same session and repair with full replay', real, async t => {
  let h
  h = await fixture(t, (request, n) => {
    assert.deepEqual(request.tools.map(t => t.name), ['run_code'])
    if (n === 1) return write(wrong)
    if (n === 2) return ptc('self-test', 'return await tools.apex_run_script({command:"node --input-type=module", description:"Self-test current code", script:'
      + JSON.stringify('import {solve} from "./solver.mjs"; console.log(solve(1));') + '});')
    if (n === 3) return textResponse('Ready for verification.')
    if (n === 4) {
      assert.equal(request.sessionId, h.agent.session.id)
      const message = request.messages.findLast(m => m.source?.kind === 'apex-native-feedback')
      assert.ok(message, 'feedback is a durable APEX producer message')
      const facts = JSON.parse(message.content[0].text.split('\n').at(-1))
      assert.deepEqual(facts.failures.map(f => f.index), [1, 2, 3])
      assert.equal(facts.failures[0].actual.value, 9)
      return write(correct)
    }
    return textResponse('Repaired.')
  }, { maxTokens: 32768 })
  h.agent.options.maxTokens = 65536
  await h.turn(h.agent, 'Implement solve(input) in solver.mjs. Use your normal tools and self-test.')
  const r = await h.report()
  assert.equal(r.status, 'public-pass', JSON.stringify(r))
  assert.equal(r.candidates.length, 2)
  assert.deepEqual(r.candidates.map(c => c.passed), [1, 4])
  assert.equal(r.requests.length, 5)
  assert.equal(r.feedback.length, 1)
  assert.equal(r.delivery.replay.outcomes.length, 4)
  assert.equal(await readFile(join(h.cwd, 'solver.mjs'), 'utf8'), correct)
  assert.ok(r.requests.every(q => q.maxTokens === 32768 && q.usage))
  assert.equal(new Set(r.requests.map(q => q.sessionId)).size, 1)
  const events = h.agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1)
  assert.ok(JSON.stringify(events).includes('self-test'))
  const selfTest = events.filter(e => e.type === 'tool/result').map(e => e.data.message)
    .find(message => message.toolCallId === 'self-test')
  assert.ok(selfTest && !selfTest.isError, JSON.stringify(selfTest))
  assert.match(JSON.stringify(selfTest), /exitCode.*0/)
})

test('default budget allows more than twelve native requests before same-session repair', real, async t => {
  const h = await fixture(t, (_, n) => {
    if (n === 1) return write(wrong)
    if (n < 14) return ptc('inspect-' + n, 'return await tools.read({file_path:"solver.mjs"});')
    if (n === 15) return write(correct)
    return textResponse('Ready for verification.')
  })
  h.agent.options.maxTokens = 262144
  await h.turn(h.agent, 'Implement and inspect the task before finishing.')
  const r = await h.report()
  assert.equal(r.status, 'public-pass', JSON.stringify(r))
  assert.equal(r.config.requestsPerPhase, null)
  assert.equal(r.config.maxTokens, null)
  assert.equal(r.requests.length, 16)
  assert.deepEqual([0, 1].map(phase => r.requests.filter(q => q.phase === phase).length), [14, 2])
  assert.ok(h.adapter.requests.every(q => q.maxTokens === 262144))
  assert.ok(r.requests.every(q => q.maxTokens === 262144 && q.usage && q.finish && q.endedAt))
  assert.equal(r.feedback.length, 1)
  assert.equal(r.delivery.passed, cases.length)
  assert.equal(r.delivery.replay.outcomes.length, cases.length)
  assert.equal(await readFile(join(h.cwd, 'solver.mjs'), 'utf8'), correct)
})

test('explicit null budgets preserve omitted native output limits and auxiliary limits', real, async t => {
  let rootRequests = 0
  const h = await fixture(t, request => request.purpose === 'session-title'
    ? textResponse('Title') : ++rootRequests === 1 ? write(correct) : textResponse('Done.'),
  { requestsPerPhase: null, maxTokens: null })
  const original = h.adapter.stream.bind(h.adapter)
  let first = true
  h.adapter.stream = async function* (request) {
    if (first) {
      first = false
      for await (const _ of h.ctx.llm.stream({ ...request, purpose: 'session-title', maxTokens: 393216 })) {}
    }
    yield* original(request)
  }
  await h.turn(h.agent, 'Use the native output configuration.')
  const r = await h.report()
  assert.equal(r.status, 'public-pass', JSON.stringify(r))
  assert.equal(r.requests.length, 3)
  assert.ok(h.adapter.requests.filter(q => q.purpose !== 'session-title').every(q => q.maxTokens === undefined))
  assert.ok(r.requests.filter(q => q.purpose === 'agent').every(q => q.maxTokens === null && q.usage))
  assert.equal(r.requests.find(q => q.purpose === 'session-title').maxTokens, 393216)
})

test('a passing initial source spends no repair request and observe mode adds no steering', real, async t => {
  for (const [mode, source, status] of [['repair', correct, 'public-pass'], ['observe', wrong, 'public-fail']]) {
    await t.test(mode, async st => {
      const h = await fixture(st, (_, n) => n === 1 ? write(source) : textResponse('Done.'), { mode })
      await h.turn(h.agent, 'Implement the task.')
      const r = await h.report()
      assert.equal(r.status, status, JSON.stringify(r))
      assert.equal(r.requests.length, 2)
      assert.equal(r.feedback.length, 0)
    })
  }
})

test('regression retains the initial source and records every regressed public case', real, async t => {
  const initial = 'export const solve = x => x < 3 ? x * 2 : 9;'
  const h = await fixture(t, (_, n) => n === 1 ? write(initial) : n === 3 ? write(wrong) : textResponse('Done.'))
  await h.turn(h.agent, 'Implement the task.')
  const r = await h.report()
  assert.equal(r.status, 'public-fail', JSON.stringify(r))
  assert.deepEqual(r.candidates[1].regressions, [1, 2])
  assert.equal(r.delivery.selectedPhase, 0)
  assert.equal(await readFile(join(h.cwd, 'solver.mjs'), 'utf8'), initial)
})

test('budget is reserved before dispatch and completed workspaces cannot restart spending', real, async t => {
  const h = await fixture(t, () => ptc('loop', 'return 1;'), { requestsPerPhase: 2 })
  await h.turn(h.agent, 'Keep working.')
  assert.equal(h.adapter.requests.length, 2)
  const r = await h.report()
  assert.equal(r.status, 'request-budget', JSON.stringify(r))
  await h.turn(h.agent, 'Continue.')
  assert.equal(h.adapter.requests.length, 2)
  await h.dispose(h.agent)
  const resumed = await h.resume(h.agent.session.id)
  await h.turn(resumed, 'Continue again.')
  assert.equal(h.adapter.requests.length, 2, 'resume cannot reset the frozen workspace budget')
})

test('missing source and changed public suite stop without a fabricated feedback cycle', real, async t => {
  for (const corrupt of [false, true]) await t.test(String(corrupt), async st => {
    const h = await fixture(st, (_, n) => corrupt && n === 1
      ? ptc('corrupt', 'await tools.read({file_path:"public-cases.json"}); return await tools.write({file_path:"public-cases.json",content:"[]"});') : textResponse('Done.'))
    await h.turn(h.agent, 'Implement the task.')
    const r = await h.report()
    assert.equal(r.status, 'verification-error', JSON.stringify(r))
    assert.equal(r.feedback.length, 0)
    assert.equal(r.delivery, null)
  })
})

test('native child and auxiliary streams share the root budget including concurrent reservations', real, async t => {
  const h = await fixture(t, () => textResponse('No source.'), { requestsPerPhase: 2 })
  // Initialize the root while a real native child and an auxiliary call race for the last slot.
  let released
  h.ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== h.agent || released) return
    released = true
  }, { global: true, prepend: true })
  const original = h.adapter.stream.bind(h.adapter)
  let first = true
  h.adapter.stream = async function* (request) {
    if (first) {
      first = false
      const { createUserMessage } = await native('dsh-llm')
      const child = await h.ctx.subagents.start('spawn', { parent: h.agent, signal: request.signal,
        prompt: 'Answer once.', maxDepth: 1 })
      const auxiliary = h.ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-flash',
        sessionId: h.agent.session.id, purpose: 'compaction', maxTokens: 1000,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize.' }], source: { kind: 'fixture-auxiliary' } })] })
      try { await Promise.allSettled([(async () => { for await (const _ of auxiliary) {} })(), child.result]) }
      finally { await child.dispose() }
    }
    yield* original(request)
  }
  await h.turn(h.agent, 'Start the bounded family.')
  const r = await h.report()
  assert.equal(r.requests.length, 2, JSON.stringify(r))
  assert.equal(r.status, 'request-budget')
  assert.ok(r.requests.some(q => q.purpose === 'compaction' || q.sessionId !== h.agent.session.id))
  assert.ok(h.adapter.requests.length <= 2)
})

test('an active owned background job blocks native verification', real, async t => {
  let h, jobId
  h = await fixture(t, (_, n) => {
    if (n === 1) {
      jobId = h.ctx.jobs.start({
        kind: 'subagent', label: 'fixture active job', owner: h.agent.id,
        run: () => ({ cancel() {}, done: delay(1000).then(() => ({ result: 'fixture complete' })) }),
      })
      return write(wrong)
    }
    return textResponse('Done.')
  })
  try {
    await h.turn(h.agent, 'Implement the task.')
    const r = await h.report()
    assert.equal(r.status, 'verification-error', JSON.stringify(r))
    assert.equal(r.feedback.length, 0)
    assert.equal(r.delivery, null)
    assert.equal(h.adapter.requests.length, 2)
  } finally {
    h.ctx.jobs.kill(jobId, h.agent.id, 'fixture cleanup')
    await h.ctx.jobs.wait(jobId, 1000, h.agent.id)
  }
})

test('model cancellation records an abnormal end and does not launch a repair', real, async t => {
  let requested
  const h = await fixture(t, request => new Promise(resolve => {
    requested = true
    request.signal.addEventListener('abort', () => resolve([]), { once: true })
  }))
  const turn = h.turn(h.agent, 'Wait until cancelled.')
  for (let i = 0; !requested && i < 100; i++) await delay(10)
  assert.ok(requested)
  h.agent.cancel({ kind: 'user' })
  await turn
  await h.dispose(h.agent)
  const r = await h.report()
  assert.equal(r.status, 'cancelled')
  assert.equal(r.feedback.length, 0)
  assert.equal(r.requests.length, 1)
})

test('each provider retry consumes a new slot', real, async t => {
  const h = await fixture(t, () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fixture', code: 'TEST' } } }],
    { requestsPerPhase: 2 })
  h.ctx.on('agent/request-error', () => ({ kind: 'retry' }), { global: true })
  await h.turn(h.agent, 'Exercise bounded retry.')
  assert.equal(h.adapter.requests.length, 2)
  assert.equal((await h.report()).status, 'request-budget')
})

test('separate roots receive independent budgets in a shared preset', real, async t => {
  const h = await fixture(t, () => textResponse('No artifact.'))
  const secondCwd = join(h.root, 'second-workspace')
  await mkdir(secondCwd)
  await writeFile(join(secondCwd, 'public-cases.json'), JSON.stringify(cases))
  const second = await h.create('other-root', 'apex-v1', secondCwd)
  await Promise.all([h.turn(h.agent, 'First.'), h.turn(second, 'Second.')])
  assert.equal(h.adapter.requests.length, 2)
  const reports = [await h.report(), JSON.parse(await readFile(await feedbackReportPath(h.reportDirectory, secondCwd), 'utf8'))]
  assert.ok(reports.every(r => r.requests.length === 1))
  assert.notEqual(reports[0].sessionId, reports[1].sessionId)
})

test('an unrecovered provider error produces a terminal report', real, async t => {
  const h = await fixture(t, () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'fixture', code: 'TEST' } } }])
  await h.turn(h.agent, 'Fail once.')
  await h.dispose(h.agent)
  const r = await h.report()
  assert.equal(r.status, 'model-error')
  assert.equal(r.feedback.length, 0)
})

test('auxiliary output above the cap is rejected before reaching the adapter', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), { maxTokens: 32768 })
  const original = h.adapter.stream.bind(h.adapter)
  let first = true
  h.adapter.stream = async function* (request) {
    if (first) {
      first = false
      for await (const _ of h.ctx.llm.stream({ ...request, purpose: 'session-title', maxTokens: 32769 })) {}
    }
    yield* original(request)
  }
  await h.turn(h.agent, 'Initialize then exercise the auxiliary cap.')
  const r = await h.report()
  assert.equal(r.status, 'output-budget')
  assert.equal(r.requests.length, 1)
  assert.ok(h.adapter.requests.length <= 1)
})
