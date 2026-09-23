/**
 * ORC tool, policy, and pre-step gate tests.
 *
 * The fixture Agent carries the real registration surface (`tools.register`,
 * `systemPrompt.section`, `ctx.on`), so what is asserted here is the exact
 * Agent-scoped contribution ORC makes: one tool, one policy section, one gate,
 * all removed by the returned disposer, and none of them touching the Agent's
 * selected provider or model.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ORC_LEAD_LABEL, OrcService } from '../src/host/service.js'
import { installOrcTool, ORC_POLICY, ORC_SECTION_NAME } from '../src/host/tool.js'
import { fakePorts, HIGH_RISK, type FakePorts, type PreStepMessage } from './fixtures/ports.js'

const SNAPSHOT_PATH = 'tests/fixtures/session.json'

/** The high-impact request the brief's gate test admits. */
const HIGH_IMPACT_REQUEST = 'Fix payment authorization before release'

const signal = new AbortController().signal

/** A minimal execution context: the tool reads only the caller and the signal. */
const execFor = (agent: Agent): ToolRunContext =>
  ({ agent, signal }) as unknown as ToolRunContext

/** One admitted user message in the shape the pre-step payload carries. */
const userMessage = (text: string): PreStepMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** Install the tool on the fixture supervisor and return its definition. */
function install(ports: FakePorts, service: OrcService): {
  dispose: () => void
  agent: Agent
  tool: NonNullable<ReturnType<FakePorts['agents']['get']>> extends never ? never : { execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }
} {
  const agent = ports.supervisor
  const dispose = installOrcTool(agent, service)
  const tool = agent.ctx.tools.get('orc')
  if (tool === undefined) throw new Error('the orc tool was not registered')
  return { dispose, agent, tool: tool as never }
}

describe('Agent-scoped installation', () => {
  it('registers one orc tool and one policy section, and removes both on dispose', () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const agent = ports.supervisor
    const before = { provider: agent.options.provider, model: agent.options.model }

    const dispose = installOrcTool(agent, service)
    expect({ provider: agent.options.provider, model: agent.options.model }).toEqual(before)
    expect(agent.ctx.tools.list().map(tool => tool.name)).toContain('orc')
    expect(agent.ctx.tools.list()).toHaveLength(1)
    expect(agent.ctx.systemPrompt.list().map(section => section.name)).toEqual([ORC_SECTION_NAME])
    expect(agent.ctx.systemPrompt.list()[0]!.text).toBe(ORC_POLICY)

    dispose()
    expect(agent.ctx.tools.list().map(tool => tool.name)).not.toContain('orc')
    expect(agent.ctx.systemPrompt.list()).toHaveLength(0)
  })

  it('is idempotent when disposed twice', () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const dispose = installOrcTool(ports.supervisor, service)
    dispose()
    expect(() => {
      dispose()
    }).not.toThrow()
  })

  it('keeps the chat-selected provider and model unchanged across an ORC call', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)
    const before = { provider: agent.options.provider, model: agent.options.model }

    await service.start(agent, HIGH_RISK)
    await tool.execute({ action: 'status' }, execFor(agent))

    expect({ provider: agent.options.provider, model: agent.options.model }).toEqual(before)
    expect(before).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  })

  it('registers a parameter surface with no credential and no route field', () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    const schema = agent.ctx.tools.schemas()[0]!
    expect(schema.name).toBe('orc')
    const properties = (schema.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).sort()).toEqual([
      'action',
      'architectureChange',
      'discoveredRisk',
      'explicitPlanOrReview',
      'findingId',
      'peerId',
      'peerName',
      'plannedFiles',
      'prompt',
      'reason',
      'report',
      'request',
      'stage',
      'taskId',
    ])
    expect(Object.keys(properties)).not.toContain('provider')
    expect(Object.keys(properties)).not.toContain('model')
    expect(Object.keys(properties)).not.toContain('effort')
    expect(Object.keys(properties)).not.toContain('route')
    expect(Object.keys(properties)).not.toContain('apiKey')
    expect(Object.keys(properties)).not.toContain('token')
  })
})

