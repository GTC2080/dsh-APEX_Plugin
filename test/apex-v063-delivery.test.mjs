import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  apply as applyDeliveryVerification,
  DELIVERY_META_KIND,
  normalizeDeliveryContract,
} from '../presets/apex-v063/apex-delivery.mjs'
import { hostEvidencePath } from '../presets/apex-v063/apex-evidence.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  WEB_VALIDATION_META_KIND,
} from '../presets/apex-v063/tool-gate.mjs'
import { APEX_POLICY } from '../presets/apex-v063/apex-policy.mjs'
import { CAPABILITY_DIRECTORY } from '../presets/apex-v063/dev-tool-search.mjs'

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

function deliveryRuntime() {
  let tool
  applyDeliveryVerification({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
  })
  return tool
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

const catalog = [
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'str_replace_editor', description: 'View and edit files' },
  { name: 'dev_tool_search', description: 'Discover optional tools' },
  { name: 'apex_verify_delivery', description: 'Verify explicit delivery constraints' },
]

async function assemble(scopedAgent) {
  return gateListener()(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools: catalog }),
  )
}

const contract = Object.freeze({
  root: '.',
  exact_files: ['index.html', 'RESEARCH_REPORT.md'],
  content_unconstrained_files: ['index.html'],
  file_count_checks: [],
  max_character_checks: [{ path: 'RESEARCH_REPORT.md', maximum: 900 }],
  required_literal_checks: [{
    path: 'RESEARCH_REPORT.md',
    literals: ['同步抛'],
  }],
})

test('delivery guidance covers inspection-only evidence and complete contract reuse', () => {
  const description = deliveryRuntime().description
  assert.match(description, /before reporting an inspection-only audit/)
  assert.match(description, /every supported explicit constraint from every named deliverable/)
  assert.match(description, /account for every file exactly once/)
  assert.match(description, /content_unconstrained_files/)
  assert.match(description, /page title, heading, label, or body message is required wording/)
  assert.match(description, /Prefer this single bounded host check over reconstructing the same represented checks in Bash/)
  assert.match(description, /identical complete contract only after the artifact changes/)
  assert.match(description, /Do not infer, translate, weaken, or invent constraints/)

  assert.match(APEX_POLICY, /before reporting an inspection-only turn/)
  assert.match(APEX_POLICY, /every supported stated constraint from every named deliverable/)
  assert.match(APEX_POLICY, /Account for every exact file in a text check or content_unconstrained_files/)
  assert.match(APEX_POLICY, /Explicit titles, labels, and body messages count as required literals/)
  assert.match(APEX_POLICY, /Prefer that single bounded check over rebuilding the same checks in Bash/)
  assert.match(APEX_POLICY, /identical complete contract only after the artifact changes/)

  assert.doesNotMatch(CAPABILITY_DIRECTORY, /apex_verify_delivery/)
  assert.match(CAPABILITY_DIRECTORY, /apex_research/)
  assert.match(CAPABILITY_DIRECTORY, /apex_validate_web/)
  assert.match(CAPABILITY_DIRECTORY, /already-installed browser/)
  assert.match(CAPABILITY_DIRECTORY, /do not probe application paths or install one/)
})

test('delivery verification appears only after Minimal promotion and a workspace artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = await assemble(agent([], root))
  assert.deepEqual(first.tools.map(tool => tool.name).sort(), [...BOOTSTRAP_TOOLS].sort())

  const promotedEmpty = await assemble(agent([...successfulCall(BOOTSTRAP_TOOLS[0])], root))
  assert.equal(promotedEmpty.tools.some(tool => tool.name === 'apex_verify_delivery'), false)

  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  const promotedArtifact = await assemble(agent([...successfulCall(BOOTSTRAP_TOOLS[0])], root))
  assert.equal(promotedArtifact.tools.some(tool => tool.name === 'apex_verify_delivery'), true)
})

