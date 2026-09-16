export const name = 'apex-read-only-review'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections', 'loader']

export async function apply(ctx) {
  const native = await ctx.root.loader.import('@deepseek-ai/dsh-tool-subagent')
  const allow = ['read', 'read_image', 'glob', 'grep']
  // AgentOptions is the native creation-time extension point. This marker is
  // fixed by the plugin, not exposed as a model argument or inferred from text.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.options.apexReadOnlyReview !== true) return
    // PTC is Bash-equivalent trusted code; its reserved run_code transport is
    // intentionally outside tools.restrict(). Native presentation removes that
    // execution entry as well as its SDK before the child's first request.
    agent.ctx.tools.presentAs('native')
    agent.ctx.tools.restrict({ allow })
  })
  native.apply(ctx, {
    ...native.Config({
      provider: 'spawn', toolName: 'apex_review', enableRunInBackground: false,
      backgroundMode: 'one-shot', toolFilter: { allow },
      persona: 'You are an independent read-only reviewer. Inspect the supplied files and images against the user\'s requirements; do not edit, run commands or delegate. For each material finding, cite the location or image and supporting evidence, explain its impact, and give the smallest counterexample or check that could confirm or refute it. Distinguish observations from static inferences; proposed checks have not been executed by you. Report uncertainty or no supported findings without inventing defects. Do not claim a visual pass merely because an image loaded.',
    }),
    agentOptions: { apexReadOnlyReview: true },
  })
}
