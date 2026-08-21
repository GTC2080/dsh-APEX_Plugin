/** Finite, dependency-free browser acceptance for built static web artifacts. */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  constants,
  promises as fs,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import { latestLedger } from './apex-policy.mjs'
import { VISUAL_META_KIND } from './apex-vision.mjs'
import { currentTaskEvents } from './tool-gate.mjs'
import { workspacePath } from './workspace-boundary.mjs'

export const name = 'apex-web-validation-v061'
export const inject = ['tools', 'subprocess']
export const WEB_VALIDATION_META_KIND = 'apex-web-validation-v061'

const MAX_DIAGNOSTICS = 20
const MAX_DIAGNOSTIC_CHARS = 600
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SETTLE_MS = 1_000
const DEFAULT_SAMPLE_MS = 1_500
const CDP_CALL_TIMEOUT_MS = 8_000
const DEFAULT_REPAIR_PROOFS = 2
const MAX_REPAIR_PROOFS = 3
const MAX_ENVIRONMENT_RETRIES = 1
const FPS_SAMPLE_SYMBOL = 'dsh.apex.fps-sample.v061'

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
  const canonicalRoot = await fs.realpath(root)
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
  await new Promise((resolveListen, reject) => {
    const onAbort = () => {
      server.close()
      reject(abortReason(signal, 'static server start cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      signal?.removeEventListener('abort', onAbort)
      resolveListen()
    })
  })
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
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`DevTools discovery returned HTTP ${response.status}`)
  return await response.json()
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
      const values = listeners.get(method) ?? []
      values.push(listener)
      listeners.set(method, values)
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
    throw new Error(bounded(result.exceptionDetails.text ?? 'page evaluation failed'))
  }
  return result.result?.value
}

/**
 * Sample page animation without holding one awaited Runtime.evaluate call open.
 * Chrome can starve a newly scheduled rAF while DevTools is awaiting that same
 * evaluation, even though the application's existing animation loop continues.
 */
export async function sampleAnimationFrames(client, sampleMs, signal, waitForSample = delay) {
  const symbol = JSON.stringify(FPS_SAMPLE_SYMBOL)
  await client.send('Page.bringToFront')
  const started = await evaluate(client, `(() => {
    const key = Symbol.for(${symbol});
    const previous = globalThis[key];
    if (previous?.frameId) cancelAnimationFrame(previous.frameId);
    const started = performance.now();
    const state = { active: true, started, last: started, frames: 0, deltas: [], frameId: 0 };
    function frame(now) {
      if (!state.active) return;
      if (state.frames > 0) state.deltas.push(now - state.last);
      state.frames += 1;
      state.last = now;
      state.frameId = requestAnimationFrame(frame);
    }
    state.frameId = requestAnimationFrame(frame);
    globalThis[key] = state;
    return true;
  })()`)
  if (started !== true) throw new Error('frame sampler did not start')

  await waitForSample(sampleMs, signal)
  const result = await evaluate(client, `(() => {
    const key = Symbol.for(${symbol});
    const state = globalThis[key];
    if (!state) return null;
    state.active = false;
    if (state.frameId) cancelAnimationFrame(state.frameId);
    delete globalThis[key];
    const elapsed = Math.max(1, performance.now() - state.started);
    const sorted = state.deltas.slice().sort((a, b) => a - b);
    return {
      frames: state.frames,
      durationMs: elapsed,
      fps: state.frames * 1000 / elapsed,
      p95FrameMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
    };
  })()`)
  if (result === null
    || !Number.isFinite(result.frames)
    || !Number.isFinite(result.durationMs)
    || !Number.isFinite(result.fps)
    || !Number.isFinite(result.p95FrameMs)) {
    throw new Error('frame sampler returned invalid metrics')
  }
  return result
}

async function waitForDocument(client, signal) {
  while (!signal.aborted) {
    const state = await evaluate(client, 'document.readyState')
    if (state === 'complete' || state === 'interactive') return state
    await delay(50, signal)
  }
  throw abortReason(signal, 'document readiness timed out')
}

function consoleText(params) {
  return (params.args ?? [])
    .map(value => value.value ?? value.description ?? value.type ?? '')
    .join(' ')
}

