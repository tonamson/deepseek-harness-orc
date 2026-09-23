import { readFileSync } from 'node:fs'
import { beforeEach, expect, it } from 'vitest'
import type { Finding } from '../src/domain/report.js'
import { canComplete, reduce, replay, type Actor, type OrcEvent, type OrcState } from '../src/domain/workflow.js'

const clean = { status: 'clean', findings: [] }
const mediumInput = {
  id: 'F-1',
  severity: 'medium' as const,
  file: 'src/pay.ts',
  line: 12,
  evidence: 'double credit',
  remediation: 'settle once',
}
const lowInput = { ...mediumInput, id: 'F-2', severity: 'low' as const }
const mediumFinding: Finding = { ...mediumInput, stage: 'review', status: 'open' }
const lowFinding: Finding = { ...lowInput, stage: 'review', status: 'open' }

let clock = 0
let sequence = 0
const correlations: Record<string, string> = {}
const actorIds: Record<Actor, string> = { supervisor: 'supervisor-1', lead: 'lead-1', peer: 'peer-1', service: 'service-1' }

beforeEach(() => {
  clock = 0
  sequence = 0
  for (const key of Object.keys(correlations)) delete correlations[key]
})

/** Stamp one durable event with version, run, actor, and an increasing timestamp. */
function event(type: OrcEvent['type'], actor: Actor, extra: Record<string, unknown> = {}): OrcEvent {
  const stage = type.replace(/-request$|-result$/, '')
  const defaults: Record<string, unknown> = {}
  if (type.endsWith('-request')) {
    correlations[stage] = (extra.correlationId as string | undefined) ?? `c-${++sequence}`
    defaults.correlationId = correlations[stage]
  } else if (type.endsWith('-result')) {
    defaults.correlationId = correlations[stage]
    if (stage === 'review' || stage === 'audit' || stage === 'final-review' || stage === 'final-audit')
      defaults.report = clean
  }
  if (type === 'lead-create') defaults.leadId = 'lead-1'
  if (type === 'peer-create') defaults.peerId = 'peer-1'
  if (type === 'task-start') {
    defaults.taskId = 'task-1'
    defaults.peerId = 'peer-1'
  }
  if (type === 'task-settle') defaults.taskId = 'task-1'
  if (type === 'fail') defaults.reason = 'delegated run failed'
  const at = new Date(Date.UTC(2026, 8, 23, 0, 0, clock++)).toISOString()
  return { version: 1, runId: 'run-1', actorId: actorIds[actor], actor, at, type, ...defaults, ...extra } as OrcEvent
}

const correlationOf = (e: OrcEvent): string => ('correlationId' in e ? e.correlationId : '')

const valid = [
  ['start', 'supervisor'],
  ['spec-request', 'supervisor'],
  ['spec-result', 'service'],
  ['plan-request', 'supervisor'],
  ['plan-result', 'service'],
  ['lead-create', 'supervisor'],
  ['peer-create', 'lead'],
  ['task-start', 'lead'],
  ['task-settle', 'peer'],
  ['review-request', 'lead'],
  ['review-result', 'service'],
  ['audit-request', 'lead'],
  ['audit-result', 'service'],
  ['final-review-request', 'supervisor'],
  ['final-review-result', 'service'],
  ['final-audit-request', 'supervisor'],
  ['final-audit-result', 'service'],
  ['complete', 'supervisor'],
] as const

const validEvents = (): OrcEvent[] => valid.map(([type, role]) => event(type, role))

/** The legal prefix through the task-level review request (index 9). */
const throughReviewRequest = (): OrcEvent[] => validEvents().slice(0, 10)

/** A legal review that raises the medium finding, leaving the run in `fix`. */
function mediumReview(): { events: OrcEvent[]; correlationId: string } {
  const base = throughReviewRequest()
  const correlationId = correlationOf(base[9]!)
  return {
    correlationId,
    events: [
      ...base,
      event('review-result', 'service', {
        correlationId,
        report: { status: 'findings', findings: [mediumInput] },
      }),
    ],
  }
}

it('replays the legal lifecycle to completed', () => {
  expect(replay(validEvents()).phase).toBe('completed')
})

it('rejects a supervisor creating a peer', () => {
  expect(() => replay([event('start', 'supervisor'), event('peer-create', 'supervisor')])).toThrow(/authority/)
})

