import { z } from 'zod'
import { registerTool } from './tools.mjs'

/** Scoped model-facing tools for the opt-in Agent Teams runtime. */
/** Cordis plugin name. */
export const name = 'apex-team';
/** Services required by the Team tool plugin. */
export const inject = ['agentTeams', 'tools', 'systemPrompt', 'sessionProjections'];
/** Loader schema for the opt-in Team tool plugin. */
export const Config = z.object({
    freshProvider: z.string().default('spawn'),
    forkProvider: z.string().default('fork'),
}).strict().prefault({});
/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Use Agent Teams autonomously when independent work justifies coordination; do simple tasks yourself. A later user or project instruction requiring a single agent takes precedence. Prefer fresh teammates, use fork only when inherited context is needed, and reuse existing members.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock. Wait for required test files and their imports to be ready before broad test discovery; meanwhile use explicit ready test files for independent checks.

Prefer read/edit/write for file changes. Avoid deleting and recreating observed paths just to revise them: Shell deletion does not clear native file observations. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

send_message attempts to steer a running target, start an idle target, or cold-resume an inactive teammate. A delivered peer item starts with its stable message id and sender name. Both accepted and queued sends are durable; queued does not confirm immediate delivery. Do not resend a queued instruction or spawn a replacement for the same work: the original message may still execute after recovery. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, inspect list_agents status and pending-delivery diagnostics; send a required instruction only if it has not already been queued. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member is running or provisioning. If required work is queued but inactive, report the delivery blocker; inactive does not mean finished. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer, or clearly report why required work remains incomplete.`;
const ACTIVE_WAIT_STATUSES = new Set(['running', 'provisioning']);
// A repeatable wait slice, not a Team/task deadline. The pinned native PTC
// ceiling is 600000 ms; long work must span separate model requests.
const MAX_WAIT_MS = 60_000;
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Check list_agents diagnostics and team_task_list. A queued send is already durable: do not resend it or spawn a replacement for the same work. If required delivery is pending, report that blocker; inactive does not mean finished. Send a new instruction only if that work has not already been queued.';
/**
 * One roster row, matching `TeamMemberView`. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "role": {
      "type": "string",
      "enum": [
        "lead",
        "teammate"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "running",
        "idle",
        "inactive",
        "provisioning",
        "failed"
      ]
    },
    "description": {
      "type": "string"
    },
    "provider": {
      "type": "string"
    },
    "context": {
      "type": "string",
      "enum": [
        "fresh",
        "fork"
      ]
    },
    "model": {
      "type": "string"
    },
    "diagnostics": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "id",
    "name",
    "role",
    "status",
    "diagnostics"
  ]
}
const TASK_VIEW_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string"
    },
    "revision": {
      "type": "integer"
    },
    "subject": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "in_progress",
        "completed",
        "deleted"
      ]
    },
    "ownerName": {
      "type": "string"
    },
    "blockedBy": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "writeScopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ready": {
      "type": "boolean"
    },
    "writeScopeWarnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "id",
    "revision",
    "subject",
    "description",
    "status",
    "blockedBy",
    "writeScopes",
    "ready",
    "writeScopeWarnings"
  ]
}
const SPAWN_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { member: MEMBER_VIEW_SCHEMA }, required: ['member'],
}
const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA }
const SEND_VALUE_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "messageId": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "accepted",
        "queued"
      ]
    }
  },
  "required": [
    "messageId",
    "status"
  ]
}
const WAIT_VALUE_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "timedOut": {
      "type": "boolean"
    },
    "waitWindow": {
      "type": "object",
      "additionalProperties": false,
      "description": "Present when the requested wait was shortened. timedOut applies to effectiveTimeoutMs, not requestedTimeoutMs. No teammate was cancelled; return from run_code and re-list on the next model request before waiting again.",
      "properties": {
        "requestedTimeoutMs": { "type": "integer" },
        "effectiveTimeoutMs": { "type": "integer" }
      },
      "required": ["requestedTimeoutMs", "effectiveTimeoutMs"]
    },
    "noProgress": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "reason": {
          "type": "string",
          "const": "no-active-peer"
        },
        "message": {
          "type": "string"
        }
      },
      "required": [
        "reason",
        "message"
      ]
    }
  },
  "required": [
    "timedOut"
  ]
}
const INTERRUPT_VALUE_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "previousStatus": {
      "type": "string",
      "enum": [
        "running",
        "idle",
        "inactive"
      ]
    }
  },
  "required": [
    "previousStatus"
  ]
}
const TASK_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { tasks: { type: 'array', items: TASK_VIEW_SCHEMA }, nextCursor: { type: 'integer' } },
  required: ['tasks'],
}
function jsonOutput(schema) {
    return {
        schema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    };
}
/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
    /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
    if (agent === undefined)
        throw new Error(`${toolName} requires a calling Agent`);
    return agent;
}
/** Add mailbox observations from the existing native projection, without retrying delivery. */
function memberViews(ctx, caller) {
    const members = ctx.agentTeams.listMembers(caller);
    const { root } = ctx.agentTeams.membership(caller);
    const state = ctx.sessionProjections.stateOf(root.session, 'agentTeam');
    if (state === undefined) throw new Error('Agent Teams projection is not registered');
    const delivered = new Set(state.delivered), pending = new Map();
    for (const message of state.messages) {
        if (!delivered.has(message.id)) pending.set(message.targetId, (pending.get(message.targetId) ?? 0) + 1);
    }
    return members.map(member => pending.has(member.id) ? { ...member, diagnostics: [...member.diagnostics,
        `${pending.get(member.id)} Team message(s) await recorded delivery; inactive status does not mean this work is finished. Do not resend queued work.`] } : member);
}
/** Register the complete Team tool set in one exact Agent scope. */
export function apply(ctx, config = {}) {
    config = Config.parse(config);
    const scoped = ctx;
    const disposers = [];
    const register = (disposer) => { disposers.push(disposer); };
    try {
        register(scoped.systemPrompt.section({
            name: 'team:policy',
            order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
            text: context => {
                // Native one-shot reviewers inherit prompt sections but restrict their tools.
                // A separate child may be a Team root; membership alone is not capability.
                if (!context.scope || !ctx.tools.get('spawn_teammate', context.scope)) return '';
                const membership = context.agent && ctx.agentTeams.tryMembership(context.agent);
                if (!membership) return "";
                return POLICY;
            },
        }));
        register(registerTool(scoped, {
            name: 'spawn_teammate',
            description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
            parameters: { "type": "object", "properties": { "name": { "type": "string", "description": "Unique lower-kebab-case teammate name." }, "description": { "type": "string", "description": "Short description of the delegated responsibility." }, "prompt": { "type": "string", "description": "Complete initial task for the teammate." }, "context": { "type": "string", "description": "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.", "enum": ["fresh", "fork"] } }, "required": ["name", "description", "prompt"] },
            output: jsonOutput(SPAWN_VALUE_SCHEMA),
            async execute(args, exec) {
                const agent = callingAgent(exec.agent, 'spawn_teammate');
                const context = args.context ?? 'fresh';
                return await ctx.agentTeams.spawnTeammate(agent, {
                    name: args.name,
                    description: args.description,
                    prompt: [
                        { type: 'text', text: `<system-reminder>\nYou are teammate "${args.name.trim()}".\n</system-reminder>\n\n` },
                        { type: 'text', text: args.prompt },
                    ],
                    context,
                    provider: context === 'fork' ? config.forkProvider : config.freshProvider,
                    signal: exec.signal,
                });
            },
        }));
        register(registerTool(scoped, {
            name: 'send_message',
            description: 'Send one durable message and attempt immediate delivery to another Team member. The target may be running, idle or inactive. queued means delivery is pending, not that sending failed: do not resend or duplicate the work. Check list_agents diagnostics before waiting.',
            parameters: { "type": "object", "properties": { "target": { "type": "string", "description": "Team member name, or lead." }, "message": { "type": "string", "description": "Self-contained message for the target." } }, "required": ["target", "message"] },
            output: jsonOutput(SEND_VALUE_SCHEMA),
            execute(args, exec) {
                return ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
                    target: args.target,
                    content: [{ type: 'text', text: args.message }],
                    signal: exec.signal,
                });
            },
        }));
        register(registerTool(scoped, {
            name: 'list_agents',
            description: 'List the Lead and every durable teammate with current runtime status and pending-delivery diagnostics. Inactive does not mean no work is queued.',
            parameters: { "type": "object", "properties": {} },
            output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
            async execute(_args, exec) {
                return memberViews(ctx, callingAgent(exec.agent, 'list_agents'));
            },
        }));
        register(registerTool(scoped, {
            name: 'wait_agent',
            description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Each call waits at most 60000 ms; a longer requested timeout returns waitWindow with the actual limit. Use a standalone PTC program: return await tools.wait_agent({timeout_ms:60000}); then re-list on the next model request. Do not loop or batch waits in one run_code: its wall-clock ceiling still applies. Waiting may continue across requests for as long as the task needs.',
            parameters: { "type": "object", "properties": { "timeout_ms": { "type": "integer", "description": "Requested upper bound in milliseconds, from 10000 through 3600000. Defaults to 30000. APEX executes at most 60000 ms per call and reports a shortened waitWindow; this is not a task deadline." } } },
            output: jsonOutput(WAIT_VALUE_SCHEMA),
            async execute(args, exec) {
                const caller = callingAgent(exec.agent, 'wait_agent');
                const timeoutMs = args.timeout_ms ?? 30_000;
                // Preserve TeamService's authoritative timeout validation before the
                // model-only no-progress shortcut.
                if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
                    return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
                }
                // The active-peer read and waiter registration must remain one synchronous
                // span; awaiting between them can lose the only peer-status edge.
                const members = memberViews(ctx, caller);
                const hasActivePeer = members.some(member => member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status));
                if (!hasActivePeer) {
                    return {
                        timedOut: false,
                        noProgress: {
                            reason: 'no-active-peer',
                            message: [NO_ACTIVE_PEER_MESSAGE, ...members.flatMap(member => member.diagnostics.map(detail => `${member.name}: ${detail}`))].join('\n'),
                        },
                    };
                }
                const effectiveTimeoutMs = Math.min(timeoutMs, MAX_WAIT_MS);
                const result = await ctx.agentTeams.waitForChange(caller, effectiveTimeoutMs, exec.signal);
                return timeoutMs === effectiveTimeoutMs ? result : {
                    ...result,
                    waitWindow: { requestedTimeoutMs: timeoutMs, effectiveTimeoutMs },
                };
            },
        }));
        register(registerTool(scoped, {
            name: 'interrupt_agent',
            description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
            parameters: { "type": "object", "properties": { "target": { "type": "string", "description": "Teammate name." } }, "required": ["target"] },
            output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
            async execute(args, exec) {
                return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target));
            },
        }));
        register(registerTool(scoped, {
            name: 'team_task_create',
            description: 'Create one unowned pending task on the shared Team task board.',
            parameters: { "type": "object", "properties": { "subject": { "type": "string", "description": "Concise task title." }, "description": { "type": "string", "description": "Complete task details and acceptance criteria." }, "blocked_by": { "type": "array", "description": "Task ids that must complete first.", "items": { "type": "string" } }, "write_scopes": { "type": "array", "description": "Advisory workspace-relative file or directory prefixes this task expects to modify.", "items": { "type": "string" } } }, "required": ["subject", "description"] },
            output: jsonOutput(TASK_VIEW_SCHEMA),
            async execute(args, exec) {
                return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
                    subject: args.subject,
                    description: args.description,
                    ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by },
                    ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
                });
            },
        }));
        register(registerTool(scoped, {
            name: 'team_task_list',
            description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
            parameters: { "type": "object", "properties": { "status": { "type": "string", "description": "Optional exact status filter.", "enum": ["pending", "in_progress", "completed"] }, "owner": { "type": "string", "description": "Optional member-name filter; use unowned for tasks without an owner." }, "ready": { "type": "boolean", "description": "Optional readiness filter." }, "cursor": { "type": "integer", "description": "Zero-based result offset. Defaults to 0." }, "limit": { "type": "integer", "description": "Number of rows, 1 through 100. Defaults to 50." } } },
            output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
            execute(args, exec) {
                const status = args.status;
                const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task => (status === undefined || task.status === status)
                    && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
                    && (args.ready === undefined || task.ready === args.ready));
                const cursor = args.cursor ?? 0;
                const limit = args.limit ?? 50;
                if (!Number.isSafeInteger(cursor) || cursor < 0)
                    throw new Error('cursor must be a non-negative safe integer');
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
                    throw new Error('limit must be an integer from 1 through 100');
                return Promise.resolve({
                    tasks: filtered.slice(cursor, cursor + limit),
                    ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
                });
            },
        }));
        register(registerTool(scoped, {
            name: 'team_task_get',
            description: 'Read the complete latest value of one shared task before changing or executing it.',
            parameters: { "type": "object", "properties": { "task_id": { "type": "string", "description": "Shared task id." } }, "required": ["task_id"] },
            output: jsonOutput(TASK_VIEW_SCHEMA),
            async execute(args, exec) {
                return Promise.resolve(ctx.agentTeams.getTask(callingAgent(exec.agent, 'team_task_get'), args.task_id));
            },
        }));
        register(registerTool(scoped, {
            name: 'team_task_update',
            description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
            parameters: { "type": "object", "properties": { "task_id": { "type": "string", "description": "Shared task id." }, "expected_revision": { "type": "integer", "description": "Current task revision used as the CAS precondition." }, "action": { "type": "string", "description": "Task transition to apply.", "enum": ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"] }, "subject": { "type": "string", "description": "Replacement title for edit." }, "description": { "type": "string", "description": "Replacement details for edit." }, "blocked_by": { "type": "array", "description": "Complete blocker list for set_dependencies.", "items": { "type": "string" } }, "write_scopes": { "type": "array", "description": "Replacement advisory write scopes for edit.", "items": { "type": "string" } }, "owner": { "type": "string", "description": "Member name for Lead-only reassign; omit to unassign." } }, "required": ["task_id", "expected_revision", "action"] },
            output: jsonOutput(TASK_VIEW_SCHEMA),
            async execute(args, exec) {
                return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
                    taskId: args.task_id,
                    expectedRevision: args.expected_revision,
                    action: args.action,
                    ...args.subject === undefined ? {} : { subject: args.subject },
                    ...args.description === undefined ? {} : { description: args.description },
                    ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by },
                    ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
                    ...args.owner === undefined ? {} : { owner: args.owner },
                });
            },
        }));
    }
    catch (error) {
        for (const dispose of disposers.reverse())
            void dispose();
        throw error;
    }
    ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) void dispose();
    });
}
