/** Produce bounded, deterministic hashes for workspace artifacts and images. */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'

import { workspacePath } from './workspace-boundary.mjs'

const IGNORED_ARTIFACT_DIRECTORIES = new Set([
  '.git',
  '.cache',
  'coverage',
  'node_modules',
])
export const HOST_EVIDENCE_DIRECTORY = '.apex-evidence'
const HOST_EVIDENCE_ROOT = 'dsh-apex-v063-evidence'
const MAX_EVIDENCE_PATH_CHARS = 512
const MAX_ARTIFACT_FILES = 8_192
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

function portablePath(value) {
  return value.split(sep).join('/')
}

function inside(root, target) {
  const value = relative(root, target)
  return value.length === 0 || (value !== '..' && !value.startsWith(`..${sep}`))
}

function normalizedHostEvidencePath(value) {
  if (typeof value !== 'string') return undefined
  const portable = value.trim().replaceAll('\\', '/')
  if (portable.length === 0
    || portable.length > MAX_EVIDENCE_PATH_CHARS
    || portable.includes('\0')) return undefined
  const normalized = posix.normalize(portable)
  const prefix = `${HOST_EVIDENCE_DIRECTORY}/`
  if (normalized !== portable || !normalized.startsWith(prefix)) return undefined
  const suffix = normalized.slice(prefix.length)
  return suffix.length > 0 && !suffix.split('/').includes('..') ? suffix : undefined
}

/** Resolve the reserved logical evidence namespace into host-owned temp storage. */
export function hostEvidencePath(agent, value) {
  const suffix = normalizedHostEvidencePath(value)
  if (suffix === undefined) return undefined
  const header = agent?.session?.header
  const sessionId = typeof header?.id === 'string' ? header.id : ''
  const cwd = typeof header?.cwd === 'string' ? resolve(header.cwd) : ''
  const sessionKey = createHash('sha256')
    .update(`${sessionId}\0${cwd}`)
    .digest('hex')
    .slice(0, 32)
  return join(tmpdir(), HOST_EVIDENCE_ROOT, sessionKey, ...suffix.split('/'))
}

async function updateFromFile(hash, path, expected) {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const current = await fs.stat(path)
  if (current.size !== expected.size
    || current.mtimeMs !== expected.mtimeMs
    || current.dev !== expected.dev
    || current.ino !== expected.ino) {
    throw new Error('evidence file changed while its content hash was being computed')
  }
}

/** Hash one bounded static artifact tree while excluding exact generated evidence files. */
export async function artifactSnapshot(agent, rootValue, excludedWorkspacePaths = []) {
  const rootPath = workspacePath(agent, rootValue)
  if (rootPath === undefined) {
    throw new Error('root must resolve inside the current session workspace')
  }
  const rootInfo = await fs.stat(rootPath)
  if (!rootInfo.isDirectory()) {
    throw new Error('root must name a directory containing the built static artifact')
  }

  const excluded = new Set()
  for (const value of excludedWorkspacePaths) {
    const path = workspacePath(agent, value)
    if (path !== undefined && inside(rootPath, path)) excluded.add(resolve(path))
  }

  const files = []
  // ponytail: a bounded sequential walk avoids a cache or second state store;
  // add incremental hashing only if measured artifact size makes this material.
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && IGNORED_ARTIFACT_DIRECTORIES.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (excluded.has(path)) continue
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`artifact tree contains unsupported non-regular entry: ${portablePath(relative(rootPath, path))}`)
      }
      const info = await fs.stat(path)
      files.push({
        path,
        relativePath: portablePath(relative(rootPath, path)),
        size: info.size,
        mtimeMs: info.mtimeMs,
        dev: info.dev,
        ino: info.ino,
      })
      if (files.length > MAX_ARTIFACT_FILES) {
        throw new Error(`artifact tree exceeds ${MAX_ARTIFACT_FILES} files; validate a bounded build directory`)
      }
    }
  }
  await walk(rootPath)

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact tree exceeds ${MAX_ARTIFACT_BYTES} bytes; validate a bounded build directory`)
  }
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`F\0${file.relativePath}\0${file.size}\0`)
    await updateFromFile(hash, file.path, file)
    hash.update('\0')
  }
  const cwd = agent?.session?.header?.cwd
  return {
    hash: hash.digest('hex'),
    root: typeof cwd === 'string' ? portablePath(relative(cwd, rootPath)) || '.' : '.',
    files: files.map(file => ({ path: file.relativePath, size: file.size })),
    fileCount: files.length,
    totalBytes,
  }
}

/** Hash bounded workspace images or immutable host evidence without re-encoding. */
export async function imageSnapshots(agent, imagePaths) {
  const snapshots = []
  let totalBytes = 0
  for (const imagePath of imagePaths) {
    const path = hostEvidencePath(agent, imagePath) ?? workspacePath(agent, imagePath)
    if (path === undefined) {
      throw new Error(`image path is outside the workspace and host evidence store: ${imagePath}`)
    }
    const info = await fs.stat(path)
    if (!info.isFile()) throw new Error(`image path is not a regular file: ${imagePath}`)
    totalBytes += info.size
    if (totalBytes > MAX_IMAGE_BYTES) {
      throw new Error(`visual evidence exceeds ${MAX_IMAGE_BYTES} bytes`)
    }
    const hash = createHash('sha256')
    await updateFromFile(hash, path, info)
    snapshots.push({ path: imagePath, hash: hash.digest('hex'), size: info.size })
  }
  return snapshots
}