describe('pre-step gate', () => {
  it('starts ORC for a high-impact admitted request before the step is entered', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    const admitted: PreStepDecision = { kind: 'enter', messages: [userMessage(HIGH_IMPACT_REQUEST)] }

    const decision = await agent.ctx.preStep(
      { agent, messages: [userMessage(HIGH_IMPACT_REQUEST)], signal },
      admitted,
    )

    expect(decision).toBe(admitted)
    expect(ports.journal.events[0]!.type).toBe('orc/start')
    expect(ports.journal.events[0]!.data).toMatchObject({ type: 'start', actorId: String(agent.id) })
    expect(ports.journal.flushCount.value).toBe(1)
    expect(service.state(agent).phase).toBe('spec')
  })

  it('leaves a small, isolated request direct and presents the policy and tool instead', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    const admitted: PreStepDecision = { kind: 'enter', messages: [userMessage('Fix a typo in the README')] }

    const decision = await agent.ctx.preStep(
      { agent, messages: [userMessage('Fix a typo in the README')], signal },
      admitted,
    )

    expect(decision).toBe(admitted)
    expect(ports.journal.events).toHaveLength(0)
    expect(agent.ctx.tools.list().map(tool => tool.name)).toContain('orc')
    expect(agent.ctx.systemPrompt.list()[0]!.text).toContain('always start ORC')
  })

  it('does not start ORC for a rejected step', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    const rejected: PreStepDecision = { kind: 'reject' }

    const decision = await agent.ctx.preStep(
      { agent, messages: [userMessage(HIGH_IMPACT_REQUEST)], signal },
      rejected,
    )

    expect(decision).toBe(rejected)
    expect(ports.journal.events).toHaveLength(0)
  })

  it('does not open a nested run for a member of an existing run', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    await service.start(agent, HIGH_RISK)
    await service.dispatch(agent, 'spec', 'spec input', signal)
    await service.dispatch(agent, 'plan', 'plan input', signal)
    const lead = await service.createLead(agent)
    installOrcTool(lead, service)
    const admitted: PreStepDecision = { kind: 'enter', messages: [userMessage(HIGH_IMPACT_REQUEST)] }

    await lead.ctx.preStep({ agent: lead, messages: [userMessage(HIGH_IMPACT_REQUEST)], signal }, admitted)

    expect(ports.journal.events.filter(event => event.type === 'orc/start')).toHaveLength(1)
    expect(service.state(lead)).toMatchObject({ runId: String(agent.id), phase: 'implement' })
  })

  it('rejects the step when the durable start fails', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    ports.journal.commit = async () => {
      throw new Error('durable log unavailable')
    }

    await expect(agent.ctx.preStep(
      { agent, messages: [userMessage(HIGH_IMPACT_REQUEST)], signal },
      { kind: 'enter', messages: [userMessage(HIGH_IMPACT_REQUEST)] },
    )).rejects.toThrow(/durable log unavailable/)
    expect(ports.journal.events).toHaveLength(0)
  })
})