it('rejects completion before the final gates', () => {
  expect(() => replay([event('start', 'supervisor'), event('complete', 'supervisor')])).toThrow(/phase/)
})

it('rejects wrong actor ancestry on every authority-bearing event', () => {
  const wrong = [
    ['lead-create', 'lead'],
    ['lead-create', 'peer'],
    ['lead-create', 'service'],
    ['peer-create', 'supervisor'],
    ['peer-create', 'peer'],
    ['peer-create', 'service'],
    ['task-start', 'supervisor'],
    ['task-start', 'service'],
    ['task-settle', 'lead'],
    ['task-settle', 'service'],
    ['review-request', 'supervisor'],
    ['review-request', 'service'],
    ['audit-request', 'supervisor'],
    ['final-review-request', 'lead'],
    ['final-audit-request', 'lead'],
    ['fix', 'supervisor'],
    ['dismiss', 'lead'],
    ['complete', 'lead'],
    ['complete', 'service'],
    ['spec-request', 'service'],
    ['plan-request', 'service'],
    ['fail', 'peer'],
  ] as const
  for (const [type, actor] of wrong)
    expect(() => replay([event('start', 'supervisor'), event(type, actor)]), `${type} by ${actor}`).toThrow(/authority/)
})

it('binds lead and peer events to the actors the run created', () => {
  const base = validEvents().slice(0, 7)
  expect(() => replay([...base, event('peer-create', 'lead', { actorId: 'lead-2' })])).toThrow(/authority/)
  const started = validEvents().slice(0, 8)
  expect(() => replay([...started, event('task-settle', 'peer', { actorId: 'peer-2' })])).toThrow(/authority/)
})

it('rejects a second lead and a second identical peer or task', () => {
  const base = validEvents().slice(0, 6)
  expect(() => replay([...base, event('lead-create', 'supervisor', { leadId: 'lead-2' })])).toThrow(/authority/)
  const withLead = validEvents().slice(0, 7)
  expect(() => replay([...withLead, event('peer-create', 'lead', { peerId: 'peer-1' })])).toThrow(/duplicate/)
  const withTask = validEvents().slice(0, 8)
  expect(() => replay([...withTask, event('task-start', 'lead', { taskId: 'task-1' })])).toThrow(/duplicate/)
})

it('rejects unknown versions, types, runs, and skipped phases', () => {
  expect(() => replay([{ ...event('start', 'supervisor'), version: 2 } as unknown as OrcEvent])).toThrow(/version/)
  expect(() => replay([{ ...event('start', 'supervisor'), type: 'rewind' } as unknown as OrcEvent])).toThrow(/unknown/)
  expect(() => replay([event('start', 'supervisor'), event('spec-request', 'supervisor', { runId: 'run-2' })])).toThrow(
    /run/,
  )
  expect(() => replay([event('start', 'supervisor'), event('plan-request', 'supervisor')])).toThrow(/phase/)
  expect(() => replay([...validEvents().slice(0, 11), event('final-review-request', 'supervisor')])).toThrow(/phase/)
  expect(() => replay([...validEvents().slice(0, 5), event('final-review-request', 'supervisor')])).toThrow(/phase/)
})

it('rejects a result without a matching request', () => {
  expect(() =>
    replay([event('start', 'supervisor'), event('spec-result', 'service', { correlationId: 'c-missing' })]),
  ).toThrow(/request/)
  const base = validEvents().slice(0, 10)
  expect(() => replay([...base, event('review-result', 'service', { correlationId: 'c-nope' })])).toThrow(/request/)
})

it('rejects duplicate correlation ids across requests', () => {
  const specRequest = event('spec-request', 'supervisor')
  expect(() =>
    replay([
      event('start', 'supervisor'),
      specRequest,
      event('spec-request', 'supervisor', { correlationId: correlationOf(specRequest) }),
    ]),
  ).toThrow(/duplicate|correlation/)
})

it('rejects an audit that reuses the review correlation id', () => {
  const base = throughReviewRequest()
  const reviewCorrelation = correlationOf(base[9]!)
  const reviewed = [...base, event('review-result', 'service', { correlationId: reviewCorrelation })]
  expect(() => replay([...reviewed, event('audit-request', 'lead', { correlationId: reviewCorrelation })])).toThrow(
    /duplicate|correlation/,
  )
  const audited = [...reviewed, event('audit-request', 'lead')]
  expect(() =>
    replay([...audited, event('audit-result', 'service', { correlationId: reviewCorrelation })]),
  ).toThrow(/request/)
})

