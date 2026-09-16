import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import * as validation from '../presets/apex-v1/validation.mjs'

const pause = { check_id: 'pause', assertion: 'The timer pauses after clicking.', root: '.', interaction_required: true,
  click_selector: '#pause', sequence_checks: [{ id: 'timer', selector: '#timer', expectation: 'stable' }] }

// Carried-forward generic browser regressions; no legacy stages, ledger or activation fixtures.
test('pointer-lock wait precedes keys and stops on cancellation or invalid targets', async () => {
  let polls = 0
  const keys = []
  const client = { async send(method, params) {
    if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('document.pointerLockElement')
      ? (++polls < 3 ? 'pending' : 'locked') : { x: 20, y: 20 } } }
    if (method === 'Input.dispatchKeyEvent') {
      assert.equal(polls, 3, 'the native lock must settle before a key is sent')
      assert.equal(params.windowsVirtualKeyCode, 87)
      assert.equal(params.key, 'w')
      assert.equal(Object.hasOwn(params, 'nativeVirtualKeyCode'), false, 'Windows key codes are not native macOS key codes')
      assert.equal(Object.hasOwn(params, 'keyCode'), false, 'only CDP fields are sent')
      keys.push(params.type)
    }
    return {}
  } }
  const args = { interactions: [{ click_selector: '#start', pointer_lock_selector: '#game' }, { key: 'KeyW', hold_ms: 0 }] }
  await validation.dispatchInteractions(client, args, new AbortController().signal)
  assert.deepEqual(keys, ['keyDown', 'keyUp'])
  const controller = new AbortController()
  client.send = async (method, params) => {
    assert.notEqual(method, 'Input.dispatchKeyEvent')
    if (method !== 'Runtime.evaluate') return {}
    if (!params.expression.includes('document.pointerLockElement')) return { result: { value: { x: 20, y: 20 } } }
    controller.abort(new Error('cancel pointer wait'))
    return { result: { value: 'pending' } }
  }
  await assert.rejects(validation.dispatchInteractions(client, args, controller.signal), /cancel pointer wait/)
  await assert.rejects(validation.waitForPointerLock({ async send() {
    return { result: { value: 'missing-or-ambiguous' } }
  } }, '#missing', new AbortController().signal), /missing-or-ambiguous/)
})

test('pointer-lock wait has a host-clock deadline even when document time is controlled', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  await assert.rejects(validation.waitForPointerLock({ async send() {
    t.mock.timers.setTime(10_000)
    return { result: { value: 'pending' } }
  } }, '#game', new AbortController().signal), /did not activate.*dependent actions were not dispatched/)
})

test('ordered waits emit no input and honor their duration and cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const keys = [], client = { async send(method, args) { keys.push([method, args.type]); return {} } }
  const controller = new AbortController()
  let settled = false
  const waiting = validation.dispatchInteractions(client, { interactions: [{ wait_ms: 2000 }] }, controller.signal)
    .then(value => { settled = true; return value })
  t.mock.timers.tick(1999)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.deepEqual(await waiting, ['wait:2000ms'])
  assert.deepEqual(keys, [], 'waiting must not send placeholder keys or other CDP input')
  const interrupted = validation.dispatchInteractions(client, { interactions: [
    { wait_ms: 2000 }, { key: 'KeyA', hold_ms: 0 },
  ] }, controller.signal)
  const rejection = assert.rejects(interrupted, /cancel ordered wait/)
  controller.abort(new Error('cancel ordered wait'))
  await rejection
  t.mock.timers.tick(2000)
  await assert.rejects(validation.dispatchInteractions(client, { interactions: [{ wait_ms: 0 }] }, controller.signal), /cancel ordered wait/)
  assert.deepEqual(keys, [], 'cancellation prevents all dependent actions')
})

