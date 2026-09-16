import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installPreset, PRESET_ID, presetSourceFor } from '../apex.js'

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'apex-v1-installer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function roster(root, validate = async () => {}) {
  return { roots: [{ path: root, trust: 'user' }], list: async () => [], standingKeyFor: validate }
}

test('create-only installation is identical, private, mount-validated and idempotent', async t => {
  const root = await temporary(t), validated = []
  const api = roster(root, async id => { validated.push(id) })
  await mkdir(join(root, 'apex-v07'))
  await writeFile(join(root, 'apex-v07', 'original'), 'keep')
  assert.equal((await installPreset(api)).status, 'installed')
  assert.equal((await installPreset(api)).status, 'existing')
  assert.deepEqual(validated, [PRESET_ID, PRESET_ID])
  assert.deepEqual(await readFile(join(root, PRESET_ID, 'agent.cordis.yml')), await readFile(join(presetSourceFor(), 'agent.cordis.yml')))
  assert.equal(await readFile(join(root, 'apex-v07', 'original'), 'utf8'), 'keep')
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, PRESET_ID))).mode & 0o777, 0o700)
    assert.equal((await stat(join(root, PRESET_ID, 'preset.yml'))).mode & 0o777, 0o600)
  }
})

test('divergent content, including an extra symlink, is never overwritten', async t => {
  const root = await temporary(t), api = roster(root)
  await installPreset(api)
  await writeFile(join(root, PRESET_ID, 'preset.yml'), 'user content')
  await assert.rejects(installPreset(api), /different content/)
  assert.equal(await readFile(join(root, PRESET_ID, 'preset.yml'), 'utf8'), 'user content')
  await symlink(join(root, PRESET_ID, 'preset.yml'), join(root, PRESET_ID, 'unsafe'))
  await assert.rejects(installPreset(api), /different content/)
})

test('failed validation removes only a newly created preset, never an existing one', async t => {
  const root = await temporary(t)
  const failed = roster(root, async () => { throw new Error('mount rejected') })
  await assert.rejects(installPreset(failed), /mount rejected/)
  await assert.rejects(access(join(root, PRESET_ID)), { code: 'ENOENT' })
  await installPreset(roster(root))
  await assert.rejects(installPreset(failed), /mount rejected/)
  await access(join(root, PRESET_ID, 'preset.yml'))
})

test('an extra empty directory is divergent, not an identical installation', async t => {
  const root = await temporary(t), api = roster(root)
  await installPreset(api)
  await mkdir(join(root, PRESET_ID, 'user-directory'))
  await assert.rejects(installPreset(api), /different content/)
  assert.ok((await stat(join(root, PRESET_ID, 'user-directory'))).isDirectory())
})

test('rejects relative roots, root symlinks, target symlinks and unsupported platforms', async t => {
  const root = await temporary(t), real = join(root, 'real')
  await mkdir(real)
  await symlink(real, join(root, 'alias'), 'dir')
  await assert.rejects(installPreset(roster('relative')), /absolute/)
  await assert.rejects(installPreset(roster(join(root, 'alias'))), /real directory/)
  await symlink(real, join(root, PRESET_ID), 'dir')
  await assert.rejects(installPreset(roster(root)), /different content/)
  for (const platform of ['darwin', 'linux', 'win32']) assert.match(presetSourceFor(platform), /apex-v1/)
  assert.throws(() => presetSourceFor('freebsd'), /unsupported platform/)
  assert.throws(() => presetSourceFor('darwin', 'apex-v07'), /unknown bundled preset/)
})

test('concurrently appeared identical tree is accepted without deletion', async t => {
  const root = await temporary(t), api = roster(root)
  api.list = async () => { await cp(presetSourceFor(), join(root, PRESET_ID), { recursive: true }); return [] }
  assert.equal((await installPreset(api)).status, 'existing')
})
