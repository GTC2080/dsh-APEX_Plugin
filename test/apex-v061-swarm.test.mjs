import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  APEX_BUILD_DESCRIPTION,
  apply as applyBuild,
  FLASH_CHILD_PERSONA,
} from '../presets/apex-v061/apex-build.mjs'
import {
  APEX_CONTINUE_DESCRIPTION,
  APEX_TAKEOVER_DESCRIPTION,
  APEX_TAKEOVER_META_KIND,
  apply as applyContinue,
} from '../presets/apex-v061/apex-continue.mjs'
import {
  BROWSER_DOWNLOAD_REASON,
  buildDenial,
  CHILD_SHELL_RESTRICTION_REASON,
  CHILD_SCOPE_REASON,
  childShellDenial,
  childScopeDenial,
  continuationDenial,
  dependencyInstallKey,
  DUPLICATE_FETCH_REASON,
  DUPLICATE_INSTALL_REASON,
  duplicateFetchDenial,
  duplicateInstallDenial,
  guardExecution,
  hasShellHeredoc,
  hasUnmanagedBackgroundOperator,
  INSTALL_INSPECTION_REQUIRED_REASON,
  installPrerequisiteDenial,
  isBrowserDownloadCommand,
  isImplementationPath,
  isUnboundedBrowserCommand,
  remoteFetchUrls,
  ROOT_SHELL_BUDGET_REASON,
  ROOT_SHELL_HARD_LIMIT,
  rootShellBudgetDenial,
  parentTakeoverScopeDenial,
  SHELL_AUTHORING_REASON,
  SHELL_HEREDOC_REASON,
  shellImplementationWrite,
  shellCommandShape,
  SYSTEM_SETTING_REASON,
  timedOutCommandDenial,
  takeoverDenial,
  TIMED_OUT_SHAPE_REASON,
  UNMANAGED_BACKGROUND_REASON,
  workerPollingDenial,
  WORKER_POLLING_REASON,
  WORKER_LIMIT_REASON,
} from '../presets/apex-v061/execution-guard.mjs'
import {
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
} from '../presets/apex-v061/tool-gate.mjs'
import {
  explicitExternalRoots,
  literalPaths,
  WORKSPACE_READ_REASON,
  WORKSPACE_SHELL_REASON,
  WORKSPACE_WRITE_REASON,
  workspacePathDenial,
  workspaceShellDenial,
} from '../presets/apex-v061/workspace-boundary.mjs'
import {
  MAX_APEX_WORKERS,
  parseBuildArguments,
  parseContinuationArguments,
  parseContinuationMessage,
  parseTakeoverArguments,
  parseWorkItemPrompt,
  renderWorkItemPrompt,
  renderContinuationMessage,
  scopesOverlap,
} from '../presets/apex-v061/work-items.mjs'

function call(name, args, callId, step = 1) {
  return {
    type: 'tool/call',
    data: { turn: 1, step, name, callId, arguments: JSON.stringify(args) },
  }
}

function result(callId, text = 'ok', isError = false) {
  return {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text }],
        }],
      },
    },
  }
}

function resultWithMeta(callId, text, meta) {
  const event = result(callId, text)
  event.data.meta = meta
  return event
}

function agent(events = [], delegationDepth = 0, cwd = '/workspace') {
  return { session: { events, header: { delegationDepth, cwd } } }
}

function managedChild(events = [], cwd = '/workspace') {
  return {
    ...agent([{
      type: 'subagent/descriptor',
      data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'APEX code worker' },
    }, ...events], 1, cwd),
    options: { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL },
  }
}

