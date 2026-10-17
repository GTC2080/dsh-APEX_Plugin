import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { loadApexPresetFixture, native, nativeHarness, systemText, textResponse, toolResponse, harnessAvailable } from './helpers/harness-v1.mjs'
import { readExecutionEvidence } from '../presets/apex-v1/evidence.mjs'
import { registerTool } from '../presets/apex-v1/tools.mjs'

const options = { skip: !harnessAvailable, timeout: 30000 }

test('native scheduler recovery preserves APEX side effects and error evidence across resume', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create()
  let executions = 0
  registerTool(agent.ctx, {
    name: 'apex_recovery_probe', description: 'Count one fixture side effect.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { return ++executions },
  })
  const { TOOL_RUNTIME_SCHEDULER } = await native('dsh-tools')
  const { TOOL_OUTCOME_UNKNOWN } = await native('dsh-session')
  const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
  const finalize = scheduler.finalize.bind(scheduler)
  const failure = t.mock.method(scheduler, 'finalize', (exec, result) => {
    if (exec.name === 'run_code' && !exec.parent) throw new Error('fixture result finalization failed')
    return finalize(exec, result)
  })
  const result = await h.runCode(agent, 'return await tools.apex_recovery_probe({})')
  failure.mock.restore()
  assert.equal(result.isError, true)
  assert.equal(executions, 1)
  const recovery = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
  assert.equal(recovery.data.error.code, TOOL_OUTCOME_UNKNOWN)
  assert.match(result.error.message, /outcome is unknown.*Do not retry blindly/s)
  const evidence = readExecutionEvidence(agent)
  assert.deepEqual(evidence.results.map(row => [row.tool, row.toolError]), [
    ['apex_recovery_probe', false], ['run_code', true],
  ])
  assert.equal(evidence.overallAcceptance, 'not-assessed')
  await h.dispose(agent)
  const resumed = await h.resume(agent.session.id)
  assert.deepEqual(readExecutionEvidence(resumed).results, evidence.results)
  await h.turn(resumed, 'Continue from the recorded outcome without repeating the operation.')
  assert.equal(executions, 1)
  const messages = h.adapter.requests.at(-1).messages
  assert.equal(messages.filter(message => message.role === 'tool'
    && message.toolCallId === recovery.data.message.toolCallId).length, 1)
  assert.equal(resumed.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
})

test('APEX PTC search keeps native account and API-key authentication scoped to its initiating session', options, async t => {
  const h = await nativeHarness()
  let provider
  t.after(async () => { try { await provider?.dispose() } finally { await h.close() } })
  const asked = [], sent = []
  h.ctx.provide('deepseekAccount', { async resolveToken(endpoint) {
    asked.push(endpoint); return 'apex-account-fixture'
  } })
  h.ctx.llm.registerAdapter(['deepseek-account'], h.adapter)
  provider = await h.ctx.plugin(await native('dsh-web-search-deepseek'), {
    apiKey: 'apex-api-fixture', baseURL: 'https://search.apex.test/anthropic/v1',
  })
  await provider.await()
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://search.apex.test/anthropic/v1/messages')
    sent.push(new Headers(init.headers))
    return Response.json({ content: [{ type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://evidence.apex.test/', title: 'Fixture result' },
    ] }] })
  })
  for (const route of ['deepseek-account', 'deepseek-official']) {
    const agent = await h.create(route)
    agent.options.provider = route
    const result = await h.runCode(agent, 'return await tools.web_search({queries:["APEX compatibility fixture"]})')
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.match(JSON.stringify(result.value), /evidence\.apex\.test/)
    assert.equal(agent.session.requestContext().provider, route)
  }
  assert.deepEqual(asked, ['https://search.apex.test/anthropic/v1/messages'])
  assert.equal(sent.length, 2)
  assert.equal(sent[0].get('x-dsh-auth-token'), 'apex-account-fixture')
  assert.equal(sent[0].has('x-api-key'), false)
  assert.equal(sent[0].has('authorization'), false)
  assert.equal(sent[1].get('x-api-key'), 'apex-api-fixture')
  assert.equal(sent[1].get('authorization'), 'Bearer apex-api-fixture')
  assert.equal(sent[1].has('x-dsh-auth-token'), false)
})

