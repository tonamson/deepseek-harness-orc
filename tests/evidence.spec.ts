/**
 * Benchmark evidence admission.
 *
 * These tests pin the fail-closed rules the route selector depends on: exact
 * backend/model/effort identity, a real and equal backend version (R22), the
 * current suite revision, an inclusive age bound, and the required scope.
 */

import { expect, it } from 'vitest'
import { routeKey } from '../src/domain/config.js'
import {
  BENCHMARK_SUITE_REVISION,
  backendIdentity,
  benchmarkIdentity,
  benchmarkMatches,
  catalogEntry,
  catalogHasExactModelEffort,
  isFresh,
  type BenchmarkEvidence,
  type BenchmarkSnapshot,
} from '../src/domain/evidence.js'
import type { CatalogSnapshot } from '../src/domain/types.js'
import { NOW, benchmarks, catalog, claudeRoute, codeRoute, codexRoute, planRoute } from './fixtures/routes.js'

const SCOPE = ['financial', 'security'] as const
const MAX_AGE_DAYS = 7

const codexRecord = benchmarks.records.find(record => record.backend === 'codex') as BenchmarkEvidence

/** Replace the codex catalog entry's backend version. */
const withCatalogVersion = (version: string): CatalogSnapshot => ({
  ...catalog,
  entries: catalog.entries.map(entry =>
    entry.routeKey === routeKey(codexRoute) ? { ...entry, backendVersion: version } : entry),
})

/** Patch the codex benchmark record, leaving every other record untouched. */
const withCodexRecord = (patch: Partial<BenchmarkEvidence>): BenchmarkSnapshot => ({
  ...benchmarks,
  records: benchmarks.records.map(record =>
    record.backend === 'codex' ? { ...record, ...patch } : record),
})

const matchesCodex = (snapshot: BenchmarkSnapshot, cat: CatalogSnapshot = catalog): boolean =>
  benchmarkMatches(snapshot, codexRoute, cat, NOW, SCOPE, MAX_AGE_DAYS) !== undefined

it('resolves the exact catalog entry for a route', () => {
  expect(catalogEntry(catalog, codexRoute)?.routeKey).toBe(routeKey(codexRoute))
  expect(catalogEntry(catalog, { kind: 'cli', cli: 'claude', model: 'absent', effort: 'high' })).toBeUndefined()
})

it('requires the exact model and effort the live catalog advertises', () => {
  expect(catalogHasExactModelEffort(catalog, codexRoute)).toBe(true)
  expect(catalogHasExactModelEffort(catalog, claudeRoute)).toBe(true)
  const wrongEffort: CatalogSnapshot = {
    ...catalog,
    entries: catalog.entries.map(entry =>
      entry.routeKey === routeKey(codexRoute) ? { ...entry, efforts: ['low'] } : entry),
  }
  expect(catalogHasExactModelEffort(wrongEffort, codexRoute)).toBe(false)
  const wrongModel: CatalogSnapshot = {
    ...catalog,
    entries: catalog.entries.map(entry =>
      entry.routeKey === routeKey(codexRoute) ? { ...entry, model: 'other' } : entry),
  }
  expect(catalogHasExactModelEffort(wrongModel, codexRoute)).toBe(false)
})

it('does not treat accountAccess as an eligibility filter (R23)', () => {
  const entry = catalogEntry(catalog, codeRoute)
  expect(entry?.accountAccess).toBe(false)
  expect(catalogHasExactModelEffort(catalog, codeRoute)).toBe(true)
})

it('identifies a route backend by provider name or CLI name', () => {
  expect(backendIdentity(codeRoute)).toBe('deepseek')
  expect(backendIdentity(planRoute)).toBe('custom')
  expect(backendIdentity(codexRoute)).toBe('codex')
  expect(backendIdentity(claudeRoute)).toBe('claude')
})

it('matches a benchmark record to an exact route and catalog version', () => {
  const matched = benchmarkMatches(benchmarks, codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)
  expect(matched?.id).toBe('codex-high')
  expect(benchmarkIdentity(benchmarks, codexRecord)).toBe(`${benchmarks.id}/codex-high`)
})

