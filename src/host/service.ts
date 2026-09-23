/**
 * ORC run service.
 *
 * The service is the single composition point between the pure domain and DSH:
 * it is the only caller of `reduce`, the only writer of `orc/*` session events
 * (through the journal), and the only place that turns user and model activity
 * into durable lifecycle events.
 *
 * Rules that shape the code:
 *
 * - Authority is validated by the reducer, not by prompt text. Every method
 *   derives the caller's role from the run's durable state and emits the event
 *   the reducer's authority table expects; an agent outside the run is refused
 *   before anything is logged, and a wrong role is refused by the reducer.
 * - A request event is committed before the delegated run starts, and a result
 *   event before the next phase becomes visible. A caller that awaits a service
 *   method therefore never observes a phase its result has not reached.
 * - Mutations are serialized per run, so concurrent tool calls cannot
 *   interleave their transitions, and every stage dispatch re-reads the
 *   committed state instead of trusting a cached copy.
 * - Correlations are committed identities: a stage whose request is committed
 *   but whose result is missing is *resumed* under the same correlation id
 *   rather than logged again, so a replayed dispatch cannot duplicate an
 *   already-correlated delegation. A later cycle of the same stage allocates a
 *   fresh id from the committed request count.
 * - A dispatch is refused unless a green connection result bound to the exact
 *   route key and current connection revision exists; the service verifies the
 *   route itself when none is recorded (R23). There is no fallback route.
 * - Every route decision is logged, credential-free, before the run it
 *   authorizes, and the committed decisions are what recovery reads back.
 * - Any child startup, route, or dispatch failure appends the reducer's only
 *   blocking event (`fail`) and rethrows, so a failed stage is never
 *   represented as progress.
 */

import { createHash } from 'node:crypto'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ContinuableStart, ContinuableStartSpec, SubagentCapabilities } from '@deepseek-ai/dsh-subagent'
import { configRevision, routeKey } from '../domain/config.js'
import type { BenchmarkSnapshot } from '../domain/evidence.js'
import { parseReport } from '../domain/report.js'
import type { RiskDecision } from '../domain/risk.js'
import { selectRoute, type RouteDecision } from '../domain/routing.js'
import type {
  CatalogEntry,
  CatalogSnapshot,
  CliName,
  CliRoute,
  ProviderRoute,
  Route,
  Stage,
} from '../domain/types.js'
import { WorkflowError, reduce, type Actor, type OrcEvent, type OrcState } from '../domain/workflow.js'
import { CliError, type CliProbe } from './cli.js'
import { ORC_ROUTE_EVENT, type OrcJournal, type OrcStartRecord } from './journal.js'
import type { ConnectionResult } from './provider.js'
import type { OrcSettingsBridge } from './settings.js'

/** The DSH subagent provider ORC creates its continuable children with. */
export const ORC_CHILD_PROVIDER = 'spawn'

/** The label ORC gives its lead child. */
export const ORC_LEAD_LABEL = 'ORC lead'

/** The label ORC gives one peer child. */
export const orcPeerLabel = (name: string): string => `ORC peer ${name}`

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The ORC run service, provided by the `orc-host` Loader row.
     *
     * Declared here so the Remote face injects the exact service and this
     * package owns the name it publishes.
     */
    orc: OrcService
  }
}

/** A refused service operation. */
export class OrcServiceError extends Error {
  /** Whether the failure blocks the run; a blocking message is prefixed `blocking`. */
  readonly blocking: boolean

  constructor(message: string, blocking = false) {
    super(blocking ? `blocking: ${message}` : message)
    this.name = 'OrcServiceError'
    this.blocking = blocking
  }
}

/** One recorded connection test, safe to cross the Remote boundary. */
export interface OrcConnection {
  /** Exact route key the test was bound to. */
  readonly routeKey: string
  /** Connection revision in force when the test ran. */
  readonly revision: string
  readonly testedAt: string
  readonly ok: boolean
  /** ORC-owned failure code, or `''` when the test passed. */
  readonly code: string
  /** Redacted CLI diagnostic, or `''`. */
  readonly diagnostic: string
}

/** The continuable-child seam; `ctx.subagents` satisfies it. */
export interface OrcSubagentPort {
  getProvider(name: string): {
    readonly capabilities: SubagentCapabilities
    readonly prepareContinuable?: (...args: never[]) => unknown
  } | undefined
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
}

/** The live-agent lookup seam; `ctx.agents` satisfies it. */
export interface OrcAgentPort {
  get(id: SessionId): Agent | undefined
}

