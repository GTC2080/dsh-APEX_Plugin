import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APEX_VISION_DESCRIPTION,
  STALE_VALIDATION_SCREENSHOT_REASON,
  validationScreenshotDenial,
  VISUAL_META_KIND,
} from '../presets/apex-v062/apex-vision.mjs'
import {
  apply as applyValidation,
  nextLegalValidationMode,
  resolveBrowser,
  resultText,
  validationAdmission,
  validationBudget,
  validationSignature,
  WEB_VALIDATION_META_KIND,
} from '../presets/apex-v062/apex-validation.mjs'
import { apply as applyDiscovery } from '../presets/apex-v062/dev-tool-search.mjs'
import {
  apply as applyPolicy,
  APEX_POLICY,
  APEX_RESEARCH_CONVERGENCE_PREFIX,
  APEX_WORKSPACE_HINT_PREFIX,
  policyMessage,
  researchConvergenceText,
  shouldInject,
  shouldInjectResearchConvergence,
} from '../presets/apex-v062/apex-policy.mjs'
import {
  apply as applyExecutionGuard,
  BROWSER_DOWNLOAD_REASON,
  CHILD_SCOPE_REASON,
  DENIAL_REASON,
  editorErrorRecovery,
  guardExecution,
  normalizeEditorCall,
  normalizeEditorNullArguments,
  recoverEditorError,
  WEB_VALIDATION_DISCOVERY_REASON,
} from '../presets/apex-v062/execution-guard.mjs'
import {
  SHELL_HEREDOC_FORMAT_REASON,
  WORKSPACE_SHELL_REASON,
  WORKSPACE_WRITE_REASON,
  workspacePath,
} from '../presets/apex-v062/workspace-boundary.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  RESIDENT_TOOLS,
  UNLOCK_META_KIND,
} from '../presets/apex-v062/tool-gate.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const frozenV061 = join(projectRoot, 'presets', 'apex-v061')
const frozenV061Digest = '497e72bb457aa15c1dbb742597b1d7f23fac5d0bd81404543f88d579e50d2ac0'

const catalog = [
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'str_replace_editor', description: 'View and edit files' },
  { name: 'dev_tool_search', description: 'Discover optional tools' },
  { name: 'apex_build', description: 'Delegate one independent code module' },
  { name: 'apex_inspect_image', description: APEX_VISION_DESCRIPTION },
  { name: 'apex_state', description: 'Keep durable task invariants and evidence' },
  { name: 'apex_validate_web', description: 'Validate one static web artifact' },
  { name: 'web_search', description: 'Search the internet for current evidence' },
]

function treeDigest(root) {
  const files = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(root, path))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function agent(events = [], cwd = '/workspace') {
  return { session: { events, header: { delegationDepth: 0, cwd } } }
}

function successfulCall(name, callId = `${name}-1`) {
  return [
    { type: 'tool/call', data: { name, callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'ok' }],
          }],
        },
      },
    },
  ]
}

function successfulResearchCall(index) {
  const callId = `research-${index}`
  return [
    {
      type: 'tool/call',
      data: {
        name: BOOTSTRAP_TOOLS[0],
        callId,
        arguments: JSON.stringify({ command: `sed -n '${index},${index + 1}p' reference.js` }),
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'source evidence' }],
          }],
        },
      },
    },
  ]
}

function successfulEditorCreate(path = '/workspace/index.html', callId = 'editor-create-1') {
  return [
    {
      type: 'tool/call',
      data: {
        name: 'str_replace_editor',
        callId,
        arguments: JSON.stringify({ command: 'create', path, file_text: '<!doctype html>' }),
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'ok' }],
          }],
        },
      },
    },
  ]
}

function validationEvent(args, status, overrides = {}) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: WEB_VALIDATION_META_KIND,
        checkId: args.check_id,
        mode: args.mode,
        status,
        signature: validationSignature(args),
        failureClass: status === 'failed' ? 'application-runtime' : 'none',
        diagnosticHash: '',
        defectScore: status === 'failed' ? 1 : 0,
        repairEligible: status === 'failed',
        screenshotPath: '',
        ...overrides,
      },
    },
  }
}

function unlockResult(...toolNames) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: UNLOCK_META_KIND, unlockedTools: toolNames },
      message: { content: [] },
    },
  }
}

function discoveryResult(matchedTools) {
  return {
    type: 'tool/result',
    data: {
      meta: { kind: UNLOCK_META_KIND, matchedTools, unlockedTools: [] },
      message: { content: [] },
    },
  }
}

function gateListener() {
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  return listener
}

