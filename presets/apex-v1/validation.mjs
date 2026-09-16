/** Real-browser checks of locally served artifacts. Protocol helpers derive from APEX 0.7. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { artifactRoot, artifactSnapshot } from './artifacts.mjs'
import { registerTool } from './tools.mjs'

export const name = 'apex-validation'
export const inject = ['tools', 'subprocess']

const MAX_DIAGNOSTICS = 20
const MAX_DIAGNOSTIC_CHARS = 600
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SETTLE_MS = 1_000
const DEFAULT_SAMPLE_MS = 1_500
const CDP_CALL_TIMEOUT_MS = 8_000
const RAF_SAMPLE_SYMBOL = 'dsh.apex.fps-sample.v1'
const MAX_SEQUENCE_SAMPLES = 12
const CANVAS_DIAGNOSTICS_SYMBOL = 'dsh.apex.canvas-diagnostics.v1'
const CANVAS_CONTEXTS_SYMBOL = 'dsh.apex.canvas-contexts.v1'
const CONTROLLED_CLOCK_SYMBOL = 'dsh.apex.controlled-clock.v1'
const SEQUENCE_EXPECTATIONS = Object.freeze([
  'contains-throughout',
  'stable',
  'changes',
  'numeric-nondecreasing',
  'numeric-progress',
])

// Keep headless system browsers from treating their only page as backgrounded.
// These are Chromium-native flags also used by browser automation runtimes.
const HEADLESS_FOREGROUND_FLAGS = Object.freeze([
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
])

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const KEY_DEFINITIONS = Object.freeze({
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  KeyA: { key: 'a', code: 'KeyA', keyCode: 65 },
  KeyD: { key: 'd', code: 'KeyD', keyCode: 68 },
  KeyS: { key: 's', code: 'KeyS', keyCode: 83 },
  KeyW: { key: 'w', code: 'KeyW', keyCode: 87 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
})

function bounded(value, max = MAX_DIAGNOSTIC_CHARS) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, max)
}

function pushBounded(list, value) {
  const text = bounded(value)
  if (text.length > 0 && list.length < MAX_DIAGNOSTICS && !list.includes(text)) list.push(text)
}

/** Runs before page scripts. Observe ignored numeric calls; preserve native results/errors. */
function installCanvasDiagnostics(key, limit, contextsKey) {
  const symbol = Symbol.for(key)
  if (globalThis[symbol] !== undefined) return
  const errors = []
  globalThis[symbol] = errors
  const contexts = new WeakMap()
  globalThis[Symbol.for(contextsKey)] = contexts
  const canvasType = globalThis.HTMLCanvasElement
  const descriptor = canvasType && Object.getOwnPropertyDescriptor(canvasType.prototype, 'getContext')
  if (typeof descriptor?.value === 'function') {
    const original = descriptor.value
    Object.defineProperty(canvasType.prototype, 'getContext', { ...descriptor, value: function (...args) {
      const context = Reflect.apply(original, this, args)
      // Do not coerce the argument again or create a context on behalf of the page.
      if (context && ['2d', 'webgl', 'experimental-webgl', 'webgl2', 'webgpu', 'bitmaprenderer'].includes(args[0])) {
        contexts.set(this, { api: args[0] === 'experimental-webgl' ? 'webgl' : args[0], context })
      }
      return context
    } })
  }
  const methods = {
    moveTo: [0, 2], lineTo: [0, 2], quadraticCurveTo: [0, 4], bezierCurveTo: [0, 6],
    arc: [0, 5], arcTo: [0, 5], ellipse: [0, 7], rect: [0, 4],
    clearRect: [0, 4], fillRect: [0, 4], strokeRect: [0, 4],
    translate: [0, 2], scale: [0, 2], rotate: [0, 1], transform: [0, 6], setTransform: [0, 6],
    fillText: [1, 4], strokeText: [1, 4], drawImage: [1, 9], putImageData: [1, 7],
  }
  for (const Type of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
    if (Type === undefined) continue
    for (const [method, [start, end]] of Object.entries(methods)) {
      const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, method)
      if (typeof descriptor?.value !== 'function') continue
      const original = descriptor.value
      Object.defineProperty(Type.prototype, method, { ...descriptor, value: function (...args) {
        if (errors.length < limit) {
          const invalid = []
          for (let i = start; i < Math.min(end, args.length); i++) {
            if (typeof args[i] === 'number' && !Number.isFinite(args[i])) invalid.push(i)
          }
          if (invalid.length > 0) {
            const detail = `Canvas2D.${method}: non-finite numeric argument(s): ${invalid.join(',')}`
            if (!errors.includes(detail)) errors.push(detail)
          }
        }
        return Reflect.apply(original, this, args)
      } })
    }
  }
}

export const CANVAS_DIAGNOSTICS_SOURCE = `(${installCanvasDiagnostics.toString()})(${JSON.stringify(CANVAS_DIAGNOSTICS_SYMBOL)}, ${MAX_DIAGNOSTICS}, ${JSON.stringify(CANVAS_CONTEXTS_SYMBOL)})`

/** Optional main-document probe, not a general event-loop or browser-time emulator. */
function installControlledClock(key) {
  if (globalThis.top && globalThis.top !== globalThis) return
  let now = 0, nextId = 0, fault = ''
  const epoch = Date.now(), frames = new Map(), timers = new Map()
  const unsupported = message => { fault = `Controlled clock unsupported: ${message}`; throw new Error(fault) }
  const allocate = callback => {
    if (typeof callback !== 'function') unsupported('only function callbacks are supported')
    if (frames.size + timers.size >= 512) unsupported('more than 512 pending callbacks')
    return ++nextId
  }
  const schedule = (callback, ms, args, repeat) => {
    const id = allocate(callback)
    const period = Math.max(1, Number(ms) || 0)
    if (!Number.isFinite(period)) unsupported('non-finite timer delay')
    timers.set(id, { callback, args, period, due: now + period, repeat })
    return id
  }
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  Date.now = () => epoch + now
  globalThis.requestAnimationFrame = callback => { const id = allocate(callback); frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  globalThis.setTimeout = (callback, ms, ...args) => schedule(callback, ms, args, false)
  globalThis.setInterval = (callback, ms, ...args) => schedule(callback, ms, args, true)
  globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id)
  const invoke = (callback, args) => {
    try { callback.apply(globalThis, args) }
    catch (error) { globalThis.reportError(error) }
  }
  globalThis[Symbol.for(key)] = {
    assertSupported() { if (fault) throw new Error(fault); return true },
    advance(at, runCallbacks) {
      this.assertSupported()
      if (!Number.isSafeInteger(at) || at < now || at > 60_000) unsupported('time must be monotonic within 60000 ms')
      now = at
      if (runCallbacks) {
        // Snapshot first: each due timer and queued frame runs once; newly queued work waits for the next step.
        const pendingFrames = [...frames]
        const dueTimers = [...timers].filter(([, timer]) => timer.due <= now)
        for (const [id, timer] of dueTimers) {
          if (!timers.has(id)) continue
          if (timer.repeat) timer.due = now + timer.period
          else timers.delete(id)
          invoke(timer.callback, timer.args)
        }
        for (const [id, callback] of pendingFrames) {
          if (!frames.delete(id)) continue
          invoke(callback, [now])
        }
      }
      return this.assertSupported()
    },
  }
}

export const CONTROLLED_CLOCK_SOURCE = `(${installControlledClock.toString()})(${JSON.stringify(CONTROLLED_CLOCK_SYMBOL)})`

/** Compare browser-reported and requested URLs after standard URL encoding. */
export function sameNetworkUrl(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)
    leftUrl.hash = ''
    rightUrl.hash = ''
    return leftUrl.href === rightUrl.href
  } catch {
    return false
  }
}

function abortReason(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error(fallback)
  error.name = 'AbortError'
  return error
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal, 'operation cancelled'))
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish(abortReason(signal, 'operation cancelled'))
    function finish(error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error instanceof Error) reject(error)
      else resolveDelay()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function inside(root, target) {
  const value = relative(root, target)
  return value.length === 0 || (value !== '..'
    && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(value))
}