function human(text) {
  return {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

const DEFAULT_WORK_ITEM_BODY = [
  'Goal: Implement the bounded work item.',
  'Context: Follow the parent architecture and existing interfaces.',
  'Non-goals: Do not change unrelated modules.',
  'Constraints: Edit only leased paths with str_replace_editor.',
  'Acceptance: Complete the requested behavior and one module self-check.',
  'Report: Return status, changed paths, check result, remaining work, and blockers.',
].join('\n')

function buildPrompt(id, paths, body = DEFAULT_WORK_ITEM_BODY) {
  return `APEX_WORK_ITEM ${JSON.stringify({ id, paths })}\n${body}`
}

function buildArguments(id, paths, extra = {}) {
  return {
    description: `Implement ${id}`,
    id,
    paths,
    goal: 'Implement the bounded work item.',
    context: 'Follow the parent architecture and existing interfaces.',
    non_goals: 'Do not change unrelated modules.',
    acceptance: 'Complete the requested observable behavior.',
    ...extra,
  }
}

function continueMessage(workItemId, evidence, body = 'Repair only the verified issue.') {
  return `APEX_CONTINUE ${JSON.stringify({ workItemId, evidence })}\n${body}`
}

function buildExecution(events, id, paths, callId = 'current', extra = {}) {
  return {
    name: 'apex_build',
    callId,
    arguments: buildArguments(id, paths, extra),
    agent: agent(events),
  }
}

function startedWork(id, paths, callId, childId, step = 1) {
  const args = buildArguments(id, paths)
  return [
    call('apex_build', args, callId, step),
    result(callId, `started subagent ${childId}`),
  ]
}

test('work-item headers accept only bounded relative write scopes', () => {
  assert.deepEqual(parseWorkItemPrompt(buildPrompt('water', ['src/water.js', 'src/shaders/**'])), {
    ok: true,
    value: { id: 'water', paths: ['src/water.js', 'src/shaders/**'] },
    body: DEFAULT_WORK_ITEM_BODY,
  })
  assert.match(
    parseWorkItemPrompt(buildPrompt('water', ['src/water.js'], 'Goal: implement it')).error,
    /requires non-empty sections/,
  )
  assert.equal(parseWorkItemPrompt('Build everything').ok, false)
  assert.equal(parseWorkItemPrompt(buildPrompt('all', ['**'])).ok, false)
  assert.equal(parseBuildArguments(buildArguments('all', ['**'])).ok, false)
  assert.equal(parseWorkItemPrompt(buildPrompt('water', ['/tmp/output.js'])).ok, false)
  assert.equal(parseWorkItemPrompt(buildPrompt('water', ['src/../secret.js'])).ok, false)
  assert.deepEqual(parseWorkItemPrompt(buildPrompt('single-file', ['./index.html'])).value, {
    id: 'single-file', paths: ['index.html'],
  })
  const markdownBody = [
    '## Goal',
    'Implement the bounded work item.',
    '## Context',
    'Follow the verified architecture.',
    '## Non-goals',
    'Do not change unrelated files.',
    '## Constraints',
    'Edit only leased paths.',
    '## Acceptance',
    'Run one module check.',
    '## Report',
    'Return changed paths and remaining gaps.',
  ].join('\n')
  assert.equal(parseWorkItemPrompt(buildPrompt('markdown', ['index.html'], markdownBody)).ok, true)
  const nextLineBody = DEFAULT_WORK_ITEM_BODY.replace('Goal: Implement', 'Goal:\nImplement')
  assert.equal(parseWorkItemPrompt(buildPrompt('next-line', ['index.html'], nextLineBody)).ok, true)
  assert.equal(scopesOverlap('src/**', 'src/water.js'), true)
  assert.equal(scopesOverlap('src/water.js', 'src/player.js'), false)
})

test('structured apex_build arguments are compiled into one canonical worker brief', async () => {
  let tool
  let start
  applyBuild({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subagents: {
      async startContinuable(value) {
        start = value
        return { childId: 'child-structured' }
      },
    },
  })
  const args = buildArguments('Pool Scene', ['./index.html'])
  const parsed = parseBuildArguments(args)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value.id, 'pool-scene')
  assert.deepEqual(parsed.value.paths, ['index.html'])
  const prompt = renderWorkItemPrompt(parsed.value, '/workspace')
  assert.equal(prompt.includes('Do not invoke Bash or PowerShell.'), true)
  assert.equal(prompt.includes('Never guess or probe alternative roots.'), true)
  assert.match(prompt, /bounded implementation specialist/)
  assert.match(prompt, /do not repeat an inspection unless/)
  assert.match(prompt, /APEX_WORKSPACE \{"root":"\/workspace","leases":\[\{"scope":"index\.html","kind":"file","absolute":"\/workspace\/index\.html"\}\]\}/)
  assert.match(
    renderWorkItemPrompt(parseBuildArguments(buildArguments('tree', ['src/**'])).value, 'C:\\Workspace'),
    /"scope":"src\/\*\*","kind":"directory","absolute":"C:\\\\Workspace\\\\src"/,
  )
  assert.throws(() => renderWorkItemPrompt(parsed.value, 'workspace'), /absolute workspace root/)
  assert.equal(tool.description, APEX_BUILD_DESCRIPTION)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    'acceptance', 'context', 'description', 'goal', 'id', 'non_goals', 'paths',
  ])
  assert.equal('prompt' in tool.parameters.properties, false)
  assert.equal('run_in_background' in tool.parameters.properties, false)
  assert.equal(tool.parameters.properties.context.maxLength, 8000)

  const parent = agent()
  const output = await tool.execute(args, {
    agent: parent,
    signal: new AbortController().signal,
  })
  assert.deepEqual(output, { subagentId: 'child-structured' })
  assert.equal(start.provider, 'spawn')
  assert.equal(start.request.parent, parent)
  assert.deepEqual(start.request.agentOptions, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
  })
  assert.equal(start.request.persona, FLASH_CHILD_PERSONA)
  assert.equal(start.request.maxDepth, 1)
  assert.equal(start.request.toolFilter.allow.includes('str_replace_editor'), true)
  assert.equal(start.request.toolFilter.allow.includes('read_image'), true)
  assert.deepEqual(parseWorkItemPrompt(start.request.prompt[0].text).value, {
    id: 'pool-scene', paths: ['index.html'],
  })
  assert.deepEqual(tool.output.render(args, output), [{
    type: 'text', text: 'started subagent child-structured',
  }])
})

test('apex_build accepts one detailed context and reports the actual overage', () => {
  const accepted = buildArguments('detailed', ['index.html'])
  accepted.context = 'x'.repeat(7_388)
  assert.equal(parseBuildArguments(accepted).ok, true)

  const rejected = { ...accepted, context: 'x'.repeat(8_001) }
  const parsed = parseBuildArguments(rejected)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /1-8000 characters; received 8001/)
})

test('structured apex_continue compiles one canonical repair turn without hand-authored JSON', async () => {
  let tool
  let followup
  applyContinue({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subagents: {
      async followup(...args) {
        followup = args
        return 'message-1'
      },
    },
  })
  const args = {
    child_id: 'child-1',
    work_item_id: 'water',
    evidence: ['src/water.js uses the wrong depth uniform'],
    instruction: 'Replace only the mismatched uniform and preserve the public API.',
  }
  const parsed = parseContinuationArguments(args)
  assert.equal(parsed.ok, true)
  assert.equal(parseContinuationMessage(renderContinuationMessage(parsed.value)).ok, true)
  assert.equal(tool.description, APEX_CONTINUE_DESCRIPTION)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    'child_id', 'evidence', 'instruction', 'work_item_id',
  ])
  const parentAgent = { ...agent(), id: 'parent-1' }
  const output = await tool.execute(args, {
    agent: parentAgent,
    signal: new AbortController().signal,
  })
  assert.deepEqual(output, { childId: 'child-1', messageId: 'message-1' })
  assert.equal(followup[0], parentAgent)
  assert.equal(followup[1], 'child-1')
  assert.match(followup[2][0].text, /^APEX_CONTINUE \{"workItemId":"water"/)
  assert.match(followup[2][0].text, /focused repair of the cited evidence/)
  assert.match(followup[2][0].text, /not a new design pass/)
  assert.equal(followup[3].source.senderSessionId, 'parent-1')
})

