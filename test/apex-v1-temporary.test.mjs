import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { harnessAvailable, native, nativeHarness } from './helpers/harness-v1.mjs'
import { Config as TemporaryConfig, apply as applyTemporaryRuntime } from '../presets/apex-v1/temporary-runtime.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const report = { modelApiCalls: 0, checks: [], observations: [] }
async function run(h, agent, code, signal = new AbortController().signal, extra = {}) {
  return h.runCode(agent, code, { signal, description: 'Fixed private temporary storage integration check', ...extra })
}
function result(reply) { assert.equal(reply.isError, false, reply.error?.message); return reply.value.result }
const bash = (command, extra = {}) => `return await tools.bash(${JSON.stringify({ command, description: 'Fixed integration fixture', ...extra })});`
const script = code => `return await tools.apex_run_script(${JSON.stringify({ command: quote(process.execPath) + ' --input-type=module', script: code, description: 'Fixed integration fixture' })});`
async function until(check) {
  for (let i = 0; i < 250; i++) { const value = await check(); if (value) return value; await delay(20) }
  assert.fail('Fixture did not settle within five seconds')
}
async function readyPid(file) {
  return until(async () => {
    let text
    try { text = await readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
    // File creation precedes writeFile completion; an empty file must never become process group 0.
    if (text === '') return false
    const pid = Number(text)
    assert.ok(/^\d+$/.test(text) && Number.isSafeInteger(pid) && pid > 0, 'Expected a published positive PID')
    return pid
  })
}

test('PID readiness waits for contents and rejects a process-group sentinel', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apex-pid-ready-')); t.after(() => rm(root, { recursive: true }))
  const file = join(root, 'pid')
  await writeFile(file, '')
  let resolved = false
  const waiting = readyPid(file).then(pid => { resolved = true; return pid })
  await delay(40)
  assert.equal(resolved, false)
  await writeFile(file, String(process.pid))
  assert.equal(await waiting, process.pid)
  await writeFile(file, '0')
  await assert.rejects(readyPid(file), /Expected a published positive PID/)
})

test('workspace-only configuration is explicit and cannot disable its enforcing runtime', () => {
  assert.deepEqual(TemporaryConfig.parse({}), { privateTemp: true, workspaceOnly: false })
  assert.deepEqual(TemporaryConfig.parse({ workspaceOnly: true }), { privateTemp: true, workspaceOnly: true })
  assert.throws(() => TemporaryConfig.parse({ privateTemp: false, workspaceOnly: true }), /requires privateTemp/)
  assert.throws(() => TemporaryConfig.parse({ workspaceOnly: 'true' }))
  assert.throws(() => TemporaryConfig.parse({ workspaceOnly: true, unknown: true }))
})

test('workspace-only path selection is explicit and fail-closed', { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }, async t => {
  const owned = await realpath(await mkdtemp(join(tmpdir(), 'apex-selected-workspace-')))
  const selected = join(owned, 'selected'), sibling = selected + '-other'
  await mkdir(selected); await mkdir(sibling)
  let h
  t.after(async () => { await h?.close(); await rm(owned, { recursive: true }) })
  assert.deepEqual(TemporaryConfig.parse({ workspaceOnly: [selected] }), { privateTemp: true, workspaceOnly: [selected] })
  for (const workspaceOnly of [[], ['relative'], [selected + '\0'], [true]]) {
    assert.throws(() => TemporaryConfig.parse({ workspaceOnly }))
  }
  assert.throws(() => TemporaryConfig.parse({ privateTemp: false, workspaceOnly: [selected] }))
  h = await nativeHarness(undefined, { workspaceOnly: [selected] })
  const a = await h.create('selected', 'apex-v1', selected)
  const b = await h.create('unselected', 'apex-v1', sibling)
  const temp = agent => h.apexRuntime.apexTemporaryDirectories.directory(h.ctx.sandboxPolicy.resolve({ session: agent.session }))
  assert.equal(temp(a).workspaceOnly, true); assert.equal(temp(b).workspaceOnly, false)
  assert.equal(result(await run(h, a, "return (await import('node:os')).tmpdir();")), selected)
  assert.equal(result(await run(h, b, "return (await import('node:os')).tmpdir();")), temp(b).path)
  for (const [agent, expected] of [[a, true], [b, false]]) {
    const target = join(temp(agent).path, 'probe')
    assert.equal((await run(h, agent, `return await tools.write(${JSON.stringify({ file_path: target, content: 'owned' })});`)).isError, expected)
    assert.equal(existsSync(target), !expected)
  }
  await h.dispose(a)
  const resumed = await h.resume('selected')
  assert.equal(temp(resumed).workspaceOnly, true)
  assert.equal(temp(await h.create('selected-fresh', 'apex-v1', selected)).workspaceOnly, true)
  // A changed configured root must not silently select the wider default,
  // including before a new session has allocated its first directory record.
  await rename(selected, selected + '-saved'); await mkdir(selected)
  const changed = await h.create('selected-changed', 'apex-v1', selected)
  assert.throws(() => temp(changed), /identity changed/)
  await rm(selected, { recursive: true }); await rename(selected + '-saved', selected)
  await h.close(); h = undefined
  await symlink(selected, join(owned, 'alias'))
  await assert.rejects(applyTemporaryRuntime({}, { workspaceOnly: [join(owned, 'alias')] }), /canonical directories/)
  await assert.rejects(applyTemporaryRuntime({}, { workspaceOnly: [join(owned, 'missing')] }), /ENOENT/)
})

