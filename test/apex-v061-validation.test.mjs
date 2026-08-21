import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apply,
  classifyValidationResult,
  resultText,
  sampleAnimationFrames,
  startStaticServer,
  validationAdmission,
  validationSignature,
  WEB_VALIDATION_META_KIND,
} from '../presets/apex-v061/apex-validation.mjs'
import {
  LEDGER_META_KIND,
  normalizeLedger,
} from '../presets/apex-v061/apex-policy.mjs'
import { VISUAL_META_KIND } from '../presets/apex-v061/apex-vision.mjs'

function ledger(checks) {
  return {
    goal: 'Ship the verified web artifact.',
    verified: [],
    open: ['Complete bounded acceptance.'],
    next: 'Run the next pending check.',
    evidence: [],
    checks,
  }
}

function ledgerEvent(value) {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: LEDGER_META_KIND,
        ledger: value,
        updated: true,
        stalled: false,
      },
    },
  }
}

function validationEvent(checkId, mode, status, signature, extra = {}) {
  return {
    type: 'tool/result',
    data: { meta: { kind: WEB_VALIDATION_META_KIND, checkId, mode, status, signature, ...extra } },
  }
}

function visualEvent(verdict, imagePaths) {
  return {
    type: 'tool/result',
    data: { meta: { kind: VISUAL_META_KIND, verdict, imagePaths } },
  }
}

function call(name, args, callId) {
  return { type: 'tool/call', data: { name, callId, arguments: JSON.stringify(args) } }
}

function result(callId, meta) {
  return {
    type: 'tool/result',
    data: {
      ...(meta === undefined ? {} : { meta }),
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        }],
      },
    },
  }
}

function agent(cwd, checks, extra = []) {
  return {
    session: {
      header: { cwd, delegationDepth: 0 },
      events: [ledgerEvent(ledger(checks)), ...extra],
    },
  }
}

const runtimePending = {
  id: 'runtime',
  assertion: 'The built page loads with a visible canvas and no runtime errors.',
  status: 'pending',
  evidence: '',
}

test('web validation returns bounded actionable browser diagnostics to Pro', () => {
  const text = resultText({
    checkId: 'runtime',
    mode: 'baseline',
    status: 'failed',
    detail: 'Assertion failed.',
    browser: 'Google Chrome',
    url: 'http://127.0.0.1:3000/index.html',
    readyState: 'complete',
    visibleCanvasCount: 1,
    canvasCount: 1,
    graphicsApi: 'webgl2',
    graphicsRenderer: 'ANGLE Metal Renderer',
    fps: 0,
    p95FrameMs: 0,
    consoleErrors: ['Uncaught TypeError: missing method'],
    pageErrors: ['ReferenceError: renderer is not defined'],
    networkErrors: ['net::ERR_FAILED: script'],
    httpErrors: ['404 http://127.0.0.1:3000/missing.js'],
    missingSelectors: [],
    screenshotPath: '',
    cleanup: 'server-closed,browser-terminated,profile-removed',
  })
  assert.match(text, /page: ReferenceError: renderer is not defined/)
  assert.match(text, /console: Uncaught TypeError: missing method/)
  assert.match(text, /network: net::ERR_FAILED: script/)
  assert.match(text, /HTTP: 404 http:\/\/127\.0\.0\.1:3000\/missing\.js/)
  assert.match(text, /browser=Google Chrome/)
  assert.match(text, /graphics=webgl2 \(ANGLE Metal Renderer\)/)
})

test('acceptance checks use bounded pending/failed/passed state with evidence on closed items', () => {
  assert.deepEqual(normalizeLedger(ledger([runtimePending])).checks, [runtimePending])
  assert.equal(normalizeLedger(ledger([{
    ...runtimePending,
    status: 'passed',
    evidence: '',
  }])), undefined)
  assert.equal(normalizeLedger(ledger([
    runtimePending,
    { ...runtimePending, assertion: 'duplicate id' },
  ])), undefined)
  assert.deepEqual(normalizeLedger({ ...ledger([]), checks: undefined }).checks, [])
})

