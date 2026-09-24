/**
 * Durable ORC lifecycle reducer.
 *
 * This module is the single authority for the Supervisor → Lead → Peer
 * hierarchy, the legal phase order, task settlement, and the review/audit/fix
 * gates. Task 8's service is the only caller: it turns user and dispatch
 * activity into {@link OrcEvent}s, commits the returned {@link OrcState}, and
 * replays the durable event log to recover after a restart.
 *
 * The reducer is pure and deterministic. It reads no wall-clock time,
 * generates no identifier, and performs no I/O: timestamps and identifiers
 * arrive on the events, so replaying the same log always produces the same
 * state. Every event carries a role (`supervisor | lead | peer | service`);
 * `service` may only report results and failures, never advance authority.
 */

import { isBlocking, parseReport, type Finding, type Report } from './report.js'

/** The lifecycle phases a run moves through. `completed` and `failed` are terminal. */
export type Phase =
  | 'spec'
  | 'plan'
  | 'implement'
  | 'review'
  | 'audit'
  | 'fix'
  | 'final-review'
  | 'final-audit'
  | 'completed'
  | 'failed'

/**
 * The kind of actor that emitted an event.
 *
 * `supervisor → lead → peer` is the authority ancestry; `service` is the
 * infrastructure that dispatches work and reports results, and may only emit
 * `*-result` and `fail` events.
 */
export type Actor = 'supervisor' | 'lead' | 'peer' | 'service'

/** Whether a final branch gate has run and how it resolved. */
export type FinalGate = 'none' | 'clean' | 'blocked'

/** The stage a request/result pair belongs to. */
export type RequestStage = 'spec' | 'plan' | 'review' | 'audit' | 'final-review' | 'final-audit'

/** One delegated task and the peer that owns it. */
export interface TaskRecord {
  id: string
  peerId: string
  status: 'started' | 'settled'
}

/** One request/result pair's correlation. */
export interface RequestRecord {
  correlationId: string
  stage: RequestStage
  consumed: boolean
}

/** One question a peer raised, and the Supervisor's answer. */
export interface QuestionRecord {
  /** Stable identity; derived by the service so a retried raise addresses the same question. */
  id: string
  /** The task whose work is blocked. */
  taskId: string
  /** The peer that raised it. */
  peerId: string
  /** What the peer needs decided. */
  question: string
  status: 'open' | 'answered'
  /** The Supervisor's answer; null while open. */
  answer: string | null
}

/** The complete lifecycle state of one ORC run. */
export interface OrcState {
  /** Empty until `start` opens the run. */
  runId: string
  started: boolean
  phase: Phase
  supervisorId: string
  leadId: string | null
  peers: string[]
  tasks: TaskRecord[]
  findings: Finding[]
  requests: RequestRecord[]
  /** Questions peers raised, in the order they were raised. */
  questions: QuestionRecord[]
  /** Whether the current implementation round earned a clean review+audit cycle. */
  taskGate: 'open' | 'passed'
  finalReview: FinalGate
  finalAudit: FinalGate
}

interface EventBase {
  version: 1
  runId: string
  /** The acting identity: the supervisor, lead, peer, or ORC service. */
  actorId: string
  /** The acting kind, which the authority rules check. */
  actor: Actor
  /** When the event was committed; supplied by the caller, never read here. */
  at: string
}

type WithCorrelation<T extends string> = EventBase & { type: T; correlationId: string }
type WithReport<T extends string> = EventBase & { type: T; correlationId: string; report: unknown }

/**
 * Every durable lifecycle event.
 *
 * The discriminant is `type`; each variant carries the identifiers the reducer
 * needs so it never has to invent one. `fix` resolves an open finding, `dismiss`
 * resolves a non-blocking one, and `fail` records a dispatch failure; they are
 * the only way to reach the `fixed`, `dismissed`, and `failed` values the plan
 * names.
 */
