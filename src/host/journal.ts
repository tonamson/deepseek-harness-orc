/**
 * Durable ORC journal.
 *
 * The journal is the only writer of `orc/*` session events and the only reader
 * of the run state folded from them. Two record families share the durable log:
 *
 * - {@link OrcEvent} reducer events, logged as `orc/<event type>` and folded by
 *   the pure reducer. They carry the lifecycle the service is the sole caller of.
 * - {@link OrcStartRecord}, the `orc/start` event carrying the run's activation
 *   risk. It is the durable classification a recovered service routes with, so a
 *   run whose only committed record is its start still dispatches.
 * - {@link OrcRouteRecord} decisions, logged as `orc/route` before the dispatch
 *   they authorize. They record provider/CLI, model, effort, stage, risk,
 *   catalog and benchmark identities, and the selection reason — never a
 *   credential.
 * - {@link OrcReportRejectionRecord} refusals, logged as `orc/report-rejected`
 *   when a dispatched review or audit answer is not a valid report. They are
 *   the visible half of a non-terminal refusal: the run keeps its phase and its
 *   pending request, and the record says which stage was refused, why, and which
 *   request a retry resumes.
 *
 * Reads go through DSH's public session-projection seam, never a direct session
 * event read: the `orc` projection folds the committed log, so a resumed or
 * forked session rebuilds the same run state, and a checkpointed projection
 * cache can seed it. Writes append to the Supervisor's exact session and await
 * `ctx.sessions.flush` before the commit resolves, so a caller that awaits
 * {@link OrcJournal.commit} never observes a record before it is durable.
 *
 * Appends are serialized per session: concurrent service mutations cannot
 * interleave their events, and a rejected append never breaks the chain for the
 * next one.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import { z, type ZodType } from 'zod'
import type { RiskDecision } from '../domain/risk.js'
import type { RouteDecision } from '../domain/routing.js'
import { initialState, reduce, type OrcEvent, type OrcState, type RequestStage } from '../domain/workflow.js'

/** The event-name prefix every durable ORC record is logged under. */
export const ORC_EVENT_PREFIX = 'orc/'

/** The event name of one durable route decision. */
export const ORC_ROUTE_EVENT = 'orc/route'

/** The event name of one durable refused report. */
export const ORC_REPORT_REJECTED_EVENT = 'orc/report-rejected'

/**
 * One durable route decision.
 *
 * Logged before the dispatch it authorizes, so the exact evidence behind every
 * routed stage is replayable. `decision.route` holds a provider/CLI reference
 * and a model/effort pair; no field can carry a credential.
 */
export interface OrcRouteRecord {
  version: 1
  type: 'orc/route'
  runId: string
  /** When the decision was committed; supplied by the caller, never read here. */
  at: string
  decision: RouteDecision
}

/**
 * One durable refusal of a review or audit answer.
 *
 * A malformed report is not a run failure: the run keeps its phase and its
 * still-pending request, so the same stage can be dispatched again once the
 * cause is fixed — the shape the routing refusals already have. The refusal is
 * still committed, with the stage, the correlation of the request the retry
 * resumes, and an ORC-owned reason, so the attempt is visible in the durable log
 * instead of being silently retried.
 *
 * Like {@link OrcRouteRecord} it is not a reducer event: it records what the
 * service observed, and folding it leaves the run state untouched.
 */
export interface OrcReportRejectionRecord {
  version: 1
  type: 'orc/report-rejected'
  runId: string
  /** When the refusal was committed; supplied by the caller, never read here. */
  at: string
  /** The stage whose answer was refused. */
  stage: RequestStage
  /** The correlation of the pending request a retry resumes. */
  correlationId: string
  /** ORC-owned, bounded, credential-free reason for the refusal. */
  reason: string
}

/**
 * The durable start record.
 *
 * The reducer's `start` event plus the activation classification that opened the
 * run. The risk is part of the record rather than process memory because it is
 * the routing input for every later dispatch: a resumed service whose only
 * committed record is this one must still be able to route, and the replayed
 * activation gate must not be able to replace the classification the run
 * started under.
 *
 * A log written before this field existed carries a plain `start` event and is
 * still a valid {@link OrcRecord}; the service heals such a run from its
 * replayed gate or its first committed route decision. That legacy shape is why
 * the field is optional here: the union must still describe a log this build
 * did not write.
 */
