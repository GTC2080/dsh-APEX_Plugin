/** Start one role-bounded PTC implementation worker from structured fields. */

import {
  parseBuildArguments,
  renderWorkItemPrompt,
  snapshotReadOnlyInputs,
} from './work-items.mjs'
import {
  APEX_CODE_CHILD_LABEL_PREFIX,
  delegationPathConflictReason,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  isManagedPtcCodeChild,
  PRO_MAX_MODEL,
  PRO_MAX_PROVIDER,
  PRO_MAX_REASONING_EFFORT,
} from './tool-gate.mjs'

export const name = 'apex-build-v063'
export const inject = ['tools', 'subagents']
export const FLASH_CHILD_PERSONA = 'You are a helpful assistant.'
export const APEX_PRESET_ID = 'apex-v063'

export const APEX_BUILD_DESCRIPTION = [
  'Start one role-bounded PTC implementation worker from an immutable handoff contract.',
  'Choose flash-production by default for isolated single-file or mechanical implementation behind frozen interfaces; choose pro-core only for a genuinely difficult algorithm or tightly coupled integration whose reasoning cannot remain with the parent.',
  'Fill the structured fields once; APEX compiles the canonical worker brief and fixed safety constraints.',
  'Use explicit non-overlapping files or a bounded subdirectory; the whole-workspace ** lease is forbidden.',
  'The parent Pro keeps architecture, cross-lease integration, research, validation, review, and final judgment.',
  'Pro may establish architecture first, but each leased path must still be untouched by Pro in this human task.',
  'The worker receives one direct official PTC programming surface from its first request.',
  'This tool always starts a continuable background worker and immediately returns its durable child id.',
].join(' ')

export const FLASH_PRODUCTION_WORKER_TOOLS = Object.freeze([
  'str_replace_editor',
  'read',
  'read_image',
  'glob',
  'grep',
])

// `report` is child-scoped by dsh-tool-subagent-report and survives this global restriction.

export const PRO_CORE_WORKER_TOOLS = Object.freeze([
  process.platform === 'win32' ? 'pwsh' : 'bash',
  ...FLASH_PRODUCTION_WORKER_TOOLS,
])

// Compatibility alias for existing imports while v0.6.3 is in development.
export const FLASH_WORKER_TOOLS = FLASH_PRODUCTION_WORKER_TOOLS

/** Present only newly labelled APEX code workers through official PTC. */
export function installCodeWorkerPtc(childCtx) {
  const agent = childCtx.agent
  if (agent?.session?.header?.agentPreset !== APEX_PRESET_ID
    || !isManagedPtcCodeChild(agent)) return () => {}
  return childCtx.tools.presentAs('ptc')
}

export const installFlashWorkerPtc = installCodeWorkerPtc

/** Register the structured, background-only APEX builder. */
export function apply(ctx) {
  ctx.subagents.registerContinuableSetup(installCodeWorkerPtc)
  ctx.tools.register({
    name: 'apex_build',
    description: APEX_BUILD_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: {
          type: 'string',
          enum: ['flash-production', 'pro-core'],
          description: 'flash-production is the default for isolated single-file or mechanical work; pro-core is reserved for genuinely difficult algorithms or tightly coupled integration.',
        },
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
        read_only_inputs: {
          type: 'array',
          minItems: 0,
          maxItems: 12,
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 240 },
              purpose: { type: 'string', minLength: 1, maxLength: 600 },
            },
            required: ['path', 'purpose'],
          },
          description: 'Existing immutable workspace files the worker may read; APEX snapshots each SHA-256 before dispatch.',
        },
        interfaces: {
          type: 'array',
          minItems: 0,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              contract: { type: 'string', minLength: 1, maxLength: 600 },
            },
            required: ['id', 'contract'],
          },
          description: 'Frozen interface contracts this lease must preserve.',
        },
        invariants: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              statement: { type: 'string', minLength: 1, maxLength: 600 },
            },
            required: ['id', 'statement'],
          },
          description: 'Named facts that must remain true after implementation.',
        },
        non_goals: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: { type: 'string', minLength: 1, maxLength: 600 },
          description: 'Explicitly excluded work; planning, validation, and review stay with the parent.',
        },
        acceptance: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              assertion: { type: 'string', minLength: 1, maxLength: 600 },
            },
            required: ['id', 'assertion'],
          },
          description: 'Named observable completion assertions for the leased scope.',
        },
      },
      required: [
        'role', 'description', 'id', 'paths', 'goal', 'context',
        'read_only_inputs', 'interfaces', 'invariants', 'non_goals', 'acceptance',
      ],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagentId: { type: 'string' },
          handoffId: { type: 'string' },
          role: { type: 'string', enum: ['flash-production', 'pro-core'] },
        },
        required: ['subagentId', 'handoffId', 'role'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started subagent ${value.subagentId}\nhandoff ${value.handoffId}; role ${value.role}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec?.agent === undefined) throw new Error('apex_build requires a calling parent agent')
      const parsed = parseBuildArguments(args)
      if (!parsed.ok) throw new Error(parsed.error)
      const conflict = delegationPathConflictReason(exec.agent, parsed.value.paths)
      if (conflict !== undefined) throw new Error(conflict)
      const workspaceRoot = exec.agent.session?.header?.cwd
      const readOnlyInputs = await snapshotReadOnlyInputs(parsed.value, workspaceRoot)
      const proCore = parsed.value.role === 'pro-core'
      const workerLabel = `${APEX_CODE_CHILD_LABEL_PREFIX} [${parsed.value.role}]: ${parsed.value.description}`
      const started = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: workerLabel,
        request: {
          label: workerLabel,
          prompt: [{
            type: 'text',
            text: renderWorkItemPrompt(parsed.value, workspaceRoot, readOnlyInputs),
          }],
          parent: exec.agent,
          agentOptions: {
            provider: proCore ? PRO_MAX_PROVIDER : FLASH_MAX_PROVIDER,
            model: proCore ? PRO_MAX_MODEL : FLASH_MAX_MODEL,
            reasoningEffort: proCore ? PRO_MAX_REASONING_EFFORT : FLASH_MAX_REASONING_EFFORT,
          },
          persona: FLASH_CHILD_PERSONA,
          toolFilter: {
            allow: [...(proCore ? PRO_CORE_WORKER_TOOLS : FLASH_PRODUCTION_WORKER_TOOLS)],
          },
          maxDepth: 1,
        },
        signal: exec.signal,
      })
      return { subagentId: started.childId, handoffId: parsed.value.id, role: parsed.value.role }
    },
  })
}