it('rejects a finding id that was already reported in this run', () => {
  const base = throughReviewRequest()
  const reviewCorrelation = correlationOf(base[9]!)
  const reviewed = [
    ...base,
    event('review-result', 'service', {
      correlationId: reviewCorrelation,
      report: { status: 'findings', findings: [lowInput] },
    }),
  ]
  expect(replay(reviewed).phase).toBe('audit')
  const audited = [...reviewed, event('audit-request', 'lead')]
  expect(() =>
    replay([
      ...audited,
      event('audit-result', 'service', { report: { status: 'findings', findings: [lowInput] } }),
    ]),
  ).toThrow(/duplicate/)
})

it('moves to fix when a review reports a medium finding', () => {
  const { events } = mediumReview()
  const state = replay(events)
  expect(state.phase).toBe('fix')
  expect(state.findings).toEqual([mediumFinding])
})

it('requires a fix, then a new review and a new audit before the final gates', () => {
  const { events: prefix } = mediumReview()
  expect(() => replay([...prefix, event('final-review-request', 'supervisor')])).toThrow(/phase/)
  expect(() => replay([...prefix, event('review-request', 'lead')])).toThrow(/blocking/)
  const fixed = [...prefix, event('fix', 'lead', { findingId: 'F-1' })]
  const fixedState = replay(fixed)
  expect(fixedState.phase).toBe('fix')
  expect(fixedState.findings[0]!.status).toBe('fixed')
  expect(() => replay([...fixed, event('audit-request', 'lead')])).toThrow(/phase/)
  const reReviewed = [...fixed, event('review-request', 'lead'), event('review-result', 'service')]
  expect(replay(reReviewed).phase).toBe('audit')
  expect(() => replay([...reReviewed, event('complete', 'supervisor')])).toThrow(/phase/)
  const reAudited = [...reReviewed, event('audit-request', 'lead'), event('audit-result', 'service')]
  expect(replay(reAudited).phase).toBe('implement')
  expect(replay(reAudited).taskGate).toBe('passed')
  expect(replay([...reAudited, event('final-review-request', 'supervisor')]).phase).toBe('final-review')
})

it('rejects fixing an unknown or already-settled finding', () => {
  const { events } = mediumReview()
  expect(() => replay([...events, event('fix', 'lead', { findingId: 'F-9' })])).toThrow(/unknown/)
  const fixed = [...events, event('fix', 'lead', { findingId: 'F-1' })]
  expect(() => replay([...fixed, event('fix', 'lead', { findingId: 'F-1' })])).toThrow(/already/)
})

it('allows dismissing a non-blocking finding but never a blocking one', () => {
  const base = throughReviewRequest()
  const reviewCorrelation = correlationOf(base[9]!)
  const lowCycle = [
    ...base,
    event('review-result', 'service', {
      correlationId: reviewCorrelation,
      report: { status: 'findings', findings: [lowInput] },
    }),
    event('audit-request', 'lead'),
    event('audit-result', 'service'),
  ]
  const state = replay(lowCycle)
  expect(state.phase).toBe('implement')
  expect(state.findings).toEqual([lowFinding])
  const dismissed = reduce(state, event('dismiss', 'supervisor', { findingId: 'F-2', reason: 'style only' }))
  expect(dismissed.findings[0]!.status).toBe('dismissed')
  const { events: blocking } = mediumReview()
  expect(() => reduce(replay(blocking), event('dismiss', 'supervisor', { findingId: 'F-1', reason: 'accepted' }))).toThrow(
    /blocking/,
  )
})

it('requires every task to settle before the final branch review', () => {
  const base = validEvents().slice(0, 13)
  expect(replay(base).taskGate).toBe('passed')
  const secondTask = [...base, event('task-start', 'lead', { taskId: 'task-2' })]
  expect(() => replay([...secondTask, event('final-review-request', 'supervisor')])).toThrow(/settled/)
  const settled = [...secondTask, event('task-settle', 'peer', { taskId: 'task-2' })]
  expect(() => replay([...settled, event('final-review-request', 'supervisor')])).toThrow(/phase/)
  const reReviewed = [
    ...settled,
    event('review-request', 'lead'),
    event('review-result', 'service'),
    event('audit-request', 'lead'),
    event('audit-result', 'service'),
  ]
  expect(replay([...reReviewed, event('final-review-request', 'supervisor')]).phase).toBe('final-review')
})