test('configured APEX workspace-only writes use real providers across tools and session recovery', { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 30000 }, async t => {
  const owned = await realpath(await mkdtemp(join(tmpdir(), 'apex-workspace-only-')))
  const durable = join(owned, 'workspace'); await mkdir(durable)
  let h, a
  t.after(async () => { await h?.close(); await rm(owned, { recursive: true }) })
  h = await nativeHarness(undefined, { shippedPresets: true, workspaceOnly: true })
  a = await h.create('workspace-lead', 'apex-v1', durable)
  const other = await h.create('workspace-other', 'apex-v1', durable)
  const official = await h.create('workspace-official', 'ptc', durable)
  const policy = agent => h.ctx.sandboxPolicy.resolve({ session: agent.session })
  const temp = agent => h.apexRuntime.apexTemporaryDirectories.directory(policy(agent))
  const privateA = temp(a).path, privateB = temp(other).path
  const outside = await realpath(h.cwd)
  const prefixSibling = durable + '-other'
  await mkdir(prefixSibling)
  await symlink(outside, join(durable, 'escape'))
  const sentinels = [join(outside, 'sentinel'), join(privateA, 'sentinel'), join(privateB, 'sentinel'), join(prefixSibling, 'sentinel')]
  for (const path of sentinels) await writeFile(path, 'preserved')
  const targets = [...sentinels, join(durable, 'escape/sentinel'), durable + '/' + relative(durable, join(privateA, 'sentinel'))]
  const surfaces = [
    code => code + 'return value;',
    code => bash(quote(process.execPath) + ' --input-type=module -e ' + quote(code + 'console.log(JSON.stringify(value));')),
    code => script(code + 'console.log(JSON.stringify(value));'),
    code => `return await tools.apex_run_script(${JSON.stringify({ argv: [process.execPath, '--input-type=module'], script: code + 'console.log(JSON.stringify(value));', description: 'Literal argv workspace check' })});`,
  ]
  async function programs(code, expected) {
    for (let i = 0; i < surfaces.length; i++) {
      const out = result(await run(h, a, surfaces[i](code)))
      if (i !== 0) { assert.equal(out.exitCode, 0, out.stderr.text); assert.equal(out.sandbox.enforcement, 'full') }
      assert.deepEqual(i === 0 ? out : JSON.parse(out.stdout.text), expected)
    }
  }
  await t.test('temporary fixtures and published guidance work inside the workspace', async () => {
    await programs(`const fs=await import('node:fs/promises'),os=await import('node:os');const root=os.tmpdir();
      const dir=await fs.mkdtemp(root+'/fixture-');let text;try{await fs.writeFile(dir+'/value','ok');text=await fs.readFile(dir+'/value','utf8')}finally{await fs.rm(dir,{recursive:true})};const value={root,text};`, { root: durable, text: 'ok' })
    const out = result(await run(h, a, bash('temp=$(mktemp -d "${TMPDIR%/}/apex.XXXXXX") || exit 1; printf "%s\\n" "$temp"; rmdir "$temp"')))
    assert.equal(out.exitCode, 0); assert.equal(out.stdout.text.trim().slice(0, durable.length + 1), durable + '/')
    assert.equal(existsSync(out.stdout.text.trim()), false)
    await h.turn(a, 'Reply without tools.')
    const request = JSON.stringify(h.adapter.requests.at(-1))
    assert.ok(request.includes('APEX workspaceOnly is enabled.'))
    assert.ok(!request.includes('APEX temporary directory for this session:'))
  })
  await t.test('workspace writes permit fixed-path preclear; exclusive preparation preserves existing data', async () => {
    const fixed = join(durable, '.example-tmp'), sentinel = join(fixed, 'sentinel')
    await mkdir(fixed); await writeFile(sentinel, 'pre-existing fixture')
    const unsafe = result(await run(h, a, bash('rm -rf .example-tmp && mkdir .example-tmp')))
    assert.equal(unsafe.exitCode, 0)
    assert.equal(existsSync(sentinel), false, 'workspaceOnly constrains location, not ownership of workspace children')
    await writeFile(sentinel, 'preserved')
    const denied = result(await run(h, a, bash('mkdir .example-tmp || exit 1; printf bad > should-not-run-after-collision')))
    assert.equal(denied.exitCode, 1)
    assert.equal(existsSync(join(durable, 'should-not-run-after-collision')), false)
    const safe = result(await run(h, a, bash('apex_tmp=$(mktemp -d "./.example-tmp.XXXXXX") || exit 1; printf own > "$apex_tmp/own" || exit 1; printf "%s\\n" "$apex_tmp"; rm -r "$apex_tmp"')))
    assert.equal(safe.exitCode, 0, safe.stderr.text)
    const created = safe.stdout.text.trim()
    assert.match(created, /^\.\/\.example-tmp\.[^/]+$/)
    assert.equal(existsSync(join(durable, created)), false)
    assert.equal(await readFile(sentinel, 'utf8'), 'preserved')
  })
  await t.test('PTC, Bash and stdin reject outside creation, overwrite and unlink', async () => {
    await programs(`const fs=await import('node:fs/promises');const value=[];for(const path of ${JSON.stringify(targets)}){
      for(const op of [()=>fs.writeFile(path+'.new','bad'),()=>fs.writeFile(path,'bad'),()=>fs.unlink(path)]){
        try{await op();value.push(false)}catch(e){value.push(['EPERM','EACCES'].includes(e.code))}}};`, targets.flatMap(() => [true, true, true]))
    for (const path of sentinels) { assert.equal(await readFile(path, 'utf8'), 'preserved'); assert.equal(existsSync(path + '.new'), false) }
  })
  await t.test('file tools share the same roots and rejected preparation stops downstream work', async () => {
    const file = join(durable, 'tool.txt')
    result(await run(h, a, `await tools.write(${JSON.stringify({ file_path: file, content: 'before' })});return await tools.edit(${JSON.stringify({ file_path: file, old_string: 'before', new_string: 'after' })});`))
    assert.equal(await readFile(file, 'utf8'), 'after')
    for (const path of targets) {
      const target = await h.apexRuntime.fs.resolve(path)
      await assert.rejects(h.apexRuntime.fs.writeText(target, 'bad', undefined, undefined, policy(a)), { code: 'FS_SANDBOX_DENIED' })
      for (const code of [
        `await tools.read(${JSON.stringify({ file_path: path })});return await tools.write(${JSON.stringify({ file_path: path, content: 'bad' })});`,
        `await tools.read(${JSON.stringify({ file_path: path })});return await tools.edit(${JSON.stringify({ file_path: path, old_string: 'preserved', new_string: 'bad' })});`,
      ]) assert.equal((await run(h, a, code)).isError, true)
    }
    for (const path of sentinels) assert.equal(await readFile(path, 'utf8'), 'preserved')
    const out = result(await run(h, a, bash('temp=$(mktemp -d ' + quote(privateA + '/apex.XXXXXX') + ') || exit 1; printf bad > should-not-exist')))
    assert.equal(out.exitCode, 1); assert.equal(existsSync(join(durable, 'should-not-exist')), false)
  })
  await t.test('official PTC and explicit full-access keep their native boundary', async () => {
    const file = join(outside, 'official.txt')
    result(await run(h, official, `return await tools.write(${JSON.stringify({ file_path: file, content: 'official' })});`))
    assert.equal(await readFile(file, 'utf8'), 'official')
    const { setSandboxMode } = await native('dsh-sandbox-policy')
    setSandboxMode(a.session, 'read-only')
    try {
      assert.equal((await run(h, a, `await(await import('node:fs/promises')).writeFile(${JSON.stringify(join(durable, 'read-only'))},'bad');`)).isError, true)
      assert.equal((await run(h, a, `return await tools.write(${JSON.stringify({ file_path: join(durable, 'read-only-file'), content: 'bad' })});`)).isError, true)
      assert.equal(existsSync(join(durable, 'read-only-file')), false)
    } finally { setSandboxMode(a.session, 'workspace-write') }
    setSandboxMode(a.session, 'danger-full-access')
    try {
      result(await run(h, a, `await tools.read(${JSON.stringify({ file_path: file })});return await tools.write(${JSON.stringify({ file_path: file, content: 'explicit' })});`))
      assert.equal(await readFile(file, 'utf8'), 'explicit')
      assert.ok(JSON.stringify(h.adapter.requests.at(-1)).includes('workspaceOnly restriction is also inactive'))
    } finally { setSandboxMode(a.session, 'workspace-write') }
    assert.equal((await run(h, a, `return await tools.write(${JSON.stringify({ file_path: file, content: 'bad' })});`)).isError, true)
  })
  await t.test('resumed and fresh or fork sessions use the configured workspace policy', async () => {
    await h.dispose(a); a = await h.resume('workspace-lead')
    assert.equal(temp(a).path, privateA); assert.equal(temp(a).workspaceOnly, true)
    for (const context of ['fresh', 'fork']) {
      const out = result(await run(h, a, `return await tools.spawn_teammate(${JSON.stringify({ name: context, description: 'Fixed workspace policy check', prompt: 'Reply ready without tools.', context })});`))
      const member = h.ctx.agentTeams.listMembers(a).find(row => row.name === out.member.target)
      assert.ok(member)
      const record = await until(() => h.apexRuntime.apexTemporaryDirectories.records.get(member.id))
      assert.equal(record.workspaceOnly, true); assert.equal(record.workspace, durable)
    }
  })
  await t.test('Host restart with the same configuration preserves workspace fixtures and policy', async () => {
    const marker = join(durable, 'retained-fixture'); await writeFile(marker, 'keep')
    await h.ctx.sessionPersistence.flush()
    const reader = await h.ctx.sessionPersistence.open(a.session.id, 'read')
    const saved = { header: reader.header, ...await reader.read() }; await reader.close()
    await h.close(); assert.equal(existsSync(privateA), false); assert.equal(await readFile(marker, 'utf8'), 'keep')
    h = await nativeHarness(undefined, { workspaceOnly: true })
    const writer = await h.ctx.sessionPersistence.create(saved.header); await writer.append(saved.events); await writer.close()
    a = await h.resume('workspace-lead')
    assert.equal(temp(a).workspaceOnly, true)
    assert.equal(result(await run(h, a, "return (await import('node:os')).tmpdir();")), durable)
    assert.equal((await run(h, a, `return await tools.write(${JSON.stringify({ file_path: join(temp(a).path, 'denied'), content: 'bad' })});`)).isError, true)
    await h.close(); assert.equal(await readFile(marker, 'utf8'), 'keep')
  })
})

