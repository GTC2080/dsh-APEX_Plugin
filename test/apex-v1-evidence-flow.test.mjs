import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { digest } from '../presets/apex-v1/search-core.mjs'
import { scoreCandidate, selectFeedback } from '../presets/apex-v1/feedback.mjs'
import { Config, readCheckpoint } from '../presets/apex-v1/evidence-flow.mjs'
import { harnessAvailable, harnessRoot, native, nativeHarness, pluginRoot, systemText, textResponse, toolResponse } from './helpers/harness-v1.mjs'

const cases = [0, 1, 2, 3].map(input => ({ input, expected: input * 2, expectedSource: 'Fixture specification: output = input * 2' }))
const sourceA = 'export const solve=x=>x===0?0:9'
const sourceB = 'export const solve=x=>x===1?2:9'
const correct = 'export const solve=x=>x*2'
const values = list => list.map(value => ({ kind: 'value', value }))
const pool = [scoreCandidate(cases, sourceA, values([0,9,9,9])), scoreCandidate(cases, sourceB, values([9,2,9,9]))]
const selection = { cases, candidates: pool, parentId: digest(sourceA), suiteHash: digest(JSON.stringify(cases)),
  mode: 'signature', maxBytes: 1600, maxItems: 2, seed: 4 }
const real = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }
const checkpoint = { task: 'Return twice the input.', taskHash: digest('Return twice the input.'),
  suiteHash: selection.suiteHash, parentId: digest(sourceA),
  candidates: pool.map(({ id, source, outcomes }) => ({ id, source, outcomes })) }

test('explicit research limits accept the provider output ceiling and retain bounded defaults', () => {
  const defaults = Config.parse({})
  assert.equal(defaults.mode, 'off')
  assert.equal(defaults.maxTokens, 16384)
  assert.equal(defaults.childTimeoutMs, 180000)
  assert.equal(Config.parse({ maxTokens: 393216, childTimeoutMs: 3600000 }).maxTokens, 393216)
  for (const invalid of [{ maxTokens: 393217 }, { maxTokens: Infinity }, { maxTokens: 256.5 },
    { childTimeoutMs: 3600001 }, { childTimeoutMs: 0 }]) assert.throws(() => Config.parse(invalid))
})

test('checkpoint binds task, suite, distinct sources and the earliest best failing parent', () => {
  assert.equal(readCheckpoint(checkpoint, cases, selection.suiteHash).pool.length, 2)
  for (const changed of [
    { ...checkpoint, task: 'different task' }, { ...checkpoint, suiteHash: digest('changed') },
    { ...checkpoint, parentId: digest(sourceB) }, { ...checkpoint, candidates: [checkpoint.candidates[0], checkpoint.candidates[0]] },
    { ...checkpoint, candidates: [{ ...checkpoint.candidates[0], source: correct }, checkpoint.candidates[1]] },
  ]) assert.throws(() => readCheckpoint(changed, cases, selection.suiteHash))
})

test('feedback covers signatures, keeps whole facts and matches the random length bins', () => {
  const a = selectFeedback(selection), b = selectFeedback({ ...selection, mode: 'random' })
  assert.equal(a.metadata.failureSignatures, 2)
  assert.equal(a.metadata.researchEligible, true)
  assert.equal(a.feedback.length, 2)
  assert.ok(a.feedback.some(e => e.index === 1))
  assert.ok(a.feedback.some(e => e.index >= 2))
  assert.equal(b.feedback.length, 2)
  const bins = entries => entries.map(e => Math.floor(Buffer.byteLength(JSON.stringify(e)) / 256)).sort()
  assert.deepEqual(bins(a.feedback), bins(b.feedback))
  for (const result of [a, b]) {
    assert.equal(Buffer.byteLength(JSON.stringify(result.feedback)), result.metadata.bytes)
    assert.ok(result.metadata.bytes <= selection.maxBytes)
    for (const entry of result.feedback) {
      assert.equal(entry.sourceHash, digest(sourceA)); assert.deepEqual(entry.actual, values([9])[0])
      assert.equal(entry.expected, cases[entry.index].expected)
      assert.equal(entry.expectedSource, cases[entry.index].expectedSource)
    }
  }
  assert.deepEqual(selectFeedback(selection), a)
})