export type OrcEvent =
  | (EventBase & { type: 'start' })
  | WithCorrelation<'spec-request'>
  | WithCorrelation<'plan-request'>
  | WithCorrelation<'review-request'>
  | WithCorrelation<'audit-request'>
  | WithCorrelation<'final-review-request'>
  | WithCorrelation<'final-audit-request'>
  | WithCorrelation<'spec-result'>
  | WithCorrelation<'plan-result'>
  | WithReport<'review-result'>
  | WithReport<'audit-result'>
  | WithReport<'final-review-result'>
  | WithReport<'final-audit-result'>
  | (EventBase & { type: 'lead-create'; leadId: string })
  | (EventBase & { type: 'peer-create'; peerId: string })
  | (EventBase & { type: 'task-start'; taskId: string; peerId: string })
  | (EventBase & { type: 'task-settle'; taskId: string })
  | (EventBase & { type: 'question-raise'; questionId: string; taskId: string; question: string })
  | (EventBase & { type: 'question-answer'; questionId: string; answer: string })
  | (EventBase & { type: 'fix'; findingId: string })
  | (EventBase & { type: 'dismiss'; findingId: string; reason: string })
  | (EventBase & { type: 'complete' })
  | (EventBase & { type: 'fail'; reason: string })

/** A rejected lifecycle transition. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

type EventType = OrcEvent['type']

type PhaseGate = 'not-started' | readonly Phase[]

interface Transition<E extends OrcEvent> {
  /** Roles allowed to emit the event. */
  readonly roles: readonly Actor[]
  /** Phases the event may be emitted from, or `not-started` for `start`. */
  readonly from: PhaseGate
  /** Identity binding checked before the phase gate. */
  readonly authority?: (state: OrcState, event: E) => void
  /** The pure transition itself. */
  readonly apply: (state: OrcState, event: E) => OrcState
}

type TransitionTable = { readonly [T in EventType]: Transition<Extract<OrcEvent, { type: T }>> }

const NON_TERMINAL_PHASES: readonly Phase[] = [
  'spec',
  'plan',
  'implement',
  'review',
  'audit',
  'fix',
  'final-review',
  'final-audit',
]

/** The state before any event: unopened, with the phase `start` will enter. */
export function initialState(): OrcState {
  return {
    runId: '',
    started: false,
    phase: 'spec',
    supervisorId: '',
    leadId: null,
    peers: [],
    tasks: [],
    findings: [],
    requests: [],
    questions: [],
    taskGate: 'open',
    finalReview: 'none',
    finalAudit: 'none',
  }
}

function requireSupervisor(state: OrcState, event: OrcEvent): void {
  if (state.supervisorId !== event.actorId) throw new WorkflowError(`authority: ${event.actorId} is not the run's supervisor`)
}

function requireLead(state: OrcState, event: OrcEvent): void {
  if (state.leadId === null) throw new WorkflowError('authority: the run has no lead')
  if (state.leadId !== event.actorId) throw new WorkflowError(`authority: ${event.actorId} is not the run's lead`)
}

function openRequest(state: OrcState, correlationId: string, stage: RequestStage): OrcState {
  if (state.requests.some(request => request.correlationId === correlationId))
    throw new WorkflowError(`duplicate correlation id ${correlationId}; every request needs its own id`)
  return { ...state, requests: [...state.requests, { correlationId, stage, consumed: false }] }
}

function consumeRequest(state: OrcState, correlationId: string, stage: RequestStage): OrcState {
  const pending = state.requests.find(
    request => request.correlationId === correlationId && request.stage === stage && !request.consumed,
  )
  if (!pending) throw new WorkflowError(`no pending ${stage} request for correlation id ${correlationId}`)
  return {
    ...state,
    requests: state.requests.map(request => (request === pending ? { ...request, consumed: true } : request)),
  }
}

function recordFindings(state: OrcState, report: Report): OrcState {
  const known = new Set(state.findings.map(finding => finding.id))
  for (const finding of report.findings) {
    if (known.has(finding.id)) throw new WorkflowError(`duplicate finding id ${finding.id}; finding ids are unique within a run`)
    known.add(finding.id)
  }
  return { ...state, findings: [...state.findings, ...report.findings] }
}

function requireOpenFinding(state: OrcState, findingId: string): Finding {
  const finding = state.findings.find(candidate => candidate.id === findingId)
  if (!finding) throw new WorkflowError(`unknown finding ${findingId}`)
  if (finding.status !== 'open') throw new WorkflowError(`finding ${findingId} is already ${finding.status}`)
  return finding
}

function requireAllTasksSettled(state: OrcState): void {
  const unsettled = state.tasks.filter(task => task.status !== 'settled')
  if (unsettled.length > 0)
    throw new WorkflowError(
      `phase: the final branch review requires every task settled; ${unsettled.length} task(s) are still open`,
    )
}

