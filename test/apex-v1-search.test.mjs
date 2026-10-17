import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Search, beta, canonical, choose, digest, randomSource } from '../presets/apex-v1/search-core.mjs'
import { executeCandidate } from '../presets/apex-v1/search.mjs'
import { harnessRoot, harnessAvailable, native, nativeHarness, pluginRoot, systemText, textResponse, toolResponse } from './helpers/harness-v1.mjs'

const cases = [{input:1,expected:2},{input:2,expected:4}]
const outcomes = values => values.map(value=>({kind:'value',value}))
const opts = { mode:'program', seed:19, initialCandidates:3, maxCandidates:6 }
const real = {skip:!harnessAvailable||process.platform!=='darwin',timeout:30000}

test('sampler has expected moments; singleton groups preserve the exact baseline stream', () => {
  const random = randomSource(937), n=20000
  let total=0, squares=0
  for (let i=0;i<n;i++) { const x=beta(3,7,random); total+=x; squares+=x*x }
  assert.ok(Math.abs(total/n-0.3)<0.005)
  assert.ok(Math.abs(squares/n-(total/n)**2-21/1100)<0.001)
  const pool=Array.from({length:8},(_,i)=>({id:String(i),group:String(i),h:i/8,failures:i}))
  for(let seed=0;seed<100;seed++) assert.deepEqual(choose(pool,'program',randomSource(seed)),choose(pool,'behavior',randomSource(seed)))
  assert.throws(()=>beta(0,2,random),/>= 1/)
})

test('group nomination changes only the sampling unit and does not share failures', () => {
  const pool=[{id:'a',group:'g',h:0.5,failures:9},{id:'b',group:'g',h:0.5,failures:0},{id:'c',group:'h',h:1,failures:0}]
  const before=structuredClone(pool)
  const a=choose(pool,'program',randomSource(7)), b=choose(pool,'behavior',randomSource(7))
  assert.equal(a.scores.length,4); assert.equal(b.scores.length,3)
  assert.deepEqual(b.groupSizes,[2,1]); assert.equal(b.scores.filter(x=>x.id==='restart').length,1)
  assert.deepEqual(pool,before)
})

test('executed values define groups; exact duplicates preserve counts and consume attempts', () => {
  const s=new Search(cases,opts)
  s.accept('source A',outcomes([0,0])); s.accept('source B',outcomes([0,0]))
  const r=s.accept('source A',outcomes([0,0]))
  assert.equal(r.duplicate,true); assert.equal(r.attempt,3); assert.equal(r.pool.length,2)
  assert.equal(r.pool[0].group,r.pool[1].group); assert.equal(r.restartFailures,3)
  const parent=s.pending
  const next=s.accept('source C',outcomes([2,0]))
  if(parent==='restart') assert.equal(next.restartFailures,4)
  else assert.equal(next.pool.find(p=>p.id===parent).failures,1)
  assert.throws(()=>s.accept('source A',outcomes([9,9])),/not deterministic/)
  assert.equal(s.attempts,4)
  const e=new Search(cases,opts)
  e.accept('error A',cases.map(()=>({kind:'runtime-error',message:'path A'})))
  e.accept('error B',cases.map(()=>({kind:'runtime-error',message:'path B'})))
  assert.equal(e.pool[0].group,e.pool[1].group)
})

test('early pass stops; budget delivers the best public source without hidden selection', () => {
  const s=new Search(cases,opts)
  const r=s.accept('correct',outcomes([2,4]))
  assert.equal(r.done,true); assert.equal(r.attempt,1); assert.equal(s.selectedSource(),'correct')
  assert.throws(()=>s.accept('extra',outcomes([2,4])),/finished/)
  const b=new Search(cases,{...opts,maxCandidates:3})
  b.accept('best',outcomes([2,0])); b.accept('bad',outcomes([0,0]))
  assert.equal(b.accept('bad2',outcomes([0,0])).reason,'candidate-budget')
  assert.equal(b.selectedSource(),'best')
  assert.throws(()=>canonical({x:undefined}),/finite JSON/)
  assert.throws(()=>new Search([] ,opts),/public cases/)
})