export interface OrcStartRecord extends Extract<OrcEvent, { type: 'start' }> {
  /** The classification the run opened under; absent only in a legacy log. */
  risk?: RiskDecision
}

/** Every durable ORC record. */
export type OrcRecord = OrcEvent | OrcStartRecord | OrcRouteRecord | OrcReportRejectionRecord

/** Whether one committed record is a start record carrying the classification. */
export const hasStartRisk = (record: OrcRecord): record is OrcStartRecord & { risk: RiskDecision } =>
  record.type === 'start' && 'risk' in record && record.risk !== undefined

/** The `orc/*` session event names one durable record can be logged under. */
export type OrcEventName = `orc/${OrcEvent['type']}` | 'orc/route' | 'orc/report-rejected'

/**
 * One durable record as it is logged: the `orc/*` event name and its payload.
 *
 * The name carries the ORC namespace; the payload carries its own `version` and
 * the reducer's own `type` discriminator, so a record is self-describing on
 * replay.
 */
export interface OrcJournalRecord {
  readonly type: OrcEventName
  readonly data: OrcRecord
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'orc/start': OrcStartRecord
    'orc/spec-request': Extract<OrcEvent, { type: 'spec-request' }>
    'orc/plan-request': Extract<OrcEvent, { type: 'plan-request' }>
    'orc/review-request': Extract<OrcEvent, { type: 'review-request' }>
    'orc/audit-request': Extract<OrcEvent, { type: 'audit-request' }>
    'orc/final-review-request': Extract<OrcEvent, { type: 'final-review-request' }>
    'orc/final-audit-request': Extract<OrcEvent, { type: 'final-audit-request' }>
    'orc/spec-result': Extract<OrcEvent, { type: 'spec-result' }>
    'orc/plan-result': Extract<OrcEvent, { type: 'plan-result' }>
    'orc/review-result': Extract<OrcEvent, { type: 'review-result' }>
    'orc/audit-result': Extract<OrcEvent, { type: 'audit-result' }>
    'orc/final-review-result': Extract<OrcEvent, { type: 'final-review-result' }>
    'orc/final-audit-result': Extract<OrcEvent, { type: 'final-audit-result' }>
    'orc/lead-create': Extract<OrcEvent, { type: 'lead-create' }>
    'orc/peer-create': Extract<OrcEvent, { type: 'peer-create' }>
    'orc/task-start': Extract<OrcEvent, { type: 'task-start' }>
    'orc/task-settle': Extract<OrcEvent, { type: 'task-settle' }>
    'orc/fix': Extract<OrcEvent, { type: 'fix' }>
    'orc/dismiss': Extract<OrcEvent, { type: 'dismiss' }>
    'orc/complete': Extract<OrcEvent, { type: 'complete' }>
    'orc/fail': Extract<OrcEvent, { type: 'fail' }>
    /** One durable route decision. */
    'orc/route': OrcRouteRecord
    /** One durable refused review or audit report. */
    'orc/report-rejected': OrcReportRejectionRecord
  }
}

