import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply as registerWindowsBash } from '../presets/v2/windows-bash.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const posixComposition = join(projectRoot, 'presets', 'posix', 'agent.cordis.yml')
const v2Composition = join(projectRoot, 'presets', 'v2', 'agent.cordis.yml')
const defaultCheckout = resolve(projectRoot, '..', '..', 'deepseek-harness', 'source')
const dshCheckout = process.env.DSH_CHECKOUT === undefined
  ? defaultCheckout
  : resolve(process.env.DSH_CHECKOUT)
const officialMinimal = join(
  dshCheckout,
  'apps',
  'cli',
  'config',
  'agent-presets',
  'minimal',
  'agent.cordis.yml',
)

test('package declares an official DSH bundle layer without install-time scripts', async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.2.0')
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(manifest.scripts.prepare, undefined)
  assert.equal(manifest.scripts.postinstall, undefined)
  assert.equal(manifest.dependencies, undefined)
  assert.match(
    await readFile(join(projectRoot, 'cordis.patch.yml'), 'utf8'),
    /id: minimal-max-preset-installer[\s\S]*name: dsh-minimal-max/,
  )
})

test('pins the POSIX first-request composition to the reviewed Minimal baseline', async () => {
  const content = await readFile(posixComposition)
  const digest = createHash('sha256').update(content).digest('hex')
  assert.equal(digest, 'cacb47f09a88985c8eb0906a62e6883205727a3c8db901807cb03f936b863cca')
})

test(
  'matches the checked-out official Minimal composition byte for byte',
  { skip: !existsSync(officialMinimal) },
  async () => {
    assert.equal(
      await readFile(posixComposition, 'utf8'),
      await readFile(officialMinimal, 'utf8'),
    )
  },
)

test('v0.2 composition keeps the complete Minimal persona and gated bootstrap pair', async () => {
  const content = await readFile(v2Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/windows-bash\.mjs/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-str-replace-editor'/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-(?:fs|web|skill|todo|goal)'/)
})

test(
  'v0.2 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialMinimal) },
  async () => {
    const officialStandard = join(
      dshCheckout,
      'apps',
      'cli',
      'config',
      'agent-presets',
      'standard',
      'agent.cordis.yml',
    )
    const packageNames = (text) => new Set(
      [...text.matchAll(/^\s+name: '([^']+)'$/gm)].map((match) => match[1]),
    )
    const expected = packageNames(await readFile(officialStandard, 'utf8'))
    const actual = packageNames(await readFile(v2Composition, 'utf8'))
    assert.deepEqual([...expected].filter((packageName) => !actual.has(packageName)), [])
  },
)

function captureWindowsTool(subprocess) {
  let registered
  registerWindowsBash({
    subprocess,
    tools: {
      register(definition) {
        registered = definition
      },
    },
  })
  assert.notEqual(registered, undefined)
  return registered
}

test('Windows fallback preserves the official bash command schema', () => {
  const tool = captureWindowsTool({})
  assert.equal(tool.name, 'bash')
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to run. Relative path is preferred in the command.',
      },
    },
    required: ['command'],
  })
  assert.deepEqual(tool.output.schema, { type: 'string' })
  assert.match(tool.description, /State does NOT persist/)
  assert.match(tool.description, /does not apply the Harness OS sandbox/)
})

test('Windows fallback executes Git Bash through the DSH subprocess seam', async () => {
  let spawnSpec
  const tool = captureWindowsTool({
    async resolveExecutable(command) {
      assert.equal(command, 'bash')
      return 'C:\\Program Files\\Git\\bin\\bash.exe'
    },
    spawn(spec) {
      spawnSpec = spec
      return {
        done: Promise.resolve({ exitCode: 7, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'stdout' }) },
          stderr: { readFrom: () => ({ text: 'stderr' }) },
        },
      }
    },
  })
  const signal = new AbortController().signal
  const result = await tool.execute(
    { command: 'printf test' },
    { signal, agent: { session: { header: { cwd: 'C:\\work' } } } },
  )

  assert.deepEqual(spawnSpec.argv, [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    '-c',
    'printf test',
  ])
  assert.equal(spawnSpec.cwd, 'C:\\work')
  assert.equal(result, 'stdout\nstderr\n[exit code: 7]')
  await assert.rejects(
    tool.execute({ command: '   ' }, { signal }),
    /command must be a non-empty string/,
  )
})
