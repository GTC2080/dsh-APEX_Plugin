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
const apexComposition = join(projectRoot, 'presets', 'apex-v03', 'agent.cordis.yml')
const apexV04Composition = join(projectRoot, 'presets', 'apex-v04', 'agent.cordis.yml')
const apexV041Composition = join(projectRoot, 'presets', 'apex-v041', 'agent.cordis.yml')
const apexV05Composition = join(projectRoot, 'presets', 'apex-v05', 'agent.cordis.yml')
const apexV051Composition = join(projectRoot, 'presets', 'apex-v051', 'agent.cordis.yml')
const apexV06Composition = join(projectRoot, 'presets', 'apex-v06', 'agent.cordis.yml')
const apexV061Composition = join(projectRoot, 'presets', 'apex-v061', 'agent.cordis.yml')
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
const officialStandard = join(
  dshCheckout,
  'apps',
  'cli',
  'config',
  'agent-presets',
  'standard',
  'agent.cordis.yml',
)

function packageNames(text) {
  return new Set([...text.matchAll(/^\s+name: '([^']+)'$/gm)].map((match) => match[1]))
}

async function missingStandardPackages(composition, ignored = new Set()) {
  const expected = packageNames(await readFile(officialStandard, 'utf8'))
  const actual = packageNames(await readFile(composition, 'utf8'))
  return [...expected].filter((packageName) => !ignored.has(packageName) && !actual.has(packageName))
}

test('package declares an official DSH bundle layer without install-time scripts', async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.6.1')
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(manifest.scripts.prepare, undefined)
  assert.equal(manifest.scripts.postinstall, undefined)
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.files.includes('presets/apex-v04'), true)
  assert.equal(manifest.files.includes('presets/apex-v041'), true)
  assert.equal(manifest.files.includes('presets/apex-v05'), true)
  assert.equal(manifest.files.includes('presets/apex-v051'), true)
  assert.equal(manifest.files.includes('presets/apex-v06'), true)
  assert.equal(manifest.files.includes('presets/apex-v061'), true)
  assert.match(
    await readFile(join(projectRoot, 'cordis.patch.yml'), 'utf8'),
    /id: minimal-max-preset-installer[\s\S]*name: dsh-minimal-max/,
  )
})

