import { z } from 'zod'

export const name = 'apex-ptc-binding'
export const inject = ['loader', 'ptcRuntime', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']
export const Config = z.object({ target: z.enum(['apexNativePtcExecution', 'apexPtcExecution']) }).strict()

export async function apply(ctx, config) {
  let provider = ctx
  if (config.target === 'apexPtcExecution') {
    const [{ Context }, { default: NativeRuntime }] = await Promise.all([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-ptc-runtime-node',
    ].map(name => ctx.root.loader.import(name)))
    // Reuse the selected native provider's validated config, including user overrides.
    const realm = ctx[Context.isolate].ptcRuntime
    const fibers = [...ctx.registry.get(NativeRuntime)?.fibers ?? []]
      .filter(fiber => fiber.ctx[Context.isolate].ptcRuntime === realm)
    if (fibers.length !== 1) throw new Error('APEX requires one native Node PTC provider in its source realm')
    provider = ctx.isolate('ptcRuntime')
    await provider.plugin(NativeRuntime, fibers[0].config).await()
  }
  const runtime = provider.get('ptcRuntime')
  if (runtime === undefined) throw new Error('APEX PTC binding requires an active native runtime')
  // A plain holder preserves the provider's caller context across the Host router.
  ctx.provide(config.target, { runtime: () => runtime })
}
