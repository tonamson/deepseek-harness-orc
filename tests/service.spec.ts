/**
 * ORC service tests.
 *
 * They drive the real service over the fake DSH ports: a real Session, the real
 * reducer, the real settings revision hashing, and fakes that reproduce the
 * published provider/CLI/subagent gates. What is asserted is the service's own
 * contract — authority, durable ordering, correlation reuse, the green-test
 * gate, and blocking failures — not the fakes' behaviour.
 */

import { describe, expect, it } from 'vitest'
import { routeKey } from '../src/domain/config.js'
import { parseConfig } from '../src/domain/config.js'
import { RouteError } from '../src/domain/routing.js'
import type { RouteDecision } from '../src/domain/routing.js'
import type { OrcStartRecord } from '../src/host/journal.js'
import { OrcService } from '../src/host/service.js'
import { ORC_LEAD_LABEL, REPORT_CONTRACT, reportPrompt } from '../src/host/service.js'
import {
  FAKE_NOW,
  fakePorts,
  HIGH_RISK,
  rawAnswer,
  SUPERVISOR_ID,
  type FakePorts,
} from './fixtures/ports.js'
import { claudeRoute, codexRoute, config as fixtureConfig, planRoute, routeBackend } from './fixtures/routes.js'

/** The clean review/audit report the workflow completes with. */
const cleanReport = { status: 'clean', findings: [] }

/** The medium finding the brief's acceptance sequence raises. */
const mediumReport = {
  status: 'findings',
  findings: [{
    id: 'F-1',
    severity: 'medium',
    file: 'src/pay.ts',
    line: 12,
    evidence: 'double credit',
    remediation: 'settle once',
  }],
}

const signal = new AbortController().signal

/** The committed route decisions of one fixture run, in commit order. */
const routeDecisions = (ports: FakePorts): RouteDecision[] =>
  ports.journal.events
    .filter(event => event.type === 'orc/route')
    .map(event => (event.data as Extract<typeof event.data, { type: 'orc/route' }>).decision)

/** Run the run up to the implement phase, where a lead and peers may be created. */
async function toImplement(ports: FakePorts, svc: OrcService): Promise<void> {
  await svc.start(ports.supervisor, HIGH_RISK)
  await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
  await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
}

/** Run one full task cycle: lead, peer, task, settlement. */
async function toReview(
  ports: FakePorts,
  svc: OrcService,
): Promise<{ lead: Awaited<ReturnType<OrcService['createLead']>>; peer: Awaited<ReturnType<OrcService['createPeer']>> }> {
  await toImplement(ports, svc)
  const lead = await svc.createLead(ports.supervisor)
  const peer = await svc.createPeer(lead, 'peer-1')
  await svc.startTask(lead, peer, 'task-1')
  await svc.settleTask(peer, 'task-1')
  return { lead, peer }
}

/**
 * A manual policy whose review route carries no benchmark evidence.
 *
 * Only the high-risk rule refuses that route, so a run's *effective*
 * classification is observable in whether the unmeasured route may run.
 */
const unmeasuredReview = () => parseConfig({
  analysisMode: 'manual',
  allowed: [planRoute, codexRoute, claudeRoute],
  manual: { spec: planRoute, plan: planRoute, review: planRoute, audit: claudeRoute },
})

/** The committed journal event names, in order. */
const eventNames = (ports: FakePorts): string[] => ports.journal.events.map(event => event.type)

/**
 * Rewrite one run's durable log into the shape an older build wrote: the start
 * record carries no `risk` field, so the run's classification survives only in
 * its committed route decisions.
 *
 * The fixture's event array is the durable log a recovery journal folds, so the
 * rewrite is exactly what a restarted service reads.
 */
function stripStartRisk(ports: FakePorts): void {
  const index = ports.journal.events.findIndex(event => event.type === 'orc/start')
  if (index < 0) throw new Error('the durable log carries no start record')
  const legacy: OrcStartRecord = { ...(ports.journal.events[index]!.data as OrcStartRecord) }
  delete legacy.risk
  ports.journal.events[index] = { type: 'orc/start', data: legacy }
}

describe('ORC run authority', () => {
  it('starts a run, creates exactly one lead, and refuses a supervisor-owned peer', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const supervisor = ports.supervisor

    await toImplement(ports, svc)
    await expect(svc.createPeer(supervisor, 'peer-1')).rejects.toThrow(/authority/)
    const lead = await svc.createLead(supervisor)
    await expect(svc.createPeer(lead, 'peer-1')).resolves.toMatchObject({ role: 'peer' })
    expect(ports.journal.events[0]!.type).toBe('orc/start')

    // A second create returns the same lead instead of provisioning another.
    await expect(svc.createLead(supervisor)).resolves.toMatchObject({ role: 'lead' })
    expect(ports.subagents.starts.filter(start => start.label === ORC_LEAD_LABEL)).toHaveLength(1)
  })

  it('refuses a peer that tries to create a child, dispatch, or complete', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { peer } = await toReview(ports, svc)

    await expect(svc.createPeer(peer, 'peer-2')).rejects.toThrow(/authority/)
    await expect(svc.createLead(peer)).rejects.toThrow(/authority/)
    await expect(svc.dispatch(peer, 'review', 'review task-1', signal)).rejects.toThrow(/authority/)
    await expect(svc.complete(peer)).rejects.toThrow(/authority/)
  })

  it('refuses an agent that is part of no run', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const stranger = fakePorts().supervisor
    await expect(svc.complete(stranger)).rejects.toThrow(/authority/)
  })

  it('refuses a direct classification instead of opening a run', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await expect(svc.start(ports.supervisor, { path: 'direct', risk: 'low', reasons: ['isolated-low-risk'] }))
      .rejects.toThrow(/direct/)
    expect(ports.journal.events).toHaveLength(0)
  })

  it('keeps the original classification when start is replayed', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    const before = eventNames(ports)
    await svc.start(ports.supervisor, { path: 'orc', risk: 'low', reasons: ['explicit-review'] })
    expect(eventNames(ports)).toEqual(before)
  })
})

