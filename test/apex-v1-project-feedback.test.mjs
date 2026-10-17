import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { harnessAvailable, harnessRoot, native, nativeHarness, pluginRoot, textResponse, toolResponse } from './helpers/harness-v1.mjs'
import { evaluateProject, parseProjectChecks, projectCoverage, projectFeedbackFacts, projectFeedbackText, protectedIdentity, validateProjectConfig } from '../presets/apex-v1/project-evaluation.mjs'
import { Config, feedbackReportPath } from '../presets/apex-v1/native-feedback.mjs'

const node = process.execPath

test('paired and live project repair share bounded failure-only facts', () => {
  const evaluation = { identity: { bindingSha256: 'binding', protectedFiles: ['host-only'] },
    artifact: { after: { hash: 'artifact' } }, output: { stderr: 'private-stderr' },
    checks: [{ id: 'pass', passed: true, detail: 'private-pass-detail' },
      { id: 'fail', passed: false, expected: '修复', actual: '遗漏' }] }
  const text = projectFeedbackText(evaluation)
  const json = text.slice(text.indexOf('\n') + 1)
  assert.equal(projectFeedbackFacts(evaluation), json)
  assert.deepEqual(JSON.parse(json), { bindingSha256: 'binding', artifactHash: 'artifact',
    passed: 1, total: 2, checks: [evaluation.checks[1]] })
  assert.doesNotMatch(text, /host-only|private-stderr|private-pass-detail/)
  assert.equal(projectFeedbackText(evaluation, Buffer.byteLength(json)), text)
  assert.throws(() => projectFeedbackText(evaluation, Buffer.byteLength(json) - 1), /feedbackBytes/)
  assert.throws(() => projectFeedbackFacts(evaluation, Buffer.byteLength(json) - 1), /feedbackBytes/)
  assert.throws(() => projectFeedbackFacts({ ...evaluation, checks: [evaluation.checks[0]] }), /measured failure/)
  assert.throws(() => projectFeedbackText({ ...evaluation, checks: [evaluation.checks[0]] }), /measured failure/)
  const missingReply = { ...evaluation, checks: [evaluation.checks[0]],
    finalResponse: { required: true, present: false, turn: 1, eventSeq: 8 } }
  const replyFacts = projectFeedbackFacts(missingReply)
  assert.deepEqual(JSON.parse(replyFacts).finalResponse, missingReply.finalResponse)
  assert.deepEqual(JSON.parse(replyFacts).checks, [])
  assert.throws(() => projectFeedbackFacts(missingReply, Buffer.byteLength(replyFacts) - 1), /feedbackBytes/)
  assert.throws(() => projectFeedbackFacts({ ...missingReply, finalResponse: { required: true, present: true } }), /measured failure/)
})
const real = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }
const webCheck = {
  check_id: 'hidden-part', assertion: 'Hidden part leaves no residual marker', root: '.', interaction_required: true,
  interactions: [{ click_selector: '#hide-part' }],
  selector_checks: [{ selector: '#part', state: 'hidden' }, { selector: '#required-marker', state: 'present' }],
  text_checks: [{ phase: 'after', selector: '#residual', equals: '' }],
}
const canvasWebCheck = {
  check_id: 'canvas-residual', assertion: 'Hiding the part removes its residual line', root: '.', interaction_required: true,
  interactions: [{ click_selector: '#hide-part' }],
  selector_checks: [{ selector: '#part', state: 'hidden' }],
  canvas_checkpoints: [
    { id: 'before-hide', selector: '#view', after_interaction: 0 },
    { id: 'after-hide', selector: '#view', after_interaction: 1, compare_to: 'before-hide', expectation: 'different' },
  ],
}

function codeTool(id, code) {
  return toolResponse(id, 'run_code', { code, description: 'Project feedback integration check' })
}