test('exact text checks compare the whole unique cell, not a substring or a truncated prefix', async () => {
  const nodes = {
    '#correct': [{ textContent: '  0.5\n' }], '#broken': [{ textContent: '0.' }],
    '#other-column': [{ textContent: '0. 50.00' }], '#empty': [{ textContent: '' }],
    '#long': [{ textContent: '0.5' + ' '.repeat(600) + 'wrong' }],
    '#duplicate': [{ textContent: '0.5' }, { textContent: 'wrong' }],
  }
  const page = createContext({ document: {
    querySelector: selector => nodes[selector]?.[0] ?? null,
    querySelectorAll: selector => nodes[selector] ?? [],
  } })
  const client = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate')
    return { result: { value: runInContext(params.expression, page) } }
  } }
  const checks = Object.keys(nodes).map(selector => ({ phase: 'before', selector,
    equals: selector === '#empty' ? '' : '0.5' }))
  checks.push({ phase: 'before', selector: '#missing', equals: '' },
    { phase: 'before', selector: '#other-column', contains: '50.00' })
  const result = await validation.inspectTextChecks(client, checks, 'before')
  assert.deepEqual(Array.from(result, item => item.passed), [true, false, false, true, false, false, false, true])
  const failures = validation.textCheckFailures(result)
  assert.match(failures.join('\n'), /equals.*0\.5/)
  assert.match(failures.join('\n'), /#duplicate/)
  assert.ok(result.every(item => item.observed.length <= 500))
})

test('reload ignores stale and child loads, verifies the loaded document and releases its listener', async () => {
  const previous = { id: 'main', loaderId: 'old', url: 'http://127.0.0.1:1234/index.html' }
  for (const outcome of ['loaded', 'wrong-url', 'wrong-loader', 'cancel', 'command-error']) {
    const controller = new AbortController(), calls = []
    let listener, removed = false, reloaded = false, loadDelivered = false
    const client = {
      on(method, callback) {
        assert.equal(method, 'Page.lifecycleEvent'); listener = callback
        return () => { removed = true }
      },
      async send(method, params) {
        calls.push(method)
        if (method === 'Page.getFrameTree') return { frameTree: { frame: reloaded
          ? { ...previous, loaderId: outcome === 'wrong-loader' ? 'racing-loader' : 'new',
            url: outcome === 'wrong-url' ? 'https://example.invalid/' : previous.url } : previous } }
        if (method === 'Page.reload') {
          assert.deepEqual(params, { ignoreCache: true, loaderId: 'old' })
          if (outcome === 'command-error') throw new Error('reload command rejected')
          reloaded = true
          listener({ name: 'load', frameId: 'main', loaderId: 'old' })
          listener({ name: 'load', frameId: 'child', loaderId: 'new' })
          listener({ name: 'DOMContentLoaded', frameId: 'main', loaderId: 'new' })
          setImmediate(() => {
            assert.equal(calls.includes('Runtime.evaluate'), false, 'old or child load must not release the wait')
            if (outcome === 'cancel') controller.abort(new Error('cancel reload wait'))
            else { loadDelivered = true; listener({ name: 'load', frameId: 'main', loaderId: 'new' }) }
          })
        }
        if (method === 'Runtime.evaluate') {
          assert.ok(loadDelivered, 'readiness is checked only after the new main load')
          return { result: { value: 'complete' } }
        }
        return {}
      },
    }
    const execution = validation.dispatchInteractions(client, { interactions: [
      { reload: true }, { key: 'Enter', hold_ms: 0 },
    ] }, controller.signal)
    if (outcome === 'loaded') assert.deepEqual(await execution, ['reload:new-document', 'Enter:0ms'])
    else {
      await assert.rejects(execution, /same page|cancel reload wait|reload command rejected/)
      assert.equal(calls.includes('Input.dispatchKeyEvent'), false, 'no dependent input after a failed reload')
    }
    assert.equal(removed, true)
  }
})

test('text contains checks the complete value while returning bounded observations', async () => {
  const content = '前'.repeat(600) + '目标🧪' + '尾'.repeat(10000)
  const page = createContext({ document: {
    querySelector: selector => selector === '#missing' ? null : { textContent: content },
  } })
  const client = { async send(_method, params) { return { result: { value: runInContext(params.expression, page) } } } }
  const result = await validation.inspectTextChecks(client, [
    { phase: 'after', selector: '#text', contains: '目标🧪' },
    { phase: 'after', selector: '#text', contains: '不存在' },
    { phase: 'after', selector: '#missing', contains: '目标🧪' },
  ], 'after')
  assert.deepEqual(Array.from(result, check => check.passed), [true, false, false])
  assert.ok(result.every(check => check.observed.length <= 500))
  assert.ok(JSON.stringify(result).length < 2000, 'full text must not become unbounded evidence output')
})

