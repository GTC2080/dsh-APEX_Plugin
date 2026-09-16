import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { harnessRoot, harnessAvailable, pluginRoot, nativeHarness } from './helpers/harness-v1.mjs'
import * as apex from '../apex.js'
import * as teams from '../presets/apex-v1/team.mjs'

test('public package names, exports and shipping roots are exclusively APEX 1.0', async () => {
  const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-apex'); assert.equal(pkg.version, '1.0.0')
  assert.equal(pkg.main, 'apex.js')
  assert.deepEqual(pkg.exports, { '.': './apex.js', './apex-v1/*': './presets/apex-v1/*.mjs' })
  assert.equal((await import('dsh-apex')).PRESET_ID, 'apex-v1')
  for (const module of ['team', 'validation', 'evidence', 'artifacts', 'tools', 'bash', 'script', 'cancellation', 'review',
    'temporary-runtime', 'temporary-sandbox', 'temporary-fs', 'temporary-context']) {
    assert.ok(await import(`dsh-apex/apex-v1/${module}`))
  }
  for (const module of ['dsh-apex/apex-v07/apex-state', 'dsh-apex/runtime', 'dsh-minimal-max']) {
    await assert.rejects(import(module), error => ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(error.code))
  }
  assert.ok(pkg.files.includes('presets/apex-v1'))
  assert.doesNotMatch(JSON.stringify(pkg.files), /apex-v07|runtime\.js|index\.js|test/)
  assert.ok(!pkg.scripts.postinstall && !pkg.scripts.prepare)
  assert.deepEqual(Object.keys(pkg.dependencies), ['zod'])
  const patch = await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/id: apex-preset-installer/g) ?? []).length, 1)
  assert.equal((patch.match(/id: agent-team\n/g) ?? []).length, 1)
  assert.equal((patch.match(/id: ui-agent-team\n/g) ?? []).length, 1)
  assert.doesNotMatch(patch, /dsh-minimal-max|tool-agent-team/)
  const preset = await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8')
  assert.equal((preset.match(/mode: ptc/g) ?? []).length, 1)
  assert.match(preset, /dsh-tool-bash[\s\S]*process.platform === 'win32'/)
  assert.match(preset, /dsh-tool-pwsh[\s\S]*process.platform !== 'win32'/)
  assert.doesNotMatch(preset, /skill-filesystem|tool-skill|workflow|apex_tools|deepseek-pro|apex-v07/)
  assert.match(preset, /name: dsh-apex\/apex-v1\/review/)
  const review = await readFile(join(pluginRoot, 'presets/apex-v1/review.mjs'), 'utf8')
  assert.match(review, /\['read', 'read_image', 'glob', 'grep'\]/)
  assert.match(review, /presentAs\('native'\)/)
  assert.deepEqual(apex.inject, ['agentPresets', 'agentTeams'])
})

test('official patch composition replaces native providers and accepts a later rollback override', { skip: !harnessAvailable }, async () => {
  const require = createRequire(join(harnessRoot, 'vendor/include/package.json'))
  const { load } = require('js-yaml')
  const { applyEntryPatches, entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')))
  const warnings = []
  const warn = (...args) => warnings.push(args)
  let entries = []
  for (const file of [join(harnessRoot, 'packages/bundle/base/cordis.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/cordis.patch.yml'), join(pluginRoot, 'cordis.patch.yml')]) {
    entries = applyEntryPatches(entries, load(await readFile(file, 'utf8'), { schema: entryListSchema }), warn)
  }
  const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  const rows = flatten(entries)
  for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) assert.equal(rows.find(row => row.id === id).disabled, true)
  for (const id of ['runtime', 'sandbox', 'fs']) {
    const selected = rows.filter(row => row.id === 'apex-temporary-' + id && row.disabled !== true)
    assert.equal(selected.length, 1)
    assert.equal(selected[0].name, 'dsh-apex/apex-v1/temporary-' + id)
  }
  const rollback = applyEntryPatches(entries, [{ id: 'apex-temporary-runtime', config: { privateTemp: false } }], warn)
  assert.equal(flatten(rollback).find(row => row.id === 'apex-temporary-runtime').config.privateTemp, false)
  assert.deepEqual(warnings, [])
})