function reasoningResponse() {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Private planning; no delivered answer.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Private planning; no delivered answer.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function writeFiles(source, build) {
  return codeTool('write-' + source + build,
    'await tools.read({file_path:"source.txt"});'
    + 'await tools.read({file_path:"build.txt"});'
    + 'await tools.write({file_path:"source.txt",content:' + JSON.stringify(source) + '});'
    + 'return await tools.write({file_path:"build.txt",content:' + JSON.stringify(build) + '});')
}

function writeWeb(html) {
  return codeTool('write-web-' + html.length,
    'await tools.read({file_path:"index.html"});'
    + 'const result = await tools.write({file_path:"index.html",content:' + JSON.stringify(html) + '});'
    + 'if (result?.isError === true) throw new Error("web repair write failed");'
    + 'return result;')
}

function removeCaptures(t, report) {
  const paths = new Set()
  const visit = value => {
    if (value === null || typeof value !== 'object') return
    if (typeof value.screenshotPath === 'string' && value.screenshotPath) paths.add(value.screenshotPath)
    for (const child of Object.values(value)) visit(child)
  }
  visit(report)
  for (const path of paths) {
    const directory = dirname(path)
    assert.match(directory.split('/').at(-1), /^dsh-apex-evidence-/)
    t.after(() => rm(directory, { recursive: true, force: true }))
  }
}

async function fixture(t, script, options = {}) {
  const { initialSource, initialBuild, checkerWrite, checkerExitCode, largeDetail, shippedPresets, projectPreset = 'apex-v1',
    workspaceRoot: configuredRoot, webChecks, webHtml, requirements, measurementComplete = true, checkerStderr, checkIds, ...configOptions } = options
  const root = await mkdtemp(join(tmpdir(), 'apex-project-checker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'apex-project-workspace-'))
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  await mkdir(join(root, projectPreset))
  const reportDirectory = join(root, 'reports')
  await mkdir(reportDirectory)
  const checker = join(root, 'checker.mjs')
  await writeFile(checker, `import { readFile, writeFile } from 'node:fs/promises'
${checkerWrite ? `let writeAttempt = 'denied'
try { await writeFile('readonly-write.txt', 'unexpected')
  writeAttempt = 'unexpected'
} catch {}` : ''}
const source = await readFile('source.txt', 'utf8')
const build = await readFile('build.txt', 'utf8')
const detail = ${JSON.stringify(largeDetail ? 'x'.repeat(5000) : 'matches')}
console.log(JSON.stringify({measurementComplete:${JSON.stringify(measurementComplete)},checks:[
  {id:'source',passed:source==='good',expected:'good',actual:source,detail:'source ' + detail},
  {id:'build',passed:build==='good',expected:'good',actual:build,detail:'build ' + detail}${checkerWrite ? `,
  {id:'readonly',passed:writeAttempt==='denied',expected:'denied',actual:writeAttempt,detail:'checker write is denied'}` : ''}
]}))
${checkerStderr === undefined ? '' : `console.error(${JSON.stringify(checkerStderr)})`}
${checkerExitCode === undefined ? '' : `process.exitCode = ${checkerExitCode}`}
`)
  const project = { command: `${node} ${checker}`, protectedFiles: [checker], checkIds: checkIds ?? (checkerWrite ? ['source', 'build', 'readonly'] : ['source', 'build']),
    ...(webChecks === undefined ? {} : { webChecks }), ...(requirements === undefined ? {} : { requirements }) }
  const basePreset = (await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8'))
    .replace(/dsh-apex\/apex-v1\/([\w-]+)/g, (_, name) => JSON.stringify(join(pluginRoot, 'presets/apex-v1', name + '.mjs')))
  const { entryListSchema } = await native('cordis-plugin-include')
  const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const rows = load(basePreset, { schema: entryListSchema })
  const presetRoot = rows.find(row => Array.isArray(row.insert))?.insert?.find(row => row.id === 'preset-apex-v1')
  assert.ok(presetRoot, 'fixture must have a preset declaration')
  if (projectPreset !== 'apex-v1') {
    presetRoot.id = projectPreset
    presetRoot.config.id = projectPreset
  }
  const session = presetRoot?.config?.plugins?.find(row => row.id === 'apex-session')
  assert.ok(session && Array.isArray(session.config), 'fixture must have an apex-session group')
  assert.equal(rows.some(row => row.id === 'native-feedback-project-test'), false, 'fixture must not add a root entry')
  session.config.push({
    id: 'native-feedback-project-test',
    name: join(pluginRoot, 'presets/apex-v1/native-feedback.mjs'),
    config: { mode: 'repair', evaluationTimeoutMs: 5000, reportDirectory, ...configOptions,
      workspaceRoot: configuredRoot ?? workspaceRoot, project },
  })
  const preset = dump(rows, { schema: entryListSchema, noRefs: true })
  await writeFile(join(root, projectPreset, 'agent.cordis.yml'), preset)
  const h = await nativeHarness(script, { presetRoot: root, workspaceRoot, shippedPresets, preset: projectPreset })
  t.after(h.close)
  await writeFile(join(h.cwd, 'source.txt'), initialSource ?? 'bad')
  await writeFile(join(h.cwd, 'build.txt'), initialBuild ?? 'bad')
  if (webHtml !== undefined) await writeFile(join(h.cwd, 'index.html'), webHtml)
  const agent = await h.create('apex-parent', projectPreset)
  const reportPath = await feedbackReportPath(reportDirectory, h.cwd)
  const report = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = JSON.parse(await readFile(reportPath, 'utf8'))
      if (value.status !== 'running') return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return JSON.parse(await readFile(reportPath, 'utf8'))
  }
  return { ...h, agent, report, reportPath, checker }
}

test('project config is opt-in and preserves old native defaults', () => {
  assert.equal(validateProjectConfig(null), null)
  assert.throws(() => validateProjectConfig({ command: 'true', protectedFiles: [], checkIds: [] }))
  assert.throws(() => validateProjectConfig({ command: 'true', protectedFiles: ['/tmp/x'], checkIds: ['x', 'x'] }))
  const configured = validateProjectConfig({ command: 'true', protectedFiles: ['/tmp/x'], checkIds: ['x'], webChecks: [webCheck] })
  assert.deepEqual(configured.webChecks, [webCheck])
  assert.throws(() => validateProjectConfig({ command: 'true', protectedFiles: ['/tmp/x'], checkIds: ['hidden-part'], webChecks: [webCheck] }), /overlap/)
  assert.throws(() => validateProjectConfig({ command: 'true', protectedFiles: ['/tmp/x'], checkIds: ['x'], webChecks: [{ ...webCheck, unknown: true }] }), /valid apex_validate_web/)
  assert.equal(typeof node, 'string')
})

const coverageRequirements = [
  { id: 'source-correct', description: 'Source behavior is correct', checkIds: ['source'] },
  { id: 'delivery-consistent', description: 'Source and delivered build are both correct', checkIds: ['source', 'build'] },
  { id: 'restoration', description: 'Restore the prior state after restart', checkIds: [] },
]

async function queryStatus(h, agent = h.agent, line = '/apex-status', signal = new AbortController().signal) {
  const execution = await h.ctx.commands.execute(agent, line, [], signal)
  assert.ok(execution, 'project feedback must register the native status command')
  return execution.result
}

test('required final response is an explicit project-only contract', () => {
  assert.equal(Config.parse({}).requireFinalResponse, false)
  assert.throws(() => Config.parse({ requireFinalResponse: true }), /project/)
  assert.throws(() => Config.parse({ requireFinalResponse: 'true' }))
})

test('file-only acceptance does not imply a final response exists', real, async t => {
  const h = await fixture(t, reasoningResponse, { initialSource: 'good', initialBuild: 'good' })
  await h.turn(h.agent, 'Deliver the project and explain the result.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', 'legacy scope checks files only')
  assert.equal(report.delivery.finalResponse, undefined)
  assert.equal(report.feedback.length, 0)
  assert.equal(h.adapter.requests.length, 1)
  const events = h.agent.session.snapshotEvents()
  assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.deepEqual(events.findLast(event => event.type === 'assistant/message').data.message.content.map(block => block.type), ['reasoning'])
})

test('required final response observes the last current-turn message', real, async t => {
  for (const [label, response, present] of [
    ['reasoning only', reasoningResponse, false],
    ['empty', () => textResponse(''), false],
    ['whitespace', () => textResponse(' \n\t'), false],
    ['historical text only', reasoningResponse, false],
    ['final text', () => textResponse('The configured checks passed.'), true],
  ]) await t.test(label, async st => {
    const h = await fixture(st, response, {
      mode: 'observe', requireFinalResponse: true, initialSource: 'good', initialBuild: 'good',
    })
    if (label === 'historical text only') {
      const { createAssistantMessage } = await native('dsh-llm')
      h.agent.session.append('assistant/message', { turn: 0, step: 0, stream: [],
        message: createAssistantMessage({ content: [{ type: 'text', text: 'Previous task completed.' }] }) }, { surfaceOp: 'append' })
    }
    await h.turn(h.agent, 'Deliver the project and explain the result.')
    const report = await h.report()
    const last = h.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    assert.deepEqual(report.delivery.finalResponse, { required: true, present, turn: last.data.turn, eventSeq: last.seq })
    assert.equal(report.status, present ? 'public-pass' : 'delivery-incomplete')
    assert.equal(report.delivery.passed, 2)
    assert.equal(report.feedback.length, 0)
    assert.equal(h.adapter.requests.length, 1)
    const result = await queryStatus(h)
    assert.match(result.text, present ? /最终回复：存在/ : /交付不完整.*delivery-incomplete/)
    if (!present) assert.match(result.text, /最终回复：缺少/)
    assert.doesNotMatch(result.text, /Private planning|configured checks passed/)
    assert.equal(h.adapter.requests.length, 1)
  })
})

test('required final response shares one repair with project failures', real, async t => {
  for (const repaired of [true, false]) await t.test(String(repaired), async st => {
    const h = await fixture(st, (_, n) => n === 1 || !repaired ? reasoningResponse() : textResponse('The configured checks passed.'), {
      requireFinalResponse: true, initialSource: 'good', initialBuild: 'good',
    })
    await h.turn(h.agent, 'Deliver the project and explain the result.')
    const report = await h.report()
    assert.equal(report.status, repaired ? 'public-pass' : 'delivery-incomplete')
    assert.equal(report.feedback.length, 1)
    assert.equal(h.adapter.requests.length, 2)
    assert.equal(report.candidates.length, 2)
    assert.equal(report.candidates[0].artifact.after.hash, report.delivery.artifact.after.hash)
    assert.deepEqual(report.delivery.fixed, [], 'a response is not another file check')
    assert.equal(report.candidates[0].finalResponse.present, false)
    assert.equal(report.delivery.finalResponse.present, repaired)
    const message = h.adapter.requests[1].messages.findLast(message => message.source?.kind === 'apex-native-feedback')
    const facts = JSON.parse(message.content[0].text.split('\n').at(-1))
    assert.deepEqual(facts.checks, [])
    assert.equal(facts.passed, 2)
    assert.equal(facts.total, 2)
    assert.deepEqual(facts.finalResponse, report.feedback[0].finalResponse)
    assert.equal(facts.finalResponse.present, false)
    assert.match(message.content[0].text, /final response/)
    assert.doesNotMatch(message.content[0].text, /Private planning/)
    assert.equal(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source?.kind === 'apex-native-feedback').length, 1)
  })
})

test('required final response cannot reuse earlier progress or buy a second repair', real, async t => {
  const progress = textResponse('I am fixing the measured failures.').slice(0, 3)
  const action = writeFiles('good', 'good').map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk)
  const h = await fixture(t, (_, n) => n === 1 ? textResponse('Ready for verification.')
    : n === 2 ? [...progress, ...action] : reasoningResponse(), { requireFinalResponse: true })
  await h.turn(h.agent, 'Deliver the project and explain the result.')
  const report = await h.report()
  assert.equal(report.status, 'delivery-incomplete')
  assert.equal(report.feedback.length, 1)
  assert.equal(h.adapter.requests.length, 3)
  assert.equal(report.candidates[0].finalResponse.present, true)
  assert.equal(report.delivery.finalResponse.present, false)
  assert.equal(report.delivery.passed, 2)
  assert.deepEqual(report.delivery.fixed, ['source', 'build'])
})

test('apex-status exposes failed Host checks despite a false completion claim without another model request', real, async t => {
  const h = await fixture(t, () => textResponse('All tests passed.'), { checkerStderr: 'private checker output' })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-fail')
  assert.equal(report.feedback.length, 1)
  assert.equal(h.adapter.requests.length, 2)
  const before = await readFile(h.reportPath, 'utf8')
  const start = h.agent.session.seq
  const shell = t.mock.method(h.agent.ctx.get('shell'), 'execute', () => { throw new Error('status must not rerun the checker') })
  const result = await queryStatus(h)
  assert.equal(result.kind, 'success', 'query success is separate from project acceptance')
  assert.match(result.text, /检查未通过.*public-fail/)
  assert.match(result.text, /0\/2/)
  assert.match(result.text, /失败检查.*"source".*"build"/)
  assert.doesNotMatch(result.text, /private checker output|All tests passed|checker\.mjs/)
  assert.equal(shell.mock.callCount(), 0)
  assert.equal(h.adapter.requests.length, 2)
  assert.equal(await readFile(h.reportPath, 'utf8'), before)
  const events = h.agent.session.snapshotEvents(start)
  assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'])
  assert.equal(events[1].data.text, result.text)
  assert.equal(await readFile(join(h.cwd, 'source.txt'), 'utf8'), 'bad')
  assert.equal(await readFile(join(h.cwd, 'build.txt'), 'utf8'), 'bad')
  const other = await h.create('apex-other')
  assert.match((await queryStatus(h, other)).text, /本次挂载尚无验收结果/)
  const command = h.ctx.commands.find(h.agent, 'apex-status')
  assert.equal((await command.handler({ agent: other, rawInput: '', signal: new AbortController().signal })).kind, 'error')
})

test('apex-status never treats changed project or checker files as current passing evidence', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), { initialSource: 'good', initialBuild: 'good' })
  await h.turn(h.agent, 'Implement the project.')
  assert.equal((await h.report()).status, 'public-pass')
  const before = await readFile(h.reportPath, 'utf8')
  assert.match((await queryStatus(h)).text, /配置检查已通过.*public-pass/)
  assert.match((await queryStatus(h)).text, /未配置需求清单/)
  await writeFile(join(h.cwd, 'source.txt'), 'changed after verification')
  assert.match((await queryStatus(h)).text, /证据已失效.*工件/)
  await writeFile(join(h.cwd, 'source.txt'), 'good')
  await writeFile(h.checker, 'changed checker')
  assert.match((await queryStatus(h)).text, /证据已失效.*检查器/)
  assert.equal(await readFile(h.reportPath, 'utf8'), before, 'status must preserve the historical receipt')
  assert.equal(h.adapter.requests.length, 1)
})