describe('tool actions', () => {
  it('escalates a direct task that discovers scope before implementation continues', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)

    const direct = await tool.execute(
      { action: 'classify', request: 'Add a small helper' },
      execFor(agent),
    )
    expect(direct).toMatchObject({ path: 'direct', risk: 'low', status: 'not-started' })

    const escalated = await tool.execute(
      { action: 'classify', request: 'Add a small helper', discoveredRisk: true },
      execFor(agent),
    )
    expect(escalated).toMatchObject({ path: 'orc', risk: 'high', reasons: ['high-impact'] })

    const started = await tool.execute({ action: 'start', request: 'Add a small helper', discoveredRisk: true }, execFor(agent))
    expect(started).toMatchObject({ action: 'start', status: 'spec' })
    expect(ports.journal.events[0]!.type).toBe('orc/start')
  })

  it('refuses a peer tool call that tries to create a lead, create a peer, or complete', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)

    await service.start(agent, HIGH_RISK)
    await service.dispatch(agent, 'spec', 'spec input', signal)
    await service.dispatch(agent, 'plan', 'plan input', signal)
    const lead = await service.createLead(agent)
    const peer = await service.createPeer(lead, 'peer-1')

    await expect(tool.execute({ action: 'create-lead' }, execFor(peer))).rejects.toThrow(/authority/)
    await expect(tool.execute({ action: 'create-peer', peerName: 'peer-2' }, execFor(peer))).rejects.toThrow(/authority/)
    await expect(tool.execute({ action: 'complete' }, execFor(peer))).rejects.toThrow(/authority/)
    expect(ports.subagents.starts.filter(start => start.label === ORC_LEAD_LABEL)).toHaveLength(1)
  })

  it('drives a lead-owned transition through the run lead identity', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)

    await service.start(agent, HIGH_RISK)
    await service.dispatch(agent, 'spec', 'spec input', signal)
    await service.dispatch(agent, 'plan', 'plan input', signal)

    const lead = await tool.execute({ action: 'create-lead' }, execFor(agent))
    expect(lead).toMatchObject({ leadId: String(agent.id) + '-orc-lead' })
    const peer = await tool.execute({ action: 'create-peer', peerName: 'peer-1' }, execFor(agent))
    expect(peer).toMatchObject({ peers: [String(agent.id) + '-orc-lead-orc-peer-peer-1'] })
    await tool.execute({ action: 'start-task', taskId: 'task-1', peerId: String(agent.id) + '-orc-lead-orc-peer-peer-1' }, execFor(agent))
    const settled = await tool.execute({ action: 'settle-task', taskId: 'task-1' }, execFor(agent))
    expect(settled).toMatchObject({ tasks: ['task-1:settled'] })
  })

  it('requires the arguments each action needs', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)
    await expect(tool.execute({ action: 'dispatch', stage: 'spec' }, execFor(agent))).rejects.toThrow(/prompt/)
    await expect(tool.execute({ action: 'create-peer' }, execFor(agent))).rejects.toThrow(/peerName/)
  })

  it('refuses a tool call without a calling agent', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { tool } = install(ports, service)
    await expect(tool.execute({ action: 'status' }, { signal } as unknown as ToolRunContext))
      .rejects.toThrow(/calling agent/)
  })
})

describe('recorded session snapshot', () => {
  it('matches the committed keyless session snapshot', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent, tool } = install(ports, service)

    // A direct classification, an escalated start, one routed stage, and a
    // blocked dispatch: the model-visible decision surface of one run.
    const classified = await tool.execute({ action: 'classify', request: 'Fix a typo' }, execFor(agent))
    const started = await tool.execute(
      { action: 'start', request: HIGH_IMPACT_REQUEST, plannedFiles: 1 },
      execFor(agent),
    )
    await service.dispatch(agent, 'spec', 'spec input', signal)
    const route = ports.journal.events.find(event => event.type === 'orc/route')!.data
    ports.providers.failNextRun(new Error('transport'))

    let failure = ''
    try {
      await service.dispatch(agent, 'plan', 'plan input', signal)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toBe('transport')

    const snapshot = {
      tool: agent.ctx.tools.schemas()[0],
      policy: ORC_POLICY,
      classification: { direct: classified, escalated: started },
      routeDecision: route.decision,
      blocked: {
        message: failure,
        event: ports.journal.events.at(-1)!.data,
        phase: service.state(agent).phase,
      },
    }

    if (process.env.ORC_WRITE_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`)
    }
    expect(snapshot).toEqual(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')))
  })

  it('records a blocked review result in the snapshot failure path', async () => {
    const ports = fakePorts()
    const service = new OrcService(ports)
    const { agent } = install(ports, service)
    await service.start(agent, HIGH_RISK)
    await service.dispatch(agent, 'spec', 'spec input', signal)
    await service.dispatch(agent, 'plan', 'plan input', signal)
    const lead = await service.createLead(agent)
    const peer = await service.createPeer(lead, 'peer-1')
    await service.startTask(lead, peer, 'task-1')
    await service.settleTask(peer, 'task-1')

    ports.reports.push({ status: 'findings', findings: [] })
    let failure = ''
    try {
      await service.dispatch(agent, 'review', 'review task-1', signal)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toMatch(/blocking/)
    expect(service.state(agent).phase).toBe('failed')
    expect(ports.journal.events.at(-1)!.data).toMatchObject({
      type: 'fail',
      reason: expect.stringMatching(/^review report blocked/),
    })
  })
})
