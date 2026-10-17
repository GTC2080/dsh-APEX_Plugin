import { z } from 'zod'

export const name = 'apex-read-only-review'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections', 'loader']
export const Config = z.object({ backgroundOnly:z.boolean().default(false) }).strict().prefault({})

export async function apply(ctx, input = {}) {
  const { backgroundOnly } = Config.parse(input)
  if (backgroundOnly) {
    ctx.tools.guard(exec => exec.name === 'apex_review' && exec.arguments?.run_in_background !== true
      ? 'Call apex_review with run_in_background:true, then collect it with job_output in separate requests.' : undefined)
    ctx.systemPrompt.section({name:'apex:background-review',order:590,
      text:'When requesting optional apex_review, set run_in_background:true. Collect its native job result with job_output in separate requests of at most 60000 ms; do not wait in a loop inside run_code. Include the completed review before delivery, or report cancellation and missing evidence.'})
  }
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
      provider: 'spawn', toolName: 'apex_review', enableRunInBackground: backgroundOnly,
      backgroundMode: 'one-shot', toolFilter: { allow },
      persona: 'You are an independent read-only reviewer. Inspect the supplied files and images against the user\'s requirements; do not edit, run commands or delegate. For each material finding, cite the location or image and supporting evidence, explain its impact, and give the smallest counterexample or check that could confirm or refute it. Distinguish observations from static inferences; proposed checks have not been executed by you. Report uncertainty or no supported findings without inventing defects. Do not claim a visual pass merely because an image loaded.',
    }),
    agentOptions: { apexReadOnlyReview: true },
  })
}