it('blocks completion while the final audit is missing or malformed', () => {
  const prefix = validEvents().slice(0, 16)
  expect(replay(prefix).phase).toBe('final-audit')
  expect(canComplete(replay(prefix))).toBe(false)
  expect(() => replay([...prefix, event('complete', 'supervisor')])).toThrow(/blocking/)
  expect(() =>
    replay([...prefix, event('final-audit-result', 'service', { report: { status: 'failed', findings: [] } })]),
  ).toThrow(/blocking/)
  expect(() =>
    replay([...prefix, event('final-audit-result', 'service', { report: { findings: [] } })]),
  ).toThrow(/blocking/)
})

it('records a blocking final audit and refuses completion', () => {
  const prefix = validEvents().slice(0, 16)
  const audited = [
    ...prefix,
    event('final-audit-result', 'service', {
      report: { status: 'findings', findings: [mediumInput] },
    }),
  ]
  const state = replay(audited)
  expect(state.finalAudit).toBe('blocked')
  expect(state.phase).toBe('fix')
  expect(canComplete(state)).toBe(false)
  expect(() => replay([...audited, event('complete', 'supervisor')])).toThrow(/phase/)
})

it('computes completion from settled tasks, clean final gates, and no open blocking finding', () => {
  const ready = replay(validEvents().slice(0, 17))
  expect(ready.phase).toBe('final-audit')
  expect(canComplete(ready)).toBe(true)
  expect(canComplete({ ...ready, tasks: ready.tasks.map(task => ({ ...task, status: 'started' as const })) })).toBe(false)
  expect(canComplete({ ...ready, finalReview: 'none' })).toBe(false)
  expect(canComplete({ ...ready, finalReview: 'blocked' })).toBe(false)
  expect(canComplete({ ...ready, finalAudit: 'none' })).toBe(false)
  expect(canComplete({ ...ready, finalAudit: 'blocked' })).toBe(false)
  expect(canComplete({ ...ready, findings: [{ ...mediumFinding, status: 'open' as const }] })).toBe(false)
  expect(canComplete({ ...ready, findings: [{ ...mediumFinding, status: 'fixed' as const }] })).toBe(true)
  expect(canComplete({ ...ready, findings: [{ ...lowFinding, status: 'open' as const }] })).toBe(true)
})

it('refuses completion while a blocking finding is unresolved', () => {
  const ready = replay(validEvents().slice(0, 17))
  const blocked: OrcState = { ...ready, findings: [{ ...mediumFinding, status: 'open' }] }
  expect(canComplete(blocked)).toBe(false)
  expect(() => reduce(blocked, event('complete', 'supervisor'))).toThrow(/blocking/)
})

it('reaches completed only through the complete event', () => {
  const ready = replay(validEvents().slice(0, 17))
  expect(canComplete(ready)).toBe(true)
  const types: OrcEvent['type'][] = [...valid.map(([type]) => type), 'fix', 'dismiss', 'fail']
  for (const type of types) {
    if (type === 'complete') continue
    const role: Actor = type.endsWith('-result') ? 'service' : 'supervisor'
    let next: OrcState | undefined
    try {
      next = reduce(ready, event(type, role))
    } catch {
      continue
    }
    expect(next.phase, `${type} must not complete the run`).not.toBe('completed')
  }
  expect(reduce(ready, event('complete', 'supervisor')).phase).toBe('completed')
})

it('fails the run terminally', () => {
  const base = validEvents().slice(0, 6)
  const failed = replay([...base, event('fail', 'supervisor', { reason: 'aborted' })])
  expect(failed.phase).toBe('failed')
  expect(() => replay([...base, event('fail', 'supervisor', { reason: 'aborted' }), event('complete', 'supervisor')])).toThrow(
    /phase/,
  )
  expect(replay([...base, event('fail', 'service', { reason: 'dispatch failed' })]).phase).toBe('failed')
})

it('is deterministic and leaves its input state untouched', () => {
  const events = validEvents()
  expect(replay(events)).toEqual(replay(events))
  const state = replay(validEvents().slice(0, 5))
  const snapshot = structuredClone(state)
  reduce(state, event('lead-create', 'supervisor'))
  expect(state).toEqual(snapshot)
})

it('reads no clock and generates no ids inside the reducer', () => {
  const source = readFileSync(new URL('../src/domain/workflow.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID/)
})
