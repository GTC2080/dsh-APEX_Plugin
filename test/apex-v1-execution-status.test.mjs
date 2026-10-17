import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import * as status from '../presets/apex-v1/execution-status.mjs'
import { harnessAvailable, harnessRoot, native, nativeHarness, pluginRoot, systemText, textResponse } from './helpers/harness-v1.mjs'

const isStatus = message => message.source?.kind === status.name
const observations = agent => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && isStatus(e.data))
const facts = message => JSON.parse(message.content[0].text.split('\n')[1])
const quietFailure = 'await tools.bash({command:"exit 7",description:"Observe a dropped failure result"});'

test('execution observations preserve policy, independent outcomes and actual APEX scope', async t => {
  const { createUserMessage } = await native('dsh-llm')
  let handler
  await status.apply({
    root: { loader: { async import(name) {
      assert.equal(name, '@deepseek-ai/dsh-llm'); return { createUserMessage }
    } } },
    agentPresets: { composedPreset: ctx => ctx.preset },
    on(event, callback) { assert.equal(event, 'tools/post-execute'); handler = callback },
  })
  const foreground = { kind: 'foreground', exitCode: 0, signal: null, timedOut: false,
    aborted: false, timeoutMs: 1000, stdout: { text: 'PRIVATE_OUTPUT', truncated: false }, stderr: { text: '', truncated: false } }
  const base = { callId: 'observed-call', name: 'bash', parent: Symbol(),
    agent: { ctx: { preset: 'apex-v1' } }, signal: new AbortController().signal }
  const aborted = new AbortController(); aborted.abort()
  const cases = [
    { label: 'successful foreground is quiet', value: foreground },
    { label: 'explicit background is quiet', value: { kind: 'background', jobId: 'job' } },
    { label: 'promotion keeps its handle', value: { kind: 'promoted', jobId: 'job', timeoutMs: 1000 }, note: true },
    { label: 'nonzero exit', value: { ...foreground, exitCode: 7 }, note: true },
    { label: 'exit zero with timeout', value: { ...foreground, timedOut: true }, note: true },
    { label: 'independent signal', value: { ...foreground, signal: 'SIGTERM' }, note: true },
    { label: 'independent aborted result', value: { ...foreground, aborted: true }, note: true },
    { label: 'unknown exit is not success', value: { ...foreground, exitCode: null }, note: true },
    { label: 'APEX script uses the same path', value: { ...foreground, exitCode: 9 }, exec: { name: 'apex_run_script' }, note: true },
    { label: 'native direct result remains unchanged', value: { ...foreground, exitCode: 7 }, exec: { parent: undefined } },
    { label: 'other tools remain unchanged', value: { ...foreground, exitCode: 7 }, exec: { name: 'read' } },
    { label: 'missing owner remains unchanged', value: { ...foreground, exitCode: 7 }, exec: { agent: undefined } },
    { label: 'caller cancellation remains authoritative', value: { ...foreground, exitCode: 7 }, exec: { signal: aborted.signal } },
    { label: 'dispatch errors are not reclassified', error: true },
    { label: 'unknown result remains unchanged', value: { kind: 'future' } },
    { label: 'block is respected', value: { ...foreground, exitCode: 7 }, decision: { kind: 'block', feedback: [] } },
    { label: 'replacement value is respected', value: { ...foreground, exitCode: 7 }, decision: { kind: 'accept', value: foreground } },
    ...['ptc', 'standard', 'minimal', undefined].map(preset => ({
      label: `no observation outside mounted APEX: ${preset}`,
      value: { ...foreground, exitCode: 7 }, exec: { agent: { ctx: { preset }, session: { header: { agentPreset: 'apex-v1' } } } },
    })),
  ]
  for (const item of cases) await t.test(item.label, async () => {
    const prior = createUserMessage({ source: { kind: 'prior-policy' }, content: [{ type: 'text', text: 'prior' }] })
    const decision = Object.freeze({ kind: 'accept', additionalContexts: [prior], ...item.decision })
    const result = Object.freeze(item.error ? { isError: true, error: { message: 'PRIVATE_ERROR' } }
      : { isError: false, value: Object.freeze(item.value), content: [{ type: 'text', text: 'PRIVATE_RENDER' }] })
    const before = structuredClone(result)
    let nextCalls = 0
    const exec = { ...base, ...item.exec }
    const output = await handler(exec, result, async () => { nextCalls++; return decision })
    assert.equal(nextCalls, 1); assert.deepEqual(result, before)
    if (!item.note) { assert.equal(output, decision); return }
    assert.equal(output.additionalContexts.length, 2)
    assert.equal(output.additionalContexts[0], prior)
    const note = output.additionalContexts[1]
    assert.ok(isStatus(note)); assert.doesNotMatch(note.content[0].text, /PRIVATE_/)
    assert.equal(facts(note).tool, exec.name)
    assert.equal(facts(note).callId, exec.callId)
    for (const key of Object.keys(facts(note)).filter(k => !['callId', 'tool'].includes(k))) {
      assert.deepEqual(facts(note)[key], item.value[key])
    }
    assert.equal(Object.hasOwn(output, 'value'), false)
    assert.equal(Object.hasOwn(output, 'content'), false)
  })
})