test('clock predicates use complete text and never compare a clipped numeric token', async () => {
  const nodes = { '#tail': '前'.repeat(600) + '目标 -2.5e3', '#boundary': 'x'.repeat(499) + '1000', '#overflow': 'x'.repeat(600) + '1e999' }
  const page = createContext({ performance: { now: () => 0 }, document: {
    querySelector: selector => nodes[selector] === undefined ? null : { textContent: nodes[selector] },
  } })
  runInContext(validation.CONTROLLED_CLOCK_SOURCE, page)
  const client = { async send(_method, params) { return { result: { value: runInContext(params.expression, page) } } } }
  const result = await validation.runClockSteps(client, [{ at_ms: 0, run_callbacks: false, checks: [
    { selector: '#tail', contains: '目标', min: -2500, max: -2500 },
    { selector: '#boundary', max: 10 },
    { selector: '#overflow', min: 0 },
    { selector: '#missing', contains: '目标' },
  ] }], new AbortController().signal)
  assert.deepEqual(result.sequenceChecks.map(check => check.passed), [true, false, false, false])
  assert.match(result.sequenceChecks[1].failure, /observedNumber=1000/)
  assert.match(result.sequenceChecks[2].failure, /no finite number/)
  assert.ok(result.sequenceChecks.every(check => check.summary.length < 500))
})

for (const [expectation, after, expected] of [
  ['stable', '1001 标记', false], ['changes', '1001 标记', true],
  ['numeric-progress', '1001 标记', true], ['numeric-nondecreasing', '1001 标记', true],
  ['numeric-nondecreasing', '999 标记', false], ['contains-throughout', '1001 标记', true],
  ['contains-throughout', '1001 缺失', false], ['stable', '1000 标记', true],
]) {
  test(`sequence ${expectation} checks complete text beyond its evidence excerpt (${after})`, async () => {
    const prefix = 'x'.repeat(499)
    let now = 0, content = prefix + '1000 标记', nextId = 0
    const frames = new Map()
    const page = createContext({ performance: { now: () => now },
      document: { querySelector: () => ({ textContent: content }) },
      requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId },
      cancelAnimationFrame(id) { frames.delete(id) } })
    const client = { async send(_method, params) { return { result: { value: runInContext(params.expression, page) } } } }
    const check = { id: 'long-text', selector: '#text', expectation,
      ...expectation === 'contains-throughout' ? { contains: '标记' } : {},
      ...expectation === 'numeric-progress' ? { min_delta: 1 } : {},
    }
    const result = await validation.sampleAnimationFrames(client, 500, new AbortController().signal,
      async () => { now = 500; content = prefix + after }, [check])
    assert.equal(validation.sequenceCheckResults([check], result.samples)[0].passed, expected)
    assert.ok(result.samples.every(sample => sample.values.every(value => value.text.length <= 500)))
    assert.ok(JSON.stringify(result.samples).length < 2000)
    assert.equal(frames.size, 0)
  })
}

test('sequence predicates retain an intermediate tail change even if the final text returns to its initial value', async () => {
  let now = 0, tail = 'A', nextId = 0
  const frames = new Map()
  const page = createContext({ performance: { now: () => now },
    document: { querySelector: () => ({ textContent: 'x'.repeat(600) + tail }) },
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId },
    cancelAnimationFrame(id) { frames.delete(id) } })
  const client = { async send(_method, params) { return { result: { value: runInContext(params.expression, page) } } } }
  const checks = ['stable', 'changes'].map(expectation => ({ id: expectation, selector: '#text', expectation }))
  const result = await validation.sampleAnimationFrames(client, 500, new AbortController().signal, async () => {
    now = 250; tail = 'B'
    const callbacks = [...frames.values()]; frames.clear()
    callbacks.forEach(callback => callback(now))
    now = 500; tail = 'A'
  }, checks)
  assert.equal(result.samples.length, 3)
  assert.deepEqual(validation.sequenceCheckResults(checks, result.samples).map(check => check.passed), [false, true])
  assert.equal(frames.size, 0)
})

