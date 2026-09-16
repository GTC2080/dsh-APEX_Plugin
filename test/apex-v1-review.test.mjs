import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { native, harnessRoot, harnessAvailable, pluginRoot, systemText, textResponse, toolResponse } from './helpers/harness-v1.mjs'
import * as review from '../presets/apex-v1/review.mjs'

// Real in-memory native registry/loop/provider/runtime; no Host, DSH_HOME,
// persistence backend, network adapter or second installation is created.
async function fixture(t, script, mountReview = true) {
  const { Context } = await native('cordis')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(harnessRoot, 'apps/cli/')).href
  t.after(() => ctx.fiber.dispose())
  for (const [name, config] of [
    ['cordis-plugin-loader'], ['dsh-llm'], ['dsh-session'], ['dsh-session-projection'],
    ['dsh-system-prompt'], ['dsh-tools', { mode: 'ptc' }], ['dsh-agent'],
    ['dsh-subprocess-local'], ['dsh-sandbox-local'],
    ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: process.cwd() }],
    ['dsh-fs-sandbox', { cwd: process.cwd() }],
    ['dsh-ptc-runtime-node', { timeoutMs: 5000 }],
    ['dsh-agent-loop', { agents: [] }], ['dsh-subagent'],
    ['dsh-subagent-spawn-in-process', { providerName: 'spawn' }],
  ]) {
    const mod = await native(name)
    await ctx.plugin(mod.default ?? mod, config)
  }
  const { defineTool } = await native('dsh-tools')
  const executed = []
  for (const name of ['read', 'read_image', 'glob', 'grep', 'write', 'bash', 'spawn_teammate']) {
    ctx.tools.register(defineTool({ name, description: 'In-memory fixture tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      execute: async () => { executed.push(name); return 'fixture content' },
    }))
  }
  if (mountReview) await ctx.plugin(review)
  const { LlmAdapter, createUserMessage } = await native('dsh-llm')
  const requests = []
  class Scripted extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' } }
    async *stream(request) {
      requests.push(request)
      for (const chunk of await script(request)) { request.signal?.throwIfAborted(); yield chunk }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Scripted())
  return { ctx, requests, executed, async create(id, setup) {
    return ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup })
  }, async turn(agent) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture task' }] }))
    await agent.whenIdle()
  } }
}