test('delivery verification stays hidden while a worker can still mutate the artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-worker-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>in progress</main>')
  const events = [
    ...successfulCall(BOOTSTRAP_TOOLS[0]),
    { type: 'tool/call', data: { name: 'apex_build', callId: 'build-1', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'build-1',
            isError: false,
            content: [{ type: 'text', text: 'started subagent child-1' }],
          }],
        },
      },
    },
  ]

  const assembled = await assemble(agent(events, root))
  assert.equal(assembled.tools.some(tool => tool.name === 'apex_verify_delivery'), false)
  await assert.rejects(deliveryRuntime().execute({
    root: '.',
    exact_files: [],
    content_unconstrained_files: [],
    file_count_checks: [{ relation: 'at-least', count: 1 }],
    max_character_checks: [],
    required_literal_checks: [],
  }, {
    agent: agent(events, root),
    signal: new AbortController().signal,
  }), /worker to settle and report evidence/)
})

test('delivery verification proves an exact file set, character limit, and required literal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-pass-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  writeFileSync(join(root, 'RESEARCH_REPORT.md'), '采用同步抛可以保持错误时序。\n')
  const scopedAgent = agent([], root)
  const tool = deliveryRuntime()

  const result = await tool.execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.cached, false)
  assert.equal(result.fileCount, 2)
  assert.equal(result.checks.length, 3)
  assert.equal(result.checks.every(check => check.passed), true)
  const meta = tool.output.presentationMeta(contract, result)
  assert.equal(meta.kind, DELIVERY_META_KIND)
  assert.equal(meta.status, 'passed')
  assert.deepEqual(meta.failedCheckIds, [])
})

test('delivery file-set checks exclude untouched inputs that predate the human task', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'reference'), 'read-only task input')
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  const events = [{
    type: 'user/message',
    time: Date.now() + 1_000,
    data: { source: { kind: 'user' } },
  }]

  const result = await deliveryRuntime().execute({
    root: '.',
    exact_files: ['index.html'],
    content_unconstrained_files: ['index.html'],
    file_count_checks: [{ relation: 'exactly', count: 1 }],
    max_character_checks: [],
    required_literal_checks: [],
  }, {
    agent: agent(events, root),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.fileCount, 1)
  assert.equal(result.checks.every(check => check.passed), true)
})

test('delivery verification reports every repairable mismatch without throwing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  writeFileSync(join(root, 'RESEARCH_REPORT.md'), 'x'.repeat(901))
  writeFileSync(join(root, 'notes.txt'), 'unexpected')
  const tool = deliveryRuntime()

  const result = await tool.execute(contract, {
    agent: agent([], root),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.checks.length, 3)
  assert.equal(result.checks.every(check => check.passed === false), true)
  assert.match(result.text, /unexpected: "notes\.txt"/)
  assert.match(result.text, /901/)
  assert.match(result.text, /同步抛/)
})

test('host evidence stays external while a legacy workspace screenshot fails the exact file set', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  writeFileSync(join(root, 'RESEARCH_REPORT.md'), '同步抛')
  const screenshotPath = '.apex-evidence/runtime-proof.png'
  const scopedAgent = agent([{
    type: 'tool/result',
    data: {
      meta: {
        kind: WEB_VALIDATION_META_KIND,
        screenshotPath,
      },
    },
  }], root)
  scopedAgent.session.header.id = 'delivery-host-evidence'
  const physical = hostEvidencePath(scopedAgent, screenshotPath)
  assert.ok(physical)
  t.after(() => rmSync(dirname(physical), { recursive: true, force: true }))
  mkdirSync(dirname(physical), { recursive: true })
  writeFileSync(physical, 'host evidence')

  const external = await deliveryRuntime().execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(external.status, 'passed')
  assert.equal(external.fileCount, 2)

  mkdirSync(join(root, '.apex-evidence'))
  writeFileSync(join(root, screenshotPath), 'legacy workspace evidence')
  const polluted = await deliveryRuntime().execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(polluted.status, 'failed')
  assert.equal(polluted.fileCount, 3)
  assert.match(polluted.text, /unexpected: "\.apex-evidence\/runtime-proof\.png"/)
})

test('delivery verification checks an explicit file count without inventing names', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-count-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'first.txt'), 'one')
  writeFileSync(join(root, 'second.txt'), 'two')

  const result = await deliveryRuntime().execute({
    root: '.',
    exact_files: [],
    content_unconstrained_files: [],
    file_count_checks: [{ relation: 'exactly', count: 2 }],
    max_character_checks: [],
    required_literal_checks: [],
  }, {
    agent: agent([], root),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.checks[0].kind, 'file-count')
  assert.equal(result.checks[0].actual, '2 file(s)')
})

