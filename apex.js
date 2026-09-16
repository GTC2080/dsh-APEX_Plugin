import { chmod, constants, copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const name = 'apex-preset-installer'
export const inject = ['agentPresets', 'agentTeams']
export const PRESET_ID = 'apex-v1'
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyExists(error) {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'EEXIST'
}

function isMissingPath(error) {
  if (error === null || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'ENOENT' || code === 'ENOTDIR'
}

class UnsafeTreeEntryError extends Error {}

function assertSafeTarget(rootPath, presetId) {
  if (!isAbsolute(rootPath)) {
    throw new Error('dsh-apex: writable preset root must be absolute: ' + rootPath)
  }
  const root = resolve(rootPath)
  const target = resolve(root, presetId)
  if (dirname(target) !== root) {
    throw new Error('dsh-apex: resolved preset path escaped its writable root')
  }
  return { root, target }
}

/** Resolve the package-owned preset tree for one Node platform identifier. */
export function presetSourceFor(platform = process.platform, presetId = PRESET_ID) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error('dsh-apex: unsupported platform ' + JSON.stringify(platform))
  }
  if (presetId !== PRESET_ID) {
    throw new Error('dsh-apex: unknown bundled preset ' + JSON.stringify(presetId))
  }
  return fileURLToPath(new URL('./presets/apex-v1/', import.meta.url))
}

async function regularFiles(root, directory = root, directories = []) {
  if (directory === root) {
    const rootEntry = await lstat(root)
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new UnsafeTreeEntryError(
        'dsh-apex: preset tree root must be a real directory: ' + root,
      )
    }
  }
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      directories.push(relative(root, path))
      files.push(...await regularFiles(root, path, directories))
      continue
    }
    if (!entry.isFile()) {
      throw new UnsafeTreeEntryError(
        'dsh-apex: preset tree contains a non-regular entry: ' + path,
      )
    }
    files.push(relative(root, path))
  }
  return files
}

async function sameTree(source, target) {
  const sourceDirectories = [], targetDirectories = []
  const sourceFiles = await regularFiles(source, source, sourceDirectories)
  let targetFiles
  try {
    targetFiles = await regularFiles(target, target, targetDirectories)
  } catch (error) {
    if (isMissingPath(error) || error instanceof UnsafeTreeEntryError) return false
    throw error
  }
  if (JSON.stringify(sourceDirectories) !== JSON.stringify(targetDirectories)) return false
  if (sourceFiles.length !== targetFiles.length) return false
  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (sourceFiles[index] !== targetFiles[index]) return false
    const relativePath = sourceFiles[index]
    const [expected, actual] = await Promise.all([
      readFile(join(source, relativePath)),
      readFile(join(target, relativePath)),
    ])
    if (!expected.equals(actual)) return false
  }
  return true
}

async function copyTreeCreateOnly(source, target) {
  const directories = []
  const files = await regularFiles(source, source, directories)
  await mkdir(target, { mode: 0o700 })
  try {
    for (const directory of directories) await mkdir(join(target, directory), { mode: 0o700 })
    for (const relativePath of files) {
      const destination = join(target, relativePath)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(join(source, relativePath), destination, constants.COPYFILE_EXCL)
      await chmod(destination, 0o600)
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

async function validate(agentPresets, presetId) {
  await agentPresets.standingKeyFor(presetId)
}

/**
 * Install or verify the preset without overwriting an existing preset.
 *
 * The optional platform argument exists so the installer paths can be tested
 * on one host without pretending to execute another platform's shell.
 */
export async function installPreset(
  agentPresets,
  platform = process.platform,
  presetId = PRESET_ID,
) {
  const source = presetSourceFor(platform, presetId)
  const existing = (await agentPresets.list()).find((preset) => preset.id === presetId)
  if (existing !== undefined) {
    const existingDirectory = dirname(existing.path)
    if (!await sameTree(source, existingDirectory)) {
      throw new Error(
        'dsh-apex: preset "' + presetId + '" already exists with different content at '
        + existingDirectory + '; remove or rename it explicitly before installing this bundle',
      )
    }
    await validate(agentPresets, presetId)
    return { status: 'existing', path: existingDirectory }
  }

  const writable = agentPresets.roots.find((root) => root.trust === 'user')
  if (writable === undefined) {
    throw new Error('dsh-apex: this Harness profile has no writable user preset root')
  }
  const { root, target } = assertSafeTarget(writable.path, presetId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootEntry = await lstat(root)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('dsh-apex: writable root must be a real directory')

  let created = false
  try {
    await copyTreeCreateOnly(source, target)
    created = true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (!await sameTree(source, target)) {
      throw new Error(
        'dsh-apex: preset "' + presetId + '" appeared concurrently with different content at '
        + target,
      )
    }
  }

  try {
    await validate(agentPresets, presetId)
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true })
    throw new Error(
      'dsh-apex: installed preset "' + presetId
      + '" failed Harness mount validation: ' + errorMessage(error),
      { cause: error },
    )
  }
  return { status: created ? 'installed' : 'existing', path: target }
}

/** Create only APEX 1.0 and validate its real standing composition. */
export async function apply(ctx) {
  const fromHost = createRequire(new URL('package.json', ctx.baseUrl))
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const baseline = manifest.peerDependencies['@deepseek-ai/dsh-experimental-agent-team']
  for (const [dependency, version] of Object.entries({ '@deepseek-ai/dsh-agent-loop': baseline, ...manifest.peerDependencies })) {
    const installed = fromHost(`${dependency}/package.json`)
    if (installed.version !== version) throw new Error(`dsh-apex: ${dependency} must match Harness ${version}; found ${installed.version}`)
  }
  if (typeof ctx.agentTeams?.spawnTeammate !== 'function' || typeof ctx.agentTeams?.updateTask !== 'function') {
    throw new Error('dsh-apex: the native Agent Teams service is missing or incompatible')
  }
  const result = await installPreset(ctx.agentPresets)
  console.log('[dsh-apex] ' + result.status + ' and mount-validated preset "' + PRESET_ID + '"')
}