const hasOpenBlocking = (state: OrcState): boolean =>
  state.findings.some(finding => finding.status === 'open' && isBlocking(finding.severity))

const hasOpenQuestion = (state: OrcState): boolean => state.questions.some(question => question.status === 'open')

function completionBlockers(state: OrcState): string[] {
  const blockers: string[] = []
  const unsettled = state.tasks.filter(task => task.status !== 'settled').length
  if (unsettled > 0) blockers.push(`${unsettled} task(s) are not settled`)
  if (state.finalReview !== 'clean') blockers.push(`final review is ${state.finalReview}`)
  if (state.finalAudit !== 'clean') blockers.push(`final audit is ${state.finalAudit}`)
  const open = state.findings.filter(finding => finding.status === 'open' && isBlocking(finding.severity)).length
  if (open > 0) blockers.push(`${open} blocking finding(s) are unresolved`)
  const unanswered = state.questions.filter(question => question.status === 'open').length
  if (unanswered > 0) blockers.push(`${unanswered} question(s) are unanswered`)
  return blockers
}

/**
 * The single completion predicate.
 *
 * A run may complete only when every task has settled, both final branch gates
 * are clean, no blocking finding is still open, and no question is unanswered.
 * A missing, malformed, or failed final audit leaves `finalAudit` short of
 * `clean`, so it blocks.
 */
export function canComplete(state: OrcState): boolean {
  return (
    state.tasks.every(task => task.status === 'settled') &&
    state.finalReview === 'clean' &&
    state.finalAudit === 'clean' &&
    !state.findings.some(finding => finding.status === 'open' && isBlocking(finding.severity)) &&
    !state.questions.some(question => question.status === 'open')
  )
}