async function assemble(scopedAgent) {
  return gateListener()(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
}

function discovery(events = []) {
  let tool
  const scopedAgent = agent(events)
  applyDiscovery({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
      schemas(value) {
        assert.equal(value, scopedAgent)
        return catalog
      },
    },
  })
  return { agent: scopedAgent, tool }
}

function policyPreStepListener() {
  let listener
  applyPolicy({
    tools: { register: () => () => {} },
    subagents: {},
    on(event, value) {
      if (event === 'agent/pre-step') listener = value
      return () => {}
    },
  })
  return listener
}

test('v0.6.1 remains byte-for-byte frozen', () => {
  assert.equal(treeDigest(frozenV061), frozenV061Digest)
})

test('v0.6.2 keeps a task-neutral Minimal anchor and activated policy', () => {
  const composition = readFileSync(
    new URL('../presets/apex-v062/agent.cordis.yml', import.meta.url),
    'utf8',
  )
  assert.match(composition, /text: You are a helpful software engineer assistant\./)
  assert.match(composition, /complete: true/)
  assert.match(composition, /includeRuntimeContext: false/)
  assert.match(APEX_WORKSPACE_HINT_PREFIX, /0\.6\.2/)
  assert.match(APEX_POLICY, /task-specific invariants/)
  assert.match(APEX_POLICY, /explicit user or project requirements/)
  assert.match(APEX_POLICY, /cheapest direct evidence/)
  assert.match(APEX_POLICY, /reuse still-valid evidence/)
  assert.match(APEX_POLICY, /runtime, visual, research, and worker evidence as separate surfaces/)
  assert.doesNotMatch(
    APEX_POLICY,
    /apex_validate_web|apex_inspect_image|broad user-facing work|poolrooms|three\.js|static.*fps|moving.*fps/i,
  )
})

test('v0.6.2 preserves the Minimal first request and exposes only the capability broker after promotion', async () => {
  assert.deepEqual((await assemble(agent())).tools.map(tool => tool.name), [...BOOTSTRAP_TOOLS])
  const promoted = agent(successfulCall(BOOTSTRAP_TOOLS[0]))
  const assembled = await assemble(promoted)
  assert.deepEqual(
    assembled.tools.map(tool => tool.name).sort(),
    [...RESIDENT_TOOLS].sort(),
  )
  assert.deepEqual(RESIDENT_TOOLS, [...BOOTSTRAP_TOOLS, 'dev_tool_search'])
})

test('promotion injects one concise capability directory without changing the first Minimal step', async () => {
  const listener = policyPreStepListener()
  const signal = new AbortController().signal
  const enter = async () => ({ kind: 'enter', messages: [] })

  const first = await listener({ agent: agent(), step: 1, signal }, enter)
  assert.equal(first.messages.some(message => message.content?.some(block => (
    block.type === 'text' && block.text.startsWith('<apex-capability-directory')
  ))), false)

  const promoted = await listener({
    agent: agent(successfulCall(BOOTSTRAP_TOOLS[0])),
    step: 2,
    signal,
  }, enter)
  const directory = promoted.messages.find(message => message.content?.some(block => (
    block.type === 'text' && block.text.startsWith('<apex-capability-directory')
  )))
  assert.ok(directory)
  const text = directory.content[0].text
  assert.match(text, /dev_tool_search/)
  assert.match(text, /web_search/)
  assert.match(text, /apex_build/)
  assert.match(text, /apex_validate_web/)
  assert.match(text, /apex_inspect_image/)
  assert.match(text, /before manual Bash setup/i)

  const repeated = await listener({
    agent: agent([
      ...successfulCall(BOOTSTRAP_TOOLS[0]),
      { type: 'user/message', data: directory },
    ]),
    step: 3,
    signal,
  }, enter)
  assert.equal(repeated.messages.some(message => message.content?.some(block => (
    block.type === 'text' && block.text.startsWith('<apex-capability-directory')
  ))), false)
})

test('the general policy appears once only after an APEX capability is activated', () => {
  const events = [...successfulCall(BOOTSTRAP_TOOLS[0]), unlockResult('apex_state')]
  const scopedAgent = agent(events)
  assert.equal(shouldInject(scopedAgent), true)

  events.push({ type: 'user/message', data: policyMessage(scopedAgent) })
  assert.equal(shouldInject(scopedAgent), false)
})

