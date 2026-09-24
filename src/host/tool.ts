/**
 * The model-facing ORC capability.
 *
 * `installOrcTool` registers three contributions in one exact Agent scope:
 *
 * - the `orc` tool, which exposes ORC's actions to the model;
 * - the ORC decision policy as a system-prompt section, so the classification
 *   rules are visible before the model implements anything;
 * - a scoped `agent/pre-step` gate, which starts ORC for a high-impact admitted
 *   request *before* model execution and rejects the step when that durable
 *   start fails.
 *
 * The tool accepts an action, identifiers, the classification facts the policy
 * is a function of, and a report payload. It has no field for a credential and
 * no field that could select a route: routes come from the ORC settings and the
 * selector, never from the model.
 *
 * The service stays the authority. The tool only resolves *which* agent identity
 * owns an action (the run's Lead for lead-owned transitions, the task's Peer for
 * peer-owned ones) and calls the service, which re-derives authority from the
 * durable state and refuses anything the reducer does not allow.
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type InferArgs, type InferValue, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { classifyRequest, type RiskDecision } from '../domain/risk.js'
import { WorkflowError, type OrcState } from '../domain/workflow.js'
import type { OrcService } from './service.js'
import { OrcServiceError } from './service.js'

/**
 * The section order ORC's policy occupies.
 *
 * DSH allocates its own policy band centrally (plan policy 500, team policy
 * 600), so an independent plugin's policy section follows that band and stays
 * ahead of the per-tool sections.
 */
const ORC_SECTION_ORDER = 650

/** The system-prompt section name ORC registers in one Agent scope. */
export const ORC_SECTION_NAME = 'orc:policy'

/** The model-facing policy. It states the rules the service enforces. */
export const ORC_POLICY = `## ORC workflow
Classify every request before implementing it, and use the \`orc\` tool to record the decision.

- Small, isolated, low-risk work — a typo, a small documentation correction, one contained visual adjustment — may be handled directly, without ORC state, while the session's ORC mode is \`adaptive\`.
- The session's ORC mode governs how early ORC starts. In \`always\` mode the ORC run opens for every admitted request, however small; in \`adaptive\` mode only the substantial and high-impact work below starts it.
- Multi-step, multi-file, architectural, explicitly planned, or explicitly reviewed work starts ORC.
- Money movement, balances, payments, authentication, authorization, security-sensitive behavior, and similarly high-impact paths always start ORC, however small the diff.
- If direct work reveals substantial scope or high risk before implementation, classify it again with \`discoveredRisk\` set, start ORC, and only then continue implementing.

Once ORC starts, this session is the Supervisor of an ORC run: the run's Lead owns tasks, reviews, and fixes; Peers implement. The ORC service validates role authority, phase order, task settlement, review and audit results, fixes, and completion — a phase or authority refusal is final until the state that caused it changes.
The Lead and Peer children inherit this session's live provider, model, and effort, because a DSH child agent can only be given a DSH provider route. The configured **code route** — including the DeepSeek Flash v4.1 high default — therefore governs exactly one thing: an explicit \`dispatch\` with \`stage: "code"\`, which ORC routes and runs on that route. It does not move the Supervisor or the hierarchy.
Review and security audit are separate stages, and the final branch review and audit are separate gates that ORC routes and dispatches itself. Every one of them runs on a route ORC selects, and ORC states the exact report format to the backend it dispatches to; a report you write is never accepted in place of the report the selected backend produced. Critical, high, and medium findings block until they are fixed and re-reviewed. A failed, malformed, missing, or unavailable review or audit is blocking and is never a clean result: a malformed report leaves the run blocked in its stage, so the same stage can be dispatched again once the cause is fixed.`

/** Every action the tool accepts. */
const ACTIONS = [
  'classify',
  'start',
  'status',
  'create-lead',
  'create-peer',
  'start-task',
  'settle-task',
  'dispatch',
  'fix',
  'dismiss',
  'final-review',
  'final-audit',
  'complete',
] as const