test('APEX v0.3 composition preserves the Minimal anchor and adds only a post-anchor policy', async () => {
  const content = await readFile(apexComposition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /name: \.\/windows-bash\.mjs/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-str-replace-editor'/)
})

test('APEX v0.4 preserves the Minimal anchor and adds post-anchor policy plus a tool guard', async () => {
  const content = await readFile(apexV04Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/execution-guard\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /name: \.\/windows-bash\.mjs/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-str-replace-editor'/)
})

test('APEX v0.4.1 preserves the Minimal anchor and composes the hard research guard', async () => {
  const content = await readFile(apexV041Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/execution-guard\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /name: \.\/windows-bash\.mjs/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-str-replace-editor'/)
})

test('APEX v0.5 preserves Minimal and configures one bounded V4 Flash researcher', async () => {
  const content = await readFile(apexV05Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/execution-guard\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /toolName: apex_research/)
  assert.match(content, /agentOptions:\n\s+model: deepseek-v4-flash/)
  assert.match(content, /toolFilter:\n\s+allow:\n\s+- web_search/)
  assert.match(content, /maxDepth: 1/)
  assert.match(content, /enableRunInBackground: false/)
})

test('APEX v0.5.1 preserves Minimal and configures evidence-gated renewable research', async () => {
  const content = await readFile(apexV051Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/execution-guard\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /toolName: apex_research/)
  assert.match(content, /agentOptions:\n\s+model: deepseek-v4-flash/)
  assert.match(content, /toolFilter:\n\s+allow:\n\s+- web_search/)
  assert.match(content, /maxDepth: 1/)
  assert.match(content, /enableRunInBackground: false/)
  assert.doesNotMatch(content, /Use at most three distinct web_search queries/)
})

test('APEX v0.6 preserves Minimal and configures bounded Flash Max implementation', async () => {
  const content = await readFile(apexV06Composition, 'utf8')
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: \.\/tool-gate\.mjs/)
  assert.match(content, /name: \.\/execution-guard\.mjs/)
  assert.match(content, /name: \.\/dev-tool-search\.mjs/)
  assert.match(content, /name: \.\/apex-policy\.mjs/)
  assert.match(content, /toolName: apex_build/)
  assert.match(content, /enableRunInBackground: false/)
  assert.match(content, /provider: deepseek-official\n\s+model: deepseek-v4-flash/)
  assert.match(content, /You are the APEX code implementer powered by DeepSeek V4 Flash Max/)
  assert.match(content, /- bash\n\s+- str_replace_editor\n\s+- read\n\s+- write\n\s+- edit\n\s+- glob\n\s+- grep/)
  assert.match(content, /toolName: apex_research/)
  assert.match(content, /maxDepth: 1/)
})

test('APEX v0.6.1 configures vision-capable Flash Max workers with a scoped code persona', async () => {
  const content = await readFile(apexV061Composition, 'utf8')
  const policy = await readFile(join(projectRoot, 'presets', 'apex-v061', 'apex-policy.mjs'), 'utf8')
  const builderModule = await readFile(join(projectRoot, 'presets', 'apex-v061', 'apex-build.mjs'), 'utf8')
  const gateModule = await readFile(join(projectRoot, 'presets', 'apex-v061', 'tool-gate.mjs'), 'utf8')
  const builder = content.slice(
    content.indexOf('- id: tool-apex-build'),
    content.indexOf('- id: tool-ask-user'),
  )
  assert.match(content, /text: You are a helpful software engineer assistant\./)
  assert.match(content, /complete: true/)
  assert.match(content, /includeRuntimeContext: false/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-bash-persistent'[\s\S]*disabled: !!js process\.platform === 'win32'/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-pwsh-persistent'[\s\S]*disabled: !!js process\.platform !== 'win32'/)
  assert.doesNotMatch(content, /name: \.\/windows-bash\.mjs/)
  assert.match(content, /name: '@deepseek-ai\/dsh-fs-sandbox'/)
  assert.doesNotMatch(content, /name: '@deepseek-ai\/dsh-fs-local'/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-subagent-control'/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-subagent-control\/list-agents'/)
  assert.match(content, /name: \.\/worker-wait\.mjs/)
  assert.match(content, /name: \.\/apex-continue\.mjs/)
  assert.match(content, /name: \.\/apex-validation\.mjs/)
  assert.match(content, /name: \.\/apex-vision\.mjs/)
  assert.match(builder, /name: \.\/apex-build\.mjs/)
  assert.doesNotMatch(builder, /\bpersona:/)
  assert.match(builderModule, /name: 'apex_build'/)
  assert.match(builderModule, /startContinuable/)
  assert.match(gateModule, /FLASH_MAX_MODEL = 'deepseek-v4-flash-vision-exp'/)
  assert.match(builderModule, /provider: FLASH_MAX_PROVIDER,\n\s+model: FLASH_MAX_MODEL/)
  assert.match(builderModule, /persona: FLASH_CHILD_PERSONA/)
  assert.match(builderModule, /'str_replace_editor',\n\s+'read',\n\s+'read_image',\n\s+'glob',\n\s+'grep'/)
  assert.match(builderModule, /maxDepth: 1/)
  const visionModule = await readFile(join(projectRoot, 'presets', 'apex-v061', 'apex-vision.mjs'), 'utf8')
  assert.match(visionModule, /name: 'apex_inspect_image'/)
  assert.match(visionModule, /model: FLASH_VISION_MODEL/)
  assert.match(visionModule, /toolFilter: \{ allow: \['read_image'\] \}/)
  assert.doesNotMatch(builderModule, /run_in_background/)
  assert.doesNotMatch(content, /toolName: (?:apex_research|subagent|subagent_fork)/)
  assert.doesNotMatch(content, /dsh-tool-(?:workflow|ralph)/)
  assert.doesNotMatch(policy, /CHILD_WALL_TIME_MS|installChildWallBudget|20 \* 60 \* 1000/)
  assert.match(policy, /profile="pro-led"/)
  assert.match(policy, /Pro parent owns architecture, main integration surfaces/)
  assert.match(policy, /path already mutated by Pro stays Pro-owned/)
  assert.match(builderModule, /delegationPathConflictReason/)
  assert.doesNotMatch(gateModule, /FLASH_MAX_MODEL = 'deepseek-v4-flash'/)
  assert.doesNotMatch(policy, /must start apex_build/)
  assert.match(builderModule, /whole-workspace \*\* lease is forbidden/)
  assert.match(policy, /apex_validate_web/)
})

test('pins the rc.8 first-request composition to the reviewed Minimal baseline', async () => {
  const content = await readFile(posixComposition)
  const digest = createHash('sha256').update(content).digest('hex')
  assert.equal(digest, 'c952e72ff87cb09e6d2700dcf806c6584a67cf867adcd103ec822a6c538d4f87')
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

test('v0.2 control tree remains byte-identical to the reviewed release', async () => {
  const expected = {
    'agent.cordis.yml': '0e30bb496903ca2314740d45d23a71dee23941faa0e6abb072dbabcc4bb87d7e',
    'tool-gate.mjs': 'ffc37df9f97fc3798957d49d68c49c05ecdffe5a4f84058930ac0e8d3a72ed6b',
    'dev-tool-search.mjs': 'ec78382f602d15919cbc7afd590ac58aef43f765db2f832d0e9946f6291ca01f',
    'windows-bash.mjs': '7f05d13d77ed92aa1457fafd4036fbd7d4a5c71c166dfc1f89d3118c55675c70',
    'preset.yml': '33c9672d8b11e24cf15cf8c5c34128bde9ccc97d309e3165449898f9bf642e18',
  }
  for (const [file, digest] of Object.entries(expected)) {
    const content = await readFile(join(projectRoot, 'presets', 'v2', file))
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file)
  }
})

test('APEX v0.3 tree remains byte-identical to the released baseline', async () => {
  const expected = {
    'agent.cordis.yml': '43b2c6252a540c2a0da7cfea094e60c7104e8c009957090e85fcfcd1c096092b',
    'apex-policy.mjs': 'eac27efd9c26049dafa31377d1487967787d3b270306e7040f67b4d1e0685e17',
    'dev-tool-search.mjs': '1945b15a7cadc1072e6df451c71dc93a19e8c73dcef7a8d65ea341fbcfcfb886',
    'preset.yml': '27d39633f873f9d5edae38eec9d177b7dc47852b6bed9ee2abeebd43e67f3829',
    'tool-gate.mjs': 'cd4da6807c28b2e4385806d8930a3760bc2ad2bdff675f3a9a4fca26fdf0f2c7',
    'windows-bash.mjs': '55323a7fd5574572a9486f2fdd34285f347c2412cfff9cf4c6d49b0f43a92c36',
  }
  for (const [file, digest] of Object.entries(expected)) {
    const content = await readFile(join(projectRoot, 'presets', 'apex-v03', file))
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file)
  }
})

test('APEX v0.4 tree remains byte-identical to the tested baseline', async () => {
  const expected = {
    'agent.cordis.yml': '73da2f73911dd99c0432f08fcc3842cf8585f037d0e6044c0ea10cc0ec477200',
    'apex-policy.mjs': '52f9200d8757b3ea6ff1e3214fcf0e770a935077b1cf6b18fbe4602afe75976c',
    'dev-tool-search.mjs': 'fa4ab846a9857fb23e8e5aa82d53ed3b1745bae47fb85ef1a928c68fed782db0',
    'execution-guard.mjs': 'a10b8fcddc3e758ba43b1892497408a7e1d288b742d2f3a04ffa1314aae68074',
    'preset.yml': '1d725b4f3f8f4f67ab7e1acace6b2b8e650ee0fdd6bb880af3d1545fe12598cd',
    'tool-gate.mjs': '497c7056ced88ef15b50006d8c057c0290e0c0ef2fb3278b20ee6e40718de922',
    'windows-bash.mjs': '55323a7fd5574572a9486f2fdd34285f347c2412cfff9cf4c6d49b0f43a92c36',
  }
  for (const [file, digest] of Object.entries(expected)) {
    const content = await readFile(join(projectRoot, 'presets', 'apex-v04', file))
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file)
  }
})

test('APEX v0.4.1 tree remains byte-identical to the tested baseline', async () => {
  const expected = {
    'agent.cordis.yml': 'f68a5ec77d101c7ff73b93df8594264974975d599a28180316421242368fd858',
    'apex-policy.mjs': 'a4262857fa28b97face365b3ee740b7d31c1aaa50d20ac54f28babd34db160ae',
    'dev-tool-search.mjs': '8638b3e6c61ada7b3bcb9d13469222784a8dbf900539614d98d82f8d1b435ab9',
    'execution-guard.mjs': '37e784d38aff3ac7a1912efdf1d6a71a48479a6ad12771d0a08581de98ac6c9a',
    'preset.yml': '2c5e026c414cb2b8e053d47ad9f5c4207f9b7b71c8c67d9dd875a2e127e0d06e',
    'tool-gate.mjs': 'd85d0813f082184d37e4496f2fbd9263dfc32ac9cd304a66288c355b4b16a2da',
    'windows-bash.mjs': '55323a7fd5574572a9486f2fdd34285f347c2412cfff9cf4c6d49b0f43a92c36',
  }
  for (const [file, digest] of Object.entries(expected)) {
    const content = await readFile(join(projectRoot, 'presets', 'apex-v041', file))
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file)
  }
})