test('repeated pre-implementation research gets one non-blocking convergence reminder', () => {
  const events = Array.from({ length: 12 }, (_, index) => successfulResearchCall(index + 1)).flat()
  assert.equal(shouldInjectResearchConvergence(agent(events)), true)
  const text = researchConvergenceText()
  assert.match(text, new RegExp(APEX_RESEARCH_CONVERGENCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /not a fixed research limit/i)
  assert.match(text, /specific unresolved API, algorithm, or domain fact/i)
  assert.match(text, /smallest end-to-end slice/i)
  assert.doesNotMatch(text, /poolrooms|three\.js|fps/i)

  assert.equal(shouldInjectResearchConvergence(agent([
    ...events,
    ...successfulEditorCreate('/workspace/index.html', 'implementation-started'),
  ])), false)
})

test('optional capability packs unlock independently', async () => {
  const base = successfulCall(BOOTSTRAP_TOOLS[0])
  const visual = await assemble(agent([...base, unlockResult('apex_inspect_image')]))
  assert.equal(visual.tools.some(tool => tool.name === 'apex_inspect_image'), true)
  assert.equal(visual.tools.some(tool => tool.name === 'apex_validate_web'), false)

  const web = await assemble(agent([...base, unlockResult('apex_validate_web')]))
  assert.equal(web.tools.some(tool => tool.name === 'apex_validate_web'), true)
  assert.equal(web.tools.some(tool => tool.name === 'apex_state'), false)

  const research = await assemble(agent([...base, unlockResult('web_search')]))
  assert.equal(research.tools.some(tool => tool.name === 'web_search'), true)
  assert.equal(research.tools.some(tool => tool.name === 'apex_build'), false)
})

test('an editor or Bash-created HTML artifact exposes only the host Web validator without a discovery round trip', async (t) => {
  const assembled = await assemble(agent(successfulEditorCreate()))
  assert.equal(assembled.tools.some(tool => tool.name === 'apex_validate_web'), true)
  assert.equal(assembled.tools.some(tool => tool.name === 'apex_inspect_image'), false)
  assert.equal(assembled.tools.some(tool => tool.name === 'web_search'), false)
  assert.equal(assembled.tools.some(tool => tool.name === 'apex_build'), false)

  const root = mkdtempSync(join(tmpdir(), 'apex-v062-html-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'shell-created.html'), '<main>ready</main>')
  const shellAssembled = await assemble(agent(successfulCall(BOOTSTRAP_TOOLS[0]), root))
  assert.equal(shellAssembled.tools.some(tool => tool.name === 'apex_validate_web'), true)
})

test('capability discovery unlocks one clear match without a second tool call', async () => {
  const { agent: scopedAgent, tool } = discovery()
  assert.match(tool.description, /Compact capability index/)
  assert.match(tool.description, /apex_build/)
  assert.match(tool.description, /apex_validate_web/)
  assert.match(tool.description, /apex_inspect_image/)
  assert.match(tool.description, /web_search/)
  assert.match(tool.description, /consequential domain decision/)
  assert.match(tool.description, /primary sources/)
  assert.match(tool.description, /implementation constraint or test/)
  assert.match(tool.description, /ordinary path discovery, local code inspection, or routine debugging/)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['query', 'toolNames'])
  assert.deepEqual(tool.output.schema.required, ['text', 'matchedTools', 'unlockedTools'])

  const broad = await tool.execute({ query: 'internet' }, { agent: scopedAgent })
  assert.deepEqual(broad.matchedTools, ['web_search'])
  assert.deepEqual(broad.unlockedTools, ['web_search'])
  assert.match(broad.text, /Use web_search in the next request/i)
  assert.doesNotMatch(broad.text, /^Call dev_tool_search again/im)

  const exact = await tool.execute({ query: 'web_search' }, { agent: scopedAgent })
  assert.deepEqual(exact.unlockedTools, ['web_search'])

  const discovered = discovery([discoveryResult(['apex_inspect_image'])])
  const accepted = await discovered.tool.execute(
    { query: 'apex_inspect_image', toolNames: ['apex_inspect_image'] },
    { agent: discovered.agent },
  )
  assert.deepEqual(accepted.unlockedTools, ['apex_inspect_image'])
  assert.match(accepted.text, /Use apex_inspect_image in the next request/i)
  assert.doesNotMatch(accepted.text, /^Call dev_tool_search again/im)
})

test('Web validation self-binds its contract and reuses unchanged passed evidence', () => {
  const assertion = 'The built page loads with one visible canvas and no runtime errors.'
  const baseline = {
    check_id: 'runtime',
    assertion,
    mode: 'baseline',
    root: '.',
    require_canvas: true,
  }
  assert.equal(validationAdmission(baseline, agent()), undefined)
  const passed = validationEvent(baseline, 'passed')
  assert.match(
    validationAdmission({ ...baseline, mode: 'final', assertion: 'A detached smoke assertion.' }, agent([passed])),
    /exact baseline/i,
  )
  assert.match(
    validationAdmission({ ...baseline, check_id: 'replacement', mode: 'final' }, agent([passed])),
    /already bound/i,
  )
  assert.match(
    validationAdmission({ ...baseline, mode: 'final' }, agent([passed])),
    /Reuse the latest passed Web evidence/i,
  )
  assert.equal(
    validationAdmission(
      { ...baseline, mode: 'final' },
      agent([passed, ...successfulEditorCreate('/workspace/index.html', 'post-validation-edit')]),
    ),
    undefined,
  )

  const failed = validationEvent(baseline, 'failed')
  assert.match(
    validationAdmission({ ...baseline, mode: 'regression' }, agent([failed])),
    /implementation mutation/i,
  )
  assert.equal(
    validationAdmission(
      { ...baseline, mode: 'regression' },
      agent([failed, ...successfulEditorCreate('/workspace/index.html', 'repair-edit')]),
    ),
    undefined,
  )

  const text = resultText({
    checkId: 'runtime',
    mode: 'baseline',
    status: 'passed',
    detail: assertion,
    browser: 'Chrome',
    url: 'http://127.0.0.1/index.html',
    readyState: 'complete',
    visibleCanvasCount: 1,
    canvasCount: 1,
    graphicsApi: 'webgl2',
    graphicsRenderer: '',
    fps: 60,
    p95FrameMs: 16.7,
    consoleErrors: [],
    pageErrors: [],
    networkErrors: [],
    httpErrors: [],
    missingSelectors: [],
    screenshotPath: 'baseline.png',
    nextMode: 'none',
    remainingBudget: {
      baseline: 0,
      regression: 1,
      final: 1,
      repairProof: 3,
      environmentRetry: 1,
    },
    cleanup: 'server-closed',
  })
  assert.match(text, /Reuse it while the artifact remains unchanged/i)
  assert.match(text, /"apex_inspect_image"/)
  assert.match(text, /Remaining budget: baseline=0, regression=1, final=1, repair-proof=3, environment-retry=1/)
  assert.match(text, /Next legal mode now: none/)
  assert.doesNotMatch(text, /apex_state/)
})

test('Web validation signatures ignore nested object key order but retain semantic changes', () => {
  const baseline = {
    check_id: 'runtime',
    assertion: 'Movement remains responsive.',
    mode: 'baseline',
    root: 'dist',
    interactions: [{ key: 'KeyW', hold_ms: 900 }],
  }
  const reordered = {
    ...baseline,
    mode: 'regression',
    interactions: [{ hold_ms: 900, key: 'KeyW' }],
  }
  assert.equal(validationSignature(reordered), validationSignature(baseline))
  assert.notEqual(
    validationSignature({ ...reordered, interactions: [{ hold_ms: 901, key: 'KeyW' }] }),
    validationSignature(baseline),
  )
  assert.equal(validationAdmission(
    reordered,
    agent([
      validationEvent(baseline, 'failed'),
      ...successfulEditorCreate('/workspace/index.html', 'contract-repair'),
    ]),
  ), undefined)
})

test('used final budget points directly to an admissible repair proof and reports remaining rounds', () => {
  const baseline = {
    check_id: 'runtime',
    assertion: 'The built page loads with one visible canvas and no runtime errors.',
    mode: 'baseline',
    root: '.',
    require_canvas: true,
  }
  const final = { ...baseline, mode: 'final', screenshot_path: 'final.png' }
  const events = [
    validationEvent(baseline, 'passed'),
    validationEvent(final, 'passed', {
      screenshotPath: 'final.png',
      screenshotHash: 'captured-hash',
    }),
    {
      type: 'tool/result',
      data: {
        meta: {
          kind: VISUAL_META_KIND,
          verdict: 'repair',
          imagePaths: ['final.png'],
        },
      },
    },
    ...successfulEditorCreate('/workspace/index.html', 'post-visual-repair'),
  ]
  const scopedAgent = agent(events)
  const denial = validationAdmission(final, scopedAgent)
  assert.match(denial, /Next legal mode: repair-proof/i)
  assert.match(denial, /"mode":"repair-proof"/)
  assert.match(denial, /repair-proof=3/)
  assert.equal(nextLegalValidationMode(final, scopedAgent), 'repair-proof')
  assert.deepEqual(validationBudget(scopedAgent), {
    baseline: 0,
    regression: 1,
    final: 0,
    repairProof: 3,
    environmentRetry: 1,
  })
})

test('editor failures return one command-specific retry shape without changing the tool surface', async () => {
  const invalid = {
    isError: true,
    error: {
      message: 'invalid arguments: "file_text" must be a string',
      info: { code: 'INVALID_ARGS' },
    },
    content: [{ type: 'text', text: 'raw invalid argument error' }],
  }
  assert.match(editorErrorRecovery({
    name: 'str_replace_editor',
    arguments: { command: 'str_replace', path: '/workspace/a.js', file_text: null },
  }, invalid), /only command, path, old_str, and new_str/i)

  assert.match(editorErrorRecovery({
    name: 'str_replace_editor',
    arguments: 'file_text: ignored',
  }, invalid), /one JSON object/i)

  assert.match(editorErrorRecovery({ name: 'str_replace_editor' }, {
    isError: true,
    error: { message: 'edit requires reading "/workspace/a.js" first', info: { code: 'FS_NOT_OBSERVED' } },
    content: [],
  }), /view the same path once/i)

  const decision = await recoverEditorError(
    { name: 'str_replace_editor', arguments: { command: 'create', path: '/workspace/a.js', file_text: null } },
    invalid,
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.match(decision.content[0].text, /command, path, and file_text/i)

  const withPlaceholders = {
    command: 'str_replace',
    path: '/workspace/a.js',
    file_text: null,
    insert_line: null,
    old_str: 'old',
    new_str: 'new',
    view_range: null,
    unknown: null,
  }
  const normalized = normalizeEditorNullArguments(withPlaceholders)
  assert.deepEqual(normalized, {
    command: 'str_replace',
    path: '/workspace/a.js',
    old_str: 'old',
    new_str: 'new',
    unknown: null,
  })
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(normalizeEditorNullArguments({
    command: null,
    path: null,
    file_text: false,
  }).command, null)

  let listener
  let normalizer
  let guard
  applyExecutionGuard({
    tools: { guard(value) { guard = value } },
    on(event, value) {
      if (event === 'tools/execute') normalizer = value
      if (event === 'tools/post-execute') listener = value
      return () => {}
    },
  })
  assert.equal(guard, guardExecution)
  assert.equal(normalizer, normalizeEditorCall)
  assert.equal(listener, recoverEditorError)

  const execution = {
    name: 'str_replace_editor',
    arguments: { command: 'view', path: '/workspace/a.js', file_text: null },
  }
  const delegated = await normalizer(execution, async () => 'delegated')
  assert.equal(delegated, 'delegated')
  assert.deepEqual(execution.arguments, { command: 'view', path: '/workspace/a.js' })
})

test('non-English discovery falls back to a bounded catalog without auto-unlocking', async () => {
  const first = discovery()
  const fallback = await first.tool.execute(
    { query: '委派代码协作者独立实现文件' },
    { agent: first.agent },
  )
  assert.equal(fallback.matchedTools.includes('apex_build'), true)
  assert.deepEqual(fallback.unlockedTools, [])
  assert.match(fallback.text, /No lexical match.*bounded optional tool catalog/is)

  const second = discovery([discoveryResult(fallback.matchedTools)])
  const unlocked = await second.tool.execute(
    { toolNames: ['apex_build'] },
    { agent: second.agent },
  )
  assert.deepEqual(unlocked.unlockedTools, ['apex_build'])
})

test('host web validation resolves the platform browser through the subprocess seam', async () => {
  const candidates = []
  const signal = new AbortController().signal
  const resolved = await resolveBrowser({
    async resolveExecutable(candidate, cwd, receivedSignal) {
      candidates.push(candidate)
      assert.equal(cwd, undefined)
      assert.equal(receivedSignal, signal)
      return '/resolved/system-browser'
    },
  }, signal)

  assert.equal(resolved, '/resolved/system-browser')
  if (process.platform === 'darwin') {
    assert.equal(candidates[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else if (process.platform === 'win32') {
    assert.match(candidates[0], /(?:chrome|msedge)(?:\.exe)?$/i)
  } else {
    assert.equal(candidates[0], 'google-chrome')
  }
})

test('host validation result exposes the next admitted mode and durable remaining budget', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v062-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let tool
  applyValidation({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subprocess: {
      async resolveExecutable() {
        throw new Error('browser unavailable in unit test')
      },
    },
  })
  const args = {
    check_id: 'runtime',
    assertion: 'The page loads.',
    mode: 'baseline',
    root: '.',
  }
  const value = await tool.execute(args, {
    agent: agent([], root),
    signal: new AbortController().signal,
  })
  assert.equal(value.status, 'blocked')
  assert.equal(value.nextMode, 'regression')
  assert.equal(value.screenshotHash, '')
  assert.deepEqual(value.remainingBudget, {
    baseline: 0,
    regression: 1,
    final: 1,
    repairProof: 3,
    environmentRetry: 1,
  })
  assert.match(value.text, /Next legal mode now: regression/)
  assert.equal(tool.output.schema.required.includes('nextMode'), true)
  assert.equal(tool.output.schema.required.includes('remainingBudget'), true)
  assert.equal(JSON.stringify(tool.output.schema).includes('"minimum"'), false)
})

test('browser-validation fallback is redirected to the already visible host validator after HTML exists', (t) => {
  const beforeArtifact = agent()
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: `node -e "try{require('jsdom')}catch{}"` },
    agent: beforeArtifact,
  }), undefined)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'npx --yes playwright@1.54.1 install chromium' },
    agent: beforeArtifact,
  }), BROWSER_DOWNLOAD_REASON)

  const afterArtifact = agent(successfulEditorCreate())
  for (const command of [
    `node -e "try{require('jsdom')}catch{}"`,
    'python3 -m pip install playwright -q',
    'npm install @napi-rs/canvas --no-save',
    'npx --yes playwright@1.54.1 install chromium',
    'pnpm dlx @playwright/test@1.54.1 install chromium',
    `which chromium || ls /Applications | grep -i 'chrome'`,
  ]) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: afterArtifact,
    }), WEB_VALIDATION_DISCOVERY_REASON)
  }
  assert.match(WEB_VALIDATION_DISCOVERY_REASON, /already exposed apex_validate_web/)
  assert.match(WEB_VALIDATION_DISCOVERY_REASON, /call it directly/i)
  assert.doesNotMatch(WEB_VALIDATION_DISCOVERY_REASON, /dev_tool_search/)

  const root = mkdtempSync(join(tmpdir(), 'apex-v062-browser-fallback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'shell-created.html'), '<main>ready</main>')
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'npx --yes playwright@1.54.1 install chromium' },
    agent: agent(successfulCall(BOOTSTRAP_TOOLS[0]), root),
  }), WEB_VALIDATION_DISCOVERY_REASON)

  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'npm install' },
    agent: afterArtifact,
  }), undefined)
})