test('web validation binds one task-global baseline, regression, and final contract', () => {
  const root = '/workspace'
  const baseline = {
    check_id: 'runtime',
    assertion: runtimePending.assertion,
    mode: 'baseline',
    root: '.',
    require_canvas: true,
    click_canvas: true,
    interactions: [{ key: 'KeyW', hold_ms: 500 }],
    min_fps: 12,
  }
  const signature = validationSignature(baseline)
  assert.equal(validationAdmission(baseline, agent(root, [runtimePending])), undefined)
  assert.match(validationAdmission(baseline, agent(root, [runtimePending], [
    validationEvent('runtime', 'baseline', 'passed', signature),
  ])), /baseline budget is already used/)

  const failed = { ...runtimePending, status: 'failed', evidence: 'Console showed an uncaught TypeError.' }
  const regression = { ...baseline, mode: 'regression', screenshot_path: 'regression.png' }
  assert.equal(validationAdmission(regression, agent(root, [failed], [
    validationEvent('runtime', 'baseline', 'failed', signature),
  ])), undefined)
  assert.match(validationAdmission(regression, agent(root, [failed], [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
  ])), /regression budget is already used/)

  const passed = { ...runtimePending, status: 'passed', evidence: 'Host smoke passed.' }
  const final = { ...baseline, mode: 'final', screenshot_path: 'final.png' }
  assert.equal(validationAdmission(final, agent(root, [passed], [
    validationEvent('runtime', 'baseline', 'passed', signature),
  ])), undefined)
  assert.equal(validationAdmission(final, agent(root, [failed], [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
  ])), undefined)
  assert.match(validationAdmission(final, agent(root, [passed], [
    validationEvent('runtime', 'baseline', 'passed', signature),
    validationEvent('runtime', 'final', 'passed', signature),
  ])), /final Web validation budget is already used/)
})

test('web validation cannot reset its task budget or lower the baseline threshold', () => {
  const root = '/workspace'
  const baseline = {
    check_id: 'runtime',
    assertion: runtimePending.assertion,
    mode: 'baseline',
    root: '.',
    min_fps: 12,
  }
  const signature = validationSignature(baseline)
  const failed = { ...runtimePending, status: 'failed', evidence: 'Runtime FPS was below 12.' }
  const events = [validationEvent('runtime', 'baseline', 'failed', signature)]
  assert.match(validationAdmission({
    ...baseline,
    check_id: 'runtime-2',
  }, agent(root, [runtimePending, { ...runtimePending, id: 'runtime-2' }], events)), /do not create another check id/)
  assert.match(validationAdmission({
    ...baseline,
    mode: 'regression',
    min_fps: 1,
  }, agent(root, [failed], events)), /exact baseline assertion/)
})

