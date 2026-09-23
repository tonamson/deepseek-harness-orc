/**
 * Host composition tests.
 *
 * `apply` is the single entry point the `orc-host` Loader row mounts, and the
 * only place the host's parts are wired together: the settings bridge, the
 * durable journal and its projection, the `orc` service published as `ctx.orc`,
 * and the per-Agent tool/policy/gate installation.
 *
 * The test loads the real plugin into a real Cordis fiber — the same
 * `ctx.effect`, `ctx.provide`, `ctx.on`, and unload path the Loader uses — over
 * the real DSH session store and projection registry, with only the surrounding
 * profile services faked. What it pins is the composition contract the brief
 * names: the `orc` service is provided and disposed with the fiber, the tool and
 * policy section exist in the exact Agent scope, `agent/created` installs them,
 * and `agent/disposed` removes them.
 */

import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/host/index.js'
import { OrcService } from '../src/host/service.js'
import { ORC_SECTION_NAME } from '../src/host/tool.js'
import {
  fakeAgent,
  fakeDshSessionServices,
  HIGH_RISK,
  type FakeAgent,
} from './fixtures/ports.js'
import { config as fixtureConfig } from './fixtures/routes.js'

/** The Supervisor session id the fixture profile uses. */
const SUPERVISOR_ID = 'session-supervisor'

/** One settings-section installation the fake provider recorded. */
interface InstallCall {
  owner: unknown
  ns: string
  schema: unknown
  entry: unknown
}

/** The fake profile ORC is composed into, plus the readers the assertions use. */
interface Composition {
  ctx: CordisContext
  supervisor: FakeAgent
  /** Register one more live top-level agent, as DSH's registry would. */
  createAgent(id: string): FakeAgent
  /** Register one live child of an existing agent, as `ctx.subagents` does. */
  createChild(id: string, parent: FakeAgent): FakeAgent
  /** Every settings section the fake provider was asked to install. */
  installs: InstallCall[]
}

/**
 * Provide one profile service by name.
 *
 * The name is typed as a plain string so the loose `provide(name, value)`
 * overload is selected: these fakes stand in for DSH services whose declared
 * types are richer than the slice ORC reads.
 */
function provide(ctx: CordisContext, service: string, value: unknown): void {
  ctx.provide(service, value)
}

/**
 * Build the profile ORC is loaded into.
 *
 * `sessions` and `sessionProjections` are the real DSH services, so the
 * journal's reads and durability checkpoint are exercised for real; `settings`,
 * `llm`, and `subprocess` are the minimal fakes `apply` reads, and `tools` /
 * `systemPrompt` are inert placeholders that exist only because the row injects
 * them (the tool and policy are registered through `agent.ctx`, never here).
 */
function composition(): Composition {
  const { ctx } = fakeDshSessionServices()
  const live = new Map<string, FakeAgent>()
  // `roots()` is DSH's runtime authority on which agents are top-level; the
  // fake models it from durable session lineage, which is what a continuable
  // child created through `ctx.subagents` carries.
  const agents = {
    list: () => [...live.values()],
    roots: () => [...live.values()].filter(agent => agent.session.header.parentSession === undefined),
    get: (id: SessionId) => live.get(String(id)),
  }
  const installs: InstallCall[] = []
  const session = ctx.get('sessions')!.create(SessionId(SUPERVISOR_ID))
  const supervisor = fakeAgent({
    id: SUPERVISOR_ID,
    role: 'supervisor',
    session,
    agents,
    options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  })
  live.set(SUPERVISOR_ID, supervisor)

  provide(ctx, 'settings', {
    installSection: (owner: unknown, ns: string, schema: unknown, entry: unknown) => {
      installs.push({ owner, ns, schema, entry })
    },
  })
  provide(ctx, 'tools', {})
  provide(ctx, 'systemPrompt', {})
  provide(ctx, 'agents', agents)
  provide(ctx, 'llm', {})
  provide(ctx, 'subprocess', {})

  const register = (id: string, parent?: FakeAgent): FakeAgent => {
    const child = ctx.get('sessions')!.create(SessionId(id), {
      ...parent === undefined ? {} : { meta: { parentSession: parent.session.id, origin: 'subagent' as const } },
    })
    const agent = fakeAgent({ id, role: 'supervisor', session: child, agents })
    live.set(id, agent)
    return agent
  }

  return {
    ctx,
    supervisor,
    installs,
    createAgent: (id) => register(id),
    createChild: (id, parent) => register(id, parent),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('host composition', () => {
  it('provides the orc service, installs the tool per agent, and unwinds on unload', async () => {
    const { ctx, supervisor, createAgent, createChild, installs } = composition()
    const dispose = vi.spyOn(OrcService.prototype, 'dispose')

    // The Loader row's own plugin shape, loaded into a real fiber.
    const fiber = await ctx.plugin({ name, inject, apply, Config }, fixtureConfig('auto'))

    const service = ctx.get('orc')
    expect(service).toBeInstanceOf(OrcService)
    expect(installs.map(call => call.ns)).toEqual(['orc'])

    // An agent that already existed when the profile loaded is served.
    expect(supervisor.ctx.tools.get('orc')).toBeDefined()
    expect(supervisor.ctx.systemPrompt.list().map(section => section.name)).toEqual([ORC_SECTION_NAME])

    // A later agent is served by the `agent/created` listener.
    const late = createAgent('session-late')
    expect(late.ctx.tools.get('orc')).toBeUndefined()
    ctx.emit('agent/created', { agent: late, source: 'startup' })
    expect(late.ctx.tools.get('orc')).toBeDefined()
    expect(late.ctx.systemPrompt.list().map(section => section.name)).toEqual([ORC_SECTION_NAME])

    // A subagent is a member of a run, never a Supervisor: DSH reports it as a
    // non-root, so ORC installs no tool, no policy, and no gate on it.
    const child = createChild('session-child', supervisor)
    expect(child.session.header.parentSession).toBe(supervisor.session.id)
    ctx.emit('agent/created', { agent: child, source: 'startup' })
    expect(child.ctx.tools.get('orc')).toBeUndefined()
    expect(child.ctx.systemPrompt.list()).toHaveLength(0)

    // The service is live over the real journal: a durable start reaches the
    // projection, so the composition wired the real seam and not a stub.
    await service!.start(supervisor, HIGH_RISK)
    expect(service!.state(supervisor).started).toBe(true)
    expect(ctx.get('sessionProjections')!.stateOf(supervisor.session, 'orc')?.risk).toEqual(HIGH_RISK)

    // `agent/disposed` removes exactly that agent's contribution.
    ctx.emit('agent/disposed', { agent: supervisor })
    expect(supervisor.ctx.tools.get('orc')).toBeUndefined()
    expect(supervisor.ctx.systemPrompt.list()).toHaveLength(0)
    expect(late.ctx.tools.get('orc')).toBeDefined()

    // Unloading the plugin unprovides and disposes the service and unwinds
    // every remaining Agent contribution.
    await fiber.dispose()
    expect(ctx.get('orc')).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(late.ctx.tools.get('orc')).toBeUndefined()
    expect(late.ctx.systemPrompt.list()).toHaveLength(0)

    // A disposed profile installs nothing for an agent created afterwards.
    const after = createAgent('session-after')
    ctx.emit('agent/created', { agent: after, source: 'startup' })
    expect(after.ctx.tools.get('orc')).toBeUndefined()
  })
})