test('sequence validation returns field conflicts together without mutating the request', () => {
  const args = { sequence_checks: [
    { id: 'state', selector: '#state', expectation: 'changes', contains: 'ready', min_delta: 1 },
    { id: 'timer', selector: '#timer', expectation: 'numeric-nondecreasing', contains: 'seconds' },
    { id: 'growth', selector: '#timer', expectation: 'numeric-progress', min_delta: -1 },
  ] }
  const original = structuredClone(args)
  assert.deepEqual(validation.sequenceContractDenial(args).split('\n'), [
    'sequence check state may use contains only with contains-throughout',
    'sequence check state may use min_delta only with numeric-progress',
    'sequence check timer may use contains only with contains-throughout',
    'sequence check growth min_delta must be a finite number from 0 to 1000000000',
  ])
  assert.deepEqual(args, original)
  assert.equal(validation.sequenceContractDenial({ sequence_checks: [
    { id: 'state', selector: '#state', expectation: 'changes' },
    { id: 'timer', selector: '#timer', expectation: 'numeric-nondecreasing' },
    { id: 'growth', selector: '#timer', expectation: 'numeric-progress', min_delta: 1 },
    { id: 'text', selector: '#state', expectation: 'contains-throughout', contains: 'ready' },
  ] }), undefined)
  assert.equal(validation.sequenceContractDenial(pause), undefined)
  assert.equal(validation.sequenceContractDenial({}), undefined)
  assert.equal(validation.sequenceContractDenial({ sequence_checks: [] }), undefined)
})

test('sequence validation keeps structural rejection while reporting later check errors', () => {
  const denial = validation.sequenceContractDenial({ sequence_checks: [null,
    { id: {}, selector: '', expectation: 'unknown' },
    { id: 'same', selector: '#timer', expectation: 'stable', surprise: true },
    { id: 'same', selector: '#timer', expectation: 'contains-throughout' },
  ] })
  for (const pattern of [/sequence_checks\[0\].*must be an object/, /sequence_checks\[1\]\.id/,
    /sequence_checks\[1\].*requires selector/, /sequence_checks\[1\].*requires expectation/,
    /unsupported fields: surprise/, /id must be unique: same/, /requires contains/]) {
    assert.match(denial, pattern)
  }
  assert.doesNotMatch(denial, /\[object Object\]/)
  assert.equal(typeof validation.sequenceContractDenial({ sequence_checks: {} }), 'string')
  assert.equal(typeof validation.sequenceContractDenial({ sequence_checks: Array(5).fill(pause.sequence_checks[0]) }), 'string')
})

test('controlled clock contracts are optional, bounded and reject ambiguous acceptance plans', () => {
  const step = { at_ms: 0, run_callbacks: false, checks: [{ selector: '#elapsed', min: 0, max: 0 }] }
  const valid = { clock_steps: [step, { at_ms: 0, run_callbacks: true }] }
  assert.equal(validation.clockContractDenial({}), undefined)
  assert.equal(validation.clockContractDenial(valid), undefined)
  const fullStep = { ...step, checks: Array(4).fill(step.checks[0]) }
  assert.equal(validation.clockContractDenial({ clock_steps: Array(8).fill(fullStep) }), undefined)
  assert.equal(typeof validation.clockContractDenial({ clock_steps: Array(9).fill(fullStep) }), 'string')
  for (const clock_steps of [null, {}, [], Array(17).fill(step), [null], [{ ...step, at_ms: -1 }],
    [{ ...step, at_ms: 60_001 }], [{ ...step, at_ms: 0.5 }], [{ ...step, at_ms: NaN }],
    [{ ...step, run_callbacks: undefined }], [{ ...step, run_callbacks: 'false' }],
    [{ ...step, at_ms: 2 }, { ...step, at_ms: 1 }], [{ at_ms: 0, run_callbacks: true }],
    [{ ...step, click_selector: '#pause', input: { selector: '#speed', value: 2 } }],
    [{ ...step, click_selector: '' }], [{ ...step, input: { selector: '#speed', value: Infinity } }],
    [{ ...step, input: { selector: '', value: 2 } }], [{ ...step, script: 'arbitrary()' }],
    [{ ...step, checks: Array(5).fill(step.checks[0]) }], [{ ...step, checks: [null] }],
    [{ ...step, checks: [{ selector: '#elapsed' }] }], [{ ...step, checks: [{ selector: '', min: 0 }] }],
    [{ ...step, checks: [{ selector: '#elapsed', contains: '' }] }],
    [{ ...step, checks: [{ selector: '#elapsed', min: 2, max: 1 }] }],
    [{ ...step, checks: [{ selector: '#elapsed', min: NaN }] }],
    [{ ...step, checks: [{ selector: '#elapsed', max: Infinity }] }],
    [{ ...step, checks: [{ selector: '#elapsed', min: 0, expression: 'arbitrary()' }] }]]) {
    assert.equal(typeof validation.clockContractDenial({ clock_steps }), 'string', JSON.stringify(clock_steps))
  }
  for (const [field, value] of Object.entries({ click_selector: '#pause', click_canvas: true,
    interactions: [], text_checks: [], sequence_checks: [], min_fps: 30, settle_ms: 0, sample_ms: 500 })) {
    assert.equal(typeof validation.clockContractDenial({ ...valid, [field]: value }), 'string', field)
  }
  for (const action of [{ click_selector: '#pause' }, { input: { selector: '#speed', value: 2 } }]) {
    assert.equal(validation.interactionContractDenial({ interaction_required: true,
      clock_steps: [{ ...step, ...action }] }), undefined)
  }
  assert.equal(typeof validation.interactionContractDenial({ interaction_required: true, ...valid }), 'string')
})