test('APEX v0.5 tree remains byte-identical to the released control', async () => {
  const expected = {
    'agent.cordis.yml': '690e944b0cd3df93e0536ce6e5cbf878d074dd91ab15378fac0a8c49a598a8f7',
    'apex-policy.mjs': 'e28de0e7bab4752ed485866d2f394966f4f3d69c20768dca93b95aefbd35b03e',
    'dev-tool-search.mjs': '238612f2ef17817a2d73c54490a978b0859e3f4c84a494f713deab40407e94bb',
    'execution-guard.mjs': '02cc8feabe336ce8bb03e211ad6e2cc08f3352e43d776d3226541312bf9e78e8',
    'preset.yml': '08aada65514ffdf7a53cab3fee600ec08165fd55537fbb3eafc063480f5b57db',
    'tool-gate.mjs': 'afe422084b39c39ef6c2605c0ff666b92b2dec30e1787e62bb4911cee828bd28',
    'windows-bash.mjs': '55323a7fd5574572a9486f2fdd34285f347c2412cfff9cf4c6d49b0f43a92c36',
  }
  for (const [file, digest] of Object.entries(expected)) {
    const content = await readFile(join(projectRoot, 'presets', 'apex-v05', file))
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file)
  }
})

test('APEX v0.4 reuses the released Windows fallback', async () => {
  assert.equal(
    await readFile(join(projectRoot, 'presets', 'apex-v04', 'windows-bash.mjs'), 'utf8'),
    await readFile(join(projectRoot, 'presets', 'apex-v03', 'windows-bash.mjs'), 'utf8'),
  )
})