test('an existing APEX session can use newly registered PTC tools without leaking them to another mode', options, async t => {
  const h = await nativeHarness(undefined, { shippedPresets: true }); t.after(h.close)
  const agent = await h.create(), official = await h.create('official', 'ptc')
  await h.turn(agent, 'Establish the original tool set.')
  const firstRequest = h.adapter.requests.at(-1), first = systemText(firstRequest)
  const remove = registerTool(agent.ctx, {
    name: 'apex_upgrade_probe', description: 'A temporary scoped compatibility probe.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'new tool reached' },
  })
  const result = await h.runCode(agent, 'return await tools.apex_upgrade_probe({})')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.result, 'new tool reached')
  assert.doesNotMatch(first, /apex_upgrade_probe/)
  assert.equal(systemText(firstRequest), first, 'a published request must not be mutated by tool registration')
  assert.match(systemText(h.adapter.requests.at(-1)), /apex_upgrade_probe/)
  await h.turn(official, 'Inspect the official tool set.')
  assert.doesNotMatch(systemText(h.adapter.requests.at(-1)), /apex_upgrade_probe/)
  remove()
  await h.turn(agent, 'Inspect the tool set after removal.')
  assert.doesNotMatch(systemText(h.adapter.requests.at(-1)), /apex_upgrade_probe/)
})
const ptc = (id, code) => toolResponse(id, 'run_code', { code, description: 'Keyless native integration fixture' })
async function tool(h, agent, name) {
  const { scopeOf } = await native('dsh-scope')
  return h.ctx.tools.get(name, scopeOf(agent.ctx))
}
async function call(h, agent, name, args = {}, signal = new AbortController().signal) {
  const definition = await tool(h, agent, name)
  assert.ok(definition, name)
  return definition.execute(args, { agent, signal })
}
async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(20) }
  assert.fail('Native lifecycle did not settle within 5 seconds')
}
async function storedEvents(h, id) {
  const handle = await h.ctx.sessionPersistence.open(id, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}
function nativeMemberId(h, agent, target) {
  const member = h.ctx.agentTeams.listMembers(agent).find(row => row.name === target)
  assert.ok(member, `native Team member ${target}`)
  return member.id
}

test('first request is native PTC with stable SDK, project instructions and no activation', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  await writeFile(join(h.cwd, 'AGENTS.md'), 'APEX_PROJECT_INSTRUCTIONS_SENTINEL')
  await mkdir(join(h.root, 'user-agents/skills/global-noise'), { recursive: true })
  await writeFile(join(h.root, 'user-agents/skills/global-noise/SKILL.md'), '---\nname: global-noise\ndescription: GLOBAL_SKILL_INJECTION_SENTINEL\n---\nUnrelated skill.')
  const agent = await h.create()
  await h.turn(agent, 'Answer without tools.')
  await h.turn(agent, 'Answer once more without tools.')
  assert.equal(h.adapter.requests.length, 2)
  const first = h.adapter.requests[0]
  assert.deepEqual(first.tools.map(x => x.name), ['run_code'])
  assert.match(first.tools[0].parameters.properties.timeoutMs.description, /Default 20000; capped at 600000/)
  assert.ok(first.tools[0].parameters.properties.sandbox_permissions)
  const system = systemText(first)
  assert.match(first.tools[0].description, /fresh Node process/)
  assert.match(first.tools[0].description, /process.env starts empty/)
  for (const name of ['apex_validate_web', 'apex_read_evidence', 'apex_review', 'spawn_teammate', 'send_message', 'team_task_update', 'web_fetch', 'read_image', 'present']) assert.ok(system.includes(name), name)
  assert.ok(JSON.stringify(first).includes('APEX_PROJECT_INSTRUCTIONS_SENTINEL'))
  assert.doesNotMatch(system, /apex_tools|apex_build|apex_state|agently-mail|apex_takeover|repair-proof/)
  assert.doesNotMatch(system, /Your Team role|your Team name|Team id is/)
  assert.doesNotMatch(JSON.stringify(first), /GLOBAL_SKILL_INJECTION_SENTINEL/)
  assert.match(system, /use finally on success, failure and cancellation/)
  assert.match(system, /stop and await owned processes, then remove exactly the disposable profile/)
  assert.match(system, /request parameters.*not an array of results/)
  assert.match(system, /Non-empty substring/)
  assert.match(system, /complete textContent.*excerpts may be truncated/)
  assert.match(system, /later step with run_callbacks:true/)
  assert.match(system, /JSON-escaped double-quoted strings/)
  assert.match(system, /String\.raw still interpolates/)
  assert.match(system, /If apex_run_script is listed, prefer it for disposable multiline checks/)
  assert.match(system, /test runner's documented file-selection syntax/)
  assert.match(system, /node:test and node:assert\/strict/)
  assert.match(system, /set process\.exitCode = 1 when any check fails/)
  assert.match(system, /failure path once in a disposable copy/)
  assert.match(system, /Wait for required test files and their imports to be ready before broad test discovery/)
  assert.match(system, /Avoid deleting and recreating observed paths just to revise them/)
  assert.equal(systemText(h.adapter.requests[1]), system, 'no per-turn injection or mode switching')
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'system/message').length, 1)
})

test('native PTC token retention preserves Unicode output ends and a complete recovery file', options, async t => {
  const h = await nativeHarness(undefined, { spillTokens: 500 }); t.after(h.close)
  const agent = await h.create()
  const original = 'BEGIN_CHECK\n' + '中文🙂'.repeat(3000) + '\nEND_CHECK exit_code=7'
  const result = await h.runCode(agent, 'return ' + JSON.stringify(original) + ';')
  assert.equal(result.isError, false)
  const message = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result').data.message
  const preview = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.match(preview, /BEGIN_CHECK/)
  assert.match(preview, /END_CHECK exit_code=7/)
  assert.doesNotMatch(preview, /\uFFFD/)
  const { estimateContent } = await native('dsh-token-meter/estimate')
  assert.ok(estimateContent(message.content) <= 500)
  const path = /Full formatted result stored at: (.+?)\. Use read/.exec(preview)?.[1]
  assert.ok(path, 'the model must receive a readable recovery locator')
  t.after(() => rm(path, { force: true }))
  const complete = await readFile(path, 'utf8')
  assert.equal(complete, original)
  const modelCopy = h.adapter.requests.at(-1).messages.findLast(message => message.role === 'tool')
  assert.deepEqual(modelCopy.content, message.content, 'retained output is durably logged before reaching the model')
})

test('APEX Teams honor native live child capacity and release it after settlement', options, async t => {
  let releaseFirst
  const h = await nativeHarness((request, step) => step === 1 ? new Promise(resolve => {
    releaseFirst = () => resolve(textResponse('ready'))
    request.signal.addEventListener('abort', releaseFirst, { once: true })
  }) : textResponse('ready'), { subagentConfig: { maxDepth: 1, maxActiveSubagents: 1 } }); t.after(h.close)
  const parent = await h.create()
  const first = await call(h, parent, 'spawn_teammate', { name: 'first', description: 'Capacity fixture', prompt: 'Reply ready.' })
  assert.equal(first.member.target, 'first')
  const firstId = nativeMemberId(h, parent, first.member.target)
  await until(() => releaseFirst !== undefined)
  await assert.rejects(call(h, parent, 'spawn_teammate', {
    name: 'overflow', description: 'Capacity overflow fixture', prompt: 'Must not reach the model.',
  }), /active child limit: 1/)
  assert.ok(h.ctx.agents.get(firstId), 'rejected admission preserves the running child')
  assert.equal(h.adapter.requests.length, 1)
  releaseFirst()
  await until(() => !h.ctx.agents.get(firstId))
  const next = await call(h, parent, 'spawn_teammate', {
    name: 'replacement', description: 'Released capacity fixture', prompt: 'Reply ready.',
  })
  const nextId = nativeMemberId(h, parent, next.member.target)
  await until(() => !h.ctx.agents.get(nextId))
  for (const name of ['first', 'replacement', 'overflow']) {
    const requests = h.adapter.requests.filter(request => request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes(`You are teammate "${name}".`))))
    assert.equal(requests.length, name === 'overflow' ? 0 : 1, name)
  }
  assert.ok(await h.ctx.sessionPersistence.stat(firstId), 'settlement preserves the first session')
})