/** The configured-provider seam; Task 5's `ProviderAdapter` satisfies it. */
export interface OrcProviderPort {
  catalog(provider: string): Promise<CatalogSnapshot>
  test(route: ProviderRoute, revision: string, signal: AbortSignal): Promise<ConnectionResult>
  run(
    route: ProviderRoute,
    prompt: string,
    revision: string,
    test: ConnectionResult,
    signal: AbortSignal,
  ): Promise<string>
}

/** The host-CLI seam; Task 6's `CliAdapter` satisfies it. */
export interface OrcCliPort {
  catalog(cli: CliName, routes: readonly CliRoute[], signal: AbortSignal): Promise<CatalogSnapshot>
  probe(route: CliRoute, path: string | undefined, signal: AbortSignal): Promise<CliProbe>
  run(route: CliRoute, path: string | undefined, prompt: string, cwd: string, signal: AbortSignal): Promise<string>
}

/** Everything the service needs from its deployment. */
export interface OrcServicePorts {
  /** The durable record seam; the sole writer of `orc/*` session events. */
  readonly journal: OrcJournal
  /** Task 2's settings bridge, read live for config and route revisions (R19). */
  readonly settings: OrcSettingsBridge
  /** Versioned benchmark evidence Auto selection reads. */
  readonly benchmarks: BenchmarkSnapshot
  readonly providers: OrcProviderPort
  readonly clis: OrcCliPort
  /** DSH's continuable-child runtime; a deployment without it cannot build a hierarchy. */
  readonly subagents?: OrcSubagentPort
  /** DSH's live-agent registry, used to resolve a published child. */
  readonly agents?: OrcAgentPort
  /** Working directory for CLI dispatches. */
  readonly cwd?: string
  /** Clock used for every durable timestamp; defaults to the system clock. */
  readonly now?: () => string
}

/** The analysis stages a dispatch drives through the lifecycle. */
type AnalysisStage = 'spec' | 'plan' | 'review' | 'audit'

/** Error names whose message is an ORC-owned, credential-free string. */
const SAFE_ERROR_NAMES = new Set([
  'ProviderError',
  'CliError',
  'RouteError',
  'ReportError',
  'WorkflowError',
  'OrcServiceError',
])

/** Reduce any thrown value to a reason safe to log durably. */
function safeReason(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR_NAMES.has(error.name)) return error.message
  return 'the selected backend failed'
}

/** The string form of a branded session id. */
const idOf = (id: SessionId): string => String(id)

/** Distinct values, in first-seen order. */
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** Whether one route is a configured provider route. */
const isProviderRoute = (route: Route): route is ProviderRoute => route.kind === 'provider'

/** Whether one route is a host CLI route. */
const isCliRoute = (route: Route): route is CliRoute => route.kind === 'cli'

/** The ORC run service. */
export class OrcService {
  private readonly ports: OrcServicePorts
  /** Cancels in-flight child startups on disposal; child work still settles through DSH. */
  private readonly lifetime = new AbortController()
  private readonly risks = new Map<string, RiskDecision>()
  private readonly connections = new Map<string, OrcConnection>()
  private readonly providerTests = new Map<string, ConnectionResult>()
  /** Member agent id → the run it belongs to. */
  private readonly members = new Map<string, string>()
  /** Run id → the Supervisor session that owns the durable log. */
  private readonly sessions = new Map<string, Session>()
  /** Per-run mutation chain. */
  private readonly tails = new Map<string, Promise<unknown>>()
  /** The last catalog observation, paired with the policy revision it was taken under. */
  private cachedCatalog: { snapshot: CatalogSnapshot; revision: string } | undefined

  constructor(ports: OrcServicePorts) {
    this.ports = ports
  }