async function staticFile(root, requestPath) {
  let pathname
  try {
    pathname = decodeURIComponent(requestPath.split('?', 1)[0])
  } catch {
    return undefined
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined
  const candidate = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`)
  if (!inside(root, candidate)) return undefined
  try {
    const info = await fs.stat(candidate)
    const file = info.isDirectory() ? join(candidate, 'index.html') : candidate
    const canonical = await fs.realpath(file)
    return inside(root, canonical) ? canonical : undefined
  } catch {
    return undefined
  }
}

/** Start one loopback-only static server and expose an idempotent close. */
export async function startStaticServer(root, signal) {
  signal?.throwIfAborted()
  const canonicalRoot = await fs.realpath(root)
  signal?.throwIfAborted()
  const requests = []
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const requestUrl = request.url ?? '/'
    if (requests.length < 100) requests.push({ method, url: bounded(requestUrl, 300) })
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    if (requestUrl.split('?', 1)[0] === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' }).end()
      return
    }
    const file = await staticFile(canonicalRoot, requestUrl)
    if (file === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    try {
      const body = await fs.readFile(file)
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': body.byteLength,
        'Content-Type': MIME_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      })
      response.end(method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Read failed')
    }
  })
  try {
    await once(server.listen(0, '127.0.0.1'), 'listening', { signal })
  } catch (error) {
    await new Promise((resolveClose, reject) => {
      server.close(closeError => {
        if (closeError && closeError.code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(new AggregateError([error, closeError], 'Static server startup and cleanup failed'))
        } else resolveClose()
      })
    })
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('static server did not expose a TCP port')
  let closed = false
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      if (closed) return
      closed = true
      await new Promise((resolveClose, reject) => {
        server.close(error => error === undefined ? resolveClose() : reject(error))
        server.closeAllConnections?.()
      })
    },
  }
}

function browserCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'google-chrome',
      'chromium',
    ]
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(value => typeof value === 'string' && value.length > 0)
    return [
      ...roots.flatMap(root => [
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]),
      'chrome.exe',
      'msedge.exe',
      'chromium.exe',
    ]
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
}

export async function resolveBrowser(subprocess, signal) {
  for (const candidate of browserCandidates()) {
    try {
      return await subprocess.resolveExecutable(candidate, undefined, signal)
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  return undefined
}

async function devtoolsPort(userDataDir, handle, signal) {
  const path = join(userDataDir, 'DevToolsActivePort')
  while (!signal.aborted) {
    try {
      const [port] = (await fs.readFile(path, 'utf8')).trim().split(/\r?\n/)
      if (/^\d+$/.test(port)) return Number(port)
    } catch {
      // Chrome writes the file only after its remote-debugging listener is ready.
    }
    const outcome = await Promise.race([
      handle.done.then(value => ({ outcome: value }), error => ({ error })),
      delay(50, signal).then(() => undefined),
    ])
    if (outcome?.error !== undefined) throw outcome.error
    if (outcome?.outcome !== undefined) throw new Error('browser exited before DevTools became ready')
  }
  throw abortReason(signal, 'browser startup timed out')
}

async function jsonFetch(url, signal) {
  signal.throwIfAborted()
  // Node fetch may add stack to its abort reason. Keep that mutable request-local
  // error separate from the Harness cancellation cause persisted in turn/end.
  const request = new AbortController()
  const abort = () => request.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, { signal: request.signal })
    if (!response.ok) throw new Error(`DevTools discovery returned HTTP ${response.status}`)
    return await response.json()
  } finally {
    signal.removeEventListener('abort', abort)
    request.abort()
  }
}

async function connectWebSocket(url, signal) {
  if (signal.aborted) throw abortReason(signal, 'DevTools connection cancelled')
  return await new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url)
    const onAbort = () => {
      socket.close()
      reject(abortReason(signal, 'DevTools connection cancelled'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    socket.addEventListener('open', () => {
      cleanup()
      resolveSocket(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      cleanup()
      reject(new Error('DevTools WebSocket connection failed'))
    }, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function cdpClient(socket, signal) {
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  const onAbort = () => {
    rejectPending(abortReason(signal, 'DevTools call cancelled'))
    socket.close()
  }
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (Number.isInteger(message.id)) {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) entry.reject(new Error(bounded(message.error.message ?? 'DevTools call failed')))
      else entry.resolve(message.result ?? {})
      return
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {})
  })
  socket.addEventListener('close', () => rejectPending(new Error('DevTools connection closed')))
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    on(method, listener) {
      const values = listeners.get(method) ?? new Set()
      values.add(listener)
      listeners.set(method, values)
      return () => {
        values.delete(listener)
        if (values.size === 0) listeners.delete(method)
      }
    },
    send(method, params = {}) {
      if (signal.aborted) return Promise.reject(abortReason(signal, 'DevTools call cancelled'))
      const id = nextId
      nextId += 1
      return new Promise((resolveCall, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`DevTools ${method} timed out`))
        }, CDP_CALL_TIMEOUT_MS)
        pending.set(id, { resolve: resolveCall, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      signal.removeEventListener('abort', onAbort)
      rejectPending(new Error('DevTools client closed'))
      listeners.clear()
      socket.close()
    },
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(bounded(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page evaluation failed'))
  }
  return result.result?.value
}

/**
 * Sample page animation without holding one awaited Runtime.evaluate call open.
 * Chrome can starve a newly scheduled rAF while DevTools is awaiting that same
 * evaluation, even though the application's existing animation loop continues.
 */
export async function sampleAnimationFrames(
  client,
  sampleMs,
  signal,
  waitForSample = delay,
  sequenceChecks = [],
  duringSample,
) {
  const symbol = JSON.stringify(RAF_SAMPLE_SYMBOL)
  const checks = JSON.stringify(sequenceChecks)
  const sampleIntervalMs = Math.max(250, Math.ceil(sampleMs / MAX_SEQUENCE_SAMPLES))
  const started = await evaluate(client, `(() => {
    const key = Symbol.for(${symbol});
    const previous = globalThis[key];
    if (previous?.frameId) cancelAnimationFrame(previous.frameId);
    const started = performance.now();
    const checks = ${checks}, previousTexts = [];
    const firstNumber = ${firstNumber.toString()};
    const state = { active: true, started, last: started, lastObserved: started, frames: 0, deltas: [], samples: [], frameId: 0 };
    function observe(now) {
      state.samples.push({
        elapsedMs: now - started,
        values: checks.map((check, index) => {
          try {
            const item = document.querySelector(check.selector);
            const text = item ? String(item.textContent ?? '') : '';
            const sameAsPrevious = previousTexts[index] === text;
            previousTexts[index] = text;
            const number = firstNumber(text);
            return { found: item !== null, text: text.slice(0, 500), sameAsPrevious,
              containsExpected: check.contains !== undefined && text.includes(check.contains),
              number: Number.isFinite(number) ? number : null };
          } catch {
            return { found: false, text: '' };
          }
        })
      });
      state.lastObserved = now;
    }
    state.observe = observe;
    observe(started);
    function frame(now) {
      if (!state.active) return;
      if (state.frames > 0) state.deltas.push(now - state.last);
      state.frames += 1;
      state.last = now;
      // Reserve the final observation for collection, including a delayed host read.
      if (state.samples.length < ${MAX_SEQUENCE_SAMPLES} && now - state.lastObserved >= ${sampleIntervalMs}) observe(now);
      state.frameId = requestAnimationFrame(frame);
    }
    state.frameId = requestAnimationFrame(frame);
    globalThis[key] = state;
    return true;
  })()`)
  if (started !== true) throw new Error('frame sampler did not start')

  if (duringSample) await duringSample()
  await waitForSample(sampleMs, signal)
  const result = await evaluate(client, `(() => {
    const key = Symbol.for(${symbol});
    const state = globalThis[key];
    if (!state) return null;
    state.active = false;
    if (state.frameId) cancelAnimationFrame(state.frameId);
    delete globalThis[key];
    const finished = performance.now();
    if (state.samples.length <= ${MAX_SEQUENCE_SAMPLES} && finished > state.lastObserved) {
      state.observe(finished);
    }
    const elapsed = Math.max(1, finished - state.started);
    const sorted = state.deltas.slice().sort((a, b) => a - b);
    return {
      frames: state.frames,
      durationMs: elapsed,
      fps: state.frames * 1000 / elapsed,
      p95FrameMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
      samples: state.samples
    };
  })()`)
  if (result === null
    || !Number.isFinite(result.frames)
    || !Number.isFinite(result.durationMs)
    || !Number.isFinite(result.fps)
    || !Number.isFinite(result.p95FrameMs)
    || !Array.isArray(result.samples)) {
    throw new Error('frame sampler returned invalid metrics')
  }
  return result
}

async function waitForDocument(client, signal, requireComplete = false) {
  while (!signal.aborted) {
    const state = await evaluate(client, 'document.readyState')
    if (state === 'complete' || !requireComplete && state === 'interactive') return state
    await delay(50, signal)
  }
  throw abortReason(signal, 'document readiness timed out')
}

/** A reload acknowledgement or an old document's readyState is not a new-page load. */
async function reloadDocument(client, signal = AbortSignal.timeout(CDP_CALL_TIMEOUT_MS)) {
  signal.throwIfAborted()
  const previous = (await client.send('Page.getFrameTree')).frameTree?.frame
  if (!previous?.id || !previous.loaderId || !previous.url) throw new Error('Reload requires an identified main document')
  let loaded
  const unsubscribe = client.on('Page.lifecycleEvent', event => {
    if (event.frameId === previous.id && event.name === 'load'
      && event.loaderId && event.loaderId !== previous.loaderId) loaded = event.loaderId
  })
  try {
    await client.send('Page.setLifecycleEventsEnabled', { enabled: true })
    await client.send('Page.reload', { ignoreCache: true, loaderId: previous.loaderId })
    while (loaded === undefined) await delay(50, signal)
    signal.throwIfAborted()
    const current = (await client.send('Page.getFrameTree')).frameTree?.frame
    if (current?.id !== previous.id || current.loaderId !== loaded
      || !sameNetworkUrl(current.url, previous.url)) {
      throw new Error('Reload did not finish on the same page with a new main document')
    }
    await waitForDocument(client, signal, true)
  } finally {
    unsubscribe()
  }
}

/** Require a concrete host action whenever the caller declares an interaction claim. */
export function interactionContractDenial(args) {
  for (const [label, action] of [['top-level', args],
    ...(args.interactions ?? []).map((item, index) => [`interactions[${index}]`, item]),
    ...(args.clock_steps ?? []).map((item, index) => [`clock_steps[${index}]`, item])]) {
    if (action?.reload !== undefined) {
      if (!label.startsWith('interactions[') || action.reload !== true || Object.keys(action).length !== 1) {
        return `${label}: reload must be true in its own ordered action`
      }
      if (args.sequence_start === 'before-actions') return 'reload cannot be combined with sequence_start:before-actions; sample only after the new document loads'
    }
    if (action?.wait_ms !== undefined && (!label.startsWith('interactions[')
      || !Number.isInteger(action.wait_ms) || action.wait_ms < 0 || action.wait_ms > 10_000
      || Object.keys(action).length !== 1)) {
      return `${label}: wait_ms must be an integer from 0 to 10000 in its own ordered action; it cannot include a key, click or text input`
    }
    if (action?.pointer_lock_selector === undefined) continue
    if (typeof action.pointer_lock_selector !== 'string' || !action.pointer_lock_selector.trim()
      || action.pointer_lock_selector.length > 160) return `${label}: pointer_lock_selector requires a nonblank selector of at most 160 characters`
    const clicks = Number(typeof action.click_selector === 'string' && action.click_selector.length > 0)
      + Number(action.click_canvas === true)
    if (clicks !== 1 || action.key !== undefined || action.text !== undefined || action.input !== undefined || action.select !== undefined) {
      return `${label}: pointer_lock_selector requires exactly one click action at the same level; it waits for that click's native lock before continuing. For an interactions click, put both fields on that action: {click_selector:"#start",pointer_lock_selector:"#view"}. Do not put its pointer_lock_selector at top level.`
    }
  }
  if (args.interaction_required !== true) return undefined
  const hasAction = args.click_canvas === true
    || (typeof args.click_selector === 'string' && args.click_selector.length > 0)
    || (Array.isArray(args.interactions) && args.interactions.some(item => item?.key || item?.selector || item?.click_selector || item?.input || item?.select))
    || (Array.isArray(args.clock_steps) && args.clock_steps.some(step => step?.click_selector || step?.input))
  return hasAction
    ? undefined
    : 'interaction_required=true needs click_selector, click_canvas=true, a bounded click/key/text/input/select interactions action, or a clock_steps action; waiting, reload or assertion text alone never executes an input action.'
}

function consoleText(params) {
  return (params.args ?? [])
    .map(value => value.value ?? value.description ?? value.type ?? '')
    .join(' ')
}