/** The host-only `orc` projection state: the run state plus its committed decisions. */
export interface OrcProjectionState {
  /** Run state folded from the committed reducer events. */
  run: OrcState
  /**
   * The activation risk recorded with the run's `orc/start` record, or `null`.
   *
   * It is the durable half of the classification: a recovered service routes
   * with it before any route decision exists, so a start-only log is still a
   * run a dispatch can be served from.
   */
  risk: RiskDecision | null
  /**
   * Committed route decisions, in commit order.
   *
   * They are carried here because a recovered service must re-derive facts the
   * reducer's own state has no field for: the review backend an audit must stay
   * independent from, and (for a log written before the start record carried
   * the classification) the run's activation risk.
   */
  decisions: RouteDecision[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Durable ORC run state, folded from `orc/*` session events. */
    orc: OrcProjectionState
  }
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
const REPORT_STAGES = ['review', 'audit'] as const
const REQUEST_STAGES = ['spec', 'plan', 'review', 'audit', 'final-review', 'final-audit'] as const
const PHASES = [
  'spec',
  'plan',
  'implement',
  'review',
  'audit',
  'fix',
  'final-review',
  'final-audit',
  'completed',
  'failed',
] as const

const ROUTE_KINDS = ['provider', 'cli'] as const

/** The classification that opened a run; the durable routing input. */
const RiskSchema = z.object({
  path: z.enum(['direct', 'orc']),
  risk: z.enum(['low', 'high']),
  reasons: z.array(z.string()),
})

/** One route reference inside a persisted decision. */
const RouteSchema = z.union([
  z.object({
    kind: z.literal('provider'),
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
  }),
  z.object({
    kind: z.literal('cli'),
    cli: z.enum(['codex', 'claude']),
    model: z.string(),
    effort: z.string(),
  }),
])

/**
 * The persisted-state contract.
 *
 * It validates a projection-cache row before it seeds a fold: a row from
 * another `stateVersion`, or one whose shape this build does not recognize, is
 * refused by the registry rather than folded into a wrong run.
 */
const ProjectionSchema = z.object({
  run: z.object({
    runId: z.string(),
    started: z.boolean(),
    phase: z.enum(PHASES),
    supervisorId: z.string(),
    leadId: z.union([z.string(), z.null()]),
    peers: z.array(z.string()),
    tasks: z.array(z.object({
      id: z.string(),
      peerId: z.string(),
      status: z.enum(['started', 'settled']),
    })),
    findings: z.array(z.object({
      id: z.string(),
      severity: z.enum(SEVERITIES),
      stage: z.enum(REPORT_STAGES),
      file: z.string(),
      line: z.number(),
      evidence: z.string(),
      remediation: z.string(),
      status: z.enum(['open', 'fixed', 'dismissed']),
    })),
    requests: z.array(z.object({
      correlationId: z.string(),
      stage: z.enum(REQUEST_STAGES),
      consumed: z.boolean(),
    })),
    taskGate: z.enum(['open', 'passed']),
    finalReview: z.enum(['none', 'clean', 'blocked']),
    finalAudit: z.enum(['none', 'clean', 'blocked']),
  }),
  risk: z.union([RiskSchema, z.null()]),
  decisions: z.array(z.object({
    route: RouteSchema,
    stage: z.enum(['code', 'spec', 'plan', 'review', 'audit']),
    risk: RiskSchema,
    catalogId: z.string(),
    benchmarkId: z.union([z.string(), z.null()]),
    reason: z.string(),
    estimatedCostUsd: z.number(),
  })),
})

/** Whether one committed session event is a durable ORC record. */
export const isOrcSessionEvent = (event: SessionEvent): boolean => event.type.startsWith(ORC_EVENT_PREFIX)

/**
 * The session event name one durable record is logged under.
 *
 * A reducer event's name is its own type under the `orc/` namespace; the two
 * observation records carry their full event name as their type, exactly as
 * they are logged.
 */
export const orcEventName = (record: OrcRecord): OrcEventName =>
  record.type === ORC_ROUTE_EVENT || record.type === ORC_REPORT_REJECTED_EVENT
    ? record.type
    : `orc/${record.type}`

/**
 * Fold one committed session event into the ORC projection state.
 *
 * Unrelated events return the same state reference, so the registry's
 * `Object.is` cut produces no downstream work. A reducer refusal propagates:
 * the log is the source of truth, so a state that cannot be folded must fail
 * loud rather than resume from a guessed state.
 */
function applyRecord(state: OrcProjectionState, event: SessionEvent): OrcProjectionState {
  if (!isOrcSessionEvent(event)) return state
  const record = event.data as OrcRecord
  if (record.type === ORC_ROUTE_EVENT) {
    return { ...state, decisions: [...state.decisions, record.decision] }
  }
  // A refused report is an observation, not a lifecycle transition: it is
  // committed so the attempt is visible, and folding it leaves the run exactly
  // as it was, so the pending request is still there for a retry to resume.
  if (record.type === ORC_REPORT_REJECTED_EVENT) return state
  const run = reduce(state.run, record)
  // A start record written before the classification became durable carries no
  // risk; the state keeps the last one it saw instead of clearing it.
  if (hasStartRisk(record)) return { ...state, run, risk: record.risk }
  return { ...state, run }
}

/** A refused journal operation. */
export class OrcJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcJournalError'
  }
}

/** The durable record seam the service consumes. */
export interface OrcJournal {
  /** Fold one session's committed ORC records into its run state. */
  state(session: Session): OrcState
  /**
   * The activation risk recorded with the run's start record, or `null`.
   *
   * `null` means the log predates the durable classification (or the run has
   * not started); the service then falls back to its replayed gate and to the
   * first committed route decision.
   */
  risk(session: Session): RiskDecision | null
  /** The committed route decisions for one session's run, in commit order. */
  decisions(session: Session): readonly RouteDecision[]
  /**
   * Commit one record to the run's exact session.
   *
   * Resolves only after the append is published and `ctx.sessions.flush` has
   * settled, so an awaited commit is durable.
   */
  commit(session: Session, record: OrcRecord): Promise<void>
}