describe('durable ordering', () => {
  it('commits the request before the delegated run and the result before the phase advances', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)

    const observed: { events: string[]; phase: string }[] = []
    const originalRun = ports.providers.run
    ports.providers.run = async (...args) => {
      observed.push({ events: eventNames(ports), phase: svc.state(ports.supervisor).phase })
      return await originalRun(...args)
    }

    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    expect(observed[0]!.events).toContain('orc/spec-request')
    expect(observed[0]!.events).not.toContain('orc/spec-result')
    expect(observed[0]!.phase).toBe('spec')
    expect(svc.state(ports.supervisor).phase).toBe('plan')
  })

  it('awaits the durability checkpoint before a commit resolves', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    expect(ports.journal.flushCount.value).toBe(1)
    expect(ports.journal.sessions).toEqual(['session-supervisor'])
  })

  it('resumes a committed request after a replay instead of duplicating it', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)

    // An interrupted run: the request is committed, the result is not, and the
    // failure is cancellation rather than a dispatch fault.
    const controller = new AbortController()
    controller.abort()
    ports.providers.failNextRun(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    await expect(svc.dispatch(ports.supervisor, 'spec', 'spec input', controller.signal)).rejects.toThrow(/interrupted/)
    expect(eventNames(ports)).toContain('orc/spec-request')
    expect(eventNames(ports)).not.toContain('orc/fail')

    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await recovered.dispatch(ports.supervisor, 'spec', 'spec input', signal)

    const requests = ports.journal.events.filter(event => event.type === 'orc/spec-request')
    expect(requests).toHaveLength(1)
    const results = ports.journal.events.filter(event => event.type === 'orc/spec-result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data).toMatchObject({ correlationId: requests[0]!.data.type === 'spec-request' ? requests[0]!.data.correlationId : '' })
    expect(recovered.state(ports.supervisor).phase).toBe('plan')
  })

  it('replays a start-only log and dispatches without a route decision to fall back on', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    // The log holds nothing but the start record: no route decision exists, so
    // the activation risk is only recoverable from the start record itself.
    expect(eventNames(ports)).toEqual(['orc/start'])

    // A restarted process: a fresh service over the same durable log.
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await expect(recovered.dispatch(ports.supervisor, 'spec', 'spec input', signal))
      .resolves.toMatchObject({ phase: 'plan' })

    expect(eventNames(ports)).toEqual(['orc/start', 'orc/route', 'orc/spec-request', 'orc/spec-result'])
    expect(recovered.state(ports.supervisor).phase).toBe('plan')
  })

  it('heals a start-only log that carries no durable classification', async () => {
    const ports = fakePorts()
    // A log written before the classification became durable: a plain start.
    await ports.journal.commit(ports.supervisor.session, {
      version: 1,
      type: 'start',
      runId: SUPERVISOR_ID,
      actorId: SUPERVISOR_ID,
      actor: 'supervisor',
      at: FAKE_NOW,
    })
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await expect(recovered.dispatch(ports.supervisor, 'spec', 'spec input', signal))
      .rejects.toThrow(/no risk classification/)

    // The replayed activation gate is the only surviving classification, so it
    // heals the run instead of leaving it permanently unroutable.
    await recovered.start(ports.supervisor, HIGH_RISK)
    await expect(recovered.dispatch(ports.supervisor, 'spec', 'spec input', signal))
      .resolves.toMatchObject({ phase: 'plan' })
    expect(eventNames(ports)).toEqual(['orc/start', 'orc/route', 'orc/spec-request', 'orc/spec-result'])
  })

  it('cannot downgrade a resumed run whose log records a high classification', async () => {
    const ports = fakePorts({ config: unmeasuredReview() })
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    expect(ports.journal.events[0]!.data).toMatchObject({ type: 'start', risk: { path: 'orc', risk: 'high' } })

    // A restarted process over the same durable log, then a replay of the
    // model-facing gate carrying a low-risk classification for the run.
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await recovered.start(ports.supervisor, { path: 'orc', risk: 'low', reasons: ['explicit-review'] })

    // The recorded high classification still governs: the unmeasured review
    // route is refused and is never dispatched, even though a clean report is
    // waiting for it.
    const runsBefore = ports.providers.runs.length
    ports.reports.push(cleanReport)
    await expect(recovered.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .rejects.toThrow(/no-qualifying-route/)
    expect(ports.providers.runs).toHaveLength(runsBefore)
    const reviewDecisions = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => event.data.decision)
      .filter(decision => decision.stage === 'review')
    expect(reviewDecisions).toHaveLength(0)
    // The refusal is a routing outcome, not a run failure (I8): the stage is
    // blocked, the run's phase is untouched, and nothing is logged as failed.
    expect(ports.journal.events.filter(event => event.type === 'orc/fail')).toHaveLength(0)
    expect(recovered.state(ports.supervisor).phase).toBe('implement')
  })

  it('cannot raise a resumed run whose log records a low classification', async () => {
    const ports = fakePorts({ config: unmeasuredReview() })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, { path: 'orc', risk: 'low', reasons: ['explicit-review'] })
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    const lead = await svc.createLead(ports.supervisor)
    const peer = await svc.createPeer(lead, 'peer-1')
    await svc.startTask(lead, peer, 'task-1')
    await svc.settleTask(peer, 'task-1')

    // A restarted process over the same durable log, then a replay that claims
    // the run is high-risk. The recorded low classification still governs: the
    // unmeasured review route is still admitted.
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await recovered.start(ports.supervisor, HIGH_RISK)

    ports.reports.push(cleanReport)
    await expect(recovered.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .resolves.toMatchObject({ phase: 'audit' })
    const review = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => event.data.decision)
      .find(decision => decision.stage === 'review')!
    expect(review.risk).toMatchObject({ path: 'orc', risk: 'low' })
  })

  it('cannot downgrade a legacy run classified only by its committed route decision', async () => {
    const ports = fakePorts({ config: unmeasuredReview() })
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    // The log an older build wrote: the start record carries no risk field, so
    // the run's high classification survives only in its route decisions.
    stripStartRisk(ports)
    expect(ports.journal.events[0]!.data).not.toHaveProperty('risk')

    // A restarted process over that log, then a replay of the model-facing gate
    // carrying a low-risk classification for the run.
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await recovered.start(ports.supervisor, { path: 'orc', risk: 'low', reasons: ['explicit-review'] })

    // The classification the run's route decision recorded still governs: the
    // unmeasured review route is refused and is never dispatched, even though a
    // clean report is waiting for it.
    const runsBefore = ports.providers.runs.length
    ports.reports.push(cleanReport)
    await expect(recovered.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .rejects.toThrow(/no-qualifying-route/)
    expect(ports.providers.runs).toHaveLength(runsBefore)
    const reviewDecisions = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => event.data.decision)
      .filter(decision => decision.stage === 'review')
    expect(reviewDecisions).toHaveLength(0)
    // The refusal is a routing outcome, not a run failure (I8): it blocks the
    // stage but leaves the run's phase alone.
    expect(ports.journal.events.filter(event => event.type === 'orc/fail')).toHaveLength(0)
    expect(recovered.state(ports.supervisor).phase).toBe('implement')
  })

  it('cannot raise a legacy run classified only by its committed route decision', async () => {
    const ports = fakePorts({ config: unmeasuredReview() })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, { path: 'orc', risk: 'low', reasons: ['explicit-review'] })
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    const lead = await svc.createLead(ports.supervisor)
    const peer = await svc.createPeer(lead, 'peer-1')
    await svc.startTask(lead, peer, 'task-1')
    await svc.settleTask(peer, 'task-1')
    // The log an older build wrote: the run's low classification survives only
    // in its committed route decisions.
    stripStartRisk(ports)
    expect(ports.journal.events[0]!.data).not.toHaveProperty('risk')

    // A restarted process over that log, then a replay that claims the run is
    // high-risk. The recorded low classification still governs: the unmeasured
    // review route is still admitted.
    const recovered = new OrcService({ ...ports, journal: ports.journal.recover() })
    await recovered.start(ports.supervisor, HIGH_RISK)

    ports.reports.push(cleanReport)
    await expect(recovered.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .resolves.toMatchObject({ phase: 'audit' })
    const review = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => event.data.decision)
      .find(decision => decision.stage === 'review')!
    expect(review.risk).toMatchObject({ path: 'orc', risk: 'low' })
  })

  it('records a report against an already-committed request', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { lead } = await toReview(ports, svc)

    const controller = new AbortController()
    controller.abort()
    ports.clis.failNextRun(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', controller.signal)).rejects.toThrow(/interrupted/)

    const request = ports.journal.events.find(event => event.type === 'orc/review-request')
    expect(request).toBeDefined()
    const correlationId = request!.data.type === 'review-request' ? request!.data.correlationId : ''
    await svc.recordReport(ports.supervisor, 'review', correlationId, mediumReport)
    expect(svc.state(ports.supervisor).phase).toBe('fix')
    await svc.fix(lead, 'F-1')
    expect(svc.state(ports.supervisor).findings[0]).toMatchObject({ id: 'F-1', status: 'fixed' })
  })
})