test('apex_takeover transfers one settled lease to Pro and permanently closes worker continuation', async () => {
  const args = {
    child_id: 'child-1',
    work_item_id: 'water',
    reason: 'worker_max_tokens',
    evidence: ['src/water.js still lacks the bounded runtime fix after the max-token stop'],
  }
  assert.equal(parseTakeoverArguments(args).ok, true)
  const events = [
    ...startedWork('water', ['src/water.js'], 'build-1', 'child-1'),
    {
      type: 'user/message',
      data: {
        source: { kind: 'subagent-settled', senderSessionId: 'child-1' },
        content: [{ type: 'text', text: 'worker hit max tokens' }],
      },
    },
    call('read', { file_path: '/workspace/src/water.js' }, 'read-1', 3),
    result('read-1', 'source'),
    call('apex_takeover', args, 'takeover-1', 4),
  ]
  const execution = {
    name: 'apex_takeover',
    callId: 'takeover-1',
    arguments: args,
    agent: agent(events),
  }
  assert.equal(takeoverDenial(execution), undefined)
  assert.equal(guardExecution(execution), undefined)
  assert.match(parentTakeoverScopeDenial({
    name: 'str_replace_editor',
    callId: 'pro-edit-before-transfer',
    arguments: { command: 'str_replace', path: '/workspace/src/water.js' },
    agent: agent(events.slice(0, -1)),
  }), /use apex_takeover/i)
  assert.equal(parentTakeoverScopeDenial({
    name: 'str_replace_editor',
    callId: 'pro-edit-unleased',
    arguments: { command: 'str_replace', path: '/workspace/src/player.js' },
    agent: agent(events.slice(0, -1)),
  }), undefined)
  assert.match(takeoverDenial({
    ...execution,
    agent: agent([
      ...events.slice(0, -1),
      ...startedWork('player', ['src/player.js'], 'build-2', 'child-2', 4),
      events.at(-1),
    ]),
  }), /Every current APEX worker must settle/)

  const tools = new Map()
  applyContinue({
    tools: {
      register(value) {
        tools.set(value.name, value)
        return () => {}
      },
    },
    subagents: { async followup() { return 'unused' } },
    sessionPersistence: {
      async inspect() {
        return {
          meta: { cwd: '/workspace' },
          events: [
            human(buildPrompt('water', ['src/water.js'])),
            { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 8192 } } },
            { type: 'step/end', data: { turn: 1, step: 1 } },
            { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
          ],
        }
      },
    },
  })
  const takeover = tools.get('apex_takeover')
  assert.equal(takeover.description, APEX_TAKEOVER_DESCRIPTION)
  const output = await takeover.execute(args, {
    agent: execution.agent,
    signal: new AbortController().signal,
  })
  assert.deepEqual(output.paths, ['src/water.js'])
  const meta = takeover.output.presentationMeta(args, output)
  assert.equal(meta.kind, APEX_TAKEOVER_META_KIND)

  const transferred = [...events, resultWithMeta('takeover-1', output.text, meta)]
  const allowedEdit = {
    name: 'str_replace_editor',
    callId: 'pro-edit',
    arguments: { command: 'str_replace', path: '/workspace/src/water.js' },
    agent: agent(transferred),
  }
  assert.equal(parentTakeoverScopeDenial(allowedEdit), undefined)
  assert.equal(parentTakeoverScopeDenial({
    ...allowedEdit,
    arguments: { ...allowedEdit.arguments, path: '/workspace/src/player.js' },
  }), undefined)

  const continuationArgs = {
    child_id: 'child-1',
    work_item_id: 'water',
    evidence: ['new finding'],
    instruction: 'repair it',
  }
  assert.match(continuationDenial({
    name: 'apex_continue',
    callId: 'continue-after-takeover',
    arguments: continuationArgs,
    agent: agent([
      ...transferred,
      call('apex_continue', continuationArgs, 'continue-after-takeover', 5),
    ]),
  }), /cannot be continued/)

  await assert.rejects(
    takeover.execute({ ...args, reason: 'worker_failed' }, {
      agent: execution.agent,
      signal: new AbortController().signal,
    }),
    /worker_failed requires durable stopReason/,
  )
})

test('invalid apex_build fields fail before a worker can start', () => {
  const args = buildArguments('invalid', ['index.html'])
  delete args.acceptance
  const denial = buildDenial({
    name: 'apex_build',
    callId: 'invalid-build',
    arguments: args,
    agent: agent(),
  })
  assert.match(denial, /requires exactly/)
  assert.match(denial, /host compiles the child prompt/)
})

test('fresh delegation rejects only Pro-mutated paths and permits untouched modules', async () => {
  const args = buildArguments('late-worker', ['src/late.js'])
  const successfulEdit = [
    call('str_replace_editor', {
      command: 'create', path: '/workspace/src/main.js', file_text: 'export default 1',
    }, 'direct-edit'),
    result('direct-edit'),
  ]
  const execution = buildExecution([
    ...successfulEdit,
    call('apex_build', args, 'current', 2),
  ], 'late-worker', ['src/late.js'])
  assert.equal(buildDenial(execution), undefined)
  assert.equal(guardExecution(execution), undefined)

  const overlappingArgs = buildArguments('overlap-worker', ['src/main.js'])
  const overlapExecution = {
    ...execution,
    arguments: overlappingArgs,
    agent: agent([
      ...successfulEdit,
      call('apex_build', overlappingArgs, 'overlap-current', 2),
    ]),
    callId: 'overlap-current',
  }
  assert.match(buildDenial(overlapExecution), /already mutated/)
  assert.match(guardExecution(overlapExecution), /Conflicting Pro-owned path\(s\): src\/main\.js/)

  const failedEdit = structuredClone(successfulEdit)
  failedEdit[1].data.message.content[0].isError = true
  assert.equal(buildDenial(buildExecution(failedEdit, 'early-worker', ['src/early.js'])), undefined)
  assert.equal(buildDenial(buildExecution([
    call('str_replace_editor', { command: 'view', path: '/workspace/src/main.js' }, 'view-1'),
    result('view-1'),
  ], 'after-view', ['src/view.js'])), undefined)

  let tool
  let starts = 0
  applyBuild({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subagents: {
      async startContinuable() {
        starts += 1
        return { childId: 'unexpected' }
      },
    },
  })
  const allowed = await tool.execute(args, {
    agent: agent(successfulEdit),
    signal: new AbortController().signal,
  })
  assert.deepEqual(allowed, { subagentId: 'unexpected' })
  await assert.rejects(tool.execute(overlappingArgs, {
    agent: agent(successfulEdit),
    signal: new AbortController().signal,
  }), /already mutated/)
  assert.equal(starts, 1)
})

