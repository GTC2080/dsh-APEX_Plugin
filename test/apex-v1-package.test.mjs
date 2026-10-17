import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pluginRoot } from './helpers/harness-v1.mjs'
import { sliceText } from '../presets/apex-v1/text.mjs'

test('text budgets retain complete Unicode characters at either end', () => {
  const source = 'a😀b'
  assert.deepEqual([0, 1, 2, 3, 4].map(n => sliceText(source, 0, n)), ['', 'a', 'a', 'a😀', source])
  assert.deepEqual([1, 2, 3, 4].map(n => sliceText(source, -n)), ['b', 'b', '😀b', source])
  assert.equal(sliceText(source, 1, 3), '😀')
  assert.equal(sliceText(source, 2, 3), '')
  assert.equal(sliceText('中文', 0, 1), '中')
})

test('public package exports and shipping roots remain APEX 1.0 only', async () => {
  const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-apex')
  assert.equal(pkg.version, '1.0.1')
  const preset = await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8')
  assert.equal(preset.match(/^        name: (.+)$/m)?.[1], `APEX ${pkg.version}`)
  assert.equal(pkg.main, 'apex.js')
  assert.deepEqual(pkg.exports, { '.': './apex.js', './apex-v1/*': './presets/apex-v1/*.mjs' })
  const apex = await import('../apex.js')
  assert.equal(apex.PRESET_ID, 'apex-v1')
  assert.deepEqual(apex.BUNDLE_PATCH, ['./cordis.patch.yml', './presets/apex-v1/agent.cordis.yml'])
  for (const module of ['team', 'validation', 'evidence', 'artifacts', 'tools', 'bash', 'script', 'cancellation', 'review',
    'temporary-runtime', 'temporary-sandbox', 'temporary-fs', 'temporary-context', 'ptc-runtime', 'ptc-binding', 'file-tools', 'search', 'search-core', 'feedback', 'evidence-flow']) {
    assert.ok(await import(`dsh-apex/apex-v1/${module}`))
  }
  for (const module of ['dsh-apex/apex-v07/apex-state', 'dsh-apex/runtime', 'dsh-minimal-max']) {
    await assert.rejects(import(module), error => ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(error.code))
  }
  assert.ok(pkg.files.includes('presets/apex-v1'))
  assert.doesNotMatch(JSON.stringify(pkg.files), /apex-v07|runtime\.js|index\.js|test/)
  assert.deepEqual(Object.keys(pkg.dependencies), ['zod'])
  assert.equal(pkg.scripts.postinstall, undefined)
  assert.equal(pkg.scripts.prepare, undefined)
})

test('cordis patch keeps host execution services and native team rows', async () => {
  const patch = await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /apex-preset-installer/)
  assert.equal((patch.match(/id: agent-team\n/g) ?? []).length, 1)
  assert.equal((patch.match(/id: ui-agent-team\n/g) ?? []).length, 1)
  assert.doesNotMatch(patch, /dsh-minimal-max|tool-agent-team/)
  const preset = await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8')
  assert.match(preset, /- insert:\n\s+- id: preset-apex-v1/)
  assert.match(preset, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.equal((preset.match(/mode: ptc/g) ?? []).length, 1)
  assert.match(preset, /dsh-tool-bash[\s\S]*process\.platform === 'win32'/)
  assert.match(preset, /dsh-tool-pwsh[\s\S]*process\.platform !== 'win32'/)
  assert.doesNotMatch(preset, /skill-filesystem|tool-skill|workflow|apex_tools|deepseek-pro|apex-v07/)
  assert.match(preset, /name: dsh-apex\/apex-v1\/review/)
  const review = await readFile(join(pluginRoot, 'presets/apex-v1/review.mjs'), 'utf8')
  assert.match(review, /\['read', 'read_image', 'glob', 'grep'\]/)
  assert.match(review, /presentAs\('native'\)/)
})