test('controlled clock advances without callbacks, coalesces delayed intervals and defers newly queued work', () => {
  const page = createContext({ performance: { now: () => 99 } })
  runInContext(validation.CONTROLLED_CLOCK_SOURCE, page)
  runInContext(`globalThis.clock = globalThis[Symbol.for('dsh.apex.controlled-clock.v1')];
    globalThis.calls = []; globalThis.epoch = Date.now();
    requestAnimationFrame(now => { calls.push(['frame', now]); requestAnimationFrame(next => calls.push(['next-frame', next])); });
    setTimeout(value => { calls.push(['timeout', value]); setTimeout(() => calls.push(['next-timeout']), 0); }, 10, 'argument');
    globalThis.interval = setInterval(() => calls.push(['interval', performance.now()]), 10);
    globalThis.cancelledFrame = requestAnimationFrame(() => calls.push(['cancelled-frame']));
    cancelAnimationFrame(cancelledFrame);
    globalThis.cancelledTimer = setTimeout(() => calls.push(['cancelled-timeout']), 0);
    clearInterval(cancelledTimer);`, page)
  runInContext('clock.advance(5, false)', page)
  assert.equal(runInContext('performance.now()', page), 5)
  assert.equal(runInContext('Date.now() - epoch', page), 5)
  assert.equal(runInContext('calls.length', page), 0)
  runInContext('clock.advance(100, true)', page)
  let calls = JSON.parse(runInContext('JSON.stringify(calls)', page))
  assert.equal(calls.length, 3, JSON.stringify(calls))
  assert.ok(calls.some(value => value[0] === 'frame' && value[1] === 100))
  assert.ok(calls.some(value => value[0] === 'timeout' && value[1] === 'argument'))
  assert.equal(calls.filter(value => value[0] === 'interval').length, 1)
  runInContext('clock.advance(101, true)', page)
  calls = JSON.parse(runInContext('JSON.stringify(calls)', page))
  assert.equal(calls.filter(value => value[0].startsWith('next-')).length, 2)
  assert.equal(calls.filter(value => value[0] === 'interval').length, 1)
  runInContext('clock.advance(1000, true); clearTimeout(interval); clock.advance(2000, true); clock.assertSupported()', page)
  calls = JSON.parse(runInContext('JSON.stringify(calls)', page))
  assert.equal(calls.filter(value => value[0] === 'interval').length, 2)
  assert.ok(calls.every(value => !value[0].startsWith('cancelled-')))
})

test('controlled clock rejects unsupported callbacks and unbounded callback queues', () => {
  for (const source of ['setTimeout("globalThis.ran=true", 0)',
    'for (let index=0; index<10001; index++) requestAnimationFrame(()=>{})']) {
    const page = createContext({ performance: { now: () => 0 } })
    runInContext(validation.CONTROLLED_CLOCK_SOURCE, page)
    assert.throws(() => runInContext(`${source}; globalThis[Symbol.for('dsh.apex.controlled-clock.v1')].assertSupported()`, page))
  }
})