test('root shell pauses after sixteen no-edit calls and a successful edit resets it', () => {
  const calls = []
  for (let index = 0; index < ROOT_SHELL_HARD_LIMIT; index += 1) {
    calls.push(
      call('bash', { command: `printf ${index}` }, `shell-${index}`, index + 1),
      result(`shell-${index}`),
    )
  }
  const current = call('bash', { command: 'pwd' }, 'shell-current', ROOT_SHELL_HARD_LIMIT + 1)
  const execution = {
    name: 'bash',
    callId: 'shell-current',
    arguments: { command: 'pwd' },
    agent: agent([...calls, current]),
  }
  assert.equal(rootShellBudgetDenial(execution), ROOT_SHELL_BUDGET_REASON)
  assert.equal(guardExecution(execution), ROOT_SHELL_BUDGET_REASON)

  const oneUnder = execution.agent.session.events.slice(0, -3)
  assert.equal(rootShellBudgetDenial({ ...execution, agent: agent([...oneUnder, current]) }), undefined)

  const failedEdit = [
    ...calls,
    call('str_replace_editor', {
      command: 'str_replace', path: '/workspace/index.html', old_str: 'a', new_str: 'b',
    }, 'failed-edit'),
    result('failed-edit', 'not found', true),
    current,
  ]
  assert.equal(rootShellBudgetDenial({ ...execution, agent: agent(failedEdit) }), ROOT_SHELL_BUDGET_REASON)

  const successfulEdit = structuredClone(failedEdit)
  successfulEdit.at(-2).data.message.content[0].isError = false
  assert.equal(rootShellBudgetDenial({ ...execution, agent: agent(successfulEdit) }), undefined)

  const nextTask = [...calls, human('new task'), current]
  assert.equal(rootShellBudgetDenial({ ...execution, agent: agent(nextTask) }), undefined)
})

test('continuation headers require a matching id, evidence, and bounded instruction', () => {
  const parsed = parseContinuationMessage(continueMessage('water', ['src/water.js fails the shader compile']))
  assert.equal(parsed.ok, true)
  assert.equal(parseContinuationMessage('continue').ok, false)
  assert.equal(parseContinuationMessage(continueMessage('water', [])).ok, false)
})

test('persistent Bash rejects raw background work without breaking ordinary shell syntax', () => {
  for (const command of [
    'python3 -m http.server 8000 &',
    'chromium --headless http://127.0.0.1:8000 & apex_browser_pid=$!',
    '(sleep 30; kill -TERM "$apex_browser_pid") &',
  ]) {
    assert.equal(hasUnmanagedBackgroundOperator(command), true, command)
    assert.equal(
      guardExecution({ name: 'bash', arguments: { command } }),
      UNMANAGED_BACKGROUND_REASON,
      command,
    )
  }
  for (const command of [
    'npm test && npm run lint',
    'node app.js >run.log 2>&1',
    'printf "%s\\n" "a&b"',
    'printf "a\\&b"',
  ]) assert.equal(hasUnmanagedBackgroundOperator(command), false, command)
})

test('persistent Bash rejects heredocs before they can desynchronize tool framing', () => {
  for (const command of [
    "python3 - <<'PY'\nprint('check')\nPY",
    'node <<EOF\nconsole.log(1)\nEOF',
  ]) {
    assert.equal(hasShellHeredoc(command), true, command)
    assert.equal(guardExecution({ name: 'bash', arguments: { command } }), SHELL_HEREDOC_REASON)
  }
  for (const command of [
    'cat <<< payload',
    `node -e "console.log('<<')"`,
    'node -e "console.log(1 << 2)"',
  ]) assert.equal(hasShellHeredoc(command), false, command)
})

test('POSIX and PowerShell cannot author implementation files outside the editor', () => {
  for (const path of [
    'index.html',
    'src/app.js',
    'styles/main.css',
    'README.md',
    'package.json',
    'Dockerfile',
  ]) assert.equal(isImplementationPath(path), true, path)
  for (const path of ['run.log', 'screen.png', '/dev/null']) {
    assert.equal(isImplementationPath(path), false, path)
  }

  for (const command of [
    "cat <<'EOF' > index.html\n<main>Poolrooms</main>\nEOF",
    "printf '%s' 'export default 1' > src/app.js",
    "printf '%s' body | tee styles/main.css",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('src/app.py').write_text('print(1)')\nPY",
    "python3 -c \"open('README.md', 'w').write('text')\"",
    "node -e \"require('node:fs').writeFileSync('src/app.mjs', 'export {}')\"",
    "sed -i 's/old/new/' src/app.js",
    "Set-Content -Path index.html -Value '<main />'",
    "'<main />' | Out-File -FilePath index.html",
    "[IO.File]::WriteAllText('src/app.cs', 'class App {}')",
    "Copy-Item template.html index.html",
  ]) {
    assert.equal(shellImplementationWrite(command), true, command)
    assert.equal(
      guardExecution({ name: command.includes('Content') || command.includes('Out-File') ? 'pwsh' : 'bash', arguments: { command } }),
      SHELL_AUTHORING_REASON,
      command,
    )
  }

  for (const command of [
    'cat index.html',
    'node --check src/app.js',
    "python3 -c \"open('run.log', 'w').write('ok')\"",
    "printf '%s' ok > run.log",
    'npm test',
    'Get-Content index.html',
  ]) assert.equal(shellImplementationWrite(command), false, command)
})