describe('route decisions', () => {
  it('logs provider/CLI, model, effort, stage, risk, evidence identity, and reason without credentials', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { lead, peer } = await toReview(ports, svc)
    ports.reports.push(mediumReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    void lead
    void peer

    const records = ports.journal.events.filter(event => event.type === 'orc/route')
    const spec = records[0]!.data.decision
    expect(spec).toMatchObject({
      stage: 'spec',
      risk: { path: 'orc', risk: 'high', reasons: ['high-impact'] },
      catalogId: 'orc@2026-09-23T00:00:00Z',
      benchmarkId: null,
      reason: expect.any(String),
    })
    expect(spec.route).toMatchObject({ kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' })

    const review = records.find(record => record.data.decision.stage === 'review')!.data.decision
    expect(review.route).toMatchObject({ kind: 'cli', cli: 'claude', model: 'claude-opus-4-1', effort: 'high' })
    expect(review.benchmarkId).toBe('benchmarks-2026-09-23/claude-high')
    expect(review.estimatedCostUsd).toBe(0.6)
    expect(JSON.stringify(ports.journal.events)).not.toMatch(/apiKey|api_key|token|password|credential/i)
  })

  it('keeps the audit on a different backend from the review', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.reports.push(cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)

    const decisions = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => event.data.decision)
    const review = decisions.filter(decision => decision.stage === 'review').at(-1)!
    const audit = decisions.filter(decision => decision.stage === 'audit').at(-1)!
    expect(review.route.kind).toBe('cli')
    expect(audit.route.kind).toBe('cli')
    expect(review.route.kind === 'cli' && audit.route.kind === 'cli' && audit.route.cli)
      .not.toBe(review.route.kind === 'cli' ? review.route.cli : '')
  })

  it('reports an actionable no-qualifying-route refusal without failing the run', async () => {
    const manual = parseConfig({
      analysisMode: 'manual',
      allowed: [planRoute, codexRoute, claudeRoute],
      manual: { spec: planRoute, plan: planRoute, review: planRoute, audit: claudeRoute },
    })
    const ports = fakePorts({ config: manual })
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    const before = ports.journal.events.length

    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)).rejects.toThrow(/no-qualifying-route/)

    // I8: the refusal is not terminal. Nothing is logged as a failure, the run
    // keeps its phase, and the stage can be dispatched again once the policy
    // changes — which is exactly what a user who just fixed the settings does.
    expect(ports.journal.events).toHaveLength(before)
    expect(svc.state(ports.supervisor).phase).toBe('implement')
    await expect(svc.complete(ports.supervisor)).rejects.toThrow(/blocking/)

    ports.config = parseConfig({
      analysisMode: 'manual',
      allowed: [planRoute, codexRoute, claudeRoute],
      manual: { spec: planRoute, plan: planRoute, review: codexRoute, audit: claudeRoute },
    })
    ports.reports.push(cleanReport)
    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)).resolves.toMatchObject({ phase: 'audit' })
    expect(ports.journal.events.at(-1)!.type).toBe('orc/review-result')
  })

  it('routes the code stage through the configured provider without a lifecycle transition', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'code', 'implement the fix', signal)

    expect(eventNames(ports)).toEqual(['orc/start', 'orc/route'])
    expect(svc.state(ports.supervisor).phase).toBe('spec')
    expect(ports.providers.runs).toHaveLength(1)
    expect(ports.providers.runs[0]!.route).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      effort: 'high',
    })
  })
})

