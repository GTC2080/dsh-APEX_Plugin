/**
 * Host-side installer for the platform-specific Minimal Max agent preset.
 *
 * The plugin is intentionally model-invisible: it registers no tools and no
 * prompt sections. It creates the preset once in the roster's writable user
 * root, refuses divergent existing content, then asks Harness to mount-validate
 * the installed composition through the same path used by a real session.
 */

import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'minimal-max-preset-installer'
export const inject = ['agentPresets']

export const PRESET_ID = 'minimal-max-v2'

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

function assertSafeTarget(rootPath) {
  if (!isAbsolute(rootPath)) {
    throw new Error('dsh-minimal-max: writable preset root must be absolute: ' + rootPath)
  }
  const root = resolve(rootPath)
  const target = resolve(root, PRESET_ID)
  if (dirname(target) !== root) {
    throw new Error('dsh-minimal-max: resolved preset path escaped its writable root')
  }
  return { root, target }
}

/** Resolve the package-owned preset tree for one Node platform identifier. */
export function presetSourceFor(platform = process.platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error('dsh-minimal-max: unsupported platform ' + JSON.stringify(platform))
  }
  return fileURLToPath(new URL('./presets/v2/', import.meta.url))
}

async function regularFiles(root, directory = root) {
  if (directory === root) {
    const rootEntry = await lstat(root)
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new UnsafeTreeEntryError(
        'dsh-minimal-max: preset tree root must be a real directory: ' + root,
      )
    }
  }
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await regularFiles(root, path))
      continue
    }
    if (!entry.isFile()) {
      throw new UnsafeTreeEntryError(
        'dsh-minimal-max: preset tree contains a non-regular entry: ' + path,
      )
    }
    files.push(relative(root, path))
  }
  return files
}

async function sameTree(source, target) {
  const sourceFiles = await regularFiles(source)
  let targetFiles
  try {
    targetFiles = await regularFiles(target)
  } catch (error) {
    if (isMissingPath(error) || error instanceof UnsafeTreeEntryError) return false
    throw error
  }
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
  const files = await regularFiles(source)
  await mkdir(target, { mode: 0o700 })
  try {
    for (const relativePath of files) {
      const destination = join(target, relativePath)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(join(source, relativePath), destination)
      await chmod(destination, 0o600)
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

async function validate(agentPresets) {
  await agentPresets.standingKeyFor(PRESET_ID)
}

/**
 * Install or verify the preset without overwriting an existing preset.
 *
 * The optional platform argument exists so the installer paths can be tested
 * on one host without pretending to execute another platform's shell.
 */
export async function installPreset(agentPresets, platform = process.platform) {
  const source = presetSourceFor(platform)
  const existing = (await agentPresets.list()).find((preset) => preset.id === PRESET_ID)
  if (existing !== undefined) {
    const existingDirectory = dirname(existing.path)
    if (!await sameTree(source, existingDirectory)) {
      throw new Error(
        'dsh-minimal-max: preset "' + PRESET_ID + '" already exists with different content at '
        + existingDirectory + '; remove or rename it explicitly before installing this bundle',
      )
    }
    await validate(agentPresets)
    return { status: 'existing', path: existingDirectory }
  }

  const writable = agentPresets.roots.find((root) => root.trust === 'user')
  if (writable === undefined) {
    throw new Error('dsh-minimal-max: this Harness profile has no writable user preset root')
  }
  const { root, target } = assertSafeTarget(writable.path)
  await mkdir(root, { recursive: true, mode: 0o700 })

  let created = false
  try {
    await copyTreeCreateOnly(source, target)
    created = true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (!await sameTree(source, target)) {
      throw new Error(
        'dsh-minimal-max: preset "' + PRESET_ID + '" appeared concurrently with different content at '
        + target,
      )
    }
  }

  try {
    await validate(agentPresets)
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true })
    throw new Error(
      'dsh-minimal-max: installed preset failed Harness mount validation: ' + errorMessage(error),
      { cause: error },
    )
  }
  return { status: created ? 'installed' : 'existing', path: target }
}

/** Materialize and mount-validate the preset when the bundle starts. */
export async function apply(ctx) {
  const result = await installPreset(ctx.agentPresets)
  console.log(
    '[dsh-minimal-max] ' + result.status
    + ' and mount-validated preset "' + PRESET_ID + '"',
  )
}