test('same contract and artifact are cached, while an edit creates new evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  writeFileSync(join(root, 'RESEARCH_REPORT.md'), '同步抛')
  const scopedAgent = agent([], root)
  const tool = deliveryRuntime()

  const first = await tool.execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  scopedAgent.session.events.push({
    type: 'tool/result',
    data: { meta: tool.output.presentationMeta(contract, first) },
  })
  const duplicate = await tool.execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(duplicate.cached, true)
  assert.equal(duplicate.artifactHash, first.artifactHash)

  writeFileSync(join(root, 'RESEARCH_REPORT.md'), '同步抛，修订后的证据。')
  const changed = await tool.execute(contract, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(changed.cached, false)
  assert.notEqual(changed.artifactHash, first.artifactHash)
})

test('semantically identical relative paths and literal sets normalize to one contract', () => {
  const first = normalizeDeliveryContract({
    root: './',
    exact_files: ['RESEARCH_REPORT.md', 'index.html'],
    content_unconstrained_files: ['index.html'],
    file_count_checks: [{ relation: 'at-most', count: 2 }],
    max_character_checks: [{ path: './RESEARCH_REPORT.md', maximum: 900 }],
    required_literal_checks: [{ path: 'RESEARCH_REPORT.md', literals: ['二', '一'] }],
  })
  const second = normalizeDeliveryContract({
    root: '.',
    exact_files: ['index.html', 'RESEARCH_REPORT.md'],
    content_unconstrained_files: ['index.html'],
    file_count_checks: [{ count: 2, relation: 'at-most' }],
    max_character_checks: [{ path: 'RESEARCH_REPORT.md', maximum: 900 }],
    required_literal_checks: [{ path: 'RESEARCH_REPORT.md', literals: ['一', '二'] }],
  })
  assert.deepEqual(first, second)
})

test('the exact absolute workspace root normalizes to dot while other absolute paths remain invalid', () => {
  const root = '/workspace/current-task'
  const exact = normalizeDeliveryContract({
    ...contract,
    root,
  }, agent([], root))
  assert.equal(exact.root, '.')

  assert.equal(normalizeDeliveryContract({
    ...contract,
    root: `${root}/nested`,
  }, agent([], root)), undefined)
  assert.equal(normalizeDeliveryContract({
    ...contract,
    root: '/workspace/other-task',
  }, agent([], root)), undefined)
  assert.equal(normalizeDeliveryContract({
    ...contract,
    root,
  }), undefined)

  const windows = normalizeDeliveryContract({
    ...contract,
    root: 'C:\\Workspace\\Current-Task',
  }, agent([], 'c:\\workspace\\current-task'))
  assert.equal(windows.root, '.')
})

test('complete file sets require per-file text coverage or an explicit unconstrained declaration', () => {
  const base = {
    root: '.',
    exact_files: ['DELIVERY_NOTE.md', 'index.html'],
    file_count_checks: [],
    max_character_checks: [{ path: 'DELIVERY_NOTE.md', maximum: 120 }],
    required_literal_checks: [{ path: 'DELIVERY_NOTE.md', literals: ['完成'] }],
  }

  assert.throws(() => normalizeDeliveryContract({
    ...base,
    content_unconstrained_files: [],
  }), /every exact_files path to be covered/)

  const complete = normalizeDeliveryContract({
    ...base,
    content_unconstrained_files: ['index.html'],
  })
  assert.deepEqual(complete.contentUnconstrainedFiles, ['index.html'])

  assert.throws(() => normalizeDeliveryContract({
    ...base,
    content_unconstrained_files: ['DELIVERY_NOTE.md', 'index.html'],
  }), /cannot overlap text checks/)
})

test('delivery verification rejects empty contracts and paths outside the artifact root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v063-delivery-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<main>ready</main>')
  const tool = deliveryRuntime()
  const exec = { agent: agent([], root), signal: new AbortController().signal }

  await assert.rejects(tool.execute({
    root: '.',
    exact_files: [],
    content_unconstrained_files: [],
    file_count_checks: [],
    max_character_checks: [],
    required_literal_checks: [],
  }, exec), /at least one explicit check/)

  await assert.rejects(tool.execute({
    root: '.',
    exact_files: ['../outside.txt'],
    content_unconstrained_files: [],
    file_count_checks: [],
    max_character_checks: [],
    required_literal_checks: [],
  }, exec), /workspace-relative file path/)
})