describe('connection gate', () => {
  it('refuses to dispatch a provider route whose verification is not green', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    ports.providers.failNextTest('authentication')

    await expect(svc.dispatch(ports.supervisor, 'code', 'implement the fix', signal)).rejects.toThrow(/blocking/)
    expect(ports.providers.runs).toHaveLength(0)
    expect(svc.getConnectionResult(routeKey({ kind: 'provider', provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'high' })))
      .toMatchObject({ ok: false, code: 'authentication' })
    expect(eventNames(ports)).toContain('orc/fail')
  })

  it('re-verifies after the connection revision moves instead of reusing a stale green result', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    const route = { kind: 'provider', provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'high' } as const
    await expect(svc.probe(route, signal)).resolves.toMatchObject({ ok: true })
    expect(ports.providers.tests).toHaveLength(1)

    ports.settings.set({ ...ports.config, maxCostUsd: 1 })
    ports.providers.failNextTest('quota')
    await expect(svc.dispatch(ports.supervisor, 'code', 'implement the fix', signal)).rejects.toThrow(/blocking/)
    expect(ports.providers.tests).toHaveLength(2)
  })

  it('reuses a green result while the revision holds', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'code', 'implement the fix', signal)
    await svc.dispatch(ports.supervisor, 'code', 'implement it again', signal)
    expect(ports.providers.tests).toHaveLength(1)
    expect(ports.providers.runs).toHaveLength(2)
  })
})

describe('host CLI path reconciliation', () => {
  it('probes the configured executable so a configured CLI dispatch is not stale', async () => {
    const config = parseConfig({
      analysisMode: 'manual',
      allowed: [claudeRoute],
      manual: { spec: claudeRoute, plan: claudeRoute, review: claudeRoute, audit: claudeRoute },
      cliPaths: { claude: '/opt/claude/bin/claude' },
    })
    const ports = fakePorts({ config })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)

    expect(ports.clis.probes.at(-1)).toMatchObject({ path: '/opt/claude/bin/claude' })
    expect(ports.clis.runs.at(-1)).toMatchObject({ path: '/opt/claude/bin/claude' })
  })

  it('uses PATH discovery when no executable path is configured', async () => {
    const config = parseConfig({
      analysisMode: 'manual',
      allowed: [claudeRoute],
      manual: { spec: claudeRoute, plan: claudeRoute, review: claudeRoute, audit: claudeRoute },
    })
    const ports = fakePorts({ config })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)

    expect(ports.clis.probes.at(-1)).toMatchObject({ path: undefined })
    expect(ports.clis.runs.at(-1)).toMatchObject({ path: undefined })
  })

  it('re-probes when an explicit path is configured after a PATH probe', async () => {
    const config = parseConfig({
      analysisMode: 'manual',
      allowed: [claudeRoute],
      manual: { spec: claudeRoute, plan: claudeRoute, review: claudeRoute, audit: claudeRoute },
    })
    const ports = fakePorts({ config })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.getCatalog(signal)
    expect(ports.clis.probes.at(-1)).toMatchObject({ path: undefined })

    ports.settings.set({ ...ports.config, cliPaths: { claude: '/opt/claude/bin/claude' } })
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)

    expect(ports.clis.probes.at(-1)).toMatchObject({ path: '/opt/claude/bin/claude' })
    expect(ports.clis.runs.at(-1)).toMatchObject({ path: '/opt/claude/bin/claude' })
  })
})

