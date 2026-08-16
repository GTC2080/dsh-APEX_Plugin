import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  APEX_PRESET_ID,
  installPresets,
  installPreset,
  PRESET_ID,
  PRESET_IDS,
  presetSourceFor,
} from '../index.js'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') {
      return false
    }
    throw error
  }
}

function fakeRoster(root, options = {}) {
  const validations = []
  return {
    roots: [{ path: root, trust: 'user' }],
    async list() {
      const presets = []
      for (const id of PRESET_IDS) {
        const composition = join(root, id, 'agent.cordis.yml')
        if (await exists(composition)) presets.push({ id, path: composition, trust: 'user' })
      }
      return presets
    },
    async standingKeyFor(id) {
      assert.equal(PRESET_IDS.includes(id), true)
      validations.push(id)
      if (options.validationError !== undefined
        && (options.validationPresetId === undefined || options.validationPresetId === id)) {
        throw options.validationError
      }
    },
    validations() {
      return [...validations]
    },
  }
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-minimal-max-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('installs the v0.2 preset once and mount-validates it', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root)
  const result = await installPreset(roster, 'linux')
  const target = join(root, PRESET_ID)

  assert.deepEqual(result, { status: 'installed', path: target })
  assert.deepEqual(roster.validations(), [PRESET_ID])
  assert.equal(
    await readFile(join(target, 'agent.cordis.yml'), 'utf8'),
    await readFile(join(presetSourceFor('linux'), 'agent.cordis.yml'), 'utf8'),
  )
  assert.equal(
    await readFile(join(target, 'preset.yml'), 'utf8'),
    await readFile(join(presetSourceFor('linux'), 'preset.yml'), 'utf8'),
  )
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o700)
    assert.equal((await stat(join(target, 'agent.cordis.yml'))).mode & 0o777, 0o600)
  }
})

test('is idempotent when the installed tree is unchanged', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root)

  await installPreset(roster, 'darwin')
  const result = await installPreset(roster, 'darwin')

  assert.equal(result.status, 'existing')
  assert.deepEqual(roster.validations(), [PRESET_ID, PRESET_ID])
})

test('installs the cross-platform v0.2 runtime modules with its composition', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root)

  await installPreset(roster, 'win32')

  assert.equal(await exists(join(root, PRESET_ID, 'windows-bash.mjs')), true)
  assert.equal(await exists(join(root, PRESET_ID, 'tool-gate.mjs')), true)
  assert.equal(await exists(join(root, PRESET_ID, 'dev-tool-search.mjs')), true)
  assert.match(
    await readFile(join(root, PRESET_ID, 'agent.cordis.yml'), 'utf8'),
    /name: \.\/windows-bash\.mjs/,
  )
  assert.deepEqual(roster.validations(), [PRESET_ID])
})

test('refuses to overwrite a divergent preset', async (t) => {
  const root = await temporaryRoot(t)
  const target = join(root, PRESET_ID)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), 'user-owned content\n')
  const roster = fakeRoster(root)

  await assert.rejects(
    installPreset(roster, 'linux'),
    /already exists with different content/,
  )
  assert.equal(await readFile(join(target, 'agent.cordis.yml'), 'utf8'), 'user-owned content\n')
  assert.deepEqual(roster.validations(), [])
})

test('refuses a symlink occupying the preset slot', async (t) => {
  const root = await temporaryRoot(t)
  const outside = await temporaryRoot(t)
  await writeFile(join(outside, 'agent.cordis.yml'), 'external content\n')
  await writeFile(join(outside, 'preset.yml'), 'name: External\n')
  await symlink(outside, join(root, PRESET_ID), 'dir')
  const roster = fakeRoster(root)

  await assert.rejects(
    installPreset(roster, 'linux'),
    /already exists with different content/,
  )
  assert.equal(await readFile(join(outside, 'agent.cordis.yml'), 'utf8'), 'external content\n')
})

test('rolls back a newly copied preset when real mount validation fails', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root, { validationError: new Error('mount rejected') })

  await assert.rejects(
    installPreset(roster, 'linux'),
    /failed Harness mount validation: mount rejected/,
  )
  assert.equal(await exists(join(root, PRESET_ID)), false)
})

test('installs APEX v0.3 without changing the v0.2 control preset', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root)

  await installPreset(roster, 'linux')
  const before = await readFile(join(root, PRESET_ID, 'agent.cordis.yml'), 'utf8')
  const result = await installPreset(roster, 'linux', APEX_PRESET_ID)

  assert.deepEqual(result, { status: 'installed', path: join(root, APEX_PRESET_ID) })
  assert.equal(await readFile(join(root, PRESET_ID, 'agent.cordis.yml'), 'utf8'), before)
  assert.match(
    await readFile(join(root, APEX_PRESET_ID, 'agent.cordis.yml'), 'utf8'),
    /name: \.\/apex-policy\.mjs/,
  )
  assert.equal(await exists(join(root, APEX_PRESET_ID, 'windows-bash.mjs')), true)
})

test('bundle installation validates both versioned presets in order', async (t) => {
  const root = await temporaryRoot(t)
  const roster = fakeRoster(root)
  const results = await installPresets(roster, 'darwin')

  assert.deepEqual(results.map(({ presetId, status }) => ({ presetId, status })), [
    { presetId: PRESET_ID, status: 'installed' },
    { presetId: APEX_PRESET_ID, status: 'installed' },
  ])
  assert.deepEqual(roster.validations(), [PRESET_ID, APEX_PRESET_ID])
})

test('APEX validation failure rolls back APEX but preserves v0.2', async (t) => {
  const root = await temporaryRoot(t)
  await installPreset(fakeRoster(root), 'linux')
  const roster = fakeRoster(root, {
    validationError: new Error('apex mount rejected'),
    validationPresetId: APEX_PRESET_ID,
  })

  await assert.rejects(
    installPresets(roster, 'linux'),
    /failed Harness mount validation: apex mount rejected/,
  )
  assert.equal(await exists(join(root, PRESET_ID)), true)
  assert.equal(await exists(join(root, APEX_PRESET_ID)), false)
})

test('uses one conditionally composed v0.2 tree on every supported platform', () => {
  assert.match(presetSourceFor('darwin'), /presets[/\\]v2[/\\]?$/)
  assert.match(presetSourceFor('linux'), /presets[/\\]v2[/\\]?$/)
  assert.match(presetSourceFor('win32'), /presets[/\\]v2[/\\]?$/)
  assert.throws(() => presetSourceFor('freebsd'), /unsupported platform/)
})

test('resolves the self-contained APEX tree and rejects unknown bundled ids', () => {
  assert.match(presetSourceFor('darwin', APEX_PRESET_ID), /presets[/\\]apex-v03[/\\]?$/)
  assert.match(presetSourceFor('linux', APEX_PRESET_ID), /presets[/\\]apex-v03[/\\]?$/)
  assert.match(presetSourceFor('win32', APEX_PRESET_ID), /presets[/\\]apex-v03[/\\]?$/)
  assert.throws(() => presetSourceFor('linux', 'unknown'), /unknown bundled preset/)
})

test('rejects a relative writable root before creating a target', async () => {
  const roster = {
    roots: [{ path: 'relative-root', trust: 'user' }],
    list: async () => [],
    standingKeyFor: async () => {},
  }
  await assert.rejects(installPreset(roster, 'linux'), /must be absolute/)
})
