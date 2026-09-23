import { expect, it } from 'vitest'
import { ReportError, isBlocking, parseReport } from '../src/domain/report.js'

const finding = { id: 'F-1', severity: 'medium', file: 'src/pay.ts', line: 12, evidence: 'rounds up', remediation: 'round down' }

it('rejects contradictory, duplicate and incomplete reports', () => {
  expect(() => parseReport({ status: 'clean', findings: [finding] }, 'review')).toThrow(/contradictory/)
  expect(() => parseReport({ status: 'findings', findings: [finding, finding] }, 'review')).toThrow(/duplicate/)
  expect(() => parseReport({ status: 'findings', findings: [{ id: 'F-2' }] }, 'audit')).toThrow(/severity|evidence/)
  expect(() => parseReport({ status: 'failed', findings: [] }, 'audit')).toThrow(/blocking/)
})

it('normalizes a clean report', () => {
  expect(parseReport({ status: 'clean', findings: [] }, 'review')).toEqual({ status: 'clean', findings: [], blocking: false })
})

it('normalizes findings, stamps the source stage, and opens them', () => {
  const report = parseReport(
    { status: 'findings', findings: [finding, { ...finding, id: 'F-2', severity: 'low' }] },
    'audit',
  )
  expect(report.status).toBe('findings')
  expect(report.blocking).toBe(true)
  expect(report.findings).toEqual([
    { ...finding, stage: 'audit', status: 'open' },
    { ...finding, id: 'F-2', severity: 'low', stage: 'audit', status: 'open' },
  ])
})

it('treats only critical, high and medium findings as blocking', () => {
  expect(isBlocking('critical')).toBe(true)
  expect(isBlocking('high')).toBe(true)
  expect(isBlocking('medium')).toBe(true)
  expect(isBlocking('low')).toBe(false)
  expect(isBlocking('info')).toBe(false)
  expect(parseReport({ status: 'findings', findings: [{ ...finding, severity: 'info' }] }, 'review').blocking).toBe(false)
})

it('rejects a findings status with no findings', () => {
  expect(() => parseReport({ status: 'findings', findings: [] }, 'review')).toThrow(/contradictory/)
})

it('rejects an unrecognized status', () => {
  expect(() => parseReport({ status: 'passed', findings: [] }, 'audit')).toThrow(/unrecognized/)
  expect(() => parseReport({ status: 'passed', findings: [] }, 'audit')).toThrow(/blocking/)
})

it('rejects unavailable output', () => {
  for (const input of [undefined, null, 'clean', 42, [], new Error('provider unavailable')]) {
    expect(() => parseReport(input, 'audit')).toThrow(ReportError)
    expect(() => parseReport(input, 'audit')).toThrow(/blocking/)
  }
})

it('rejects missing, blank and malformed finding fields', () => {
  const incomplete = [
    { ...finding, id: '' },
    { ...finding, severity: 'urgent' },
    { ...finding, file: '   ' },
    { ...finding, line: 1.5 },
    { ...finding, line: -1 },
    { ...finding, evidence: '   ' },
    { ...finding, remediation: '' },
    { ...finding, remediation: 7 },
  ]
  for (const bad of incomplete) {
    expect(() => parseReport({ status: 'findings', findings: [bad] }, 'review')).toThrow(/blocking/)
  }
})

it('rejects unknown report and finding fields', () => {
  expect(() => parseReport({ status: 'clean', findings: [], summary: 'ok' }, 'review')).toThrow(/unknown field/)
  expect(() => parseReport({ status: 'findings', findings: [{ ...finding, status: 'fixed' }] }, 'review')).toThrow(
    /unknown field/,
  )
})

it('requires findings to be an array and each finding to be an object', () => {
  expect(() => parseReport({ status: 'clean' }, 'review')).toThrow(/findings/)
  expect(() => parseReport({ status: 'clean', findings: {} }, 'review')).toThrow(/findings/)
  expect(() => parseReport({ status: 'findings', findings: ['F-1'] }, 'audit')).toThrow(/blocking/)
})

it('labels every rejection as blocking', () => {
  const rejections = [
    () => parseReport(undefined, 'audit'),
    () => parseReport({ status: 'failed', findings: [] }, 'audit'),
    () => parseReport({ status: 'clean', findings: [finding] }, 'review'),
    () => parseReport({ status: 'findings', findings: [finding, finding] }, 'review'),
    () => parseReport({ status: 'findings', findings: [{ id: 'F-2' }] }, 'audit'),
    () => parseReport({ status: 'findings', findings: [] }, 'review'),
    () => parseReport({ status: 'clean', findings: {} }, 'review'),
  ]
  for (const rejection of rejections) {
    expect(rejection).toThrow(ReportError)
    expect(rejection).toThrow(/blocking/)
  }
})