const TRANSITIONS: TransitionTable = {
  start: {
    roles: ['supervisor'],
    from: 'not-started',
    apply: (state, event) => ({ ...state, runId: event.runId, started: true, supervisorId: event.actorId, phase: 'spec' }),
  },
  'spec-request': {
    roles: ['supervisor'],
    from: ['spec'],
    authority: requireSupervisor,
    apply: (state, event) => openRequest(state, event.correlationId, 'spec'),
  },
  'spec-result': {
    roles: ['service'],
    from: ['spec'],
    apply: (state, event) => ({ ...consumeRequest(state, event.correlationId, 'spec'), phase: 'plan' }),
  },
  'plan-request': {
    roles: ['supervisor'],
    from: ['plan'],
    authority: requireSupervisor,
    apply: (state, event) => openRequest(state, event.correlationId, 'plan'),
  },
  'plan-result': {
    roles: ['service'],
    from: ['plan'],
    apply: (state, event) => ({ ...consumeRequest(state, event.correlationId, 'plan'), phase: 'implement' }),
  },
  'lead-create': {
    roles: ['supervisor'],
    from: ['implement'],
    authority: requireSupervisor,
    apply: (state, event) => {
      if (state.leadId !== null) throw new WorkflowError('authority: a run has exactly one lead')
      return { ...state, leadId: event.leadId }
    },
  },
  'peer-create': {
    roles: ['lead'],
    from: ['implement'],
    authority: requireLead,
    apply: (state, event) => {
      if (state.peers.includes(event.peerId)) throw new WorkflowError(`duplicate peer id ${event.peerId}`)
      return { ...state, peers: [...state.peers, event.peerId] }
    },
  },
  'task-start': {
    roles: ['lead'],
    from: ['implement'],
    authority: requireLead,
    apply: (state, event) => {
      if (!state.peers.includes(event.peerId))
        throw new WorkflowError(`authority: peer ${event.peerId} was not created by the lead`)
      if (state.tasks.some(task => task.id === event.taskId)) throw new WorkflowError(`duplicate task id ${event.taskId}`)
      return {
        ...state,
        tasks: [...state.tasks, { id: event.taskId, peerId: event.peerId, status: 'started' }],
        taskGate: 'open',
      }
    },
  },
  'task-settle': {
    roles: ['peer'],
    from: ['implement'],
    apply: (state, event) => {
      const task = state.tasks.find(candidate => candidate.id === event.taskId)
      if (!task) throw new WorkflowError(`unknown task ${event.taskId}`)
      if (task.peerId !== event.actorId)
        throw new WorkflowError(`authority: peer ${event.actorId} may not settle task ${event.taskId} assigned to ${task.peerId}`)
      if (task.status === 'settled') throw new WorkflowError(`task ${event.taskId} is already settled`)
      if (state.questions.some(question => question.status === 'open' && question.taskId === event.taskId))
        throw new WorkflowError(`blocking: task ${event.taskId} has an open question; answer it before settling`)
      return { ...state, tasks: state.tasks.map(candidate => (candidate.id === task.id ? { ...candidate, status: 'settled' } : candidate)) }
    },
  },
  'question-raise': {
    roles: ['peer'],
    from: ['implement'],
    apply: (state, event) => {
      const task = state.tasks.find(candidate => candidate.id === event.taskId)
      if (!task) throw new WorkflowError(`unknown task ${event.taskId}`)
      if (task.peerId !== event.actorId)
        throw new WorkflowError(
          `authority: peer ${event.actorId} may not raise a question on task ${event.taskId} assigned to ${task.peerId}`,
        )
      if (task.status === 'settled') throw new WorkflowError(`phase: task ${event.taskId} is already settled`)
      if (event.question.trim() === '') throw new WorkflowError('a question requires non-empty text')
      if (state.questions.some(question => question.id === event.questionId))
        throw new WorkflowError(`duplicate question id ${event.questionId}`)
      return {
        ...state,
        questions: [
          ...state.questions,
          {
            id: event.questionId,
            taskId: event.taskId,
            peerId: event.actorId,
            question: event.question,
            status: 'open',
            answer: null,
          },
        ],
      }
    },
  },
  'question-answer': {
    roles: ['supervisor'],
    from: NON_TERMINAL_PHASES,
    authority: requireSupervisor,
    apply: (state, event) => {
      const question = state.questions.find(candidate => candidate.id === event.questionId)
      if (!question) throw new WorkflowError(`unknown question ${event.questionId}`)
      if (question.status !== 'open')
        throw new WorkflowError(`question ${event.questionId} is already ${question.status}`)
      if (event.answer.trim() === '') throw new WorkflowError('an answer requires non-empty text')
      return {
        ...state,
        questions: state.questions.map(candidate =>
          candidate.id === question.id ? { ...candidate, status: 'answered', answer: event.answer } : candidate,
        ),
      }
    },
  },
  'review-request': {
    roles: ['lead'],
    from: ['implement', 'fix'],
    authority: requireLead,
    apply: (state, event) => {
      if (hasOpenBlocking(state))
        throw new WorkflowError('blocking: review cannot start while a blocking finding is open; fix it first')
      if (hasOpenQuestion(state))
        throw new WorkflowError('blocking: review cannot start while a question is open; answer it first')
      return { ...openRequest(state, event.correlationId, 'review'), phase: 'review' }
    },
  },
  'review-result': {
    roles: ['service'],
    from: ['review'],
    apply: (state, event) => {
      const report = parseReport(event.report, 'review')
      const next = recordFindings(consumeRequest(state, event.correlationId, 'review'), report)
      return { ...next, phase: hasOpenBlocking(next) ? 'fix' : 'audit' }
    },
  },
  'audit-request': {
    roles: ['lead'],
    from: ['audit'],
    authority: requireLead,
    apply: (state, event) => openRequest(state, event.correlationId, 'audit'),
  },
  'audit-result': {
    roles: ['service'],
    from: ['audit'],
    apply: (state, event) => {
      const report = parseReport(event.report, 'audit')
      const next = recordFindings(consumeRequest(state, event.correlationId, 'audit'), report)
      const blocking = hasOpenBlocking(next)
      return { ...next, phase: blocking ? 'fix' : 'implement', taskGate: blocking ? 'open' : 'passed' }
    },
  },
  'final-review-request': {
    roles: ['supervisor'],
    from: ['implement'],
    authority: requireSupervisor,
    apply: (state, event) => {
      // The question gate precedes the settled-task gate: an open question always
      // leaves its own task unsettled, so checking it second would make it dead code.
      if (hasOpenQuestion(state))
        throw new WorkflowError('blocking: the final branch review requires every question answered')
      requireAllTasksSettled(state)
      if (state.taskGate !== 'passed')
        throw new WorkflowError('phase: the final branch review requires a completed task-level review and audit cycle')
      return { ...openRequest(state, event.correlationId, 'final-review'), phase: 'final-review' }
    },
  },
  'final-review-result': {
    roles: ['service'],
    from: ['final-review'],
    apply: (state, event) => {
      const report = parseReport(event.report, 'review')
      const next = recordFindings(consumeRequest(state, event.correlationId, 'final-review'), report)
      const blocking = hasOpenBlocking(next)
      return {
        ...next,
        finalReview: blocking ? 'blocked' : 'clean',
        finalAudit: 'none',
        phase: blocking ? 'fix' : 'final-audit',
      }
    },
  },
  'final-audit-request': {
    roles: ['supervisor'],
    from: ['final-audit'],
    authority: requireSupervisor,
    apply: (state, event) => {
      if (state.finalAudit !== 'none')
        throw new WorkflowError('phase: the final audit already ran for this final review')
      return openRequest(state, event.correlationId, 'final-audit')
    },
  },
  'final-audit-result': {
    roles: ['service'],
    from: ['final-audit'],
    apply: (state, event) => {
      const report = parseReport(event.report, 'audit')
      const next = recordFindings(consumeRequest(state, event.correlationId, 'final-audit'), report)
      const blocking = hasOpenBlocking(next)
      return { ...next, finalAudit: blocking ? 'blocked' : 'clean', phase: blocking ? 'fix' : 'final-audit' }
    },
  },
  fix: {
    roles: ['lead'],
    from: ['fix'],
    authority: requireLead,
    apply: (state, event) => {
      const finding = requireOpenFinding(state, event.findingId)
      return {
        ...state,
        findings: state.findings.map(candidate => (candidate.id === finding.id ? { ...candidate, status: 'fixed' } : candidate)),
        taskGate: 'open',
        finalReview: 'none',
        finalAudit: 'none',
      }
    },
  },
  dismiss: {
    roles: ['supervisor'],
    from: ['implement', 'fix'],
    authority: requireSupervisor,
    apply: (state, event) => {
      const finding = requireOpenFinding(state, event.findingId)
      if (isBlocking(finding.severity))
        throw new WorkflowError(`blocking: ${finding.severity} finding ${finding.id} blocks until it is fixed and re-reviewed`)
      if (event.reason.trim() === '') throw new WorkflowError('dismiss requires a non-empty reason')
      return {
        ...state,
        findings: state.findings.map(candidate =>
          candidate.id === finding.id ? { ...candidate, status: 'dismissed' } : candidate,
        ),
      }
    },
  },
  complete: {
    roles: ['supervisor'],
    from: ['final-audit'],
    authority: requireSupervisor,
    apply: state => {
      if (!canComplete(state))
        throw new WorkflowError(`blocking: cannot complete (${completionBlockers(state).join('; ')})`)
      return { ...state, phase: 'completed' }
    },
  },
  fail: {
    roles: ['supervisor', 'service'],
    from: NON_TERMINAL_PHASES,
    apply: state => ({ ...state, phase: 'failed' }),
  },
}

