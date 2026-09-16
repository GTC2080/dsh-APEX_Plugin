import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { harnessAvailable, native, nativeHarness } from './helpers/harness-v1.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const report = { modelApiCalls: 0, checks: [], observations: [] }
let callId = 0
async function run(h, agent, code, signal = new AbortController().signal, extra = {}) {
  return h.ctx.tools.execute({ agent, name: 'run_code', callId: 'temporary-' + ++callId,
    arguments: { code, description: 'Fixed private temporary storage integration check', ...extra }, signal })
}
function result(reply) { assert.equal(reply.isError, false, reply.error?.message); return reply.value.result }
const bash = (command, extra = {}) => `return await tools.bash(${JSON.stringify({ command, description: 'Fixed integration fixture', ...extra })});`
const script = code => `return await tools.apex_run_script(${JSON.stringify({ command: quote(process.execPath) + ' --input-type=module', script: code, description: 'Fixed integration fixture' })});`
async function until(check) {
  for (let i = 0; i < 250; i++) { const value = await check(); if (value) return value; await delay(20) }
  assert.fail('Fixture did not settle within five seconds')
}

test('native sessions use private temporary storage across execution and lifecycle paths', { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 60000 }, async t => {
  const oldHome = process.env.DSH_HOME
  const external = await realpath(await mkdtemp(join(tmpdir(), 'apex-temporary-control-')))
  const durable = await realpath(await mkdtemp(join(tmpdir(), 'apex-temporary-workspace-')))
  let h = await nativeHarness(undefined, { shippedPresets: true })
  let a = await h.create('temporary-lead', 'apex-v1', durable)
  const b = await h.create('temporary-other', 'apex-v1', durable)
  const official = await h.create('temporary-official', 'ptc', durable)
  const policy = agent => h.ctx.sandboxPolicy.resolve({ session: agent.session })
  const temp = agent => h.ctx.apexTemporaryDirectories.directory(policy(agent)).path
  const privateA = temp(a), privateB = temp(b), container = h.ctx.apexTemporaryDirectories.root.path
  async function check(name, fn) {
    await t.test(name, async () => {
      try { await fn(); report.checks.push({ name, pass: true }) }
      catch (error) { report.checks.push({ name, pass: false, error: String(error) }); throw error }
    })
  }
  try {
    await check('Bash, stdin scripts and direct PTC share only their session temp directory', async () => {
      const code = `const fs=await import('node:fs/promises'),os=await import('node:os');const root=os.tmpdir();
        const p=await fs.mkdtemp(root+'/ordinary-');await fs.writeFile(p+'/value','ok');const value=await fs.readFile(p+'/value','utf8');await fs.rm(p,{recursive:true});`
      const programs = [bash(quote(process.execPath)+' --input-type=module -e '+quote(code+'console.log(JSON.stringify({root,value}));')),
        script(code+'console.log(JSON.stringify({root,value}));'), code+'return {root,value,env:Object.keys(process.env)};']
      for (let i = 0; i < programs.length; i++) {
        const out = result(await run(h, a, programs[i]))
        if (i !== 2) assert.equal(out.exitCode, 0, out.stderr.text)
        const value = i === 2 ? out : JSON.parse(out.stdout.text)
        assert.equal(await realpath(value.root), privateA); assert.equal(value.value, 'ok')
        if (i === 2) assert.deepEqual(value.env, [])
      }
      assert.notEqual(privateA, privateB)
    })
    await check('shared, sibling-session and linked targets survive real deletion attempts', async () => {
      const first = join(external, 'sentinel'), second = join(privateB, 'sentinel')
      await writeFile(first, 'outside'); await writeFile(second, 'other session')
      const link = join(privateA, 'external-link'); await symlink(external, link)
      const paths = [first, second, join(link, 'sentinel'), privateA+'/../'+privateB.split('/').at(-1)+'/sentinel']
      const code = `const fs=await import('node:fs/promises');const denied=[];for(const p of ${JSON.stringify(paths)}){try{await fs.rm(p,{force:true});denied.push(false)}catch(e){denied.push(['EPERM','EACCES'].includes(e.code))}};`
      for (const program of [code+'return denied;', script(code+'console.log(JSON.stringify(denied));'),
        bash(quote(process.execPath)+' --input-type=module -e '+quote(code+'console.log(JSON.stringify(denied));'))]) {
        const out = result(await run(h, a, program)), denied = Array.isArray(out) ? out : JSON.parse(out.stdout.text)
        assert.deepEqual(denied, paths.map(() => true)); assert.equal(await readFile(first,'utf8'),'outside'); assert.equal(await readFile(second,'utf8'),'other session')
      }
      for (const path of paths) {
        const out = await run(h,a,`return await tools.write(${JSON.stringify({file_path:path,content:'forbidden'})});`)
        assert.equal(out.isError,true); assert.equal(await readFile(first,'utf8'),'outside'); assert.equal(await readFile(second,'utf8'),'other session')
      }
    })
    await check('native writes and edits preserve version checks and serialize competing mutations', async () => {
      const file=join(durable,'version.txt'), target=await h.ctx.fs.resolve(file)
      const started=performance.now()
      const created=await h.ctx.fs.writeText(target,'before\r\n',{kind:'createIfAbsent'},undefined,policy(a))
      const first=await h.ctx.fs.editText(target,{oldString:'before',newString:'after',replaceAll:false},{version:created.version},undefined,policy(a))
      assert.equal(await readFile(file,'utf8'),'after\r\n')
      await assert.rejects(h.ctx.fs.writeText(target,'stale',{kind:'replaceIfVersion',version:created.version},undefined,policy(a)),{code:'FS_STALE_VERSION'})
      const writes=await Promise.allSettled(['one','two'].map(text=>h.ctx.fs.writeText(target,text,{kind:'replaceIfVersion',version:first.version},undefined,policy(a))))
      assert.equal(writes.filter(x=>x.status==='fulfilled').length,1)
      assert.equal(writes.find(x=>x.status==='rejected').reason.code,'FS_STALE_VERSION')
      const p=join(privateA,'native-tool.txt')
      result(await run(h,a,`await tools.write(${JSON.stringify({file_path:p,content:'old'})});return await tools.edit(${JSON.stringify({file_path:p,old_string:'old',new_string:'new'})});`))
      assert.equal(await readFile(p,'utf8'),'new')
      report.observations.push({kind:'file-operations',elapsedMs:performance.now()-started,operations:7})
    })
    await check('a directory replacement after native containment cannot redirect worker publication', async () => {
      const directory=join(durable,'race'), held=directory+'-held', target=join(directory,'sentinel')
      await mkdir(directory); await writeFile(target,'workspace'); await writeFile(join(external,'sentinel'),'outside')
      const wrapper=join(external,'race-provider.mjs'), originalSpawn=h.ctx.subprocess.spawn.bind(h.ctx.subprocess)
      let intercepted=0
      const original = t.mock.method(h.ctx.subprocess,'spawn',function(spec){
        const index=spec.argv.findIndex(arg=>arg.endsWith('/temporary-fs-worker.mjs'))
        if(index===-1)return originalSpawn(spec)
        intercepted++
        const argv=[...spec.argv];argv[index+2]=pathToFileURL(wrapper).href
        return originalSpawn({...spec,argv})
      })
      const {createRequire}=await import('node:module')
      const req=createRequire(new URL('package.json',h.ctx.baseUrl)), local=createRequire(req.resolve('@deepseek-ai/dsh-fs-sandbox')).resolve('@deepseek-ai/dsh-fs-local')
      await writeFile(wrapper,`import Native from ${JSON.stringify(pathToFileURL(local).href)};import{rename,symlink}from'node:fs/promises';
        export default class extends Native{constructor(ctx,config){super(ctx,config);this.internals.inspectTemp=async()=>{await rename(${JSON.stringify(directory)},${JSON.stringify(held)});await symlink(${JSON.stringify(external)},${JSON.stringify(directory)});}}}`)
      try {
        const current=await h.ctx.fs.resolve(target)
        await assert.rejects(h.ctx.fs.writeText(current,'must-not-escape',undefined,undefined,policy(a)))
        assert.equal(intercepted,1);assert.equal(await readFile(join(external,'sentinel'),'utf8'),'outside')
        assert.equal(await readFile(join(held,'sentinel'),'utf8'),'workspace')
      } finally {
        original.mock.restore()
        if(existsSync(held)){await unlink(directory);await rename(held,directory)}
      }
    })
    await check('official presets and explicit full-access retain native behavior; read-only still denies writes', async () => {
      const file=join(external,'official-allowed.txt')
      result(await run(h,official,`return await tools.write(${JSON.stringify({file_path:file,content:'official'})});`))
      assert.equal(await readFile(file,'utf8'),'official')
      const {setSandboxMode}=await native('dsh-sandbox-policy')
      setSandboxMode(a.session,'read-only')
      try {assert.equal((await run(h,a,`await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(privateA,'denied'))},'x');`)).isError,true)}
      finally {setSandboxMode(a.session,'workspace-write')}
      setSandboxMode(a.session,'danger-full-access')
      try {result(await run(h,a,`return await tools.write(${JSON.stringify({file_path:join(external,'explicit-full.txt'),content:'explicit'})});`))}
      finally {setSandboxMode(a.session,'workspace-write')}
      assert.equal(await readFile(join(external,'explicit-full.txt'),'utf8'),'explicit')
    })
    await check('unload and native resume reuse the same private directory within a Host', async () => {
      await writeFile(join(privateA,'resume-marker'),'retained')
      await h.turn(a,'Reply briefly without tools.')
      await h.dispose(a);a=await h.resume('temporary-lead')
      assert.equal(temp(a),privateA);assert.equal(await readFile(join(temp(a),'resume-marker'),'utf8'),'retained')
    })
    await check('fresh and fork teammates receive separate private directories', async () => {
      for(const context of ['fresh','fork']) {
        const out=result(await run(h,a,`return await tools.spawn_teammate(${JSON.stringify({name:context,description:'Fixed component lifecycle check',prompt:'Reply ready without tools.',context})});`))
        const id=out.member.id
        await until(()=>h.ctx.apexTemporaryDirectories.records.get(id))
        const record=h.ctx.apexTemporaryDirectories.records.get(id)
        assert.notEqual(record.path,privateA);assert.notEqual(record.path,privateB)
        assert.equal(record.workspace,durable)
      }
      assert.equal(new Set([...h.ctx.apexTemporaryDirectories.records.values()].map(r=>r.path)).size,4)
    })
    await check('cancelled PTC stops its owned process and keeps session files available for a later turn', async () => {
      const file=join(privateA,'cancel-pid'),controller=new AbortController()
      const pending=run(h,a,`await(await import('node:fs/promises')).writeFile(${JSON.stringify(file)},String(process.pid));await new Promise(()=>{});`,controller.signal)
      await until(()=>existsSync(file));const pid=Number(await readFile(file,'utf8'));controller.abort(new Error('fixed test cancellation'))
      assert.equal((await pending).isError,true);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert(existsSync(privateA))
    })
    await check('background jobs retain private temp across turns and stop through their native owned job id', async () => {
      const file=join(privateA,'background-pid')
      const code=`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`
      const job=result(await run(h,a,bash(quote(process.execPath)+' -e '+quote(code),{run_in_background:true})))
      assert.equal(job.kind,'background');assert.equal(typeof job.jobId,'string')
      await until(()=>existsSync(file));const pid=Number(await readFile(file,'utf8'))
      try {
        await h.turn(a,'Reply without tools while the test-owned background job remains active.')
        process.kill(pid,0);assert.equal(temp(a),privateA)
      } finally {result(await run(h,a,`return await tools.job_kill(${JSON.stringify({job_id:job.jobId})});`))}
      await until(()=>{try{process.kill(pid,0);return false}catch(e){assert.equal(e.code,'ESRCH');return true}})
      assert(existsSync(privateA))
    })
    await check('timeouts stay explicit and private container deletion remains denied', async () => {
      const body=`console.log(process.pid);setInterval(()=>{},1000)`
      const out=result(await run(h,a,`return await tools.apex_run_script(${JSON.stringify({command:quote(process.execPath)+' --input-type=module',script:body,description:'Fixed timeout fixture',timeoutMs:150})});`))
      assert.equal(out.timedOut,true)
      const pid=Number(out.stdout.text.trim());assert(pid>0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
      const denied=result(await run(h,a,`const fs=await import('node:fs/promises');const out=[];for(const path of ${JSON.stringify([privateA,container])}){try{await fs.rm(path,{recursive:true,force:true});out.push(false)}catch(e){out.push(['EPERM','EACCES'].includes(e.code))}};return out;`))
      assert.deepEqual(denied,[true,true]);assert(existsSync(privateA));assert(existsSync(privateB))
    })
    await check('closing the component Host drains a live owned process before deleting its private storage', async () => {
      const file=join(privateA,'close-pid')
      const pending=run(h,a,`await(await import('node:fs/promises')).writeFile(${JSON.stringify(file)},String(process.pid));await new Promise(()=>{});`)
      await until(()=>existsSync(file));const pid=Number(await readFile(file,'utf8'))
      await h.ctx.sessionPersistence.flush()
      const reader=await h.ctx.sessionPersistence.open(a.session.id,'read')
      const saved={header:reader.header,...await reader.read()};await reader.close()
      await h.close();assert.equal((await pending).isError,true);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(existsSync(container),false)
      h=await nativeHarness()
      const writer=await h.ctx.sessionPersistence.create(saved.header);await writer.append(saved.events);await writer.close()
      a=await h.resume('temporary-lead')
      const after=temp(a);assert.notEqual(after,privateA);assert.equal(existsSync(privateA),false)
      await h.turn(a,'Reply briefly without tools.')
      assert(JSON.stringify(h.adapter.requests.at(-1)).includes(after))
      report.observations.push({kind:'restart',oldDirectoryRemoved:true,newDirectory:after})
    })
    await check('the explicit rollback setting restores native temporary writes without allocating private directories', async () => {
      await h.close();h=await nativeHarness(undefined,{privateTemp:false});a=await h.create('temporary-rollback','apex-v1',durable)
      const file=join(external,'rollback.txt')
      result(await run(h,a,`return await tools.write(${JSON.stringify({file_path:file,content:'rollback'})});`))
      assert.equal(await readFile(file,'utf8'),'rollback');assert.equal(h.ctx.apexTemporaryDirectories.root,undefined)
      await h.turn(a,'Reply without tools.');assert(!JSON.stringify(h.adapter.requests.at(-1)).includes('APEX temporary directory for this session:'))
    })
    assert.equal(process.env.DSH_HOME,oldHome)
  } finally {
    await h.close()
    await rm(external,{recursive:true,force:false});await rm(durable,{recursive:true,force:false})
    if(process.env.APEX_TEMPORARY_REPORT)await writeFile(process.env.APEX_TEMPORARY_REPORT,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  }
})
