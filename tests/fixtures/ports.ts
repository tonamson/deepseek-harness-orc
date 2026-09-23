/**
 * Fake DSH ports for the ORC service, tool, and integration tests.
 *
 * The fakes model the *published* seams, not the service's assumptions:
 *
 * - the journal appends real `orc/*` events to real `Session` objects and
 *   awaits a durability checkpoint before a commit resolves, exactly like
 *   {@link SessionOrcJournal};
 * - the subagent port validates the continuable-child capability before it
 *   starts a child and returns a published Agent through a registry, exactly
 *   like `ctx.subagents` + `ctx.agents`;
 * - the provider and CLI ports reproduce Task 5's and Task 6's gates — a green
 *   test bound to the exact route and revision, a CLI probe bound to the exact
 *   executable path — so a service that skipped its own gate would still be
 *   caught here;
 * - the Agent context exposes the real registration surface (`tools.register`,
 *   `systemPrompt.section`, `ctx.on`) plus fixture-only readers used by the
 *   assertions.
 *
 * Stage output is a FIFO queue: a test pushes the report the next review or
 * audit run must return, and any stage run pops one entry, so the brief's
 * `ports.reports.push(mediumReport)` sequence drives the fake directly.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionStore,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SubagentCapabilities } from '@deepseek-ai/dsh-subagent'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { connectionRevision } from '../../src/domain/config.js'
import type { BenchmarkSnapshot } from '../../src/domain/evidence.js'
import type { RiskDecision } from '../../src/domain/risk.js'
import type { RouteDecision } from '../../src/domain/routing.js'
import type { OrcConfig, ProviderRoute, Route } from '../../src/domain/types.js'
import { initialState, reduce, type OrcState } from '../../src/domain/workflow.js'
import type { CliProbe } from '../../src/host/cli.js'
import {
  hasStartRisk,
  orcEventName,
  type OrcJournal,
  type OrcJournalRecord,
  type OrcRecord,
} from '../../src/host/journal.js'
import type { ConnectionResult, ProviderErrorCode } from '../../src/host/provider.js'
import {
  ORC_LEAD_LABEL,
  type OrcAgentPort,
  type OrcCliPort,
  type OrcProviderPort,
  type OrcServicePorts,
  type OrcSubagentPort,
} from '../../src/host/service.js'
import type { OrcSettingsBridge } from '../../src/host/settings.js'
import { benchmarks, catalog, config as fixtureConfig } from './routes.js'

/** The fixed instant every fake uses, so durable records are deterministic. */
export const FAKE_NOW = '2026-09-23T00:00:00Z'

/** The supervisor session every fake run belongs to. */
export const SUPERVISOR_ID = 'session-supervisor'

/** The result a stage run returns when the report queue is empty. */
export const DEFAULT_STAGE_OUTPUT = 'stage output'

// --------------------------------------------------------------------- agents

/** One fake Agent, plus the ORC role the fixture models for assertions. */
export interface FakeAgent extends Agent {
  /** Fixture-only marker: the real DSH Agent carries no role field. */
  readonly role: 'supervisor' | 'lead' | 'peer'
}

/** The registered tool surface, plus a fixture-only listing reader. */
export interface FakeTools {
  register(definition: ToolDefinition): () => void
  get(name: string): ToolDefinition | undefined
  /** Fixture-only: the real `ToolRuntime` exposes `schemas()`/`get()`, not `list()`. */
  list(): ToolDefinition[]
  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[]
}

/** The registered prompt-section surface. */
export interface FakeSystemPrompt {
  section(section: PromptSection): () => void
  /** Fixture-only: the registered sections in registration order. */
  list(): PromptSection[]
}

/** One pre-step payload the fixture dispatches. */
export interface FakePreStep {
  agent: Agent
  messages: PreStepMessage[]
  signal: AbortSignal
}

/** The minimal user-message shape the pre-step gate reads. */
export interface PreStepMessage {
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: 'user' }
}