/** Browser-side visibility, separate from hit testing: pointer-events:none may still be visible. */
export function elementVisible(item, inViewport = true) {
  if (!item) return false
  if (typeof item.checkVisibility === 'function'
    && !item.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false
  const rect = item.getBoundingClientRect(), style = getComputedStyle(item)
  if (rect.width <= 0 || rect.height <= 0 || style.display === 'none'
    || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false
  let left = inViewport ? Math.max(0, rect.left) : rect.left, right = inViewport ? Math.min(innerWidth, rect.right) : rect.right
  let top = inViewport ? Math.max(0, rect.top) : rect.top, bottom = inViewport ? Math.min(innerHeight, rect.bottom) : rect.bottom
  for (let parent = item.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent)
    if (css.opacity === '0') return false
    // Fixed descendants can escape ordinary ancestor overflow; hit checks remain authoritative for actions.
    if (style.position === 'fixed') continue
    const bounds = parent.getBoundingClientRect()
    if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
    }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
    }
  }
  return right > left && bottom > top
}

/** Browser-side hit sampling; no input events and no scrolling unless explicitly requested. */
function controlHitTarget(item, scroll = false) {
  if (!item) return 'missing'
  if (item.matches(':disabled, [aria-disabled="true"]') || item.closest('[inert], [aria-hidden="true"]')) return 'disabled'
  const nativeModal = document.querySelector(':modal')
  const declaredModals = nativeModal ? [] : [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')]
    .filter(dialog => {
      if (dialog.closest('[inert], [aria-hidden="true"]')) return false
      if (typeof dialog.checkVisibility === 'function'
        && !dialog.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false
      const rect = dialog.getBoundingClientRect(), style = getComputedStyle(dialog)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
    })
  // Multiple unrelated declared modals are ambiguous: do not hide background failures.
  const modal = nativeModal ?? (declaredModals.length === 1 ? declaredModals[0] : undefined)
  if (modal && !modal.contains(item)) return 'disabled'
  if (scroll) item.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof item.checkVisibility === 'function'
    && !item.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return 'hidden'
  const rect = item.getBoundingClientRect(), style = getComputedStyle(item)
  if (rect.width <= 0 || rect.height <= 0 || style.display === 'none'
    || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return 'hidden'
  let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
  const viewportBounds = { left, right, top, bottom }
  for (let parent = item.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect()
    if (css.opacity === '0') return 'hidden'
    if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
    }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
    }
  }
  // Native hit testing wins over ancestor clipping estimates (e.g. fixed-position controls).
  for (const area of [viewportBounds, { left, right, top, bottom }]) {
    if (area.right <= area.left || area.bottom <= area.top) continue
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
      const x = area.left + (area.right - area.left) * fx, y = area.top + (area.bottom - area.top) * fy
      const hit = document.elementFromPoint(x, y)
      if (hit === item || item.contains(hit) || hit?.closest('label')?.control === item) return { x, y }
    }
  }
  if (right <= left || bottom <= top) return 'offscreen'
  return 'occluded'
}

/** Inspect only the current main-document view; never infer geometry or trigger controls. */
async function inspectPageLayout(hitTarget, visible, limit) {
  const layoutErrors = [], canvasErrors = [], warnings = [], layoutChecks = []
  const identify = item => (item.id ? '#' + item.id : item.tagName.toLowerCase()).slice(0, 100)
  const controls = document.querySelectorAll('button, input, select, textarea, [role="button"], [role="slider"], [role="checkbox"]')
  let checked = 0, offscreen = 0
  // ponytail: sample at most 200 controls/20 canvases in this view; larger or
  // offscreen interfaces need explicit scoped actions, not an automatic UI crawl.
  for (let index = 0; index < Math.min(controls.length, 200); index++) {
    const item = controls[index]
    const hit = hitTarget(item)
    if (hit === 'offscreen') offscreen++
    else if (hit === 'occluded') {
      checked++
      if (layoutErrors.length < limit) layoutErrors.push(identify(item) + ': all sampled hit points are occluded')
    } else if (typeof hit === 'object') checked++
  }
  layoutChecks.push('Main-document controls: ' + checked + ' hit-tested; ' + offscreen + ' offscreen/clipped (unverified); hidden/disabled controls excluded.')
  if (controls.length > 200) warnings.push('Control scan limit reached; remaining controls are unverified.')
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(item => visible(item))
  let drawable = 0
  for (const canvas of canvases.slice(0, limit)) {
    const label = identify(canvas)
    if (canvas.width === 0 || canvas.height === 0) {
      canvasErrors.push(label + ': visible canvas has an empty bitmap')
      continue
    }
    try {
      // Crop one pixel; do not serialize or copy the full backing store.
      const bitmap = await createImageBitmap(canvas, 0, 0, 1, 1)
      bitmap.close()
      drawable++
    } catch (error) {
      if (error?.name === 'InvalidStateError') canvasErrors.push(label + ': canvas bitmap is not drawable (InvalidStateError)')
      else if (warnings.length < limit) warnings.push(label + ': bitmap check unverified (' + String(error?.name).slice(0, 80) + ')')
    }
  }
  layoutChecks.push('Canvas bitmap availability: ' + drawable + '/' + canvases.length + ' visible canvases drawable in this sample; this does not verify drawing content or geometry.')
  if (canvases.length > limit && warnings.length < limit) warnings.push('Canvas scan limit reached; remaining bitmaps are unverified.')
  return { layoutErrors, canvasErrors, warnings, layoutChecks }
}

export const LAYOUT_DIAGNOSTICS_SOURCE = `(${inspectPageLayout.toString()})(${controlHitTarget.toString()}, ${elementVisible.toString()}, ${MAX_DIAGNOSTICS})`

async function targetPoint(client, selector, firstVisible = false) {
  const point = await evaluate(client, `(() => {
    const visible = item => {
      const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && !['hidden', 'collapse'].includes(style.visibility);
    };
    const targets = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const item = ${firstVisible ? 'targets.find(visible)' : 'targets[0]'};
    return (${controlHitTarget.toString()})(item, true);
  })()`)
  if (typeof point === 'string') {
    const error = new Error(`Interaction target is ${point}: ${selector}`)
    error.layoutFailure = point === 'occluded'
    throw error
  }
  return point
}

/** Wait for a native lock on exactly one connected element; never change the page's Pointer Lock API. */
export async function waitForPointerLock(client, selector, signal) {
  const deadline = Date.now() + CDP_CALL_TIMEOUT_MS
  while (true) {
    signal?.throwIfAborted()
    const state = await evaluate(client, `(() => {
      const matches = document.querySelectorAll(${JSON.stringify(selector)});
      if (matches.length !== 1 || !matches[0].isConnected) return 'missing-or-ambiguous';
      return document.pointerLockElement === matches[0] ? 'locked' : 'pending';
    })()`)
    if (state === 'locked') return
    if (state !== 'pending') throw new Error(`Pointer Lock target is ${state}: ${selector}`)
    if (Date.now() >= deadline) throw new Error(`Pointer Lock did not activate for ${selector}; dependent actions were not dispatched`)
    await delay(25, signal)
  }
}

async function clickTarget(client, selector, firstVisible = false, pointerLockSelector, signal) {
  signal?.throwIfAborted()
  const point = await targetPoint(client, selector, firstVisible)
  signal?.throwIfAborted()
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  if (pointerLockSelector !== undefined) await waitForPointerLock(client, pointerLockSelector, signal)
}

/** Replace text with native browser input, not a value setter or synthetic input/change event. */
async function fillText(client, item, signal) {
  signal?.throwIfAborted()
  const target = JSON.stringify(item.selector)
  const denial = await evaluate(client, `(() => {
    const targets = document.querySelectorAll(${target});
    if (targets.length !== 1) return 'missing or ambiguous';
    const item = targets[0];
    if (!(item instanceof HTMLTextAreaElement)
      && !(item instanceof HTMLInputElement && ['text', 'search', 'tel', 'url'].includes(item.type))) return 'unsupported type';
    const type = item.type;
    if (item.readOnly) return 'read-only';
    if (item instanceof HTMLInputElement && /[\\r\\n]/.test(${JSON.stringify(item.text)})) return 'single-line only';
    const hitTarget = ${controlHitTarget.toString()};
    const hit = hitTarget(item, true);
    if (typeof hit === 'string') return hit;
    item.focus({preventScroll: true});
    if (!item.isConnected || document.activeElement !== item) return 'focus changed';
    if (item.readOnly || item.type !== type || typeof hitTarget(item) === 'string') return 'changed during focus';
    item.setSelectionRange(0, item.value.length);
    return null;
  })()`)
  if (denial !== null) {
    const error = new Error(`Text input target is ${denial}: ${item.selector}`)
    error.layoutFailure = denial === 'occluded'
    throw error
  }
  signal?.throwIfAborted()
  await client.send('Input.insertText', { text: item.text })
  const normalizedText = item.text.replace(/\r\n?/g, '\n')
  const matched = await evaluate(client, `(() => {
    const targets = document.querySelectorAll(${target});
    return targets.length === 1 && targets[0].value === ${JSON.stringify(normalizedText)};
  })()`)
  if (matched !== true) throw new Error(`Text replacement did not retain the requested value: ${item.selector}. Check maxlength or application normalization; the action may already have taken effect.`)
}

