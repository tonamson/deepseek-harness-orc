/**
 * Manual and Auto route selection.
 *
 * `selectRoute` is the one gate the ORC service calls before every dispatch. It
 * resolves a {@link Route} from the user's allowlist plus live catalog and
 * versioned benchmark evidence, and returns a {@link RouteDecision} the caller
 * logs before dispatch.
 *
 * The policy is fail-closed and has no hidden fallback:
 *
 * - Manual mode uses the exact route the user assigned, and only if that route
 *   is on the allowlist and the live catalog serves the exact model/effort.
 * - Auto ranks only live, allowlisted routes. High-risk review and audit must
 *   carry current benchmark evidence covering financial and security risk, and
 *   audit must run on a different backend from review. Missing, stale, or
 *   version-unknown evidence excludes a route; it never downgrades silently.
 * - A cost ceiling may exclude a route, but it can neither lower the quality
 *   floor nor admit a route outside the allowlist.
 * - Code is not benchmark-gated: it uses the user's configured code route, or
 *   the DeepSeek Flash v4.1 high route when that is available. Otherwise the
 *   stage stops and asks the user to configure a route.
 */

import { routeKey } from './config.js'
import {
  backendIdentity,
  benchmarkIdentity,
  benchmarkMatches,
  catalogHasExactModelEffort,
  type BenchmarkEvidence,
  type BenchmarkSnapshot,
} from './evidence.js'
import type { RiskDecision } from './risk.js'
import type { AnalysisStage, CatalogSnapshot, OrcConfig, Route, Stage } from './types.js'

/**
 * The model the code policy defaults to when the user has pinned no route.
 * The provider id is the user's configured choice, so the default is
 * identified by model plus effort and never by a hardcoded provider (R24).
 */
export const DEFAULT_CODE_MODEL = 'deepseek-v4.1-flash'

/** The reasoning effort the DeepSeek Flash v4.1 code default requires. */
export const DEFAULT_CODE_EFFORT = 'high'

/** Risk scopes a high-risk review or audit must have measured. */
const REQUIRED_SCOPE = ['financial', 'security'] as const

/** Why no route could be selected. Each maps to one actionable failure. */
export type RouteErrorCode = 'no-qualifying-route' | 'no-independent-route' | 'no-code-route'

const ROUTE_ERROR_MESSAGES: Record<RouteErrorCode, (stage: Stage) => string> = {
  'no-qualifying-route': stage =>
    `no-qualifying-route: no allowed route meets the evidence and cost rules for ${stage}`,
  'no-independent-route': stage =>
    `no-independent-route for ${stage}: every eligible backend is already used by the paired review stage`,
  'no-code-route': () =>
    'no-code-route: no configured DeepSeek Flash v4.1 high route is available; ask the user to select or configure a code route',
}

/** A selection refusal carrying an ORC-owned code and the affected stage. */
export class RouteError extends Error {
  readonly code: RouteErrorCode
  readonly stage: Stage

  constructor(code: RouteErrorCode, stage: Stage) {
    super(ROUTE_ERROR_MESSAGES[code](stage))
    this.name = 'RouteError'
    this.code = code
    this.stage = stage
  }
}

/** The route, its evidence identity, and why it was chosen. Logged before dispatch. */
export interface RouteDecision {
  route: Route
  stage: Stage
  risk: RiskDecision
  /** Identity of the catalog snapshot the route was resolved from. */
  catalogId: string
  /** Identity of the benchmark record used, or `null` when none was needed. */
  benchmarkId: string | null
  reason: string
  /** Validated benchmark cost when known; `0` means no measured cost. */
  estimatedCostUsd: number
}

/** Minimum measured quality a stage accepts. */
interface QualityFloor {
  readonly detection: number
  readonly falsePositive: number
}

const QUALITY_FLOORS: Record<Stage, QualityFloor> = {
  code: { detection: 0, falsePositive: 1 },
  spec: { detection: 0.5, falsePositive: 0.5 },
  plan: { detection: 0.5, falsePositive: 0.5 },
  review: { detection: 0.8, falsePositive: 0.2 },
  audit: { detection: 0.8, falsePositive: 0.2 },
}

/** High-risk review and audit are the only stages that require validated evidence. */
const requiresValidatedEvidence = (stage: Stage, risk: RiskDecision): boolean =>
  risk.risk === 'high' && (stage === 'review' || stage === 'audit')