test('new native PTC uses fresh processes, session cwd and an empty model environment', options, async t => {
  let step = 0
  const code = 'const previous = globalThis.apexFixtureMarker ?? null; globalThis.apexFixtureMarker = "set"; return {pid:process.pid,cwd:process.cwd(),env:Object.keys(process.env),previous};'
  const h = await nativeHarness(() => step++ < 2 ? ptc(`process-${step}`, code) : textResponse('done'))
  t.after(h.close)
  const agent = await h.create(); await h.turn(agent, 'Inspect process isolation without touching files.')
  const evidence = agent.session.snapshotEvents()
    .filter(event => event.type === 'tool/result')
    .map(event => event.data.message.content.find(block => block.type === 'text')?.text)
    .filter(text => text !== undefined)
    .filter(text => text.trimStart().startsWith('{\n  "pid"'))
  assert.equal(evidence.length, 2)
  const pids = []
  for (const outputText of evidence) {
    const result = JSON.parse(outputText)
    assert.equal(result.cwd, await realpath(h.cwd))
    assert.deepEqual(result.env, []); assert.equal(result.previous, null)
    assert.notEqual(result.pid, process.pid); pids.push(result.pid)
  }
  assert.notEqual(pids[0], pids[1])
  assert.equal(globalThis.apexFixtureMarker, undefined)
})

test('APEX first request and tool history serialize through native Messages without network or credentials', options, async t => {
  const h = await nativeHarness((_request, step) => step === 1
    ? ptc('messages-fixture', 'return await tools.list_agents({});') : textResponse('done'))
  t.after(h.close)
  const agent = await h.create(); await h.turn(agent, 'Read the roster and finish.')
  assert.equal(h.adapter.requests.length, 2)
  const { DeepSeekAdapter, resolveAdapterOptions } = await native('dsh-llm-deepseek')
  const config = resolveAdapterOptions({})
  assert.equal(config.baseURL, 'https://api.deepseek.com/anthropic')
  const adapter = new DeepSeekAdapter({ options: () => config,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'apex-fixture-not-a-credential' } }),
    resolveUserId: () => 'apex-fixture',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(new Headers(init.headers).get('x-api-key'), 'apex-fixture-not-a-credential')
    sent.push(JSON.parse(init.body))
    const events = [
      { type: 'message_start', message: { id: 'fixture', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  })
  for (const request of h.adapter.requests) {
    const chunks = []
    for await (const chunk of adapter.stream(request)) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
  }
  assert.equal(sent.length, 2)
  for (const body of sent) {
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.output_config.effort, 'max')
    assert.deepEqual(body.tools.map(tool => tool.name), ['run_code'])
    assert.ok(body.tools[0].input_schema.properties.timeoutMs)
    assert.ok(JSON.stringify(body).includes('apex_validate_web'))
    assert.equal(Object.hasOwn(body, 'dsh_session_log'), false)
  }
  const blocks = sent[1].messages.flatMap(message => message.content)
  assert.ok(blocks.some(block => block.type === 'tool_use' && block.id === 'messages-fixture'))
  assert.ok(blocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'messages-fixture'))
})

test('official preset and a second APEX session do not inherit each other tools or policies', options, async t => {
  const h = await nativeHarness(undefined, { shippedPresets: true }); t.after(h.close)
  const official = await h.create('official', 'ptc')
  const before = await tool(h, official, 'send_message')
  const apex = await h.create('apex')
  const other = await h.create('another-apex')
  assert.equal(await tool(h, official, 'apex_validate_web'), undefined)
  assert.equal(await tool(h, official, 'spawn_teammate'), undefined)
  assert.equal(await tool(h, official, 'send_message'), before)
  assert.ok(await tool(h, apex, 'spawn_teammate'))
  assert.ok(await tool(h, other, 'spawn_teammate'))
  await h.turn(official, 'Reply without tools.')
  assert.doesNotMatch(systemText(h.adapter.requests.at(-1)), /Use Agent Teams autonomously|APEX/)
  await call(h, apex, 'team_task_create', { subject: 'local', description: 'Only this team' })
  assert.equal((await call(h, other, 'team_task_list')).tasks.length, 0)
})

test('APEX task changes reach the native Team panel projection and survive session reload', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  let parent = await h.create()
  const view = () => h.ctx.sessionProjections.snapshot(parent.session, ['agentTeam']).values.agentTeam
  const before = view()
  assert.deepEqual(before.tasks, [])
  assert.equal(before.members[0].name, 'lead')
  const task = await call(h, parent, 'team_task_create', { subject: 'Panel update', description: 'Durable APEX task' })
  assert.deepEqual(view().tasks, [task])
  assert.deepEqual(before.tasks, [], 'a published panel snapshot must not be mutated by later events')
  const claimed = await call(h, parent, 'team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'claim' })
  const completed = await call(h, parent, 'team_task_update', { task_id: task.id, expected_revision: claimed.revision, action: 'complete' })
  assert.deepEqual(view().tasks, [completed])
  const saved = structuredClone(view())
  assert.equal(saved.failure, undefined)
  assert.equal(saved.messages, undefined, 'the browser projection does not expose the Team mailbox')
  await h.ctx.sessions.flush(parent.session)
  await h.dispose(parent)
  parent = await h.resume(parent.id)
  assert.deepEqual(view(), saved)
  assert.deepEqual((await call(h, parent, 'team_task_list')).tasks, saved.tasks)
})

