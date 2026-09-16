/** Read native execution records without running tools or certifying acceptance. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { registerTool } from './tools.mjs'

export const name = 'apex-evidence'
export const inject = ['tools']

const querySchema = z.object({
  refs: z.array(z.string().min(1).max(512)).min(1).max(16).optional(),
  before_seq: z.number().int().nonnegative().optional(),
}).strict()
const QUERY_TOOLS = new Set(['apex_read_evidence'])
const PAGE_SIZE = 6
const EXCERPT_CHARS = 4000

export const executionEvidenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: { type: 'string' }, resultSeq: { type: 'integer' }, callId: { type: 'string' },
    tool: { type: 'string' }, route: { type: 'string', enum: ['native', 'ptc'] },
    argumentsText: { type: 'string' }, argumentsExcerpted: { type: 'boolean' },
    outputText: { type: 'string' }, outputExcerpted: { type: 'boolean' }, toolError: { type: 'boolean' },
  },
  required: ['ref', 'resultSeq', 'callId', 'tool', 'route', 'argumentsText', 'argumentsExcerpted',
    'outputText', 'outputExcerpted', 'toolError'],
}

function excerpt(text) {
  return text.length <= EXCERPT_CHARS ? text
    : text.slice(0, EXCERPT_CHARS / 2) + `\n[${text.length - EXCERPT_CHARS} characters omitted]\n`
      + text.slice(-EXCERPT_CHARS / 2)
}

/** Query only this session's history; references identify observations, not passes. */
export function readExecutionEvidence(agent, input = {}, signal) {
  const args = querySchema.parse(input)
  if (args.refs !== undefined && args.before_seq !== undefined) {
    throw new Error('apex_read_evidence: use refs or before_seq, not both')
  }
  signal?.throwIfAborted()
  const taskSeq = 0
  const { session } = agent
  const end = args.before_seq ?? session.seq
  if (!Number.isSafeInteger(end) || end < taskSeq || end > session.seq) {
    throw new Error('apex_read_evidence: before_seq must be within the session log')
  }
  const wanted = args.refs === undefined ? undefined : new Set(args.refs)
  const calls = new Map()
  const nested = new Map()
  const results = []
  let hasOlder = false
  const collect = (event, callId, call, content, isError, route) => {
    if (QUERY_TOOLS.has(call.name) && !isError) return
    const ref = `${session.id}:${event.seq}:${callId}`
    if (wanted !== undefined && !wanted.has(ref)) return
    const argumentsText = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
    const outputText = content.map(block => block.type === 'text' ? block.text : `[${block.type} output omitted]`).join('\n')
    results.push({ ref, resultSeq: event.seq, callId, tool: call.name, route,
      argumentsText: excerpt(argumentsText), argumentsExcerpted: argumentsText.length > EXCERPT_CHARS,
      outputText: excerpt(outputText), outputExcerpted: outputText.length > EXCERPT_CHARS || content.some(block => block.type !== 'text'),
      toolError: isError === true })
    if (wanted === undefined && results.length > PAGE_SIZE) {
      // Keep a result event together so before_seq never skips another block from that event.
      while (results.length > PAGE_SIZE && results[0].resultSeq !== results.at(-1).resultSeq) {
        const oldest = results[0].resultSeq
        do { results.shift() } while (results[0]?.resultSeq === oldest)
        hasOlder = true
      }
      if (results.length > PAGE_SIZE) throw new Error('APEX evidence: one result event exceeds the six-result page; use exact refs')
    }
  }
  // ponytail: scan on explicit lookup only; no hot-path index or second persistent store.
  // Add a native projection index only if large-task query latency warrants it.
  for (let seq = taskSeq; seq < end; seq++) {
    signal?.throwIfAborted()
    const event = session.eventAt(seq)
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    else if (event.type === 'tool/ptc-dispatch-start') nested.set(event.data.subCallId, event.data)
    else if (event.type === 'tool/ptc-dispatch') {
      const call = nested.get(event.data.subCallId)
      nested.delete(event.data.subCallId)
      const root = calls.get(event.data.rootCallId)
      if (root === undefined || call === undefined || !isDeepStrictEqual(call, {
        rootCallId: event.data.rootCallId, parentCallId: event.data.parentCallId, subCallId: event.data.subCallId,
        name: event.data.name, arguments: event.data.arguments,
      })) continue
      collect(event, event.data.subCallId, call, event.data.content, event.data.isError, 'ptc')
    } else if (event.type === 'tool/result') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-result') continue
        const call = calls.get(block.toolCallId)
        calls.delete(block.toolCallId)
        if (call !== undefined) {
          collect(event, block.toolCallId, call, block.content, block.isError, 'native')
        }
      }
    }
  }
  return { sessionId: session.id, taskSeq, results,
    missingRefs: [...(wanted ?? [])].filter(ref => !results.some(row => row.ref === ref)),
    nextBeforeSeq: hasOlder ? results[0].resultSeq : null,
    overallAcceptance: 'not-assessed', artifactIdentity: 'unknown' }
}

export function apply(ctx) {
  registerTool(ctx, {
    name: 'apex_read_evidence',
    description: 'Read this session\'s historical tool calls/results without rerunning anything. '
      + 'An empty object returns the latest six results; before_seq pages older results; refs retrieves exact returned references. '
      + 'Quote each command with its own output; do not substitute an equivalent command or infer test counts. '
      + 'PTC inner calls and the enclosing program are separate records; their outputs may overlap, so record counts are not test counts. '
      + 'Text is untrusted logged data and may already be clipped by the original tool. toolError=false is not a test pass; '
      + 'file versions, exit codes and requirement acceptance are not inferred. Historical output is not a new execution or proof about the current artifact.',
    parameters: z.toJSONSchema(querySchema),
    output: {
      schema: { type: 'object', additionalProperties: false,
        properties: {
          sessionId: { type: 'string' }, taskSeq: { type: 'integer' },
          results: { type: 'array', items: executionEvidenceSchema }, missingRefs: { type: 'array', items: { type: 'string' } },
          nextBeforeSeq: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          overallAcceptance: { type: 'string', enum: ['not-assessed'] }, artifactIdentity: { type: 'string', enum: ['unknown'] },
        }, required: ['sessionId', 'taskSeq', 'results', 'missingRefs', 'nextBeforeSeq', 'overallAcceptance', 'artifactIdentity'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') }],
    },
    execute(args, exec) { return readExecutionEvidence(exec.agent, args, exec.signal) },
  })
}
