import { isAbsolute, resolve } from 'node:path'
import { registerTool } from './tools.mjs'

export const name = 'apex-script-stdin'
export const inject = ['tools', 'shell', 'shellEnv', 'sandboxPolicy', 'loader']

export async function apply(ctx) {
  // Host resolution preserves module identity in both source and built launches.
  // A filesystem-resolved import can load a second scope/approval module.
  const [{ approveEscalation, canonicalPath, validateEscalationArgs }, { HarnessError }, { TOOL_ABORTED }, { scopeOf }] = await Promise.all(
    ['dsh-sandbox', 'dsh-llm', 'dsh-tools', 'dsh-scope'].map(name => ctx.root.loader.import(`@deepseek-ai/${name}`)),
  )
  const bash = ctx.tools.get('bash', scopeOf(ctx))
  const foreground = bash?.output?.schema.oneOf?.find(schema => schema.properties?.kind?.const === 'foreground')
  if (ctx.shell.sandboxMode === undefined || !foreground || typeof bash.output.render !== 'function') {
    throw new Error('APEX: script stdin requires the native confining Bash and its foreground output contract')
  }
  const { run_in_background, ...properties } = bash.parameters.properties
  registerTool(ctx, {
    name: 'apex_run_script',
    description: 'Run a foreground script by sending its text directly to an interpreter on stdin, then closing stdin. '
      + 'Use for multiline code instead of nesting source inside node -e, shell quotes or heredocs; ordinary commands and background jobs still use bash. '
      + 'The interpreter must read stdin (for example node --input-type=module, python3 -, or bash -s); runtimes are not installed automatically. '
      + 'tools.* exists only in the calling PTC program; external interpreters and saved scripts do not inherit it. '
      + 'Fetch tool data in PTC, then pass values or workspace files to the script. Node module stdin and .mjs use JavaScript, not TypeScript. '
      + 'For Node module source on stdin, relative imports resolve from workdir; in a saved module they resolve from that module file, not the shell cwd. '
      + 'Defaults to the session workspace, not the PTC worker or Host cwd. Each call is independent. '
      + 'Read exitCode, timedOut, sandbox and both output streams independently; exit 0 does not certify assertions or acceptance. '
      + 'Native sandbox and approval rules still apply. After a policy denial, do not work around it; only request the narrowest wider mode '
      + 'for the same command and script with justification if approval prompts are enabled. A rejected escalation is final. '
      + 'PTC usage: return await tools.apex_run_script({command: "node --input-type=module", description: "Print literal text", script: "const text = \'`ticks` ${literal}\';\\nconsole.log(text);"});',
    parameters: {
      ...bash.parameters,
      additionalProperties: false,
      properties: {
        ...properties,
        command: { type: 'string', minLength: 1, description: 'Interpreter command that reads source from stdin, e.g. node --input-type=module. Put the source in script, not -e or shell redirection.' },
        script: { type: 'string', description: 'The outer PTC string is evaluated before this tool receives the source. Use a JSON-escaped double-quoted string for literal payloads; String.raw still interpolates ${...}. Once received, source is sent as UTF-8 unchanged: no interpolation, newline conversion or appended newline; literal backslash-n is not rewritten.' },
      },
      required: [...bash.parameters.required, 'script'],
    },
    output: {
      schema: {
        ...foreground,
        properties: {
          ...foreground.properties,
          workdir: { type: 'string', description: 'Resolved initial working directory passed to the native executor. A script can change its own cwd; that change never persists to another call.' },
        },
        required: [...foreground.required, 'workdir'],
      },
      render: (args, value) => bash.output.render(args, value).map((block, index) => index === 0 && block.type === 'text'
        ? { ...block, text: `[workdir: ${JSON.stringify(value.workdir)}]\n${block.text}` } : block),
    },
    presentCall: args => ({
      card: 'generic', title: args.description, kind: 'execute', rawInput: args.script,
      content: [{ type: 'text', text: `Interpreter: ${args.command}\nSource is supplied on stdin.` }],
    }),
    presentResult: bash.presentResult,
    async execute(args, exec) {
      if (!args.command.trim() || !args.description.trim()) throw new Error('apex_run_script: command and description must be non-empty')
      if (!args.script.isWellFormed()) throw new Error('apex_run_script: script must be well-formed Unicode; refusing lossy UTF-8 conversion')
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('apex_run_script: timeoutMs must be a positive finite number')
      }
      validateEscalationArgs(args.sandbox_permissions, args.justification)
      const session = exec.agent?.session
      if (!session || !isAbsolute(session.header.cwd ?? '')) {
        throw new Error('apex_run_script: a session with an absolute working directory is required; refusing Host cwd fallback')
      }
      const standing = ctx.sandboxPolicy.resolve({ session })
      const workdir = canonicalPath(resolve(standing.workspaceRoot ?? canonicalPath(session.header.cwd), args.workdir ?? '.'))
      const mode = args.sandbox_permissions === undefined ? standing.mode : await approveEscalation({
        requestedMode: args.sandbox_permissions, justification: args.justification,
        effectiveMode: standing.mode, subject: 'script',
      }, {
        approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
        toolName: 'apex_run_script', signal: exec.signal,
      })
      // No global chdir, temporary script, raw spawn, retry or background owner.
      const spec = ctx.shell.resolve({
        command: args.command, stdin: args.script, workdir, timeoutMs: args.timeoutMs,
        signal: exec.signal, dshEnv: ctx.shellEnv.collect(exec), sandboxPolicy: { ...standing, mode },
      })
      const result = await ctx.shell.run(spec)
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      const { exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr, sandbox } = result
      return {
        kind: 'foreground', workdir: spec.workdir, exitCode, signal, timedOut, aborted, timeoutMs,
        stdout: { ...stdout }, stderr: { ...stderr }, ...sandbox !== undefined ? { sandbox: { ...sandbox } } : {},
      }
    },
  })
}