test('repair proofs accept deterministic runtime, FPS, or structured visual evidence', () => {
  const baseResult = {
    status: 'failed',
    detail: 'Assertion failed: 1 uncaught page error(s).',
    pageErrors: ['TypeError: camera.move is not a function\n at app.js:120:4'],
    consoleErrors: [],
    networkErrors: [],
    httpErrors: [],
  }
  const firstClass = classifyValidationResult(baseResult)
  const shiftedClass = classifyValidationResult({
    ...baseResult,
    pageErrors: ['TypeError: camera.move is not a function\n at app.js:999:18'],
  })
  assert.equal(firstClass.failureClass, 'application-runtime')
  assert.equal(firstClass.repairEligible, true)
  assert.equal(firstClass.diagnosticHash, shiftedClass.diagnosticHash)
  assert.equal(firstClass.defectScore, 1)
  assert.deepEqual(classifyValidationResult({
    ...baseResult,
    pageErrors: [],
    networkErrors: ['net::ERR_FAILED'],
  }), { failureClass: 'network', diagnosticHash: '', defectScore: 0, repairEligible: false })
  assert.deepEqual(classifyValidationResult({
    ...baseResult,
    pageErrors: [],
    detail: 'Assertion failed: sampled FPS 5.0 was below 30.',
  }), { failureClass: 'performance', diagnosticHash: '', defectScore: 833, repairEligible: true })

  const root = '/workspace'
  const baseline = {
    check_id: 'runtime',
    assertion: runtimePending.assertion,
    mode: 'baseline',
    root: '.',
    require_canvas: true,
  }
  const signature = validationSignature(baseline)
  const failed = { ...runtimePending, status: 'failed', evidence: 'Final host check found the runtime exception.' }
  const finalFailure = validationEvent('runtime', 'final', 'failed', signature, {
    ...firstClass,
  })
  const repairProof = { ...baseline, mode: 'repair-proof' }
  const prior = [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
    finalFailure,
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], prior)), /successful implementation mutation/)

  const directProRepair = [
    ...prior,
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'direct-edit'),
    result('direct-edit'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], directProRepair)), undefined)

  const repaired = [
    ...prior,
    call('apex_takeover', { child_id: 'child-1' }, 'takeover-1'),
    result('takeover-1', {
      kind: 'apex-takeover-v061',
      childId: 'child-1',
      workItemId: 'web',
      paths: ['src/app.js'],
      reason: 'final_runtime_failure',
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'edit-1'),
    result('edit-1'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], repaired)), undefined)
  const transferredBeforeFinal = [
    ...prior.slice(0, -1),
    call('apex_takeover', { child_id: 'child-1' }, 'takeover-before-final'),
    result('takeover-before-final', {
      kind: 'apex-takeover-v061',
      childId: 'child-1',
      workItemId: 'web',
      paths: ['src/app.js'],
      reason: 'pro_only_fix',
    }),
    finalFailure,
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'edit-after-final'),
    result('edit-after-final'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], transferredBeforeFinal)), undefined)

  const performanceFinal = [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
    validationEvent('runtime', 'final', 'failed', signature, {
      failureClass: 'performance', diagnosticHash: '', repairEligible: false,
    }),
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], performanceFinal)), /successful implementation mutation/)
  assert.equal(validationAdmission(repairProof, agent(root, [failed], [
    ...performanceFinal,
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/render.js' }, 'fps-edit'),
    result('fps-edit'),
  ])), undefined)

  const passedFinalScreenshot = [
    validationEvent('runtime', 'baseline', 'passed', signature),
    validationEvent('runtime', 'final', 'passed', signature, {
      failureClass: 'none', diagnosticHash: '', repairEligible: false, screenshotPath: 'final.png',
    }),
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], passedFinalScreenshot)), /structured repair verdict/)
  const visualFailure = [...passedFinalScreenshot, visualEvent('repair', ['final.png'])]
  assert.match(validationAdmission(repairProof, agent(root, [failed], visualFailure)), /successful implementation mutation/)
  assert.equal(validationAdmission(repairProof, agent(root, [failed], [
    ...visualFailure,
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/materials.js' }, 'visual-edit'),
    result('visual-edit'),
  ])), undefined)
})