test('clock checkpoint evidence retains numeric bounds and missing selectors without claiming real-time FPS', async () => {
  const page = createContext({ performance: { now: () => 0 },
    document: { querySelector: selector => selector === '#missing' ? null : { textContent: 'elapsed 1e2 ms' } } })
  runInContext(validation.CONTROLLED_CLOCK_SOURCE, page)
  const client = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate')
    return { result: { value: runInContext(params.expression, page) } }
  } }
  const result = await validation.runClockSteps(client, [
    { at_ms: 100, run_callbacks: true, checks: [{ selector: '#elapsed', min: 99, max: 101, contains: 'ms' }] },
    { at_ms: 150, run_callbacks: false, checks: [{ selector: '#elapsed', min: 150 }, { selector: '#missing', max: 0 }] },
  ], new AbortController().signal)
  assert.equal(result.interactions.length, 0)
  assert.deepEqual(result.sequenceChecks.map(check => check.passed), [true, false, false])
  assert.ok(result.sequenceChecks.slice(1).every(check => typeof check.failure === 'string' && check.failure.length > 0))
  assert.equal(result.fps, undefined)
  const abort = new AbortController()
  abort.abort(new Error('stop-clock-check'))
  let sent = 0
  await assert.rejects(validation.runClockSteps({ send() { sent++; throw new Error('unexpected CDP call') } },
    [{ at_ms: 0, run_callbacks: true, checks: [{ selector: '#elapsed', min: 0 }] }], abort.signal), /stop-clock-check/)
  assert.equal(sent, 0)
})