describe('blocking failures and gates', () => {
  it('blocks a malformed review report instead of normalizing it', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.reports.push({ status: 'clean', findings: [mediumReport.findings[0]] })

    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)).rejects.toThrow(/blocking/)
    expect(eventNames(ports)).not.toContain('orc/review-result')
    // The refusal is durable and visible, but it is not a run failure: the
    // contradictory report is neither normalized to clean nor recorded, the run
    // keeps the phase and the pending request, and completion still refuses.
    expect(ports.journal.events.at(-1)!.type).toBe('orc/report-rejected')
    expect(svc.state(ports.supervisor).phase).toBe('review')
    expect(svc.state(ports.supervisor).findings).toEqual([])
    await expect(svc.complete(ports.supervisor)).rejects.toThrow(/blocking/)
  })

  it('blocks a review whose backend fails', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.clis.failNextRun(new Error('transport failure'))

    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)).rejects.toThrow(/transport failure/)
    const failure = ports.journal.events.at(-1)!
    expect(failure.type).toBe('orc/fail')
    expect(failure.data).toMatchObject({ type: 'fail', reason: expect.stringMatching(/^review dispatch failed/) })
    expect(JSON.stringify(failure)).not.toContain('transport failure')
  })

  it('blocks an unavailable audit report', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.reports.push(cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)

    await expect(svc.recordReport(ports.supervisor, 'audit', 'audit:1:none', undefined)).rejects.toThrow(/blocking/)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/fail')
  })

  it('refuses the final gates for a run with no tasks', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toImplement(ports, svc)
    expect(svc.state(ports.supervisor).phase).toBe('implement')

    await expect(svc.finalBranchReview(ports.supervisor, 'final review', signal)).rejects.toThrow(/blocking/)
    expect(eventNames(ports)).not.toContain('orc/final-review-request')
    // The two spec/plan dispatches routed; the refused gate added no third.
    expect(eventNames(ports).filter(name => name === 'orc/route')).toHaveLength(2)
  })

  it('does not let a task advance before both gates are clean', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { lead, peer } = await toReview(ports, svc)
    ports.reports.push(mediumReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    expect(svc.state(ports.supervisor).phase).toBe('fix')

    await expect(svc.startTask(lead, peer, 'task-2')).rejects.toThrow(/phase/)
    await expect(svc.finalBranchReview(ports.supervisor, 'final review', signal)).rejects.toThrow(/phase/)
    // The refused gate logged no route decision: spec and plan routed, and the
    // task review that opened the fix phase did too.
    expect(ports.journal.events.filter(event => event.type === 'orc/route')).toHaveLength(3)

    await svc.fix(lead, 'F-1')
    await expect(svc.finalBranchReview(ports.supervisor, 'final review', signal)).rejects.toThrow(/phase/)

    ports.reports.push(cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1 again', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)
    expect(svc.state(ports.supervisor).taskGate).toBe('passed')

    // New implementation work reopens the gate: the final review refuses until
    // that work earned its own clean review and audit cycle.
    await svc.startTask(lead, peer, 'task-2')
    await svc.settleTask(peer, 'task-2')
    await expect(svc.finalBranchReview(ports.supervisor, 'final review', signal)).rejects.toThrow(/task-level/)

    ports.reports.push(cleanReport, cleanReport, cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-2', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-2', signal)
    await svc.finalBranchReview(ports.supervisor, 'final branch review', signal)
    await svc.finalBranchAudit(ports.supervisor, 'final branch audit', signal)
    await expect(svc.complete(ports.supervisor)).resolves.toMatchObject({ phase: 'completed' })

    // Both final gates were routed through the selector and dispatched: the
    // route decisions are durable, and the final audit ran on a different
    // backend from the final review.
    const decisions = routeDecisions(ports)
    const finalReview = decisions.at(-2)!
    const finalAudit = decisions.at(-1)!
    expect(finalReview).toMatchObject({ stage: 'review', risk: { risk: 'high' } })
    expect(finalAudit).toMatchObject({ stage: 'audit', risk: { risk: 'high' } })
    expect(routeBackend(finalAudit.route)).not.toBe(routeBackend(finalReview.route))
    expect(ports.clis.runs.filter(run => run.prompt === reportPrompt('final branch review'))).toHaveLength(1)
    expect(ports.clis.runs.filter(run => run.prompt === reportPrompt('final branch audit'))).toHaveLength(1)
  })

  it('records only the report the final gate dispatch produced', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { lead, peer } = await toReview(ports, svc)
    ports.reports.push(cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)
    expect(svc.state(ports.supervisor).taskGate).toBe('passed')

    // The backend's own report is what lands: the tool has no report field, so
    // a model cannot supply one for a final gate.
    ports.reports.push(mediumReport)
    const state = await svc.finalBranchReview(ports.supervisor, 'final branch review', signal)
    expect(state.finalReview).toBe('blocked')
    expect(state.findings).toMatchObject([{ id: 'F-1', severity: 'medium', status: 'open' }])

    // A blocking final review is re-reviewable: the fix cycle the reducer
    // requires is a task-level review and audit, and the final gates then reopen.
    await svc.fix(lead, 'F-1')
    ports.reports.push(cleanReport, cleanReport, cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1 after fix', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1 after fix', signal)
    await svc.finalBranchReview(ports.supervisor, 'final branch review again', signal)
    await svc.finalBranchAudit(ports.supervisor, 'final branch audit', signal)
    await expect(svc.complete(ports.supervisor)).resolves.toMatchObject({ phase: 'completed' })
  })

  it('blocks a malformed final gate answer instead of normalizing it, and re-runs that gate', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { peer } = await toReview(ports, svc)
    ports.reports.push(cleanReport, cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)
    await svc.finalBranchReview(ports.supervisor, 'final branch review', signal)

    // The audit's route answered with something that is not a report.
    ports.reports.push('not a report')
    await expect(svc.finalBranchAudit(ports.supervisor, 'final branch audit', signal)).rejects.toThrow(/blocking/)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/report-rejected')
    expect(svc.state(ports.supervisor).phase).toBe('final-audit')
    expect(svc.state(ports.supervisor).finalAudit).toBe('none')
    await expect(svc.complete(ports.supervisor)).rejects.toThrow(/blocking/)

    // The refused gate is re-runnable: the retry resumes the pending request
    // instead of opening a second round, and the clean answer completes it.
    ports.reports.push(cleanReport)
    await expect(svc.finalBranchAudit(ports.supervisor, 'final branch audit', signal))
      .resolves.toMatchObject({ finalAudit: 'clean' })
    expect(eventNames(ports).filter(name => name === 'orc/final-audit-request')).toHaveLength(1)
    expect(eventNames(ports).filter(name => name === 'orc/final-audit-result')).toHaveLength(1)
    await expect(svc.complete(ports.supervisor)).resolves.toMatchObject({ phase: 'completed' })
    expect(peer.id).toBeDefined()
  })

  it('blocks the run when child startup fails', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toImplement(ports, svc)
    ports.subagents.failNextStart(new Error('spawn unavailable'))

    await expect(svc.createLead(ports.supervisor)).rejects.toThrow(/spawn unavailable/)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/fail')
  })

  it('refuses child creation when the provider cannot create continuable children', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toImplement(ports, svc)
    ports.subagents.setCapable(false)

    await expect(svc.createLead(ports.supervisor)).rejects.toThrow(/continuable/)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/fail')
  })

  it('refuses a result for a correlation the run never opened', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    const controller = new AbortController()
    controller.abort()
    ports.clis.failNextRun(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', controller.signal)).rejects.toThrow(/interrupted/)

    await expect(svc.recordReport(ports.supervisor, 'review', 'review:99:none', cleanReport))
      .rejects.toThrow(/no pending review request/)
    expect(eventNames(ports)).not.toContain('orc/review-result')
  })

  it('refuses a peer name that is not a safe session identity', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toImplement(ports, svc)
    const lead = await svc.createLead(ports.supervisor)
    await expect(svc.createPeer(lead, '../escape')).resolves.toMatchObject({ role: 'peer' })
    const peerId = [...ports.subagents.children.keys()].at(-1)!
    expect(peerId).toMatch(/^session-supervisor-orc-lead-orc-peer-[A-Za-z0-9._-]+$/)
    expect(peerId).not.toContain('/')
    await expect(svc.createPeer(lead, '   ')).rejects.toThrow(/needs a name/)
  })

  it('rejects a route selection refusal with its own error type', async () => {
    const ports = fakePorts({ config: parseConfig({ analysisMode: 'auto', allowed: [] }) })
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await expect(svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)).rejects.toBeInstanceOf(RouteError)
  })

  it('blocks a catalog failure instead of leaking it, and never reaches the model', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    // A raw provider discovery failure from inside the catalog read.
    ports.providers.failCatalog(new Error('raw provider transport failure'))

    const failure = await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(svc.state(ports.supervisor).phase).toBe('failed')
    const blocked = ports.journal.events.at(-1)!
    expect(blocked.type).toBe('orc/fail')
    // The durable reason is ORC-owned: no raw adapter message, no provider payload.
    expect(JSON.stringify(blocked)).not.toContain('raw provider transport failure')
    expect(JSON.stringify(blocked)).toMatch(/route selection for spec failed/)
    expect(ports.providers.tests).toEqual([])
    expect(ports.clis.runs).toEqual([])
  })

  it('serializes concurrent mutations on one run', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const { lead, peer } = await toReview(ports, svc)
    const [first, second] = await Promise.all([
      svc.startTask(lead, peer, 'task-2'),
      svc.startTask(lead, peer, 'task-3'),
    ])
    expect(first.tasks.map(task => task.id)).toEqual(['task-1', 'task-2'])
    expect(second.tasks.map(task => task.id)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(ports.journal.events.filter(event => event.type === 'orc/task-start')).toHaveLength(3)
  })
})

