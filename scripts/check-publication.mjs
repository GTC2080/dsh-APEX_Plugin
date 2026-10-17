import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const paper = join(root, 'papers/diesel-engine-2026-09-16')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const privateHomePath = /\/(?:Users|home|Volumes)\/|(?<!private)\/(?:var)\/folders(?:\/|$)|\/private\/(?:var)\/(?!folders(?:$|["')]))/i
const patterns = [
  ['private home path', privateHomePath],
  ['Windows user path', /[A-Z]:\\+Users\\+/i],
  ['credential', /\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
]
const sensitive = text => patterns.filter(([, expression]) => expression.test(text)).map(([name]) => name)
assert.ok(sensitive(['', 'Users', 'example', 'workspace'].join('/')).includes('private home path'))
assert.ok(sensitive('sk' + '-' + 'x'.repeat(32)).includes('credential'))
assert.deepEqual(sensitive('https://example.invalid; outputTokens: 1229906'), [])
const unicodeUserPath = ['', 'Users', '中文用户名', 'workspace'].join('/')
const unicodeVolumePath = ['', 'Volumes', '资料', 'workspace'].join('/')
const genericMacTempPath = ['', 'var', 'folders', 'fixture'].join('/')
const privateUnicodeChild = ['', 'private', 'var', 'folders中文'].join('/')
assert.ok(sensitive(unicodeUserPath).includes('private home path'))
assert.ok(sensitive(unicodeVolumePath).includes('private home path'))
assert.ok(sensitive(genericMacTempPath).includes('private home path'))
assert.ok(sensitive(privateUnicodeChild).includes('private home path'))
const macTempRoot = ['/private', 'var', 'folders'].join('/')
assert.deepEqual(sensitive(`(subpath "${macTempRoot}")`), [])
assert.ok(sensitive(`(subpath "${macTempRoot}/fixture")`).includes('private home path'))

function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path)
    assert.ok(!stat.isSymbolicLink(), 'Public paper must not contain symlinks')
    assert.ok(stat.isFile() || stat.isDirectory(), 'Unexpected public file type')
    return stat.isDirectory() ? files(path) : [path]
  })
}
const manifest = JSON.parse(readFileSync(join(paper, 'manifest.json'), 'utf8'))
const current = files(paper).map(path => relative(paper, path).replaceAll('\\', '/'))
  .filter(path => path !== 'manifest.json')
assert.deepEqual(current.sort(), Object.keys(manifest.files).sort(), 'Public file allowlist changed')
for (const [path, digest] of Object.entries(manifest.files)) {
  assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Manifest path escaped its root')
  assert.equal(sha(readFileSync(join(paper, path))), digest, 'Public file hash mismatch: ' + path)
}
const candidates = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean)
const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean))
const validCandidates = candidates.filter(path => !deleted.has(path))
const failures = []
for (const path of validCandidates) {
  if (/(?:^|\/)(?:node_modules|research|tmp)\//.test(path) || /\.(?:jsonl|log|trace|pem|key)(?:\.gz)?$/i.test(path)) {
    failures.push(path + ': disallowed publication file')
    continue
  }
  if (!/\.(?:md|txt|js|mjs|cjs|json|ya?ml|csv|enw|svg|html|css|toml)$/i.test(path) && !['NOTICE', 'LICENSE'].includes(path)) continue
  const bytes = readFileSync(join(root, path))
  for (const reason of sensitive(bytes.toString('utf8'))) failures.push(path + ': ' + reason)
}
const comparison = JSON.parse(readFileSync(join(paper, 'data/comparison.json'), 'utf8'))
assert.equal(comparison.official.rawScore, 72.8)
assert.equal(comparison.official.finalScore, 40)
assert.equal(comparison.apex.finalScore, 83.8)
for (const arm of ['native', 'apex']) {
  const data = JSON.parse(readFileSync(join(paper, 'data', arm + '-evaluation.json'), 'utf8'))
  assert.equal(Object.keys(data.criteria).length, 37)
  assert.equal(Math.round(Object.values(data.criteria).reduce((sum, row) => sum + row.points, 0) * 10) / 10, data.rawScore)
  assert.equal(data.overallAcceptance, 'failed')
}
assert.deepEqual(failures, [], 'Publication scan failed; matched content is deliberately not printed')
console.log(JSON.stringify({ publicFilesVerified: current.length, repositoryFilesScanned: validCandidates.length,
  scoredCriteriaPerArm: 37, obviousSecretsOrPrivatePaths: 0 }))