test('selection retains identical random packets and records degenerate/budget fallbacks', () => {
  const single = selectFeedback({ ...selection, candidates: pool.slice(0,1) })
  assert.ok(single.feedback.length)
  assert.equal(single.metadata.researchEligible, false)
  assert.ok(single.metadata.reasons.includes('fewer-than-two-distinct-sources'))
  const all = selectFeedback({ ...selection, maxItems: 8, maxBytes: 10000 })
  assert.equal(all.metadata.identicalPackages, true)
  assert.equal(all.metadata.researchEligible, false)
  const empty = selectFeedback({ ...selection, maxBytes: 2 })
  assert.deepEqual(empty.feedback, [])
  assert.throws(() => selectFeedback({ ...selection, parentId: 'missing' }), /parent/)
  assert.throws(() => selectFeedback({ ...selection, candidates: [{ ...pool[0], id: 'bad' }] }), /fingerprint/)
  assert.throws(() => selectFeedback({ ...selection, cases: cases.map(({ expectedSource, ...c }) => c) }), /expectedSource/)
  const unicodeCases = cases.map(c => ({ ...c, expectedSource: '公式依据：' + '数据'.repeat(300) }))
  const unicode = selectFeedback({ ...selection, cases: unicodeCases, maxBytes: 512 })
  assert.deepEqual(unicode.feedback, [], 'UTF-8 byte bounds do not truncate a fact')
})

function taskPayload(request) {
  const text = request.messages.flatMap(m => m.content ?? []).find(b => b.type === 'text'
    && b.text.startsWith('Implement a complete synchronous pure ESM'))?.text
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined
}