test('optional-argument tools expose executable empty-object examples in the native PTC SDK', options, async t => {
  const names = ['list_agents', 'wait_agent', 'team_task_list', 'apex_read_evidence']
  const programs = [
    'return await tools.list_agents();',
    'return await (tools.list_agents as any)();',
    names.map(name => `await tools.${name}({});`).join('\n') + '\nreturn "done";',
  ]
  let step = 0
  const h = await nativeHarness(() => step < programs.length
    ? ptc(`optional-${step}`, programs[step++]) : textResponse('done'))
  t.after(h.close)
  const parent = await h.create()
  await h.turn(parent, 'Exercise the SDK argument contract, then finish.')
  const events = parent.session.snapshotEvents()
  const outer = events.filter(e => e.type === 'tool/result')
    .flatMap(e => e.data.message.content.filter(block => block.type === 'text'))
  assert.equal(outer.length, 3)
  for (const block of outer.slice(0, 2)) {
    assert.match(block.text, /binding arguments must be lossless JSON/, 'undefined must remain a native error, including after an as-any cast')
  }
  assert.doesNotMatch(outer[2].text, /Error:/)
  const dispatched = events.filter(e => e.type === 'tool/ptc-dispatch')
  assert.deepEqual(dispatched.map(e => e.data.name), names, 'omitted arguments must not execute any tool')
  assert.ok(dispatched.every(e => !e.data.isError), JSON.stringify(dispatched))
  assert.equal(JSON.parse(dispatched[0].data.content[0].text)[0].target, 'lead', 'list_agents returns the real Lead target')
  assert.equal(h.adapter.requests.length, 4, 'no automatic retry or extra model turn')
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
  const system = systemText(h.adapter.requests[0])
  for (const name of names) {
    const example = `PTC usage: await tools.${name}({});`
    assert.ok(system.includes(example), `${name}: missing first-request SDK example`)
    assert.equal(system.split(example).length - 1, 1, `${name}: duplicate guidance`)
  }
  for (const name of ['spawn_teammate', 'apex_validate_web']) {
    assert.ok(!system.includes(`PTC usage: await tools.${name}({});`), 'required arguments must not get an empty-object example')
    await assert.rejects(call(h, parent, name, {}), new RegExp(name))
  }
  assert.doesNotMatch((await tool(h, parent, 'apex_read_evidence')).description, /No arguments/)
  await assert.rejects(call(h, parent, 'list_agents', null), /list_agents/)
})

test('candidate preset declaration mounts through the new package', options, async t => {
  const h = await nativeHarness(undefined, { emptyRoster: true }); t.after(h.close)
  await loadApexPresetFixture(h.ctx)
  assert.deepEqual((await h.ctx.agentPresets.list()).map(row => row.id), ['apex-v1'])
  const agent = await h.create()
  await h.turn(agent, 'Reply without tools.')
  assert.ok(systemText(h.adapter.requests[0]).includes('apex_validate_web'))
})

test('PTC literal payloads preserve source text without concealing template interpolation failures', options, async t => {
  const payload = '`instanceof TypeError` ${not-a-template} 中文\n\\n \\([0-9.]+ms$ "quoted"'
  const programs = [
    'const text = `check `instanceof TypeError` now`; return await tools.team_task_create({subject:"literal",description:text});',
    'const text = String.raw`${not-a-template}`; return await tools.write({file_path:"payload.txt",content:text});',
    `const text = ${JSON.stringify(payload)}; await tools.team_task_create({subject:"literal",description:text}); return await tools.write({file_path:"payload.txt",content:text});`,
  ]
  let step = 0
  const h = await nativeHarness(() => step < programs.length ? ptc(`literal-${step}`, programs[step++]) : textResponse('done'))
  t.after(h.close)
  const agent = await h.create()
  await h.turn(agent, 'Exercise literal argument transport once per supplied program.')
  const events = agent.session.snapshotEvents()
  const results = events.filter(e => e.type === 'tool/result')
    .flatMap(e => e.data.message.content.filter(block => block.type === 'text'))
  assert.equal(results.length, 3)
  assert.match(results[0].text, /Right-hand side of 'instanceof' is not callable/)
  assert.match(results[1].text, /not is not defined/)
  assert.doesNotMatch(results[2].text, /Error:/)
  assert.deepEqual(events.filter(e => e.type === 'tool/ptc-dispatch').map(e => e.data.name), ['team_task_create', 'write'])
  assert.equal((await call(h, agent, 'team_task_list')).tasks[0].description, payload)
  assert.equal(await readFile(join(h.cwd, 'payload.txt'), 'utf8'), payload)
  assert.equal(h.adapter.requests.length, 4, 'no rewriting, automatic retry or added model turn')
})

test('native file observations survive Shell deletion and still reject concurrent replacement', {
  ...options, skip: options.skip || process.platform === 'win32',
}, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create(), file = join(h.cwd, 'observed.txt')
  const write = content => call(h, agent, 'write', { file_path: file, content })
  await write('original')
  await write('local revision')
  assert.equal(await readFile(file, 'utf8'), 'local revision', 'native replacement needs no directory reset')
  const removed = await call(h, agent, 'bash', { command: 'rm -- observed.txt', description: 'Remove this fixture-owned file' })
  assert.equal(removed.exitCode, 0)
  await assert.rejects(write('stale recreation'), error => error.code === 'FS_STALE_VERSION')
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  await assert.rejects(call(h, agent, 'read', { file_path: file }), error => error.code === 'FS_NOT_FOUND')
  // Explicitly observing absence permits creation, but cannot erase a later writer.
  await writeFile(file, 'another writer')
  await assert.rejects(write('blind overwrite'), error => error.code === 'FS_NOT_OBSERVED')
  assert.equal(await readFile(file, 'utf8'), 'another writer')
  await call(h, agent, 'read', { file_path: file })
  await write('rebased revision')
  assert.equal(await readFile(file, 'utf8'), 'rebased revision')
})

