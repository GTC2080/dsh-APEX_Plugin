/** Bounded artifact and screenshot identity, independent of task or agent orchestration. */
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const IGNORED = new Set(['.git', '.cache', 'coverage', 'node_modules'])
const MAX_FILES = 8192
const MAX_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 16384

export function inside(root, path) {
  const value = relative(root, path)
  return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
}

/** Resolve a real static build directory; never serve a symlink escaping the workspace. */
export async function artifactRoot(agent, value) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('APEX requires an absolute session working directory')
  const workspace = await fs.realpath(cwd)
  const lexical = resolve(cwd, value)
  if (!inside(resolve(cwd), lexical)) throw new Error('root must be inside the session workspace')
  const path = await fs.realpath(lexical)
  if (!inside(workspace, path)) throw new Error('root escapes the workspace through a symlink')
  if (!(await fs.stat(path)).isDirectory()) throw new Error('root must be a static build directory')
  return path
}

async function hashFile(hash, path, expected, signal) {
  if (expected.size > MAX_BYTES) throw new Error('artifact file exceeds the 256 MiB hashing limit')
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const same = actual => actual.isFile()
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => actual[key] === expected[key])
  try {
    if (!same(await file.stat())) throw new Error('artifact changed before hashing')
    let bytes = 0
    for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
      bytes += chunk.length
      if (bytes > expected.size) throw new Error('artifact grew during hashing')
      hash.update(chunk)
    }
    if (bytes !== expected.size || !same(await file.stat()) || !same(await fs.lstat(path))) {
      throw new Error('artifact changed while its hash was being computed')
    }
  } finally {
    await file.close()
  }
}

/** Hash a static build tree without caches or generated dependency trees. */
export async function artifactSnapshot(agent, value, signal) {
  const root = await artifactRoot(agent, value)
  const files = []
  const directories = []
  let totalBytes = 0
  let entryCount = 0
  // ponytail: bounded sequential hashing needs no second state store; optimize only after profiling.
  async function walk(directory) {
    signal?.throwIfAborted()
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Artifact directory changed or contains a symlink')
    directories.push({ path: directory, info })
    const entries = []
    for await (const entry of await fs.opendir(directory)) {
      signal?.throwIfAborted()
      if (++entryCount > MAX_ENTRIES) throw new Error('Validate a bounded build directory: limit 16384 entries')
      entries.push(entry)
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue
      const info = await fs.lstat(path)
      if (info.isDirectory()) { await walk(path); continue }
      if (!info.isFile()) throw new Error(`Unsupported non-regular artifact entry: ${relative(root, path)}`)
      totalBytes += info.size
      if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) throw new Error('Validate a bounded build directory: limit 8192 files / 256 MiB')
      files.push({ path, info })
    }
  }
  await walk(root)
  const hash = createHash('sha256')
  for (const { path, info } of files) {
    signal?.throwIfAborted()
    hash.update(`F\0${relative(root, path).split(sep).join('/')}\0${info.size}\0`)
    await hashFile(hash, path, info, signal)
    hash.update('\0')
  }
  for (const { path, info } of directories) {
    signal?.throwIfAborted()
    const current = await fs.lstat(path)
    if (!current.isDirectory() || ['dev', 'ino', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== info[key])) {
      throw new Error('artifact directory changed during hashing')
    }
  }
  return { root, hash: hash.digest('hex'), fileCount: files.length, totalBytes, excludedDirectories: [...IGNORED] }
}

/** Inspect a recorded screenshot without changing it. */
export async function screenshotIdentity(path, signal) {
  const info = await fs.lstat(path)
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Screenshot must be a regular file of at most 64 MiB')
  const hash = createHash('sha256')
  await hashFile(hash, path, info, signal)
  return { path, hash: hash.digest('hex'), size: info.size }
}
