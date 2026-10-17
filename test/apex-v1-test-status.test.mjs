import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as status from '../presets/apex-v1/execution-status.mjs'
import { feedbackReportPath } from '../presets/apex-v1/native-feedback.mjs'
import { harnessAvailable, harnessRoot, native, nativeHarness, pluginRoot, textResponse, toolResponse } from './helpers/harness-v1.mjs'

const real = { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 60000 }
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const observations = agent => agent.session.snapshotEvents().filter(event =>
  event.type === 'user/message' && event.data.source?.kind === status.name)

test('APEX and official PTC preserve shell status without inventing hidden child failures', real, async t => {
  const h = await nativeHarness(undefined, { shippedPresets: true })
  let observer
  try {
    observer = await h.ctx.plugin(status)
    const failure = `${quote(process.execPath)} -e 'process.exit(7)' | tail -n 1`
    const cases = [
      ['pipeline masks failure', failure, 0],
      ['pipefail preserves failure', `set -o pipefail; ${failure}`, 7],
      ['trailing echo masks pipefail', `set -o pipefail; ${failure}; echo "TEST_EXIT=\${PIPESTATUS[0]}"`, 0],
      ['saved status is explicitly returned', `set -o pipefail; ${failure}; test_status=\${PIPESTATUS[0]}; echo "TEST_EXIT=$test_status"; exit "$test_status"`, 7],
    ]
    for (const preset of ['apex-v1', 'ptc']) {
      const agent = await h.create(`shell-status-${preset}`, preset)
      let expectedNotes = 0
      for (const [label, command, exitCode] of cases) await t.test(`${preset}: ${label}`, async () => {
        const result = await h.runCode(agent, 'return await tools.bash(' + JSON.stringify({ command, description: label }) + ');')
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(result.value.result.kind, 'foreground')
        assert.equal(result.value.result.exitCode, exitCode)
        assert.equal(result.value.result.signal, null)
        assert.equal(result.value.result.timedOut, false)
        if (command.includes('TEST_EXIT')) assert.match(result.value.result.stdout.text, /TEST_EXIT=7/)
        if (preset === 'apex-v1' && exitCode !== 0) expectedNotes++
        assert.equal(observations(agent).length, expectedNotes)
      })
    }
    t.diagnostic(JSON.stringify({ shellCases: 8, apexObservations: 2, officialObservations: 0, realModelRequests: 0 }))
  } finally {
    try { await observer?.dispose() } finally { await h.close() }
  }
  await assert.rejects(access(h.root), { code: 'ENOENT' })
})