/**
 * Apply one durable event to the run state.
 *
 * @throws {@link WorkflowError} for an unknown version or type, a mismatched
 * run, a wrong actor, a skipped phase, a duplicate correlation or finding id,
 * a result without a matching request, or an unresolved blocking finding.
 * @throws {@link import('./report.js').ReportError} for a malformed report.
 */
export function reduce(state: OrcState, event: OrcEvent): OrcState {
  if (event.version !== 1) throw new WorkflowError(`version: unsupported event version ${String(event.version)}; expected 1`)
  const transition = TRANSITIONS[event.type] as Transition<OrcEvent> | undefined
  if (!transition) throw new WorkflowError(`unknown: unsupported event type ${String((event as { type: unknown }).type)}`)
  if (!state.started && event.type !== 'start')
    throw new WorkflowError(`phase: ${event.type} cannot be applied before the run starts`)
  if (state.started && event.runId !== state.runId)
    throw new WorkflowError(`run: event belongs to run ${event.runId}, not ${state.runId}`)
  if (!transition.roles.includes(event.actor))
    throw new WorkflowError(`authority: ${event.actor} may not emit ${event.type}`)
  transition.authority?.(state, event)
  if (transition.from === 'not-started') {
    if (state.started) throw new WorkflowError(`phase: ${event.type} is only valid before the run starts`)
  } else if (!transition.from.includes(state.phase)) {
    throw new WorkflowError(`phase: ${event.type} is not allowed in phase ${state.phase}`)
  }
  return transition.apply(state, event)
}

/** Fold a durable event log into the current run state. */
export function replay(events: readonly OrcEvent[]): OrcState {
  return events.reduce(reduce, initialState())
}