async function fixture(t, config = {}, script = () => toolResponse('source', 'structured_output', { source: correct })) {
  const { completionDelivery = 'quiet', ...flowConfig } = config
  const dir = await mkdtemp(join(tmpdir(), 'apex-evidence-preset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { entryListSchema } = await native('cordis-plugin-include')
  const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const rows = load(await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
  const preset = rows.find(row => Array.isArray(row.insert))?.insert?.find(row => row.id === 'preset-apex-v1')
  const session = preset?.config?.plugins?.find(row => row.id === 'apex-session')
  assert.ok(session && Array.isArray(session.config), 'fixture must have an apex-session group')
  const flow = session.config.find(row => row.id === 'apex-evidence-flow')
  const jobs = session.config.find(row => row.id === 'tool-jobs')
  assert.ok(flow && jobs, 'fixture must have evidence flow and jobs plugins')
  flow.name = join(pluginRoot, 'presets/apex-v1/evidence-flow.mjs')
  flow.config = { mode: 'signature', seed: 4, feedbackItems: 2, feedbackBytes: 1600, ...flowConfig }
  jobs.config = { ...(jobs.config ?? {}), maxWaitTimeoutMs: 60000, completionDelivery }
  await mkdir(join(dir, 'apex-v1'))
  await writeFile(join(dir, 'apex-v1/agent.cordis.yml'), dump(rows, { schema: entryListSchema, noRefs: true }))
  const h = await nativeHarness(script, { presetRoot: dir }); t.after(h.close)
  const agent = await h.create()
  await writeFile(join(h.cwd, 'public-cases.json'), JSON.stringify(cases))
  async function start(signal = new AbortController().signal) {
    const result = await h.ctx.commands.execute(agent, '/apex_flow Return twice the input.', [], signal)
    return result
  }
  async function collect(started) {
    assert.equal(started.result.kind, 'success', started.result.text)
    const handle = JSON.parse(started.result.text)
    const snapshot = await h.ctx.jobs.wait(handle.jobId, 20000, agent.id)
    assert.ok(!['running','stopping'].includes(snapshot.status), JSON.stringify(snapshot))
    const report = JSON.parse(await readFile(join(h.cwd, handle.report), 'utf8'))
    return { handle, snapshot, report }
  }
  return { ...h, agent, start, collect }
}

test('native command drives generation, selected feedback, complete replay and frozen delivery', real, async t => {
  const seen = []
  const h = await fixture(t, {}, request => {
    assert.match(systemText(request), /host owns execution/)
    const payload = taskPayload(request); assert.ok(payload); seen.push(payload)
    if (seen.length === 3) {
      assert.equal(payload.phase, 'repair'); assert.equal(payload.source, sourceA)
      assert.equal(payload.sourceHash, digest(sourceA))
      assert.equal(payload.feedback.length, 2)
      assert.deepEqual(payload.feedback.map(e => e.index), [1, 2])
      assert.equal(payload.task, 'Return twice the input.')
      assert.ok(!JSON.stringify(payload).includes(sourceB), 'other candidate code is not added to repair input')
    } else assert.equal(payload.phase, 'generate')
    return toolResponse('s' + seen.length, 'structured_output', { source: [sourceA, sourceB, correct][seen.length - 1] })
  })
  const { report, snapshot } = await h.collect(await h.start())
  assert.equal(snapshot.status, 'completed', JSON.stringify(report))
  assert.equal(report.children.length, 3)
  assert.equal(h.adapter.requests.length, 3, 'no parent-model solve or completion turn')
  assert.equal(report.candidates.length, 3)
  assert.equal(report.repairs[0].researchEligible, true)
  assert.equal(report.delivery.passed, 4)
  assert.equal(report.delivery.replay.outcomes.length, 4, 'replay includes the omitted failure')
  assert.equal(report.delivery.hash, digest(await readFile(join(h.cwd, 'solver.mjs'))))
  assert.equal(await readFile(join(h.cwd, report.delivery.snapshot), 'utf8'), correct)
  assert.ok(report.children.every(child => child.sessionId && child.usage?.outputTokens === 5 && child.settledWithoutUsage === 0))
  assert.ok(h.agent.session.snapshotEvents().some(e => e.type === 'command/done'))
  assert.equal((await h.start()).result.kind, 'error', 'a completed workspace cannot silently rerun')
})

test('special JSON keys survive measurement, repair feedback and final replay', real, async t => {
  const inputs = [{ ordinary: 1 }, JSON.parse('{"__proto__":{"n":1},"constructor":"own"}')]
  const suite = inputs.map(input => ({ input, expected: structuredClone(input), expectedSource: 'Return the complete JSON input unchanged.' }))
  const dropsKey = 'export const solve=input=>Object.fromEntries(Object.entries(input).filter(([key])=>key!=="__proto__"))'
  const identity = 'export const solve=input=>input'
  const seen = []
  const h = await fixture(t, { initialCandidates: 1, maxRepairs: 1 }, request => {
    const payload = taskPayload(request); assert.ok(payload); seen.push(payload)
    if (seen.length === 2) {
      assert.equal(payload.phase, 'repair')
      assert.equal(payload.sourceHash, digest(dropsKey))
      assert.equal(payload.feedback.length, 1)
      assert.equal(payload.feedback[0].index, 1)
      assert.deepEqual(payload.feedback[0].input, inputs[1])
      assert.deepEqual(payload.feedback[0].expected, inputs[1])
      assert.deepEqual(payload.feedback[0].actual, { kind: 'value', value: { constructor: 'own' } })
    } else assert.equal(payload.phase, 'generate')
    return toolResponse('s' + seen.length, 'structured_output', { source: [dropsKey, identity][seen.length - 1] })
  })
  await writeFile(join(h.cwd, 'public-cases.json'), JSON.stringify(suite))
  const started = await h.ctx.commands.execute(h.agent, '/apex_flow Return the complete JSON input unchanged.', [], new AbortController().signal)
  const { report, snapshot } = await h.collect(started)
  assert.equal(snapshot.status, 'completed', JSON.stringify(report))
  assert.equal(h.adapter.requests.length, 2)
  assert.deepEqual(report.candidates.map(c => c.passed), [1, 2])
  assert.ok(report.candidates.every(c => c.execution.exitCode === 0 && !c.execution.timedOut))
  assert.deepEqual(report.repairs[0].regressions, [])
  assert.equal(report.delivery.hash, digest(identity))
  assert.equal(report.delivery.passed, 2)
  assert.deepEqual(report.delivery.replay.outcomes, values(inputs))
  assert.equal(await readFile(join(h.cwd, 'solver.mjs'), 'utf8'), identity)
})

test('pending UI selection overrides creation and earlier request routes before any parent call', real, async t => {
  const h = await fixture(t, {}, () => toolResponse('source', 'structured_output', { source: correct }))
  // This is the actual official projection used by session.selectModel, not a stub.
  const { installModelSelectionProjection } = await import(pathToFileURL(join(harnessRoot,
    'packages/api/session-controller/src/model-selection-projection.ts')))
  installModelSelectionProjection(h.ctx)
  h.agent.session.append('request/header', { header: { config: {
    provider: 'deepseek-official', model: 'previous-model', reasoningEffort: 'max',
  } }, reason: 'initial' })
  h.agent.session.append('model/selection', {
    provider: 'deepseek-official', model: 'newly-selected-model',
  })
  const { report, snapshot } = await h.collect(await h.start())
  assert.equal(snapshot.status, 'completed', JSON.stringify(report))
  assert.equal(report.requestedModel.model, 'newly-selected-model')
  assert.equal(report.requestedModel.reasoningEffort, 'max', 'resolve the selected model default')
  assert.equal(h.adapter.requests.length, 1)
  const request = h.adapter.requests[0]
  assert.equal(request.model, 'newly-selected-model')
  assert.equal(request.reasoningEffort, 'max')
  assert.equal(request.maxTokens, report.config.maxTokens)
})

test('selection made before the first request supplies the child reasoning effort', real, async t => {
  const h = await fixture(t, { maxTokens: 393216, childTimeoutMs: 3600000 },
    () => toolResponse('source', 'structured_output', { source: correct }))
  const { installModelSelectionProjection } = await import(pathToFileURL(join(harnessRoot,
    'packages/api/session-controller/src/model-selection-projection.ts')))
  installModelSelectionProjection(h.ctx)
  delete h.agent.options.reasoningEffort
  h.agent.session.append('model/selection', {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
  })
  assert.equal(h.agent.session.requestHeader(), undefined)
  const { report, snapshot } = await h.collect(await h.start())
  assert.equal(snapshot.status, 'completed', JSON.stringify(report))
  assert.equal(report.requestedModel.reasoningEffort, 'max')
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.adapter.requests[0].reasoningEffort, 'max')
  assert.equal(h.adapter.requests[0].maxTokens, 393216)
})

test('paired entry replays one checkpoint and binds exactly one repair in both policies', real, async t => {
  const payloads = []
  for (const mode of ['signature', 'random']) {
    const h = await fixture(t, { mode }, request => {
      const payload = taskPayload(request); payloads.push(payload)
      assert.equal(payload.phase, 'repair'); assert.equal(payload.task, checkpoint.task)
      assert.equal(payload.source, sourceA)
      assert.deepEqual(payload.feedback, selectFeedback({ ...selection, mode }).feedback)
      return toolResponse('repaired', 'structured_output', { source: correct })
    })
    await writeFile(join(h.cwd, 'checkpoint.json'), JSON.stringify(checkpoint))
    const started = await h.ctx.commands.execute(h.agent, '/apex_repair checkpoint.json', [], new AbortController().signal)
    const { report, snapshot } = await h.collect(started)
    assert.equal(snapshot.status, 'completed', JSON.stringify(report))
    assert.equal(h.adapter.requests.length, 1, 'no paid initialization or extra parent request')
    assert.equal(report.children.length, 1)
    assert.equal(report.checkpoint.hash, digest(JSON.stringify(checkpoint)))
    assert.equal(report.checkpoint.parentId, checkpoint.parentId)
    assert.deepEqual(report.candidates.map(c => c.origin), ['checkpoint-replay', 'checkpoint-replay', 'generated'])
    assert.equal(report.delivery.passed, 4)
  }
  const common = ({ feedback, ...value }) => value
  assert.deepEqual(common(payloads[0]), common(payloads[1]))
})

test('checkpoint observation forgery, ineligible evidence and multiple repairs spend no model calls', real, async t => {
  for (const mode of ['forgery', 'ineligible', 'multiple']) {
    const cp = structuredClone(checkpoint)
    if (mode === 'forgery') cp.candidates[0].outcomes[1] = { kind: 'value', value: 2 }
    if (mode === 'ineligible') {
      cp.candidates = [9, 7].map(value => {
        const source = 'export const solve=()=>'+value
        return { id: digest(source), source, outcomes: values(cases.map(() => value)) }
      })
      cp.parentId = cp.candidates[0].id
    }
    const h = await fixture(t, mode === 'multiple' ? { maxRepairs: 2 } : {})
    await writeFile(join(h.cwd, 'checkpoint.json'), JSON.stringify(cp))
    const started = await h.ctx.commands.execute(h.agent, '/apex_repair checkpoint.json', [], new AbortController().signal)
    if (mode === 'multiple') assert.equal(started.result.kind, 'error')
    else {
      const { report, snapshot } = await h.collect(started)
      assert.equal(snapshot.status, 'failed', JSON.stringify(report))
      assert.match(report.reason, mode === 'forgery' ? /differs from frozen/ : /not eligible/)
      assert.equal(report.children.length, 0); assert.equal(report.delivery, null)
    }
    assert.equal(h.adapter.requests.length, 0)
  }
})

test('public pass ends initialization early; disabled entry remains absent', real, async t => {
  const h = await fixture(t)
  const { report } = await h.collect(await h.start())
  assert.equal(report.reason, 'public-pass'); assert.equal(report.children.length, 1)
  assert.deepEqual(report.repairs, [])
  assert.equal(h.adapter.requests.length, 1)
  const off = await fixture(t, { mode: 'off' }, () => textResponse('done'))
  assert.equal(await off.start(), undefined)
  await off.turn(off.agent, 'Ordinary task')
  assert.doesNotMatch(systemText(off.adapter.requests[0]), /host owns execution|apex_flow/)
})

test('random arm binds selected facts and rejects private-file reads and writes', real, async t => {
  const privateDir = await mkdtemp(join(tmpdir(), 'apex-private-evidence-'))
  t.after(() => rm(privateDir, { recursive: true, force: true }))
  const secret = 'private-oracle-canary-' + digest(privateDir)
  const privateFile = join(privateDir, 'oracle.json')
  await writeFile(privateFile, JSON.stringify({ secret }))
  let step = 0
  const h = await fixture(t, { mode: 'random' }, request => {
    step++
    assert.deepEqual(request.tools.map(tool => tool.name), ['structured_output'])
    assert.ok(!JSON.stringify(request).includes(secret), 'private oracle content never enters a model request')
    assert.equal(taskPayload(request).publicCasesPath, undefined)
    if (step === 1) return toolResponse('read', 'read', { file_path: privateFile })
    if (step === 2) assert.ok(JSON.stringify(request.messages).includes('"isError":true'), 'read is rejected before file content is returned')
    if (step === 2) return toolResponse('denied', 'write', { file_path: 'forbidden.txt', content: 'no' })
    if (step === 3) return toolResponse('a', 'structured_output', { source: sourceA })
    if (step === 4) return toolResponse('b', 'structured_output', { source: sourceB })
    const payload = taskPayload(request)
    const expected = selectFeedback({ ...selection, mode: 'random' }).feedback
    assert.deepEqual(payload.feedback, expected)
    assert.equal(payload.source, sourceA)
    return toolResponse('c', 'structured_output', { source: correct })
  })
  const { report, snapshot } = await h.collect(await h.start())
  assert.equal(snapshot.status, 'completed', JSON.stringify(report))
  assert.equal(report.children.length, 3); assert.equal(h.adapter.requests.length, 5)
  assert.equal(report.children[0].reads.length, 1)
  assert.equal(report.children[0].reads[0].name, 'read')
  assert.equal(report.children[0].usage.outputTokens, 15)
  assert.equal(report.repairs[0].mode, 'random')
  await assert.rejects(access(join(h.cwd, 'forbidden.txt')), { code: 'ENOENT' })
})

test('evidence children cannot search for other candidates or grader files', real, async t => {
  for (const name of ['glob', 'grep']) await t.test(name, async t => {
    let step = 0
    const h = await fixture(t, { initialCandidates: 1 }, request => {
      assert.deepEqual(request.tools.map(tool => tool.name), ['structured_output'])
      if (++step === 1) return toolResponse('probe', name, { path: '..', pattern: name === 'glob' ? '**/*' : 'private-oracle-canary' })
      assert.ok(JSON.stringify(request.messages).includes('"isError":true'))
      return toolResponse('source', 'structured_output', { source: correct })
    })
    const { snapshot, report } = await h.collect(await h.start())
    assert.equal(snapshot.status, 'completed', JSON.stringify(report))
    assert.equal(h.adapter.requests.length, 2)
    assert.equal(report.delivery.passed, cases.length)
  })
})

test('uncollected completion cannot wake another model request; explicit user continuation still works', real, async t => {
  const h = await fixture(t, { completionDelivery: 'wakeup' }, request => taskPayload(request)
    ? toolResponse('s', 'structured_output', { source: correct }) : textResponse('User continuation received.'))
  const completed = new Promise(resolve => h.ctx.jobs.events.subscribe({ owner: h.agent.id }, event => {
    if (event.type === 'settled' && event.job.status === 'completed') resolve(event.job)
  }))
  const started = await h.start()
  assert.equal(started.result.kind, 'success')
  assert.equal((await completed).status, 'completed')
  await h.agent.whenIdle()
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(digest(await readFile(join(h.cwd, 'solver.mjs'))), digest(correct))
  assert.ok(h.agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'aborted'))
  await h.turn(h.agent, 'Explain the frozen result.')
  assert.equal(h.adapter.requests.length, 2)
})

test('regressing repair is recorded and the best previous source is delivered', real, async t => {
  let n = 0
  const h = await fixture(t, { initialCandidates: 1 }, () => toolResponse('s' + n, 'structured_output', {
    source: n++ === 0 ? 'export const solve=x=>x===3?9:x*2' : sourceB,
  }))
  const { report } = await h.collect(await h.start())
  assert.equal(report.reason, 'candidate-budget')
  assert.equal(report.delivery.passed, 3)
  assert.deepEqual(report.repairs[0].regressions, [0, 2])
  assert.equal(report.repairs[0].researchEligible, false)
})

test('job outlives launch cancellation; explicit kill waits for child cleanup and prevents repair', real, async t => {
  let began, ended = false
  const startedChild = new Promise(resolve => { began = resolve })
  const h = await fixture(t, {}, async request => {
    began()
    try { await delay(20000, undefined, { signal: request.signal }) }
    finally { ended = true }
    return toolResponse('never', 'structured_output', { source: correct })
  })
  const launch = new AbortController(), started = await h.start(launch.signal)
  const handle = JSON.parse(started.result.text)
  launch.abort()
  await Promise.race([startedChild, h.ctx.jobs.wait(handle.jobId, 2000, h.agent.id).then(snapshot => {
    if (snapshot.status !== 'running') throw new Error('Job settled before the scripted child: ' + JSON.stringify(snapshot))
  })])
  assert.equal(h.ctx.jobs.get(handle.jobId, h.agent.id).status, 'running')
  assert.equal((await h.start()).result.kind, 'error')
  h.ctx.jobs.kill(handle.jobId, h.agent.id)
  const { report, snapshot } = await h.collect(started)
  assert.equal(snapshot.status, 'killed', JSON.stringify(report))
  assert.ok(ended); assert.equal(report.children.length, 1); assert.equal(report.delivery, null)
  await assert.rejects(access(join(h.cwd, 'solver.mjs')), { code: 'ENOENT' })
  assert.equal(h.adapter.requests.length, 1)
})

test('missing structured output and per-child deadlines fail without extra attempts', real, async t => {
  for (const timeout of [false, true]) {
    const h = await fixture(t, { childTimeoutMs: timeout ? 100 : 1000 }, async request => {
      if (timeout) await delay(10000, undefined, { signal: request.signal })
      return textResponse('No source')
    })
    const { report, snapshot } = await h.collect(await h.start())
    assert.equal(snapshot.status, 'failed', JSON.stringify(report))
    assert.match(report.reason, timeout ? /timed out/ : /structured source/)
    assert.equal(report.children.length, 1); assert.equal(report.delivery, null)
  }
})

test('owner disposal cancels and awaits the active child, with missing usage kept unknown', real, async t => {
  let began, ended = false
  const childStarted = new Promise(resolve => { began = resolve })
  const h = await fixture(t, {}, async request => {
    began()
    try { await delay(20000, undefined, { signal: request.signal }) }
    finally { ended = true }
    return toolResponse('never', 'structured_output', { source: correct })
  })
  const started = await h.start(), handle = JSON.parse(started.result.text)
  await childStarted
  await h.dispose(h.agent)
  assert.ok(ended, 'disposal reaches quiescence before returning')
  const report = JSON.parse(await readFile(join(h.cwd, handle.report), 'utf8'))
  assert.equal(report.status, 'killed')
  assert.equal(report.children[0].usage, null)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(report.delivery, null)
})

test('suite edits, output races and symlinks are refused without overwriting data', real, async t => {
  for (const mode of ['suite', 'output']) {
    const h = await fixture(t, {}, async () => {
      await writeFile(join(h.cwd, mode === 'suite' ? 'public-cases.json' : 'solver.mjs'), 'external edit')
      return toolResponse('s', 'structured_output', { source: correct })
    })
    const { snapshot, report } = await h.collect(await h.start())
    assert.equal(snapshot.status, 'failed', JSON.stringify(report))
    assert.equal(await readFile(join(h.cwd, mode === 'suite' ? 'public-cases.json' : 'solver.mjs'), 'utf8'), 'external edit')
    assert.equal(report.delivery, null)
  }
  const h = await fixture(t)
  await symlink('public-cases.json', join(h.cwd, 'solver.mjs'))
  const result = await h.start()
  assert.equal(result.result.kind, 'error'); assert.match(result.result.text, /regular files/)
  assert.equal(h.adapter.requests.length, 0)
})
