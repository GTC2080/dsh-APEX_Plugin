import { sliceText } from './text.mjs'
import { randomInt, randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { registerTool } from './tools.mjs'
import { Search, canonical, digest } from './search-core.mjs'

export const name = 'apex-candidate-search'
export const inject = ['tools', 'systemPrompt', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']
export const Config = z.object({
  mode: z.enum(['off', 'program', 'behavior']).default('off'),
  initialCandidates: z.number().int().min(1).max(3).default(3),
  maxCandidates: z.number().int().min(1).max(6).default(6),
  evaluationTimeoutMs: z.number().int().min(100).max(20000).default(10000),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  useSeedPool: z.boolean().default(false),
}).strict().refine(c => c.initialCandidates <= c.maxCandidates, 'initialCandidates exceeds maxCandidates').prefault({})

const MAX_SOURCE = 131072
const MAX_CASES = 1048576

/** Runner payload shared with independently hosted evaluation. No reference answers. */
export function candidateScript(source, inputs) {
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  // Parse JSON as data so __proto__ stays an own key instead of setting a prototype.
  return `const inputs = JSON.parse(${JSON.stringify(JSON.stringify(inputs))});
const encode = JSON.stringify.bind(JSON), clone = structuredClone;
const sliceText = ${sliceText.toString()};
const plain = Object.getPrototypeOf.bind(Object), finite = Number.isFinite.bind(Number);
function json(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && finite(v))) return;
  if (!v || typeof v !== 'object' || seen.has(v)) throw Error('Non-JSON result');
  if (!Array.isArray(v) && plain(v) !== Object.prototype && plain(v) !== null) throw Error('Non-plain result');
  seen.add(v); for (const x of Array.isArray(v) ? v : Object.values(v)) json(x, seen); seen.delete(v);
}
const results = []; let run;
try { run = (await import(${JSON.stringify(url)})).solve; if (typeof run !== 'function') throw Error('Missing solve export'); }
catch (e) { run = undefined; for (const _ of inputs) results.push({kind:e instanceof SyntaxError?'syntax-error':'runtime-error',message:sliceText(String(e),0,1000)}); }
if (run) for (const input of inputs) {
  try { const value = run(clone(input));
    try { json(value); results.push({kind:'value',value}); }
    catch (e) { results.push({kind:'invalid-result',message:sliceText(String(e),0,1000)}); }
  } catch (e) { results.push({kind:'runtime-error',message:sliceText(String(e),0,1000)}); }
}
process.stdout.write(encode(results));`
}

/** One disposable, permission-restricted Node process; reference answers stay in the parent. */
export async function executeCandidate(ctx, exec, source, inputs, timeoutMs) {
  const script = candidateScript(source,inputs)
  // macOS cannot apply nested Seatbelt profiles. Narrow the native profile once,
  // then retain the native subprocess service's cancellation and range cleanup.
  const command = ['/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=en_US.UTF-8','TZ=UTC',
    process.execPath,'--permission','--max-old-space-size=256','--input-type=module','-e',
    // Node's implicit stdin entry grants cwd reads. Explicit -e keeps them denied.
    'const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); await import("data:text/javascript;base64,"+Buffer.concat(chunks).toString("base64"));']
  const confined = await ctx.sandbox.confine(command,
    { ...ctx.sandboxPolicy.resolve({session:exec.agent.session}), mode:'read-only' },exec.signal)
  const [runner,flag,profile,separator,...actual] = confined.argv
  if (!['sandbox-exec','/usr/bin/sandbox-exec'].includes(runner) || flag!=='-p' || separator!=='--') {
    throw new Error('Search requires the verified native macOS Seatbelt argv contract')
  }
  const restrictions = ' (deny network*) (deny file-write*) (deny process-fork)'
    + ' (deny signal) (allow signal (target same-sandbox))'
    + ' (deny file-read-data (subpath "/Users") (subpath "/private/var/folders"))'
    + ' (allow file-read-data (subpath '+JSON.stringify(dirname(dirname(process.execPath)))+'))'
    + ' (deny process-exec) (allow process-exec (literal "/usr/bin/env") (literal '+JSON.stringify(process.execPath)+'))'
  const deadline = new AbortController(), timer=setTimeout(()=>deadline.abort(),timeoutMs)
  const signal = AbortSignal.any([exec.signal,deadline.signal])
  let running, result, stdout, stderr
  try {
    signal.throwIfAborted()
    running=ctx.subprocess.spawn({argv:[runner,flag,profile+restrictions,separator,...actual],cwd:'/',
      stdio:{stdin:{data:script},stdout:{maxBytes:MAX_CASES},stderr:{maxBytes:16384}},graceMs:1000,signal})
    result=await running.done
    stdout=running.collected.stdout.readFrom(0); stderr=running.collected.stderr.readFrom(0)
  } finally {
    clearTimeout(timer)
    if(running) {
      running.terminate()
      if(!await running.waitForExit(AbortSignal.timeout(5000))) throw new Error('Candidate process cleanup is incomplete')
    }
  }
  exec.signal.throwIfAborted()
  if (stdout.lossy || stderr.lossy) throw new Error('Candidate execution output was truncated')
  if (/sandbox-exec: sandbox_apply:|sandbox-exec: execvp:/.test(stderr.text)) throw new Error('Candidate sandbox runner failed: '+sliceText(stderr.text,0,1000))
  const execution = { exitCode: result.exitCode, timedOut: deadline.signal.aborted,
    stderr: sliceText(stderr.text,0,2000), sandbox:{mode:'read-only',enforcement:confined.enforcement,network:'denied'} }
  if (execution.timedOut || result.exitCode !== 0) return {
    outcomes: inputs.map(() => ({ kind: execution.timedOut ? 'timeout' : 'process-error' })), execution,
  }
  let outcomes
  try { outcomes = JSON.parse(stdout.text) }
  catch { return { outcomes: inputs.map(() => ({kind:'invalid-result',message:'Unexpected stdout; solve must not log'})), execution } }
  if (!Array.isArray(outcomes) || outcomes.length !== inputs.length) throw new Error('Candidate runner returned an invalid result count')
  return { outcomes, execution }
}

/** Version-checked, policy-aware workspace files shared by both experiment entry points. */
export function candidateWorkspace(ctx) {
  async function target(exec, name) {
    const cwd = exec.agent.session.header.cwd
    if (!isAbsolute(cwd ?? '')) throw new Error('Search requires an absolute session workspace')
    const root = await ctx.fs.resolve(cwd, { signal: exec.signal })
    const path = await ctx.fs.resolve(name, { cwd, signal: exec.signal })
    if (!ctx.fs.contains(root, path)) throw new Error('Search file escapes the workspace')
    const info = await ctx.fs.lstat(name, { cwd }, exec.signal)
    if (info && info.type !== 'file') throw new Error('Search accepts regular files only')
    return { path, info }
  }
  async function read(exec, name, cap) {
    const t = await target(exec, name)
    if (!t.info) throw new Error('Missing search file: ' + name)
    const bytes = await ctx.fs.readBytes(t.path, exec.signal, cap)
    const after = await ctx.fs.stat(t.path, exec.signal)
    if (after?.version !== t.info.version) throw new Error('Search file changed while being read')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ...t, text }
  }
  async function write(exec, t, text) {
    return ctx.fs.writeText(t.path, text, t.info
      ? { kind: 'replaceIfVersion', version: t.info.version } : { kind: 'createIfAbsent' }, exec.signal,
    ctx.sandboxPolicy.resolve({ session: exec.agent.session }))
  }
  return { target, read, write }
}

export function apply(ctx, input = {}) {
  const config = Config.parse(input)
  if (config.mode === 'off') return
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('APEX search currently requires the verified macOS / Node 24 execution path')
  }
  const states = new WeakMap()
  const { target, read, write } = candidateWorkspace(ctx)
  ctx.systemPrompt.section({ name: 'apex:search', order: 600,
    text: 'For a pure ESM solve(input) task with public-cases.json, use apex_search to conduct candidate search. '
      + 'Call action:start before writing solver.mjs. It freezes public checks and returns a ticket. Write a complete candidate to solver.mjs, '
      + 'then call action:submit with that ticket. The tool executes the candidate and chooses the next parent; it restores that parent into solver.mjs '
      + '(or empties the file for a fresh approach). Inspect the returned evidence and selected source, then make the next candidate. '
      + 'Do not edit public-cases.json or the .apex-search records. Do not generate deliberate failures or duplicate copies to influence sampling. '
      + 'Only the tool chooses the next parent. A public pass stops search immediately; after the candidate limit it restores the best public candidate. '
      + 'When done:true is returned, deliver that exact solver.mjs and report the observed public result, including any remaining failures. '
      + 'Do not patch it further or restart search. A public pass is not proof of unseen-case correctness. Other task types use ordinary APEX.',
  })

  registerTool(ctx, { name: 'apex_search',
    description: 'Run bounded candidate search on solver.mjs using immutable public-cases.json. start freezes the suite; submit executes source, '
      + 'records its actual behavior, and restores the algorithm-selected parent. status returns the same pending ticket without resampling. '
      + 'Source snapshots and the search marker are workspace files. Each instance permits one search; a restarted Host refuses automatic resumption. '
      + 'Supports only synchronous pure ESM solve(input), no imports from workspace files, no filesystem, network or child processes in candidate execution.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['start','submit','status'] }, ticket: { type: 'string', minLength: 1, maxLength: 128 },
    }, required: ['action'] },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{type:'text',text:JSON.stringify(value)}] },
    presentCall: args => ({ card:'generic', title:'APEX candidate search: '+args.action, kind:'execute' }),
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('Search requires a calling agent')
      let state = states.get(agent)
      if (state?.busy) throw new Error('Another search operation is in progress')
      if (state?.failed) throw new Error('Search state is uncertain after a failed operation; preserve records and stop')
      if (args.action === 'status' || (args.action === 'start' && state)) {
        if (!state) throw new Error('Search has not started')
        return state.last
      }
      if (args.action === 'start') {
        state = { busy:true }; states.set(agent,state)
        try {
          const suite = await read(exec,'public-cases.json',MAX_CASES)
          const seed = config.seed ?? randomInt(0x100000000)
          state.search = new Search(JSON.parse(suite.text), {...config, seed})
          state.suiteHash = digest(suite.text)
          const marker = await target(exec,'.apex-search.json')
          if (marker.info) throw new Error('This workspace already contains a search; transparent restart is unsupported')
          let imported
          if (config.useSeedPool) {
            const file = await read(exec,'search-seeds.json',MAX_CASES)
            const pool = z.object({ suiteHash:z.string(), sources:z.array(z.object({
              source:z.string().min(1), sha256:z.string(), outcomes:z.array(z.unknown()),
            }).strict()).min(1).max(config.initialCandidates) }).strict().parse(JSON.parse(file.text))
            if (pool.suiteHash !== state.suiteHash) throw new Error('Seed pool uses different public cases')
            state.seedHash = digest(file.text)
            for (const candidate of pool.sources) {
              if (digest(candidate.source) !== candidate.sha256) throw new Error('Seed source hash mismatch')
              const result = await executeCandidate(ctx,exec,candidate.source,state.search.cases.map(c=>c.input),config.evaluationTimeoutMs)
              // Re-execute every imported candidate; never trust a supplied public score.
              imported = state.search.accept(candidate.source,result.outcomes)
              const normalize = outcomes => outcomes.map(o=>o.kind==='value'?{kind:o.kind,value:o.value}:{kind:o.kind})
              if (canonical(normalize(result.outcomes)) !== canonical(normalize(candidate.outcomes))) throw new Error('Seed behavior differs from its frozen execution')
            }
            if (!state.search.done && pool.sources.length !== config.initialCandidates) throw new Error('Incomplete initial pool')
            await write(exec,await target(exec,'solver.mjs'),state.search.selectedSource())
          }
          state.last = { ...imported, done:state.search.done, ticket:state.search.done?null:randomUUID(),
            action:state.search.done?'deliver':state.search.pending==='restart'?'generate':'repair', selected:state.search.pending,
            parentSource:state.search.selectedSource(), startedCandidates:state.search.attempts+(state.search.done?0:1),
            suiteHash:state.suiteHash, seedHash:state.seedHash??null, seed, mode:config.mode,
            maxCandidates:config.maxCandidates, initialCandidates:config.initialCandidates }
          await write(exec,marker,JSON.stringify({...state.last,mode:config.mode})+'\n')
          return state.last
        } catch (error) { state.failed=true; throw error }
        finally { state.busy=false }
      }
      if (!state) throw new Error('Start search first')
      if (state.search.done) throw new Error('Search has finished; deliver the selected file')
      if (args.ticket !== state.last.ticket) throw new Error('The submission ticket does not match the pending decision')
      state.busy=true
      try {
        const suite = await read(exec,'public-cases.json',MAX_CASES)
        if (digest(suite.text) !== state.suiteHash) throw new Error('Public cases changed after start')
        if (state.seedHash && digest((await read(exec,'search-seeds.json',MAX_CASES)).text) !== state.seedHash) throw new Error('Seed pool changed after start')
        const candidate = await read(exec,'solver.mjs',MAX_SOURCE)
        const hash = digest(candidate.text)
        const snapshotName = '.apex-search-'+hash+'.mjs'
        const snapshot = await target(exec,snapshotName)
        if (snapshot.info) {
          if ((await read(exec,snapshotName,MAX_SOURCE)).text !== candidate.text) throw new Error('Candidate snapshot was modified')
        } else await write(exec,snapshot,candidate.text)
        const result = await executeCandidate(ctx,exec,candidate.text,state.search.cases.map(c=>c.input),config.evaluationTimeoutMs)
        const decision = state.search.accept(candidate.text,result.outcomes)
        await write(exec,candidate,state.search.selectedSource())
        state.last = { ...decision, execution:result.execution, snapshot:snapshotName, suiteHash:state.suiteHash,
          mode:config.mode, startedCandidates:state.search.attempts+(decision.done?0:1), parentSource:state.search.selectedSource(),
          ticket:decision.done ? null : randomUUID(), action:decision.done ? 'deliver' : decision.selected==='restart' ? 'generate' : 'repair',
          restoredHash:decision.selected==='restart' ? digest('') : decision.selected }
        return state.last
      } catch (error) { state.failed=true; throw error }
      finally { state.busy=false }
    },
  })
}