test('only literal paths in the latest top-level human request grant external reads', () => {
  assert.deepEqual(literalPaths('Three.js/WebGPU and https://example.com/api'), [])
  assert.deepEqual(literalPaths('const html = "</script><main>ok</main>"'), [])
  assert.deepEqual(literalPaths(String.raw`const close = /<\/script>/`), [])
  assert.deepEqual(literalPaths(String.raw`const close = /<\/script>/gi`), [])
  assert.deepEqual(literalPaths(String.raw`const color = /^hsl\(\d+\.\d{2}, 70%$/`), [])
  assert.deepEqual(literalPaths(String.raw`const html = "</script>/etc/passwd"`), ['/etc/passwd'])
  assert.deepEqual(literalPaths('请参考“/reference/My Folder/spec.md”'), [
    '/reference/My Folder/spec.md',
  ])

  const authorized = agent([human('请读取 /reference 中的资料')])
  assert.deepEqual(explicitExternalRoots(authorized).map(root => root.absolute), ['/reference'])
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/spec.md' }, agent: authorized,
  }), undefined)
  assert.equal(workspacePathDenial({
    name: 'glob', arguments: { pattern: '**/*', path: '/reference' }, agent: authorized,
  }), undefined)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference-copy/spec.md' }, agent: authorized,
  }), WORKSPACE_READ_REASON)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/other/spec.md' }, agent: authorized,
  }), WORKSPACE_READ_REASON)
  assert.equal(guardExecution({
    name: 'read', arguments: { file_path: '/other/spec.md' }, agent: authorized,
  }), WORKSPACE_READ_REASON)

  assert.equal(workspaceShellDenial({
    name: 'bash',
    arguments: { command: "rg '</script>' index.html" },
    agent: agent(),
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash',
    arguments: {
      command: String.raw`node -e "const html=''; const m=html.match(/<script>([\s\S]*?)<\/script>/);"`,
    },
    agent: agent(),
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash',
    arguments: {
      command: String.raw`node -e "const html=''; const m=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];"`,
    },
    agent: agent(),
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash',
    arguments: {
      command: String.raw`node --input-type=module -e 'console.log(/^hsl\(\d+\.\d{2}, 70%$/.test("x"))'`,
    },
    agent: agent(),
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: String.raw`node -e 'const html="</script>/etc/passwd"'` }, agent: agent(),
  }), WORKSPACE_SHELL_REASON)
  assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command: 'cat /etc/passwd' }, agent: agent(),
  }), WORKSPACE_SHELL_REASON)

  const discoveredOnly = agent([
    human('只检查当前项目'),
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'Found /reference' }] } },
    result('search-1', '/reference/spec.md'),
  ])
  assert.equal(explicitExternalRoots(discoveredOnly).length, 0)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/spec.md' }, agent: discoveredOnly,
  }), WORKSPACE_READ_REASON)

  const resetOnNextTask = agent([
    human('请读取 /reference'),
    { type: 'assistant/message', data: {} },
    human('现在继续，只检查 workspace'),
  ])
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/spec.md' }, agent: resetOnNextTask,
  }), WORKSPACE_READ_REASON)

  const child = agent([human('请读取 /reference')], 1)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/spec.md' }, agent: child,
  }), WORKSPACE_READ_REASON)

  const oneFile = agent([human('请只读取“/reference/spec.md”')])
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/spec.md' }, agent: oneFile,
  }), undefined)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/reference/other.md' }, agent: oneFile,
  }), WORKSPACE_READ_REASON)

  const broadRoot = agent([human('请读取 /')])
  assert.equal(explicitExternalRoots(broadRoot).length, 0)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: '/etc/passwd' }, agent: broadRoot,
  }), WORKSPACE_READ_REASON)
})

test('external grants are read-only while every workspace path remains usable', () => {
  const scoped = agent([human('请查看 /reference')])
  for (const execution of [
    { name: 'read', arguments: { file_path: 'src/main.js' } },
    { name: 'write', arguments: { file_path: '/workspace/src/main.js' } },
    { name: 'str_replace_editor', arguments: { command: 'view', path: '/reference/spec.md' } },
  ]) assert.equal(workspacePathDenial({ ...execution, agent: scoped }), undefined)

  for (const execution of [
    { name: 'write', arguments: { file_path: '/reference/out.md' } },
    { name: 'edit', arguments: { file_path: '/reference/spec.md' } },
    { name: 'str_replace_editor', arguments: { command: 'create', path: '/reference/out.md' } },
  ]) assert.equal(workspacePathDenial({ ...execution, agent: scoped }), WORKSPACE_WRITE_REASON)
})

test('shell paths stay workspace-only on POSIX and Windows', () => {
  const posixAgent = agent([human('请查看 /reference')])
  for (const command of [
    'rg TODO src',
    'cat /workspace/src/main.js',
    'curl https://example.com/api',
    'printf x >/dev/null',
    "sed '1d;$d' index.html | node --check /dev/stdin",
  ]) assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command }, agent: posixAgent,
  }), undefined, command)
  for (const command of [
    'find /reference -type f',
    'cat ../secret.txt',
    'cat $HOME/.config/app',
    'cat ${PROJECT_ROOT}/secret.txt',
    'cat $PWD/../secret.txt',
    'cd - && pwd',
    'curl file:///etc/passwd',
    'cat /^secret',
  ]) assert.equal(workspaceShellDenial({
    name: 'bash', arguments: { command }, agent: posixAgent,
  }), WORKSPACE_SHELL_REASON, command)

  const windowsAgent = agent([human('请查看 C:\\Reference')], 0, 'C:\\Workspace')
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: 'C:\\Reference\\spec.md' }, agent: windowsAgent,
  }), undefined)
  assert.equal(workspacePathDenial({
    name: 'write', arguments: { file_path: 'C:\\Reference\\out.md' }, agent: windowsAgent,
  }), WORKSPACE_WRITE_REASON)
  assert.equal(workspaceShellDenial({
    name: 'pwsh', arguments: { command: 'Get-ChildItem C:\\Workspace\\src' }, agent: windowsAgent,
  }), undefined)
  assert.equal(workspaceShellDenial({
    name: 'pwsh', arguments: { command: 'Get-ChildItem C:\\Reference' }, agent: windowsAgent,
  }), WORKSPACE_SHELL_REASON)
  assert.equal(workspaceShellDenial({
    name: 'pwsh', arguments: { command: 'Get-Content $env:USERPROFILE\\secret.txt' }, agent: windowsAgent,
  }), WORKSPACE_SHELL_REASON)
})