test('a final screenshot points to the hidden visual reviewer through discovery', () => {
  const text = resultText({
    checkId: 'web-final',
    mode: 'final',
    status: 'passed',
    detail: 'ok',
    url: 'http://127.0.0.1/',
    browser: 'Chrome',
    readyState: 'complete',
    visibleCanvasCount: 1,
    canvasCount: 1,
    graphicsApi: '2d',
    graphicsRenderer: '',
    fps: 60,
    p95FrameMs: 16.7,
    consoleErrors: [],
    pageErrors: [],
    networkErrors: [],
    httpErrors: [],
    missingSelectors: [],
    screenshotPath: 'proof.png',
    cleanup: 'server-closed',
    failureClass: 'none',
    repairEligible: false,
  })
  assert.match(text, /dev_tool_search/)
  assert.match(text, /"apex_inspect_image"/)
})

test('visual review accepts only the latest unchanged host-captured screenshot hash', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v062-vision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const imagePath = join(root, 'latest.png')
  const bytes = Buffer.from('captured-image')
  writeFileSync(imagePath, bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const baseline = {
    check_id: 'visual-runtime',
    assertion: 'The page renders.',
    mode: 'final',
    root: '.',
  }
  const capture = validationEvent(baseline, 'passed', {
    screenshotPath: 'latest.png',
    screenshotHash: hash,
  })
  assert.equal(await validationScreenshotDenial(agent([capture], root), ['latest.png']), undefined)

  const older = validationEvent({ ...baseline, mode: 'baseline' }, 'passed', {
    screenshotPath: 'older.png',
    screenshotHash: 'older-hash',
  })
  assert.equal(
    await validationScreenshotDenial(agent([older, capture], root), ['older.png']),
    STALE_VALIDATION_SCREENSHOT_REASON,
  )

  const changed = agent([
    capture,
    ...successfulEditorCreate(join(root, 'index.html'), 'after-capture-edit'),
  ], root)
  assert.equal(
    await validationScreenshotDenial(changed, ['latest.png']),
    STALE_VALIDATION_SCREENSHOT_REASON,
  )

  writeFileSync(imagePath, 'replaced-image')
  assert.equal(
    await validationScreenshotDenial(agent([capture], root), ['latest.png']),
    STALE_VALIDATION_SCREENSHOT_REASON,
  )
  assert.equal(
    await validationScreenshotDenial(agent([capture], root), ['unrelated-reference.png']),
    undefined,
  )
})