test('repair proofs allow two rounds and a third only after immediate convergence', () => {
  const root = '/workspace'
  const baseline = {
    check_id: 'runtime',
    assertion: runtimePending.assertion,
    mode: 'baseline',
    root: '.',
    require_canvas: true,
  }
  const signature = validationSignature(baseline)
  const failed = { ...runtimePending, status: 'failed', evidence: 'The latest host proof still has an application defect.' }
  const repairProof = { ...baseline, mode: 'repair-proof' }
  const start = [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
    validationEvent('runtime', 'final', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'final-errors', defectScore: 3, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'repair-final'),
    result('repair-final'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], start)), undefined)

  const afterFirst = [
    ...start,
    validationEvent('runtime', 'repair-proof', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'two-errors', defectScore: 2, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'repair-one'),
    result('repair-one'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], afterFirst)), undefined)

  const noProgress = [
    ...afterFirst,
    validationEvent('runtime', 'repair-proof', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'different-two-errors', defectScore: 2, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'repair-two-no-progress'),
    result('repair-two-no-progress'),
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], noProgress)), /third repair-proof requires.*convergence/i)

  const converged = [
    ...afterFirst,
    validationEvent('runtime', 'repair-proof', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'one-error', defectScore: 1, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'repair-two'),
    result('repair-two'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], converged)), undefined)

  const exhausted = [
    ...converged,
    validationEvent('runtime', 'repair-proof', 'failed', signature, {
      failureClass: 'performance', diagnosticHash: '', defectScore: 250, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/render.js' }, 'repair-three'),
    result('repair-three'),
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], exhausted)), /three evidence-backed repair-proof rounds are exhausted/i)
})

test('a repeated runtime fingerprint requires Pro repair before another proof', () => {
  const root = '/workspace'
  const baseline = {
    check_id: 'runtime', assertion: runtimePending.assertion, mode: 'baseline', root: '.', require_canvas: true,
  }
  const signature = validationSignature(baseline)
  const failed = { ...runtimePending, status: 'failed', evidence: 'The same runtime exception remains.' }
  const repairProof = { ...baseline, mode: 'repair-proof' }
  const repeated = [
    validationEvent('runtime', 'baseline', 'failed', signature),
    validationEvent('runtime', 'regression', 'failed', signature),
    validationEvent('runtime', 'final', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'same-runtime-error', defectScore: 1, repairEligible: true,
    }),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'first-repair'),
    result('first-repair'),
    validationEvent('runtime', 'repair-proof', 'failed', signature, {
      failureClass: 'application-runtime', diagnosticHash: 'same-runtime-error', defectScore: 1, repairEligible: true,
    }),
    call('apex_continue', { child_id: 'child-1' }, 'continue-1'),
    result('continue-1'),
    result('worker-wait-1', {
      kind: 'apex-worker-wait-v061', childId: 'child-1', successfulMutations: 1,
    }),
  ]
  assert.match(validationAdmission(repairProof, agent(root, [failed], repeated)), /Flash must stop.*direct Pro mutation/i)
  assert.equal(validationAdmission(repairProof, agent(root, [failed], [
    ...repeated,
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/app.js' }, 'pro-repair'),
    result('pro-repair'),
  ])), undefined)
})

test('one external retry is separate from the repair-proof budget', () => {
  const root = '/workspace'
  const baseline = {
    check_id: 'runtime', assertion: runtimePending.assertion, mode: 'baseline', root: '.', require_canvas: true,
  }
  const signature = validationSignature(baseline)
  const repairProof = { ...baseline, mode: 'repair-proof' }
  const blockedFinal = [
    validationEvent('runtime', 'baseline', 'passed', signature),
    validationEvent('runtime', 'final', 'blocked', signature, {
      failureClass: 'environment', diagnosticHash: '', defectScore: 0, repairEligible: false,
    }),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [runtimePending], blockedFinal)), undefined)
  assert.match(validationAdmission(repairProof, agent(root, [runtimePending], [
    ...blockedFinal,
    validationEvent('runtime', 'repair-proof', 'blocked', signature, {
      failureClass: 'environment', diagnosticHash: '', defectScore: 0, repairEligible: false,
    }),
  ])), /environment\/network retry is already used/i)

  const failed = { ...runtimePending, status: 'failed', evidence: 'The retry screenshot has a blocking visual defect.' }
  const externalRetryPassed = [
    validationEvent('runtime', 'baseline', 'passed', signature),
    validationEvent('runtime', 'final', 'failed', signature, {
      failureClass: 'network', diagnosticHash: '', defectScore: 0, repairEligible: false,
    }),
    validationEvent('runtime', 'repair-proof', 'passed', signature, {
      failureClass: 'none', diagnosticHash: '', defectScore: 0, repairEligible: false, screenshotPath: 'external-retry.png',
    }),
    visualEvent('repair', ['external-retry.png']),
    call('str_replace_editor', { command: 'str_replace', path: '/workspace/src/materials.js' }, 'visual-repair'),
    result('visual-repair'),
  ]
  assert.equal(validationAdmission(repairProof, agent(root, [failed], externalRetryPassed)), undefined)
})