test('native one-shot shell handles workdir, parent cd, Unicode, quotes and long heredoc without changing later cwd', options, async t => {
  const body = "α中文 'quoted' $literal `backticks` " + 'x'.repeat(40000)
  const command = `node <<'APEX_FIXTURE'\nconst value = ${JSON.stringify(body)}; console.log(value.length);\nAPEX_FIXTURE\n`
  let step = 0
  const h = await nativeHarness(() => ++step === 1 ? ptc('shell', `
    const a = await tools.bash({command:${JSON.stringify(command)},description:'Long Unicode heredoc'});
    const b = await tools.bash({command:'cd ..; pwd',workdir:'sub',description:'Parent directory in one call'});
    const c = await tools.bash({command:'pwd',description:'Next call starts at workspace'});
    const d = await tools.bash({command:'exit 7',description:'Preserve nonzero exit'});
    return {a,b,c,d};`) : textResponse('done'))
  t.after(h.close)
  await mkdir(join(h.cwd, 'sub'))
  const agent = await h.create()
  await h.turn(agent, 'Run the local shell fixtures, then finish.')
  const rows = readExecutionEvidence(agent).results.filter(row => row.tool === 'bash')
  assert.equal(rows.length, 4)
  assert.ok(rows.every(row => !row.toolError), JSON.stringify(rows))
  assert.ok(rows[0].outputText.includes(String(body.length)))
  assert.ok(rows[1].outputText.includes(h.cwd))
  assert.ok(rows[2].outputText.includes(h.cwd))
  assert.match(rows[3].outputText, /\[exit code: 7\]/)
  assert.equal(h.adapter.requests.length, 2)
})

test('fresh and fork teammates inherit the model; task dependencies, CAS and cold recovery stay native', options, async t => {
  let releaseAlpha
  const h = await nativeHarness(request => {
    if (!releaseAlpha && request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('You are teammate "alpha".')))) {
      return new Promise(resolve => {
        releaseAlpha = () => resolve(textResponse('ready'))
        request.signal.addEventListener('abort', releaseAlpha, { once: true })
      })
    }
    return textResponse('ready')
  }, { model: 'future-multimodal-pro-fixture' }); t.after(h.close)
  let parent = await h.create()
  await h.turn(parent, 'Prepare a completed prefix for the fork.')
  const a = (await call(h, parent, 'spawn_teammate', { name: 'alpha', description: 'Read-only task A', prompt: 'Reply ready.', context: 'fresh' })).member
  const b = (await call(h, parent, 'spawn_teammate', { name: 'beta', description: 'Read-only task B', prompt: 'Reply ready.', context: 'fork' })).member
  assert.equal(a.target, 'alpha'); assert.equal(b.target, 'beta')
  const alphaId = nativeMemberId(h, parent, a.target), betaId = nativeMemberId(h, parent, b.target)
  await until(() => releaseAlpha !== undefined)
  const alpha = h.ctx.agents.get(alphaId)
  await until(() => !h.ctx.agents.get(betaId))
  assert.equal(alpha.options.model, parent.options.model)
  assert.equal(alpha.options.reasoningEffort, 'max')
  assert.equal((await h.ctx.sessionPersistence.stat(alphaId)).header.isSeeded, false)
  assert.equal((await h.ctx.sessionPersistence.stat(betaId)).header.isSeeded, true)
  for (const [id, name] of [[alphaId, 'alpha'], [betaId, 'beta']]) {
    const identity = `You are teammate "${name}".`
    const messages = (await storedEvents(h, id)).filter(event => event.type === 'user/message')
    assert.equal(messages.filter(event => event.data.content.some(block => block.type === 'text'
      && block.text.includes(identity))).length, 1, 'native teammate identity is supplied once on fresh and fork')
  }
  const first = await call(h, parent, 'team_task_create', { subject: 'First', description: 'First task', write_scopes: ['module.js'] })
  const second = await call(h, parent, 'team_task_create', { subject: 'Second', description: 'Depends on first', blocked_by: [first.id], write_scopes: ['module.js'] })
  assert.equal(second.ready, false)
  const claimed = await call(h, alpha, 'team_task_update', { task_id: first.id, expected_revision: first.revision, action: 'claim' })
  await assert.rejects(call(h, parent, 'team_task_update', { task_id: first.id, expected_revision: first.revision, action: 'edit', subject: 'stale' }), /revision/i)
  await call(h, alpha, 'team_task_update', { task_id: first.id, expected_revision: claimed.revision, action: 'complete' })
  assert.equal((await call(h, parent, 'team_task_get', { task_id: second.id })).ready, true)
  await assert.rejects(call(h, alpha, 'spawn_teammate', { name: 'forbidden', description: 'Nested', prompt: 'Do not run' }), /Lead/)
  const controller = new AbortController()
  const waiting = call(h, parent, 'wait_agent', {}, controller.signal)
  controller.abort(new Error('cancel active wait'))
  await assert.rejects(waiting, /cancel active wait/)
  releaseAlpha()
  await until(() => !h.ctx.agents.get(alphaId))
  const receipt = await call(h, parent, 'send_message', { target: 'alpha', message: 'Reply acknowledged.' })
  assert.equal(receipt.status, 'accepted')
  await until(() => !h.ctx.agents.get(alphaId))
  assert.equal((await storedEvents(h, alphaId)).filter(e => e.type === 'user/message' && e.data.source.messageId === receipt.messageId).length, 1)
  assert.equal((await call(h, parent, 'wait_agent')).noProgress.reason, 'no-active-peer')
  await h.dispose(parent)
  parent = await h.resume(parent.id)
  assert.equal((await call(h, parent, 'team_task_get', { task_id: first.id })).status, 'completed')
  assert.equal((await call(h, parent, 'list_agents')).length, 3)
  const wake = await call(h, parent, 'send_message', { target: 'alpha', message: 'Cold resume and reply ready.' })
  assert.ok(['accepted', 'queued'].includes(wake.status))
  await until(() => !h.ctx.agents.get(alphaId))
  assert.ok(h.adapter.requests.every(request => request.model === parent.options.model))
})