test('general root work is not constrained by v0.6.1 engineering heuristics', () => {
  const root = agent()
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'node server.js &' },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: "printf '%s' ok > index.html" },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'npm install' },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: 'web_search',
    arguments: { query: 'same difficult topic' },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'pkill -f Chromium' },
    agent: root,
  }), DENIAL_REASON)
})

test('bounded Bash heredocs follow the official persistent-shell contract', () => {
  const root = agent()
  for (const command of [
    "cat > index.html <<'EOF'\n<script src=\"/assets/app.js\"></script>\n<p>$HOME stays literal</p>\nEOF",
    "cat <<'JS' > src/app.js\nexport const route = '/api/status'\nJS",
    "node <<EOF\nconsole.log(1)\nEOF",
    "node --input-type=module - <<'EOF'\nconsole.log('ok')\n// Check opening total logic via wall box coverage maybe\nEOF",
    "node <<'EOF'\n// diagnostic path /etc/passwd\nconsole.log('safe')\nEOF",
    "cat > first.txt <<'FIRST'\none\nFIRST\ncat > second.txt <<'SECOND'\ntwo\nSECOND",
    "cat > /tmp/apex-v062-out.txt <<'EOF'\ntext\nEOF",
    "cd /workspace && mkdir -p .tmp && cat > .tmp/pbf.js <<'EOF'\nconst scratch = '/tmp/pbf.js';\nconst ratio = 1 / 3;\nEOF",
    "cd /workspace && node <<'EOF'\nconsole.log('/etc/passwd is text, not a file operation')\nEOF",
    "sed 's/const h=spacing\\*1.35;/const h=spacing*1.5;/' /tmp/pbf_test2.js > /tmp/pbf_test3.js",
    "cd /workspace && for it in 4 5 6; do sed \"s/const solverIters=3;/const solverIters=$it;/\" .tmp/pbf.js > .tmp/pbf_$it.js; done",
    "printf '%s\\n' $((1 << 2))",
    "printf '%s\\n' $((1 << SHIFT))\nprintf '%s\\n' done",
    "cat <<< payload",
  ]) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: root,
    }), undefined, command)
  }

  for (const command of [
    "cat > ../out.txt <<'EOF'\ntext\nEOF",
    "python3 - <<'PY'\nopen('/etc/passwd').read()\nPY",
    "cd /workspace && python3 - <<'PY'\nopen('/etc/passwd').read()\nPY",
    "node <<EOF\nconsole.log('$HOME/private')\nEOF",
  ]) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: root,
    }), WORKSPACE_SHELL_REASON, command)
  }

  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: "cat > index.html <<'EOF'\n<main>unfinished</main>" },
    agent: root,
  }), SHELL_HEREDOC_FORMAT_REASON)
})