// Fixed test-runner events provide evidence; candidate stdout is never parsed as a result.
const checkerSource = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export default async function* reporter(events) {
  const checks = []; let summary;
  for await (const event of events) {
    if (['test:pass', 'test:fail'].includes(event.type) && event.data.name === 'double input') {
      checks.push(event.type === 'test:pass');
    }
    if (event.type === 'test:summary' && event.data.file === undefined) {
      summary = { success: event.data.success, counts: event.data.counts };
    }
  }
  yield JSON.stringify({ summary, checks });
}
if (process.argv[2] === '--evaluate') {
  const mode = process.argv[3];
  const scripts = { empty: 'process.exit(0)', signal: 'process.kill(process.pid, "SIGTERM")', timeout: 'setTimeout(() => {}, 60000)' };
  const args = Object.hasOwn(scripts, mode) ? ['-e', scripts[mode]]
    : ['--test', '--test-reporter=' + fileURLToPath(import.meta.url), fileURLToPath(new URL('./assertions.test.mjs', import.meta.url))];
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', maxBuffer: 65536,
    timeout: mode === 'timeout' ? 200 : 3000, killSignal: 'SIGKILL' });
  assert.equal(child.error, undefined, 'Runner execution did not complete');
  assert.equal(child.signal, null, 'Runner was interrupted');
  assert.ok([0, 1].includes(child.status), 'Unexpected runner exit');
  assert.ok(child.stdout.trim(), 'Missing runner summary');
  const { summary, checks } = JSON.parse(child.stdout);
  assert.ok(summary && Array.isArray(checks), 'Missing runner events');
  assert.equal(summary.counts.tests, 1);
  assert.equal(summary.counts.passed + summary.counts.failed, 1);
  for (const key of ['cancelled', 'skipped', 'todo']) assert.equal(summary.counts[key], 0);
  assert.equal(checks.length, 1);
  assert.equal(checks.filter(Boolean).length, summary.counts.passed);
  assert.equal(summary.success, summary.counts.failed === 0);
  assert.equal(summary.success, child.status === 0);
  console.log(JSON.stringify({ measurementComplete: true, checks: [{ id: 'tests', passed: child.status === 0,
    expected: { exitCode: 0, tests: 1, passed: 1 }, actual: { exitCode: child.status, signal: child.signal, summary } }] }));
}
`

test('published self-test examples propagate assertion and counter failures through APEX', real, async t => {
  const doc = await readFile(join(pluginRoot, 'docs/NATIVE-FEEDBACK.md'), 'utf8')
  const assertions = doc.match(/```js\n(\/\/ selfcheck\.test\.mjs\n[\s\S]*?)\n```/)?.[1]
  const counterExit = doc.match(/```js\n(if \(fails\.length > 0\) process\.exitCode = 1;)\n```/)?.[1]
  assert.ok(assertions, 'Documented assertion example is required')
  assert.ok(counterExit, 'Documented counter failure handling is required')
  const h = await nativeHarness()
  try {
    const agent = await h.create('self-test-failure-contract')
    const reporter = join(h.cwd, 'reporter.mjs')
    const file = join(h.cwd, 'selfcheck.test.mjs')
    await writeFile(reporter, checkerSource)
    const cases = [
      { name: 'printed failure exits zero', source: 'console.log("FAIL double input");', exit: 0 },
      { name: 'test flag cannot turn logs into assertions', source: 'console.log("FAIL double input");', runner: true, exit: 0, checks: [] },
      { name: 'assertion accepts correct output', source: assertions, runner: true, solver: 4, exit: 0, checks: [true] },
      { name: 'assertion rejects wrong output', source: assertions, runner: true, solver: 3, exit: 1, checks: [false] },
      { name: 'counter preserves success', failed: false, exit: 0 },
      { name: 'counter reports failure after cleanup', failed: true, exit: 1 },
      { name: 'counter does not clear an earlier error', failed: false, priorExit: 7, exit: 7 },
    ]
    for (const item of cases) await t.test(item.name, async () => {
      const source = item.source ?? `const fails = ${JSON.stringify(item.failed ? ['double input'] : [])};