test('workspace shell denial stays generic because the trusted root is declared before execution', () => {
  const cwd = process.platform === 'win32' ? 'C:\\Workspace' : '/workspace'
  const command = process.platform === 'win32'
    ? 'Set-Location C:\\Temp; Get-ChildItem'
    : 'cd /tmp && pwd'
  const reason = guardExecution({
    name: process.platform === 'win32' ? 'pwsh' : 'bash',
    arguments: { command },
    agent: agent([], 0, cwd),
  })
  assert.equal(
    reason,
    WORKSPACE_SHELL_REASON,
  )
})

test('canonical containment blocks a workspace symlink that escapes its root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v061-boundary-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const scoped = agent([human('只检查 workspace')], 0, workspace)
  assert.equal(workspacePathDenial({
    name: 'read', arguments: { file_path: join(workspace, 'linked', 'secret.txt') }, agent: scoped,
  }), WORKSPACE_READ_REASON)
  assert.equal(workspaceShellDenial({
    name: process.platform === 'win32' ? 'pwsh' : 'bash',
    arguments: { command: process.platform === 'win32'
      ? 'Get-Content linked\\secret.txt'
      : 'cat linked/secret.txt' },
    agent: scoped,
  }), WORKSPACE_SHELL_REASON)
})

test('headless browser validation requires a foreground child-process deadline', () => {
  const browser = 'chromium --headless --dump-dom http://127.0.0.1:8000'
  assert.equal(isUnboundedBrowserCommand(browser), true)
  assert.equal(isUnboundedBrowserCommand(`timeout 45s ${browser}`), false)
  assert.equal(isUnboundedBrowserCommand([
    "python3 - <<'PY'",
    'import subprocess',
    `subprocess.run(['chromium', '--headless', '--dump-dom', 'http://127.0.0.1:8000'], timeout=45, check=True)`,
    'PY',
  ].join('\n')), false)
})

test('browser payload downloads are redirected to the host validator', () => {
  for (const command of [
    'npx playwright install chromium',
    'pnpm exec playwright install --with-deps chromium',
    'python3 -m playwright install chromium',
    'npx puppeteer browsers install chrome',
  ]) {
    assert.equal(isBrowserDownloadCommand(command), true, command)
    assert.equal(guardExecution({ name: 'bash', arguments: { command } }), BROWSER_DOWNLOAD_REASON)
  }
  assert.equal(isBrowserDownloadCommand('npm install playwright'), false)
  assert.equal(isBrowserDownloadCommand('node --test'), false)
})

test('system settings and timed-out command shapes fail before another dispatch', () => {
  const system = {
    name: 'bash',
    arguments: { command: 'safaridriver --enable' },
    agent: agent(),
  }
  assert.equal(guardExecution(system), SYSTEM_SETTING_REASON)

  const events = [
    call('bash', { command: "node -e 'await new Promise(() => {})'" }, 'probe-1'),
    result('probe-1', 'Command timed out after 300000 ms', true),
    call('bash', { command: 'node -e "console.log(42)"' }, 'probe-2', 2),
  ]
  const retry = {
    name: 'bash',
    callId: 'probe-2',
    arguments: { command: 'node -e "console.log(42)"' },
    agent: agent(events),
  }
  assert.equal(shellCommandShape(events[0].data ? JSON.parse(events[0].data.arguments).command : ''), 'node-inline-check')
  assert.equal(timedOutCommandDenial(retry), TIMED_OUT_SHAPE_REASON)
  assert.equal(guardExecution(retry), TIMED_OUT_SHAPE_REASON)
})

test('an unchanged dependency installation cannot loop within one human task', () => {
  assert.equal(dependencyInstallKey('cd app && npm install'), 'cd app && npm install')
  assert.equal(dependencyInstallKey('yarn install --frozen-lockfile'), 'yarn install --frozen-lockfile')
  assert.equal(dependencyInstallKey('npm run build'), undefined)
  assert.equal(
    dependencyInstallKey('npm --cache .cache/npm install selenium-webdriver'),
    'npm --cache .cache/npm install selenium-webdriver',
  )
  const events = [
    call('str_replace_editor', {
      command: 'view',
      path: '/workspace/app/package.json',
    }, 'manifest-read'),
    result('manifest-read', '{"dependencies":{}}'),
    call('bash', { command: 'cd app && npm install' }, 'install-1'),
    result('install-1', 'installed'),
    call('bash', { command: '  cd app  &&  npm install  ' }, 'install-2', 2),
  ]
  const execution = {
    name: 'bash',
    callId: 'install-2',
    arguments: { command: '  cd app  &&  npm install  ' },
    agent: agent(events),
  }
  assert.equal(duplicateInstallDenial(execution), DUPLICATE_INSTALL_REASON)
  assert.equal(guardExecution(execution), DUPLICATE_INSTALL_REASON)

  const afterManifestChange = [
    ...events.slice(0, 4),
    call('str_replace_editor', {
      command: 'str_replace',
      path: '/workspace/app/package.json',
    }, 'manifest-edit', 2),
    result('manifest-edit', 'updated'),
    events.at(-1),
  ]
  assert.equal(duplicateInstallDenial({
    ...execution,
    agent: agent(afterManifestChange),
  }), undefined)

  const nextTask = [
    ...events.slice(0, 4),
    { type: 'user/message', data: { source: { kind: 'user' } } },
    events.at(-1),
  ]
  assert.equal(duplicateInstallDenial({ ...execution, agent: agent(nextTask) }), undefined)
})