test('review first request is native and rejects direct Node execution, writes, shell and delegation', { skip: !harnessAvailable, timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'apex-review-boundary-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const canary = join(dir, 'must-not-exist')
  const childRequests = [], parents = []
  const attempted = [
    ['run_code', { code: `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(canary)}, 'escaped'); const cp = await import('node:child_process'); cp.execFileSync(process.execPath, ['-e', ''], {timeout:1000}); return 'escaped';`, description: 'Probe forbidden direct Node execution' }],
    ['write', {}], ['bash', {}], ['spawn_teammate', {}],
    ...['read', 'read_image', 'glob', 'grep'].map(name => [name, {}]),
  ]
  const h = await fixture(t, request => {
    if (systemText(request).includes('independent read-only reviewer')) {
      childRequests.push(request)
      const attempt = attempted[childRequests.length - 1]
      return attempt ? toolResponse(`child-${childRequests.length}`, ...attempt) : textResponse('review complete')
    }
    parents.push(request)
    return parents.length === 1 ? toolResponse('parent-review', 'run_code', {
      description: 'Request review', code: 'return await tools.apex_review({description:"Read-only fixture review",prompt:"Inspect only."});',
    }) : textResponse('done')
  })
  const parent = await h.create('review-parent')
  t.after(() => parent.dispose())
  await h.turn(parent.agent)
  assert.equal(childRequests.length, attempted.length + 1)
  for (const request of childRequests) {
    assert.deepEqual(request.tools.map(t => t.name).sort(), ['glob', 'grep', 'read', 'read_image'])
    assert.doesNotMatch(systemText(request), /tools\.read|run_code|PTC|Use Agent Teams autonomously/)
    assert.match(systemText(request), /smallest counterexample or check that could confirm or refute/)
    assert.match(systemText(request), /Distinguish observations from static inferences/)
    assert.match(systemText(request), /proposed checks have not been executed by you/)
    assert.match(systemText(request), /no supported findings without inventing defects/)
    assert.equal(request.model, 'fixture', 'native model inheritance stays intact')
  }
  assert.deepEqual(h.executed, ['read', 'read_image', 'glob', 'grep'])
  for (const request of parents) assert.deepEqual(request.tools.map(t => t.name), ['run_code'])
  await assert.rejects(access(canary), { code: 'ENOENT' })
  assert.equal(parent.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
  const sibling = await h.create('ordinary-sibling'), official = await h.create('official-native', ctx => { ctx.tools.presentAs('native') })
  t.after(() => sibling.dispose()); t.after(() => official.dispose())
  assert.ok(h.ctx.tools.get('run_code', sibling.agent))
  assert.ok(h.ctx.tools.get('write', sibling.agent))
  assert.equal(h.ctx.tools.get('run_code', official.agent), undefined)
  assert.ok(h.ctx.tools.get('write', official.agent))
})

test('parent first request explains review limits once and preserves unverified findings without affecting other scopes', { skip: !harnessAvailable, timeout: 15000 }, async t => {
  const report = 'Static inference at fixture.mjs:4: input may be aliased. Proposed check (not executed): mutate the input after push. No measured failure or pass.'
  const parents = [], children = []
  const h = await fixture(t, request => {
    const system = systemText(request)
    if (system.includes('independent read-only reviewer')) {
      children.push(request)
      return textResponse(report)
    }
    if (!system.includes('You are APEX')) return textResponse('ordinary reply')
    parents.push(request)
    return parents.length === 1 ? toolResponse('review-handoff', 'run_code', {
      description: 'Read-only review', code: 'return await tools.apex_review({description:"Inspect fixture",prompt:"Inspect fixture.mjs against the supplied requirements."});',
    }) : textResponse('done')
  }, false)
  const { createScope, bindScopeParent, scopeOf } = await native('dsh-scope')
  const { entryListSchema } = await native('cordis-plugin-include')
  const { load, dump } = createRequire(join(harnessRoot, 'package.json'))('js-yaml')
  // Use the shipped persona and review rows, with the native YAML dialect and
  // scope/provider/loop. No full Host fixture or temporary DSH_HOME is needed.
  const entries = load(await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
  const persona = entries.find(row => row.id === 'persona')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(entries.find(row => row.id === 'apex-review').name, 'dsh-apex/apex-v1/review')
  const dir = await mkdtemp(join(tmpdir(), 'apex-review-composition-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const composition = join(dir, 'agent.cordis.yml')
  await writeFile(composition, dump([persona, { ...entries.find(row => row.id === 'apex-review'), name: join(pluginRoot, 'presets/apex-v1/review.mjs') }]))
  const roster = await native('dsh-agent-presets')
  await h.ctx.plugin(roster.default, { default: 'fixture', roots: [], includeShippedRoot: false, includeUserRoot: false })
  const key = {}, preset = createScope(h.ctx, key)
  t.after(() => preset.dispose())
  // Native composeFrom() recognizes standing mounts, not an arbitrary scope
  // parent. Exercise the real join so the delegated child inherits this preset.
  await roster.mountPreset(preset.ctx, { id: 'fixture', trust: 'user', path: composition })
  const parent = await h.create('guided-parent', ctx => { bindScopeParent(scopeOf(ctx), key) })
  t.after(() => parent.dispose())
  await h.turn(parent.agent)
  assert.equal(parents.length, 2, JSON.stringify(parent.agent.session.snapshotEvents().slice(-2)))
  assert.equal(children.length, 1)
  const first = systemText(parents[0])
  assert.match(first, /apex_review is optional read-only code\/image review/)
  assert.match(first, /cannot execute commands, write even temporary files, or delegate/)
  assert.match(first, /Use yourself or a capable teammate for execution/)
  assert.match(first, /Treat review findings as hypotheses/)
  assert.match(first, /existing evidence or the smallest relevant check before editing/)
  assert.match(first, /do not require either for every task/)
  assert.match(first, /cleanup failures as incomplete cleanup, which may include partial deletion/)
  assert.match(first, /mark only the affected resource state as unknown and retain other confirmed facts/)
  assert.match(first, /A zero exit code does not prove that no processes or temporary files remain/)
  assert.equal(first.split('apex_review is optional read-only').length - 1, 1)
  assert.equal((first.match(/\n  apex_review: \{/g) ?? []).length, 2, 'one native input and one native output declaration')
  assert.ok(JSON.stringify(parents[1].messages).includes(report), 'the native result retains the unverified claim verbatim')
  const dispatch = parent.agent.session.snapshotEvents().find(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'apex_review')
  assert.ok(dispatch && !dispatch.data.isError)
  assert.ok(JSON.stringify(dispatch.data.content).includes(report), 'tool success is not rewritten into test acceptance')
  assert.deepEqual(children[0].tools.map(t => t.name).sort(), ['glob', 'grep', 'read', 'read_image'])
  assert.doesNotMatch(systemText(children[0]), /apex_review is optional read-only|You are APEX/)
  await h.turn(parent.agent)
  assert.equal(parents.length, 3, 'only the explicit follow-up adds another parent request')
  for (const request of parents) {
    assert.deepEqual(request.tools.map(t => t.name), ['run_code'])
    assert.equal(systemText(request), first, 'stable prompt, no per-turn reminder')
  }
  assert.equal(parent.agent.session.snapshotEvents().filter(e => e.type === 'system/message').length, 1)
  const ordinary = await h.create('ordinary-parent')
  t.after(() => ordinary.dispose())
  await h.turn(ordinary.agent)
  assert.equal(h.ctx.tools.get('apex_review', ordinary.agent), undefined)
  assert.doesNotMatch(systemText(h.requests.at(-1)), /apex_review|Treat review findings|You are APEX/)
})

test('conflicting review presentation fails before publication instead of retaining PTC', { skip: !harnessAvailable, timeout: 10000 }, async t => {
  const h = await fixture(t, () => textResponse('done'))
  const parent = await h.create('scope-parent')
  t.after(() => parent.dispose())
  // A conflicting child-local presentation must fail creation, not silently
  // retain PTC. The factory owns rollback of this unpublished child.
  await assert.rejects(h.ctx.agents.create({ sessionId: 'conflicting-review',
    agentOptions: { provider: 'fixture', model: 'fixture', apexReadOnlyReview: true },
    setup: ctx => { ctx.tools.presentAs('ptc') },
  }), /conflicts/)
  assert.equal(h.ctx.agents.get('conflicting-review'), undefined)
  assert.ok(h.ctx.tools.get('run_code', parent.agent))
  const old = await h.create('filter-only-control', ctx => { ctx.tools.restrict({ allow: ['read', 'read_image', 'glob', 'grep'] }) })
  t.after(() => old.dispose())
  assert.ok(h.ctx.tools.get('run_code', old.agent), 'positive control: the old toolFilter-only design still exposes PTC')
})

test('review creation listener belongs only to its preset scope and unwinds on unload', { skip: !harnessAvailable, timeout: 10000 }, async t => {
  const h = await fixture(t, () => textResponse('done'), false)
  const { createScope, bindScopeParent, scopeOf } = await native('dsh-scope')
  const presetKey = {}, preset = createScope(h.ctx, presetKey)
  t.after(() => preset.dispose())
  const plugin = await preset.ctx.plugin(review)
  for (const [id, joined, nativeExpected] of [['review', true, true], ['unrelated', false, false], ['unloaded', true, false]]) {
    if (id === 'unloaded') await plugin.dispose()
    const handle = await h.ctx.agents.create({ sessionId: id,
      agentOptions: { provider: 'fixture', model: 'fixture', apexReadOnlyReview: true },
      setup: ctx => { if (joined) bindScopeParent(scopeOf(ctx), presetKey) },
    })
    t.after(() => handle.dispose())
    const { agent } = handle
    assert.equal(h.ctx.tools.get('run_code', agent) === undefined, nativeExpected, id)
    if (nativeExpected) assert.deepEqual(h.ctx.tools.schemas(agent).map(t => t.name).sort(), ['glob', 'grep', 'read', 'read_image'])
  }
})