type OrcAction = (typeof ACTIONS)[number]

/** The tool's parameters: an action, identifiers, policy facts, and a report. */
const ORC_PARAMETERS = {
  action: {
    type: 'string',
    enum: ACTIONS,
    required: true,
    description: 'The ORC action to perform.',
  },
  request: {
    type: 'string',
    description: 'classify/start: the request text the risk policy classifies.',
  },
  plannedFiles: {
    type: 'integer',
    description: 'classify/start: planned file count; only exactly 1 may stay direct.',
  },
  architectureChange: {
    type: 'boolean',
    description: 'classify/start: whether the request changes architecture.',
  },
  explicitPlanOrReview: {
    type: 'boolean',
    description: 'classify/start: whether the user asked for a plan or review.',
  },
  discoveredRisk: {
    type: 'boolean',
    description: 'classify/start: set when direct work revealed substantial scope or high risk.',
  },
  peerName: { type: 'string', description: 'create-peer: the peer name.' },
  peerId: { type: 'string', description: 'start-task: the peer the task is assigned to.' },
  taskId: { type: 'string', description: 'start-task/settle-task: the task identifier.' },
  findingId: { type: 'string', description: 'fix/dismiss: the finding identifier.' },
  stage: {
    type: 'string',
    enum: ['code', 'spec', 'plan', 'review', 'audit'],
    description: 'dispatch: the stage to route and run.',
  },
  prompt: {
    type: 'string',
    description: 'dispatch/final-review/final-audit: the work the stage receives; ORC appends the report contract to a review or audit dispatch.',
  },
  reason: { type: 'string', description: 'dismiss: why the finding does not block.' },
} as const satisfies ParameterSchemaSpec

/** The output declaration for the tool's canonical value. */
const ORC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    status: { type: 'string' },
    path: { type: 'string' },
    risk: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
    leadId: { type: 'string' },
    peers: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    taskGate: { type: 'string' },
    finalReview: { type: 'string' },
    finalAudit: { type: 'string' },
    message: { type: 'string' },
  },
} as const

/** The validated arguments one call supplies. */
type OrcToolArgs = InferArgs<typeof ORC_PARAMETERS>

/** The canonical value every action returns. */
type OrcToolValue = InferValue<typeof ORC_OUTPUT_SCHEMA>

/** The classification facts one tool call supplies, with the policy defaults applied. */
function riskOf(args: {
  request?: string
  plannedFiles?: number
  architectureChange?: boolean
  explicitPlanOrReview?: boolean
  discoveredRisk?: boolean
}): RiskDecision {
  return classifyRequest({
    text: args.request ?? '',
    touchedPaths: [],
    plannedFiles: args.plannedFiles ?? 1,
    hasArchitectureChange: args.architectureChange ?? false,
    explicitPlanOrReview: args.explicitPlanOrReview ?? false,
    ...args.discoveredRisk === undefined ? {} : { discoveredRisk: args.discoveredRisk },
  })
}

/** Project the committed run state into the tool's canonical value. */
function valueOf(action: OrcAction, state: OrcState, risk: RiskDecision, message: string): OrcToolValue {
  return {
    action,
    status: state.started ? state.phase : 'not-started',
    path: risk.path,
    risk: risk.risk,
    reasons: [...risk.reasons],
    leadId: state.leadId ?? '',
    peers: [...state.peers],
    tasks: state.tasks.map(task => `${task.id}:${task.status}`),
    findings: state.findings.map(finding => `${finding.id}:${finding.severity}:${finding.status}`),
    taskGate: state.taskGate,
    finalReview: state.finalReview,
    finalAudit: state.finalAudit,
    message,
  }
}

/** The admitted user text one pre-step proposes to the model. */
function admittedText(messages: readonly UserMessage[]): string {
  return messages
    .map(message => message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' '))
    .join('\n')
}