for (const mode of ['real-time', 'controlled-clock']) test(`${mode} range input uses the native setter and rejects unsupported or unrepresentable targets`, async () => {
  for (const [patch, value, valid] of [[{}, 2, true], [{ type: 'text' }, 2, false],
    [{ disabled: true }, 2, false], [{ hidden: true }, 2, false], [{ occluded: true }, 2, false],
    [{ ambiguous: true }, 2, false], [{}, 5, false], [{}, 2.25, false]]) {
    const page = createContext({ performance: { now: () => 0 }, patch, innerWidth: 640, innerHeight: 480,
      getComputedStyle: item => ({ display: item.hidden ? 'none' : 'block', visibility: 'visible' }) })
    runInContext(`globalThis.events=[];
      globalThis.Event=class {constructor(type){this.type=type;}};
      globalThis.HTMLInputElement=class {
        constructor(){this.current='1';this.type='range';this.min='0';this.max='4';this.isConnected=true;this.validity={stepMismatch:false};}
        get value(){return this.current;}
        set value(value){this.current=String(Math.max(Number(this.min),Math.min(Number(this.max),Math.round(Number(value)*2)/2)));}
        cloneNode(){return Object.assign(new HTMLInputElement(),this);}
        matches(){return this.disabled===true;} closest(){return null;} contains(){return false;} scrollIntoView(){}
        getBoundingClientRect(){return {width:100,height:20,left:0,top:0,right:100,bottom:20};}
        dispatchEvent(event){events.push(event.type);}
      };
      globalThis.input=Object.assign(new HTMLInputElement(),patch);
      globalThis.document={querySelector:selector=>selector===':modal'?null:selector==='#speed'?input:{get textContent(){return input.value;}},
        querySelectorAll:selector=>selector.startsWith('[role=')?[]:patch.ambiguous?[input,input]:[input],
        elementFromPoint:()=>patch.occluded?null:input};`, page)
    runInContext(validation.CONTROLLED_CLOCK_SOURCE, page)
    const client = { async send(method, params) {
      assert.equal(method, 'Runtime.evaluate')
      return { result: { value: runInContext(params.expression, page) } }
    } }
    const run = () => mode === 'real-time'
      ? validation.dispatchInteractions(client, { interactions: [{ input: { selector: '#speed', value } }] }, new AbortController().signal)
      : validation.runClockSteps(client, [{ at_ms: 100, run_callbacks: false,
        input: { selector: '#speed', value }, checks: [{ selector: '#value', min: value, max: value }] }],
      new AbortController().signal)
    if (valid) {
      const result = await run()
      if (mode === 'controlled-clock') {
        assert.equal(result.sequenceChecks[0].passed, true)
        assert.match(result.interactions[0], /programmatic-input.*#speed/)
      } else assert.deepEqual(result, ['programmatic-range:#speed=2'])
      assert.equal(runInContext('JSON.stringify(events)', page), '["input","change"]')
    } else {
      await assert.rejects(run)
      assert.equal(runInContext('events.length', page), 0, 'a rejected input cannot dispatch acceptance events')
      assert.equal(runInContext('input.value', page), '1', 'an invalid request cannot mutate the live value')
    }
  }
})

test('text interactions honor cancellation before inserting native input', async () => {
  let calls = 0
  const controller = new AbortController()
  const client = { async send(method) {
    calls++
    assert.equal(method, 'Runtime.evaluate')
    controller.abort(new Error('cancel text input'))
    return { result: { value: null } }
  } }
  const args = { interactions: [{ selector: '#text', text: 'not inserted' }] }
  await assert.rejects(validation.dispatchInteractions(client, args, controller.signal), /cancel text input/)
  assert.equal(calls, 1, 'cancellation during focus preparation prevents Input.insertText')
  await assert.rejects(validation.dispatchInteractions(client, args, controller.signal), /cancel text input/)
  assert.equal(calls, 1, 'already-aborted input does not touch the browser')
})

test('navigation keys use CDP key pairs and cancellation releases a held key before stopping', async () => {
  const calls = [], client = { async send(method, params) { calls.push({ method, ...params }); return {} } }
  for (const key of ['Tab', 'Enter', 'Escape', 'Home', 'End']) {
    const sent = await validation.dispatchInteractions(client, { interactions: [{ key, hold_ms: 0 }] })
    assert.deepEqual(sent, [`${key}:0ms`])
    const [down, up] = calls.slice(-2)
    assert.equal(down.method, 'Input.dispatchKeyEvent'); assert.equal(down.type, 'keyDown')
    assert.equal(up.type, 'keyUp'); assert.equal(up.key, key)
    assert.equal(Object.hasOwn(down, 'nativeVirtualKeyCode'), false)
    assert.equal(Object.hasOwn(up, 'text'), false)
    if (key === 'Enter') assert.equal(down.text, '\r')
  }
  const controller = new AbortController(), reason = new Error('cancel held key'), interrupted = []
  const blocked = { async send(_method, params) {
    interrupted.push(params.type)
    if (params.type === 'keyDown') controller.abort(reason)
    return {}
  } }
  await assert.rejects(validation.dispatchInteractions(blocked, { interactions: [
    { key: 'Tab', hold_ms: 2000 }, { key: 'Enter', hold_ms: 0 },
  ] }, controller.signal), error => error === reason)
  assert.deepEqual(interrupted, ['keyDown', 'keyUp'])
})

test('control actions honor cancellation after evaluation and never continue the sequence', async () => {
  for (const action of [{ input: { selector: '#speed', value: 2 } }, { select: { selector: '#mode', value: 'b' } }]) {
    const controller = new AbortController(), reason = new Error('cancel after control evaluation')
    let calls = 0
    const client = { async send(method) {
      calls++
      assert.equal(method, 'Runtime.evaluate')
      controller.abort(reason)
      return { result: { value: { value: '2' } } }
    } }
    const args = { interactions: [action, { key: 'Enter', hold_ms: 0 }] }
    await assert.rejects(validation.dispatchInteractions(client, args, controller.signal), error => error === reason)
    assert.equal(calls, 1)
    await assert.rejects(validation.dispatchInteractions(client, args, controller.signal), error => error === reason)
    assert.equal(calls, 1, 'already-cancelled controls do not touch the page')
  }
})

test('Canvas context observation never initializes a canvas or changes native calls', () => {
  const realm = createContext({ calls: [] })
  runInContext(`class HTMLCanvasElement {
    getContext(kind, options) {
      calls.push({receiver:this,kind,options});
      if (!(this instanceof HTMLCanvasElement)) throw new TypeError('native receiver');
      if (kind === 'throw') throw new RangeError('native context error');
      if (!['2d','webgl','webgl2','webgpu','bitmaprenderer'].includes(kind)) return null;
      if (this.kind && this.kind !== kind) return null;
      this.kind = kind;
      return this.context ??= {kind};
    }
  }
  globalThis.HTMLCanvasElement=HTMLCanvasElement;
  globalThis.canvases=Array.from({length:5},()=>new HTMLCanvasElement());
  globalThis.options={alpha:false};`, realm)
  runInContext(validation.CANVAS_DIAGNOSTICS_SOURCE, realm)
  assert.equal(realm.calls.length, 0, 'installing diagnostics cannot allocate any native context')
  assert.equal(runInContext('canvases[0].kind', realm), undefined)
  const original = runInContext('HTMLCanvasElement.prototype.getContext', realm)
  runInContext(validation.CANVAS_DIAGNOSTICS_SOURCE, realm)
  assert.equal(runInContext('HTMLCanvasElement.prototype.getContext', realm), original, 'installation is idempotent')
  for (const [index, api] of ['2d', 'webgl', 'webgl2', 'webgpu', 'bitmaprenderer'].entries()) {
    const context = runInContext(`canvases[${index}].getContext(${JSON.stringify(api)}, options)`, realm)
    assert.equal(context, runInContext(`canvases[${index}].context`, realm))
    assert.equal(realm.calls[index].options, realm.options)
    const observed = runInContext(`globalThis[Symbol.for('dsh.apex.canvas-contexts.v1')]?.get(canvases[${index}])`, realm)
    assert.equal(observed?.api, api)
    assert.equal(observed.context, context)
  }
  assert.equal(realm.calls.length, 5, 'observation cannot repeat native calls')
  assert.equal(runInContext("canvases[0].getContext('webgpu')", realm), null)
  assert.equal(runInContext("globalThis[Symbol.for('dsh.apex.canvas-contexts.v1')].get(canvases[0]).api", realm), '2d')
  assert.throws(() => runInContext("canvases[0].getContext('throw')", realm), /native context error/)
  assert.throws(() => runInContext("HTMLCanvasElement.prototype.getContext.call({}, '2d')", realm), /native receiver/)
  assert.equal(realm.calls.length, 8)
})

test('Canvas diagnostics observe silent non-finite calls without changing native behavior', () => {
  const realm = createContext({ calls: [] })
  runInContext(`class CanvasRenderingContext2D {
    moveTo(...args) { calls.push({ receiver: this, args }); return 7; }
    lineTo(...args) { calls.push({ receiver: this, args }); }
    arc() { throw new RangeError('native error'); }
  }
  globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
  globalThis.context = new CanvasRenderingContext2D();`, realm)
  assert.equal(typeof validation.CANVAS_DIAGNOSTICS_SOURCE, 'string')
  runInContext(validation.CANVAS_DIAGNOSTICS_SOURCE, realm)
  assert.equal(runInContext('context.moveTo(1, 2)', realm), 7)
  runInContext('for (let i = 0; i < 1000; i++) { context.moveTo(NaN, 2); context.lineTo(Infinity, -Infinity); }', realm)
  const diagnostics = JSON.parse(runInContext('JSON.stringify(globalThis[Symbol.for("dsh.apex.canvas-diagnostics.v1")])', realm))
  assert.equal(diagnostics.length, 2, 'repeated bad frames must not grow diagnostics')
  assert.match(diagnostics.join('\n'), /moveTo.*non-finite/)
  assert.match(diagnostics.join('\n'), /lineTo.*non-finite/)
  assert.equal(realm.calls.length, 2001, 'observation must neither drop nor repeat native calls')
  assert.equal(realm.calls[0].receiver, realm.context)
  assert.throws(() => runInContext('context.arc()', realm), /native error/)
  runInContext(validation.CANVAS_DIAGNOSTICS_SOURCE, realm)
  runInContext('context.moveTo(NaN, 2)', realm)
  assert.equal(realm.calls.length, 2002, 'reinstallation must not double-wrap the prototype')
})

test('sequence sampler captures the state before an action and cleans up its callback', async () => {
  let now = 0, text = '0', nextId = 0
  const frames = new Map()
  const page = createContext({ performance: { now: () => now },
    document: { querySelector: () => ({ textContent: text }) },
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId },
    cancelAnimationFrame(id) { frames.delete(id) } })
  const client = { async send(_method, params) { return { result: { value: runInContext(params.expression, page) } } } }
  const check = { id: 'progress', selector: '#value', expectation: 'numeric-progress', min_delta: 50 }
  const result = await validation.sampleAnimationFrames(client, 500, new AbortController().signal,
    async () => { now = 500 }, [check], async () => {
      assert.equal(frames.size, 1, 'sampling must already be active at action dispatch')
      text = '100'
    })
  assert.equal(result.samples[0].values[0].text, '0')
  assert.equal(result.samples.at(-1).values[0].text, '100')
  assert.equal(validation.sequenceCheckResults([check], result.samples)[0].passed, true)
  assert.equal(frames.size, 0)
})