test('apex-status handles pending work, invalid input and cancellation without starting a run', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'))
  // The native composer only routes argued lines to commands that declare input.
  const descriptor = h.ctx.commands.list(h.agent).find(command => command.name === 'apex-status')
  assert.deepEqual(descriptor.input, { hint: '直接发送即可查询；不接受参数或附件。' })
  assert.match((await queryStatus(h)).text, /未验证.*尚无验收结果/)
  assert.equal((await queryStatus(h, h.agent, '/apex-status rerun')).kind, 'error')
  await assert.rejects(queryStatus(h, h.agent, '/apex-status', AbortSignal.abort()), /abort/i)
  const attachment = await h.ctx.commands.execute(h.agent, '/apex-status', [{}], new AbortController().signal)
  assert.equal(attachment.result.kind, 'error')
  assert.match(attachment.result.text, /does not accept attachments/)
  assert.equal(h.adapter.requests.length, 0)
  await assert.rejects(readFile(h.reportPath), /ENOENT/)
})

test('apex-status does not present intermediate measurements as a final result', real, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await fixture(t, async () => { entered.resolve(); await release.promise; return textResponse('Done.') }, { mode: 'observe' })
  const running = h.turn(h.agent, 'Implement the project.')
  await entered.promise
  try {
    assert.match((await queryStatus(h)).text, /运行中.*尚无最终结论/)
    assert.equal(h.adapter.requests.length, 1)
  } finally { release.resolve(); await running }
})

test('apex-status distinguishes configured requirement coverage from check counts', real, async t => {
  for (const [label, requirements, expected] of [
    ['mapped', coverageRequirements.slice(0, 2), /需求覆盖：2\/2 通过；0 失败；0 未验证/],
    ['gap', coverageRequirements, /需求覆盖：2\/3 通过；0 失败；1 未验证/],
    ['unmapped', [coverageRequirements[2]], /需求覆盖：0\/1 通过；0 失败；1 未验证/],
  ]) await t.test(label, async t => {
    const h = await fixture(t, () => textResponse('Done.'), { initialSource: 'good', initialBuild: 'good', requirements })
    await h.turn(h.agent, 'Implement the project.')
    await h.report()
    const result = await queryStatus(h)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /检查：2\/2 通过；0 项失败/)
    assert.match(result.text, expected)
    if (label !== 'mapped') {
      assert.match(result.text, /覆盖不完整.*coverage-incomplete/)
      assert.match(result.text, /未通过或未验证的需求："restoration"/)
    }
    assert.equal(h.adapter.requests.length, 1)
  })
})

test('apex-status preserves verification errors and unreadable evidence as unverified', real, async t => {
  await t.test('incomplete measurement', async t => {
    const h = await fixture(t, () => textResponse('All tests passed.'), { measurementComplete: false })
    await h.turn(h.agent, 'Implement the project.')
    assert.equal((await h.report()).status, 'verification-error')
    assert.match((await queryStatus(h)).text, /未验证.*verification-error/)
    assert.equal(h.adapter.requests.length, 1)
  })
  await t.test('missing checker after delivery', async t => {
    const h = await fixture(t, () => textResponse('Done.'), { initialSource: 'good', initialBuild: 'good' })
    await h.turn(h.agent, 'Implement the project.')
    await h.report()
    await rm(h.checker)
    const result = await queryStatus(h)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /证据复核未完成.*未验证/)
    assert.doesNotMatch(result.text, /checker\.mjs|ENOENT/)
  })
})

test('apex-status refuses certification when the Host report did not persist', real, async t => {
  let h
  h = await fixture(t, async () => {
    await rename(dirname(h.reportPath), dirname(h.reportPath) + '-moved')
    await mkdir(dirname(h.reportPath))
    return textResponse('Done.')
  }, { initialSource: 'good', initialBuild: 'good' })
  await h.turn(h.agent, 'Implement the project.')
  const result = await queryStatus(h)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Host 报告未成功保存.*未确认/)
})