test('native sessions use private temporary storage across execution and lifecycle paths', { skip: !harnessAvailable || process.platform !== 'darwin', timeout: 60000 }, async t => {
  const oldHome = process.env.DSH_HOME
  const external = await realpath(await mkdtemp(join(tmpdir(), 'apex-temporary-control-')))
  const durable = await realpath(await mkdtemp(join(tmpdir(), 'apex-temporary-workspace-')))
  let h = await nativeHarness(undefined, { shippedPresets: true })
  let a = await h.create('temporary-lead', 'apex-v1', durable)
  const b = await h.create('temporary-other', 'apex-v1', durable)
  const official = await h.create('temporary-official', 'ptc', durable)
  const policy = agent => h.ctx.sandboxPolicy.resolve({ session: agent.session })
  const temp = agent => h.apexRuntime.apexTemporaryDirectories.directory(policy(agent)).path
  const privateA = temp(a), privateB = temp(b), container = h.apexRuntime.apexTemporaryDirectories.root.path
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
      const file=join(durable,'version.txt'), target=await h.apexRuntime.fs.resolve(file)
      const started=performance.now()
      const created=await h.apexRuntime.fs.writeText(target,'before\r\n',{kind:'createIfAbsent'},undefined,policy(a))
      const first=await h.apexRuntime.fs.editText(target,{oldString:'before',newString:'after',replaceAll:false},{version:created.version},undefined,policy(a))
      assert.equal(await readFile(file,'utf8'),'after\r\n')
      await assert.rejects(h.apexRuntime.fs.writeText(target,'stale',{kind:'replaceIfVersion',version:created.version},undefined,policy(a)),{code:'FS_STALE_VERSION'})
      const writes=await Promise.allSettled(['one','two'].map(text=>h.apexRuntime.fs.writeText(target,text,{kind:'replaceIfVersion',version:first.version},undefined,policy(a))))
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
      const wrapper=join(external,'race-provider.mjs'), originalSpawn=h.apexRuntime.subprocess.spawn.bind(h.apexRuntime.subprocess)
      let intercepted=0
      const original = t.mock.method(h.apexRuntime.subprocess,'spawn',function(spec){
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
        const current=await h.apexRuntime.fs.resolve(target)
        await assert.rejects(h.apexRuntime.fs.writeText(current,'must-not-escape',undefined,undefined,policy(a)))
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
        const target=out.member.target
        const member=h.ctx.agentTeams.listMembers(a).find(row=>row.name===target)
        assert.ok(member,`spawned teammate ${target} must be present in the native roster`)
        const id=member.id
        assert.equal(typeof id,'string');assert.ok(id.length>0)
        await until(()=>h.apexRuntime.apexTemporaryDirectories.records.get(id))
        const record=h.apexRuntime.apexTemporaryDirectories.records.get(id)
        assert.notEqual(record.path,privateA);assert.notEqual(record.path,privateB)
        assert.equal(record.workspace,durable)
      }
      assert.equal(new Set([...h.apexRuntime.apexTemporaryDirectories.records.values()].map(r=>r.path)).size,4)
    })
    await check('cancelled PTC stops its owned process and keeps session files available for a later turn', async () => {
      const file=join(privateA,'cancel-pid'),controller=new AbortController()
      const pending=run(h,a,`await(await import('node:fs/promises')).writeFile(${JSON.stringify(file)},String(process.pid));await new Promise(()=>{});`,controller.signal)
      const pid=await readyPid(file);controller.abort(new Error('fixed test cancellation'))
      assert.equal((await pending).isError,true);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert(existsSync(privateA))
    })
    await check('background jobs retain private temp across turns and stop through their native owned job id', async () => {
      const file=join(privateA,'background-pid')
      const code=`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`
      const job=result(await run(h,a,bash(quote(process.execPath)+' -e '+quote(code),{run_in_background:true})))
      assert.equal(job.kind,'background');assert.equal(typeof job.jobId,'string')
      const pid=await readyPid(file)
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
      const pid=await readyPid(file)
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
      assert.equal(await readFile(file,'utf8'),'rollback');assert.equal(h.apexRuntime.apexTemporaryDirectories.root,undefined)
      await h.turn(a,'Reply without tools.');assert(!JSON.stringify(h.adapter.requests.at(-1)).includes('APEX temporary directory for this session:'))
    })
    assert.equal(process.env.DSH_HOME,oldHome)
  } finally {
    await h.close()
    await rm(external,{recursive:true,force:false});await rm(durable,{recursive:true,force:false})
    if(process.env.APEX_TEMPORARY_REPORT)await writeFile(process.env.APEX_TEMPORARY_REPORT,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  }
})