describe('report contract and malformed-report recovery', () => {
  it('states the report contract to a dispatched review and audit', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.reports.push(cleanReport, cleanReport)
    await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
    await svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)

    const review = ports.clis.runs.find(run => run.prompt.startsWith('review task-1'))!
    const audit = ports.clis.runs.find(run => run.prompt.startsWith('audit task-1'))!
    // The caller's prompt is still the work; ORC appends the contract it parses.
    expect(review.prompt).toBe(reportPrompt('review task-1'))
    expect(audit.prompt).toBe(reportPrompt('audit task-1'))

    // The contract names the exact shape, statuses, finding fields, severities,
    // and blocking rule the parser enforces — not a vague instruction.
    for (const required of [
      '{"status":"clean","findings":[]}',
      'exactly one JSON object and nothing else',
      '"status" is exactly "clean" or "findings"',
      '"findings" is an array of finding objects',
      'exactly these six fields',
      '"id": a unique, non-empty string within this report',
      '"severity": exactly one of "critical", "high", "medium", "low", "info"',
      '"file": the non-empty path',
      '"line": the non-negative integer line number',
      '"evidence": non-empty text describing what is wrong',
      '"remediation": non-empty text describing what must change',
      '"critical", "high", and "medium" findings block the run until they are fixed and re-reviewed',
      'no code fences',
    ]) {
      expect(REPORT_CONTRACT).toContain(required)
      expect(review.prompt).toContain(required)
      expect(audit.prompt).toContain(required)
    }
  })

  it('does not state the report contract to spec, plan, or code', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    await svc.dispatch(ports.supervisor, 'code', 'code input', signal)

    // Those three answers are not parsed as reports, so the backend receives
    // the caller's prompt byte-for-byte.
    expect(ports.providers.runs.map(run => run.prompt)).toEqual(['spec input', 'plan input', 'code input'])
    expect(ports.clis.runs).toEqual([])
    for (const run of ports.providers.runs) expect(run.prompt).not.toContain(REPORT_CONTRACT)
  })

  it('turns a prose answer into an ORC-owned blocking error with a bounded excerpt', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    const tail = 'TAIL-MARKER-THAT-MUST-NOT-SURVIVE'
    ports.reports.push(rawAnswer(`No payment issue found in src/pay.ts:12. ${'detail '.repeat(80)}${tail}`))

    const failure = await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
      .then(() => undefined, (error: unknown) => error)

    // ORC owns the refusal: not a raw SyntaxError quoting the model's answer.
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(SyntaxError)
    expect((failure as Error).name).toBe('ReportError')
    expect((failure as Error).message).toMatch(/^blocking: the answer is not the report JSON: /)
    // The excerpt is bounded and redacted: the beginning survives, the path is
    // replaced, and the tail past the bound does not.
    expect((failure as Error).message).toContain('No payment issue found')
    expect((failure as Error).message).toContain('<path>')
    expect((failure as Error).message).not.toContain(tail)
    expect((failure as Error).message.length).toBeLessThan(400)
    // The durable record is bounded the same way.
    const rejection = ports.journal.events.at(-1)!
    expect(rejection.type).toBe('orc/report-rejected')
    expect(JSON.stringify(rejection)).not.toContain(tail)
    expect(JSON.stringify(rejection).length).toBeLessThan(700)
  })

  it('blocks a schema-violating JSON report with an ORC-owned error', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    const finding = (id: string): Record<string, unknown> => ({
      id,
      severity: 'high',
      file: 'src/pay.ts',
      line: 12,
      evidence: 'double credit',
      remediation: 'settle once',
    })
    const violations: [string, unknown][] = [
      ['an unknown report field', { status: 'clean', findings: [], summary: 'all good' }],
      ['an unknown finding field', { status: 'findings', findings: [{ ...finding('F-1'), note: 'extra' }] }],
      ['an invalid severity', { status: 'findings', findings: [{ ...finding('F-1'), severity: 'blocker' }] }],
      ['empty evidence', { status: 'findings', findings: [{ ...finding('F-1'), evidence: '   ' }] }],
      ['duplicate finding ids', { status: 'findings', findings: [finding('F-1'), finding('F-1')] }],
    ]

    for (const [name, report] of violations) {
      ports.reports.push(report)
      const failure = await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
        .then(() => undefined, (error: unknown) => error)
      expect(failure, name).toBeInstanceOf(Error)
      expect((failure as Error).name, name).toBe('ReportError')
      expect((failure as Error).message, name).toMatch(/^blocking: the report is malformed: /)
      expect(ports.journal.events.at(-1)!.type, name).toBe('orc/report-rejected')
      expect(eventNames(ports), name).not.toContain('orc/review-result')
      expect(svc.state(ports.supervisor).phase, name).toBe('review')
    }

    // None of the refusals recorded a finding or advanced the gate.
    expect(svc.state(ports.supervisor).findings).toEqual([])
    expect(svc.state(ports.supervisor).taskGate).toBe('open')
  })

  it('recovers from a malformed report: the run stays blocked, and a well-formed re-dispatch advances it', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)

    // The backend answers the question it was asked, in prose.
    ports.reports.push(rawAnswer('No src/pay.ts issue found; the change looks good to me.'))
    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)).rejects.toThrow(/blocking/)

    // The refused attempt is durably visible.
    const rejection = ports.journal.events.at(-1)!
    expect(rejection.type).toBe('orc/report-rejected')
    expect(rejection.data).toMatchObject({
      type: 'orc/report-rejected',
      stage: 'review',
      correlationId: expect.stringMatching(/^review:1:/),
      reason: expect.stringMatching(/^blocking: the answer is not the report JSON/),
    })

    // The run is still blocked: nothing was recorded as a review result, the
    // phase did not advance, and the next stage stays out of reach.
    expect(eventNames(ports)).not.toContain('orc/review-result')
    expect(svc.state(ports.supervisor).phase).toBe('review')
    await expect(svc.dispatch(ports.supervisor, 'audit', 'audit task-1', signal)).rejects.toThrow(/phase/)
    await expect(svc.complete(ports.supervisor)).rejects.toThrow(/blocking/)

    // The same stage, dispatched again with a well-formed report, advances.
    ports.reports.push(cleanReport)
    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .resolves.toMatchObject({ phase: 'audit' })

    // The retry resumed the pending request instead of opening a second one,
    // while each attempt was still routed.
    expect(eventNames(ports).filter(name => name === 'orc/review-request')).toHaveLength(1)
    expect(eventNames(ports).filter(name => name === 'orc/review-result')).toHaveLength(1)
    expect(routeDecisions(ports).filter(decision => decision.stage === 'review')).toHaveLength(2)
  })
})