  /** Stop accepting new child startups. Called when the ORC plugin unloads. */
  dispose(): void {
    this.lifetime.abort(new OrcServiceError('ORC was disabled'))
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Open the run for one Supervisor session.
   *
   * Idempotent: a run that already started returns its state unchanged, so a
   * retried activation gate cannot fail the session or replace the run's
   * original risk classification. The classification is committed with the
   * start record, so a resumed service routes a run whose log holds nothing but
   * its start.
   *
   * A run whose log predates that record has no durable classification: the
   * replayed gate is then the only surviving one, so it heals the run instead
   * of leaving every later dispatch with nothing to route on. A classification
   * that does not call for ORC never installs one.
   *
   * @throws when the classification does not call for ORC at all.
   */
  async start(supervisor: Agent, risk: RiskDecision): Promise<OrcState> {
    const runId = idOf(supervisor.id)
    this.bindSession(runId, supervisor.session)
    return await this.serialize(runId, async () => {
      const state = this.ports.journal.state(supervisor.session)
      if (state.started) {
        if (!this.risks.has(runId) && risk.path === 'orc') this.risks.set(runId, risk)
        return state
      }
      if (risk.path !== 'orc') {
        throw new OrcServiceError(`a "${risk.path}" classification does not start an ORC run`)
      }
      // The classification is committed *with* the start record, so a recovered
      // service can route a run whose log holds nothing else.
      const start: OrcStartRecord = {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'start',
        risk,
      }
      const next = await this.commit(supervisor.session, start)
      this.risks.set(runId, risk)
      return next
    })
  }

  /**
   * Create the run's single Lead as a continuable DSH child.
   *
   * The child identity is reserved and recorded before the child is
   * materialized, so a crash between the two leaves a durable provisioning
   * record instead of an unknown child. A run that already has a lead returns
   * the live lead rather than creating a second one.
   */
  async createLead(supervisor: Agent): Promise<Agent> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      if (state.leadId !== null) return this.requireChild(state.leadId, 'lead')
      const leadId = SessionId(`${runId}-orc-lead`)
      await this.commit(session, {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'lead-create',
        leadId,
      })
      return await this.startChild(session, runId, supervisor, leadId, ORC_LEAD_LABEL)
    })
  }

  /**
   * Create one Peer under the run's Lead.
   *
   * The peer's durable identity is derived from the lead's session and the
   * caller-supplied name, so a retried call addresses the same child and a name
   * that is not a safe session id cannot escape the session store.
   */
  async createPeer(lead: Agent, name: string): Promise<Agent> {
    const runId = this.runIdOf(lead)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireLead(state, lead)
      const peerId = SessionId(peerIdentity(lead, name))
      if (state.peers.includes(idOf(peerId))) return this.requireChild(idOf(peerId), 'peer')
      await this.commit(session, {
        ...this.envelope(runId, 'lead', lead.id),
        type: 'peer-create',
        peerId,
      })
      return await this.startChild(session, runId, lead, peerId, orcPeerLabel(name))
    })
  }

  /** Assign one task to a peer the lead created. */
  async startTask(lead: Agent, peer: Agent, taskId: string): Promise<OrcState> {
    const runId = this.runIdOf(lead)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireLead(state, lead)
      return await this.commit(session, {
        ...this.envelope(runId, 'lead', lead.id),
        type: 'task-start',
        taskId,
        peerId: peer.id,
      })
    })
  }

  /** Settle one task the calling peer owns. */
  async settleTask(peer: Agent, taskId: string): Promise<OrcState> {
    const runId = this.runIdOf(peer)
    return await this.serialize(runId, async () => {
      return await this.commit(this.sessionOf(runId), {
        ...this.envelope(runId, 'peer', peer.id),
        type: 'task-settle',
        taskId,
      })
    })
  }

  /**
   * Resolve a finding as fixed.
   *
   * Only the run's lead may do this, and only while the run is in the fix
   * phase the reducer selects after a blocking finding.
   */
  async fix(lead: Agent, findingId: string): Promise<OrcState> {
    const runId = this.runIdOf(lead)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireLead(state, lead)
      return await this.commit(session, {
        ...this.envelope(runId, 'lead', lead.id),
        type: 'fix',
        findingId,
      })
    })
  }

  /** Dismiss one non-blocking finding with a reason; blocking findings refuse. */
  async dismiss(supervisor: Agent, findingId: string, reason: string): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      return await this.commit(session, {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'dismiss',
        findingId,
        reason,
      })
    })
  }

  /**
   * Close the run.
   *
   * Every lifecycle refusal is reported with the `blocking` prefix so a caller
   * can treat any rejection as a blocked completion; an authority failure keeps
   * its own `authority` prefix because it is not a lifecycle outcome.
   */
  async complete(supervisor: Agent): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      try {
        return await this.commit(session, {
          ...this.envelope(runId, 'supervisor', supervisor.id),
          type: 'complete',
        })
      } catch (error) {
        throw asBlocking(error)
      }
    })
  }

  // ------------------------------------------------------------------ routing

  /**
   * The committed run state for one agent.
   *
   * The Supervisor's own session is the run log. A member agent's own session
   * is not a run log, so it is resolved through its run instead.
   */
  state(agent: Agent): OrcState {
    const own = agent.session
    this.bindSession(idOf(own.id), own)
    const state = this.ports.journal.state(own)
    if (state.started) return state
    const runId = this.findRunId(agent)
    return runId === undefined ? state : this.ports.journal.state(this.sessionOf(runId))
  }

  /** The recorded connection result for one exact route key, or `null`. */
  getConnectionResult(routeKeyValue: string): OrcConnection | null {
    return this.connections.get(routeKeyValue) ?? null
  }

  /**
   * Verify one route now and record the result.
   *
   * A provider route sends the harmless connection-test request; a CLI route
   * runs the documented version/auth/capability probe against the configured
   * executable path, so the green result binds to the executable a later
   * dispatch will use.
   */
  async probe(route: Route, signal: AbortSignal): Promise<OrcConnection> {
    return await this.verify(route, signal)
  }

  /**
   * Live catalog of every route the allowlist can select, plus the configured
   * code route.
   *
   * Provider routes contribute one entry per advertised model/effort pair with
   * no backend version and unverified account access, exactly as Task 5's live
   * DSH catalog reports them; CLI routes contribute only the model/effort pairs
   * whose own live probe succeeded.
   */
  async getCatalog(signal: AbortSignal): Promise<CatalogSnapshot> {
    const config = this.ports.settings.config()
    const observedAt = this.now()
    const routes: Route[] = [...config.allowed]
    if (config.codeRoute !== undefined) routes.push(config.codeRoute)
    const entries: CatalogEntry[] = []
    for (const provider of unique(routes.filter(isProviderRoute).map(route => route.provider))) {
      const snapshot = await this.ports.providers.catalog(provider)
      entries.push(...snapshot.entries)
    }
    const cliRoutes = routes.filter(isCliRoute)
    for (const cli of unique(cliRoutes.map(route => route.cli))) {
      const snapshot = await this.cliCatalog(cli, cliRoutes.filter(route => route.cli === cli), signal)
      entries.push(...snapshot.entries)
    }
    const snapshot: CatalogSnapshot = { id: `orc@${observedAt}`, observedAt, entries }
    this.cachedCatalog = { snapshot, revision: configRevision(config) }
    return snapshot
  }

  // ----------------------------------------------------------------- dispatch

  /**
   * Route and run one stage.
   *
   * `code` runs implementation work: it logs the route decision and drives no
   * lifecycle transition, because the reducer's request/result pairs cover the
   * analysis stages. `spec` and `plan` run under the Supervisor's authority;
   * `review` and `audit` are emitted by the run's Lead, which owns those
   * transitions in the reducer's authority table.
   */
  async dispatch(supervisor: Agent, stage: Stage, prompt: string, signal: AbortSignal): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      const risk = this.riskOf(runId, session)
      const config = this.ports.settings.config()
      const catalog = await this.catalogFor(signal)
      const prior = stage === 'audit' ? this.lastReviewDecision(session) : undefined
      let decision: RouteDecision
      try {
        decision = selectRoute(stage, risk, config, catalog, this.ports.benchmarks, this.now(), prior)
      } catch (error) {
        await this.block(session, runId, `route selection for ${stage} failed: ${safeReason(error)}`)
        throw error
      }
      await this.ports.journal.commit(session, {
        version: 1,
        type: ORC_ROUTE_EVENT,
        runId,
        at: this.now(),
        decision,
      })
      if (stage === 'code') {
        await this.runRoute(session, runId, decision, prompt, signal)
        return this.ports.journal.state(session)
      }
      const analysis = stage
      const pending = state.requests.find(request => request.stage === analysis && !request.consumed)
      const correlationId = pending?.correlationId ?? this.freshCorrelation(state, analysis, prompt)
      if (pending === undefined) {
        await this.commit(session, this.requestEvent(state, analysis, correlationId))
      }
      const text = await this.runRoute(session, runId, decision, prompt, signal)
      let report: unknown
      try {
        report = this.stageReport(analysis, text)
      } catch (error) {
        await this.block(session, runId, `${analysis} report blocked: ${safeReason(error)}`)
        throw error
      }
      await this.commit(session, this.resultEvent(runId, analysis, correlationId, report))
      return this.ports.journal.state(session)
    })
  }

  /**
   * Commit one review or audit result for an already-committed request.
   *
   * The report is validated before it is logged: a malformed, contradictory, or
   * unavailable report blocks the run and is never represented as a result.
   */
  async recordReport(
    supervisor: Agent,
    stage: 'review' | 'audit',
    correlationId: string,
    raw: unknown,
  ): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      try {
        parseReport(raw, stage)
      } catch (error) {
        await this.block(session, runId, `${stage} report blocked: ${safeReason(error)}`)
        throw error
      }
      return await this.commit(session, this.resultEvent(runId, stage, correlationId, raw))
    })
  }

  /**
   * Run the final branch review from an already-produced report.
   *
   * Refuses a run with no tasks: the reducer's completion predicate is vacuous
   * over an empty task list, so the service refuses to open the final gates
   * without task evidence. `canComplete` is not weakened.
   */
  async finalBranchReview(supervisor: Agent, raw: unknown): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      this.requireTaskEvidence(state, 'final review')
      const correlationId = `final-review:${runId}`
      await this.commit(session, {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'final-review-request',
        correlationId,
      })
      const report = await this.validatedReport(session, runId, 'review', raw)
      return await this.commit(session, this.resultEvent(runId, 'review', correlationId, report, 'final-review'))
    })
  }

  /** Run the final branch audit from an already-produced report. */
  async finalBranchAudit(supervisor: Agent, raw: unknown): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      this.requireSupervisor(state, supervisor)
      this.requireTaskEvidence(state, 'final audit')
      const correlationId = `final-audit:${runId}`
      await this.commit(session, {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'final-audit-request',
        correlationId,
      })
      const report = await this.validatedReport(session, runId, 'audit', raw)
      return await this.commit(session, this.resultEvent(runId, 'audit', correlationId, report, 'final-audit'))
    })
  }

  // ------------------------------------------------------------------ private

  /** Bind one run to the session that owns its durable log. */
  private bindSession(runId: string, session: Session): void {
    this.sessions.set(runId, session)
  }

  /** The session that owns one run's durable log. */
  private sessionOf(runId: string): Session {
    const known = this.sessions.get(runId)
    if (known !== undefined) return known
    const supervisor = this.ports.agents?.get(SessionId(runId))
    if (supervisor !== undefined) {
      this.sessions.set(runId, supervisor.session)
      return supervisor.session
    }
    throw new OrcServiceError(`the session of ORC run ${runId} is not available`)
  }

  /**
   * The run one agent belongs to, or `undefined` when it is part of none.
   *
   * The Supervisor's own session is the run identity; a Lead or Peer is
   * resolved through its durable parent lineage, so a member agent recovered
   * from a resumed session still addresses its own run.
   */
  private findRunId(agent: Agent): string | undefined {
    let session: Session | undefined = agent.session
    for (let depth = 0; depth < 4 && session !== undefined; depth += 1) {
      const id = idOf(session.id)
      const known = this.members.get(id)
      if (known !== undefined) return known
      if (this.ports.journal.state(session).started) return id
      const parentId: SessionId | undefined = session.header.parentSession
      session = parentId === undefined
        ? undefined
        : this.sessions.get(idOf(parentId)) ?? this.ports.agents?.get(parentId)?.session
    }
    return undefined
  }

  /** The run one agent belongs to, refusing an agent outside every run. */
  private runIdOf(agent: Agent): string {
    const runId = this.findRunId(agent)
    if (runId === undefined) {
      throw new WorkflowError(`authority: ${idOf(agent.id)} is not part of an ORC run`)
    }
    return runId
  }

  /**
   * The activation risk for one run: process-local first, then the durable
   * records.
   *
   * The start record carries the classification this build commits, so a
   * recovered service routes a start-only log. The first committed route
   * decision is the legacy fallback for a log written before that field
   * existed; only a log with neither leaves a run that cannot be routed.
   */
  private riskOf(runId: string, session: Session): RiskDecision {
    const known = this.risks.get(runId)
    if (known !== undefined) return known
    const recorded = this.ports.journal.risk(session)
    if (recorded !== null) {
      this.risks.set(runId, recorded)
      return recorded
    }
    const first = this.ports.journal.decisions(session)[0]
    if (first !== undefined) {
      this.risks.set(runId, first.risk)
      return first.risk
    }
    throw new OrcServiceError(`no risk classification is recorded for ORC run ${runId}; replay the activation gate for this session`)
  }

  /** The committed review decision an audit must stay independent from. */
  private lastReviewDecision(session: Session): RouteDecision | undefined {
    return this.ports.journal.decisions(session).filter(decision => decision.stage === 'review').at(-1)
  }

  /** Refuse an actor that is not the run's Supervisor. */
  private requireSupervisor(state: OrcState, agent: Agent): void {
    if (!state.started) throw new WorkflowError('phase: the ORC run has not started')
    if (state.supervisorId !== idOf(agent.id)) {
      throw new WorkflowError(`authority: ${idOf(agent.id)} is not the run's supervisor`)
    }
  }

  /** Refuse an actor that is not the run's Lead. */
  private requireLead(state: OrcState, agent: Agent): void {
    if (state.leadId === null) throw new WorkflowError('authority: the run has no lead')
    if (state.leadId !== idOf(agent.id)) {
      throw new WorkflowError(`authority: ${idOf(agent.id)} is not the run's lead`)
    }
  }

  /** Refuse the final gates for a run with no task evidence. */
  private requireTaskEvidence(state: OrcState, gate: string): void {
    if (state.tasks.length === 0) {
      throw new OrcServiceError(`the ${gate} requires at least one settled task; this run has none`, true)
    }
  }

  /** Resolve a live child the run already provisioned. */
  private requireChild(childId: string, role: string): Agent {
    const child = this.ports.agents?.get(SessionId(childId))
    if (child === undefined) {
      throw new OrcServiceError(`the run's ${role} ${childId} is not live; resume that child session before continuing`)
    }
    return child
  }

  /** The run's lead identity, or a refusal. */
  private leadIdOf(state: OrcState): string {
    if (state.leadId === null) {
      throw new WorkflowError('authority: the run has no lead; create the lead before dispatching review or audit')
    }
    return state.leadId
  }

  /** One durable event envelope; the variant fields are added by the caller. */
  private envelope(
    runId: string,
    actor: Actor,
    actorId: SessionId,
  ): { version: 1; runId: string; actorId: SessionId; actor: Actor; at: string } {
    return { version: 1, runId, actorId, actor, at: this.now() }
  }

  /** Build the request event for one analysis stage under its owning role. */
  private requestEvent(state: OrcState, stage: AnalysisStage, correlationId: string): OrcEvent {
    const runId = state.runId
    if (stage === 'spec') {
      return { ...this.envelope(runId, 'supervisor', SessionId(state.supervisorId)), type: 'spec-request', correlationId }
    }
    if (stage === 'plan') {
      return { ...this.envelope(runId, 'supervisor', SessionId(state.supervisorId)), type: 'plan-request', correlationId }
    }
    const leadId = SessionId(this.leadIdOf(state))
    return stage === 'review'
      ? { ...this.envelope(runId, 'lead', leadId), type: 'review-request', correlationId }
      : { ...this.envelope(runId, 'lead', leadId), type: 'audit-request', correlationId }
  }

  /** Build the result event for one stage; only reports carry a payload. */
  private resultEvent(
    runId: string,
    stage: AnalysisStage,
    correlationId: string,
    report: unknown,
    kind: 'task' | 'final-review' | 'final-audit' = 'task',
  ): OrcEvent {
    const actorId = SessionId(runId)
    if (kind === 'final-review') {
      return { ...this.envelope(runId, 'service', actorId), type: 'final-review-result', correlationId, report }
    }
    if (kind === 'final-audit') {
      return { ...this.envelope(runId, 'service', actorId), type: 'final-audit-result', correlationId, report }
    }
    if (stage === 'spec') return { ...this.envelope(runId, 'service', actorId), type: 'spec-result', correlationId }
    if (stage === 'plan') return { ...this.envelope(runId, 'service', actorId), type: 'plan-result', correlationId }
    return stage === 'review'
      ? { ...this.envelope(runId, 'service', actorId), type: 'review-result', correlationId, report }
      : { ...this.envelope(runId, 'service', actorId), type: 'audit-result', correlationId, report }
  }

  /**
   * A correlation id that is stable for a retry and fresh for a later cycle.
   *
   * The committed request count for the stage is part of the identity, so the
   * second review of a run cannot collide with the first, while a resumed
   * dispatch reuses the pending request's own id instead of allocating one.
   */
  private freshCorrelation(state: OrcState, stage: AnalysisStage, prompt: string): string {
    const round = state.requests.filter(request => request.stage === stage).length + 1
    const digest = createHash('sha256').update(prompt).digest('hex').slice(0, 16)
    return `${stage}:${round}:${digest}`
  }

  /** Reduce one event against the committed state, then commit it. */
  private async commit(session: Session, event: OrcEvent): Promise<OrcState> {
    const next = reduce(this.ports.journal.state(session), event)
    await this.ports.journal.commit(session, event)
    return next
  }

  /** Append the reducer's blocking event for a failed stage, if the run can take it. */
  private async block(session: Session, runId: string, reason: string): Promise<void> {
    const state = this.ports.journal.state(session)
    if (!state.started || state.phase === 'failed' || state.phase === 'completed') return
    await this.ports.journal.commit(session, {
      ...this.envelope(runId, 'service', SessionId(runId)),
      type: 'fail',
      reason,
    })
  }

  /**
   * Parse one review/audit stage's accepted text.
   *
   * The text must be exactly the report JSON: a fenced, padded, or otherwise
   * unparseable answer is a malformed report, and a malformed report blocks.
   */
  private stageReport(stage: AnalysisStage, text: string): unknown {
    if (stage !== 'review' && stage !== 'audit') return undefined
    const raw: unknown = JSON.parse(text)
    parseReport(raw, stage)
    return raw
  }

  /** Validate one final-gate report; a refusal blocks the run. */
  private async validatedReport(
    session: Session,
    runId: string,
    stage: 'review' | 'audit',
    raw: unknown,
  ): Promise<unknown> {
    try {
      parseReport(raw, stage)
      return raw
    } catch (error) {
      await this.block(session, runId, `${stage} report blocked: ${safeReason(error)}`)
      throw error
    }
  }

  /** Verify a route and dispatch one prompt through its own backend. */
  private async runRoute(
    session: Session,
    runId: string,
    decision: RouteDecision,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return await this.invoke(decision.route, prompt, signal)
    } catch (error) {
      if (signal.aborted) throw error
      await this.block(session, runId, `${decision.stage} dispatch failed: ${safeReason(error)}`)
      throw error
    }
  }

  /** Dispatch through the exact adapter that owns the selected route. */
  private async invoke(route: Route, prompt: string, signal: AbortSignal): Promise<string> {
    const revision = this.ports.settings.connectionRevision(route)
    const key = routeKey(route)
    if (route.kind === 'provider') {
      const test = await this.greenProviderTest(route, key, revision, signal)
      return await this.ports.providers.run(route, prompt, revision, test, signal)
    }
    await this.greenCliProbe(route, key, revision, signal)
    return await this.ports.clis.run(route, this.ports.settings.config().cliPaths[route.cli], prompt, this.cwd(), signal)
  }

  /**
   * The green provider test for one exact route and revision.
   *
   * A recorded green result is reused while the connection revision holds; a
   * missing, failed, or stale one is re-verified now and refused when it is not
   * green. There is no fallback to another route.
   */
  private async greenProviderTest(
    route: ProviderRoute,
    key: string,
    revision: string,
    signal: AbortSignal,
  ): Promise<ConnectionResult> {
    const recorded = this.providerTests.get(key)
    if (recorded !== undefined && recorded.ok && recorded.configRevision === revision) return recorded
    const fresh = await this.verify(route, signal)
    if (!fresh.ok) throw new OrcServiceError(`no green connection test for ${key}: ${fresh.code}`, true)
    const test = this.providerTests.get(key)
    if (test === undefined) throw new OrcServiceError(`no green connection test for ${key}`, true)
    return test
  }

  /** The green CLI probe for one exact route and revision; the adapter re-inspects it at run. */
  private async greenCliProbe(route: CliRoute, key: string, revision: string, signal: AbortSignal): Promise<void> {
    const recorded = this.connections.get(key)
    if (recorded !== undefined && recorded.ok && recorded.revision === revision) return
    const fresh = await this.verify(route, signal)
    if (!fresh.ok) throw new OrcServiceError(`no green probe for ${key}: ${fresh.code}`, true)
  }

  /** Run one route's connection test now and record it. */
  private async verify(route: Route, signal: AbortSignal): Promise<OrcConnection> {
    const key = routeKey(route)
    const revision = this.ports.settings.connectionRevision(route)
    if (route.kind === 'provider') {
      const result = await this.ports.providers.test(route, revision, signal)
      const connection: OrcConnection = {
        routeKey: result.routeKey,
        revision: result.configRevision,
        testedAt: result.testedAt,
        ok: result.ok,
        code: result.ok ? '' : result.code,
        diagnostic: '',
      }
      if (result.ok) this.providerTests.set(key, result)
      else this.providerTests.delete(key)
      this.connections.set(key, connection)
      return connection
    }
    const path = this.ports.settings.config().cliPaths[route.cli]
    try {
      const probe = await this.ports.clis.probe(route, path, signal)
      const connection: OrcConnection = {
        routeKey: probe.routeKey,
        revision,
        testedAt: probe.testedAt,
        ok: true,
        code: '',
        diagnostic: '',
      }
      this.connections.set(key, connection)
      return connection
    } catch (error) {
      if (signal.aborted) throw error
      const connection: OrcConnection = {
        routeKey: key,
        revision,
        testedAt: this.now(),
        ok: false,
        code: error instanceof CliError ? error.code : 'unsupported-protocol',
        diagnostic: error instanceof CliError ? error.diagnostic : '',
      }
      this.connections.set(key, connection)
      return connection
    }
  }

  /**
   * Catalog one CLI's configured routes.
   *
   * When the settings pin an explicit executable path, the probe runs against
   * that exact path instead of the `PATH` discovery Task 6's catalog performs:
   * the adapter records the green probe a later `run(route, path, …)`
   * re-inspects, so the configured executable and the tested executable are the
   * same one. Without a configured path the adapter's own `PATH` discovery is
   * already the path a dispatch will use, so its catalog is consumed unchanged.
   */
  private async cliCatalog(cli: CliName, routes: readonly CliRoute[], signal: AbortSignal): Promise<CatalogSnapshot> {
    const path = this.ports.settings.config().cliPaths[cli]
    if (path === undefined) return await this.ports.clis.catalog(cli, routes, signal)
    const observedAt = this.now()
    const entries: CatalogEntry[] = []
    for (const route of routes) {
      try {
        const probe = await this.ports.clis.probe(route, path, signal)
        entries.push({
          routeKey: probe.routeKey,
          backendVersion: probe.version,
          model: route.model,
          efforts: [route.effort],
          accountAccess: true,
          sourceUrl: '',
          retrievedAt: observedAt,
        })
      } catch (error) {
        if (signal.aborted) throw error
        // One unusable pair must not hide the remaining configured pairs.
      }
    }
    return { id: `${cli}@${observedAt}`, observedAt, entries }
  }

  /**
   * The catalog a dispatch selects from.
   *
   * A fresh recorded snapshot is reused so a workflow does not re-probe every
   * backend at every stage; anything older than the configured maximum age is
   * re-read, which is the selection-point revalidation the design asks for. A
   * snapshot is also re-read when the policy that selected its routes changed,
   * so a route the user just allowed is not invisible until the age bound
   * expires.
   */
  private async catalogFor(signal: AbortSignal): Promise<CatalogSnapshot> {
    const cached = this.cachedCatalog
    if (cached !== undefined && cached.revision === configRevision(this.ports.settings.config()) && this.isFresh(cached.snapshot.observedAt)) {
      return cached.snapshot
    }
    return await this.getCatalog(signal)
  }

  /** Whether one observation is inside the configured catalog age. */
  private isFresh(observedAt: string): boolean {
    const observed = Date.parse(observedAt)
    const at = Date.parse(this.now())
    if (!Number.isFinite(observed) || !Number.isFinite(at)) return false
    const age = at - observed
    return age >= 0 && age <= this.ports.settings.config().catalogMaxAgeDays * 24 * 60 * 60 * 1000
  }

  /** Start one continuable DSH child and resolve its published Agent. */
  private async startChild(
    session: Session,
    runId: string,
    parent: Agent,
    childId: SessionId,
    label: string,
  ): Promise<Agent> {
    try {
      const subagents = this.ports.subagents
      if (subagents === undefined) {
        throw new OrcServiceError('the DSH subagent runtime is not mounted; ORC cannot create its hierarchy')
      }
      const provider = subagents.getProvider(ORC_CHILD_PROVIDER)
      if (provider === undefined || typeof provider.prepareContinuable !== 'function') {
        throw new OrcServiceError(`the DSH subagent provider "${ORC_CHILD_PROVIDER}" cannot create continuable children`)
      }
      const started = await subagents.startContinuable({
        provider: ORC_CHILD_PROVIDER,
        label,
        childId,
        request: {
          parent,
          prompt: [{ type: 'text', text: `${label} (${idOf(childId)}) owns work delegated by ORC run ${runId}.` }],
          ...this.childOptions(parent),
        },
        signal: this.lifetime.signal,
      })
      const child = this.ports.agents?.get(started.childId)
      if (child === undefined) {
        throw new OrcServiceError(`the ORC child ${idOf(started.childId)} was not published by DSH`)
      }
      this.members.set(idOf(child.id), runId)
      this.bindSession(idOf(child.id), child.session)
      return child
    } catch (error) {
      await this.block(session, runId, `child startup failed: ${safeReason(error)}`)
      throw error
    }
  }

  /**
   * The agent options one ORC child inherits.
   *
   * A child is a DSH agent, so it can only be given a DSH provider route: the
   * Supervisor's exact live route. A CLI-selected backend never reaches a DSH
   * child bundle, and no route is invented when the Supervisor has none.
   */
  private childOptions(parent: Agent): { agentOptions?: AgentOptions } {
    const options = parent.options
    if (options.provider === undefined || options.model === undefined) return {}
    return {
      agentOptions: {
        provider: options.provider,
        model: options.model,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      },
    }
  }

  /** The working directory CLI dispatches run in. */
  private cwd(): string {
    return this.ports.cwd ?? process.cwd()
  }

  /** Serialize one run's mutations; a rejected operation does not break the chain. */
  private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(runId) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    this.tails.set(runId, next.then(() => {}, () => {}))
    return next
  }

  /** The current instant, ISO-formatted. */
  private now(): string {
    return this.ports.now?.() ?? new Date().toISOString()
  }
}

/** Prefix a lifecycle refusal with `blocking` unless it already carries an ORC-owned prefix. */
function asBlocking(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (error.message.startsWith('blocking:') || error.message.startsWith('authority:')) return error
  return new OrcServiceError(error.message, true)
}

/**
 * The durable peer identity for one lead and caller-supplied name.
 *
 * The name is reduced to a safe session-id fragment: a peer name reaches DSH as
 * a child session identity, so it must not be able to name a path or another
 * session. The lead's id keeps two runs' peers distinct.
 */
export function peerIdentity(lead: Agent, name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (safe === '') throw new OrcServiceError('a peer needs a name')
  return `${idOf(lead.id)}-orc-peer-${safe}`
}
