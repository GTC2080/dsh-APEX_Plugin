import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function collect(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path, files)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path)
  }
}

test('all bundled runtime modules pass the Node syntax check', () => {
  const files = [join(root, 'index.js')]
  collect(join(root, 'presets'), files)
  for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assertSuccessful(result, file)
  }
})

function assertSuccessful(result, file) {
  if (result.status === 0) return
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  throw new Error(`${file} failed syntax validation${detail.length > 0 ? `:\n${detail}` : ''}`)
}
