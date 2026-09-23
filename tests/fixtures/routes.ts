/**
 * Route-selection fixtures.
 *
 * One versioned catalog and benchmark set, shared by the routing and evidence
 * specs, plus the two helpers the brief's test snippets call but the plan never
 * defines: {@link routeBackend} and {@link selectFixtureRoute}.
 *
 * The fixture is built so that exactly one mutation is needed to make a
 * high-risk audit fail. Both CLI backends carry a real probed version and a
 * fresh financial+security benchmark record; the provider routes carry the
 * empty backend version Task 5's live DSH catalog produces, so they are
 * deliberately unable to satisfy a high-risk review/audit (R22).
 */

import { routeKey } from '../../src/domain/config.js'
import { backendIdentity, type BenchmarkSnapshot } from '../../src/domain/evidence.js'
import { DEFAULT_CODE_ROUTE, selectRoute, type RouteDecision } from '../../src/domain/routing.js'
import type { RiskDecision, RiskLevel } from '../../src/domain/risk.js'
import type { CatalogSnapshot, OrcConfig, Route, Stage } from '../../src/domain/types.js'

/** The instant every fixture decision is taken at. */
export const NOW = '2026-09-23T00:00:00Z'

/** The suite revision every fixture benchmark record claims. */
export const SUITE_REVISION = 'orc-review-v1'

/** The configured DeepSeek Flash v4.1 high route the code policy defaults to. */
export const codeRoute: Route = { kind: 'provider', ...DEFAULT_CODE_ROUTE }

/** A provider route with no live backend version: never high-risk eligible. */
export const planRoute: Route = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' }

