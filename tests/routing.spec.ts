/**
 * Route-selection behavior.
 *
 * Every test drives the real `selectRoute` entry point. The failure table
 * changes exactly one verified fixture field per case so the cause of a
 * refusal is unambiguous, and the independence case resolves its review
 * decision by actually selecting the review stage.
 */

import { expect, it } from 'vitest'
import type { BenchmarkSnapshot } from '../src/domain/evidence.js'
import { routeKey } from '../src/domain/config.js'
import type { RiskDecision } from '../src/domain/risk.js'
import { selectRoute } from '../src/domain/routing.js'
import {
  NOW,
  benchmarks,
  catalog,
  claudeRoute,
  codeRoute,
  codexRoute,
  config,
  routeBackend,
  selectFixtureRoute,
} from './fixtures/routes.js'

const lowRisk: RiskDecision = { path: 'orc', risk: 'low', reasons: [] }
const highRisk: RiskDecision = { path: 'orc', risk: 'high', reasons: ['high-impact'] }

it('uses only allowed exact routes in Manual mode', () => {
  const selected = selectRoute('plan', { path: 'orc', risk: 'low', reasons: [] }, config('manual'), catalog, benchmarks, '2026-09-23T00:00:00Z')
  expect(selected.route).toEqual(config('manual').manual.plan)
  expect(selected.catalogId).toBe(catalog.id)
})

it('requires independent evidence-qualified review and audit for money changes', () => {
  const risk = { path: 'orc', risk: 'high', reasons: ['high-impact'] } as const
  const review = selectRoute('review', risk, config('auto'), catalog, benchmarks, '2026-09-23T00:00:00Z')
  const audit = selectRoute('audit', risk, config('auto'), catalog, benchmarks, '2026-09-23T00:00:00Z', review)
  expect(audit.route.kind === review.route.kind && routeBackend(audit.route) === routeBackend(review.route)).toBe(false)
  expect(review.benchmarkId).toBeTruthy()
  expect(audit.benchmarkId).toBeTruthy()
})

it.each([
  ['unlisted', { allowed: [] }],
  ['missing-model', { catalogModels: [] }],
  ['wrong-effort', { catalogEfforts: ['low'] }],
  ['stale-benchmark', { benchmarkDate: '2025-01-01' }],
  ['wrong-backend-version', { benchmarkVersion: '0.155.1' }],
  ['cost-cap', { maxCostUsd: 0 }],
] as const)('%s has no qualifying route', (_name, change) => {
  expect(() => selectFixtureRoute('audit', 'high', change)).toThrow(/no-qualifying-route/)
})

it('rejects a benchmark run recorded at a different effort', () => {
  expect(() => selectFixtureRoute('audit', 'high', { benchmarkEffort: 'low' })).toThrow(/no-qualifying-route/)
})

it('requires an audit route on a backend independent of review', () => {
  expect(() => selectFixtureRoute('audit', 'high', { priorBackend: 'codex', onlyBackend: 'codex' })).toThrow(/independent/)
})

it('prefers the highest validated detection quality for high-risk review and audit', () => {
  const selected = selectRoute('audit', highRisk, config('auto'), catalog, benchmarks, NOW)
  expect(routeBackend(selected.route)).toBe('claude')
  expect(selected.benchmarkId).toBe(`${benchmarks.id}/claude-high`)
})

it('breaks equal validated quality by lower cost, then latency', () => {
  const equalQuality: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({
      ...record,
      detectionScore: 0.9,
      falsePositiveScore: 0.1,
      costUsd: record.backend === 'claude' ? 5 : 0.5,
      latencyMs: record.backend === 'claude' ? 1 : 10_000,
    })),
  }
  expect(routeBackend(selectRoute('audit', highRisk, config('auto'), catalog, equalQuality, NOW).route)).toBe('codex')
})

it('breaks a fully equal tie by lexical routeKey', () => {
  const identical: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({
      ...record,
      detectionScore: 0.9,
      falsePositiveScore: 0.1,
      costUsd: 0.5,
      latencyMs: 1200,
    })),
  }
  const selected = selectRoute('audit', highRisk, config('auto'), catalog, identical, NOW)
  // cli:claude… sorts before cli:codex…, so the tie is reproducible.
  expect(routeBackend(selected.route)).toBe('claude')
})

