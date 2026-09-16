import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const harnessRoot = resolve(process.env.DSH_CHECKOUT
  ?? join(pluginRoot, '../../deepseek-harness/source'))
export const harnessAvailable = existsSync(join(harnessRoot, 'packages/core/agent-loop/lib/index.js'))
const resolvers = [
  'apps/cli', 'packages/bundle/base', 'packages/bundle/web-app', 'packages/preset/agent-presets',
  'packages/shell/tool-bash', 'packages/core/tools',
].map(path => createRequire(join(harnessRoot, path, 'package.json')))

function resolvedModule(name) {
  for (const resolver of resolvers) {
    try { return resolver.resolve(name) } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`Native Harness dependency not found: ${name}; build the v0.1.6-alpha.1 checkout first`)
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

/** Real services and Loader; only the model's responses are scripted. No API adapter is mounted. */
export async function nativeHarness(script = () => textResponse('done'), {
  spillBytes = 50_000, emptyRoster = false, shippedPresets = false, preset = 'apex-v1', model = 'deepseek-flash',
  presetRoot = join(pluginRoot, 'presets'),
  privateTemp,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'apex-v1-native-'))
  const cwd = join(root, 'workspace')
  const liveHome = process.env.DSH_HOME ?? resolve(harnessRoot, '../data')
  const profile = join(liveHome, 'profiles/web')
  if (!existsSync(join(profile, 'node_modules/dsh-apex'))) throw new Error('Native component checks require the existing live profile dependency resolver')
  const fibers = []
  const handles = []
  const env = Object.fromEntries(['DSH_CWD', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR'].map(key => [key, process.env[key]]))
  process.env.DSH_CWD = cwd
  process.env.DSH_AGENTS_HOME = join(root, 'user-agents')
  process.env.DSH_BUNDLED_SKILL_DIR = join(root, 'bundled-skills')
  await mkdir(cwd)
  const { Context } = await native('cordis')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(profile).href + '/'
  async function mount(name, config) {
    const replacement = { 'dsh-subprocess-local': 'temporary-runtime', 'dsh-sandbox-local': 'temporary-sandbox', 'dsh-fs-sandbox': 'temporary-fs' }[name]
    const mod = replacement ? await import(pathToFileURL(join(pluginRoot, 'presets/apex-v1', replacement + '.mjs'))) : await native(name)
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
    // Use the existing profile only for module resolution. Component state stays in disposable fixtures.
    const fixturePresets = presetRoot
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
      ['dsh-ptc-runtime-node', { timeoutMs: 20_000 }],
      ['dsh-subprocess-local', privateTemp === undefined ? undefined : { privateTemp }], ['dsh-sandbox-local'],
      ['dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }],
      [process.platform === 'win32' ? 'dsh-pwsh-sandbox' : 'dsh-bash-sandbox'],
      ['dsh-user-approval', { policy: 'never' }], ['dsh-shell-env'],
      ['dsh-spill-local'], ['dsh-spill-policy', { maxInlineBytes: spillBytes }],
      ['dsh-session-checkpoint-policy'],
      ['dsh-fs-observation-policy'], ['dsh-fs-sandbox', { cwd }],
      ['dsh-skill'], ['dsh-jobs-local'], ['dsh-goal'], ['dsh-user-questions'],
      ['dsh-web'], ['dsh-commands'], ['dsh-subagent'],
      ['dsh-subagent-spawn-in-process', { providerName: 'spawn' }],
      ['dsh-subagent-fork-in-process', { providerName: 'fork' }],
      ['dsh-experimental-agent-team'],
      ...shippedPresets ? [['dsh-tool-subagent/model-selection-settings']] : [],
      ['dsh-agent-presets', {
        default: preset, roots: [{ path: emptyRoster ? join(root, 'preset-install') : fixturePresets, trust: 'user' }],
        includeShippedRoot: shippedPresets, includeUserRoot: false,
      }],
    ]) await mount(name, config)

    const { LlmAdapter, createUserMessage } = await native('dsh-llm')
    class ScriptedAdapter extends LlmAdapter {
      requests = []
      async resolveModel(provider, id) {
        return { provider, id, name: id,
          inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
          reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }
      }
      async * stream(options) {
        this.requests.push(options)
        for (const chunk of await script(options, this.requests.length)) {
          options.signal?.throwIfAborted()
          yield chunk
        }
      }
    }
    const adapter = new ScriptedAdapter()
    const agentOptions = { provider: 'deepseek-official', model, reasoningEffort: 'max' }
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    return {
      ctx, root, cwd, adapter, close,
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
      async turn(agent, text) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
