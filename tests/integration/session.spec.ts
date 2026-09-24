/**
 * Session integration tests.
 *
 * Two layers:
 *
 * - the brief's complete fake workflow, driven exactly as written;
 * - the real DSH session stack — `SessionStore`, the `session-projection`
 *   registry, and the real journal — proving that ORC's durable records reach
 *   the Supervisor's exact session, survive a durability checkpoint, and rebuild
 *   the same run state when the session is resumed from its log.
 *
 * The last test records a DSH `0.1.6-alpha.2` platform contract this bundle
 * cannot change from outside: a stored log containing an event type the harness
 * does not know, and that is not marked `ignorable`, is refused on read. ORC's
 * durable records are therefore only half of the durability story until DSH
 * publishes a way for an out-of-tree plugin to mark its own events ignorable.
 * The finding, its evidence, and its consequence are recorded in the task
 * report; this test exists so the constraint cannot silently change unnoticed.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { installOrcJournal } from '../../src/host/journal.js'
import { OrcService } from '../../src/host/service.js'
import {
  fakeAgent,
  fakeDshSessionServices,
  fakePorts,
  FAKE_NOW,
  HIGH_RISK,
  SUPERVISOR_ID,
  type FakePorts,
} from '../fixtures/ports.js'

const signal = new AbortController().signal

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
const cleanReport = { status: 'clean', findings: [] }

describe('complete fake workflow', () => {
  it('drives spec to completion through review, fix, audit, and the final gates', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    const supervisor = ports.supervisor

    await svc.start(supervisor, { path: 'orc', risk: 'high', reasons: ['high-impact'] })
    await svc.dispatch(supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(supervisor, 'plan', 'plan input', signal)
    const lead = await svc.createLead(supervisor)
    const peer = await svc.createPeer(lead, 'peer-1')
    await svc.startTask(lead, peer, 'task-1')
    await svc.settleTask(peer, 'task-1')
    ports.reports.push(mediumReport)
    await svc.dispatch(supervisor, 'review', 'review task-1', signal)
    await expect(svc.complete(supervisor)).rejects.toThrow(/blocking/)
    expect(svc.state(supervisor).findings).toMatchObject([{ id: 'F-1', severity: 'medium', status: 'open' }])
    await svc.fix(lead, 'F-1')
    ports.reports.push(cleanReport, cleanReport, cleanReport, cleanReport)
    await svc.dispatch(supervisor, 'review', 'review task-1 again', signal)
    await svc.dispatch(supervisor, 'audit', 'audit task-1', signal)
    await svc.finalBranchReview(supervisor, 'final branch review', signal)
    await svc.finalBranchAudit(supervisor, 'final branch audit', signal)
    await expect(svc.complete(supervisor)).resolves.toMatchObject({ phase: 'completed' })

    const events = ports.journal.events.map(event => event.type)
    expect(events[0]).toBe('orc/start')
    expect(events).toEqual([
      'orc/start',
      'orc/route',
      'orc/spec-request',
      'orc/spec-result',
      'orc/route',
      'orc/plan-request',
      'orc/plan-result',
      'orc/lead-create',
      'orc/peer-create',
      'orc/task-start',
      'orc/task-settle',
      'orc/route',
      'orc/review-request',
      'orc/review-result',
      'orc/fix',
      'orc/route',
      'orc/review-request',
      'orc/review-result',
      'orc/route',
      'orc/audit-request',
      'orc/audit-result',
      'orc/route',
      'orc/final-review-request',
      'orc/final-review-result',
      'orc/route',
      'orc/final-audit-request',
      'orc/final-audit-result',
      'orc/complete',
    ])
    expect(ports.journal.sessions.every(id => id === SUPERVISOR_ID)).toBe(true)

    // Every analysis stage, including both final gates, carries a durable route
    // decision: nothing is self-attested.
    const decisions = ports.journal.events
      .filter(event => event.type === 'orc/route')
      .map(event => (event.data as { decision: { stage: string } }).decision)
    expect(decisions.map(decision => decision.stage)).toEqual([
      'spec', 'plan', 'review', 'review', 'audit', 'review', 'audit',
    ])
  })
})

describe('real DSH session durability', () => {
  it('commits to the supervisor session, flushes, and projects the run state', async () => {
    const { ctx, store, projections } = fakeDshSessionServices()
    const install = installOrcJournal(ctx)
    const session = store.create(SessionId('orc-integration'))

    await install.journal.commit(session, {
      version: 1,
      type: 'start',
      runId: 'orc-integration',
      actorId: 'orc-integration',
      actor: 'supervisor',
      at: FAKE_NOW,
    })
    expect(install.journal.state(session).started).toBe(true)
    expect(projections.stateOf(session, 'orc')?.run).toMatchObject({
      runId: 'orc-integration',
      supervisorId: 'orc-integration',
      phase: 'spec',
    })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['orc/start'])

    install()
    expect(projections.stateOf(session, 'orc')).toBeUndefined()
  })

  it('rebuilds the same run state from a resumed session log', async () => {
    const first = fakeDshSessionServices()
    const firstInstall = installOrcJournal(first.ctx)
    const session = first.store.create(SessionId('orc-resume'))
    const base = { version: 1 as const, runId: 'orc-resume', actorId: 'orc-resume', actor: 'supervisor' as const, at: FAKE_NOW }
    await firstInstall.journal.commit(session, { ...base, type: 'start' })
    await firstInstall.journal.commit(session, {
      ...base,
      type: 'spec-request',
      correlationId: 'spec:1:abc',
    })
    const seed = session.snapshotEvents()

    const second = fakeDshSessionServices()
    const secondInstall = installOrcJournal(second.ctx)
    const resumed = second.store.create(SessionId('orc-resume'), { seed })
    const state = secondInstall.journal.state(resumed)
    expect(state).toMatchObject({ started: true, phase: 'spec', supervisorId: 'orc-resume' })
    expect(state.requests).toEqual([{ correlationId: 'spec:1:abc', stage: 'spec', consumed: false }])
  })

  it('commits a refused report as a durable observation that leaves the run resumable', async () => {
    const { ctx, store, projections } = fakeDshSessionServices()
    const install = installOrcJournal(ctx)
    const session = store.create(SessionId('orc-refusal'))
    const base = { version: 1 as const, runId: 'orc-refusal', actorId: 'orc-refusal', actor: 'supervisor' as const, at: FAKE_NOW }
    await install.journal.commit(session, { ...base, type: 'start' })
    await install.journal.commit(session, { ...base, type: 'spec-request', correlationId: 'spec:1:abc' })
    await install.journal.commit(session, {
      version: 1,
      type: 'orc/report-rejected',
      runId: 'orc-refusal',
      at: FAKE_NOW,
      stage: 'review',
      correlationId: 'review:1:abc',
      reason: 'blocking: the answer is not the report JSON: No <path> issue found',
    })

    // The refusal reaches the supervisor's exact session, through the real
    // journal and the real projection.
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'orc/start',
      'orc/spec-request',
      'orc/report-rejected',
    ])
    // It is an observation, not a lifecycle transition: the folded run keeps
    // its phase and its pending request, so a retry can still resume it.
    expect(projections.stateOf(session, 'orc')?.run).toMatchObject({ phase: 'spec' })
    expect(install.journal.state(session).requests).toEqual([
      { correlationId: 'spec:1:abc', stage: 'spec', consumed: false },
    ])
  })

  it('resumes a pending request through the real journal without duplicating it', async () => {
    const ports = fakePorts()
    const services = fakeDshSessionServices()
    const install = installOrcJournal(services.ctx)
    const session = services.store.create(SessionId(SUPERVISOR_ID))
    const supervisor = fakeAgent({
      id: SUPERVISOR_ID,
      role: 'supervisor',
      session,
      agents: ports.agents,
      options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    })
    ports.agents.live.set(SUPERVISOR_ID, supervisor)

    const svc = new OrcService({ ...ports, journal: install.journal })
    await svc.start(supervisor, HIGH_RISK)
    const controller = new AbortController()
    controller.abort()
    ports.providers.failNextRun(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    await expect(svc.dispatch(supervisor, 'spec', 'spec input', controller.signal)).rejects.toThrow(/interrupted/)

    // A restarted process: a fresh journal and service over the resumed log.
    const resumedServices = fakeDshSessionServices()
    const resumedInstall = installOrcJournal(resumedServices.ctx)
    const resumed = resumedServices.store.create(SessionId(SUPERVISOR_ID), { seed: session.snapshotEvents() })
    const resumedSupervisor = fakeAgent({
      id: SUPERVISOR_ID,
      role: 'supervisor',
      session: resumed,
      agents: ports.agents,
      options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    })
    ports.agents.live.set(SUPERVISOR_ID, resumedSupervisor)
    const recovered = new OrcService({ ...ports, journal: resumedInstall.journal })

    await recovered.dispatch(resumedSupervisor, 'spec', 'spec input', signal)

    const names = resumed.snapshotEvents().map(event => event.type)
    expect(names.filter(name => name === 'orc/spec-request')).toHaveLength(1)
    expect(names.filter(name => name === 'orc/spec-result')).toHaveLength(1)
    expect(recovered.state(resumedSupervisor).phase).toBe('plan')
  })

  it('dispatches a resumed session whose log holds only the start record', async () => {
    const ports = fakePorts()
    const services = fakeDshSessionServices()
    const install = installOrcJournal(services.ctx)
    const session = services.store.create(SessionId(SUPERVISOR_ID))
    const supervisor = fakeAgent({
      id: SUPERVISOR_ID,
      role: 'supervisor',
      session,
      agents: ports.agents,
      options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    })
    ports.agents.live.set(SUPERVISOR_ID, supervisor)

    const svc = new OrcService({ ...ports, journal: install.journal })
    await svc.start(supervisor, HIGH_RISK)
    // The only committed record is the start, so no route decision can carry
    // the classification the resumed service must route with.
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['orc/start'])

    // A restarted process: a fresh journal and service over the resumed log.
    const resumedServices = fakeDshSessionServices()
    const resumedInstall = installOrcJournal(resumedServices.ctx)
    const resumed = resumedServices.store.create(SessionId(SUPERVISOR_ID), { seed: session.snapshotEvents() })
    const resumedSupervisor = fakeAgent({
      id: SUPERVISOR_ID,
      role: 'supervisor',
      session: resumed,
      agents: ports.agents,
      options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    })
    ports.agents.live.set(SUPERVISOR_ID, resumedSupervisor)
    const recovered = new OrcService({ ...ports, journal: resumedInstall.journal })

    await expect(recovered.dispatch(resumedSupervisor, 'spec', 'spec input', signal))
      .resolves.toMatchObject({ phase: 'plan' })
    expect(resumed.snapshotEvents().map(event => event.type).filter(type => type.startsWith('orc/'))).toEqual([
      'orc/start',
      'orc/route',
      'orc/spec-request',
      'orc/spec-result',
    ])
  })

  it('records the DSH 0.1.6 persistence contract for unknown plugin event types', () => {
    const session = Session.create(SessionId('orc-durability-probe'))
    session.append('orc/start', {
      version: 1,
      type: 'start',
      runId: 'orc-durability-probe',
      actorId: 'orc-durability-probe',
      actor: 'supervisor',
      at: FAKE_NOW,
    })
    const events = session.snapshotEvents().map(event => structuredClone(event))
    expect(() => validateStoredEvents(
      {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('orc-durability-probe'),
        createdAt: 0,
        isSeeded: false,
      },
      events,
      undefined,
    )).toThrow(/unknown to this harness and not marked ignorable/)
  })
})

describe('plugin unload', () => {
  it('cancels in-flight child startup when the service is disposed', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    await svc.dispose()
    await expect(svc.createLead(ports.supervisor)).rejects.toThrow(/ORC was disabled/)
    expect(ports.journal.events.at(-1)!.type).toBe('orc/fail')
    expect(ports.subagents.starts.at(-1)!.childId).toBe(`${SUPERVISOR_ID}-orc-lead`)
  })

  it('settles an in-flight child startup before dispose resolves', async () => {
    const ports = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    const lead = await svc.createLead(ports.supervisor)
    // A startup the abort will cancel: dispose must not resolve before its
    // settlement has been committed, because the Host disposes the durable
    // projection in the same unload batch.
    const pending = svc.createPeer(lead, 'peer-1').catch((error: unknown) => error)
    await svc.dispose()
    expect(ports.journal.events.at(-1)!.type).toBe('orc/fail')
    expect((await pending)).toBeInstanceOf(Error)
  })
})

describe('fake ports hygiene', () => {
  it('builds a real Context without leaking services between tests', () => {
    const first = fakeDshSessionServices()
    const second = fakeDshSessionServices()
    expect(first.ctx === second.ctx).toBe(false)
    expect(typeof first.ctx.get('sessions')?.flush).toBe('function')
    expect(typeof second.ctx.get('sessionProjections')?.register).toBe('function')
    expect(new Context().get('sessions') === undefined).toBe(true)
  })

  it('hands the provider the exact agent options the supervisor selected', async () => {
    const ports: FakePorts = fakePorts()
    const svc = new OrcService(ports)
    await svc.start(ports.supervisor, HIGH_RISK)
    await svc.dispatch(ports.supervisor, 'spec', 'spec input', signal)
    await svc.dispatch(ports.supervisor, 'plan', 'plan input', signal)
    await svc.createLead(ports.supervisor)
    expect(ports.subagents.starts[0]!.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
    })
  })
})
