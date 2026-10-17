import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { harnessAvailable, harnessRoot, native, pluginRoot } from './helpers/harness-v1.mjs'
import { BUNDLE_PATCH, PRESET_ID } from '../apex.js'

async function loadYaml(file) {
  const require = createRequire(join(harnessRoot, 'vendor/include/package.json'))
  const { load } = require('js-yaml')
  const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')))
  return load(await readFile(file, 'utf8'), { schema: entryListSchema })
}

function flatten(rows) {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
}

test('APEX uses an ordered declarative bundle patch instead of a directory installer', async () => {
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.bundle.patch, BUNDLE_PATCH)
  assert.deepEqual(manifest.dsh.bundle.patch, [
    './cordis.patch.yml',
    './presets/apex-v1/agent.cordis.yml',
  ])
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-agent-preset'], '0.2.0-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-agent-preset-registry'], '0.2.0-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-experimental-agent-team'], '0.2.0-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-experimental-client-ui-agent-team'], '0.2.0-rc.2')
  assert.equal(PRESET_ID, 'apex-v1')
  assert.equal((await import('../apex.js')).installPreset, undefined)
  assert.equal((await import('../apex.js')).apply, undefined)
})

test('APEX declaration keeps its scoped execution realm and display metadata', async () => {
  const [patch, preset] = await Promise.all([
    loadYaml(join(pluginRoot, 'cordis.patch.yml')),
    loadYaml(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml')),
  ])
  assert.equal(patch.find(row => row.id === 'apex-preset-installer'), undefined)
  assert.equal(preset.length, 1)
  assert.equal(preset[0].insert.length, 1)
  const declaration = preset[0].insert[0]
  assert.equal(declaration.id, 'preset-apex-v1')
  assert.equal(declaration.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(declaration.config.id, PRESET_ID)
  assert.equal(declaration.config.name, 'APEX 1.0')
  assert.equal(declaration.config.order, 10)
  assert.ok(declaration.config.description)
  const session = declaration.config.plugins.find(row => row.id === 'apex-session')
  assert.deepEqual(session.isolate, {
    subprocess: 'dsh-apex',
    sandbox: 'dsh-apex',
    fs: 'dsh-apex',
    apexTemporaryDirectories: 'dsh-apex',
  })
  assert.equal(session.group, true)
  assert.ok(session.config.some(row => row.id === 'apex-validation'))
})

test('native compatibility admission accepts current APEX peers and rejects the previous baseline without exemptions', { skip: !harnessAvailable }, async () => {
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await native('dsh-app-boot')
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(getDshRuntimeVersion(), '0.2.0-rc.2')
  assert.equal(evaluatePluginCompatibility(manifest), undefined)
  const previous = { ...manifest, peerDependencies: Object.fromEntries(
    Object.keys(manifest.peerDependencies).map(name => [name, '0.2.0-rc.1'])) }
  const rejected = evaluatePluginCompatibility(previous)
  assert.equal(rejected.exempted, false)
  assert.deepEqual(rejected.peers, previous.peerDependencies)
})

test('APEX and official preset declarations compose without changing native mode rows', { skip: !harnessAvailable }, async () => {
  const require = createRequire(join(harnessRoot, 'vendor/include/package.json'))
  const { applyEntryPatches, entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')))
  const warn = message => { throw new Error(message) }
  let entries = []
  for (const file of [
    join(harnessRoot, 'packages/bundle/base/cordis.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/cordis.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/presets/standard.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/presets/ptc.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/presets/minimal.patch.yml'),
    join(harnessRoot, 'packages/bundle/web-app/presets/cordis.patch.yml'),
    join(pluginRoot, 'cordis.patch.yml'),
    join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'),
  ]) {
    entries = applyEntryPatches(entries, await loadYaml(file), warn)
  }
  const rows = flatten(entries)
  for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis', 'preset-apex-v1']) {
    assert.ok(rows.find(row => row.id === id), id)
  }
  assert.equal(rows.find(row => row.id === 'preset-apex-v1').config.id, PRESET_ID)
  for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) {
    assert.notEqual(rows.find(row => row.id === id)?.disabled, true, id)
  }
  assert.equal(rows.find(row => row.id === 'apex-preset-installer'), undefined)
  assert.equal(rows.find(row => row.id === 'agent-team').name, '@deepseek-ai/dsh-experimental-agent-team')
})