test('review tool executes read-only child filtering without the PTC transport', options, async t => {
  const childRequests = []
  let requested = false
  const h = await nativeHarness(request => {
    if (systemText(request).includes('You are an independent read-only reviewer')) {
      childRequests.push(request)
      return childRequests.length === 1 ? toolResponse('review-deny', 'write', {file_path:"forbidden.txt",content:"no"}) : textResponse('Read-only review: write unavailable.')
    }
    if (!requested) { requested = true; return ptc('review', 'return await tools.apex_review({description:"Independent read-only review",prompt:"Review existing files without editing them."});') }
    return textResponse('Review finished; the attempted write was denied.')
  }); t.after(h.close)
  const parent = await h.create()
  await h.turn(parent, 'Request an independent read-only review.')
  assert.equal(childRequests.length, 2)
  assert.deepEqual(childRequests[0].tools.map(t => t.name).sort(), ['glob', 'grep', 'read', 'read_image'])
  assert.doesNotMatch(systemText(childRequests[0]), /run_code|tools\.read/)
  assert.doesNotMatch(systemText(childRequests[0]), /spawn_teammate:|apex_validate_web:|write:|Use Agent Teams autonomously/)
  await assert.rejects(readFile(join(h.cwd, 'forbidden.txt')), { code: 'ENOENT' })
  assert.ok(JSON.stringify(childRequests[1]).includes('write'))
})

test('cancelled Team wait propagates cancellation and preserves the next turn', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const agent = await h.create(), controller = new AbortController()
  controller.abort(new Error('cancel fixture'))
  await assert.rejects(call(h, agent, 'wait_agent', {}, controller.signal), /cancel fixture/)
  await assert.rejects(call(h, agent, 'wait_agent', { timeout_ms: 1 }), /timeout/i)
  await h.turn(agent, 'Reply done.')
  assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
})

test('long Team waits use repeatable native 60-second windows without cancelling work', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const caller = await h.create(), controller = new AbortController()
  const wait = await tool(h, caller, 'wait_agent')
  let active = true, serviceCalls = 0
  t.mock.method(h.ctx.agentTeams, 'listMembers', () => [
    { id: caller.id, name: 'lead', status: 'running', diagnostics: [] },
    { id: 'peer', name: 'peer', status: active ? 'running' : 'inactive', diagnostics: [] },
  ])
  const nativeWait = h.ctx.agentTeams.waitForChange
  t.mock.method(h.ctx.agentTeams, 'waitForChange', function (agent, timeoutMs, signal) {
    assert.equal(agent, caller); serviceCalls++
    return nativeWait.call(this, agent, timeoutMs, signal)
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exec = { agent: caller, signal: controller.signal }
  // Simulated wall time, real native TeamActivity timers; no real model or long sleep.
  for (let i = 0; i < 12; i++) {
    const args = { timeout_ms: 900_000 }
    let settled = false
    const waiting = wait.execute(args, exec).then(result => { settled = true; return result })
    t.mock.timers.tick(59_999)
    await Promise.resolve()
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    assert.deepEqual(await waiting, { timedOut: true,
      waitWindow: { requestedTimeoutMs: 900_000, effectiveTimeoutMs: 60_000 } })
    assert.deepEqual(args, { timeout_ms: 900_000 })
    assert.equal(active, true)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
  const short = wait.execute({}, exec)
  t.mock.timers.tick(30_000)
  assert.deepEqual(await short, { timedOut: true })
  const early = wait.execute({ timeout_ms: 900_000 }, exec)
  await h.ctx.agentTeams.createTask(caller, { subject: 'Native change', description: 'Wake only the active waiter' })
  assert.equal((await early).timedOut, false, 'native activity ends a slice early')
  const cancelled = wait.execute({ timeout_ms: 900_000 }, exec)
  const rejection = assert.rejects(cancelled, /cancel window/)
  controller.abort(new Error('cancel window'))
  await rejection
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  active = false
  const fresh = { agent: caller, signal: new AbortController().signal }
  const callsBefore = serviceCalls
  assert.equal((await wait.execute({ timeout_ms: 900_000 }, fresh)).noProgress.reason, 'no-active-peer')
  assert.equal(serviceCalls, callsBefore, 'no inactive wait is started')
  await assert.rejects(wait.execute({ timeout_ms: 3_600_001 }, fresh), /timeoutMs/)
})

test('long-wait window metadata survives native PTC output validation and logged evidence', options, async t => {
  let step = 0
  const h = await nativeHarness(() => ++step <= 2
    ? ptc(`wait-window-${step}`, 'return await tools.wait_agent({timeout_ms:900000});') : textResponse('done'))
  t.after(h.close)
  // Only elapsed waiting is simulated here; the native registry, PTC and logs are real.
  t.mock.method(h.ctx.agentTeams, 'listMembers', () => [{ id: 'peer', name: 'peer', status: 'running', diagnostics: [] }])
  t.mock.method(h.ctx.agentTeams, 'waitForChange', async (_agent, ms, signal) => {
    signal.throwIfAborted(); assert.equal(ms, 60_000); return { timedOut: true }
  })
  const parent = await h.create()
  await h.turn(parent, 'Exercise separate wait requests, then finish.')
  const events = parent.session.snapshotEvents()
  const results = events.filter(event => event.type === 'tool/ptc-dispatch')
  assert.equal(results.length, 2)
  for (const event of results) {
    assert.equal(event.data.isError, false)
    assert.deepEqual(JSON.parse(event.data.content[0].text), { timedOut: true,
      waitWindow: { requestedTimeoutMs: 900_000, effectiveTimeoutMs: 60_000 } })
  }
  const outer = events.filter(e => e.type === 'tool/result').flatMap(e => e.data.message.content)
  assert.ok(outer.length === 2 && outer.every(block => !block.isError))
  assert.equal(h.adapter.requests.length, 3, 'no plugin-triggered continuation or project budget')
})

test('native job_output caps each wait, keeps jobs alive and preserves cancellation and ownership', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  const parent = await h.create(), other = await h.create('other-job-owner')
  const output = await tool(h, parent, 'job_output')
  const { promise: done, resolve: finish } = Promise.withResolvers()
  let cancellations = 0, calls = 0, expectedTimeout = 60_000
  const id = h.ctx.jobs.start({ owner: parent.id, kind: 'bash', label: 'Deferred native job fixture',
    run: () => ({ done, cancel() { cancellations++; finish({ status: 'killed' }) } }),
  })
  const nativeWait = h.ctx.jobs.wait
  t.mock.method(h.ctx.jobs, 'wait', function (jobId, ms, caller, signal) {
    calls++; assert.equal(ms, expectedTimeout)
    return nativeWait.call(this, jobId, ms, caller, signal)
  })
  const controller = new AbortController(), exec = { agent: parent, signal: controller.signal }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // Advance real native deadlines in virtual time, including more than ten minutes of work.
    for (const requested of [...Array(12).fill(600_000), undefined, 1500]) {
      expectedTimeout = requested === undefined ? 30_000 : Math.min(requested, 60_000)
      const args = { job_id: id, wait: true, ...requested === undefined ? {} : { timeout_ms: requested } }
      const original = structuredClone(args)
      const waiting = output.execute(args, exec)
      t.mock.timers.tick(expectedTimeout)
      const result = await waiting
      assert.equal(result.job.status, 'running')
      assert.equal(result.text, '')
      assert.equal(cancellations, 0)
      assert.deepEqual(args, original, 'native clamping must not mutate model arguments')
    }
    const before = calls
    assert.equal((await output.execute({ job_id: id }, exec)).job.status, 'running')
    assert.equal(calls, before, 'non-blocking reads do not start a wait')
    for (const invalid of [0, -1]) {
      expectedTimeout = invalid
      await assert.rejects(output.execute({ job_id: id, wait: true, timeout_ms: invalid }, exec), /invalid wait timeout/)
    }
    expectedTimeout = 60_000
    await assert.rejects(output.execute({ job_id: id, wait: true, timeout_ms: 600_000 },
      { agent: other, signal: controller.signal }), /belong|access|owner/i)
    const cancelled = output.execute({ job_id: id, wait: true, timeout_ms: 600_000 }, exec)
    const rejection = assert.rejects(cancelled, /wait aborted/)
    controller.abort(new Error('cancel the wait, not the job'))
    await rejection
    assert.equal(h.ctx.jobs.get(id, parent.id).status, 'running')
    assert.equal(cancellations, 0)
    const early = output.execute({ job_id: id, wait: true, timeout_ms: 600_000 },
      { agent: parent, signal: new AbortController().signal })
    finish({ status: 'completed', result: 'native completion' })
    const result = await early
    assert.equal(result.job.status, 'completed')
    assert.equal(result.text, 'native completion')
    assert.equal(h.adapter.requests.length, 0, 'waiting does not drive model turns')
  } finally { t.mock.timers.reset() }
})