/** Audit must not reuse review's backend, so the two stages stay independent. */
const requiresIndependentBackend = (
  stage: Stage,
  prior: RouteDecision | undefined,
): prior is RouteDecision =>
  prior !== undefined && stage === 'audit' && prior.stage === 'review'

/**
 * Select the route for one stage.
 *
 * @param stage the workflow stage being dispatched
 * @param risk the classifier's decision, including whether evidence is required
 * @param config the validated ORC policy and allowlist
 * @param catalog the live provider/CLI observation
 * @param benchmarks the versioned benchmark snapshot
 * @param now the ISO instant freshness is judged against
 * @param prior the review decision, when selecting its paired audit
 */
export function selectRoute(
  stage: Stage,
  risk: RiskDecision,
  config: OrcConfig,
  catalog: CatalogSnapshot,
  benchmarks: BenchmarkSnapshot,
  now: string,
  prior?: RouteDecision,
): RouteDecision {
  if (stage === 'code') return selectCodeRoute(risk, config, catalog, benchmarks, now)
  return config.analysisMode === 'manual'
    ? selectManualRoute(stage, risk, config, catalog, benchmarks, now, prior)
    : selectAutoRoute(stage, risk, config, catalog, benchmarks, now, prior)
}

/** Code uses the pinned code route, else the available DeepSeek Flash v4.1 default. */
function selectCodeRoute(
  risk: RiskDecision,
  config: OrcConfig,
  catalog: CatalogSnapshot,
  benchmarks: BenchmarkSnapshot,
  now: string,
): RouteDecision {
  const configured = config.codeRoute
  if (configured !== undefined) {
    if (!catalogHasExactModelEffort(catalog, configured)) throw new RouteError('no-code-route', 'code')
    return decision(configured, 'code', risk, config, catalog, benchmarks, now, 'configured code route')
  }
  const fallback = config.allowed
    .filter(route => isDefaultCodeRoute(route) && catalogHasExactModelEffort(catalog, route))
    .sort(compareRouteKey)[0]
  if (fallback === undefined) throw new RouteError('no-code-route', 'code')
  return decision(fallback, 'code', risk, config, catalog, benchmarks, now, 'default DeepSeek Flash v4.1 high route')
}

/**
 * Whether a route is the DeepSeek Flash v4.1 high route the code policy
 * defaults to. Identity is model plus effort: the provider id is the user's to
 * choose, so it is deliberately not compared (R24).
 */
const isDefaultCodeRoute = (route: Route): boolean =>
  route.kind === 'provider' &&
  route.model === DEFAULT_CODE_MODEL &&
  route.effort === DEFAULT_CODE_EFFORT

/** Manual honors the user's exact assignment, bounded by the allowlist and evidence. */
function selectManualRoute(
  stage: AnalysisStage,
  risk: RiskDecision,
  config: OrcConfig,
  catalog: CatalogSnapshot,
  benchmarks: BenchmarkSnapshot,
  now: string,
  prior: RouteDecision | undefined,
): RouteDecision {
  const route = config.manual[stage]
  if (route === undefined) throw new RouteError('no-qualifying-route', stage)
  if (!config.allowed.some(allowed => routeKey(allowed) === routeKey(route))) {
    throw new RouteError('no-qualifying-route', stage)
  }
  if (!catalogHasExactModelEffort(catalog, route)) throw new RouteError('no-qualifying-route', stage)
  const record = benchmarkMatches(benchmarks, route, catalog, now, REQUIRED_SCOPE, config.catalogMaxAgeDays)
  if (requiresValidatedEvidence(stage, risk) && record === undefined) {
    throw new RouteError('no-qualifying-route', stage)
  }
  if (record !== undefined && !meetsQualityFloor(stage, record)) throw new RouteError('no-qualifying-route', stage)
  if (requiresIndependentBackend(stage, prior) && backendIdentity(route) === backendIdentity(prior.route)) {
    throw new RouteError('no-independent-route', stage)
  }
  return decision(route, stage, risk, config, catalog, benchmarks, now, `manual ${stage} route`)
}

/** One allowlisted route that survived the live-catalog, evidence, and cost filters. */
interface Candidate {
  readonly route: Route
  readonly record: BenchmarkEvidence | undefined
}