describe('report location', () => {
  /** A valid report a backend wraps in prose or a fence. */
  const report = {
    status: 'findings',
    findings: [{
      id: 'F-1',
      severity: 'medium',
      file: 'src/pay.ts',
      line: 12,
      evidence: 'double credit',
      remediation: 'settle once',
    }],
  }
  const json = JSON.stringify(report)

  /**
   * The wrappers a real backend has been observed to add around the contract
   * answer. The contract still asks for exact JSON; ORC has to survive a model
   * that says something first anyway.
   */
  const wrappers: [string, (body: string) => string][] = [
    ['exact JSON', body => body],
    ['a fenced json block', body => `\`\`\`json\n${body}\n\`\`\``],
    ['a plain fenced block', body => `\`\`\`\n${body}\n\`\`\``],
    ['prose before and after', body => `No staged change, file src/pay.ts not found in repo. ${body}\nThat is all.`],
    ['prose carrying an earlier unrelated brace', body => `The map {a, b} is unrelated, but here it is: ${body}`],
  ]

  it.each(wrappers)('locates a report wrapped in %s', async (_name, wrap) => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    ports.reports.push(rawAnswer(wrap(json)))

    const state = await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)

    expect(state.findings.map(finding => finding.id)).toEqual(['F-1'])
    expect(eventNames(ports)).toContain('orc/review-result')
    expect(eventNames(ports)).not.toContain('orc/report-rejected')
  })

  it.each(wrappers)('still rejects a report that fails validation in %s', async (_name, wrap) => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    // A contradictory report: "findings" with an empty list. Locating it must
    // not relax one validation rule.
    ports.reports.push(rawAnswer(wrap(JSON.stringify({ status: 'findings', findings: [] }))))

    const failure = await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)
      .then(() => undefined, (error: unknown) => error)

    expect((failure as Error).name).toBe('ReportError')
    expect((failure as Error).message).toMatch(/^blocking: the report is malformed: /)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/report-rejected')
    expect(eventNames(ports)).not.toContain('orc/review-result')
    expect(svc.state(ports.supervisor).phase).toBe('review')
  })

  it('locates a report whose own strings contain braces and escapes', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    const tricky = {
      status: 'findings',
      findings: [{
        id: 'F-1',
        severity: 'low',
        file: 'src/pay.ts',
        line: 1,
        evidence: 'the literal {"a": 1} and a stray } brace',
        remediation: 'escape { and } in the text',
      }],
    }
    // A naive greedy regex or a brace counter that ignores string literals
    // cannot locate this object.
    ports.reports.push(rawAnswer(`Findings follow.\n${JSON.stringify(tricky)}\n`))

    const state = await svc.dispatch(ports.supervisor, 'review', 'review task-1', signal)

    expect(state.findings.map(finding => finding.evidence)).toEqual(['the literal {"a": 1} and a stray } brace'])
  })

  it('does not hunt for a later object once the first one is located', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    // The first balanced object is not a valid report; the clean one after it
    // must not be accepted in its place.
    ports.reports.push(rawAnswer(`${JSON.stringify({ status: 'findings', findings: [] })} ${JSON.stringify(cleanReport)}`))

    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .rejects.toThrow(/^blocking: the report is malformed: /)
    expect(eventNames(ports)).not.toContain('orc/review-result')
  })

  it('rejects an answer with no locatable object, never accepting the payload', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await toReview(ports, svc)
    // An unbalanced brace is not an object; nothing may be extracted from it.
    ports.reports.push(rawAnswer('the review found {"status":"clean","findings":[]'))

    await expect(svc.dispatch(ports.supervisor, 'review', 'review task-1', signal))
      .rejects.toThrow(/^blocking: the answer is not the report JSON: /)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/report-rejected')
    expect(eventNames(ports)).not.toContain('orc/review-result')
  })
})