test('apex-status does not reload or trust edited reports after session restoration', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), { initialSource: 'good', initialBuild: 'good' })
  await h.turn(h.agent, 'Implement the project.')
  await h.report()
  await writeFile(h.reportPath, '{"status":"public-pass","delivery":{"passed":999}}')
  assert.match((await queryStatus(h)).text, /检查：2\/2 通过/)
  const id = h.agent.session.id
  await h.dispose(h.agent)
  const resumed = await h.resume(id)
  assert.match((await queryStatus(h, resumed)).text, /本次挂载尚无验收结果.*历史报告须独立复核/)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(await readFile(h.reportPath, 'utf8'), '{"status":"public-pass","delivery":{"passed":999}}')
})

test('apex-status is absent when the optional project controller is off', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), { mode: 'off' })
  assert.equal(h.ctx.commands.find(h.agent, 'apex-status'), undefined)
})

test('requirements accept explicit coverage gaps and reject ambiguous or unbounded mappings', () => {
  const base = { command: 'true', protectedFiles: [], checkIds: ['source', 'build'], requirements: coverageRequirements }
  assert.deepEqual(validateProjectConfig(base).requirements, coverageRequirements)
  assert.equal(validateProjectConfig({ ...base, requirements: undefined }).requirements, undefined)
  assert.doesNotThrow(() => validateProjectConfig({ ...base, webChecks: [webCheck], requirements: [
    { id: 'visible', description: 'Visibility is correct', checkIds: ['hidden-part'] },
  ] }))
  for (const requirements of [[], Array(257).fill(coverageRequirements[0]),
    [coverageRequirements[0], coverageRequirements[0]],
    [{ ...coverageRequirements[0], checkIds: ['typo'] }],
    [{ ...coverageRequirements[0], checkIds: ['source', 'source'] }],
    [{ ...coverageRequirements[0], id: ' ' }],
    [{ ...coverageRequirements[0], id: '汉'.repeat(43) }],
    [{ ...coverageRequirements[0], description: '汉'.repeat(342) }],
    [{ ...coverageRequirements[0], optional: true }],
  ]) assert.throws(() => validateProjectConfig({ ...base, requirements }))
})

async function coverageFixture(t, { sourcePass = true, buildPass = true, requirements = coverageRequirements } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'apex-coverage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const checker = join(root, 'checker.mjs'), source = join(workspace, 'source.txt')
  await writeFile(checker, 'fixed checker identity')
  await writeFile(source, 'original source')
  const config = { command: 'fixed-checker', protectedFiles: [checker], checkIds: ['source', 'build'], requirements }
  const agent = { session: { header: { cwd: workspace } } }
  const ctx = { shellEnv: { collect: () => ({}) }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    shell: { sandboxMode: 'read-only', resolve: spec => spec, execute: () => ({ result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, sandbox: { mode: 'read-only' },
      stdout: { text: JSON.stringify({ measurementComplete: true, checks: [
        { id: 'source', passed: sourcePass }, { id: 'build', passed: buildPass },
      ] }), truncated: false }, stderr: { text: '', truncated: false },
    }) }) } }
  const evaluation = await evaluateProject(ctx, agent, config, { root: workspace })
  return { agent, config, evaluation, checker, source }
}

test('coverage separates requirement failures, passes and missing evidence without inflating check counts', async t => {
  const { agent, config, evaluation } = await coverageFixture(t, { buildPass: false })
  assert.deepEqual(evaluation.coverage.summary, { total: 3, passed: 1, failed: 1, unverified: 1, invalid: 0 })
  assert.equal(evaluation.coverage.scope, 'configured-requirements')
  assert.equal(evaluation.coverage.status, 'failed')
  assert.deepEqual(await projectCoverage(agent, config, evaluation), evaluation.coverage)
  const facts = JSON.parse(projectFeedbackFacts(evaluation))
  assert.equal(facts.total, 2)
  assert.deepEqual(facts.checks.map(check => check.id), ['build'])
  assert.deepEqual(facts.coverage.requirements.map(requirement => requirement.id), ['delivery-consistent', 'restoration'])
  assert.equal(facts.coverage.requirements[1].status, 'unverified')
  assert.match(projectFeedbackText(evaluation), /not measured defects/)
  assert.throws(() => projectFeedbackFacts(evaluation, Buffer.byteLength(JSON.stringify(facts)) - 1), /feedbackBytes/)
  const pending = await projectCoverage(agent, config)
  assert.equal(pending.summary.unverified, 3)
  assert.equal(pending.summary.failed, 0)
  assert.equal(await projectCoverage(agent, { ...config, requirements: undefined }, evaluation), undefined)
})

test('saved coverage invalidates on artifact, checker and requirement-map changes', async t => {
  const { agent, config, evaluation, source, checker } = await coverageFixture(t)
  assert.equal(evaluation.coverage.summary.passed, 2)
  await writeFile(source, 'changed after successful checks')
  let current = await projectCoverage(agent, config, evaluation)
  assert.equal(current.summary.passed, 0)
  assert.equal(current.summary.invalid, 2)
  assert.equal(current.requirements[0].reason, 'artifact-changed')
  assert.equal(evaluation.coverage.summary.passed, 2, 'historical receipt must not be rewritten')
  await writeFile(source, 'original source')
  await writeFile(checker, 'changed checker identity')
  current = await projectCoverage(agent, config, evaluation)
  assert.equal(current.requirements[0].reason, 'checker-changed')
  await writeFile(checker, 'fixed checker identity')
  for (const replacement of [
    { ...coverageRequirements[0], description: 'Stronger revised requirement' },
    { ...coverageRequirements[0], checkIds: ['build'] },
  ]) {
    current = await projectCoverage(agent, { ...config, requirements: [replacement, ...coverageRequirements.slice(1)] }, evaluation)
    assert.equal(current.status, 'invalid')
    assert.equal(current.requirements[0].reason, 'checker-changed')
  }
  await assert.rejects(projectCoverage(agent, config, evaluation, { signal: AbortSignal.abort() }), /abort/i)
})

test('incomplete or malformed saved measurements never certify configured requirements', async t => {
  const { agent, config, evaluation } = await coverageFixture(t)
  for (const invalid of [null, { ...evaluation, measurementComplete: false },
    { ...evaluation, measurementComplete: undefined }, { ...evaluation, checks: [] },
    { ...evaluation, checks: [evaluation.checks[0], evaluation.checks[0]] },
    { ...evaluation, checks: [{ id: 'unknown', passed: true }, evaluation.checks[1]] },
    { ...evaluation, checks: [{ id: 'source', passed: 'true' }, evaluation.checks[1]] },
    { ...evaluation, artifact: { before: evaluation.artifact.before, after: { ...evaluation.artifact.after, hash: 'stale' } } },
  ]) {
    const coverage = await projectCoverage(agent, config, invalid)
    assert.equal(coverage.status, 'invalid')
    assert.equal(coverage.summary.invalid, 2)
    assert.equal(coverage.summary.failed, 0)
    assert.equal(coverage.summary.passed, 0)
  }
})

test('only a fully mapped current requirement list has passed coverage', async t => {
  const { evaluation } = await coverageFixture(t, { requirements: coverageRequirements.slice(0, 2) })
  assert.equal(evaluation.coverage.status, 'passed')
  assert.deepEqual(evaluation.coverage.summary, { total: 2, passed: 2, failed: 0, unverified: 0, invalid: 0 })
})