test('the system temporary root may be entered while destructive root targets and final writes stay blocked', (t) => {
  const root = agent([], process.platform === 'win32' ? 'C:\\workspace' : '/workspace')
  const scratch = join(tmpdir(), 'dsh-apex-v062', 'probe.js')

  assert.equal(guardExecution({
    name: 'write',
    arguments: { file_path: scratch, content: 'console.log(1)' },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: scratch, file_text: 'console.log(1)' },
    agent: root,
  }), undefined)
  assert.equal(workspacePath(root, scratch), undefined)

  const child = {
    session: { events: [], header: { delegationDepth: 1, cwd: root.session.header.cwd } },
  }
  assert.equal(guardExecution({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: scratch, file_text: 'console.log(1)' },
    agent: child,
  }), CHILD_SCOPE_REASON)

  const shell = process.platform === 'win32'
    ? `Set-Content -LiteralPath '${scratch}' -Value 'ok'`
    : `printf '%s' ok > '${scratch}'`
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: shell },
    agent: root,
  }), undefined)

  const tempRoot = tmpdir()
  const enterTempRootCommand = process.platform === 'win32'
    ? `Set-Location -LiteralPath '${tempRoot}'; Get-Location`
    : `cd '${tempRoot}' && pwd`
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: enterTempRootCommand },
    agent: root,
  }), undefined)

  const destructiveRootCommand = process.platform === 'win32'
    ? `Remove-Item -Recurse -Force '${tempRoot}'`
    : `rm -rf '${tempRoot}'`
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: destructiveRootCommand },
    agent: root,
  }), WORKSPACE_SHELL_REASON)
  const destructiveCurrentDirectoryCommands = process.platform === 'win32'
    ? [
        'Remove-Item -Recurse -Force .',
        'Remove-Item -Recurse -Force *',
      ]
    : [
        'rm -rf .',
        'rm -rf *',
        'rm -rf "$PWD"',
      ]
  for (const command of destructiveCurrentDirectoryCommands) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: root,
    }), WORKSPACE_SHELL_REASON, command)
  }
  const removeScratchCommand = process.platform === 'win32'
    ? `Remove-Item -Force '${scratch}'`
    : `rm -f '${scratch}'`
  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: removeScratchCommand },
    agent: root,
  }), undefined)
  assert.equal(guardExecution({
    name: 'write',
    arguments: { file_path: tempRoot, content: 'not a file' },
    agent: root,
  }), WORKSPACE_WRITE_REASON)

  const linkRoot = mkdtempSync(join(tmpdir(), 'dsh-apex-v062-link-'))
  t.after(() => rmSync(linkRoot, { recursive: true, force: true }))
  const linkedOutside = join(linkRoot, 'outside')
  symlinkSync(projectRoot, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(guardExecution({
    name: 'write',
    arguments: { file_path: join(linkedOutside, 'probe.js'), content: 'not allowed' },
    agent: root,
  }), WORKSPACE_WRITE_REASON)

  if (process.platform === 'darwin') {
    for (const alias of ['/tmp/dsh-apex-v062/probe.js', '/private/tmp/dsh-apex-v062/probe.js']) {
      assert.equal(guardExecution({
        name: 'write',
        arguments: { file_path: alias, content: 'console.log(1)' },
        agent: root,
      }), undefined, alias)
    }
    for (const alias of ['/tmp', '/private/tmp']) {
      assert.equal(guardExecution({
        name: BOOTSTRAP_TOOLS[0],
        arguments: { command: `cd '${alias}' && pwd` },
        agent: root,
      }), undefined, alias)
      assert.equal(guardExecution({
        name: BOOTSTRAP_TOOLS[0],
        arguments: { command: `rm -rf '${alias}'` },
        agent: root,
      }), WORKSPACE_SHELL_REASON, alias)
      assert.equal(guardExecution({
        name: BOOTSTRAP_TOOLS[0],
        arguments: { command: `rm -rf '${alias}'/*` },
        agent: root,
      }), WORKSPACE_SHELL_REASON, `${alias}/*`)
    }
  }
})