/** Programmatic native-control commit, shared by real-time actions and controlled range input. */
async function setControlValue(client, request, kind, signal) {
  signal?.throwIfAborted()
  const observed = await evaluate(client, `(() => {
    const {selector, value} = ${JSON.stringify(request)}, kind = ${JSON.stringify(kind)};
    const targets = document.querySelectorAll(selector);
    if (targets.length !== 1) return {error:'target is missing or ambiguous'};
    const item = targets[0], range = kind === 'range';
    if (range ? !(item instanceof HTMLInputElement) || item.type !== 'range'
      : !(item instanceof HTMLSelectElement) || item.multiple) return {error:'unsupported type; expected '+(range?'range input':'single select')};
    const hit = (${controlHitTarget.toString()})(item, true);
    if (typeof hit === 'string') return {error:'target is '+hit, layoutFailure:hit === 'occluded'};
    const prototype = range ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    let option;
    if (range) {
      if (!Number.isFinite(value)) return {error:'range value must be finite'};
      // Let the browser apply its own min/max/step rules without mutating the live control.
      const probe = item.cloneNode(false);
      setter.call(probe, String(value));
      if (Number(probe.value) !== value || probe.validity.stepMismatch)
        return {error:'value cannot be represented by the range min/max/step'};
    } else {
      const options = [...item.options].filter(option => option.value === value);
      if (options.length !== 1) return {error:'option value is missing or ambiguous'};
      option = options[0];
      if (option.matches(':disabled, [aria-disabled="true"]') || option.closest('[hidden], optgroup[disabled]')
        || [option, option.parentElement].some(node => getComputedStyle(node).display === 'none'
          || ['hidden','collapse'].includes(getComputedStyle(node).visibility))) return {error:'option is disabled or hidden'};
    }
    const retained = () => item.isConnected && document.querySelectorAll(selector).length === 1
      && document.querySelector(selector) === item;
    setter.call(item, String(value));
    item.dispatchEvent(new Event('input', {bubbles:true}));
    if (!retained()) return {error:'target replaced or detached after input; the action may already have taken effect'};
    item.dispatchEvent(new Event('change', {bubbles:true}));
    if (!retained() || (range ? item.type !== 'range' || Number(item.value) !== value
      : item.multiple || item.value !== value || item.selectedOptions[0] !== option))
      return {error:'requested value was not retained after input/change; the action may already have taken effect'};
    return {value:item.value};
  })()`)
  signal?.throwIfAborted()
  if (observed.error) {
    const error = new Error(`Programmatic ${kind} ${observed.error}: ${request.selector}`)
    error.layoutFailure = observed.layoutFailure === true
    throw error
  }
  return observed.value
}

export async function dispatchInteractions(client, args, signal) {
  const sent = []
  if (typeof args.click_selector === 'string' && args.click_selector.length > 0) {
    await clickTarget(client, args.click_selector, false, args.pointer_lock_selector, signal)
    sent.push(`click_selector:${args.click_selector}`)
  }
  if (args.click_canvas === true) {
    await clickTarget(client, 'canvas', true, args.pointer_lock_selector, signal)
    sent.push('click_canvas')
  }
  for (const item of args.interactions ?? []) {
    signal?.throwIfAborted()
    if (item.reload === true) {
      await reloadDocument(client, signal)
      sent.push('reload:new-document')
      continue
    }
    if (item.wait_ms !== undefined) {
      await delay(item.wait_ms, signal)
      sent.push(`wait:${item.wait_ms}ms`)
      continue
    }
    if (item.text !== undefined) {
      await fillText(client, item, signal)
      sent.push(`fill:${item.selector}`)
      continue
    }
    if (item.click_selector !== undefined) {
      await clickTarget(client, item.click_selector, false, item.pointer_lock_selector, signal)
      sent.push(`click_selector:${item.click_selector}`)
      continue
    }
    if (item.input !== undefined || item.select !== undefined) {
      const request = item.input ?? item.select, kind = item.input !== undefined ? 'range' : 'select'
      const value = await setControlValue(client, request, kind, signal)
      sent.push(`programmatic-${kind}:${request.selector}=${bounded(value, 80)}`)
      continue
    }
    const { keyCode, text, ...definition } = KEY_DEFINITIONS[item.key]
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...definition,
      ...(text === undefined ? {} : { text }),
      windowsVirtualKeyCode: keyCode,
    })
    try {
      await delay(item.hold_ms, signal)
    } finally {
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', ...definition, windowsVirtualKeyCode: keyCode,
      })
    }
    sent.push(`${item.key}:${item.hold_ms}ms`)
  }
  return sent
}

/** Validate text expectations before artifact reads or browser startup. */
export function textContractDenial(args) {
  if (args.text_checks === undefined) return undefined
  if (!Array.isArray(args.text_checks) || args.text_checks.length > 8) return 'text_checks must contain at most 8 checks'
  for (const [index, check] of args.text_checks.entries()) {
    const label = `text_checks[${index}]`
    if (check === null || typeof check !== 'object' || Array.isArray(check)
      || Object.keys(check).some(key => !['phase', 'selector', 'contains', 'equals'].includes(key))) return `${label}: unsupported check fields`
    if (!['before', 'after'].includes(check.phase)
      || typeof check.selector !== 'string' || !check.selector.trim() || check.selector.length > 160) return `${label}: invalid phase or selector`
    if ((check.contains !== undefined) === (check.equals !== undefined)) return `${label}: choose exactly one of contains or equals`
    const expected = check.equals ?? check.contains
    if (typeof expected !== 'string' || expected.length > 160
      || (check.contains !== undefined && expected.length === 0)) return `${label}: expected text must be a string of at most 160 characters; contains cannot be empty`
  }
  return undefined
}

export async function inspectTextChecks(client, checks, phase) {
  const selected = (checks ?? []).filter(check => check.phase === phase)
  if (selected.length === 0) return []
  return await evaluate(client, `(() => ${JSON.stringify(selected)}.map((check) => {
    try {
      const item = document.querySelector(check.selector);
      const text = item ? String(item.textContent ?? '') : '';
      const exact = check.equals !== undefined;
      const unique = !exact || document.querySelectorAll(check.selector).length === 1;
      return {
        phase: check.phase,
        selector: check.selector,
        ...(exact ? {equals: check.equals} : {contains: check.contains}),
        observed: text.slice(0, 500),
        passed: item !== null && unique && (exact ? text.trim() === check.equals : text.includes(check.contains))
      };
    } catch {
      return { ...check, observed: '', passed: false };
    }
  }))()`)
}

/** Convert bounded DOM observations into stable actionable failures. */
export function textCheckFailures(checks) {
  return (checks ?? [])
    .filter(check => check.passed !== true)
    .map(check => `${check.phase}:${check.selector} expected ${check.equals === undefined
      ? `text containing ${JSON.stringify(check.contains)}`
      : `one element whose trimmed text equals ${JSON.stringify(check.equals)}`}`)
}

/** Reject semantically incomplete temporal checks before starting a browser. */
export function sequenceContractDenial(args) {
  if (args.sequence_checks === undefined) return undefined
  if (!Array.isArray(args.sequence_checks)) {
    return 'sequence_checks must be an array of {id, selector, expectation} objects'
  }
  if (args.sequence_checks.length > 4) return 'sequence_checks supports at most 4 checks'
  const errors = []
  const ids = new Set()
  for (const [index, check] of args.sequence_checks.entries()) {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`sequence_checks[${index}] must be an object {id, selector, expectation}; for example {"id":"state","selector":"#status","expectation":"changes"}`)
      continue
    }
    const validId = typeof check.id === 'string' && check.id.length > 0 && check.id.length <= 64
    const label = validId ? `sequence check ${check.id}` : `sequence_checks[${index}]`
    if (!validId) {
      errors.push(`sequence_checks[${index}].id must be a non-empty string of at most 64 characters`)
    }
    if (typeof check.selector !== 'string' || check.selector.length === 0 || check.selector.length > 160) {
      errors.push(`${label} requires selector; for example "#status"`)
    }
    const validExpectation = SEQUENCE_EXPECTATIONS.includes(check.expectation)
    if (!validExpectation) {
      errors.push(`${label} requires expectation: ${SEQUENCE_EXPECTATIONS.join(', ')}`)
    }
    const extra = Object.keys(check).filter(key => !['id', 'selector', 'expectation', 'contains', 'min_delta'].includes(key))
    if (extra.length > 0) errors.push(`${label} has unsupported fields: ${extra.join(', ')}`)
    if (validId) {
      if (ids.has(check.id)) errors.push(`sequence_checks id must be unique: ${check.id}`)
      ids.add(check.id)
    }
    if (check.expectation === 'contains-throughout') {
      if (typeof check.contains !== 'string' || check.contains.length === 0 || check.contains.length > 160) {
        errors.push(`${label} requires contains of 1–160 characters for contains-throughout`)
      }
    } else if (validExpectation && check.contains !== undefined) {
      errors.push(`${label} may use contains only with contains-throughout`)
    }
    if (validExpectation && check.expectation !== 'numeric-progress' && check.min_delta !== undefined) {
      errors.push(`${label} may use min_delta only with numeric-progress`)
    }
    if (check.min_delta !== undefined
      && (typeof check.min_delta !== 'number' || !Number.isFinite(check.min_delta)
        || check.min_delta < 0 || check.min_delta > 1_000_000_000)) {
      errors.push(`${label} min_delta must be a finite number from 0 to 1000000000`)
    }
  }
  return errors.length > 0 ? errors.join('\n') : undefined
}

function firstNumber(value) {
  const match = String(value).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/)
  return match === null ? undefined : Number(match[0])
}

function compactSequenceValues(entries) {
  const values = entries.map(entry => entry?.found === true ? bounded(entry.text, 120) : '<missing>')
  const compact = []
  for (const value of values) {
    if (compact.at(-1) !== value) compact.push(value)
  }
  return compact.length <= 8 ? compact
    : [...compact.slice(0, 4), `<${compact.length - 8} intermediate values omitted>`, ...compact.slice(-4)]
}

/** Evaluate full-text predicates while retaining only bounded evidence excerpts. */
export function sequenceCheckResults(checks = [], samples = []) {
  return checks.map((check, checkIndex) => {
    const entries = samples.map(sample => sample?.values?.[checkIndex])
    const observed = compactSequenceValues(entries)
    let failure
    if (entries.length < 2) {
      failure = 'needed at least two observations'
    } else if (entries.some(entry => entry?.found !== true)) {
      failure = 'selector was missing during the sample window'
    } else if (check.expectation === 'contains-throughout') {
      if (entries.some(entry => entry.containsExpected !== true)) {
        failure = `expected text containing ${JSON.stringify(check.contains)} throughout`
      }
    } else if (check.expectation === 'stable') {
      if (entries.slice(1).some(entry => entry.sameAsPrevious !== true)) {
        failure = 'expected text to remain stable'
      }
    } else if (check.expectation === 'changes') {
      if (!entries.slice(1).some(entry => entry.sameAsPrevious === false)) {
        failure = 'expected text to change'
      }
    } else {
      const numbers = entries.map(entry => entry.number)
      if (numbers.some(value => !Number.isFinite(value))) {
        failure = 'expected every observation to contain a number'
      } else if (numbers.some((value, index) => index > 0 && value < numbers[index - 1])) {
        failure = 'expected the first numeric value to be nondecreasing'
      } else if (check.expectation === 'numeric-progress'
        && numbers.at(-1) - numbers[0] < (check.min_delta ?? 1)) {
        failure = `expected numeric progress of at least ${check.min_delta ?? 1}`
      }
    }
    const passed = failure === undefined
    const numericEvidence = check.expectation.startsWith('numeric-')
      ? ` observedNumbers=${JSON.stringify(entries.map(entry => entry?.number ?? null))}` : ''
    return {
      id: check.id,
      passed,
      summary: `${check.id}:${check.expectation}:${passed ? 'passed' : 'failed'} observedExcerpts=${JSON.stringify(observed)}${numericEvidence}`,
      failure: passed ? '' : `${check.id}:${check.selector} ${failure}`,
    }
  })
}