test('native project delivery reports coverage gaps even when every configured check passes', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), {
    initialSource: 'good', initialBuild: 'good', requirements: coverageRequirements,
  })
  await h.turn(h.agent, 'Review and deliver the project.')
  const report = await h.report()
  assert.equal(report.status, 'coverage-incomplete')
  assert.equal(report.delivery.passed, 2)
  assert.equal(report.delivery.total, 2)
  assert.equal(report.delivery.coverage.status, 'unverified')
  assert.deepEqual(report.delivery.coverage.summary, { total: 3, passed: 2, failed: 0, unverified: 1, invalid: 0 })
  assert.equal(report.feedback.length, 0, 'an unmeasured requirement alone is not a defect or a reason to retry')
  assert.equal(h.adapter.requests.length, 1)
})

test('native feedback logs uncovered requirements alongside failures and rechecks repaired coverage', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? textResponse('Ready.')
    : n === 2 ? writeFiles('good', 'good') : textResponse('Repaired.'), {
    initialSource: 'good', initialBuild: 'bad', requirements: coverageRequirements,
  })
  await h.turn(h.agent, 'Review and deliver the project.')
  const report = await h.report()
  assert.equal(report.status, 'coverage-incomplete')
  assert.deepEqual(report.candidates.map(row => row.coverage.status), ['failed', 'unverified'])
  assert.deepEqual(report.delivery.fixed, ['build'])
  assert.equal(report.feedback.length, 1)
  const message = h.adapter.requests[1].messages.find(message => message.source?.kind === 'apex-native-feedback')
  const facts = JSON.parse(message.content[0].text.split('\n').at(-1))
  assert.deepEqual(facts.coverage.requirements.map(requirement => requirement.status), ['failed', 'unverified'])
  assert.ok(report.delivery.identity.requirementsSha256)
  assert.notEqual(report.candidates[0].artifact.after.hash, report.delivery.coverage.artifactHash)
})

test('invalid native measurements are coverage errors without an automatic repair', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), {
    measurementComplete: false, requirements: coverageRequirements,
  })
  await h.turn(h.agent, 'Review and deliver the project.')
  const report = await h.report()
  assert.equal(report.status, 'verification-error')
  assert.equal(report.projectVerification.coverage.summary.invalid, 2)
  assert.equal(report.projectVerification.coverage.summary.failed, 0)
  assert.equal(report.feedback.length, 0)
  assert.equal(report.delivery, null)
})

test('project checker output is exact, bounded and typed', () => {
  const good = JSON.stringify({ measurementComplete: true, checks: [{ id: 'a', passed: false, expected: 1, actual: 2, detail: 'mismatch' }] })
  assert.deepEqual(parseProjectChecks(good, ['a']), [{ id: 'a', passed: false, expected: 1, actual: 2, detail: 'mismatch' }])
  for (const output of [
    '{}',
    JSON.stringify({ measurementComplete: true, checks: [{ id: 'a', passed: true }, { id: 'a', passed: true }] }),
    JSON.stringify({ measurementComplete: true, checks: [{ id: 'unknown', passed: true }] }),
    JSON.stringify({ measurementComplete: true, checks: [{ id: 'a', passed: 'yes' }] }),
    JSON.stringify({ measurementComplete: true, checks: [{ id: 'a', passed: true, extra: 1 }] }),
    JSON.stringify({ checks: [{ id: 'a', passed: false }] }),
    JSON.stringify({ measurementComplete: false, checks: [{ id: 'a', passed: false }] }),
    JSON.stringify({ measurementComplete: 'true', checks: [{ id: 'a', passed: true }] }),
  ]) assert.throws(() => parseProjectChecks(output, ['a']))
})

test('protected identity binds browser checks while preserving the old shell identity shape', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apex-project-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checker = join(root, 'checker.mjs')
  await writeFile(checker, 'checker')
  const baseProject = { command: 'true', protectedFiles: [checker], checkIds: ['source'] }
  const oldIdentity = await protectedIdentity(baseProject)
  assert.equal(oldIdentity.webChecksSha256, undefined)
  const browserIdentity = await protectedIdentity({ ...baseProject, webChecks: [webCheck] })
  assert.equal(typeof browserIdentity.webChecksSha256, 'string')
  assert.deepEqual(browserIdentity.webCheckIds, ['hidden-part'])
  const changed = await protectedIdentity({ ...baseProject, webChecks: [{ ...webCheck, assertion: 'changed' }] })
  assert.notEqual(browserIdentity.bindingSha256, changed.bindingSha256)
})

test('a valid negative checker result with exit 2 is a verification error', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'bad') : textResponse('Done.'), {
    checkerExitCode: 2,
  })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'verification-error', JSON.stringify(report))
  assert.equal(report.feedback.length, 0)
  assert.equal(report.delivery, null)
  assert.equal(report.errorFacts.exitCode, 2)
  assert.deepEqual(JSON.parse(report.errorFacts.stdout).checks.map(check => ({ id: check.id, passed: check.passed })), [
    { id: 'source', passed: false }, { id: 'build', passed: false },
  ])
  assert.equal(h.adapter.requests.length, 2)
})

test('project feedback preserves child exit status and checks a claimed README change', real, async t => {
  for (const initialSource of ['bad', 'good', 'unmeasured', 'missing-readme-and-reply']) await t.test(initialSource, async st => {
    const missing = initialSource === 'missing-readme-and-reply'
    const sentence = 'Run node verify.mjs to check the project.'
    const ids = ['test-status', 'readme-note']
    const h = await fixture(st, (_, n) => n === 1
      ? missing ? reasoningResponse() : textResponse('All checks passed and the verification command is documented in README.')
      : n === 2 ? codeTool('repair-checked-claims',
        'await tools.read({file_path:"source.txt"});'
        + (missing ? '' : 'await tools.read({file_path:"README.md"});')
        + 'await tools.write({file_path:"source.txt",content:"good"});'
        + 'return await tools.write({file_path:"README.md",content:' + JSON.stringify(sentence) + '});')
        : textResponse('The measured failures are repaired.'), {
      initialSource, checkIds: ids, requireFinalResponse: missing,
      requirements: ids.map(id => ({ id, description: id, checkIds: [id] })),
    })
    if (!missing) await writeFile(join(h.cwd, 'README.md'), 'Project overview.\n')
    // A controlled child distinguishes a completed assertion from missing measurement.
    // Its misleading diagnostic is data; only the process status determines the result.
    const child = `const {readFileSync} = require('node:fs');
const source = readFileSync('source.txt', 'utf8');
if (source === 'unmeasured') process.exit(0);
console.log(JSON.stringify({measurementComplete:true,diagnostic:'EXIT:0'}));
process.exitCode = source === 'good' ? 0 : 1;`
    await writeFile(h.checker, `import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}], {
  encoding:'utf8',timeout:1000,killSignal:'SIGKILL',maxBuffer:4096,
});
if (result.error || result.signal || ![0,1].includes(result.status)) throw new Error('Child did not complete');
if (JSON.parse(result.stdout).measurementComplete !== true) throw new Error('Missing measurement');
let note = false;
try { note = readFileSync('README.md','utf8').includes(${JSON.stringify(sentence)}); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(JSON.stringify({measurementComplete:true,checks:[
  {id:'test-status',passed:result.status===0,expected:{exitCode:0},actual:{exitCode:result.status}},
  {id:'readme-note',passed:note,expected:${JSON.stringify(sentence)},actual:note},
]}));
`)
    await h.turn(h.agent, 'Check the project and document the verification command.')
    const report = await h.report()
    if (initialSource === 'unmeasured') {
      assert.equal(report.status, 'verification-error')
      assert.equal(report.delivery, null)
      assert.equal(report.feedback.length, 0)
      assert.equal(report.projectVerification.coverage.status, 'invalid')
      assert.equal(h.adapter.requests.length, 1)
      return
    }
    const failures = initialSource === 'good' ? ['readme-note'] : ids
    assert.equal(report.status, 'public-pass', JSON.stringify(report))
    assert.equal(report.candidates[0].checks[0].actual.exitCode, initialSource === 'good' ? 0 : 1)
    assert.equal(report.candidates[0].checks[1].passed, false)
    assert.deepEqual(report.feedback[0].failures.map(check => check.id), failures)
    assert.equal(report.feedback.length, 1)
    assert.equal(report.delivery.checks[0].actual.exitCode, 0)
    assert.deepEqual(report.delivery.fixed, failures)
    assert.equal(report.delivery.coverage.status, 'passed')
    assert.equal(h.adapter.requests.length, 3)
    const message = h.adapter.requests[1].messages.findLast(message => message.source?.kind === 'apex-native-feedback')
    const facts = JSON.parse(message.content[0].text.split('\n').at(-1))
    assert.deepEqual(facts.checks.map(check => check.id), failures)
    assert.equal(facts.checks.at(-1).actual, false)
    if (missing) {
      assert.equal(facts.finalResponse.present, false)
      assert.equal(report.delivery.finalResponse.present, true)
      assert.equal(await readFile(join(h.cwd, 'README.md'), 'utf8'), sentence)
    }
  })
})