/** Codex CLI at its probed minimum version. */
export const codexRoute: Route = { kind: 'cli', cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' }

/** Claude Code CLI at its probed minimum version. */
export const claudeRoute: Route = { kind: 'cli', cli: 'claude', model: 'claude-opus-4-1', effort: 'high' }

/** Live catalog: exact model/effort per route, with the version the probe saw. */
export const catalog: CatalogSnapshot = {
  id: 'catalog-2026-09-23',
  observedAt: NOW,
  entries: [
    {
      routeKey: routeKey(codeRoute),
      backendVersion: '',
      model: codeRoute.kind === 'provider' ? codeRoute.model : '',
      efforts: [codeRoute.effort],
      accountAccess: false,
      sourceUrl: '',
      retrievedAt: NOW,
    },
    {
      routeKey: routeKey(planRoute),
      backendVersion: '',
      model: planRoute.kind === 'provider' ? planRoute.model : '',
      efforts: [planRoute.effort],
      accountAccess: false,
      sourceUrl: '',
      retrievedAt: NOW,
    },
    {
      routeKey: routeKey(codexRoute),
      backendVersion: '0.156.1',
      model: codexRoute.kind === 'cli' ? codexRoute.model : '',
      efforts: [codexRoute.effort],
      accountAccess: true,
      sourceUrl: '',
      retrievedAt: NOW,
    },
    {
      routeKey: routeKey(claudeRoute),
      backendVersion: '2.1.280',
      model: claudeRoute.kind === 'cli' ? claudeRoute.model : '',
      efforts: [claudeRoute.effort],
      accountAccess: true,
      sourceUrl: '',
      retrievedAt: NOW,
    },
  ],
}

/** Versioned ORC benchmark set: claude leads on quality, codex is cheaper. */
export const benchmarks: BenchmarkSnapshot = {
  id: 'benchmarks-2026-09-23',
  suiteRevision: SUITE_REVISION,
  records: [
    {
      id: 'codex-high',
      suiteRevision: SUITE_REVISION,
      backend: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      backendVersion: '0.156.1',
      date: '2026-09-20T00:00:00Z',
      scope: ['financial', 'security'],
      detectionScore: 0.9,
      falsePositiveScore: 0.1,
      latencyMs: 1200,
      costUsd: 0.5,
    },
    {
      id: 'claude-high',
      suiteRevision: SUITE_REVISION,
      backend: 'claude',
      model: 'claude-opus-4-1',
      effort: 'high',
      backendVersion: '2.1.280',
      date: '2026-09-21T00:00:00Z',
      scope: ['financial', 'security'],
      detectionScore: 0.92,
      falsePositiveScore: 0.08,
      latencyMs: 1500,
      costUsd: 0.6,
    },
  ],
}

/** The fixture config for one analysis mode; Manual assigns every stage. */
export function config(mode: 'manual' | 'auto'): OrcConfig {
  const allowed = [codeRoute, planRoute, codexRoute, claudeRoute]
  return {
    sessionMode: 'adaptive',
    codeRoute: undefined,
    analysisMode: mode,
    manual: mode === 'manual'
      ? { spec: planRoute, plan: planRoute, review: codexRoute, audit: claudeRoute }
      : { spec: undefined, plan: undefined, review: undefined, audit: undefined },
    allowed,
    cliPaths: {},
    catalogMaxAgeDays: 7,
  }
}

/**
 * The backend identity used for the review/audit independence comparison.
 * Delegates to the domain helper so the fixture cannot drift from selection.
 */
export const routeBackend = (route: Route): string => backendIdentity(route)

/** One verified fixture field a failure test may change. */
export interface FixtureChange {
  readonly allowed?: readonly Route[]
  /** Replace every catalog entry's model; `[]` means no model is advertised. */
  readonly catalogModels?: readonly string[]
  /** Replace every catalog entry's accepted efforts. */
  readonly catalogEfforts?: readonly string[]
  readonly benchmarkDate?: string
  readonly benchmarkVersion?: string
  readonly benchmarkEffort?: string
  readonly maxCostUsd?: number
  /** Restrict the allowlist to one backend, as a user allowlist would. */
  readonly onlyBackend?: string
  /** Select the review decision that audit must be independent from. */
  readonly priorBackend?: string
}

/**
 * Build the fixture, apply exactly one {@link FixtureChange}, and run real
 * selection. A `priorBackend` is resolved by actually selecting the review
 * stage, so the independence case is driven by the same code under test.
 */
export function selectFixtureRoute(
  stage: Stage,
  riskLevel: RiskLevel,
  change: FixtureChange = {},
): RouteDecision {
  const base = config('auto')
  const allowed = (change.allowed ?? base.allowed)
    .filter(route => change.onlyBackend === undefined || routeBackend(route) === change.onlyBackend)
  const cfg: OrcConfig = { ...base, allowed, maxCostUsd: change.maxCostUsd ?? base.maxCostUsd }

  let entries = catalog.entries
  if (change.catalogModels !== undefined) {
    const model = change.catalogModels[0] ?? ''
    entries = entries.map(entry => ({ ...entry, model }))
  }
  if (change.catalogEfforts !== undefined) {
    const efforts = [...change.catalogEfforts]
    entries = entries.map(entry => ({ ...entry, efforts }))
  }
  const cat: CatalogSnapshot = { ...catalog, entries }

  const bench: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({
      ...record,
      date: change.benchmarkDate ?? record.date,
      backendVersion: change.benchmarkVersion ?? record.backendVersion,
      effort: change.benchmarkEffort ?? record.effort,
    })),
  }

  const risk: RiskDecision = {
    path: 'orc',
    risk: riskLevel,
    reasons: riskLevel === 'high' ? ['high-impact'] : [],
  }
  const prior = change.priorBackend === undefined
    ? undefined
    : fixturePrior(risk, cfg, cat, bench, change.priorBackend)
  return selectRoute(stage, risk, cfg, cat, bench, NOW, prior)
}

/** Resolve the review decision the audit must not share a backend with. */
function fixturePrior(
  risk: RiskDecision,
  cfg: OrcConfig,
  cat: CatalogSnapshot,
  bench: BenchmarkSnapshot,
  backend: string,
): RouteDecision {
  const prior = selectRoute('review', risk, cfg, cat, bench, NOW)
  const actual = routeBackend(prior.route)
  if (actual !== backend) {
    throw new Error(`fixture prior backend "${backend}" is not selectable for review (got "${actual}")`)
  }
  return prior
}