test('workspace guard ignores URL syntax and script operators while keeping real external file operands blocked', () => {
  const root = agent()
  const allowed = [
    `for v in 0.169.0 0.170.0; do curl -s "https://data.jsdelivr.com/v1/package/npm/three@$v/flat" | grep SSRPass; done`,
    `node -e "const https=require('https'); https.get('https://cdn.jsdelivr.net/npm/three@'+'0.170.0'+'/examples/jsm/SSRPass.js',()=>{})"`,
    "python3 - <<'PY'\nfrom PIL import Image\nim=Image.open('poolrooms-regression.png')\n# sample colors / brightness\nprint(im.size)\nPY",
    "python3 - <<'PY'\np='poolrooms-regression.png'\nd=open(p,'rb').read()\nprint((10+20)//3)\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\np = Path('src/post/SSRPass.js')\ns = p.read_text()\ns = s.replace(\"\"\"render(renderer, writeBuffer /*, deltaTime */)\"\"\", \"render(renderer)\")\np.write_text(s)\nPY",
    "python3 - <<'PY'\nprint('/etc/passwd is documentation, not a file operand')\nPY",
  ]
  for (const command of allowed) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: root,
    }), undefined, command)
  }

  for (const command of [
    "python3 - <<'PY'\nopen('/etc/passwd','rb').read()\nPY",
    "sed -n 'r /etc/passwd' input.txt",
    "sed 's/value/replacement/w /etc/passwd' input.txt",
    'ls /Applications',
  ]) {
    assert.equal(guardExecution({
      name: BOOTSTRAP_TOOLS[0],
      arguments: { command },
      agent: root,
    }), WORKSPACE_SHELL_REASON, command)
  }

  assert.equal(guardExecution({
    name: BOOTSTRAP_TOOLS[0],
    arguments: { command: 'curl -o /tmp/remote.js https://example.com/app.js' },
    agent: root,
  }), undefined)
})

test('v0.6.2 preset metadata names the general core', () => {
  const metadata = readFileSync(
    new URL('../presets/apex-v062/preset.yml', import.meta.url),
    'utf8',
  )
  assert.equal(basename(frozenV061), 'apex-v061')
  assert.match(metadata, /APEX v0\.6\.2（通用核心）/)
  assert.match(metadata, /按需开放研究、代码协作、运行验证或视觉复核/)
})