test('exit zero without a completed measurement never supplies failure feedback', real, async t => {
  for (const measurementComplete of [false, null]) await t.test(String(measurementComplete), async st => {
    const h = await fixture(st, reasoningResponse, { measurementComplete, requireFinalResponse: true })
    await h.turn(h.agent, 'Implement the project.')
    const report = await h.report()
    assert.equal(report.status, 'verification-error', JSON.stringify(report))
    assert.match(report.error, /complete measurement/)
    assert.equal(report.feedback.length, 0)
    assert.equal(report.delivery, null)
    assert.equal(report.errorFacts.kind, 'checker-output')
    assert.equal(h.adapter.requests.length, 1)
    assert.ok(h.adapter.requests.every(request => !request.messages.some(message => message.source?.kind === 'apex-native-feedback')))
  })
})

test('initial reports stay outside the project and repair messages contain only failed checks and hashes', real, async t => {
  let h, initial
  const hostLog = 'HOST_ONLY_CHECKER_DIAGNOSTIC'
  h = await fixture(t, async (request, n) => {
    if (n === 1) {
      initial = JSON.parse(await readFile(h.reportPath, 'utf8'))
      assert.equal(initial.config.project, undefined)
      assert.equal(initial.config.reportDirectory, undefined)
      assert.equal(initial.disclosure.strictReadIsolationProven, false)
      await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
      return textResponse('Ready for verification.')
    }
    const feedback = request.messages.findLast(message => message.source?.kind === 'apex-native-feedback')
    assert.ok(feedback)
    const text = feedback.content[0].text
    assert.ok(!text.includes(h.checker))
    assert.ok(!text.includes(hostLog))
    const facts = JSON.parse(text.split('\n').at(-1))
    assert.deepEqual(facts.checks.map(check => check.id), ['build'])
    assert.deepEqual(Object.keys(facts).sort(), ['artifactHash', 'bindingSha256', 'checks', 'passed', 'total'])
    return n === 2 ? writeFiles('good', 'good') : textResponse('Repaired.')
  }, { initialSource: 'good', initialBuild: 'bad', checkerStderr: hostLog })
  await h.turn(h.agent, 'Review and deliver the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.equal(report.disclosure.reportLocation, 'host')
  assert.equal(report.feedback.length, 1)
  assert.match(report.feedback[0].stderr, /HOST_ONLY_CHECKER_DIAGNOSTIC/)
  assert.deepEqual(report.delivery.fixed, ['build'])
  assert.deepEqual(report.delivery.regressed, [])
  assert.ok(initial.configSha256)
  await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
  assert.equal(report.delivery.artifact.after.fileCount, 2)
  assert.equal(report.delivery.artifact.after.excludedFiles, undefined)
})

test('project evaluation uses read-only shell and rejects checker failure or mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apex-project-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checker = join(root, 'checker.mjs'), source = join(root, 'source.txt')
  await writeFile(checker, 'checker')
  await writeFile(source, 'source')
  const project = { command: 'trusted-check', protectedFiles: [checker], checkIds: ['ok'] }
  const agent = { session: { id: 'unit-agent', header: { cwd: root } } }
  const output = JSON.stringify({ measurementComplete: true, checks: [{ id: 'ok', passed: true }] })
  let mode
  const context = behavior => ({
    shellEnv: { collect() { return { DSH_TEST: '1' } } },
    sandboxPolicy: { resolve({ mode: requested }) { mode = requested; return { mode: requested, workspaceRoot: root } } },
    shell: {
      resolve(request) { assert.equal(request.command, 'trusted-check'); assert.equal(request.dshEnv.DSH_TEST, '1'); return request },
      sandboxMode: 'read-only',
      execute(spec) { return { result: () => behavior(spec) } },
    },
  })
  const result = await evaluateProject(context(async spec => ({ exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: output, truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } })), agent, project, { root, signal: new AbortController().signal })
  assert.equal(mode, 'read-only')
  assert.equal(result.checks[0].passed, true)
  let ran = false
  const unconfined = context(async () => { ran = true; throw new Error('must not run') })
  delete unconfined.shell.sandboxMode
  await assert.rejects(evaluateProject(unconfined, agent, project, { root }), /sandboxed shell/)
  assert.equal(ran, false)
  await assert.rejects(evaluateProject(context(async () => ({ exitCode: 1, signal: null, timedOut: false, aborted: false,
    stdout: { text: '', truncated: false }, stderr: { text: 'bad', truncated: false }, sandbox: { mode: 'read-only' } })), agent, project, { root }), /non-zero/)
  await assert.rejects(evaluateProject(context(async () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true, aborted: false,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } })), agent, project, { root }), /timed out/)
  await assert.rejects(evaluateProject(context(async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: true,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } })), agent, project, { root }), /cancelled/)
  await assert.rejects(evaluateProject(context(async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: '{"measurementComplete":true,"checks":[{"id":"unknown","passed":true}]}', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } })), agent, project, { root }), /unknown or duplicate/)
  await assert.rejects(evaluateProject(context(async () => {
    await writeFile(source, 'changed')
    return { exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { text: output, truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } }
  }), agent, project, { root }), /changed during verification/)
  await writeFile(source, 'source')
  await assert.rejects(evaluateProject(context(async () => {
    await writeFile(checker, 'tampered')
    return { exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { text: output, truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only' } }
  }), agent, project, { root }), /changed during verification/)
})