async function fixture(t, config={}, script=()=>textResponse('done')) {
  const dir=await mkdtemp(join(tmpdir(),'apex-search-preset-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const { entryListSchema } = await native('cordis-plugin-include')
  const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const rows = load(await readFile(join(pluginRoot,'presets/apex-v1/agent.cordis.yml'),'utf8'), { schema: entryListSchema })
  const preset = rows.find(row => Array.isArray(row.insert))?.insert?.find(row => row.id === 'preset-apex-v1')
  const session = preset?.config?.plugins?.find(row => row.id === 'apex-session')
  assert.ok(session && Array.isArray(session.config), 'fixture must have an apex-session group')
  const search = session.config.find(row => row.id === 'apex-search')
  const review = session.config.find(row => row.id === 'apex-review')
  assert.ok(search && review, 'fixture must have search and review plugins')
  search.name = join(pluginRoot, 'presets/apex-v1/search.mjs')
  Object.assign(search.config, {...opts,...config})
  review.config = { backgroundOnly: true }
  await mkdir(join(dir,'apex-v1'))
  await writeFile(join(dir,'apex-v1/agent.cordis.yml'),dump(rows, { schema: entryListSchema, noRefs: true }))
  const h=await nativeHarness(script,{presetRoot:dir}); t.after(h.close)
  const agent=await h.create()
  await writeFile(join(h.cwd,'public-cases.json'),JSON.stringify(cases))
  const {scopeOf}=await native('dsh-scope')
  const def=h.ctx.tools.get('apex_search',scopeOf(agent.ctx))
  const exec={agent,signal:new AbortController().signal,callId:'search-check'}
  return {...h,agent,exec,call:args=>def.execute(args,exec),def}
}

test('assembled native tool executes, restores parent, rejects stale tickets and records the first request',real,async t=>{
  let step=0
  const h=await fixture(t,{initialCandidates:1},()=>++step===1?toolResponse('start','run_code',{
    description:'Start candidate search',code:'return await tools.apex_search({action:"start"});',
  }):textResponse('done'))
  await h.turn(h.agent,'Solve the fixture')
  const events=h.agent.session.snapshotEvents()
  const row=events.find(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='apex_search')
  assert.ok(row&&!row.data.isError,JSON.stringify(row))
  assert.match(systemText(h.adapter.requests[0]),/Only the tool chooses the next parent/)
  const start=await h.call({action:'status'})
  assert.equal(start.startedCandidates,1)
  await assert.rejects(h.call({action:'submit',ticket:'wrong'}),/ticket/)
  await writeFile(join(h.cwd,'solver.mjs'),'export function solve(x){return x*2}')
  const end=await h.call({action:'submit',ticket:start.ticket})
  assert.equal(end.passed,2,JSON.stringify(end)); assert.equal(end.done,true); assert.equal(end.execution.exitCode,0)
  assert.equal(digest(await readFile(join(h.cwd,'solver.mjs'))),end.selected)
  assert.equal(await readFile(join(h.cwd,end.snapshot),'utf8'),end.parentSource)
  await assert.rejects(h.call({action:'submit',ticket:start.ticket}),/finished/)
})

test('candidate execution denies filesystem, network, process creation and handles syntax, timeout, invalid exports',real,async t=>{
  const h=await fixture(t)
  const run=source=>executeCandidate(h.ctx,h.exec,source,[1],1000)
  const boundary=await run('export function solve(){return {args:process.execArgv,read:process.permission?.has("fs.read"),exe:process.execPath}}')
  assert.equal(boundary.outcomes[0].value.read,false,JSON.stringify(boundary))
  for(const source of [
    'import fs from "node:fs"; export function solve(){return fs.readFileSync("/etc/hosts","utf8")}',
    'import fs from "node:fs"; export function solve(){fs.writeFileSync("canary","bad");return 1}',
    'import cp from "node:child_process"; export function solve(){cp.execSync("true");return 1}',
    'import dgram from "node:dgram"; const s=dgram.createSocket("udp4"); s.bind(0); export function solve(){return 1}',
  ]) {
    const r=await run(source)
    assert.ok(r.outcomes.every(o=>o.kind!=='value'),JSON.stringify(r))
  }
  await assert.rejects(access(join(h.cwd,'canary')),{code:'ENOENT'})
  assert.equal((await run('export const solve=1')).outcomes[0].kind,'runtime-error')
  assert.equal((await run('export function {')).outcomes[0].kind,'syntax-error')
  assert.equal((await run('export function solve(){while(true){}}')).outcomes[0].kind,'timeout')
  assert.equal((await run('export async function solve(){return 1}')).outcomes[0].kind,'invalid-result')
})

test('candidate input preserves special JSON keys, arrays, primitives and escaped text',real,async t=>{
  const h=await fixture(t)
  const inputs=[
    JSON.parse('{"__proto__":{"n":1},"constructor":"own","prototype":2}'),
    JSON.parse('{"doc":{"__proto__":null},"items":[{"__proto__":"value"}]}'),
    JSON.parse('[{"__proto__":{"n":2}},null,false,3,"text"]'),
    {},[],null,true,false,0,-1,1.25,
    '\"; throw Error("must remain text"); // \\ \n \u0000 \u2028 \u2029 中文',
  ]
  const before=structuredClone(inputs)
  const result=await executeCandidate(h.ctx,h.exec,'export const solve=input=>input',inputs,1000)
  assert.equal(result.execution.exitCode,0)
  assert.equal(result.execution.timedOut,false)
  assert.deepEqual(result.outcomes,outcomes(before))
  assert.deepEqual(inputs,before)
  assert.equal(h.adapter.requests.length,0)
})

test('suite tampering and overlapping calls fail without another search',real,async t=>{
  const h=await fixture(t)
  const first=h.call({action:'start'})
  await assert.rejects(h.call({action:'start'}),/in progress/)
  const start=await first
  await writeFile(join(h.cwd,'public-cases.json'),'[]')
  await assert.rejects(h.call({action:'submit',ticket:start.ticket}),/changed/)
  await assert.rejects(h.call({action:'status'}),/uncertain/)
  const other=await h.create('other', 'apex-v1')
  await assert.rejects(h.def.execute({action:'start'},{...h.exec,agent:other}),/public cases|already contains/)
})

test('symbolic links are refused and cancellation never advances the pending decision',real,async t=>{
  const h=await fixture(t)
  const start=await h.call({action:'start'})
  await symlink('public-cases.json',join(h.cwd,'solver.mjs'))
  await assert.rejects(h.call({action:'submit',ticket:start.ticket}),/regular files/)
  await rm(join(h.cwd,'solver.mjs'))
  // A separate workspace/session tests cancellation without reusing failed state.
  const cwd=join(h.root,'cancel-workspace');await mkdir(cwd)
  await writeFile(join(cwd,'public-cases.json'),JSON.stringify(cases))
  const agent=await h.create('cancel-search','apex-v1',cwd),abort=new AbortController()
  const exec={...h.exec,agent,signal:abort.signal}
  const first=await h.def.execute({action:'start'},exec)
  await writeFile(join(cwd,'solver.mjs'),'export function solve(){while(true){}}')
  const call=h.def.execute({action:'submit',ticket:first.ticket},exec)
  const timer=setTimeout(()=>abort.abort(new Error('fixture cancellation')),100)
  try{await assert.rejects(call,/fixture cancellation/)}finally{clearTimeout(timer)}
  await assert.rejects(h.def.execute({action:'status'},{...exec,signal:new AbortController().signal}),/uncertain/)
})

test('frozen seed pool is re-executed and both modes inherit exact sources and counters',real,async t=>{
  const h=await fixture(t,{useSeedPool:true})
  const sources=['export const solve=x=>0','export const solve=x=>x','export const solve=x=>x+0']
  const pool={suiteHash:digest(JSON.stringify(cases)),sources:sources.map((source,i)=>({source,sha256:digest(source),outcomes:outcomes(i===0?[0,0]:[1,2])}))}
  await writeFile(join(h.cwd,'search-seeds.json'),JSON.stringify(pool))
  const start=await h.call({action:'start'})
  assert.equal(start.pool.length,3); assert.equal(start.restartFailures,3); assert.equal(start.startedCandidates,4)
  assert.deepEqual(start.groupSizes.slice().sort(),[1,2])
  assert.equal(await readFile(join(h.cwd,'solver.mjs'),'utf8'),start.parentSource)
})

test('disabled search keeps its tool and prompt absent',real,async t=>{
  const h=await fixture(t,{mode:'off'})
  assert.equal(h.def,undefined)
  await h.turn(h.agent,'Ordinary task')
  assert.doesNotMatch(systemText(h.adapter.requests[0]),/apex_search|Only the tool chooses/)
})

test('native background review rejects synchronous calls and outlives its completed launching PTC',real,async t=>{
  let parentStep=0,childFinished=false
  const h=await fixture(t,{mode:'off'},async request=>{
    if(systemText(request).includes('independent read-only reviewer')) {
      await delay(250); childFinished=true; return textResponse('review-finished')
    }
    parentStep++
    if(parentStep===1) return toolResponse('blocked','run_code',{description:'Check foreground guard',code:'return await tools.apex_review({description:"review",prompt:"inspect"});'})
    if(parentStep===2) return toolResponse('background','run_code',{description:'Start native background review',code:'return await tools.apex_review({description:"review",prompt:"inspect",run_in_background:true});'})
    if(parentStep===3) {
      assert.equal(childFinished,false,'launching PTC returned before the review completed')
      const job=h.ctx.jobs.list(h.agent.id).at(-1)
      assert.ok(job)
      return toolResponse('collect','run_code',{description:'Collect native review job',code:`return await tools.job_output({job_id:${JSON.stringify(job.id)},wait:true,timeout_ms:1000});`})
    }
    return textResponse('done')
  })
  await h.turn(h.agent,'Review once')
  const events=h.agent.session.snapshotEvents(),reviews=events.filter(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='apex_review')
  assert.equal(reviews.length,2); assert.equal(reviews[0].data.isError,true); assert.equal(reviews[1].data.isError,false)
  assert.ok(childFinished)
  assert.ok(JSON.stringify(events.filter(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='job_output')).includes('review-finished'))
})