test('APEX v0.4.1 reuses the released Windows fallback', async () => {
  assert.equal(
    await readFile(join(projectRoot, 'presets', 'apex-v041', 'windows-bash.mjs'), 'utf8'),
    await readFile(join(projectRoot, 'presets', 'apex-v04', 'windows-bash.mjs'), 'utf8'),
  )
})

test('APEX v0.5 reuses the released Windows fallback', async () => {
  assert.equal(
    await readFile(join(projectRoot, 'presets', 'apex-v05', 'windows-bash.mjs'), 'utf8'),
    await readFile(join(projectRoot, 'presets', 'apex-v041', 'windows-bash.mjs'), 'utf8'),
  )
})

test('APEX v0.5.1 reuses the released Windows fallback', async () => {
  assert.equal(
    await readFile(join(projectRoot, 'presets', 'apex-v051', 'windows-bash.mjs'), 'utf8'),
    await readFile(join(projectRoot, 'presets', 'apex-v05', 'windows-bash.mjs'), 'utf8'),
  )
})

test('APEX v0.6 reuses the released Windows fallback', async () => {
  assert.equal(
    await readFile(join(projectRoot, 'presets', 'apex-v06', 'windows-bash.mjs'), 'utf8'),
    await readFile(join(projectRoot, 'presets', 'apex-v051', 'windows-bash.mjs'), 'utf8'),
  )
})

test('APEX v0.6.1 replaces the legacy Windows fallback with the rc.8 persistent shell', async () => {
  const content = await readFile(apexV061Composition, 'utf8')
  assert.equal(existsSync(join(projectRoot, 'presets', 'apex-v061', 'windows-bash.mjs')), false)
  assert.match(content, /shellDialect: pwsh/)
  assert.match(content, /name: '@deepseek-ai\/dsh-tool-pwsh-persistent'/)
})

test(
  'v0.2 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(v2Composition), [])
  },
)

test(
  'APEX v0.3 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexComposition), [])
  },
)

test(
  'APEX v0.4 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexV04Composition), [])
  },
)

test(
  'APEX v0.4.1 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexV041Composition), [])
  },
)

test(
  'APEX v0.5 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexV05Composition), [])
  },
)

test(
  'APEX v0.5.1 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexV051Composition), [])
  },
)

test(
  'APEX v0.6 carries every current Standard package row before request-time filtering',
  { skip: !existsSync(officialStandard) },
  async () => {
    assert.deepEqual(await missingStandardPackages(apexV06Composition), [])
  },
)

test(
  'APEX v0.6.1 carries Standard except deliberately removed delegation rows',
  { skip: !existsSync(officialStandard) },
  async () => {
    const removed = new Set([
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      '@deepseek-ai/dsh-workflow-worker-thread',
      '@deepseek-ai/dsh-tool-workflow',
      '@deepseek-ai/dsh-tool-ralph',
    ])
    assert.deepEqual(await missingStandardPackages(apexV061Composition, removed), [])
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
