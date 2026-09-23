import { expect, it } from 'vitest'
import { classifyRequest } from '../src/domain/risk.js'

const base = { text: 'Correct one typo', touchedPaths: ['README.md'], plannedFiles: 1, hasArchitectureChange: false, explicitPlanOrReview: false }
it.each([
  [base, 'direct'],
  [{ ...base, plannedFiles: 3 }, 'orc'],
  [{ ...base, text: 'Fix balance rounding' }, 'orc'],
  [{ ...base, text: 'Repair withdrawal ledger entries' }, 'orc'],
  [{ ...base, touchedPaths: ['src/auth/permissions.ts'] }, 'orc'],
  [{ ...base, explicitPlanOrReview: true }, 'orc'],
  [{ ...base, discoveredRisk: true }, 'orc'],
] as const)('classifies %#', (input, path) => expect(classifyRequest(input).path).toBe(path))

it('marks high-impact work high risk with the high-impact reason', () => {
  expect(classifyRequest({ ...base, text: 'Fix balance rounding' })).toEqual({
    path: 'orc',
    risk: 'high',
    reasons: ['high-impact'],
  })
})

it('reports explicit planning or review as explicit-review', () => {
  expect(classifyRequest({ ...base, explicitPlanOrReview: true })).toEqual({
    path: 'orc',
    risk: 'low',
    reasons: ['explicit-review'],
  })
})

it('reports an architecture change as substantial', () => {
  expect(classifyRequest({ ...base, hasArchitectureChange: true })).toEqual({
    path: 'orc',
    risk: 'low',
    reasons: ['substantial'],
  })
})

it('reports unknown or multi-file scope as scope-escalation', () => {
  expect(classifyRequest({ ...base, plannedFiles: 0 }).reasons).toEqual(['scope-escalation'])
  expect(classifyRequest({ ...base, plannedFiles: 3 }).reasons).toEqual(['scope-escalation'])
})

it('keeps one-file low-risk work direct', () => {
  expect(classifyRequest(base)).toEqual({ path: 'direct', risk: 'low', reasons: ['isolated-low-risk'] })
})

it('escalates an initially direct task that discovers risk before implementation', () => {
  const decision = classifyRequest({ ...base, discoveredRisk: true })
  expect(decision.path).toBe('orc')
  expect(decision.risk).toBe('high')
  expect(decision.reasons).toContain('high-impact')
})
