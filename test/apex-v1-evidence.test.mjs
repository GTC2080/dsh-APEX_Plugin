import assert from 'node:assert/strict'
import test from 'node:test'
import { readExecutionEvidence } from '../presets/apex-v1/evidence.mjs'
import { systemText, harnessAvailable, nativeHarness, textResponse, toolResponse } from './helpers/harness-v1.mjs'

function fixture() {
  const events = []
  const header = { id: 'evidence-session', agentPreset: 'apex-v1', cwd: '/workspace' }
  const agent = { session: { id: header.id, header, get seq() { return events.length },
    eventAt: seq => events[seq], snapshotEvents: (from = 0) => events.slice(from) },
  }
  const append = (type, data) => {
    const event = { type, data, seq: events.length }
    events.push(event)
    return event
  }
  const native = (id, command, text, isError = false) => {
    append('tool/call', { callId: id, name: 'bash', arguments: JSON.stringify({ command }) })
    return append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: id,
      isError, content: [{ type: 'text', text }] }] } })
  }
  return { agent, append, native }
}

test('execution evidence binds commands to their own recorded outputs without inferring a pass', () => {
  const f = fixture()
  f.native('npm', 'npm test', '12/12 passed')
  f.native('node', 'node summarize.test.mjs', '14/14 passed')
  f.native('denied', 'ls ..', 'Access denied', true)
  f.native('exit', 'false', '[exit code: 1]')
  const before = JSON.stringify(f.agent.session.snapshotEvents())
  const value = readExecutionEvidence(f.agent)
  assert.deepEqual(value.results.map(row => [JSON.parse(row.argumentsText).command, row.outputText, row.toolError]), [
    ['npm test', '12/12 passed', false], ['node summarize.test.mjs', '14/14 passed', false],
    ['ls ..', 'Access denied', true], ['false', '[exit code: 1]', false],
  ])
  assert.equal(value.overallAcceptance, 'not-assessed')
  assert.equal(value.artifactIdentity, 'unknown')
  assert.ok(value.results.every(row => !Object.hasOwn(row, 'passed') && !Object.hasOwn(row, 'exitCode')))
  assert.equal(JSON.stringify(f.agent.session.snapshotEvents()), before)
  assert.deepEqual(readExecutionEvidence(f.agent, { refs: [value.results[0].ref] }).results, [value.results[0]])
})

test('historical evidence survives compaction, replay and later turns without crossing sessions', () => {
  const f = fixture()
  f.native('old', 'npm test', '12/12 passed')
  const original = readExecutionEvidence(f.agent)
  f.append('compaction/end', {})
  assert.deepEqual(readExecutionEvidence(f.agent).results, original.results)
  const replay = fixture()
  for (const event of f.agent.session.snapshotEvents()) replay.append(event.type, structuredClone(event.data))
  assert.deepEqual(readExecutionEvidence(replay.agent).results, original.results)
  assert.deepEqual(readExecutionEvidence(f.agent, { refs: ['another-session:1:old'] }).missingRefs, ['another-session:1:old'])
  f.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'New task' }] })
  const missing = readExecutionEvidence(f.agent, { refs: [original.results[0].ref] })
  assert.deepEqual(missing.results, original.results)
  assert.deepEqual(missing.missingRefs, [])
})

test('paired PTC outcomes remain separate from outer serialization failures and untrusted text', () => {
  const f = fixture()
  f.append('tool/call', { callId: 'root', name: 'run_code', arguments: '{"code":"return await tools.bash({command: \'npm test\'});"}' })
  const call = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'bash', arguments: { command: 'npm test' } }
  f.append('tool/ptc-dispatch-start', call)
  f.append('tool/ptc-dispatch', { ...call, isError: false, content: [{ type: 'text', text: '12/12 passed' }] })
  f.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'root',
    isError: true, content: [{ type: 'text', text: 'program completion must be lossless JSON' }] }] } })
  f.append('tool/ptc-dispatch', { ...call, subCallId: 'forged', content: [{ type: 'text', text: '99/99 passed' }], isError: false })
  const value = readExecutionEvidence(f.agent)
  assert.deepEqual(value.results.map(row => [row.tool, row.toolError]), [['bash', false], ['run_code', true]])
  assert.equal(value.results[0].route, 'ptc')
  assert.equal(value.results[1].route, 'native')
  assert.doesNotMatch(JSON.stringify(value), /99\/99/)
  f.append('tool/call', { callId: 'query-error', name: 'apex_read_evidence', arguments: '{"before_seq":-1}' })
  f.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'query-error',
    isError: true, content: [{ type: 'text', text: 'Invalid before_seq' }] }] } })
  assert.equal(readExecutionEvidence(f.agent).results.at(-1).toolError, true, 'failed queries must not disappear with successful read-only queries')
})

