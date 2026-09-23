/**
 * Versioned benchmark evidence.
 *
 * Route selection is only as trustworthy as the evidence behind it, so this
 * module owns the one question routing asks about a benchmark record: does this
 * exact route have a current, in-scope, version-matched measurement? It is
 * deliberately pure — no clock, no I/O, no network — and it never reads a
 * vendor claim as a quality score.
 *
 * Two rules are load-bearing:
 *
 * - The suite revision is a constant, not whatever a snapshot claims. A
 *   snapshot or record from any other revision is not current evidence.
 * - A backend version must be real, non-empty, and equal to the live catalog's
 *   observation (R22). An unknown version is not a wildcard: a route whose
 *   backend version the live catalog cannot establish is ineligible for
 *   high-risk review/audit, which is how provider routes with DSH's
 *   version-less live catalog fail closed.
 */

import { routeKey } from './config.js'
import type { CatalogEntry, CatalogSnapshot, Route } from './types.js'

/** The only benchmark suite revision Auto accepts as current. */
export const BENCHMARK_SUITE_REVISION = 'orc-review-v1'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * One versioned ORC benchmark result for an exact route.
 *
 * `scope` names the evaluated risk areas; `detectionScore` and
 * `falsePositiveScore` are measured on the fixture suite, never derived from
 * provider documentation or marketing text.
 */
export interface BenchmarkEvidence {
  /** Identity of this run, unique within its snapshot. */
  id: string
  /** Suite revision the run used; only {@link BENCHMARK_SUITE_REVISION} is current. */
  suiteRevision: string
  /** Backend identity: provider name for a provider route, CLI name for a CLI route. */
  backend: string
  model: string
  effort: string
  /** Version of the backend the run measured. */
  backendVersion: string
  /** ISO timestamp the run finished. */
  date: string
  /** Evaluated risk areas, e.g. `financial` and `security`. */
  scope: string[]
  /** Measured known-bug detection, 0..1; higher is better. */
  detectionScore: number
  /** Measured false-positive rate, 0..1; lower is better. */
  falsePositiveScore: number
  /** Measured wall-clock latency in milliseconds. */
  latencyMs: number
  /** Measured cost in USD. */
  costUsd: number
}

/** A versioned set of benchmark results, identified with every decision made from it. */
export interface BenchmarkSnapshot {
  id: string
  suiteRevision: string
  records: BenchmarkEvidence[]
}

/** The backend identity the independence comparison and evidence matching use. */
export const backendIdentity = (route: Route): string =>
  route.kind === 'provider' ? route.provider : route.cli

/** The live catalog entry for an exact route, if the catalog observed it. */
export const catalogEntry = (catalog: CatalogSnapshot, route: Route): CatalogEntry | undefined =>
  catalog.entries.find(entry => entry.routeKey === routeKey(route))

/**
 * Whether the live catalog observed this exact route with this exact model and
 * effort. `accountAccess` is carried metadata, not an eligibility filter here:
 * the only verified access signal ORC has is a green connection test, which is
 * Task 8's dispatch gate.
 */
export function catalogHasExactModelEffort(catalog: CatalogSnapshot, route: Route): boolean {
  const entry = catalogEntry(catalog, route)
  return entry !== undefined && entry.model === route.model && entry.efforts.includes(route.effort)
}

/** Whether evidence is dated no earlier than `maxAgeDays` before `now`. */
export function isFresh(record: BenchmarkEvidence, now: string, maxAgeDays: number): boolean {
  const observed = Date.parse(record.date)
  const at = Date.parse(now)
  if (!Number.isFinite(observed) || !Number.isFinite(at)) return false
  const ageMs = at - observed
  // Future-dated evidence is malformed, not young: it fails closed too.
  return ageMs >= 0 && ageMs <= maxAgeDays * MS_PER_DAY
}

/** Whether one record is admissible evidence for an exact route and version. */
function isAdmissible(
  record: BenchmarkEvidence,
  backend: string,
  route: Route,
  version: string,
  requiredScope: readonly string[],
  now: string,
  maxAgeDays: number,
): boolean {
  return record.backend === backend &&
    record.model === route.model &&
    record.effort === route.effort &&
    record.backendVersion.length > 0 &&
    record.backendVersion === version &&
    record.suiteRevision === BENCHMARK_SUITE_REVISION &&
    requiredScope.every(scope => record.scope.includes(scope)) &&
    isFresh(record, now, maxAgeDays)
}

/**
 * Order admissible records for one route: newest `date` first, then the
 * highest validated detection, then the lowest false-positive score, then
 * lexical `id`. Snapshot array position is never consulted, so the same
 * records in any order select the same evidence (R25).
 */
const compareEvidence = (a: BenchmarkEvidence, b: BenchmarkEvidence): number => {
  const age = Date.parse(b.date) - Date.parse(a.date)
  if (age !== 0) return age
  if (a.detectionScore !== b.detectionScore) return b.detectionScore - a.detectionScore
  if (a.falsePositiveScore !== b.falsePositiveScore) return a.falsePositiveScore - b.falsePositiveScore
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The current benchmark record for an exact route, or `undefined` when the
 * route has no admissible evidence.
 *
 * Admission requires all of: an exact live catalog entry, a real and equal
 * non-empty backend version, the current suite revision on both snapshot and
 * record, the exact backend/model/effort, every required scope, and an age
 * within `maxAgeDays`. Among several admissible runs for the same route the
 * newest is selected — an older passing run never masks a newer failing one.
 */
export function benchmarkMatches(
  benchmarks: BenchmarkSnapshot,
  route: Route,
  catalog: CatalogSnapshot,
  now: string,
  requiredScope: readonly string[],
  maxAgeDays: number,
): BenchmarkEvidence | undefined {
  if (benchmarks.suiteRevision !== BENCHMARK_SUITE_REVISION) return undefined
  if (!catalogHasExactModelEffort(catalog, route)) return undefined
  const version = catalogEntry(catalog, route)?.backendVersion ?? ''
  // R22: an unknown live version can never match, so it can never qualify.
  if (version.length === 0) return undefined
  const backend = backendIdentity(route)
  return benchmarks.records
    .filter(record => isAdmissible(record, backend, route, version, requiredScope, now, maxAgeDays))
    .sort(compareEvidence)[0]
}

/** The identity recorded on a decision that used this exact benchmark record. */
export const benchmarkIdentity = (benchmarks: BenchmarkSnapshot, record: BenchmarkEvidence): string =>
  `${benchmarks.id}/${record.id}`