test('the loopback static server serves files and rejects traversal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v061-static-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<canvas></canvas>')
  const server = await startStaticServer(root, new AbortController().signal)
  t.after(() => server.close())
  const page = await fetch(`${server.origin}/index.html`)
  assert.equal(page.status, 200)
  assert.equal(await page.text(), '<canvas></canvas>')
  assert.equal((await fetch(`${server.origin}/%2e%2e/package.json`)).status, 404)
  await server.close()
})

test('FPS sampling lets the page run between two bounded DevTools evaluations', async () => {
  const calls = []
  let waited = false
  const client = {
    async send(method, params) {
      calls.push({ method, params, waited })
      if (method === 'Page.bringToFront') return {}
      return calls.filter(call => call.method === 'Runtime.evaluate').length === 1
        ? { result: { value: true } }
        : { result: { value: { frames: 60, durationMs: 1_000, fps: 60, p95FrameMs: 16.7 } } }
    },
  }
  const value = await sampleAnimationFrames(
    client,
    1_000,
    new AbortController().signal,
    async (ms) => {
      assert.equal(ms, 1_000)
      waited = true
    },
  )

  assert.equal(value.fps, 60)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].method, 'Page.bringToFront')
  assert.equal(calls[1].method, 'Runtime.evaluate')
  assert.equal(calls[1].params.awaitPromise, true)
  assert.equal(calls[1].waited, false)
  assert.equal(calls[2].waited, true)
  assert.doesNotMatch(calls[1].params.expression, /new Promise/)
  assert.match(calls[1].params.expression, /requestAnimationFrame/)
  assert.match(calls[2].params.expression, /cancelAnimationFrame/)
})

test('apex_validate_web exposes bounded host checks and never downloads a browser', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apex-v061-validator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<canvas></canvas>')
  let tool
  let resolveCalls = 0
  apply({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subprocess: {
      async resolveExecutable() {
        resolveCalls += 1
        throw new Error('not installed')
      },
      spawn() {
        throw new Error('must not spawn without a resolved browser')
      },
    },
  })
  assert.equal(tool.name, 'apex_validate_web')
  assert.deepEqual(tool.parameters.required, ['check_id', 'assertion', 'mode', 'root'])
  assert.deepEqual(tool.parameters.properties.mode.enum, ['baseline', 'regression', 'final', 'repair-proof'])
  assert.match(tool.description, /two repair-proof rounds are available by default/i)
  assert.match(tool.description, /one environment\/network retry/i)
  assert.equal(tool.output.schema.properties.defectScore.type, 'number')
  assert.equal('command' in tool.parameters.properties, false)
  assert.equal('script' in tool.parameters.properties, false)
  const scoped = agent(root, [runtimePending])
  const value = await tool.execute({
    check_id: 'runtime',
    assertion: runtimePending.assertion,
    mode: 'baseline',
    root: '.',
    require_canvas: true,
  }, {
    agent: scoped,
    signal: new AbortController().signal,
  })
  assert.equal(value.status, 'blocked')
  assert.match(value.detail, /No existing Chrome/)
  assert.match(value.text, /did not download one|environment\/tooling block/)
  assert.equal(resolveCalls > 0, true)
  assert.equal(value.cleanup, 'nothing-started')
  assert.equal(tool.output.presentationMeta({}, value).defectScore, 0)
})