test('job_output long requests stay valid through native PTC and leave the official preset unchanged', options, async t => {
  let step = 0, jobId
  const h = await nativeHarness(() => ++step <= 2 ? ptc(`job-window-${step}`,
    `return await tools.job_output({job_id:${JSON.stringify(jobId)},wait:true,timeout_ms:600000});`) : textResponse('done'),
  { shippedPresets: true })
  t.after(h.close)
  const parent = await h.create(), official = await h.create('official-jobs', 'ptc')
  const { promise: done, resolve: finish } = Promise.withResolvers()
  jobId = h.ctx.jobs.start({ owner: parent.id, kind: 'bash', label: 'PTC wait fixture',
    run: () => ({ done, cancel: () => finish({ status: 'killed' }) }),
  })
  const nativeWait = h.ctx.jobs.wait
  t.mock.method(h.ctx.jobs, 'wait', function (id, ms, caller, signal) {
    assert.equal(ms, caller === official.id ? 600_000 : 60_000)
    if (caller === parent.id && step === 2) finish({ status: 'completed', result: 'ready' })
    // Only elapsed time is shortened; native job status, PTC validation and logging remain real.
    return nativeWait.call(this, id, 1, caller, signal)
  })
  await h.turn(parent, 'Read the job in separate requests, then finish.')
  const events = parent.session.snapshotEvents()
  const results = events.filter(e => e.type === 'tool/ptc-dispatch')
  assert.equal(results.length, 2)
  assert.ok(results.every(e => !e.data.isError), JSON.stringify(results))
  assert.match(results[0].data.content[0].text, /status: running/)
  assert.match(results[1].data.content[0].text, /ready[\s\S]*status: completed/)
  assert.ok(events.filter(e => e.type === 'tool/result').every(e => e.data.message.content.every(b => !b.isError)))
  assert.equal(h.adapter.requests.length, 3)
  const system = systemText(h.adapter.requests[0])
  assert.match(system, /job_output waits at most 60000 ms per call/)
  assert.match(system, /not a job or project deadline/)
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
  const officialJob = h.ctx.jobs.start({ owner: official.id, kind: 'bash', label: 'Official scope fixture',
    run: () => ({ done: Promise.resolve({ status: 'completed' }), cancel() {} }),
  })
  await call(h, official, 'job_output', { job_id: officialJob, wait: true, timeout_ms: 600_000 })
  await h.turn(official, 'Reply without tools.')
  assert.doesNotMatch(systemText(h.adapter.requests.at(-1)), /job_output waits at most 60000/)
})