process.exitCode = ${item.priorExit ?? 0};
console.log(JSON.stringify({ failed: fails.length }));
${counterExit}
await new Promise(resolve => setTimeout(resolve, 1));
console.log('cleanup completed');`
      await writeFile(file, source)
      if (item.solver !== undefined) await writeFile(join(h.cwd, 'solver.mjs'), `export const solve = () => ${item.solver};\n`)
      const args = item.runner ? ['--test', `--test-reporter=${reporter}`, file] : [file]
      const command = `unset NODE_TEST_CONTEXT; ${[process.execPath, ...args].map(quote).join(' ')}`
      const result = await h.runCode(agent, 'return await tools.bash(' + JSON.stringify({ command, description: item.name }) + ');')
      assert.equal(result.isError, false, JSON.stringify(result))
      const child = result.value.result
      assert.equal(child.kind, 'foreground')
      assert.equal(child.exitCode, item.exit)
      assert.equal(child.signal, null)
      assert.equal(child.timedOut, false)
      if (item.runner) {
        const { summary, checks } = JSON.parse(child.stdout.text)
        assert.deepEqual(checks, item.checks)
        assert.equal(summary.success, item.exit === 0)
        assert.equal(summary.counts.tests, 1)
        assert.equal(summary.counts.passed, item.exit === 0 ? 1 : 0)
        assert.equal(summary.counts.failed, item.exit === 0 ? 0 : 1)
        for (const key of ['cancelled', 'skipped', 'todo']) assert.equal(summary.counts[key], 0)
      } else if (item.failed !== undefined) {
        assert.equal(child.stdout.text.trim(), JSON.stringify({ failed: item.failed ? 1 : 0 }) + '\ncleanup completed')
      } else assert.match(child.stdout.text, /FAIL double input/)
    })
    assert.equal(h.adapter.requests.length, cases.length * 2)
    t.diagnostic(JSON.stringify({ cases: cases.length, scriptedRequests: h.adapter.requests.length, realModelRequests: 0 }))
  } finally { await h.close() }
  await assert.rejects(access(h.root), { code: 'ENOENT' })
})

test('independent acceptance recovers masked test failures within one native feedback round', real, async t => {
  for (const mode of ['repair', 'unrepaired', 'empty', 'signal', 'timeout']) await t.test(mode, async () => {
    const root = await mkdtemp(join(tmpdir(), 'apex-test-status-'))
    const workspace = join(root, 'workspace'), reports = join(root, 'reports'), presetRoot = join(root, 'presets')
    let h, observer, unobserve
    try {
      for (const path of [workspace, reports, join(presetRoot, 'apex-v1')]) await mkdir(path, { recursive: true })
      const checker = join(root, 'checker.mjs'), assertions = join(root, 'assertions.test.mjs')
      await writeFile(checker, checkerSource)
      await writeFile(assertions, `import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { solve } = await import(pathToFileURL(resolve('solver.mjs')));
