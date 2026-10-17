export const name = 'apex-file-tools'
export const inject = ['loader', 'tools', 'fs', 'systemPrompt']

export async function apply(ctx, config) {
  const native = await ctx.root.loader.import('@deepseek-ai/dsh-tool-fs')
  // alpha.2's nested attachment injection cannot inherit an isolated fs dependency.
  // Bind this one service in the local context; its owner still tracks fs reloads.
  native.apply(ctx.extend({ fs: ctx.fs }), native.Config(config))
}