test('dependency installation belongs to Pro after a successful manifest inspection', () => {
  const install = call('bash', { command: 'npm install' }, 'install-current', 2)
  const withoutInspection = {
    name: 'bash',
    callId: 'install-current',
    arguments: { command: 'npm install' },
    agent: agent([install]),
  }
  assert.equal(installPrerequisiteDenial(withoutInspection), INSTALL_INSPECTION_REQUIRED_REASON)
  assert.equal(guardExecution(withoutInspection), INSTALL_INSPECTION_REQUIRED_REASON)

  const compoundBootstrap = {
    ...withoutInspection,
    arguments: { command: 'npm init -y && npm install three@0.170.0' },
  }
  assert.equal(installPrerequisiteDenial(compoundBootstrap), INSTALL_INSPECTION_REQUIRED_REASON)
  assert.equal(guardExecution(compoundBootstrap), INSTALL_INSPECTION_REQUIRED_REASON)

  const namedOnly = [
    call('bash', { command: 'printf "%s\\n" package.json' }, 'manifest-name'),
    result('manifest-name', 'package.json'),
    install,
  ]
  assert.equal(
    installPrerequisiteDenial({ ...withoutInspection, agent: agent(namedOnly) }),
    INSTALL_INSPECTION_REQUIRED_REASON,
  )

  const inspected = [
    call('bash', { command: 'sed -n 1,160p package.json' }, 'manifest-read'),
    result('manifest-read', '{"dependencies":{}}'),
    install,
  ]
  assert.equal(installPrerequisiteDenial({ ...withoutInspection, agent: agent(inspected) }), undefined)

  const child = { ...withoutInspection, agent: managedChild([install]) }
  assert.equal(childShellDenial(child), CHILD_SHELL_RESTRICTION_REASON)
  assert.equal(guardExecution(child), CHILD_SHELL_RESTRICTION_REASON)
  assert.equal(childShellDenial({
    ...child,
    arguments: { command: 'curl -fsSL https://example.com/source.js' },
  }), CHILD_SHELL_RESTRICTION_REASON)
  assert.equal(childShellDenial({
    ...child,
    arguments: { command: 'node --check src/main.js' },
  }), CHILD_SHELL_RESTRICTION_REASON)
})

test('an exact remote URL is acquired once per human task and failed attempts may retry', () => {
  const url = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'
  assert.deepEqual(remoteFetchUrls(`curl -fsSL '${url}#symbols'`), [url])
  assert.deepEqual(remoteFetchUrls(`rg '${url}' index.html`), [])
  assert.deepEqual(remoteFetchUrls('curl -fsS http://127.0.0.1:4173/index.html'), [])
  assert.deepEqual(remoteFetchUrls('curl -fsS http://localhost:4173/index.html'), [])

  const successful = [
    call('bash', { command: `curl -fsSL '${url}' | rg 'Plane'` }, 'fetch-1'),
    result('fetch-1', 'class Plane'),
    call('bash', { command: `curl -fsSL '${url}' | rg 'Frustum'` }, 'fetch-2', 2),
  ]
  const execution = {
    name: 'bash',
    callId: 'fetch-2',
    arguments: { command: `curl -fsSL '${url}' | rg 'Frustum'` },
    agent: agent(successful),
  }
  assert.equal(duplicateFetchDenial(execution), DUPLICATE_FETCH_REASON)
  assert.equal(guardExecution(execution), DUPLICATE_FETCH_REASON)

  const failed = [...successful]
  failed[1] = result('fetch-1', 'network failed', true)
  assert.equal(duplicateFetchDenial({ ...execution, agent: agent(failed) }), undefined)
  assert.equal(duplicateFetchDenial({
    ...execution,
    arguments: { command: 'curl -fsSL https://example.com/other.js' },
  }), undefined)
  assert.equal(duplicateFetchDenial({
    ...execution,
    arguments: { command: `curl -fsSL '${url}' && wget '${url}'` },
    agent: agent(),
  }), DUPLICATE_FETCH_REASON)

  const nextTask = [
    ...successful.slice(0, 2),
    human('new task'),
    successful.at(-1),
  ]
  assert.equal(duplicateFetchDenial({ ...execution, agent: agent(nextTask) }), undefined)
})

test('fresh workers must be continuable and keep disjoint write leases', () => {
  const first = startedWork('water', ['src/water.js'], 'build-1', 'child-1')
  assert.equal(buildDenial(buildExecution(first, 'player', ['src/player.js'])), undefined)
  assert.equal(
    buildDenial(buildExecution(first, 'water-copy', ['src/water.js'])),
    'APEX v0.6.1 blocked overlapping write leases between "water" and "water-copy". Resume the existing worker or choose disjoint paths.',
  )
  assert.match(buildDenial(buildExecution(first, 'water', ['src/other.js'])), /already exists/)
  assert.match(
    buildDenial(buildExecution([], 'water', ['src/water.js'], 'current', { unexpected: true })),
    /requires exactly/,
  )
})

test('a pending worker replaces bare shell sleep with lifecycle waiting', () => {
  const active = [
    ...startedWork('water', ['src/water.js'], 'build-1', 'child-1'),
    call('bash', { command: 'sleep 2' }, 'sleep-current', 3),
  ]
  const execution = {
    name: 'bash',
    callId: 'sleep-current',
    arguments: { command: 'sleep 2' },
    agent: agent(active),
  }
  assert.equal(workerPollingDenial(execution), WORKER_POLLING_REASON)
  assert.equal(guardExecution(execution), WORKER_POLLING_REASON)

  const settled = [
    ...active.slice(0, -1),
    {
      type: 'user/message',
      data: { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } },
    },
    active.at(-1),
  ]
  assert.equal(workerPollingDenial({ ...execution, agent: agent(settled) }), undefined)
  assert.equal(workerPollingDenial({ ...execution, arguments: { command: 'sleep 2 && npm test' } }), undefined)
})