it('chooses the least costly eligible route for a low-risk stage', () => {
  const onlyClis = { ...config('auto'), allowed: [claudeRoute, codexRoute] }
  const selected = selectRoute('review', lowRisk, onlyClis, catalog, benchmarks, NOW)
  expect(routeBackend(selected.route)).toBe('codex')
  expect(selected.estimatedCostUsd).toBe(0.5)
})

it('fails closed when every validated record is below the stage quality floor', () => {
  const weak: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({
      ...record,
      detectionScore: 0.5,
      falsePositiveScore: 0.5,
    })),
  }
  expect(() => selectRoute('audit', highRisk, config('auto'), catalog, weak, NOW)).toThrow(/no-qualifying-route/)
})

it('never lowers the quality floor to satisfy a cost ceiling', () => {
  const weakAndFree: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({
      ...record,
      detectionScore: 0.5,
      falsePositiveScore: 0.5,
      costUsd: 0,
    })),
  }
  const capped = { ...config('auto'), maxCostUsd: 1 }
  expect(() => selectRoute('audit', highRisk, capped, catalog, weakAndFree, NOW)).toThrow(/no-qualifying-route/)
})

it('rejects a benchmark snapshot from a different suite revision', () => {
  const oldSuite: BenchmarkSnapshot = { ...benchmarks, suiteRevision: 'orc-review-v0' }
  expect(() => selectRoute('audit', highRisk, config('auto'), catalog, oldSuite, NOW)).toThrow(/no-qualifying-route/)
})

it('excludes a provider route whose live backend version is unknown from high-risk audit', () => {
  const providerOnly = { ...config('auto'), allowed: [codeRoute] }
  expect(() => selectRoute('audit', highRisk, providerOnly, catalog, benchmarks, NOW)).toThrow(/no-qualifying-route/)
})

it('fails closed when a Manual high-risk route lacks fresh evidence', () => {
  const stale: BenchmarkSnapshot = {
    ...benchmarks,
    records: benchmarks.records.map(record => ({ ...record, date: '2025-01-01T00:00:00Z' })),
  }
  expect(() => selectRoute('audit', highRisk, config('manual'), catalog, stale, NOW)).toThrow(/no-qualifying-route/)
})

it('refuses a Manual route that is not on the allowlist', () => {
  const unlisted = { ...config('manual'), allowed: [] }
  expect(() => selectRoute('plan', lowRisk, unlisted, catalog, benchmarks, NOW)).toThrow(/no-qualifying-route/)
})

it('refuses an unassigned Manual stage', () => {
  const base = config('manual')
  const unassigned = { ...base, manual: { ...base.manual, plan: undefined } }
  expect(() => selectRoute('plan', lowRisk, unassigned, catalog, benchmarks, NOW)).toThrow(/no-qualifying-route/)
})

it('records the catalog, benchmark, risk, reason, and cost on the decision', () => {
  const selected = selectRoute('audit', highRisk, config('auto'), catalog, benchmarks, NOW)
  expect(selected.stage).toBe('audit')
  expect(selected.risk).toEqual(highRisk)
  expect(selected.catalogId).toBe(catalog.id)
  expect(selected.reason).toContain('validated')
  expect(selected.estimatedCostUsd).toBeGreaterThan(0)
})

it('selects the configured DeepSeek Flash v4.1 high route for code', () => {
  const selected = selectRoute('code', lowRisk, config('auto'), catalog, benchmarks, NOW)
  expect(selected.route).toEqual(codeRoute)
  expect(selected.benchmarkId).toBeNull()
})

it('honors an explicitly configured code route', () => {
  const explicit = { ...config('auto'), codeRoute: claudeRoute }
  expect(selectRoute('code', lowRisk, explicit, catalog, benchmarks, NOW).route).toEqual(claudeRoute)
})

it('asks for a code route instead of inventing one', () => {
  const withoutDefault = {
    ...config('auto'),
    allowed: config('auto').allowed.filter(route => routeKey(route) !== routeKey(codeRoute)),
  }
  expect(() => selectRoute('code', lowRisk, withoutDefault, catalog, benchmarks, NOW)).toThrow(/select or configure/)
})