/** Reject ambiguous or unbounded clock plans before any browser or artifact I/O. */
export function clockContractDenial(args) {
  if (args.clock_steps === undefined) return undefined
  const steps = args.clock_steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 16) return 'clock_steps requires 1–16 steps'
  const mixed = ['click_selector', 'click_canvas', 'pointer_lock_selector', 'interactions', 'text_checks', 'sequence_checks', 'sequence_start', 'min_fps', 'settle_ms', 'sample_ms']
    .filter(key => args[key] !== undefined)
  if (mixed.length) return `clock_steps cannot be combined with real-time options: ${mixed.join(', ')}`
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const selector = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160
  let previous = 0, count = 0
  for (const [index, step] of steps.entries()) {
    const label = `clock_steps[${index}]`
    if (!object(step) || Object.keys(step).some(key => !['at_ms', 'run_callbacks', 'click_selector', 'pointer_lock_selector', 'input', 'checks'].includes(key))) return `${label}: unsupported step fields`
    if (!Number.isSafeInteger(step.at_ms) || step.at_ms < previous || step.at_ms > 60_000) return `${label}: at_ms must be monotonic, from 0 to 60000`
    previous = step.at_ms
    if (typeof step.run_callbacks !== 'boolean') return `${label}: run_callbacks is required`
    if (step.click_selector !== undefined && !selector(step.click_selector)) return `${label}: invalid click_selector`
    if (step.pointer_lock_selector !== undefined && (!selector(step.pointer_lock_selector) || step.click_selector === undefined)) return `${label}: pointer_lock_selector requires a valid selector and click_selector`
    if (step.input !== undefined) {
      if (step.click_selector !== undefined) return `${label}: choose one click or input action`
      if (!object(step.input) || Object.keys(step.input).some(key => !['selector', 'value'].includes(key))
        || !selector(step.input.selector) || !Number.isFinite(step.input.value)) return `${label}: input requires selector and finite numeric value`
    }
    if (step.checks !== undefined && (!Array.isArray(step.checks) || step.checks.length > 4)) return `${label}: at most 4 checks`
    for (const check of step.checks ?? []) {
      count++
      if (count > 32) return 'clock_steps supports at most 32 checkpoint checks in total'
      if (!object(check) || Object.keys(check).some(key => !['selector', 'contains', 'equals', 'min', 'max'].includes(key))
        || !selector(check.selector)) return `${label}: invalid check selector or fields`
      if (check.contains !== undefined && !selector(check.contains)) return `${label}: contains must have 1–160 nonblank characters`
      if (check.equals !== undefined && (typeof check.equals !== 'string' || check.equals.length > 160)) return `${label}: equals must be a string of at most 160 characters`
      if (check.equals !== undefined && check.contains !== undefined) return `${label}: choose contains or equals, not both`
      for (const key of ['min', 'max']) if (check[key] !== undefined && !Number.isFinite(check[key])) return `${label}: ${key} must be finite`
      if (check.contains === undefined && check.equals === undefined && check.min === undefined && check.max === undefined) return `${label}: each check needs contains, equals, min or max`
      if (check.min !== undefined && check.max !== undefined && check.min > check.max) return `${label}: min exceeds max`
    }
  }
  return count > 0 ? undefined : 'clock_steps requires at least one executable checkpoint check'
}

/** A bounded, structured DOM probe of the original entry; never accepts model-supplied JavaScript. */
export async function runClockSteps(client, steps, signal) {
  const denial = clockContractDenial({ clock_steps: steps })
  if (denial) throw new Error(denial)
  const clock = `globalThis[Symbol.for(${JSON.stringify(CONTROLLED_CLOCK_SYMBOL)})]`
  const interactions = [], sequenceChecks = []
  for (const [index, step] of steps.entries()) {
    signal?.throwIfAborted()
    if (await evaluate(client, `${clock}?.advance(${step.at_ms}, ${step.run_callbacks})`) !== true) throw new Error('Controlled clock did not initialize')
    if (step.click_selector !== undefined) {
      await clickTarget(client, step.click_selector, false, step.pointer_lock_selector, signal)
      interactions.push(`clock@${step.at_ms}ms:click:${step.click_selector}`)
    }
    if (step.input !== undefined) {
      const observed = await setControlValue(client, step.input, 'range', signal)
      interactions.push(`clock@${step.at_ms}ms:programmatic-input:${step.input.selector}=${bounded(observed, 80)}`)
    }
    const checks = step.checks ?? []
    const values = await evaluate(client, `(() => {
      ${clock}.assertSupported();
      const firstNumber = ${firstNumber.toString()};
      return ${JSON.stringify(checks)}.map(check => {
        const item = document.querySelector(check.selector);
        const text = item ? String(item.textContent ?? '') : '';
        const number = firstNumber(text);
        return {found: item !== null, text: text.slice(0,500),
          containsExpected: check.contains === undefined || text.includes(check.contains),
          number: Number.isFinite(number) ? number : null,
          exact: check.equals === undefined || (document.querySelectorAll(check.selector).length === 1 && text.trim() === check.equals)};
      });
    })()`)
    for (const [checkIndex, check] of checks.entries()) {
      const value = values?.[checkIndex], number = value?.number
      const expected = JSON.stringify(check), observed = bounded(value?.text, 120)
      const passed = value?.found === true
        && value.exact === true
        && value.containsExpected === true
        && (check.min === undefined || Number.isFinite(number) && number >= check.min)
        && (check.max === undefined || Number.isFinite(number) && number <= check.max)
      const id = `clock-${index}-${checkIndex}`
      const numericEvidence = check.min !== undefined || check.max !== undefined
        ? ` observedNumber=${number ?? '<no finite number>'}` : ''
      sequenceChecks.push({ id, passed,
        summary: `${id}@${step.at_ms}ms:${passed ? 'passed' : 'failed'} expected=${expected} observedExcerpt=${JSON.stringify(observed)}${numericEvidence}`,
        failure: passed ? '' : `${id}@${step.at_ms}ms expected=${expected} observedExcerpt=${value?.found === true ? JSON.stringify(observed) : '<missing>'}${numericEvidence}` })
    }
  }
  return { interactions, sequenceChecks }
}

async function capturePage(client, args, signal, onSample) {
  const readyState = await waitForDocument(client, signal, args.clock_steps !== undefined)
  signal?.throwIfAborted()
  await client.send('Page.bringToFront')
  const sample = async duringSample => {
    const result = await sampleAnimationFrames(client, args.sample_ms ?? DEFAULT_SAMPLE_MS,
      signal, undefined, args.sequence_checks ?? [], duringSample)
    onSample(result)
    return result
  }
  let interactions, clockResult, actionSample, beforeTextChecks = [], afterTextChecks = []
  if (args.clock_steps !== undefined) {
    clockResult = await runClockSteps(client, args.clock_steps, signal)
    interactions = clockResult.interactions
  } else {
    await delay(args.settle_ms ?? DEFAULT_SETTLE_MS, signal)
    beforeTextChecks = await inspectTextChecks(client, args.text_checks, 'before')
    const actions = async () => {
      interactions = await dispatchInteractions(client, args, signal)
      if (interactions.length > 0) await delay(250, signal)
      afterTextChecks = await inspectTextChecks(client, args.text_checks, 'after')
    }
    if (args.sequence_start === 'before-actions') {
      actionSample = await sample(actions)
    } else await actions()
  }

  const documentInfo = await evaluate(client, `(() => ({
    readyState: document.readyState,
    title: document.title,
    pointerLocked: document.pointerLockElement !== null
  }))()`)
  const canvas = await evaluate(client, `(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const visible = canvases.filter(item => (${elementVisible.toString()})(item));
    const contexts = globalThis[Symbol.for(${JSON.stringify(CANVAS_CONTEXTS_SYMBOL)})];
    if (!contexts) throw new Error('Canvas context observation did not initialize');
    const observed = visible.slice(0, ${MAX_DIAGNOSTICS}).map(item => contexts.get(item)).filter(Boolean);
    const api = [...new Set(observed.map(item => item.api))].sort().join(',') || 'none';
    const renderer = [...new Set(observed.filter(item => ['webgl', 'webgl2'].includes(item.api))
      .map(({context}) => String(context.getParameter(context.RENDERER) ?? '')).filter(Boolean))].join(',');
    return { count: canvases.length, visible: visible.length, api, renderer };
  })()`)
  const selectors = await evaluate(client, `(() => ${JSON.stringify(args.selector_checks ?? [])}.map(check => {
    try {
      const nodes = document.querySelectorAll(check.selector);
      const item = nodes[0];
      const present = nodes.length > 0;
      const visible = (${elementVisible.toString()})(item, false);
      const inViewport = (${elementVisible.toString()})(item, true);
      const passed = check.state === 'present' ? present : check.state === 'absent' ? !present
        : check.state === 'visible' ? visible : check.state === 'hidden' ? present && !visible : inViewport;
      return { ...check, present, visible, inViewport, passed };
    } catch { return { ...check, present: false, visible: false, inViewport: false, passed: false }; }
  }))()`)
  const fps = clockResult ? { fps: 0, p95FrameMs: 0 }
    : actionSample ?? await sample()
  const sequenceChecks = clockResult?.sequenceChecks ?? sequenceCheckResults(args.sequence_checks, fps.samples)
  return {
    readyState,
    documentInfo,
    canvas,
    selectors,
    fps,
    sequenceChecks,
    interactions,
    textChecks: [...beforeTextChecks, ...afterTextChecks],
  }
}

function effectiveTimeoutMs(args) {
  if (args.timeout_ms !== undefined) return args.timeout_ms
  const waitMs = (args.interactions ?? []).reduce((sum, item) => sum + (item.wait_ms ?? 0), 0)
  return Math.min(60_000, Math.max(
    DEFAULT_TIMEOUT_MS,
    (args.settle_ms ?? DEFAULT_SETTLE_MS) + (args.sample_ms ?? DEFAULT_SAMPLE_MS) + waitMs + 10_000,
  ))
}