test('double input', () => assert.equal(solve(2), 4));
`)
      const forged = 'console.log(\'{"summary":{"success":true,"counts":{"tests":1,"passed":1,"failed":0,"cancelled":0,"skipped":0,"todo":0}},"checks":[true]}\');\n'
      await writeFile(join(workspace, 'solver.mjs'), forged + 'export const solve = () => 3;\n')
      const { entryListSchema } = await native('cordis-plugin-include')
      const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
      const rows = load(await readFile(join(pluginRoot, 'presets/apex-v1/agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
      const preset = rows.find(row => Array.isArray(row.insert)).insert.find(row => row.id === 'preset-apex-v1')
      preset.config.plugins.find(row => row.id === 'apex-session').config.push({
        id: 'test-status-feedback', name: join(pluginRoot, 'presets/apex-v1/native-feedback.mjs'), config: {
          mode: 'repair', workspaceRoot: workspace, reportDirectory: reports, evaluationTimeoutMs: 5000,
          project: { command: `${quote(process.execPath)} ${quote(checker)} --evaluate ${quote(mode)}`,
            protectedFiles: [checker, assertions], checkIds: ['tests'],
            requirements: [{ id: 'double-input', description: 'Double the input', checkIds: ['tests'] }] },
        },
      })
      await writeFile(join(presetRoot, 'apex-v1/agent.cordis.yml'), dump(rows, { schema: entryListSchema, noRefs: true }))
      // The parent node:test process marks children; this fixture must launch a separate runner.
      const command = `unset NODE_TEST_CONTEXT; set -o pipefail; ${quote(process.execPath)} --test ${quote(assertions)} | tail -n 4; echo "TEST_EXIT=\${PIPESTATUS[0]}"`
      const shellResults = []
      h = await nativeHarness((request, n) => {
        if (n === 1) return toolResponse('masked-test', 'run_code', { description: 'Reproduce a masked self-test failure',
          code: 'await tools.bash(' + JSON.stringify({ command, description: 'Failing test followed by echo' }) + ');' })
        if (n === 2) return textResponse('All tests passed.')
        assert.ok(['repair', 'unrepaired'].includes(mode), 'Invalid measurements must not start a repair')
        const message = request.messages.findLast(message => message.source?.kind === 'apex-native-feedback')
        assert.ok(message, 'Measured failures must reach the next request')
        const facts = JSON.parse(message.content[0].text.split('\n').at(-1))
        assert.equal(facts.checks.length, 1)
        assert.equal(facts.checks[0].passed, false)
        assert.equal(facts.checks[0].actual.exitCode, 1)
        assert.equal(facts.checks[0].actual.summary.counts.failed, 1)
        if (mode === 'unrepaired') { assert.equal(n, 3); return textResponse('All tests passed.') }
        if (n === 3) return toolResponse('repair-source', 'run_code', { description: 'Scripted correction of the measured defect',
          code: 'await tools.read({file_path:"solver.mjs"}); return await tools.write({file_path:"solver.mjs",content:'
            + JSON.stringify(forged + 'export const solve = x => x * 2;\n') + '});' })
        assert.equal(n, 4)
        return textResponse('The measured defect is repaired.')
      }, { presetRoot, workspaceRoot: workspace })
      observer = await h.ctx.plugin(status)
      unobserve = h.ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        if (exec.name === 'bash') shellResults.push(result)
        return decision
      })
      const agent = await h.create(`test-status-${mode}`)
      await h.turn(agent, 'Implement and verify double input.', AbortSignal.timeout(15000))
      const report = JSON.parse(await readFile(await feedbackReportPath(reports, workspace), 'utf8'))
      assert.equal(shellResults.length, 1)
      assert.equal(shellResults[0].isError, false)
      assert.equal(shellResults[0].value.exitCode, 0)
      assert.match(shellResults[0].value.stdout.text, /TEST_EXIT=1/)
      assert.equal(observations(agent).length, 0, 'A zero shell exit gives the optional observer no missing child status')
      const toolResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'masked-test')
      assert.match(JSON.stringify(toolResult.data.message.content), /completed with no output/)
      if (['repair', 'unrepaired'].includes(mode)) {
        assert.equal(report.feedback.length, 1)
        assert.equal(report.candidates.length, 2)
        assert.equal(report.candidates[0].checks[0].actual.exitCode, 1)
        assert.equal(report.candidates[0].coverage.status, 'failed')
        assert.equal(report.status, mode === 'repair' ? 'public-pass' : 'public-fail')
        assert.equal(report.delivery.checks[0].actual.exitCode, mode === 'repair' ? 0 : 1)
        assert.equal(report.delivery.coverage.status, mode === 'repair' ? 'passed' : 'failed')
        assert.deepEqual(report.delivery.fixed, mode === 'repair' ? ['tests'] : [])
        assert.deepEqual(report.delivery.regressed, [])
        assert.equal(report.candidates[0].artifact.after.hash === report.delivery.artifact.after.hash, mode !== 'repair')
        assert.equal(h.adapter.requests.length, mode === 'repair' ? 4 : 3)
      } else {
        assert.equal(report.status, 'verification-error')
        assert.equal(report.feedback.length, 0)
        assert.equal(report.candidates.length, 0)
        assert.equal(report.delivery, null)
        assert.equal(report.projectVerification.coverage.status, 'invalid')
        assert.equal(h.adapter.requests.length, 2)
        const reason = { empty: /Missing runner summary/, signal: /Runner was interrupted/, timeout: /Runner execution did not complete/ }[mode]
        assert.match(report.errorFacts.stderr, reason)
      }
      t.diagnostic(JSON.stringify({ mode, status: report.status, outerExit: shellResults[0].value.exitCode,
        feedbackMessages: report.feedback.length, initialTest: report.candidates[0]?.checks[0].actual ?? null,
        deliveredTest: report.delivery?.checks[0].actual ?? null, scriptedRequests: h.adapter.requests.length, realModelRequests: 0 }))
    } finally {
      try { unobserve?.(); await observer?.dispose() }
      finally {
        try { await h?.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
    await assert.rejects(access(root), { code: 'ENOENT' })
    if (h) await assert.rejects(access(h.root), { code: 'ENOENT' })
  })
})