test('project checker sends factual failures in the same session and repairs two files', real, async t => {
  let h
  h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'bad')
    : n === 2 ? textResponse('Ready.')
      : n === 3 ? writeFiles('good', 'good') : textResponse('Repaired.'))
  await h.turn(h.agent, 'Implement the project and finish.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.equal(report.feedback.length, 1)
  assert.deepEqual(report.feedback[0].failures.map(check => check.id), ['source', 'build'])
  assert.equal(typeof report.feedback[0].artifact.hash, 'string')
  assert.equal(typeof report.feedback[0].identity.bindingSha256, 'string')
  assert.deepEqual(report.delivery.fixed, ['source', 'build'])
  assert.deepEqual(report.delivery.regressed, [])
  assert.equal(await readFile(join(h.cwd, 'source.txt'), 'utf8'), 'good')
  assert.equal(await readFile(join(h.cwd, 'build.txt'), 'utf8'), 'good')
  const feedback = h.adapter.requests[2].messages.find(message => message.source?.kind === 'apex-native-feedback')
  assert.ok(feedback, 'feedback must be a durable request message')
  assert.match(feedback.content[0].text, /artifact|bindingSha256|source/) // identity and artifact facts are in the actual request
  assert.doesNotMatch(feedback.content[0].text, /"stdout"/) // successful checker output is not duplicated into repair facts
})

test('project browser checks persist factual DOM failures and replay the repaired artifact', real, async t => {
  const bad = `<!doctype html><button id="hide-part">Hide</button><div id="part">part</div><output id="residual">residual</output>
    <script>document.querySelector('#hide-part').onclick=()=>{document.querySelector('#part').style.display='none'}</script>`
  const good = `<!doctype html><button id="hide-part">Hide</button><div id="part">part</div><output id="residual">residual</output><span id="required-marker"></span>
    <script>document.querySelector('#hide-part').onclick=()=>{document.querySelector('#part').style.display='none';document.querySelector('#residual').textContent=''}</script>`
  const h = await fixture(t, (_, n) => n === 1 ? textResponse('Done.')
    : n === 2 ? writeWeb(good) : textResponse('Repaired.'), {
    initialSource: 'good', initialBuild: 'good', webHtml: bad, webChecks: [webCheck],
    requirements: [{ id: 'consistent-visibility', description: 'The delivered project hides a part without residual content',
      checkIds: ['source', 'build', 'hidden-part'] }],
  })
  await h.turn(h.agent, 'Implement the project and finish.')
  const report = await h.report()
  removeCaptures(t, report)
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.deepEqual(report.feedback[0].failures.map(check => check.id), ['hidden-part'])
  assert.equal(report.feedback[0].failures[0].actual.status, 'failed')
  assert.equal(report.feedback[0].failures[0].actual.artifactStable, true)
  assert.deepEqual(report.feedback[0].failures[0].actual.missingSelectors, ['#required-marker: expected present'])
  assert.deepEqual(report.feedback[0].failures[0].actual.canvasErrors, [])
  assert.equal(report.feedback[0].coverage.status, 'failed')
  assert.equal(report.delivery.coverage.status, 'passed')
  assert.deepEqual(report.delivery.coverage.summary, { total: 1, passed: 1, failed: 0, unverified: 0, invalid: 0 })
  assert.deepEqual(report.delivery.fixed, ['hidden-part'])
  assert.deepEqual(report.delivery.regressed, [])
  assert.equal(await readFile(join(h.cwd, 'index.html'), 'utf8'), good)
})

test('project browser canvas facts persist residual-line failure and replay the repaired artifact', real, async t => {
  const bad = `<!doctype html><button id="hide-part">Hide</button><div id="part">part</div><canvas id="view" width="160" height="40"></canvas>
    <script>const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d');ctx.moveTo(10,20);ctx.lineTo(150,20);ctx.stroke();document.querySelector('#hide-part').onclick=()=>{document.querySelector('#part').style.display='none'}</script>`
  const good = `<!doctype html><button id="hide-part">Hide</button><div id="part">part</div><canvas id="view" width="160" height="40"></canvas>
    <script>const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d');ctx.moveTo(10,20);ctx.lineTo(150,20);ctx.stroke();document.querySelector('#hide-part').onclick=()=>{document.querySelector('#part').style.display='none';ctx.clearRect(0,0,canvas.width,canvas.height)}</script>`
  const h = await fixture(t, (_, n) => n === 1 ? textResponse('Done.')
    : n === 2 ? writeWeb(good) : textResponse('Repaired.'), {
    initialSource: 'good', initialBuild: 'good', webHtml: bad, webChecks: [canvasWebCheck],
  })
  await h.turn(h.agent, 'Implement the project and finish.')
  const report = await h.report()
  removeCaptures(t, report)
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.deepEqual(report.feedback[0].failures.map(check => check.id), ['canvas-residual'])
  assert.equal(report.feedback[0].failures[0].actual.canvasChecks[1].passed, false)
  assert.deepEqual(report.delivery.fixed, ['canvas-residual'])
  assert.deepEqual(report.delivery.regressed, [])
})

test('an incomplete browser measurement is a verification error without feedback', real, async t => {
  const h = await fixture(t, () => textResponse('Done.'), {
    initialSource: 'good', initialBuild: 'good',
    webHtml: '<!doctype html><p id="part">part</p>',
    webChecks: [{ ...webCheck, interactions: [], interaction_required: false,
      selector_checks: [], text_checks: [],
      canvas_checkpoints: [{ id: 'missing-canvas', selector: '#missing-canvas', after_interaction: 0 }] }],
  })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  removeCaptures(t, report)
  assert.equal(report.status, 'verification-error', JSON.stringify(report))
  assert.equal(report.feedback.length, 0)
  assert.equal(report.delivery, null)
  assert.equal(report.errorFacts.kind, 'browser-verification')
})

test('an already passing project does not add a repair request', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('good', 'good') : textResponse('Done.'))
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.equal(report.feedback.length, 0)
  assert.equal(h.adapter.requests.length, 2)
})

test('unchanged project checks must agree across repair and final replay', real, async t => {
  const cases = [
    ['replay cannot turn failure into success', 'observe', [[false, true], [true, true]], 'verification-error'],
    ['replay cannot turn success into failure', 'observe', [[true, true], [true, false]], 'verification-error'],
    ['equal counts cannot hide different failing checks', 'observe', [[false, true], [true, false]], 'verification-error'],
    ['unchanged repair cannot claim a fix', 'repair', [[false, true], [true, true]], 'verification-error'],
    ['repair replay cannot erase a remaining failure', 'repair', [[false, true], [false, true], [true, true]], 'verification-error'],
    ['order and diagnostic changes preserve a pass', 'observe', [[true, true], [true, true]], 'public-pass'],
    ['stable failures remain project failures', 'repair', [[false, true], [false, true], [false, true]], 'public-fail'],
  ]
  for (const [label, mode, outcomes, status] of cases) await t.test(label, async st => {
    const h = await fixture(st, () => textResponse('All tests passed.'), {
      mode, initialSource: 'good', initialBuild: 'good', requirements: coverageRequirements.slice(0, 2),
    })
    const shell = h.agent.ctx.get('shell'), execute = shell.execute.bind(shell)
    let calls = 0
    // Run the real read-only checker, then supply controlled changing measurements at its result seam.
    st.mock.method(shell, 'execute', async spec => {
      const execution = await execute(spec)
      const result = await execution.result()
      assert.equal(result.exitCode, 0)
      assert.equal(result.sandbox.mode, 'read-only')
      const values = outcomes[calls++] ?? outcomes.at(-1)
      assert.ok(calls <= 3, 'at most two phases and a final replay')
      const measurement = JSON.parse(result.stdout.text)
      measurement.checks = measurement.checks.map((check, index) => ({ ...check,
        passed: values[index], actual: values[index] ? 'good' : 'bad', detail: `measurement ${calls}`,
      }))
      if (calls % 2 === 0) measurement.checks.reverse()
      return { result: async () => ({ ...result, stdout: { ...result.stdout, text: JSON.stringify(measurement) } }) }
    })
    await h.turn(h.agent, 'Verify and deliver the project.')
    const report = await h.report()
    assert.equal(report.status, status)
    assert.equal(calls, outcomes.length)
    assert.equal(h.adapter.requests.length, mode === 'repair' ? 2 : 1)
    assert.equal(report.feedback.length, mode === 'repair' ? 1 : 0)
    assert.equal(new Set(report.candidates.map(row => row.artifact.after.hash)).size, 1)
    assert.equal(await readFile(join(h.cwd, 'source.txt'), 'utf8'), 'good')
    assert.equal(await readFile(join(h.cwd, 'build.txt'), 'utf8'), 'good')
    if (status === 'verification-error') {
      assert.equal(report.delivery, null)
      assert.match(report.error, /changed outcome.*unchanged artifact/)
      assert.equal(report.errorFacts.kind, 'checker-inconsistent')
      assert.equal(report.errorFacts.artifactHash, report.candidates.at(-1).artifact.after.hash)
      assert.equal(report.errorFacts.bindingSha256, report.candidates.at(-1).identity.bindingSha256)
      const [before, after] = outcomes.slice(-2)
      assert.deepEqual(report.errorFacts.checks.toSorted((a, b) => a.id.localeCompare(b.id)),
        ['source', 'build'].flatMap((id, index) => before[index] === after[index] ? []
          : [{ id, before: before[index], after: after[index] }]).toSorted((a, b) => a.id.localeCompare(b.id)))
      assert.match((await queryStatus(h)).text, /未验证.*verification-error/)
      assert.equal(calls, outcomes.length, 'status queries must not retry inconsistent measurements')
    } else {
      assert.equal(report.errorFacts, undefined)
      assert.equal(report.delivery.passed, status === 'public-pass' ? 2 : 1)
      assert.equal(report.delivery.coverage.status, status === 'public-pass' ? 'passed' : 'failed')
    }
  })
})

