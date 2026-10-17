import { isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerTool } from './tools.mjs'

export const name = 'apex-script-stdin'
export const inject = ['tools', 'shell', 'shellEnv', 'sandboxPolicy', 'loader', 'pluginPackages']

export async function apply(ctx) {
  // Resolve from the selected native tools package so source-launch mappings
  // and built launches use the same scope/approval modules as the registry.
  const owner = ctx.pluginPackages.packageOf('@deepseek-ai/dsh-tools', ctx.root.baseUrl)
  if (!owner) throw new Error('APEX: native tools package is unavailable in the current Harness runtime')
  const host = ctx.extend({ baseUrl: pathToFileURL(await realpath(owner.manifestPath)).href })
  const [{ approveEscalation, canonicalPath, validateEscalationArgs }, { HarnessError }, { TOOL_ABORTED }, { scopeOf }] = await Promise.all(
    ['dsh-sandbox', 'dsh-llm', 'dsh-tools', 'dsh-scope'].map(name => host.loader.import(`@deepseek-ai/${name}`)),
  )
  const bash = ctx.tools.get('bash', scopeOf(ctx))
  const foreground = bash?.output?.schema.oneOf?.find(schema => schema.properties?.kind?.const === 'foreground')
  if (ctx.shell.sandboxMode === undefined || !foreground || typeof bash.output.render !== 'function') {
    throw new Error('APEX: script stdin requires the native confining Bash and its foreground output contract')
  }
  const { run_in_background, ...properties } = bash.parameters.properties
  registerTool(ctx, {
    name: 'apex_run_script',
    description: 'Run a foreground program with literal argv, or send script text to an interpreter on stdin, then close stdin. '
      + 'For tests and saved programs use argv (e.g. ["node", "--test", "test/audit.test.mjs"]); arguments are literal, without shell expansion or pipelines. '
      + 'Use argv for deliberately failing test copies too. Keep copy preparation and cleanup in the calling PTC try/finally; retain the full program result before cleanup and check the intended failed assertion and complete runner summary. '
      + 'This uses native Bash exec so exitCode belongs to that program; inspect or print output in PTC after awaiting the result. '
      + 'A program or shell wrapper can still hide its own child failures. Provide either argv (script optional, default empty stdin) or command plus script, never both. '
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
        argv: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Program followed by literal arguments. Use for test runners and saved programs so trailing diagnostics cannot overwrite their exit status. Do not supply command. Shell syntax is not evaluated.' },
        script: { type: 'string', description: 'The outer PTC string is evaluated before this tool receives the source. Use a JSON-escaped double-quoted string for literal payloads; String.raw still interpolates ${...}. Once received, source is sent as UTF-8 unchanged: no interpolation, newline conversion or appended newline; literal backslash-n is not rewritten.' },
      },
      required: bash.parameters.required.filter(key => key !== 'command'),
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
      card: 'generic', title: args.description, kind: 'execute', rawInput: args.argv ? JSON.stringify(args.argv) + (args.script === undefined ? '' : '\n' + args.script) : args.script,
      content: [{ type: 'text', text: args.argv ? `Program arguments: ${JSON.stringify(args.argv)}\nArguments are literal; stdin closes after the optional script.` : `Interpreter: ${args.command}\nSource is supplied on stdin.` }],
    }),
    presentResult: bash.presentResult,
    async execute(args, exec) {
      if (!args.description.trim()) throw new Error('apex_run_script: description must be non-empty')
      if ((args.argv !== undefined) === (args.command !== undefined)) throw new Error('apex_run_script: provide either argv or command plus script')
      if (args.command !== undefined && (!args.command.trim() || args.script === undefined)) throw new Error('apex_run_script: a non-empty command requires script')
      if (args.argv && (!args.argv[0] || args.argv.some(value => value.includes('\0') || !value.isWellFormed()))) {
        throw new Error('apex_run_script: argv requires a non-empty program and well-formed strings without NUL')
      }
      const stdin = args.script ?? ''
      if (!stdin.isWellFormed()) throw new Error('apex_run_script: script must be well-formed Unicode; refusing lossy UTF-8 conversion')
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
      // Native exec replaces Bash; quote every token so diagnostics stay in the caller.
      const command = args.argv ? 'exec -- ' + args.argv.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ') : args.command
      const spec = ctx.shell.resolve({
        command, stdin, workdir, timeoutMs: args.timeoutMs,
        signal: exec.signal, dshEnv: ctx.shellEnv.collect(exec), sandboxPolicy: { ...standing, mode },
      })
      const execution = await ctx.shell.execute(spec)
      const result = await execution.result()
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