/** Auto ranks only live, allowlisted routes and never substitutes an unallowed one. */
function selectAutoRoute(
  stage: AnalysisStage,
  risk: RiskDecision,
  config: OrcConfig,
  catalog: CatalogSnapshot,
  benchmarks: BenchmarkSnapshot,
  now: string,
  prior: RouteDecision | undefined,
): RouteDecision {
  const validated = requiresValidatedEvidence(stage, risk)
  const candidates: Candidate[] = []
  for (const route of config.allowed) {
    if (!catalogHasExactModelEffort(catalog, route)) continue
    const record = benchmarkMatches(benchmarks, route, catalog, now, REQUIRED_SCOPE, config.catalogMaxAgeDays)
    if (validated && record === undefined) continue
    if (record !== undefined && !meetsQualityFloor(stage, record)) continue
    if (config.maxCostUsd !== undefined && costOf(record) > config.maxCostUsd) continue
    candidates.push({ route, record })
  }
  if (candidates.length === 0) throw new RouteError('no-qualifying-route', stage)
  const independent = requiresIndependentBackend(stage, prior)
    ? candidates.filter(candidate => backendIdentity(candidate.route) !== backendIdentity(prior.route))
    : candidates
  if (independent.length === 0) throw new RouteError('no-independent-route', stage)
  const ranked = [...independent].sort(validated ? compareValidated : compareLeastCost)
  const winner = ranked[0]
  const reason = validated
    ? `auto: highest validated quality for high-risk ${stage}`
    : `auto: least costly route meeting the ${stage} quality floor`
  return decision(winner.route, stage, risk, config, catalog, benchmarks, now, reason)
}

const meetsQualityFloor = (stage: Stage, record: BenchmarkEvidence): boolean =>
  record.detectionScore >= QUALITY_FLOORS[stage].detection &&
  record.falsePositiveScore <= QUALITY_FLOORS[stage].falsePositive

/**
 * Validated benchmark cost. A route with no measured evidence costs `0` here:
 * low-risk stages do not require evidence, so an unmeasured route is treated as
 * having no known charge rather than being excluded by the ceiling or ranking.
 */
const costOf = (record: BenchmarkEvidence | undefined): number => record?.costUsd ?? 0

const latencyOf = (record: BenchmarkEvidence | undefined): number => record?.latencyMs ?? 0

/**
 * High-risk ranking: validated detection first, then lower false positives,
 * then the shared cost/latency/routeKey tie-break.
 */
const compareValidated = (a: Candidate, b: Candidate): number => {
  const left = a.record as BenchmarkEvidence
  const right = b.record as BenchmarkEvidence
  if (right.detectionScore !== left.detectionScore) return right.detectionScore - left.detectionScore
  if (left.falsePositiveScore !== right.falsePositiveScore) return left.falsePositiveScore - right.falsePositiveScore
  return compareLeastCost(a, b)
}

/**
 * Low-risk ranking: least costly, then lowest latency, then lexical routeKey.
 * `routeKey` is unique per route and compared as plain strings, so the order is
 * total and reproducible — no collection iteration order leaks into the result.
 */
const compareLeastCost = (a: Candidate, b: Candidate): number => {
  const cost = costOf(a.record) - costOf(b.record)
  if (cost !== 0) return cost
  const latency = latencyOf(a.record) - latencyOf(b.record)
  if (latency !== 0) return latency
  return compareRouteKey(a.route, b.route)
}

/** Total, reproducible tie-break: lexical `routeKey` ascending. */
const compareRouteKey = (a: Route, b: Route): number => {
  const left = routeKey(a)
  const right = routeKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/** Assemble the logged decision, resolving the benchmark identity it used. */
function decision(
  route: Route,
  stage: Stage,
  risk: RiskDecision,
  config: OrcConfig,
  catalog: CatalogSnapshot,
  benchmarks: BenchmarkSnapshot,
  now: string,
  reason: string,
): RouteDecision {
  const record = benchmarkMatches(benchmarks, route, catalog, now, REQUIRED_SCOPE, config.catalogMaxAgeDays)
  return {
    route,
    stage,
    risk,
    catalogId: catalog.id,
    benchmarkId: record === undefined ? null : benchmarkIdentity(benchmarks, record),
    reason,
    estimatedCostUsd: costOf(record),
  }
}