test('optional package overlay preserves complete APEX and native modes through lifecycle and bursts', {
  skip: !harnessAvailable || process.platform !== 'darwin', timeout: 60000,
}, async t => {
  const { entryListSchema, applyEntryPatches } = await native('cordis-plugin-include')
  const { load } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const overlay = load(await readFile(join(pluginRoot, 'presets/apex-v1/execution-status.patch.yml'), 'utf8'), { schema: entryListSchema })
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch.some(file => file.includes('execution-status')), false)
  assert.equal((await import('dsh-apex/apex-v1/execution-status')).name, status.name)
  let compactionInput
  const h = await nativeHarness(request => {
    const last = request.messages.at(-1)?.content?.map(block => block.text ?? '').join('\n') ?? ''
    if (!last.includes('acting as a compaction engine')) return textResponse('done')
    compactionInput = request.messages.filter(isStatus)
    return textResponse('## Primary Request and Intent\n- Check execution observations.\n'
      + '## Key Technical Concepts\n- APEX execution status.\n## Files and Code\n- (none)\n'
      + '## Errors and Fixes\n- Completed shell calls returned exit code 7.\n'
      + '## Pending Jobs\n- (none)\n## Current Work\n- Local lifecycle check.\n'
      + '## Next Step\n- Continue checking new observations.\n## Critical Context\n'
      + '- These are execution observations, not task acceptance or cleanup proof.')
  }, { shippedPresets: true })
  try {
    const apex = await h.create('status-apex'), official = await h.create('status-official', 'ptc')
    const standard = await h.create('status-standard', 'standard'), minimal = await h.create('status-minimal', 'minimal')
    const agents = [apex, official, standard, minimal]
    const schemas = new Map(agents.map(agent => [agent, h.ctx.tools.schemas(agent)]))
    const prompts = new Map()
    for (const agent of agents) {
      await h.turn(agent, 'Reply done.')
      prompts.set(agent, systemText(h.adapter.requests.at(-1)))
    }
    const control = await h.runCode(apex, quietFailure)
    assert.equal(control.isError, false)
    assert.equal(control.value.result, '(run_code completed with no output)')
    assert.equal(observations(apex).length, 0)
    const baseRows = [...h.ctx.loader.root.data]
    await h.ctx.loader.root.update(applyEntryPatches(baseRows, structuredClone(overlay), message => { throw new Error(message) }))
    await h.ctx.loader.await()
    await h.ctx.loader.resolve('apex-execution-status').fiber.await()
    for (const agent of agents) {
      assert.deepEqual(h.ctx.tools.schemas(agent), schemas.get(agent))
      await h.turn(agent, 'Reply done.')
      assert.equal(systemText(h.adapter.requests.at(-1)), prompts.get(agent))
    }

    const start = apex.session.seq
    assert.deepEqual(await h.runCode(apex, quietFailure), control)
    let notes = observations(apex)
    assert.equal(notes.length, 1); assert.equal(facts(notes[0].data).exitCode, 7)
    assert.equal(h.adapter.requests.at(-1).messages.filter(isStatus).length, 1)
    assert.ok(notes[0].seq > apex.session.snapshotEvents(start).find(e => e.type === 'tool/result').seq)
    await h.runCode(official, quietFailure)
    for (const agent of [official, standard, minimal]) assert.equal(observations(agent).length, 0)
    const fresh = await h.create('status-fresh-apex')
    await h.runCode(fresh, quietFailure)
    assert.equal(observations(fresh).length, 1)
    assert.equal(observations(apex).length, 1, 'New APEX sessions retain their own observations')
    await h.runCode(apex, 'await tools.apex_run_script({command:"node",script:"process.exit(9)",description:"Dropped script result"});')
    assert.equal(facts(observations(apex).at(-1).data).tool, 'apex_run_script')
    assert.equal(facts(observations(apex).at(-1).data).exitCode, 9)

    const count = observations(apex).length
    await h.runCode(apex, 'await tools.bash({command:"true",description:"Successful command"});')
    assert.equal(observations(apex).length, count)
    const unguard = apex.ctx.tools.guard(exec => exec.name === 'bash' ? 'Fixture denial' : undefined)
    try {
      await h.runCode(apex, 'try { ' + quietFailure + ' } catch {}')
      assert.equal(observations(apex).length, count)
    } finally { unguard() }
    const suppress = apex.ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      return exec.name === 'bash' ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture policy block' }] } : decision
    })
    try {
      await h.runCode(apex, 'try { ' + quietFailure + ' } catch {}')
      assert.equal(observations(apex).length, count)
    } finally { suppress() }

    const browserFailure = await h.runCode(apex, 'return await tools.bash({command:"printf \'ProcessSingleton: Failed to create socket directory\\n\' >&2; exit 21",description:"Existing browser guidance fixture"});')
    assert.equal(browserFailure.value.result.exitCode, 21)
    assert.equal(h.adapter.requests.at(-1).messages.filter(m => m.source?.kind === 'apex-browser-guidance').length, 1)
    assert.equal(facts(observations(apex).at(-1).data).exitCode, 21)
    const outerFailure = await h.runCode(apex, quietFailure + 'throw new Error("Outer fixture error");')
    assert.equal(outerFailure.isError, true)
    assert.equal(observations(apex).length, count + 2)

    const promoted = await h.runCode(apex, 'const r=await tools.bash({command:"node -e \'setTimeout(()=>{},5000)\'",description:"Owned promotion fixture",timeoutMs:500}); if(r.kind==="foreground") console.log(r.stdout.text);')
    assert.equal(promoted.isError, false)
    assert.equal(promoted.value.result, '(run_code completed with no output)')
    const job = facts(observations(apex).at(-1).data)
    assert.equal(job.kind, 'promoted')
    assert.equal(facts(h.adapter.requests.at(-1).messages.filter(isStatus).at(-1)).jobId, job.jobId)
    const stopped = await h.runCode(apex, `return await tools.job_kill(${JSON.stringify({ job_id: job.jobId, reason: 'Owned fixture cleanup' })});`)
    assert.equal(stopped.isError, false)
    assert.equal((await h.ctx.jobs.wait(job.jobId, 3000, apex.id)).status, 'killed')

    const burstStart = observations(apex).length
    for (let batch = 0; batch < 4; batch++) {
      const result = await h.runCode(apex, `await Promise.all(Array.from({length:16},()=>tools.bash({command:"exit 7",description:"Independent burst failure"})));`)
      assert.equal(result.isError, false)
      assert.equal(observations(apex).length, burstStart + (batch + 1) * 16)
    }
    notes = observations(apex).slice(burstStart).map(event => event.data)
    assert.equal(new Set(notes.map(note => facts(note).callId)).size, 64)
    assert.ok(notes.every(note => facts(note).exitCode === 7))
    const bytes = notes.map(note => Buffer.byteLength(note.content[0].text))
    assert.ok(Math.max(...bytes) < 500, 'Fixture per-dispatch prose must remain compact')
    assert.equal(h.adapter.requests.at(-1).messages.filter(isStatus).length, burstStart + 64)
    t.diagnostic(JSON.stringify({ burstCalls: 64, statusMessages: notes.length,
      statusTextBytes: bytes.reduce((a, b) => a + b, 0), maxStatusTextBytes: Math.max(...bytes), paidApiCalls: 0 }))

    const beforeReplay = observations(apex).map(event => event.data)
    await h.dispose(apex)
    const resumed = await h.resume('status-apex')
    assert.deepEqual(observations(resumed).map(event => event.data), beforeReplay)
    await h.runCode(resumed, quietFailure)
    assert.equal(observations(resumed).length, beforeReplay.length + 1)
    assert.deepEqual(h.ctx.tools.schemas(resumed), schemas.get(apex))

    const compaction = h.ctx.agentPresets.serviceFor(resumed, 'compaction')
    assert.ok(compaction, 'Use the complete APEX preset compaction service')
    const compacted = await compaction.compactNow(resumed, new AbortController().signal)
    assert.ok(compacted, 'Native compaction must actually replace a history region')
    assert.ok(compactionInput.length > 0, 'Execution observations reach the native summarizer')
    await h.turn(resumed, 'Continue after the scripted checkpoint.')
    assert.match(JSON.stringify(h.adapter.requests.at(-1).messages), /Completed shell calls returned exit code 7/)
    const afterCompaction = observations(resumed).length
    await h.runCode(resumed, quietFailure)
    assert.equal(observations(resumed).length, afterCompaction + 1)
    assert.equal(facts(h.adapter.requests.at(-1).messages.filter(isStatus).at(-1)).exitCode, 7)
    t.diagnostic(JSON.stringify({ compactionInputStatusMessages: compactionInput.length,
      scriptedSummaryOnly: true, newStatusAfterCompaction: true }))

    const mounted = h.ctx.loader.resolve('apex-execution-status').fiber
    await h.ctx.loader.root.update(baseRows)
    await mounted.dispose()
    let priorCount = observations(resumed).length
    await h.runCode(resumed, quietFailure)
    assert.equal(observations(resumed).length, priorCount)
    // Loader marks disposed runtime rows disabled. A new load uses fresh configuration data.
    await h.ctx.loader.root.update(applyEntryPatches(baseRows, structuredClone(overlay), message => { throw new Error(message) }))
    await h.ctx.loader.await()
    await h.ctx.loader.resolve('apex-execution-status').fiber.await()
    await h.runCode(resumed, quietFailure)
    assert.equal(observations(resumed).length, priorCount + 1, 'Reload adds exactly one listener')
    assert.equal(resumed.session.snapshotEvents().filter(e => e.type === 'approval/asked').length, 0)
    t.diagnostic(JSON.stringify({ fullApex: true, nativeModesUnchanged: ['standard', 'minimal', 'ptc'],
      scriptAndBashCovered: true, durableReplay: true, unloadReload: true, ownedJobStatus: 'killed' }))
  } finally { await h.close() }
  await assert.rejects(access(h.root), { code: 'ENOENT' })
})
