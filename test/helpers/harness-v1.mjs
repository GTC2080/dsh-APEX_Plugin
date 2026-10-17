import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const harnessRoot = resolve(process.env.DSH_CHECKOUT
  ?? join(pluginRoot, '../../deepseek-harness/source'))
export const harnessAvailable = existsSync(join(harnessRoot, 'packages/core/agent-loop/lib/index.js'))
const resolvers = [
  'apps/cli', 'packages/bundle/base', 'packages/bundle/web-app',
  'packages/preset/agent-preset-registry', 'packages/preset/agent-preset',
  'packages/shell/tool-bash', 'packages/core/tools',
].map(path => createRequire(join(harnessRoot, path, 'package.json')))

function resolvedModule(name) {
  for (const resolver of resolvers) {
    try { return resolver.resolve(name) } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`Native Harness dependency not found: ${name}; build the matching Harness checkout first`)
}

export async function native(name) {
  return import(pathToFileURL(resolvedModule(`@deepseek-ai/${name}`)).href)
}

/** Read the effective V3 system message without inventing a legacy request.system field. */
export function systemText(request) {
  const message = request.messages.findLast(message => message.role === 'system')
  if (message === undefined) throw new Error('Expected a logged system message in the native request')
  return message.content.map(block => {
    if (block.type !== 'text') throw new Error('Expected text in the native system message')
    return block.text
  }).join('\n')
}

export function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolResponse(id, name, args) {
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function loadPresetDeclaration(ctx, file, { patch = false } = {}) {
  const { entryListSchema, applyEntryPatches } = await native('cordis-plugin-include')
  const { load } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
  const rows = load(await readFile(file, 'utf8'), { schema: entryListSchema })
  const entries = patch ? applyEntryPatches([], rows, message => { throw new Error(message) }) : rows
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`Preset declaration is empty: ${file}`)
  await ctx.loader.root.update([...ctx.loader.root.data, ...entries])
}

async function loadPresetDeclarations(ctx, { presetRoot, preset, emptyRoster, shippedPresets }) {
  if (emptyRoster) return
  if (shippedPresets) {
    const webPresets = join(harnessRoot, 'packages/bundle/web-app/presets')
    for (const id of ['standard', 'ptc', 'minimal']) {
      await loadPresetDeclaration(ctx, join(webPresets, `${id}.patch.yml`), { patch: true })
    }
  }
  const composition = join(presetRoot, preset, 'agent.cordis.yml')
  if (existsSync(composition)) await loadPresetDeclaration(ctx, composition, { patch: true })
}

/** Register the candidate declaration in an otherwise empty native fixture. */
export async function loadApexPresetFixture(ctx, presetRoot = join(pluginRoot, 'presets')) {
  const composition = join(presetRoot, 'apex-v1', 'agent.cordis.yml')
  await loadPresetDeclaration(ctx, composition, { patch: true })
}