describe('catalog reads', () => {
  it('merges provider and CLI catalogs for every allowlisted route', async () => {
    const config = parseConfig({
      analysisMode: 'auto',
      allowed: [planRoute, codexRoute, claudeRoute],
    })
    const ports = fakePorts({ config })
    const svc = new OrcService(ports)
    const snapshot = await svc.getCatalog(signal)
    expect(snapshot.id).toBe('orc@2026-09-23T00:00:00Z')
    expect(snapshot.entries.map(entry => entry.routeKey).sort()).toEqual([
      routeKey(claudeRoute),
      routeKey(codexRoute),
      routeKey(planRoute),
    ].sort())
    expect(snapshot.entries.find(entry => entry.routeKey === routeKey(claudeRoute))).toMatchObject({
      backendVersion: '2.1.280',
      accountAccess: true,
    })
    expect(snapshot.entries.find(entry => entry.routeKey === routeKey(planRoute))).toMatchObject({
      backendVersion: '',
      accountAccess: false,
    })
  })

  it('reuses a fresh catalog instead of re-probing at every stage', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.getCatalog(signal)
    const probes = ports.clis.probes.length
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    expect(ports.clis.probes).toHaveLength(probes)
  })
})

describe('settings bridge', () => {
  it('reads config and revisions live from the bridge', async () => {
    const ports = fakePorts({ config: parseConfig({ allowed: [] }) })
    const svc = new OrcService(ports)
    expect(ports.settings.config().allowed).toEqual([])
    ports.settings.set(fixtureConfig('auto'))
    expect(ports.settings.config().allowed).toHaveLength(4)
    expect(ports.settings.connectionRevision(planRoute)).toHaveLength(64)
  })
})