/** Capture once into a private, unique directory. Return a native read_image path. */
async function writeScreenshot(client) {
  const image = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (typeof image.data !== 'string' || image.data.length > 90 * 1024 * 1024) throw new Error('Screenshot response is missing or oversized')
  const body = Buffer.from(image.data, 'base64')
  if (body.length < 8 || !body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Screenshot response is not a PNG')
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-apex-evidence-'))
  const path = join(directory, 'capture.png')
  try { await fs.writeFile(path, body, { flag: 'wx', mode: 0o600 }) }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
  return { hash: createHash('sha256').update(body).digest('hex'), path }
}

async function terminateBrowser(handle) {
  if (!handle) return true
  handle.terminate()
  if (await handle.waitForExit(AbortSignal.timeout(5_000))) return true
  handle.terminate()
  return await handle.waitForExit(AbortSignal.timeout(5_000))
}

function emptyResult(args, snapshot, startedAt) {
  return {
    checkId: args.check_id, performedAt: new Date(startedAt).toISOString(), checks: args,
    status: 'blocked', overallAcceptance: 'not-assessed',
    timingMode: args.clock_steps ? 'controlled-clock' : 'real-time',
    metricsKind: 'not-measured',
    viewport: { width: args.width ?? 1280, height: args.height ?? 720, deviceScaleFactor: args.device_scale_factor ?? 1 },
    browser: '', url: '', durationMs: 0, readyState: '', title: '', pointerLocked: false,
    canvasCount: 0, visibleCanvasCount: 0, graphicsApi: 'none', graphicsRenderer: '',
    fps: 0, p95FrameMs: 0, interactions: [], failedTextChecks: [], sequenceChecks: [],
    failedSequenceChecks: [], missingSelectors: [], selectorChecks: [],
    consoleErrors: [], pageErrors: [], canvasErrors: [], layoutErrors: [], layoutChecks: [],
    networkErrors: [], httpErrors: [], warnings: [], screenshotPath: '', screenshotHash: '',
    artifactRoot: snapshot.root, artifactHash: snapshot.hash, artifactHashAfter: '', artifactStable: false,
    excludedDirectories: snapshot.excludedDirectories, detail: '', cleanup: 'not-started',
  }
}
export async function runValidation(ctx, args, exec) {
  const textDenial = textContractDenial(args)
  if (textDenial) throw new Error(textDenial)
  const clockDenial = clockContractDenial(args)
  if (clockDenial) throw new Error(clockDenial)
  const interactionDenial = interactionContractDenial(args)
  if (interactionDenial) throw new Error(interactionDenial)
  const sequenceDenial = sequenceContractDenial(args)
  if (sequenceDenial) throw new Error(sequenceDenial)
  const snapshot = await artifactSnapshot(exec.agent, args.root, exec.signal)
  const root = await artifactRoot(exec.agent, args.root)
  const startedAt = Date.now()
  const timeoutMs = effectiveTimeoutMs(args)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = exec.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([exec.signal, timeoutSignal])
  let stage = 'resolve-browser'
  let browserHandle
  let staticServer
  let client
  let userDataDir
  let result = emptyResult(args, snapshot, startedAt)
  let metricsDetail = 'rAF not measured; fps and p95FrameMs are unmeasured placeholders.'
  let cleanup = []
  let browserTerminated = browserHandle === undefined
  try {
    const browser = await resolveBrowser(ctx.subprocess, signal)
    if (browser === undefined) {
      throw new Error('No existing Chrome, Chromium, or Edge executable was found; APEX did not download one')
    }
    result.browser = browser.split(/[\\/]/).at(-1)
    stage = 'server'
    staticServer = await startStaticServer(root, signal)
    const entry = typeof args.entry === 'string' && args.entry.length > 0
      ? `/${args.entry.replace(/^\/+/, '')}`
      : '/index.html'
    result.url = `${staticServer.origin}${entry}`
    stage = 'launch-browser'
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'dsh-apex-web-'))
    browserHandle = ctx.subprocess.spawn({
      argv: [
        browser,
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        `--window-size=${args.width ?? 1280},${args.height ?? 720}`,
        '--disable-background-networking',
        ...HEADLESS_FOREGROUND_FLAGS,
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        'about:blank',
      ],
      cwd: exec.agent.session.header.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65_536 },
        stderr: { maxBytes: 65_536 },
      },
      graceMs: 1_000,
      signal,
    })
    const port = await devtoolsPort(userDataDir, browserHandle, signal)
    stage = 'connect-devtools'
    const targets = await jsonFetch(`http://127.0.0.1:${port}/json/list`, signal)
    const page = Array.isArray(targets) ? targets.find(target => target?.type === 'page') : undefined
    if (typeof page?.webSocketDebuggerUrl !== 'string') throw new Error('Chrome exposed no debuggable page target')
    const socket = await connectWebSocket(page.webSocketDebuggerUrl, signal)
    client = cdpClient(socket, signal)

    // Keep already observed errors even if interaction or screenshot capture aborts.
    const { consoleErrors, pageErrors, networkErrors, httpErrors, warnings } = result
    let mainStatus = 0
    client.on('Runtime.consoleAPICalled', params => {
      const text = consoleText(params)
      if (params.type === 'error' || params.type === 'assert') pushBounded(consoleErrors, text)
      else if (params.type === 'warning') pushBounded(warnings, text)
    })
    client.on('Runtime.exceptionThrown', params => {
      pushBounded(pageErrors, params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text)
    })
    client.on('Log.entryAdded', params => {
      if (params.entry?.level === 'error') pushBounded(consoleErrors, params.entry.text)
      else if (params.entry?.level === 'warning') pushBounded(warnings, params.entry.text)
    })
    client.on('Network.loadingFailed', params => {
      if (!params.canceled) pushBounded(networkErrors, `${params.errorText}: ${params.type ?? 'resource'}`)
    })
    client.on('Network.responseReceived', params => {
      const response = params.response
      if (params.type === 'Document' && sameNetworkUrl(response?.url, result.url)) {
        mainStatus = response.status
      }
      if (response?.status >= 400) pushBounded(httpErrors, `${response.status} ${response.url}`)
    })

    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Log.enable'),
      client.send('Network.enable'),
      client.send('Emulation.setDeviceMetricsOverride', {
        ...result.viewport,
        mobile: false,
      }),
    ])
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: CANVAS_DIAGNOSTICS_SOURCE })
    if (args.clock_steps !== undefined) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: CONTROLLED_CLOCK_SOURCE })
    stage = 'navigate'
    const navigation = await client.send('Page.navigate', { url: result.url })
    if (navigation.errorText) throw new Error(`navigation failed: ${bounded(navigation.errorText)}`)
    stage = 'page-validation'
    const pageInfo = await capturePage(client, args, signal, sample => {
      // Commit both sampling paths before any subsequent diagnostics or capture can fail.
      result.metricsKind = 'instrumented-raf'
      result.fps = Number(sample.fps.toFixed(2))
      result.p95FrameMs = Number(sample.p95FrameMs.toFixed(2))
      metricsDetail = `rAF sample: ${sample.frames} callbacks over ${sample.durationMs.toFixed(1)} ms; not GPU frame throughput.`
      if (sample.frames < 2) metricsDetail += ' p95FrameMs is an unmeasured placeholder: fewer than two callbacks.'
    })
    const layout = await evaluate(client, LAYOUT_DIAGNOSTICS_SOURCE)
    for (const field of ['layoutErrors', 'canvasErrors', 'warnings', 'layoutChecks']) {
      if (!Array.isArray(layout?.[field]) || layout[field].length > MAX_DIAGNOSTICS
        || layout[field].some(value => typeof value !== 'string' || value.length > MAX_DIAGNOSTIC_CHARS)) {
        throw new Error('Layout diagnostics were unavailable or invalid; visible controls and bitmaps remain unverified')
      }
    }
    for (const warning of layout.warnings) pushBounded(warnings, warning)
    const screenshot = await writeScreenshot(client)
    result.screenshotPath = screenshot.path
    result.screenshotHash = screenshot.hash
    const canvasErrors = await evaluate(client, `globalThis[Symbol.for(${JSON.stringify(CANVAS_DIAGNOSTICS_SYMBOL)})]`)
    if (!Array.isArray(canvasErrors) || canvasErrors.length > MAX_DIAGNOSTICS
      || canvasErrors.some(value => typeof value !== 'string' || value.length > MAX_DIAGNOSTIC_CHARS)) {
      throw new Error('Canvas diagnostics were unavailable or invalid; rendering checks are incomplete')
    }
    for (const diagnostic of layout.canvasErrors) pushBounded(canvasErrors, diagnostic)
    const missingSelectors = pageInfo.selectors.filter(item => !item.passed).map(item => `${item.selector}: expected ${item.state}`)
    const failedTextChecks = textCheckFailures(pageInfo.textChecks)
    const sequenceChecks = pageInfo.sequenceChecks.map(check => check.summary)
    const failedSequenceChecks = pageInfo.sequenceChecks.filter(check => !check.passed).map(check => check.failure)
    const failures = []
    if (mainStatus >= 400 || mainStatus === 0) failures.push(`main document HTTP status was ${mainStatus || 'not observed'}`)
    if (args.require_canvas === true && pageInfo.canvas.visible === 0) failures.push('no visible canvas')
    if (args.require_graphics_api && !pageInfo.canvas.api.split(',').includes(args.require_graphics_api)) {
      failures.push(`required graphics API ${args.require_graphics_api} was not observed on a visible canvas`)
      pushBounded(warnings, `${args.require_graphics_api}: capability and initialization remain unverified; no fallback is counted as a pass`)
    }
    if (typeof args.min_fps === 'number' && pageInfo.fps.fps < args.min_fps) {
      failures.push(`sampled rAF rate ${pageInfo.fps.fps.toFixed(1)} was below ${args.min_fps}`)
    }
    if (args.interaction_required === true && pageInfo.interactions.length === 0) {
      failures.push('interaction_required was true but no host action was dispatched')
    }
    if (missingSelectors.length > 0) failures.push(`selector checks failed: ${missingSelectors.join(', ')}`)
    if (failedTextChecks.length > 0) failures.push(`text checks failed: ${failedTextChecks.join(', ')}`)
    if (failedSequenceChecks.length > 0) failures.push(`sequence checks failed: ${failedSequenceChecks.join(', ')}`)
    if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} uncaught page error(s)`)
    if (canvasErrors.length > 0) failures.push(`${canvasErrors.length} Canvas diagnostic(s)`)
    if (layout.layoutErrors.length > 0) failures.push(`${layout.layoutErrors.length} occluded control diagnostic(s)`)
    if (networkErrors.length > 0) failures.push(`${networkErrors.length} network error(s)`)
    if (httpErrors.length > 0) failures.push(`${httpErrors.length} HTTP error response(s)`)
    result = {
      ...result,
      status: failures.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      readyState: pageInfo.documentInfo.readyState ?? pageInfo.readyState,
      title: bounded(pageInfo.documentInfo.title, 300),
      pointerLocked: pageInfo.documentInfo.pointerLocked === true,
      canvasCount: pageInfo.canvas.count,
      visibleCanvasCount: pageInfo.canvas.visible,
      graphicsApi: pageInfo.canvas.api,
      graphicsRenderer: bounded(pageInfo.canvas.renderer, 300),
      interactions: pageInfo.interactions,
      failedTextChecks,
      sequenceChecks,
      failedSequenceChecks,
      missingSelectors,
      selectorChecks: pageInfo.selectors,
      consoleErrors,
      pageErrors,
      canvasErrors,
      layoutErrors: layout.layoutErrors,
      layoutChecks: layout.layoutChecks,
      networkErrors,
      httpErrors,
      warnings,
      screenshotPath: screenshot.path,
      screenshotHash: screenshot.hash,
      detail: [failures.length === 0 ? 'Configured checks passed.' : `Configured checks failed: ${failures.join('; ')}.`,
        ...args.clock_steps && failedSequenceChecks.length > 0
          ? ['Controlled-clock checks run immediately after each action; this step\'s callbacks run before the action. If the display updates on rAF/timers, check it in a later step with run_callbacks:true at the required time. Earlier failed checkpoints remain failed.'] : [],
        ...pageInfo.textChecks.map(check => `Text ${check.phase} ${check.selector}: ${check.equals === undefined
          ? `contains=${JSON.stringify(check.contains)}` : `equals=${JSON.stringify(check.equals)}`}, observedExcerpt=${JSON.stringify(bounded(check.observed, 120))}, ${check.passed ? 'passed' : 'failed'}.`),
      ].join('\n'),
    }
  } catch (error) {
    if (exec.signal?.aborted) throw error
    const unsupportedClock = /Controlled clock (?:unsupported|did not initialize)/.test(String(error?.message ?? error))
    const status = !unsupportedClock && ['navigate', 'page-validation'].includes(stage) ? 'failed' : 'blocked'
    result.status = status
    result.detail = `${stage}: ${bounded(error instanceof Error ? error.message : error)}`
    if (error?.layoutFailure === true) result.layoutErrors = [bounded(error.message)]
    if (/Pointer Lock/.test(result.detail)) pushBounded(result.warnings, 'Native Pointer Lock was not established; dependent actions and their acceptance remain unverified. Headless support varies.')
    if (client && !signal.aborted && !result.screenshotPath) {
      try {
        const capture = await writeScreenshot(client)
        result.screenshotPath = capture.path
        result.screenshotHash = capture.hash
      } catch (captureError) {
        pushBounded(result.warnings, 'Failure capture unavailable: ' + bounded(captureError.message))
      }
    }
    result.durationMs = Date.now() - startedAt
  } finally {
    try {
      client?.close()
    } catch {
      cleanup.push('devtools-close-failed')
    }
    try {
      await staticServer?.close()
      if (staticServer !== undefined) cleanup.push('server-closed')
    } catch {
      cleanup.push('server-close-failed')
    }
    try {
      if (browserHandle !== undefined) {
        browserTerminated = false
        browserTerminated = await terminateBrowser(browserHandle)
        cleanup.push(browserTerminated ? 'browser-terminated' : 'browser-still-live')
      }
    } catch {
      cleanup.push('browser-cleanup-failed')
    }
    try {
      if (userDataDir !== undefined && browserTerminated) {
        await fs.rm(userDataDir, { recursive: true, force: true })
        cleanup.push('profile-removed')
      }
    } catch {
      cleanup.push('profile-remove-failed')
    }
    if (userDataDir !== undefined && !cleanup.includes('profile-removed')) {
      const warning = `Owned browser profile retained: ${userDataDir}. Remove only this directory after its browser process range has verifiably stopped; do not scan or delete unrelated temporary directories.`
      result.detail = `${result.detail} ${warning}`.trim()
      pushBounded(result.warnings, warning)
      if (exec.signal?.aborted) ctx.logger?.warn(warning)
    }
    if (exec.signal?.aborted && result.screenshotPath) {
      try {
        await fs.rm(dirname(result.screenshotPath), { recursive: true, force: true })
        cleanup.push('unreturned-capture-removed')
      } catch {
        cleanup.push('unreturned-capture-remove-failed')
      }
    }
    result.cleanup = cleanup.length > 0 ? cleanup.join(',') : 'nothing-started'
    if (cleanup.some(item => item.endsWith('-failed') || item === 'browser-still-live')) {
      result.status = 'blocked'
      result.detail = `${result.detail} Host cleanup did not reach verified quiescence.`.trim()
      if (exec.signal?.aborted) ctx.logger?.warn(`APEX browser cancellation cleanup: ${result.cleanup}`)
    }
    result.durationMs = Date.now() - startedAt
  }
  if (result.artifactHash.length > 0) {
    exec.signal?.throwIfAborted()
    try {
      const current = await artifactSnapshot(exec.agent, args.root, exec.signal)
      result.artifactStable = current.hash === result.artifactHash
      result.artifactHashAfter = current.hash
      if (current.hash !== result.artifactHash) {
        result.status = 'blocked'
        result.detail += ' Artifact changed during browser validation; these observations cannot certify the recorded artifact generation. Stop concurrent writes before validating this artifact again.'
      }
    } catch (error) {
      result.status = 'blocked'
      result.detail += ` Artifact could not be rechecked after browser validation: ${bounded(error instanceof Error ? error.message : error)}.`
    }
    exec.signal?.throwIfAborted()
    result.durationMs = Date.now() - startedAt
  }
  exec.signal?.throwIfAborted()
  result.detail += `\n${metricsDetail}`
  return result
}
const RANGE_INPUT_PARAMETERS = {
  type: 'object', additionalProperties: false,
  description: 'Programmatic enabled range input: unique visible target; native value setter, then input/change events. Value must fit its min/max/step; no clamping. Not physical dragging or trusted-input proof.',
  properties: { selector: { type: 'string', minLength: 1, maxLength: 160 }, value: { type: 'number' } },
  required: ['selector', 'value'],
}

export const VALIDATION_PARAMETERS = {
      type: 'object',
      additionalProperties: false,
      properties: {
        check_id: { type: 'string', minLength: 1, maxLength: 64, description: 'Label for this execution. Historical results retain their original labels.' },
        assertion: { type: 'string', minLength: 1, maxLength: 320, description: 'Descriptive acceptance label only; it never executes actions or proves outcomes that are absent from the structured checks.' },
        root: { type: 'string', minLength: 1, maxLength: 512, description: 'Workspace-local static build directory such as dist.' },
        entry: { type: 'string', minLength: 1, maxLength: 240, description: 'Entry path inside root; defaults to index.html.' },
        require_canvas: { type: 'boolean' },
        require_graphics_api: { type: 'string', enum: ['2d', 'webgl', 'webgl2', 'webgpu'], description: 'Require this actual context on a visible canvas. Observation never creates a context or substitutes another API. Context presence alone does not prove successful rendering.' },
        selector_checks: {
          type: 'array', maxItems: 16,
          description: 'At most 16 checks. present/absent test DOM existence; visible/hidden test layout visibility independently of the viewport; in-viewport tests the current clipped viewport.',
          items: { type: 'object', additionalProperties: false, properties: {
            selector: { type: 'string', minLength: 1, maxLength: 160 },
            state: { type: 'string', enum: ['present', 'absent', 'visible', 'hidden', 'in-viewport'] },
          }, required: ['selector', 'state'] },
        },
        interaction_required: { type: 'boolean', description: 'Required declaration. Set true when the acceptance requirement depends on any user action; the host then requires at least one concrete supported action.' },
        click_selector: { type: 'string', minLength: 1, maxLength: 160, description: 'Optional DOM selector to scroll into view and click once before after-phase checks. Missing, disabled or occluded targets fail without claiming an interaction.' },
        click_canvas: { type: 'boolean', description: 'Scroll the first visible canvas into view and click it only when its hit target is unobstructed.' },
        pointer_lock_selector: { type: 'string', minLength: 1, maxLength: 160, description: 'For Pointer Lock requirements, name the element that must acquire native lock after exactly one top-level click. Waits before any later action; failure stops dependent actions. Omit for ordinary clicks. Also supported on ordered click actions and clock-step clicks.' },
        interactions: {
          type: 'array',
          maxItems: 8,
          description: 'Ordered actions after top-level clicks and before after-text checks. Choose exactly one form: key/hold_ms (0..2000), selector/text, input:{selector,value} for range, select:{selector,value} for a single select, click_selector, reload:true, or wait_ms (0..10000). Keys go to current focus; click to focus first. Put pointer_lock_selector on the same click action that requests the lock. Wait uses real time without input, counts toward timeout_ms, and is not strict deadline proof; use clock_steps for supported exact timing. Fill replaces the entire value (empty string clears it); maximum 4096 characters. Only unique, visible, enabled, writable text/search/tel/url inputs and textarea are supported, not password/file/hidden fields, contenteditable or iframes. Single-line inputs reject newlines. Textarea CRLF/CR is normalized to LF by the browser. Other truncated or changed replacements fail.',
          items: {
            oneOf: [{
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', enum: Object.keys(KEY_DEFINITIONS) },
                hold_ms: { type: 'integer', minimum: 0, maximum: 2_000 },
              },
              required: ['key', 'hold_ms'],
            }, {
              type: 'object', additionalProperties: false,
              properties: {
                selector: { type: 'string', minLength: 1, maxLength: 160 },
                text: { type: 'string', maxLength: 4096 },
              },
              required: ['selector', 'text'],
            }, {
              type: 'object', additionalProperties: false,
              properties: { click_selector: { type: 'string', minLength: 1, maxLength: 160 },
                pointer_lock_selector: { type: 'string', minLength: 1, maxLength: 160 } },
              required: ['click_selector'],
            }, {
              type: 'object', additionalProperties: false,
              properties: { reload: { type: 'boolean', const: true,
                description: 'Reload the same page, preserving this call\'s profile and origin; wait for a new main document to load. Use after-text checks to assert retained data; add wait_ms for asynchronous app updates. Not browser-restart persistence or input evidence. Cannot combine with sequence_start:before-actions or clock_steps.',
              } }, required: ['reload'],
            }, {
              type: 'object', additionalProperties: false,
              properties: { wait_ms: { type: 'integer', minimum: 0, maximum: 10_000 } },
              required: ['wait_ms'],
            }, {
              type: 'object', additionalProperties: false,
              properties: { input: RANGE_INPUT_PARAMETERS }, required: ['input'],
            }, {
              type: 'object', additionalProperties: false,
              properties: { select: {
                type: 'object', additionalProperties: false,
                description: 'Programmatic single select by exact option value, not label/index. Unique enabled visible target and option required; emits input/change once and checks the retained value. Not a trusted user gesture; multi-select/custom widgets/iframes unsupported.',
                properties: { selector: { type: 'string', minLength: 1, maxLength: 160 }, value: { type: 'string', maxLength: 512 } },
                required: ['selector', 'value'],
              } }, required: ['select'],
            }],
          },
        },
        text_checks: {
          type: 'array',
          maxItems: 8,
          description: 'Optional DOM text postconditions before or after actions. Each check must choose exactly one of contains or equals.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              phase: { type: 'string', enum: ['before', 'after'] },
              selector: { type: 'string', minLength: 1, maxLength: 160 },
              contains: { type: 'string', minLength: 1, maxLength: 160, description: 'Non-empty substring of the complete textContent; evidence excerpts may be truncated. Use equals:"" for empty text, or selector_checks for existence.' },
              equals: { type: 'string', maxLength: 160, description: 'Exact textContent after trimming outer whitespace; selector must match exactly one element. Empty string checks a cleared label. No substring or numeric coercion.' },
            },
            required: ['phase', 'selector'],
          },
        },
        sequence_checks: {
          type: 'array',
          maxItems: 4,
          description: 'Discrete DOM time-series observations; default window starts AFTER actions and after-text checks. Use sequence_start:"before-actions" to include the initial state and action interval. Comparisons and first-number parsing use complete textContent; evidence excerpts may be truncated.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              selector: { type: 'string', minLength: 1, maxLength: 160 },
              expectation: {
                type: 'string',
                enum: SEQUENCE_EXPECTATIONS,
              },
              contains: {
                type: 'string', minLength: 1, maxLength: 160,
                description: 'Required only for contains-throughout; omit for all other expectations.',
              },
              min_delta: {
                type: 'number', minimum: 0, maximum: 1_000_000_000,
                description: 'Optional minimum increase for numeric-progress only; omit for all other expectations. Defaults to 1.',
              },
            },
            required: ['id', 'selector', 'expectation'],
          },
        },
        clock_steps: {
          type: 'array', minItems: 1, maxItems: 16,
          description: 'Optional controlled-clock checkpoints on the original main document. Starts at 0 before page scripts. Monotonic timestamps, up to 32 checks total. Each step advances time, optionally runs each due function timer/queued rAF once, performs its action, then asserts DOM text. New callbacks wait for a later step. Omit settle_ms, sample_ms, min_fps and all top-level action/text/sequence options. Default real-time path is unchanged when absent.',
          items: {
            type: 'object', additionalProperties: false,
            description: 'At most one action per step: click_selector or input; checks may also run without an action.',
            properties: {
              at_ms: { type: 'integer', minimum: 0, maximum: 60_000, description: 'Absolute controlled time since document startup, not a real wait; cannot go backwards.' },
              run_callbacks: { type: 'boolean', description: 'False moves time without rendering/timer delivery, allowing an action between callbacks. True delivers pending callbacks once before this step action. For action-triggered rAF/timer updates, add a later step with run_callbacks:true at the required time.' },
              click_selector: { type: 'string', minLength: 1, maxLength: 160 },
              pointer_lock_selector: { type: 'string', minLength: 1, maxLength: 160 },
              input: RANGE_INPUT_PARAMETERS,
              checks: {
                type: 'array', maxItems: 4,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    selector: { type: 'string', minLength: 1, maxLength: 160 },
                    contains: { type: 'string', minLength: 1, maxLength: 160, description: 'Non-empty substring of the complete textContent; evidence excerpts may be truncated. Use equals:"" for empty text, or selector_checks for existence.' },
                    equals: { type: 'string', maxLength: 160, description: 'Exact trimmed textContent of one uniquely matched element; cannot combine with contains. Empty string is allowed.' },
                    min: { type: 'number', description: 'Inclusive lower bound on the first number in textContent.' },
                    max: { type: 'number', description: 'Inclusive upper bound; use a range matching display precision, not an exact transient decimal.' },
                  },
                  required: ['selector'],
                },
              },
            },
            required: ['at_ms', 'run_callbacks'],
          },
        },
        min_fps: { type: 'number', minimum: 1, maximum: 120, description: 'Minimum sampled rAF callbacks per second, not rendered GPU frames per second. Passing this threshold does not certify rendering throughput.' },
        sequence_start: { type: 'string', enum: ['after-actions', 'before-actions'], description: 'Optional real-time sequence/rAF sampling origin. Default after-actions preserves existing timing. before-actions samples the initial state, during actions, and for sample_ms after after-text checks; no extra action is dispatched. Cannot combine with clock_steps.' },
        sample_ms: { type: 'integer', minimum: 500, maximum: 30_000, description: 'rAF/sequence duration AFTER after-text checks; does not delay those checks. before-actions additionally samples the action interval.' },
        settle_ms: { type: 'integer', minimum: 0, maximum: 10_000, description: 'Initial wait BEFORE before-text checks and actions; use ordered wait_ms for waiting after a click.' },
        timeout_ms: { type: 'integer', minimum: 5_000, maximum: 60_000 },
        width: { type: 'integer', minimum: 320, maximum: 3_840 },
        height: { type: 'integer', minimum: 240, maximum: 2_160 },
        device_scale_factor: { type: 'number', minimum: 1, maximum: 2, description: 'Device pixel ratio (DPR), defaults to 1; use 2 for Retina/high-DPI evidence when relevant. Width/height remain CSS pixels. One density does not establish correctness at other densities.' },
      },
      required: ['check_id', 'assertion', 'root', 'interaction_required'],
    }

export const VALIDATION_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    ...Object.fromEntries(['checkId', 'performedAt', 'browser', 'url', 'readyState', 'title', 'graphicsApi', 'graphicsRenderer', 'screenshotPath', 'screenshotHash', 'artifactRoot', 'artifactHash', 'artifactHashAfter', 'detail', 'cleanup'].map(key => [key, { type: 'string' }])),
    ...Object.fromEntries(['durationMs', 'canvasCount', 'visibleCanvasCount'].map(key => [key, { type: 'number' }])),
    fps: { type: 'number', description: 'Measured rAF callbacks per second, not GPU frame throughput. When metricsKind is not-measured, 0 is an unmeasured placeholder.' },
    p95FrameMs: { type: 'number', description: '95th percentile of intervals between observed rAF callbacks in milliseconds, not GPU render duration. 0 is an unmeasured placeholder when metricsKind is not-measured or fewer than two callbacks were observed; see detail.' },
    ...Object.fromEntries(['interactions', 'failedTextChecks', 'failedSequenceChecks', 'missingSelectors', 'consoleErrors', 'pageErrors', 'canvasErrors', 'layoutErrors', 'layoutChecks', 'networkErrors', 'httpErrors', 'warnings', 'excludedDirectories'].map(key => [key, { type: 'array', items: { type: 'string' } }])),
    sequenceChecks: { type: 'array', items: { type: 'string' }, description: 'Executed checkpoint summary strings, not objects with a passed field. Failures are also listed in failedSequenceChecks.' },
    status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
    overallAcceptance: { type: 'string', const: 'not-assessed' },
    timingMode: { type: 'string', enum: ['real-time', 'controlled-clock'] },
    metricsKind: { type: 'string', enum: ['instrumented-raf', 'not-measured'], description: 'instrumented-raf requires a completed real-time sample, even if later checks fail. not-measured means no completed sample or controlled-clock mode; never interpret its numeric placeholders as measured zero.' },
    pointerLocked: { type: 'boolean' }, artifactStable: { type: 'boolean' },
    checks: {
      // Field guidance is already in the input SDK; keep the echo types and constraints.
      ...JSON.parse(JSON.stringify(VALIDATION_PARAMETERS,
        (key, value) => key === 'description' && typeof value === 'string' ? undefined : value)),
      description: 'Echo of the validated request parameters: an object, not an array of results. Read status/detail and failedTextChecks/failedSequenceChecks for outcomes; selectorChecks contains structured selector results.',
    },
    viewport: { type: 'object', additionalProperties: false, properties: {
      width: { type: 'integer' }, height: { type: 'integer' }, deviceScaleFactor: { type: 'number' },
    }, required: ['width', 'height', 'deviceScaleFactor'] },
    selectorChecks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      selector: { type: 'string' }, state: { type: 'string' }, present: { type: 'boolean' },
      visible: { type: 'boolean' }, inViewport: { type: 'boolean' }, passed: { type: 'boolean' },
    }, required: ['selector', 'state', 'present', 'visible', 'inViewport', 'passed'] } },
  },
}
VALIDATION_OUTPUT.required = Object.keys(VALIDATION_OUTPUT.properties)

export function apply(ctx) {
  registerTool(ctx, {
    name: 'apex_validate_web',
    description: 'Run local HTML/JS in real isolated headless Chromium, including dynamic interactions; no downloads. '
      + 'Every call executes fresh checks and records its inputs, observations, artifact hashes and screenshot. Read apex_read_evidence first when nothing relevant changed. '
      + 'Derive checks from requirements; assertion is only a label. A pass covers configured checks, not all requirements or visual quality. '
      + 'Use ordered fill/click/key/select/reload actions between before/after DOM text checks; width/height set the viewport. Each call starts a fresh private profile; reload preserves data only within that call. Sequence sampling normally follows actions. '
      + 'Instrumented rAF is a responsiveness signal, not actual GPU frame throughput. Controlled clock is only a bounded main-document probe, not CSS animations, Date construction, iframes, workers or network scheduling. '
      + 'Pointer Lock is native and may be unsupported; failures remain failures. Read screenshotPath with read_image, optionally request apex_review; image loading alone is not acceptance.',
    parameters: VALIDATION_PARAMETERS,
    output: {
      schema: VALIDATION_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => runValidation(ctx, args, exec),
  })
}