test('present advertises its native batch limit before execution and keeps failed batches atomic', options, async t => {
  const files = Array.from({ length: 9 }, (_, i) => ({ path: `delivery-${i}.txt` }))
  const batches = [[], files, [files[0], { path: 'missing.txt' }], files.slice(0, 8), files.slice(8)]
  let step = 0
  const h = await nativeHarness(() => step < batches.length ? ptc(`present-${step}`,
    `return await tools.present({files:${JSON.stringify(batches[step++])}});`) : textResponse('done'))
  t.after(h.close)
  await Promise.all(files.map(file => writeFile(join(h.cwd, file.path), 'fixture')))
  const parent = await h.create()
  await h.turn(parent, 'Exercise native delivery boundaries, then finish.')
  const events = parent.session.snapshotEvents()
  const results = events.filter(e => e.type === 'tool/ptc-dispatch')
  assert.equal(results.length, 5)
  assert.deepEqual(results.map(e => e.data.isError), [true, true, true, false, false])
  for (const result of results.slice(0, 2)) assert.match(result.data.content[0].text, /present accepts 1 to 8 files/)
  assert.match(results[2].data.content[0].text, /file not found/)
  assert.deepEqual(events.filter(e => e.type === 'deliverables/presented').map(e => e.data.files), [files.slice(0, 8), files.slice(8)])
  const hint = 'present accepts 1 to 8 files per call; split larger deliveries into separate calls.'
  const first = systemText(h.adapter.requests[0])
  assert.equal(first.split(hint).length - 1, 1, 'the first request includes the configured limit exactly once')
  assert.equal(systemText(h.adapter.requests.at(-1)), first)
  assert.equal(events.filter(e => e.type === 'system/message').length, 1)
  assert.equal(h.adapter.requests.length, 6, 'no automatic retry or forced additional turn')
})

test('queued native mail survives lead cold recovery and is delivered exactly once', options, async t => {
  const h = await nativeHarness(); t.after(h.close)
  let parent = await h.create()
  const child = (await call(h, parent, 'spawn_teammate', { name: 'reader', description: 'Read-only fixture', prompt: 'Reply ready.' })).member
  const childId = nativeMemberId(h, parent, child.target)
  await until(() => !h.ctx.agents.get(childId))
  const open = h.ctx.sessionPersistence.open
  let failed = false
  const mock = t.mock.method(h.ctx.sessionPersistence, 'open', async function (...args) {
    if (args[0] === childId && !failed) { failed = true; throw new Error('fixture target temporarily unavailable') }
    return open.apply(this, args)
  })
  const receipt = await call(h, parent, 'send_message', { target: 'reader', message: 'Durable queued message.' })
  assert.equal(receipt.status, 'queued')
  mock.mock.restore()
  const requestsBeforeWait = h.adapter.requests.length
  const pending = (await call(h, parent, 'list_agents')).find(member => member.target === 'reader')
  assert.equal(pending.status, 'inactive')
  assert.match(pending.diagnostics.join('\n'), /1 Team message\(s\) await recorded delivery/)
  assert.deepEqual(h.ctx.agentTeams.listMembers(parent).find(member => member.name === 'reader').diagnostics, [], 'APEX must not mutate the native roster')
  const waiting = await call(h, parent, 'wait_agent')
  assert.equal(waiting.noProgress.reason, 'no-active-peer')
  assert.match(waiting.noProgress.message, /reader: 1 Team message/)
  assert.match(waiting.noProgress.message, /do not resend it or spawn a replacement/)
  assert.equal(h.adapter.requests.length, requestsBeforeWait, 'Observation must not retry or start a model turn')
  await h.ctx.sessions.flush(parent.session)
  const requests = h.adapter.requests.length
  await h.dispose(parent)
  parent = await h.resume(parent.id)
  await until(() => h.adapter.requests.length > requests && !h.ctx.agents.get(childId))
  assert.equal((await storedEvents(h, childId)).filter(e => e.type === 'user/message' && e.data.source.messageId === receipt.messageId).length, 1)
  const settled = (await call(h, parent, 'list_agents')).find(member => member.target === 'reader')
  assert.equal(settled.status, 'inactive')
  assert.deepEqual(settled.diagnostics, [], 'Recorded delivery removes the pending diagnostic')
})

test('native interrupt cancels a running teammate without deleting its roster or session', options, async t => {
  let started = false
  const h = await nativeHarness(request => {
    started = true
    return new Promise(resolve => {
      if (request.signal.aborted) resolve([])
      else request.signal.addEventListener('abort', () => resolve([]), { once: true })
    })
  }); t.after(h.close)
  const parent = await h.create()
  const child = (await call(h, parent, 'spawn_teammate', { name: 'waiting', description: 'Cancelable fixture', prompt: 'Wait.' })).member
  const childId = nativeMemberId(h, parent, child.target)
  await until(() => started)
  const result = await call(h, parent, 'interrupt_agent', { target: 'waiting' })
  assert.equal(result.previousStatus, 'running')
  await until(() => !h.ctx.agents.get(childId))
  assert.ok(await h.ctx.sessionPersistence.stat(childId))
  assert.equal((await call(h, parent, 'list_agents')).find(m => m.target === child.target).status, 'inactive')
  assert.notEqual((await storedEvents(h, childId)).findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
})

test('Team creation and task updates are callable through the first native PTC SDK', options, async t => {
  let parentStep = 0
  const h = await nativeHarness(request => {
    if (request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('You are teammate "helper".')))) return textResponse('Read-only teammate ready.')
    return ++parentStep === 1 ? ptc('native-team', `
      const task = await tools.team_task_create({subject:'Read fixture', description:'Read-only protocol fixture'});
      const member = await tools.spawn_teammate({name:'helper',description:'Independent read-only check',prompt:'Reply ready.'});
      const current = await tools.team_task_get({task_id:task.id});
      const claimed = await tools.team_task_update({task_id:task.id,expected_revision:current.revision,action:'claim'});
      await tools.team_task_update({task_id:task.id,expected_revision:claimed.revision,action:'complete'});
      await tools.wait_agent({});
      return await tools.team_task_list({status:'completed'});`) : textResponse('Task complete.')
  }); t.after(h.close)
  const parent = await h.create(); await h.turn(parent, 'Run the independent fixture, then finish.')
  const calls = parent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch')
  assert.equal(calls.length, 7)
  assert.ok(calls.every(e => !e.data.isError), JSON.stringify(calls.map(e => [e.data.name,e.data.isError,e.data.content])))
  assert.equal((await call(h, parent, 'team_task_list', { status: 'completed' })).tasks.length, 1)
  assert.equal(parentStep, 2)
})