test('copied native Team contracts stay pinned with only the documented wait-window extension', { skip: !harnessAvailable }, async () => {
  for (const [file, expected] of [
    ['packages/preset/agent-presets/presets/ptc/agent.cordis.yml', 'e7613a9c29feee587c2d479c82b4039da51d8de6b31680dcc24b7fc3d4cc9d20'],
    ['packages/experimental/tool-agent-team/src/index.ts', '1ab4aa1d9eb669ad361f9a6483e0ff06c424252f00fde769116097c3fdd303d0'],
  ]) assert.equal(createHash('sha256').update(await readFile(join(harnessRoot, file))).digest('hex'), expected, file)
  const official = await import(pathToFileURL(join(harnessRoot, 'packages/experimental/tool-agent-team/lib/index.js')))
  function capture() {
    const definitions = [], effects = []
    const ctx = { tools: { register(def) { definitions.push(def); return () => {} } },
      systemPrompt: { section() { return () => {} }, getSectionOrder() { return 0 } },
      agentTeams: { tryMembership() { return { role: 'lead', name: 'lead', id: 'team' } } },
      on() {}, effect(dispose) { effects.push(dispose()) },
    }
    ctx.agents = { list: () => [{ ctx }] }
    return { ctx, definitions, effects }
  }
  const original = capture(), current = capture()
  official.apply(original.ctx); teams.apply(current.ctx)
  assert.equal(current.definitions.length, 9)
  for (const definition of original.definitions) {
    const replacement = current.definitions.find(d => d.name === definition.name)
    assert.ok(replacement, definition.name)
    if (definition.name === 'wait_agent') {
      assert.match(replacement.parameters.properties.timeout_ms.description, /10000 through 3600000.*60000.*not a task deadline/)
      assert.match(replacement.description, /standalone PTC.*Do not loop or batch waits/)
      const parameters = structuredClone(replacement.parameters)
      parameters.properties.timeout_ms.description = definition.parameters.properties.timeout_ms.description
      assert.deepEqual(parameters, definition.parameters, 'the accepted native input fields and types are unchanged')
      const output = structuredClone(replacement.output.schema)
      assert.deepEqual(output.properties.waitWindow.required, ['requestedTimeoutMs', 'effectiveTimeoutMs'])
      assert.deepEqual(output.properties.waitWindow.properties, {
        requestedTimeoutMs: { type: 'integer' }, effectiveTimeoutMs: { type: 'integer' },
      })
      delete output.properties.waitWindow
      assert.deepEqual(output, definition.output.schema, 'all existing native wait result fields retain their schemas')
      continue
    }
    assert.deepEqual(replacement.parameters, definition.parameters, definition.name)
    assert.deepEqual(replacement.output.schema, definition.output.schema, definition.name)
  }
  for (const dispose of [...original.effects, ...current.effects]) dispose()
})

test('Host installer validates active dependency versions before create-only mounting', { skip: !harnessAvailable }, async t => {
  const h = await nativeHarness(undefined, { emptyRoster: true }); t.after(h.close)
  await apex.apply(h.ctx)
  await apex.apply(h.ctx)
  const missing = Object.create(h.ctx)
  Object.defineProperty(missing, 'agentTeams', { value: {} })
  await assert.rejects(apex.apply(missing), /Teams service is missing or incompatible/)
  const bad = join(h.root, 'incompatible-profile')
  await mkdir(join(bad, 'node_modules/@deepseek-ai/dsh-agent-loop'), { recursive: true })
  await writeFile(join(bad, 'node_modules/@deepseek-ai/dsh-agent-loop/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-loop', version: '0.1.4' }))
  await assert.rejects(apex.apply({ baseUrl: pathToFileURL(bad).href + '/' }), /must match Harness 0.1.6-alpha.1; found 0.1.4/)
})