/** The Agent-scoped context the tool and gate register into. */
export interface FakeAgentContext {
  tools: FakeTools
  systemPrompt: FakeSystemPrompt
  agents: { get(id: SessionId): Agent | undefined }
  on(event: 'agent/pre-step', listener: (payload: FakePreStep, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>): () => void
  /** Fixture-only: run every registered pre-step listener with a `next()` decision. */
  preStep(payload: FakePreStep, decision: PreStepDecision): Promise<PreStepDecision>
}

/** Build one fake Agent over a real Session. */
export function fakeAgent(options: {
  id: string
  role: FakeAgent['role']
  session: Session
  agents: { get(id: SessionId): Agent | undefined }
  options?: AgentOptions
}): FakeAgent {
  const tools = fakeTools()
  const systemPrompt = fakeSystemPrompt()
  const listeners: ((payload: FakePreStep, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)[] = []
  const agent = {
    id: SessionId(options.id),
    role: options.role,
    session: options.session,
    options: options.options ?? {},
    ctx: {
      tools,
      systemPrompt,
      agents: options.agents,
      on: (_event: 'agent/pre-step', listener: (payload: FakePreStep, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
      preStep: async (payload: FakePreStep, decision: PreStepDecision): Promise<PreStepDecision> => {
        let chain = async (): Promise<PreStepDecision> => decision
        for (const listener of [...listeners].reverse()) {
          const next = chain
          chain = async () => await listener(payload, next)
        }
        return await chain()
      },
    } as unknown as Agent['ctx'],
  } as unknown as FakeAgent
  return agent
}

/** A tool registry with the real registration contract plus fixture readers. */
function fakeTools(): FakeTools {
  const definitions = new Map<string, ToolDefinition>()
  return {
    register: (definition) => {
      definitions.set(definition.name, definition)
      return () => {
        definitions.delete(definition.name)
      }
    },
    get: name => definitions.get(name),
    list: () => [...definitions.values()],
    schemas: () => [...definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    })),
  }
}

/** A prompt-section registry with the real registration contract. */
function fakeSystemPrompt(): FakeSystemPrompt {
  const sections = new Map<string, PromptSection>()
  return {
    section: (section) => {
      sections.set(section.name, section)
      return () => {
        sections.delete(section.name)
      }
    },
    list: () => [...sections.values()],
  }
}

// -------------------------------------------------------------------- journal

/** The durable journal plus the fixture readers the assertions use. */
export interface FakeJournal extends OrcJournal {
  /** Every committed record, in commit order, exactly as it was logged. */
  readonly events: OrcJournalRecord[]
  /** The sessions each commit appended to, so a test can prove which session was written. */
  readonly sessions: string[]
  /** How many durability checkpoints were awaited. */
  readonly flushCount: { value: number }
  /** A fresh journal folding the same durable records, as a restarted service sees it. */
  recover(): FakeJournal
}

/** Build a journal over real Sessions, folding committed records itself. */
export function fakeJournal(seed: OrcJournalRecord[] = []): FakeJournal {
  // The record array is shared with every recovery journal: a restarted
  // service reads the same durable log, not a private copy of it.
  const events: OrcJournalRecord[] = seed
  const sessions: string[] = []
  const flushCount = { value: 0 }
  const records = new Map<string, OrcRecord[]>()
  const states = new Map<string, OrcState>()
  const risks = new Map<string, RiskDecision>()

  const fold = (): void => {
    records.clear()
    states.clear()
    risks.clear()
    for (const record of events) {
      const runId = record.data.runId
      const list = records.get(runId) ?? []
      list.push(record.data)
      records.set(runId, list)
      if (record.data.type === 'orc/route') continue
      // The durable classification lives on the start record, exactly as the
      // session projection folds it, so a recovery journal exposes it too.
      if (hasStartRisk(record.data)) risks.set(runId, record.data.risk)
      states.set(runId, reduce(states.get(runId) ?? initialState(), record.data))
    }
  }
  fold()

  const journal: FakeJournal = {
    events,
    sessions,
    flushCount,
    state: (session) => states.get(String(session.id)) ?? initialState(),
    risk: (session) => risks.get(String(session.id)) ?? null,
    decisions: (session) => routeDecisions(records.get(String(session.id)) ?? []),
    commit: async (session, record) => {
      // Append through the real Session so the durable event vocabulary is
      // exercised, then await the durability checkpoint before publishing.
      if (record.type === 'orc/route') session.append('orc/route', record)
      else session.append(orcEventName(record), record)
      flushCount.value += 1
      sessions.push(String(session.id))
      events.push({ type: record.type === 'orc/route' ? 'orc/route' : orcEventName(record), data: record })
      fold()
    },
    recover: () => fakeJournal(events),
  }
  return journal
}

/** The committed route decisions of one run, in commit order. */
function routeDecisions(records: readonly OrcRecord[]): RouteDecision[] {
  return records
    .filter((record): record is Extract<OrcRecord, { type: 'orc/route' }> => record.type === 'orc/route')
    .map(record => record.decision)
}

// ----------------------------------------------------------------- subagents

/** The continuable-child port plus the fixture's recorded starts. */
export interface FakeSubagents extends OrcSubagentPort {
  /** Every start spec the service handed over, in order. */
  readonly starts: { provider: string; label: string; childId?: string; parentId: string; agentOptions: AgentOptions | undefined }[]
  /** Every published child, keyed by child id. */
  readonly children: Map<string, FakeAgent>
  /** Make the next start fail. */
  failNextStart(error: Error | undefined): void
  /** Withdraw the continuable capability. */
  setCapable(capable: boolean): void
}

// ------------------------------------------------------------------- settings

/** The live settings bridge over one mutable config. */
export interface FakeSettings extends OrcSettingsBridge {
  /** Replace the resolved config, as a committed settings change would. */
  set(config: OrcConfig): void
}

// ------------------------------------------------------------------ providers

/** The configured-provider port plus the fixture's recorded dispatches. */
export interface FakeProviders extends OrcProviderPort {
  readonly runs: { route: ProviderRoute; prompt: string; revision: string; test: ConnectionResult }[]
  readonly tests: { route: ProviderRoute; revision: string }[]
  failNextTest(code: ProviderErrorCode | undefined): void
  failNextRun(error: Error | undefined): void
}

/** The host-CLI port plus the fixture's recorded dispatches. */
export interface FakeClis extends OrcCliPort {
  readonly runs: { route: Route; path: string | undefined; prompt: string }[]
  readonly probes: { route: Route; path: string | undefined }[]
  failNextProbe(error: Error | undefined): void
  failNextRun(error: Error | undefined): void
}

// ---------------------------------------------------------------------- ports

/** Everything {@link fakePorts} builds, plus the readers the tests assert on. */
export interface FakePorts extends OrcServicePorts {
  readonly journal: FakeJournal
  readonly supervisor: FakeAgent
  readonly subagents: FakeSubagents
  readonly agents: OrcAgentPort & { readonly live: Map<string, FakeAgent> }
  readonly providers: FakeProviders
  readonly clis: FakeClis
  readonly settings: FakeSettings
  /** Stage output queue; a stage run pops one entry. */
  readonly reports: unknown[]
  /** The mutable ORC config the settings bridge resolves. */
  config: OrcConfig
}

export interface FakePortsOptions {
  readonly config?: OrcConfig
  readonly now?: string
  readonly cwd?: string
  readonly supervisorOptions?: AgentOptions
  readonly benchmarks?: BenchmarkSnapshot
  readonly reports?: readonly unknown[]
}

/** Build one complete fake deployment. */
export function fakePorts(options: FakePortsOptions = {}): FakePorts {
  const now = options.now ?? FAKE_NOW
  const live = new Map<string, FakeAgent>()
  const agents: OrcAgentPort & { readonly live: Map<string, FakeAgent> } = {
    live,
    get: (id) => live.get(String(id)),
  }

  const supervisorSession = session(SUPERVISOR_ID)
  const supervisor = fakeAgent({
    id: SUPERVISOR_ID,
    role: 'supervisor',
    session: supervisorSession,
    agents,
    options: options.supervisorOptions ?? { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  })
  live.set(SUPERVISOR_ID, supervisor)

  const journal = fakeJournal()
  const reports = [...options.reports ?? []]

  let config = options.config ?? fixtureConfig('auto')
  const settings: FakeSettings = {
    config: () => config,
    connectionRevision: route => connectionRevision(config, route),
    subscribe: () => () => {},
    dispose: () => {},
    set: (next) => {
      config = next
    },
  }

  const subagents = fakeSubagents({ agents, now })
  const providers = fakeProviders({ reports })
  const clis = fakeClis({ reports, now })

  return {
    journal,
    supervisor,
    subagents,
    agents,
    providers,
    clis,
    settings,
    reports,
    benchmarks: options.benchmarks ?? benchmarks,
    cwd: options.cwd ?? '/work',
    now: () => now,
    get config() {
      return config
    },
    set config(next: OrcConfig) {
      config = next
      settings.set(next)
    },
  }
}

/** One real Session, optionally a child of another. */
export function session(id: string, parent?: string): Session {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    isSeeded: false,
    ...parent === undefined ? {} : { parentSession: SessionId(parent) },
  }
  return Session.create(SessionId(id), undefined, header)
}

/** A fake continuable-child runtime over one live-agent registry. */
function fakeSubagents(deps: { agents: OrcAgentPort & { live: Map<string, FakeAgent> }; now: string }): FakeSubagents {
  const starts: FakeSubagents['starts'] = []
  const children = new Map<string, FakeAgent>()
  let capable = true
  let failure: Error | undefined
  let counter = 0
  const capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  return {
    starts,
    children,
    failNextStart: (error) => {
      failure = error
    },
    setCapable: (next) => {
      capable = next
    },
    getProvider: (name) => {
      if (name !== 'spawn') return undefined
      return {
        capabilities,
        ...capable ? { prepareContinuable: () => ({}) } : {},
      }
    },
    startContinuable: async (spec) => {
      starts.push({
        provider: spec.provider,
        label: spec.label,
        ...spec.childId === undefined ? {} : { childId: String(spec.childId) },
        parentId: String(spec.request.parent.id),
        agentOptions: spec.request.agentOptions,
      })
      if (spec.signal.aborted) {
        throw spec.signal.reason instanceof Error ? spec.signal.reason : new Error('aborted')
      }
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      counter += 1
      const childId = String(spec.childId ?? `child-${counter}`)
      if (children.has(childId)) throw new Error(`subagent "${childId}" already exists`)
      const child = fakeAgent({
        id: childId,
        role: spec.label === ORC_LEAD_LABEL ? 'lead' : 'peer',
        session: session(childId, String(spec.request.parent.id)),
        agents: deps.agents,
        ...spec.request.agentOptions === undefined ? {} : { options: spec.request.agentOptions },
      })
      children.set(childId, child)
      deps.agents.live.set(childId, child)
      return { childId: SessionId(childId), messageId: MessageId(`message-${childId}`) }
    },
  }
}

/** A fake provider adapter reproducing Task 5's gate. */
function fakeProviders(deps: { reports: unknown[] }): FakeProviders {
  const runs: FakeProviders['runs'] = []
  const tests: FakeProviders['tests'] = []
  let testFailure: ProviderErrorCode | undefined
  let runFailure: Error | undefined
  return {
    runs,
    tests,
    failNextTest: (code) => {
      testFailure = code
    },
    failNextRun: (error) => {
      runFailure = error
    },
    catalog: async (provider) => ({
      id: `${provider}@${FAKE_NOW}`,
      observedAt: FAKE_NOW,
      entries: catalog.entries.filter(entry => entry.routeKey.startsWith(`provider:${provider}:`)),
    }),
    test: async (route, revision) => {
      tests.push({ route, revision })
      if (testFailure !== undefined) {
        const code = testFailure
        testFailure = undefined
        return { routeKey: routeKeyOf(route), configRevision: revision, testedAt: FAKE_NOW, ok: false, code }
      }
      return { routeKey: routeKeyOf(route), configRevision: revision, testedAt: FAKE_NOW, ok: true }
    },
    run: async (route, prompt, revision, test) => {
      runs.push({ route, prompt, revision, test })
      if (runFailure !== undefined) {
        const error = runFailure
        runFailure = undefined
        throw error
      }
      if (!test.ok || test.routeKey !== routeKeyOf(route) || test.configRevision !== revision) {
        throw new Error(`stale connection test for ${routeKeyOf(route)}`)
      }
      return JSON.stringify(deps.reports.shift() ?? DEFAULT_STAGE_OUTPUT)
    },
  }
}

/** A fake host-CLI adapter reproducing Task 6's probe/run identity binding. */
function fakeClis(deps: { reports: unknown[]; now: string }): FakeClis {
  const runs: FakeClis['runs'] = []
  const probes: FakeClis['probes'] = []
  const green = new Map<string, { path: string | undefined; version: string }>()
  let probeFailure: Error | undefined
  let runFailure: Error | undefined
  const probe = async (route: Route, path: string | undefined): Promise<CliProbe> => {
    probes.push({ route, path })
    if (probeFailure !== undefined) {
      const error = probeFailure
      probeFailure = undefined
      throw error
    }
    const version = route.cli === 'codex' ? '0.156.1' : '2.1.280'
    const key = routeKeyOf(route)
    green.set(key, { path, version })
    return {
      routeKey: key,
      cli: route.cli,
      executable: path ?? `/usr/local/bin/${route.cli}`,
      version,
      auth: { method: 'test', accountFingerprint: '' },
      model: route.model,
      effort: route.effort,
      revision: `${key}@${version}`,
      testedAt: deps.now,
    }
  }
  return {
    runs,
    probes,
    failNextProbe: (error) => {
      probeFailure = error
    },
    failNextRun: (error) => {
      runFailure = error
    },
    catalog: async (cli, routes) => {
      const entries = []
      for (const route of routes) {
        const observed = await probe(route, undefined)
        entries.push({
          routeKey: observed.routeKey,
          backendVersion: observed.version,
          model: route.model,
          efforts: [route.effort],
          accountAccess: true,
          sourceUrl: '',
          retrievedAt: deps.now,
        })
      }
      return { id: `${cli}@${deps.now}`, observedAt: deps.now, entries }
    },
    probe,
    run: async (route, path, prompt) => {
      runs.push({ route, path, prompt })
      if (runFailure !== undefined) {
        const error = runFailure
        runFailure = undefined
        throw error
      }
      const recorded = green.get(routeKeyOf(route))
      if (recorded === undefined) throw new Error(`no green ${route.cli} probe for ${routeKeyOf(route)}`)
      if (recorded.path !== path) {
        throw new Error(`stale ${route.cli} probe for ${routeKeyOf(route)}: probed ${String(recorded.path)}, running ${String(path)}`)
      }
      return JSON.stringify(deps.reports.shift() ?? DEFAULT_STAGE_OUTPUT)
    },
  }
}

/** The exact route key of one route, matching the domain helper. */
const routeKeyOf = (route: Route): string => route.kind === 'provider'
  ? `provider:${route.provider}:${route.model}:${route.effort}`
  : `cli:${route.cli}:${route.model}:${route.effort}`

/** One risk decision for the brief's high-impact fixture request. */
export const HIGH_RISK: RiskDecision = { path: 'orc', risk: 'high', reasons: ['high-impact'] }

/** Build a real DSH session store and projection registry for integration tests. */
export function fakeDshSessionServices(): {
  ctx: Context
  store: SessionStore
  projections: SessionProjectionRegistry
  events: SessionEvent[]
} {
  const ctx = new Context()
  const store = new SessionStore(ctx)
  const projections = new SessionProjectionRegistry(ctx)
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => {
    events.push(event)
  })
  return { ctx, store, projections, events }
}