it('selects the newest admissible record regardless of snapshot array order (R25)', () => {
  const olderStronger: BenchmarkEvidence = {
    ...codexRecord,
    id: 'codex-older',
    date: '2026-09-19T00:00:00Z',
    detectionScore: 0.95,
    falsePositiveScore: 0.05,
  }
  const newerWeaker: BenchmarkEvidence = {
    ...codexRecord,
    id: 'codex-newer',
    date: '2026-09-22T00:00:00Z',
    detectionScore: 0.81,
    falsePositiveScore: 0.19,
  }
  const olderFirst: BenchmarkSnapshot = { ...benchmarks, records: [olderStronger, newerWeaker] }
  const newerFirst: BenchmarkSnapshot = { ...benchmarks, records: [newerWeaker, olderStronger] }
  expect(benchmarkMatches(olderFirst, codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-newer')
  expect(benchmarkMatches(newerFirst, codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-newer')
})

it('breaks equal-date evidence by detection, then false positives, then lexical id (R25)', () => {
  const date = '2026-09-22T00:00:00Z'
  const weak: BenchmarkEvidence = { ...codexRecord, id: 'codex-b', date, detectionScore: 0.8, falsePositiveScore: 0.1 }
  const strong: BenchmarkEvidence = { ...codexRecord, id: 'codex-b', date, detectionScore: 0.9, falsePositiveScore: 0.2 }
  const strongLowFp: BenchmarkEvidence = { ...codexRecord, id: 'codex-a', date, detectionScore: 0.9, falsePositiveScore: 0.05 }
  const snapshot = (records: BenchmarkEvidence[]): BenchmarkSnapshot => ({ ...benchmarks, records })
  expect(benchmarkMatches(snapshot([weak, strong]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-b')
  expect(benchmarkMatches(snapshot([strong, weak]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-b')
  expect(benchmarkMatches(snapshot([strong, strongLowFp]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-a')
  expect(benchmarkMatches(snapshot([strongLowFp, strong]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-a')
  const twinA: BenchmarkEvidence = { ...strongLowFp, id: 'codex-a' }
  const twinB: BenchmarkEvidence = { ...strongLowFp, id: 'codex-b' }
  expect(benchmarkMatches(snapshot([twinB, twinA]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-a')
  expect(benchmarkMatches(snapshot([twinA, twinB]), codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-a')
})

it('ignores admissible records for other routes when selecting evidence', () => {
  const claudeRecord = benchmarks.records.find(record => record.backend === 'claude') as BenchmarkEvidence
  const mixed: BenchmarkSnapshot = { ...benchmarks, records: [claudeRecord, codexRecord] }
  expect(benchmarkMatches(mixed, codexRoute, catalog, NOW, SCOPE, MAX_AGE_DAYS)?.id).toBe('codex-high')
})

it('requires a real, non-empty, equal backend version (R22)', () => {
  expect(matchesCodex(benchmarks, withCatalogVersion(''))).toBe(false)
  expect(matchesCodex(withCodexRecord({ backendVersion: '' }))).toBe(false)
  expect(matchesCodex(withCodexRecord({ backendVersion: '0.155.1' }))).toBe(false)
  expect(matchesCodex(benchmarks, withCatalogVersion('0.156.1'))).toBe(true)
})

it('requires the current suite revision on both the snapshot and the record', () => {
  expect(matchesCodex({ ...benchmarks, suiteRevision: 'orc-review-v0' })).toBe(false)
  expect(matchesCodex(withCodexRecord({ suiteRevision: 'orc-review-v0' }))).toBe(false)
  expect(BENCHMARK_SUITE_REVISION).toBe('orc-review-v1')
})

it('requires the record to cover the whole required scope', () => {
  expect(matchesCodex(withCodexRecord({ scope: ['financial'] }))).toBe(false)
  expect(matchesCodex(withCodexRecord({ scope: ['security'] }))).toBe(false)
  expect(matchesCodex(withCodexRecord({ scope: ['financial', 'security', 'performance'] }))).toBe(true)
})

it('requires the exact backend, model, and effort', () => {
  expect(matchesCodex(withCodexRecord({ backend: 'claude' }))).toBe(false)
  expect(matchesCodex(withCodexRecord({ model: 'other' }))).toBe(false)
  expect(matchesCodex(withCodexRecord({ effort: 'low' }))).toBe(false)
})

it('admits evidence exactly at the age bound and rejects anything older', () => {
  expect(isFresh({ ...codexRecord, date: '2026-09-16T00:00:00Z' }, NOW, MAX_AGE_DAYS)).toBe(true)
  expect(isFresh({ ...codexRecord, date: '2026-09-15T23:59:59.999Z' }, NOW, MAX_AGE_DAYS)).toBe(false)
  expect(matchesCodex(withCodexRecord({ date: '2026-09-16T00:00:00Z' }))).toBe(true)
  expect(matchesCodex(withCodexRecord({ date: '2025-01-01T00:00:00Z' }))).toBe(false)
})

it('rejects future-dated and malformed evidence', () => {
  expect(isFresh({ ...codexRecord, date: '2026-09-24T00:00:00Z' }, NOW, MAX_AGE_DAYS)).toBe(false)
  expect(isFresh({ ...codexRecord, date: 'not-a-date' }, NOW, MAX_AGE_DAYS)).toBe(false)
  expect(isFresh(codexRecord, 'not-a-date', MAX_AGE_DAYS)).toBe(false)
  expect(matchesCodex(withCodexRecord({ date: '2026-09-24T00:00:00Z' }))).toBe(false)
})

it('matches nothing when the catalog has no entry for the route', () => {
  const empty: CatalogSnapshot = { ...catalog, entries: [] }
  expect(benchmarkMatches(benchmarks, codexRoute, empty, NOW, SCOPE, MAX_AGE_DAYS)).toBeUndefined()
})