/**
 * The Cordis effect disposer {@link installOrcJournal} returns, carrying the
 * journal it installed so the host can wire it into the service.
 */
export type OrcJournalInstall = (() => void) & { readonly journal: OrcJournal }

/** The session-projection seam the journal reads; `ctx.sessionProjections` satisfies it. */
export interface OrcProjectionPort {
  register(definition: {
    key: 'orc'
    stateSchema: ZodType<OrcProjectionState>
    init(header: SessionHeader, inheritedEventCount: SessionLogOffset): OrcProjectionState
    apply(state: OrcProjectionState, event: SessionEvent): OrcProjectionState
    stateVersion: number
  }): () => void
  stateOf(session: Session, key: 'orc'): OrcProjectionState | undefined
}

/** The session-durability seam the journal awaits; `ctx.sessions.flush` satisfies it. */
export interface OrcSessionPort {
  flush(session: Session): Promise<unknown>
}

/**
 * The session-backed journal.
 *
 * Serialization is per session id: every commit for one run is appended in
 * order, and the chain survives a rejected commit so one failed flush cannot
 * wedge the run.
 */
export class SessionOrcJournal implements OrcJournal {
  private readonly projections: OrcProjectionPort
  private readonly sessions: OrcSessionPort
  private readonly tails = new Map<string, Promise<void>>()

  constructor(projections: OrcProjectionPort, sessions: OrcSessionPort) {
    this.projections = projections
    this.sessions = sessions
  }

  /** Read the folded projection state, failing loud when the seam is absent. */
  private projection(session: Session): OrcProjectionState {
    const state = this.projections.stateOf(session, 'orc')
    if (state === undefined) {
      throw new OrcJournalError('the ORC session projection is not registered; ORC cannot read its durable run state')
    }
    return state
  }

  state(session: Session): OrcState {
    return this.projection(session).run
  }

  risk(session: Session): RiskDecision | null {
    return this.projection(session).risk
  }

  decisions(session: Session): readonly RouteDecision[] {
    return this.projection(session).decisions
  }

  commit(session: Session, record: OrcRecord): Promise<void> {
    const key = String(session.id)
    const prior = this.tails.get(key) ?? Promise.resolve()
    const next = prior.then(async () => {
      if (record.type === ORC_ROUTE_EVENT) session.append(ORC_ROUTE_EVENT, record)
      else if (record.type === ORC_REPORT_REJECTED_EVENT) session.append(ORC_REPORT_REJECTED_EVENT, record)
      else session.append(orcEventName(record), record)
      await this.sessions.flush(session)
    })
    // The chain continues past a rejected commit; only the caller sees the failure.
    this.tails.set(key, next.catch(() => {}))
    return next
  }
}

/**
 * Install the durable ORC journal on one Cordis context.
 *
 * Registers the host-only `orc` projection as a fiber-owned effect, so
 * unloading the plugin removes the projection key with the rest of ORC's
 * contributions.
 *
 * The projection is disposed as part of the plugin unload, and a child startup
 * that unload cancels settles only afterwards, so a blocking write issued from
 * that settlement cannot rely on this key still existing. The service keeps its
 * own phase mirror for exactly that guard (see `OrcService.block`); the durable
 * session is still writable, so the record itself always lands.
 *
 * @param ctx - the calling plugin's context; it must carry `sessionProjections`
 *   and `sessions`, which the `orc-host` Loader row declares as injections.
 * @returns the Cordis effect disposer, with the live journal attached.
 */
export function installOrcJournal(ctx: Context): OrcJournalInstall {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) {
    throw new OrcJournalError('the DSH session-projection registry is not mounted; ORC needs it to read durable run state')
  }
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new OrcJournalError('the DSH session store is not mounted; ORC needs it to flush durable run state')
  }
  const disposeEffect = ctx.effect(() => {
    return projections.register({
      key: 'orc',
      stateSchema: ProjectionSchema,
      init: () => ({ run: initialState(), risk: null, decisions: [] }),
      apply: applyRecord,
      stateVersion: 2,
    })
  }, 'orc.projection')
  return Object.assign(() => {
    void disposeEffect()
  }, { journal: new SessionOrcJournal(projections, sessions) })
}