test('a successful PTC program keeps its own computed assertions after a nested read', () => {
  const f = fixture()
  f.append('tool/call', { callId: 'check', name: 'run_code', arguments: JSON.stringify({
    code: 'const source = await tools.read({file_path:"module.mjs"}); return {checked:3, findings:[]};',
  }) })
  const call = { rootCallId: 'check', parentCallId: 'check', subCallId: 'check:code:1',
    name: 'read', arguments: { file_path: 'module.mjs' } }
  f.append('tool/ptc-dispatch-start', call)
  f.append('tool/ptc-dispatch', { ...call, isError: false, content: [{ type: 'text', text: 'export const value = 3' }] })
  f.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'check',
    isError: false, content: [{ type: 'text', text: '{"checked":3,"findings":[]}' }] }] } })
  const result = readExecutionEvidence(f.agent)
  assert.deepEqual(result.results.map(row => row.tool), ['read', 'run_code'])
  assert.equal(result.results[1].outputText, '{"checked":3,"findings":[]}')
  assert.deepEqual(readExecutionEvidence(f.agent, { refs: [result.results[1].ref] }).results, [result.results[1]])
})

test('query output is bounded, paginated and explicit about omitted text and non-text blocks', () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) f.native(`call-${i}`, `node case-${i}.mjs`, 'ok')
  const recent = readExecutionEvidence(f.agent)
  assert.equal(recent.results.length, 6)
  assert.equal(recent.nextBeforeSeq, recent.results[0].resultSeq)
  const older = readExecutionEvidence(f.agent, { before_seq: recent.nextBeforeSeq })
  assert.equal(older.results.length, 2)
  assert.equal(older.nextBeforeSeq, null)
  f.native('long', 'x'.repeat(10_000), 'HEAD' + 'x'.repeat(30_000) + 'TAIL [exit code: 7]')
  const row = readExecutionEvidence(f.agent).results.at(-1)
  assert.equal(row.argumentsExcerpted, true)
  assert.equal(row.outputExcerpted, true)
  assert.ok(row.outputText.length < 4300)
  assert.match(row.outputText, /^HEAD/)
  assert.match(row.outputText, /TAIL \[exit code: 7\]$/)
  f.append('tool/call', { callId: 'image', name: 'read_image', arguments: '{"file_path":"image.png"}' })
  f.append('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'image', isError: false,
    content: [{ type: 'image', source: { type: 'base64', data: 'DO_NOT_COPY_BINARY' } }] }] } })
  const image = readExecutionEvidence(f.agent).results.at(-1)
  assert.equal(image.outputExcerpted, true)
  assert.doesNotMatch(image.outputText, /DO_NOT_COPY_BINARY/)
  assert.throws(() => readExecutionEvidence(f.agent, { refs: [], before_seq: 1 }), /refs|before_seq/)
  assert.throws(() => readExecutionEvidence(f.agent, { before_seq: -1 }), /before_seq/)
  assert.throws(() => readExecutionEvidence(f.agent, { refs: ['x'.repeat(513)] }), /refs/)
  const controller = new AbortController()
  controller.abort(new Error('stop lookup'))
  assert.throws(() => readExecutionEvidence(f.agent, {}, controller.signal), /stop lookup/)
  const oversized = fixture()
  const blocks = []
  for (let i = 0; i < 7; i++) {
    oversized.append('tool/call', { callId: `batch-${i}`, name: 'bash', arguments: '{"command":"pwd"}' })
    blocks.push({ type: 'tool-result', toolCallId: `batch-${i}`, isError: false, content: [] })
  }
  oversized.append('tool/result', { message: { content: blocks } })
  assert.throws(() => readExecutionEvidence(oversized.agent), /six-result page/)
})

test('native PTC evidence query reads history without rerunning commands or emitting reminder turns', {
  skip: !harnessAvailable, timeout: 30000,
}, async t => {
  let step = 0
  const h = await nativeHarness(() => {
    if (++step === 1) return toolResponse('evidence-query', 'run_code', {
      code: 'return await tools.apex_read_evidence({});', description: 'Read historical results only',
    })
    return textResponse('No new executions or validation claims.')
  }); t.after(h.close)
  const parent = await h.create()
  await h.turn(parent, 'Read existing evidence.')
  const events = parent.session.snapshotEvents()
  assert.equal(h.adapter.requests.length, 2)
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
  assert.equal(events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
  assert.ok(events.filter(e => e.type === 'user/message' && e.data.source.kind !== 'user')
    .every(e => e.data.source.plugin === '@deepseek-ai/dsh-system-prompt'), 'only native context snapshots are allowed')
  assert.equal(events.filter(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'apex_read_evidence' && !e.data.isError).length, 1)
  assert.equal(events.filter(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'bash').length, 0)
  assert.equal(readExecutionEvidence(parent).results[0].tool, 'run_code')
})