/** Real services and Loader; only the model's responses are scripted. No API adapter is mounted. */
export async function nativeHarness(script = () => textResponse('done'), {
  spillTokens = 12_500, emptyRoster = false, shippedPresets = false, preset = 'apex-v1', model = 'deepseek-flash',
  presetRoot = join(pluginRoot, 'presets'),
  workspaceRoot,
  privateTemp,
  workspaceOnly,
  subagentConfig,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'apex-v1-native-'))
  const cwd = workspaceRoot ?? join(root, 'workspace')
  const fibers = []
  const handles = []
  const loaderEntries = new Map()
  const env = Object.fromEntries(['DSH_CWD', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR'].map(key => [key, process.env[key]]))
  process.env.DSH_CWD = cwd
  process.env.DSH_AGENTS_HOME = join(root, 'user-agents')
  process.env.DSH_BUNDLED_SKILL_DIR = join(root, 'bundled-skills')
  await mkdir(cwd, { recursive: true })
  const { Context } = await native('cordis')
  const ctx = new Context()
  async function mount(name, config, { viaLoader = false, id = name } = {}) {
    const mod = await native(name)
    if (viaLoader) {
      const builtin = `apex-test-${name}`
      ctx.loader.builtins[builtin] = mod.default ?? mod
      const entryId = await ctx.loader.create({ id, name: `cordis:${builtin}`, config })
      const entry = ctx.loader.resolve(entryId)
      await entry.fiber.await()
      loaderEntries.set(name, entry)
      return
    }
    fibers.push(await ctx.plugin(mod.default ?? mod, config))
  }
  async function close() {
    const errors = []
    for (const handle of handles.splice(0).reverse()) {
      try { await handle.dispose() } catch (error) { errors.push(error) }
    }
    for (const fiber of fibers.splice(0).reverse()) {
      try { await fiber.dispose() } catch (error) { errors.push(error) }
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Native Harness fixture cleanup failed')
  }
  try {
    // Use the official runtime resolver without links or state from the live installation.
    const resolver = join(root, 'profiles/web'), modules = join(resolver, 'node_modules')
    await mkdir(modules, { recursive: true })
    await writeFile(join(resolver, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dependencies: { 'dsh-apex': 'link:' + pluginRoot },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-apex'] } },
    }))
    await symlink(pluginRoot, join(modules, 'dsh-apex'), 'junction')
    ctx.baseUrl = pathToFileURL(resolver).href + '/'
    const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await native('dsh-app-boot')
    const installAnchor = join(harnessRoot, 'apps/cli/package.json')
    const resolution = await createRuntimeResolution({ installAnchor, home: root,
      profile: loadProfileDirectory('apex-test', resolver, installAnchor),
    })
    fibers.push(await ctx.plugin(PluginPackages, { resolution }))
    // Component state and preset declarations stay in disposable fixtures.
    await mount('cordis-plugin-loader')
    ctx.loader.builtins.include = (await native('cordis-plugin-include')).default
    ctx.loader.builtins.group = (await import(pathToFileURL(join(harnessRoot, 'vendor/group/lib/index.js')).href)).default
    for (const [name, config] of [
      ['dsh-llm'], ['dsh-session'], ['dsh-system-prompt'],
      ['dsh-tools'], ['dsh-agent'], ['dsh-session-projection'], ['dsh-token-meter'],
      ['dsh-session-persistence-jsonl', { root: join(root, 'sessions') }],
      ['dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }],
      ['dsh-attachment-local', { root: join(root, 'attachments') }],
      ['dsh-agent-loop', { agents: [] }],
      ['dsh-subprocess-local'], ['dsh-sandbox-local'],
      ['dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }],
      [process.platform === 'win32' ? 'dsh-pwsh-sandbox' : 'dsh-bash-sandbox'],
      ['dsh-user-approval', { policy: 'never' }], ['dsh-shell-env'],
      ['dsh-spill-local'], ['dsh-spill-policy', { maxInlineTokens: spillTokens }],
      ['dsh-session-checkpoint-policy'],
      ['dsh-fs-observation-policy'], ['dsh-fs-sandbox', { cwd }],
      ['dsh-skill'], ['dsh-jobs-local'], ['dsh-goal'], ['dsh-user-questions'],
      ['dsh-web'], ['dsh-commands'], ['dsh-subagent', subagentConfig],
      ['dsh-subagent-spawn-in-process', { providerName: 'spawn' }],
      ['dsh-subagent-fork-in-process', { providerName: 'fork' }],
      ['dsh-experimental-agent-team'],
      ...shippedPresets ? [['dsh-tool-subagent/model-selection-settings']] : [],
      ['dsh-agent-preset-registry', { default: preset }],
    ]) await mount(name, config, {
      viaLoader: name === (process.platform === 'win32' ? 'dsh-pwsh-sandbox' : 'dsh-bash-sandbox'),
      id: 'native-shell',
    })

    // Mount the bundle's real isolated group while keeping all native Host providers active.
    const { default: Include, entryListSchema, applyEntryPatches } = await native('cordis-plugin-include')
    const { load, dump } = createRequire(join(harnessRoot, 'vendor/include/package.json'))('js-yaml')
    const bundle = load(await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const runtimeRows = applyEntryPatches([{ id: 'ptc-runtime', name: '@deepseek-ai/dsh-ptc-runtime-node', config: { timeoutMs: 20_000 } }],
      bundle, message => { throw new Error(message) }).filter(row =>
      ['ptc-runtime', 'apex-execution-services', 'apex-native-ptc-binding', 'apex-ptc-runtime'].includes(row.id))
    const runtimeGroup = runtimeRows.find(row => row.id === 'apex-execution-services')
    if (!runtimeGroup) throw new Error('Missing isolated APEX execution group')
    if (privateTemp !== undefined || workspaceOnly !== undefined) {
      runtimeGroup.config.find(row => row.id === 'apex-temporary-runtime').config = { privateTemp, workspaceOnly }
    }
    const runtimePath = join(resolver, 'apex-runtime.yml')
    await writeFile(runtimePath, dump(runtimeRows, { schema: entryListSchema }))
    let runtimeTree
    class RuntimeTree extends Include {
      constructor(inner, config) { super(inner, config); runtimeTree = this }
    }
    fibers.push(await ctx.plugin(RuntimeTree, { path: runtimePath }))
    await runtimeTree.await()
    const runtimeCtx = runtimeTree.entries().find(entry => entry.options.id === 'apex-execution-services').ctx
    const apexRuntime = Object.fromEntries(['subprocess', 'sandbox', 'fs', 'apexTemporaryDirectories'].map(name => [name, runtimeCtx.get(name)]))

    // Preset activation must see the complete native and isolated provider roster.
    await loadPresetDeclarations(ctx, { presetRoot, preset, emptyRoster, shippedPresets })

    const { LlmAdapter, createUserMessage } = await native('dsh-llm')
    const scriptedTurns = []
    class ScriptedAdapter extends LlmAdapter {
      requests = []
      async resolveModel(provider, id) {
        return { provider, id, name: id,
          inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
          reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }
      }
      async * stream(options) {
        this.requests.push(options)
        const response = scriptedTurns.length > 0
          ? await scriptedTurns.shift()(options)
          : await script(options, this.requests.length)
        for (const chunk of response) {
          options.signal?.throwIfAborted()
          yield chunk
        }
      }
    }
    const adapter = new ScriptedAdapter()
    const agentOptions = { provider: 'deepseek-official', model, reasoningEffort: 'max' }
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    return {
      ctx, apexRuntime, root, cwd, adapter, loaderEntries, close,
      async dispose(agent) {
        const index = handles.findIndex(handle => handle.agent === agent)
        if (index === -1) throw new Error('Unknown fixture agent')
        await handles.splice(index, 1)[0].dispose()
      },
      async resume(id) {
        const handle = await ctx.agents.resume({
          resumeSessionId: id, agentOptions,
          setup: async (agentCtx, agent) => void await ctx.agentPresets.mount(agentCtx,
            ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? preset),
        })
        handles.push(handle)
        return handle.agent
      },
      async create(id = 'apex-parent', presetId = preset, workspace = cwd) {
        const handle = await ctx.agents.create({
          sessionId: id, meta: { cwd: workspace, agentPreset: presetId },
          agentOptions,
          setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, presetId),
        })
        handles.push(handle)
        return handle.agent
      },
      async turn(agent, text, signal) {
        const abort = () => agent.cancel({ kind: 'user' })
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        try { await agent.whenIdle() }
        finally { signal?.removeEventListener('abort', abort) }
      },
      async runCode(agent, code, { signal, description = 'Native fixture run_code', ...extra } = {}) {
        const callId = `fixture-run-code-${adapter.requests.length}-${Date.now()}`
        const start = agent.session.seq
        scriptedTurns.push(() => toolResponse(callId, 'run_code', { code, description, ...extra }))
        await this.turn(agent, 'Run the scripted fixture check.', signal)
        const result = agent.session.snapshotEvents(start).findLast(event =>
          event.type === 'tool/result' && event.data.message.toolCallId === callId)
        if (result === undefined) return { isError: true, error: { message: 'run_code produced no result' } }
        const content = result.data.message.content
        const text = content.find(block => block.type === 'text')?.text
        if (result.data.message.isError) return { isError: true, error: { message: text ?? 'run_code failed' } }
        let value
        try { value = JSON.parse(text ?? 'null') } catch { value = text }
        return { isError: false, value: { result: value } }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