test('one step starts at most two workers and one task starts at most four', () => {
  const twoSameStep = [
    ...startedWork('one', ['one.js'], 'build-1', 'child-1', 7),
    ...startedWork('two', ['two.js'], 'build-2', 'child-2', 7),
    call('apex_build', buildArguments('three', ['three.js']), 'current', 7),
  ]
  assert.match(buildDenial(buildExecution(twoSameStep, 'three', ['three.js'])), /at most two/)

  const four = []
  for (let index = 0; index < MAX_APEX_WORKERS; index += 1) {
    four.push(...startedWork(
      `work-${index}`,
      [`file-${index}.js`],
      `build-${index}`,
      `child-${index}`,
      index + 1,
    ))
  }
  assert.equal(buildDenial(buildExecution(four, 'fifth', ['fifth.js'])), WORKER_LIMIT_REASON)
})

test('pending starts reserve leases while failed starts release them', () => {
  const pending = [
    call('apex_build', buildArguments('one', ['one.js']), 'build-1', 7),
    call('apex_build', buildArguments('two', ['two.js']), 'build-2', 7),
    call('apex_build', buildArguments('three', ['three.js']), 'current', 7),
  ]
  assert.match(buildDenial(buildExecution(pending, 'three', ['three.js'])), /at most two/)

  const failed = [
    call('apex_build', buildArguments('water', ['src/water.js']), 'build-failed'),
    result('build-failed', 'provider unavailable', true),
  ]
  assert.equal(buildDenial(buildExecution(failed, 'water', ['src/water.js'])), undefined)
})

test('Flash mutations cannot escape the work-item lease', () => {
  const child = managedChild([{
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: buildPrompt('water', ['src/water.js']) }],
    },
  }])
  assert.equal(childScopeDenial({
    name: 'str_replace_editor',
    arguments: { command: 'str_replace', path: '/workspace/src/water.js' },
    agent: child,
  }), undefined)
  assert.equal(childScopeDenial({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: '/workspace/src/player.js' },
    agent: child,
  }), CHILD_SCOPE_REASON)
  assert.equal(childScopeDenial({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: '/tmp/outside.js' },
    agent: child,
  }), CHILD_SCOPE_REASON)
})

test('a worker resumes only after feedback, workspace inspection, and new evidence', () => {
  const events = [
    ...startedWork('water', ['src/water.js'], 'build-1', 'child-1'),
    {
      type: 'user/message',
      data: {
        source: { kind: 'subagent-settled', senderSessionId: 'child-1' },
        content: [{ type: 'text', text: 'worker settled' }],
      },
    },
    call('read', { file_path: '/workspace/src/water.js' }, 'read-1', 3),
    result('read-1', 'source'),
    call('send_message', {
      subagent_id: 'child-1',
      message: continueMessage('water', ['src/water.js has an invalid uniform']),
    }, 'send-current', 4),
  ]
  const execution = {
    name: 'send_message',
    callId: 'send-current',
    arguments: {
      subagent_id: 'child-1',
      message: continueMessage('water', ['src/water.js has an invalid uniform']),
    },
    agent: agent(events),
  }
  assert.equal(continuationDenial(execution), undefined)

  const shellOnly = [
    ...events.slice(0, -3),
    call('bash', { command: 'sed -n 1,200p src/water.js' }, 'shell-read', 3),
    result('shell-read', 'source'),
    events.at(-1),
  ]
  assert.match(continuationDenial({ ...execution, agent: agent(shellOnly) }), /shell output alone/)

  const outsideScope = [
    ...events.slice(0, -3),
    call('read', { file_path: '/workspace/src/player.js' }, 'read-outside', 3),
    result('read-outside', 'source'),
    events.at(-1),
  ]
  assert.match(continuationDenial({ ...execution, agent: agent(outsideScope) }), /leased paths/)

  const withoutInspection = events.filter(event => (
    event.data?.callId !== 'read-1'
    && !(event.type === 'tool/result' && event.data?.message?.content?.[0]?.toolCallId === 'read-1')
  ))
  assert.match(continuationDenial({ ...execution, agent: agent(withoutInspection) }), /No successful read/)

  const priorSend = call('send_message', execution.arguments, 'send-1', 4)
  const duplicate = [
    ...events.slice(0, -1),
    priorSend,
    result('send-1', 'message queued'),
    events.at(-1),
  ]
  assert.match(continuationDenial({ ...execution, agent: agent(duplicate) }), /no new inspection evidence/)
})

test('apex_continue uses the same ownership, inspection, and fresh-evidence guard', () => {
  const args = {
    child_id: 'child-1',
    work_item_id: 'water',
    evidence: ['src/water.js has a mismatched depth uniform'],
    instruction: 'Repair only the verified uniform mismatch.',
  }
  const events = [
    ...startedWork('water', ['src/water.js'], 'build-1', 'child-1'),
    {
      type: 'user/message',
      data: {
        source: { kind: 'subagent-settled', senderSessionId: 'child-1' },
        content: [{ type: 'text', text: 'worker settled' }],
      },
    },
    call('read', { file_path: '/workspace/src/water.js' }, 'read-1', 3),
    result('read-1', 'source'),
    call('apex_continue', args, 'continue-current', 4),
  ]
  const execution = {
    name: 'apex_continue',
    callId: 'continue-current',
    arguments: args,
    agent: agent(events),
  }
  assert.equal(continuationDenial(execution), undefined)
  assert.equal(guardExecution(execution), undefined)
  assert.match(continuationDenial({
    ...execution,
    arguments: { ...args, work_item_id: 'other' },
  }), /does not match/)
})