test('a source-only repair leaves the stale build as public-fail', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'bad')
    : n === 2 ? textResponse('Ready.')
      : n === 3 ? writeFiles('good', 'bad') : textResponse('Repaired.'))
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-fail', JSON.stringify(report))
  assert.deepEqual(report.delivery.fixed, ['source'])
  assert.deepEqual(report.delivery.regressed, [])
  assert.equal(await readFile(join(h.cwd, 'source.txt'), 'utf8'), 'good')
  assert.equal(await readFile(join(h.cwd, 'build.txt'), 'utf8'), 'bad')
})

test('a passing build that regresses after source repair is public-fail', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'good')
    : n === 2 ? textResponse('Ready.')
      : n === 3 ? writeFiles('good', 'bad') : textResponse('Repaired.'))
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-fail', JSON.stringify(report))
  assert.deepEqual(report.candidates[0].regressed, [])
  assert.deepEqual(report.delivery.fixed, ['source'])
  assert.deepEqual(report.delivery.regressed, ['build'])
})

test('observe mode records a project failure without adding feedback', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'bad') : textResponse('Done.'), { mode: 'observe' })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-fail', JSON.stringify(report))
  assert.equal(report.feedback.length, 0)
  assert.equal(h.adapter.requests.length, 2)
})

test('protected checker material changed during generation is a verification error', real, async t => {
  let h
  h = await fixture(t, async (_, n) => {
    if (n === 1) {
      await writeFile(h.checker, 'tampered')
      return textResponse('Done.')
    }
    return textResponse('Unexpected extra request.')
  })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'verification-error', JSON.stringify(report))
  assert.match(report.error, /Protected project checker material changed during generation/)
  assert.equal(report.feedback.length, 0)
  assert.equal(report.delivery, null)
})

test('the project checker is enforced by the real read-only shell', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('good', 'good') : textResponse('Done.'), {
    checkerWrite: true, initialSource: 'good', initialBuild: 'good', feedbackBytes: 512,
  })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.equal(report.delivery.checks.find(check => check.id === 'readonly').passed, true)
  await assert.rejects(readFile(join(h.cwd, 'readonly-write.txt')), /ENOENT/)
})

test('a large passing checker report does not consume the feedback budget', real, async t => {
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('good', 'good') : textResponse('Done.'), {
    initialSource: 'good', initialBuild: 'good', largeDetail: true, feedbackBytes: 512,
  })
  await h.turn(h.agent, 'Implement the project.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.equal(report.feedback.length, 0)
  assert.ok(report.delivery.checks.every(check => check.passed))
})

test('a nonmatching workspaceRoot does not mount project feedback', real, async t => {
  const foreign = await mkdtemp(join(tmpdir(), 'apex-project-foreign-'))
  t.after(() => rm(foreign, { recursive: true, force: true }))
  const h = await fixture(t, () => textResponse('Done.'), { workspaceRoot: foreign })
  assert.equal(h.ctx.commands.find(h.agent, 'apex-status'), undefined)
  await h.turn(h.agent, 'Implement the project.')
  await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.agent.status, 'idle')
  assert.equal(h.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})

test('an enabled project controller yields to same-session PTC and Minimal modes', real, async t => {
  const projectPreset = 'apex-project-test'
  const h = await fixture(t, () => textResponse('Done.'), {
    shippedPresets: true, projectPreset, initialSource: 'good', initialBuild: 'good',
  })
  assert.equal(h.ctx.agentPresets.composedPreset(h.agent.ctx), projectPreset)
  const inactiveCommand = h.ctx.commands.find(h.agent, 'apex-status')
  assert.ok(inactiveCommand)
  await h.ctx.agentPresets.recompose(h.agent.ctx, 'ptc')
  assert.equal((await inactiveCommand.handler({ agent: h.agent, rawInput: '', signal: new AbortController().signal })).kind, 'error')
  await h.turn(h.agent, 'Use PTC mode.')
  await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
  await h.ctx.agentPresets.recompose(h.agent.ctx, 'minimal')
  await h.turn(h.agent, 'Use Minimal mode.')
  await assert.rejects(readFile(join(h.cwd, '.apex-native-feedback.json')), /ENOENT/)
  await h.ctx.agentPresets.recompose(h.agent.ctx, projectPreset)
  await h.turn(h.agent, 'Return to the project preset and finish.')
  const report = await h.report()
  assert.equal(report.status, 'public-pass', JSON.stringify(report))
  assert.match((await queryStatus(h)).text, /配置检查已通过.*public-pass/)
  assert.equal(report.feedback.length, 0)
  assert.equal(h.adapter.requests.length, 3)
})

test('returning to the project preset after one feedback round cannot spend another round', real, async t => {
  const projectPreset = 'apex-project-feedback-reentry'
  const h = await fixture(t, (_, n) => n === 1 ? writeFiles('bad', 'bad')
    : n === 2 ? textResponse('Ready.')
      : n === 3 ? writeFiles('good', 'good') : textResponse('Repaired.'), {
    shippedPresets: true, projectPreset,
  })
  await h.turn(h.agent, 'Finish the project.')
  const before = await readFile(h.reportPath, 'utf8')
  const requestsAfterRepair = h.adapter.requests.length
  assert.equal(JSON.parse(before).feedback.length, 1)
  await h.ctx.agentPresets.recompose(h.agent.ctx, 'ptc')
  await h.turn(h.agent, 'Use PTC.')
  await h.ctx.agentPresets.recompose(h.agent.ctx, projectPreset)
  await h.turn(h.agent, 'Return to the project preset.')
  assert.equal(h.adapter.requests.length, requestsAfterRepair + 1)
  assert.equal(await readFile(h.reportPath, 'utf8'), before)
})