async function dispatchInteractions(client, args, signal) {
  const sent = []
  if (args.click_canvas === true) {
    const point = await evaluate(client, `(() => {
      const canvas = [...document.querySelectorAll('canvas')].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (point !== null) {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      sent.push('click_canvas')
    }
  }
  for (const item of args.interactions ?? []) {
    const definition = KEY_DEFINITIONS[item.key]
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...definition,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
    })
    await delay(item.hold_ms, signal)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...definition,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
    })
    sent.push(`${item.key}:${item.hold_ms}ms`)
  }
  return sent
}

async function capturePage(client, args, signal) {
  const readyState = await waitForDocument(client, signal)
  await delay(args.settle_ms ?? DEFAULT_SETTLE_MS, signal)
  const interactions = await dispatchInteractions(client, args, signal)
  if (interactions.length > 0) await delay(250, signal)

  const documentInfo = await evaluate(client, `(() => ({
    readyState: document.readyState,
    title: document.title,
    pointerLocked: document.pointerLockElement !== null
  }))()`)
  const canvas = await evaluate(client, `(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const visible = canvases.filter((item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    let api = 'none'; let renderer = '';
    const target = visible[0];
    if (target) {
      for (const kind of ['webgl2', 'webgl']) {
        try {
          const context = target.getContext(kind);
          if (!context) continue;
          api = kind;
          const extension = context.getExtension('WEBGL_debug_renderer_info');
          renderer = extension ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : String(context.getParameter(context.RENDERER));
          break;
        } catch {}
      }
    }
    return { count: canvases.length, visible: visible.length, api, renderer };
  })()`)
  const selectors = await evaluate(client, `(() => ${JSON.stringify(args.required_selectors ?? [])}.map((selector) => {
    try {
      const item = document.querySelector(selector);
      if (!item) return { selector, visible: false };
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return { selector, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
    } catch { return { selector, visible: false }; }
  }))()`)
  const sampleMs = args.sample_ms ?? DEFAULT_SAMPLE_MS
  const fps = await sampleAnimationFrames(client, sampleMs, signal)
  return { readyState, documentInfo, canvas, selectors, fps, interactions }
}

function validationRecords(agent) {
  const records = []
  const events = currentTaskEvents(agent?.session?.events)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'tool/result' || event.data?.meta?.kind !== WEB_VALIDATION_META_KIND) continue
    const meta = event.data.meta
    if (typeof meta.checkId !== 'string'
      || !['baseline', 'regression', 'final', 'repair-proof'].includes(meta.mode)
      || !['passed', 'failed', 'blocked'].includes(meta.status)) continue
    records.push({
      checkId: meta.checkId,
      mode: meta.mode,
      status: meta.status,
      signature: typeof meta.signature === 'string' ? meta.signature : '',
      failureClass: typeof meta.failureClass === 'string' ? meta.failureClass : '',
      diagnosticHash: typeof meta.diagnosticHash === 'string' ? meta.diagnosticHash : '',
      defectScore: Number.isFinite(meta.defectScore) ? meta.defectScore : 0,
      repairEligible: meta.repairEligible === true,
      screenshotPath: typeof meta.screenshotPath === 'string' ? meta.screenshotPath : '',
      index,
    })
  }
  return records
}

function parsedArguments(event) {
  if (typeof event.data?.arguments !== 'string') return {}
  try {
    const value = JSON.parse(event.data.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function successfulResultIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || !Array.isArray(event.data?.message?.content)) continue
    for (const block of event.data.message.content) {
      if (block?.type === 'tool-result' && block.isError !== true) ids.add(block.toolCallId)
    }
  }
  return ids
}

function isImplementationMutation(event) {
  const args = parsedArguments(event)
  if (event.data?.name === 'write' || event.data?.name === 'edit') return true
  return event.data?.name === 'str_replace_editor' && args.command !== 'view'
}

/** Find durable worker or direct-Pro repair evidence after one concrete defect. */
function repairEvidenceAfter(agent, evidenceIndex) {
  const events = currentTaskEvents(agent?.session?.events)
  const successful = successfulResultIds(events)
  const after = events.slice(evidenceIndex + 1)
  const continued = new Set(after
    .filter(event => event.type === 'tool/call'
      && event.data?.name === 'apex_continue'
      && successful.has(event.data?.callId))
    .map(event => parsedArguments(event).child_id)
    .filter(value => typeof value === 'string'))
  const worker = after.some(event => (
    event.type === 'tool/result'
    && event.data?.meta?.kind === 'apex-worker-wait-v061'
    && event.data.meta.successfulMutations > 0
    && continued.has(event.data.meta.childId)
  ))
  const pro = after.some(event => (
    event.type === 'tool/call'
    && successful.has(event.data?.callId)
    && isImplementationMutation(event)
  ))
  return { any: worker || pro, pro, worker }
}

function externalFailure(record) {
  return record !== undefined && (record.status === 'blocked'
    || ['environment', 'network'].includes(record.failureClass))
}

function proofLedger(records) {
  const proofs = []
  let environmentRetries = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.mode !== 'repair-proof') continue
    if (externalFailure(records[index - 1])) {
      environmentRetries += 1
      continue
    }
    if (!externalFailure(record)) proofs.push(record)
  }
  return { environmentRetries, proofs }
}

function repairProofCause(agent, record) {
  if (record.status === 'failed'
    && ['application-runtime', 'performance'].includes(record.failureClass)) {
    return { index: record.index, kind: record.failureClass }
  }
  if (record.status !== 'passed' || record.screenshotPath.length === 0) return undefined
  const events = currentTaskEvents(agent?.session?.events)
  const visual = events
    .map((event, index) => ({ event, index }))
    .findLast(({ event, index }) => (
      index > record.index
      && event.type === 'tool/result'
      && event.data?.meta?.kind === VISUAL_META_KIND
      && event.data.meta.verdict === 'repair'
      && Array.isArray(event.data.meta.imagePaths)
      && event.data.meta.imagePaths.includes(record.screenshotPath)
    ))
  return visual === undefined ? undefined : { index: visual.index, kind: 'visual' }
}

function previousRepairableFailure(records, record) {
  const index = records.indexOf(record)
  return records.slice(0, index).findLast(item => (
    item.status === 'failed'
    && ['application-runtime', 'performance'].includes(item.failureClass)
  ))
}

function sameRuntimeDiagnostic(records, record) {
  if (record.failureClass !== 'application-runtime' || record.diagnosticHash.length === 0) return false
  const previous = previousRepairableFailure(records, record)
  return previous?.failureClass === 'application-runtime'
    && previous.diagnosticHash === record.diagnosticHash
}

function proofConverged(records, proof) {
  if (proof.status === 'passed') return true
  const previous = previousRepairableFailure(records, proof)
  if (previous === undefined) return false
  const severity = { 'application-runtime': 2, performance: 1 }
  if (severity[proof.failureClass] < severity[previous.failureClass]) return true
  return proof.failureClass === previous.failureClass
    && proof.defectScore > 0
    && previous.defectScore > proof.defectScore
}

/** Hash the user-visible acceptance contract while allowing a fresh screenshot path. */
export function validationSignature(args) {
  const contract = {
    assertion: args.assertion ?? '',
    root: args.root ?? '',
    entry: args.entry ?? 'index.html',
    requireCanvas: args.require_canvas === true,
    requiredSelectors: args.required_selectors ?? [],
    clickCanvas: args.click_canvas === true,
    interactions: args.interactions ?? [],
    minFps: args.min_fps ?? null,
    sampleMs: args.sample_ms ?? DEFAULT_SAMPLE_MS,
    settleMs: args.settle_ms ?? DEFAULT_SETTLE_MS,
    timeoutMs: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    width: args.width ?? 1280,
    height: args.height ?? 720,
  }
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

/** Enforce one fixed contract plus evidence-gated post-final repair proofs. */
export function validationAdmission(args, agent) {
  const ledger = latestLedger(agent)
  if (ledger === undefined || ledger.checks.length === 0) {
    return 'Record the required pending/failed/passed acceptance checks with apex_state before runtime validation.'
  }
  const records = validationRecords(agent)
  const check = ledger.checks.find(item => item.id === args.check_id)
  if (check === undefined) return `Acceptance check "${args.check_id}" is not present in the latest apex_state snapshot.`
  const first = records[0]
  if (first !== undefined) {
    if (args.check_id !== first.checkId) {
      return `This task already bound Web validation to check "${first.checkId}"; do not create another check id to reset the budget.`
    }
    const signature = validationSignature(args)
    if (first.signature.length === 0 || first.signature !== signature) {
      return 'Reuse the exact baseline assertion, root, entry, selectors, interactions, timing, viewport, and FPS threshold; only mode and screenshot_path may change.'
    }
  }

  if (args.mode === 'repair-proof') {
    const final = records.findLast(record => record.mode === 'final')
    if (final === undefined) return 'repair-proof requires one completed final Web validation.'
    const last = records.at(-1)
    const budget = proofLedger(records)
    if (externalFailure(last)) {
      return budget.environmentRetries < MAX_ENVIRONMENT_RETRIES
        ? undefined
        : 'The single post-final environment/network retry is already used; report the external block without another browser probe.'
    }
    const cause = repairProofCause(agent, last)
    if (cause === undefined) {
      return 'repair-proof requires either the latest deterministic application/runtime performance failure or a structured repair verdict tied to the latest passed final/repair-proof screenshot.'
    }
    if (check.status !== 'failed') {
      return `Record check "${args.check_id}" as failed with the latest host or visual evidence before repair-proof.`
    }
    const evidence = repairEvidenceAfter(agent, cause.index)
    if (!evidence.any) {
      return `repair-proof requires one successful implementation mutation after the ${cause.kind} evidence; Pro may repair directly, or a continued worker may settle with a mutation.`
    }
    const nextProof = budget.proofs.length + 1
    if (nextProof > MAX_REPAIR_PROOFS) {
      return 'The three evidence-backed repair-proof rounds are exhausted; report the remaining defect without another browser probe.'
    }
    if (nextProof > DEFAULT_REPAIR_PROOFS && !proofConverged(records, budget.proofs.at(-1))) {
      return 'A third repair-proof requires the immediately preceding proof to show convergence by passing runtime, reducing defect scope, or moving from an application-runtime failure to a lower-severity performance failure.'
    }
    if (sameRuntimeDiagnostic(records, last) && !evidence.pro) {
      return 'The same runtime diagnostic persisted after a repair. Flash must stop; a successful direct Pro mutation after the latest evidence is required before another repair-proof.'
    }
    return undefined
  }

  if (args.mode === 'baseline') {
    if (check.status !== 'pending') return `Baseline validation requires check "${args.check_id}" to be pending, not ${check.status}.`
    return records.length === 0
      ? undefined
      : `The task-global baseline budget is already used by check "${first.checkId}".`
  }

  if (args.mode === 'final') {
    if (records.some(record => record.mode === 'final')) {
      return 'The task-global final Web validation budget is already used; report its result without another probe.'
    }
    if (first === undefined) return 'Run the one task-global baseline before final validation.'
    const last = records.at(-1)
    const otherOpen = ledger.checks.filter(item => item.id !== args.check_id && item.status !== 'passed')
    if (otherOpen.length > 0) {
      return `Final validation requires every other acceptance check to be passed; still open: ${otherOpen.map(item => item.id).join(', ')}.`
    }
    if (last.status === 'passed') {
      return check.status === 'passed'
        ? undefined
        : `Record check "${args.check_id}" as passed with the prior host evidence before final validation.`
    }
    if (last.mode === 'regression' && (last.status === 'failed' || last.status === 'blocked')) {
      return undefined
    }
    return 'A failed or blocked baseline gets its one regression before the one final repaired run.'
  }

  if (args.mode !== 'regression') return 'apex_validate_web mode must be baseline, regression, final, or repair-proof.'
  if (first === undefined) return 'Run the one task-global baseline before regression validation.'
  if (records.some(record => record.mode === 'regression')) {
    return 'The task-global regression budget is already used; repair from its evidence, then use the one final run with the unchanged contract.'
  }
  const last = records.at(-1)
  const retryable = last?.status === 'failed' || last?.status === 'blocked'
  if (!retryable) return `Regression for check "${args.check_id}" requires a failed or blocked baseline result.`
  if (last.status === 'failed' && check.status !== 'failed') {
    return `Record check "${args.check_id}" as failed with its concrete evidence in apex_state before regression.`
  }
  return undefined
}

function emptyResult(args, status, detail, startedAt) {
  return {
    checkId: args.check_id,
    mode: args.mode,
    status,
    failureClass: status === 'blocked' ? 'environment' : 'none',
    diagnosticHash: '',
    defectScore: 0,
    repairEligible: false,
    browser: '',
    url: '',
    durationMs: Date.now() - startedAt,
    readyState: '',
    title: '',
    pointerLocked: false,
    canvasCount: 0,
    visibleCanvasCount: 0,
    graphicsApi: 'none',
    graphicsRenderer: '',
    fps: 0,
    p95FrameMs: 0,
    interactions: [],
    missingSelectors: [],
    consoleErrors: [],
    pageErrors: [],
    networkErrors: [],
    httpErrors: [],
    warnings: [],
    screenshotPath: '',
    detail: bounded(detail),
    cleanup: 'not-started',
    text: '',
  }
}

function normalizedRuntimeDiagnostic(value) {
  return bounded(value)
    .split('\n', 1)[0]
    .replace(/https?:\/\/[^\s)]+/gi, '<url>')
    .replace(/:\d+:\d+\b/g, ':#:#')
    .replace(/\bline\s+\d+\b/gi, 'line #')
    .replace(/\s+/g, ' ')
    .trim()
}

function performanceDefectScore(result) {
  const match = String(result.detail ?? '').match(/sampled FPS\s+([\d.]+)\s+was below\s+([\d.]+)/i)
  if (match === null) return 1
  const observed = Number(match[1])
  const threshold = Number(match[2])
  if (!Number.isFinite(observed) || !Number.isFinite(threshold) || threshold <= 0) return 1
  return Math.max(1, Math.round(Math.max(0, threshold - observed) * 1_000 / threshold))
}

/** Classify deterministic application/runtime performance defects and their bounded scope. */
export function classifyValidationResult(result) {
  let failureClass = 'none'
  if (result.status === 'blocked') failureClass = 'environment'
  else if (result.status === 'failed') {
    if (result.pageErrors.length > 0
      && result.networkErrors.length === 0
      && result.httpErrors.length === 0) failureClass = 'application-runtime'
    else if (result.networkErrors.length > 0 || result.httpErrors.length > 0) failureClass = 'network'
    else if (/sampled FPS .* was below/i.test(result.detail)) failureClass = 'performance'
    else failureClass = 'contract'
  }
  const diagnostics = failureClass === 'application-runtime'
    ? [...new Set(result.pageErrors.map(normalizedRuntimeDiagnostic).filter(Boolean))].sort()
    : []
  return {
    failureClass,
    diagnosticHash: diagnostics.length > 0
      ? createHash('sha256').update(JSON.stringify(diagnostics)).digest('hex')
      : '',
    defectScore: failureClass === 'application-runtime'
      ? Math.max(1, diagnostics.length)
      : failureClass === 'performance'
        ? performanceDefectScore(result)
        : 0,
    repairEligible: result.status === 'failed'
      && ['application-runtime', 'performance'].includes(failureClass),
  }
}

export function resultText(result) {
  const lines = [
    `APEX web validation ${result.checkId} (${result.mode}): ${result.status.toUpperCase()}.`,
    result.detail,
  ]
  if (result.url.length > 0) {
    lines.push(`Page: ${result.url}; browser=${result.browser || 'unknown'}; readyState=${result.readyState}; visibleCanvas=${result.visibleCanvasCount}/${result.canvasCount}; graphics=${result.graphicsApi}${result.graphicsRenderer ? ` (${result.graphicsRenderer})` : ''}; FPS=${result.fps.toFixed(1)}; p95=${result.p95FrameMs.toFixed(1)}ms.`)
    lines.push(`Diagnostics: console=${result.consoleErrors.length}, page=${result.pageErrors.length}, network=${result.networkErrors.length}, HTTP=${result.httpErrors.length}, missingSelectors=${result.missingSelectors.length}.`)
  }
  const diagnostics = [
    ...result.pageErrors.map(value => `page: ${value}`),
    ...result.consoleErrors.map(value => `console: ${value}`),
    ...result.networkErrors.map(value => `network: ${value}`),
    ...result.httpErrors.map(value => `HTTP: ${value}`),
  ]
  if (diagnostics.length > 0) {
    lines.push('Failure details:')
    lines.push(...diagnostics.slice(0, 4).map(value => `- ${value}`))
    if (diagnostics.length > 4) lines.push(`- ${diagnostics.length - 4} additional diagnostic(s) omitted`)
  }
  if (result.screenshotPath.length > 0) lines.push(`Screenshot: ${result.screenshotPath}`)
  lines.push(`Cleanup: ${result.cleanup}.`)
  if (result.mode === 'repair-proof') {
    if (result.status === 'passed') {
      lines.push(result.screenshotPath.length > 0
        ? 'This repair proof passed at runtime. Review its screenshot once; deliver if no structured blocking visual defect remains.'
        : 'This repair proof passed; deliver without another browser probe.')
    } else if (result.status === 'blocked' || ['environment', 'network'].includes(result.failureClass)) {
      lines.push('This is external/tooling evidence, not an application repair failure. One bounded post-final environment retry may be admitted without consuming a repair round.')
    } else if (result.repairEligible === true) {
      lines.push('Repair only this evidence. Another proof requires a successful mutation; the third round additionally requires measurable convergence, and a repeated runtime fingerprint requires a direct Pro repair.')
    } else {
      lines.push('This failure is not eligible for another repair proof; report it without lowering or changing the acceptance contract.')
    }
  } else if (result.status === 'passed' && result.mode === 'final') {
    lines.push(result.screenshotPath.length > 0
      ? 'The final runtime check passed. Review this final screenshot once with apex_inspect_image before delivery; only a definite blocking repair verdict can open an evidence-backed repair proof after a successful fix.'
      : 'The one final Web validation passed; deliver now without opening another probe.')
  } else if (result.status === 'failed' && result.mode === 'final' && result.repairEligible === true) {
    lines.push(`Final exposed a deterministic ${result.failureClass} defect. Repair only this evidence, then use mode=repair-proof with the exact same contract. Two evidence-backed rounds are available by default; a third requires convergence. Pro may repair directly; use apex_takeover only when a worker still owns the affected path.`)
  } else if (result.mode === 'final' && (result.status === 'blocked' || ['environment', 'network'].includes(result.failureClass))) {
    lines.push('Final hit an external environment/network block. One post-final environment retry may use mode=repair-proof without consuming a repair round; do not edit the application merely to satisfy external failure evidence.')
  } else if (result.status !== 'passed' && result.mode === 'final') {
    lines.push('The task-global final Web validation budget is closed; report the failure and do not create another check or lower the acceptance contract.')
  } else if (result.status !== 'passed' && result.mode === 'regression') {
    lines.push(`Record check "${result.checkId}" as failed, repair from these diagnostics, then use mode=final once with the exact same contract.`)
  } else if (result.status === 'passed') {
    lines.push(`Record check "${result.checkId}" as passed with this evidence in apex_state, then use the one final run with the unchanged contract.`)
  } else if (result.status === 'failed') {
    lines.push(`Record check "${result.checkId}" as failed, repair the concrete defect through one inspected worker continuation or explicit takeover, then use the one task-global regression with the exact same contract.`)
  } else {
    lines.push('This was an environment/tooling block, not proof that the application failed; keep the check pending and use at most its one regression after resolving the block.')
  }
  return lines.filter(Boolean).join('\n')
}

async function writeScreenshot(client, agent, value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const path = workspacePath(agent, value)
  if (path === undefined || extname(path).toLowerCase() !== '.png') {
    throw new Error('screenshot_path must be a workspace-local relative .png path')
  }
  const image = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, Buffer.from(image.data, 'base64'), { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY })
  return relative(agent.session.header.cwd, path).split(process.platform === 'win32' ? '\\' : '/').join('/')
}

async function terminateBrowser(handle) {
  if (handle === undefined) return true
  handle.terminate()
  if (await handle.waitForExit(AbortSignal.timeout(5_000))) return true
  handle.terminate()
  return await handle.waitForExit(AbortSignal.timeout(5_000))
}

/** Execute one admitted validation; exported for host-level smoke verification. */
export async function runValidation(ctx, args, exec) {
  const startedAt = Date.now()
  const root = workspacePath(exec.agent, args.root)
  if (root === undefined) throw new Error('root must resolve inside the current session workspace')
  const info = await fs.stat(root)
  if (!info.isDirectory()) throw new Error('root must name a directory containing the built static artifact')
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = exec.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([exec.signal, timeoutSignal])
  let stage = 'resolve-browser'
  let browserHandle
  let staticServer
  let client
  let userDataDir
  let result = emptyResult(args, 'blocked', '', startedAt)
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

    const consoleErrors = []
    const pageErrors = []
    const networkErrors = []
    const httpErrors = []
    const warnings = []
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
      if (params.type === 'Document' && response?.url === result.url) mainStatus = response.status
      if (response?.status >= 400) pushBounded(httpErrors, `${response.status} ${response.url}`)
    })

    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Log.enable'),
      client.send('Network.enable'),
      client.send('Emulation.setDeviceMetricsOverride', {
        width: args.width ?? 1280,
        height: args.height ?? 720,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ])
    stage = 'navigate'
    const navigation = await client.send('Page.navigate', { url: result.url })
    if (navigation.errorText) throw new Error(`navigation failed: ${bounded(navigation.errorText)}`)
    stage = 'page-validation'
    const pageInfo = await capturePage(client, args, signal)
    const screenshotPath = await writeScreenshot(client, exec.agent, args.screenshot_path)
    const missingSelectors = pageInfo.selectors.filter(item => !item.visible).map(item => item.selector)
    const failures = []
    if (mainStatus >= 400 || mainStatus === 0) failures.push(`main document HTTP status was ${mainStatus || 'not observed'}`)
    if (args.require_canvas === true && pageInfo.canvas.visible === 0) failures.push('no visible canvas')
    if (typeof args.min_fps === 'number' && pageInfo.fps.fps < args.min_fps) {
      failures.push(`sampled FPS ${pageInfo.fps.fps.toFixed(1)} was below ${args.min_fps}`)
    }
    if (missingSelectors.length > 0) failures.push(`missing/hidden selectors: ${missingSelectors.join(', ')}`)
    if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} uncaught page error(s)`)
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
      fps: Number(pageInfo.fps.fps.toFixed(2)),
      p95FrameMs: Number(pageInfo.fps.p95FrameMs.toFixed(2)),
      interactions: pageInfo.interactions,
      missingSelectors,
      consoleErrors,
      pageErrors,
      networkErrors,
      httpErrors,
      warnings,
      screenshotPath,
      detail: failures.length === 0
        ? bounded(args.assertion)
        : `Assertion failed: ${failures.join('; ')}.`,
    }
  } catch (error) {
    if (exec.signal?.aborted) throw error
    const status = ['navigate', 'page-validation'].includes(stage) ? 'failed' : 'blocked'
    result.status = status
    result.detail = `${stage}: ${bounded(error instanceof Error ? error.message : error)}`
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
    result.cleanup = cleanup.length > 0 ? cleanup.join(',') : 'nothing-started'
    if (cleanup.some(item => item.endsWith('-failed') || item === 'browser-still-live')) {
      result.status = 'blocked'
      result.detail = `${result.detail} Host cleanup did not reach verified quiescence.`.trim()
    }
    result.durationMs = Date.now() - startedAt
  }
  Object.assign(result, classifyValidationResult(result))
  result.text = resultText(result)
  return result
}

function outputSchema() {
  const strings = ['text', 'checkId', 'mode', 'status', 'failureClass', 'diagnosticHash', 'browser', 'url', 'readyState', 'title', 'graphicsApi', 'graphicsRenderer', 'screenshotPath', 'detail', 'cleanup']
  const properties = Object.fromEntries(strings.map(key => [key, { type: 'string' }]))
  properties.mode = { type: 'string', enum: ['baseline', 'regression', 'final', 'repair-proof'] }
  properties.status = { type: 'string', enum: ['passed', 'failed', 'blocked'] }
  properties.failureClass = { type: 'string', enum: ['none', 'application-runtime', 'performance', 'network', 'contract', 'environment'] }
  for (const key of ['durationMs', 'canvasCount', 'visibleCanvasCount', 'fps', 'p95FrameMs', 'defectScore']) properties[key] = { type: 'number' }
  properties.pointerLocked = { type: 'boolean' }
  properties.repairEligible = { type: 'boolean' }
  for (const key of ['interactions', 'missingSelectors', 'consoleErrors', 'pageErrors', 'networkErrors', 'httpErrors', 'warnings']) {
    properties[key] = { type: 'array', items: { type: 'string' } }
  }
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'apex_validate_web',
    description: [
      'Run one finite host-level browser acceptance check against a built static web directory without installing validation dependencies.',
      'Before the baseline, record stable pending/failed/passed acceptance checks in apex_state. The whole task gets one baseline, one regression after failure/block, and one final repaired run.',
      'After final, two repair-proof rounds are available by default for host-verifiable application/runtime, FPS, or structured blocking visual evidence. A third opens only when the immediately preceding proof measurably converged; an unchanged runtime fingerprint requires a direct Pro repair.',
      'One environment/network retry is tracked separately and does not consume a repair round. Browser, timeout, cleanup, preference-only, and inconclusive evidence never creates an application repair loop.',
      'Every run binds to one check id and the same acceptance contract; changing the id or lowering a threshold never resets the budget.',
      'The host starts a loopback static server and an already-installed Chrome/Chromium/Edge through the Harness subprocess seam, records console/page/network/HTTP failures, checks selectors/canvas, samples rAF, can dispatch bounded keys, optionally writes one workspace PNG, then closes only its own server/browser/profile.',
      'This is a smoke/interaction signal, not visual acceptance. When a run writes a screenshot, review it separately with apex_inspect_image.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check_id: { type: 'string', minLength: 1, maxLength: 64 },
        assertion: { type: 'string', minLength: 1, maxLength: 320 },
        mode: { type: 'string', enum: ['baseline', 'regression', 'final', 'repair-proof'] },
        root: { type: 'string', minLength: 1, maxLength: 512, description: 'Workspace-local static build directory such as dist.' },
        entry: { type: 'string', minLength: 1, maxLength: 240, description: 'Entry path inside root; defaults to index.html.' },
        require_canvas: { type: 'boolean' },
        required_selectors: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        click_canvas: { type: 'boolean' },
        interactions: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string', enum: Object.keys(KEY_DEFINITIONS) },
              hold_ms: { type: 'integer', minimum: 0, maximum: 2_000 },
            },
            required: ['key', 'hold_ms'],
          },
        },
        min_fps: { type: 'number', minimum: 1, maximum: 120 },
        sample_ms: { type: 'integer', minimum: 500, maximum: 5_000 },
        settle_ms: { type: 'integer', minimum: 0, maximum: 10_000 },
        timeout_ms: { type: 'integer', minimum: 5_000, maximum: 60_000 },
        width: { type: 'integer', minimum: 320, maximum: 3_840 },
        height: { type: 'integer', minimum: 240, maximum: 2_160 },
        screenshot_path: { type: 'string', maxLength: 512, description: 'Optional new workspace-local .png path; existing files are never overwritten.' },
      },
      required: ['check_id', 'assertion', 'mode', 'root'],
    },
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({
        kind: WEB_VALIDATION_META_KIND,
        checkId: value.checkId,
        mode: value.mode,
        status: value.status,
        signature: validationSignature(_args),
        failureClass: value.failureClass,
        diagnosticHash: value.diagnosticHash,
        defectScore: value.defectScore,
        repairEligible: value.repairEligible,
        screenshotPath: value.screenshotPath,
      }),
    },
    async execute(args, exec) {
      if (exec.agent?.session === undefined) throw new Error('apex_validate_web requires a calling parent agent')
      const denial = validationAdmission(args, exec.agent)
      if (denial !== undefined) throw new Error(denial)
      return await runValidation(ctx, args, exec)
    },
  })
}
