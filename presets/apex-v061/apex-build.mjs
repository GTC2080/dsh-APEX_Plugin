/** Start one continuable Flash Max implementation worker from structured fields. */

import { parseBuildArguments, renderWorkItemPrompt } from './work-items.mjs'
import {
  delegationPathConflictReason,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
} from './tool-gate.mjs'

export const name = 'apex-build-v061'
export const inject = ['tools', 'subagents']
export const FLASH_CHILD_PERSONA = 'You are a helpful assistant.'

export const APEX_BUILD_DESCRIPTION = [
  'Start one V4 Flash Max code worker for a genuinely independent module selected by the Pro parent.',
  'Fill the structured fields once; APEX compiles the canonical worker brief and fixed safety constraints.',
  'Use explicit non-overlapping files or a bounded subdirectory; the whole-workspace ** lease is forbidden.',
  'Do not delegate a single-file deliverable or tightly coupled whole-app implementation. The Pro parent keeps architecture, main integration surfaces, research, validation, review, and final repair.',
  'Pro may establish architecture first, but each leased path must still be untouched by Pro in this human task.',
  'This tool always starts a continuable background worker and immediately returns its durable child id.',
].join(' ')

const CHILD_TOOL_FILTER = Object.freeze([
  process.platform === 'win32' ? 'pwsh' : 'bash',
  'str_replace_editor',
  'read',
  'read_image',
  'glob',
  'grep',
])

/** Register the structured, background-only APEX builder. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'apex_build',
    description: APEX_BUILD_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'Short display label for this bounded implementation scope.',
        },
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Stable work-item id using letters, digits, spaces, dot, dash, or underscore.',
        },
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 240 },
          description: 'Bounded workspace-relative files or non-root trailing /** directory scopes leased to this worker; never **.',
        },
        goal: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: 'One bounded implementation outcome.',
        },
        context: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'Verified local files, interfaces, constraints, and facts the worker needs; up to 8000 characters.',
        },
        non_goals: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: 'Explicitly excluded work; keep planning, validation, and review with the parent.',
        },
        acceptance: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: 'Observable completion checks for the leased implementation scope.',
        },
      },
      required: ['description', 'id', 'paths', 'goal', 'context', 'non_goals', 'acceptance'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { subagentId: { type: 'string' } },
        required: ['subagentId'],
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec?.agent === undefined) throw new Error('apex_build requires a calling parent agent')
      const parsed = parseBuildArguments(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const conflict = delegationPathConflictReason(exec.agent, parsed.value.paths)
      if (conflict !== undefined) throw new Error(conflict)
      const workspaceRoot = exec.agent.session?.header?.cwd
      const started = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: parsed.value.description,
        request: {
          label: parsed.value.description,
          prompt: [{ type: 'text', text: renderWorkItemPrompt(parsed.value, workspaceRoot) }],
          parent: exec.agent,
          agentOptions: {
            provider: FLASH_MAX_PROVIDER,
            model: FLASH_MAX_MODEL,
          },
          persona: FLASH_CHILD_PERSONA,
          toolFilter: { allow: [...CHILD_TOOL_FILTER] },
          maxDepth: 1,
        },
        signal: exec.signal,
      })
      return { subagentId: started.childId }
    },
  })
}