/**
 * Register the ORC tool, policy, and pre-step gate in one Agent scope.
 *
 * Every contribution is made through `agent.ctx`, so it exists only for that
 * agent and unwinds with the agent's scope. The returned disposer removes all
 * three explicitly, which is what `agent/disposed` and plugin unload call.
 *
 * @param agent - the exact Agent whose model requests receive the capability.
 * @param service - the ORC run service the tool drives.
 * @returns the disposer that removes the tool, the policy section, and the gate.
 */
export function installOrcTool(agent: Agent, service: OrcService): () => void {
  const tools = agent.ctx.tools
  const systemPrompt = agent.ctx.systemPrompt
  let disposed = false

  const disposeTool = tools.register(defineTool({
    name: 'orc',
    description: [
      'Record and drive an ORC workflow run for this session.',
      'Use `classify` to apply the ORC risk policy and `start` to open the run for substantial or high-impact work.',
      'Lead, peer, task, review, audit, fix, and completion actions drive the run; the ORC service validates every authority and phase rule.',
    ].join(' '),
    parameters: ORC_PARAMETERS,
    output: {
      schema: ORC_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => await runAction(args, service, exec.agent, exec.signal),
  }))

  const disposeSection = systemPrompt.section({
    name: ORC_SECTION_NAME,
    order: ORC_SECTION_ORDER,
    text: ORC_POLICY,
  })

  const disposeGate = agent.ctx.on('agent/pre-step', async ({ agent: subject, messages, signal }, next) => {
    const decision: PreStepDecision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const text = admittedText(decision.messages)
    const classified = riskOf({ request: text })
    // `always` opens ORC for every admitted request that carries user text.
    // The gate observes only the request text, so it cannot see the file count
    // or architecture that make a request trivially direct; rather than guess,
    // it honors the mode the user selected. A step with no admitted text is not
    // work, so it stays direct in both modes.
    const escalated = classified.path !== 'orc' && service.sessionMode() === 'always' && text.trim() !== ''
    if (classified.path !== 'orc' && !escalated) return decision
    const risk: RiskDecision = escalated
      ? { path: 'orc', risk: classified.risk, reasons: ['session-always'] }
      : classified
    const state = service.state(subject)
    // A member of an existing run is not a Supervisor: its work is governed by
    // the run it already belongs to, so it never opens a nested run.
    if (state.started && state.runId !== String(subject.id)) return decision
    // Durable before model execution: a failed start rejects the step.
    await service.start(subject, risk)
    return decision
  })

  return () => {
    if (disposed) return
    disposed = true
    disposeGate()
    disposeSection()
    disposeTool()
  }
}

/** Dispatch one validated tool call to the service. */
async function runAction(
  args: OrcToolArgs,
  service: OrcService,
  caller: Agent | undefined,
  signal: AbortSignal,
): Promise<OrcToolValue> {
  if (caller === undefined) throw new OrcServiceError('the orc tool needs the calling agent')
  const risk = riskOf(args)
  const state = service.state(caller)
  switch (args.action) {
    case 'classify':
      return valueOf(args.action, state, risk, `classified as ${risk.path}`)
    case 'start': {
      const started = await service.start(caller, risk)
      return valueOf(args.action, started, risk, `ORC run started for ${caller.id}`)
    }
    case 'status':
      return valueOf(args.action, state, risk, state.started ? `run phase ${state.phase}` : 'no ORC run')
    case 'create-lead': {
      const lead = await service.createLead(caller)
      return valueOf(args.action, service.state(caller), risk, `lead ${lead.id}`)
    }
    case 'create-peer': {
      const peerName = required(args.peerName, 'peerName')
      const lead = leadAgent(caller, state)
      const peer = await service.createPeer(lead, peerName)
      return valueOf(args.action, service.state(caller), risk, `peer ${peer.id}`)
    }
    case 'start-task': {
      const taskId = required(args.taskId, 'taskId')
      const peerId = required(args.peerId, 'peerId')
      const lead = leadAgent(caller, state)
      const peer = peerAgent(caller, state, peerId)
      const next = await service.startTask(lead, peer, taskId)
      return valueOf(args.action, next, risk, `task ${taskId} assigned to ${peer.id}`)
    }
    case 'settle-task': {
      const taskId = required(args.taskId, 'taskId')
      const peer = peerForTask(caller, state, taskId)
      const next = await service.settleTask(peer, taskId)
      return valueOf(args.action, next, risk, `task ${taskId} settled`)
    }
    case 'dispatch': {
      const stage = required(args.stage, 'stage')
      const next = await service.dispatch(caller, stage, required(args.prompt, 'prompt'), signal)
      return valueOf(args.action, next, risk, `${stage} stage dispatched`)
    }
    case 'fix': {
      const findingId = required(args.findingId, 'findingId')
      const lead = leadAgent(caller, state)
      const next = await service.fix(lead, findingId)
      return valueOf(args.action, next, risk, `finding ${findingId} fixed`)
    }
    case 'dismiss': {
      const findingId = required(args.findingId, 'findingId')
      const reason = required(args.reason, 'reason')
      const next = await service.dismiss(caller, findingId, reason)
      return valueOf(args.action, next, risk, `finding ${findingId} dismissed`)
    }
    case 'final-review': {
      const next = await service.finalBranchReview(caller, required(args.prompt, 'prompt'), signal)
      return valueOf(args.action, next, risk, 'final branch review dispatched and recorded')
    }
    case 'final-audit': {
      const next = await service.finalBranchAudit(caller, required(args.prompt, 'prompt'), signal)
      return valueOf(args.action, next, risk, 'final branch audit dispatched and recorded')
    }
    case 'complete': {
      const next = await service.complete(caller)
      return valueOf(args.action, next, risk, 'ORC run completed')
    }
  }
}

/** Require one tool argument. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new OrcServiceError(`the orc tool needs "${name}" for this action`)
  return value
}

/**
 * Whether one caller may act for another identity in the run.
 *
 * The Supervisor and the Lead are the run's coordinators: the model request
 * that drives the workflow runs as the Supervisor, so it may address the Lead's
 * and the Peers' transitions. A Peer is not a coordinator, and a Peer's tool
 * call is refused here before the service is even asked.
 */
function isCoordinator(caller: Agent, state: OrcState): boolean {
  const id = String(caller.id)
  return state.supervisorId === id || state.leadId === id
}

/**
 * The run's Lead identity for a lead-owned action.
 *
 * The service re-validates that this identity is the run's lead; the tool only
 * resolves which live agent the action belongs to, so the Supervisor's model
 * request can drive a hierarchy whose transitions stay Lead-owned.
 */
function leadAgent(caller: Agent, state: OrcState): Agent {
  if (state.leadId === null) throw new OrcServiceError('the ORC run has no lead yet; create the lead first')
  if (!isCoordinator(caller, state)) {
    throw new WorkflowError(`authority: ${String(caller.id)} may not drive the run's lead-owned actions`)
  }
  if (state.leadId === String(caller.id)) return caller
  const lead = caller.ctx.agents.get(SessionId(state.leadId))
  if (lead === undefined) throw new OrcServiceError(`the run's lead ${state.leadId} is not live`)
  return lead
}

/** The Peer identity one action addresses. */
function peerAgent(caller: Agent, state: OrcState, peerId: string): Agent {
  if (state.peers.includes(peerId) === false) {
    throw new OrcServiceError(`peer ${peerId} was not created by this run's lead`)
  }
  if (String(caller.id) === peerId) return caller
  if (!isCoordinator(caller, state)) {
    throw new WorkflowError(`authority: ${String(caller.id)} may not drive peer ${peerId}`)
  }
  const peer = caller.ctx.agents.get(SessionId(peerId))
  if (peer === undefined) throw new OrcServiceError(`peer ${peerId} is not live`)
  return peer
}

/** The Peer that owns one task, so a settlement reaches its owning identity. */
function peerForTask(caller: Agent, state: OrcState, taskId: string): Agent {
  const task = state.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new OrcServiceError(`unknown task ${taskId}`)
  return peerAgent(caller, state, task.peerId)
}
