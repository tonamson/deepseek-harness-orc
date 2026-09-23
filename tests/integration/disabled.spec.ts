/**
 * Profile lifecycle: install, enable, disable, remove.
 *
 * The Task 10 release gate asserts the brief's contribution transitions against
 * a disposable profile whose bundle was extracted from the real packed archive:
 *
 * - installing and enabling the bundle activates all four contributions;
 * - disabling it removes the runtime contributions and the ORC settings page;
 * - removing it leaves the profile's DSH-owned defaults exactly as they were.
 *
 * Every assertion uses the same profile snapshot before and after each action,
 * and the standard preset, global model defaults, provider credentials, and an
 * unrelated plugin's settings are compared byte-for-byte so a bundle that wrote
 * outside its own namespace cannot pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrcConfig } from '../../src/domain/types.js'
import type { OrcService } from '../../src/host/service.js'
import { HIGH_RISK } from '../fixtures/ports.js'
import { planRoute } from '../fixtures/routes.js'
import {
  bundleInstalled,
  createProfile,
  PACKAGE_NAME,
  packBundle,
  ProfileManager,
  ProfileRuntime,
  removeOwned,
  selectedBundles,
  snapshotDefaults,
  snapshotProfile,
  type PackedBundle,
  type Profile,
} from './profile-harness.js'

let packed: PackedBundle
let profile: Profile
let runtime: ProfileRuntime
let manager: ProfileManager
/** Every owned temp directory this spec created. */
const owned: string[] = []

beforeAll(() => {
  packed = packBundle()
})

afterAll(async () => {
  await runtime?.unmount()
  for (const root of [...owned, packed.root]) removeOwned(root)
})

/** Build one disposable profile and its live runtime. */
function setup(): void {
  profile = createProfile()
  owned.push(profile.home)
  runtime = new ProfileRuntime()
  manager = new ProfileManager(profile, runtime)
}

describe('profile lifecycle', () => {
  it('activates every contribution on install and unwinds each action against the same snapshot', async () => {
    setup()
    const before = snapshotProfile(profile)

    await manager.installBundle(packed.tarball)
    expect(runtime.contributions()).toEqual({ service: true, tool: true, policy: true, page: true })
    // ORC owns exactly its own settings namespace.
    expect([...new Set(runtime.installs)]).toEqual(['orc'])
    // The bundle layer is selected; the pre-existing layers are untouched.
    expect(selectedBundles(profile)).toEqual([...before.bundles, PACKAGE_NAME])
    expect(snapshotDefaults(profile)).toEqual(before.defaults)
    expect(snapshotProfile(profile).patchLayer).toBe(before.patchLayer)
    expect(snapshotProfile(profile).settings).toBe(before.settings)
    expect(snapshotProfile(profile).credentials).toBe(before.credentials)

    await manager.setBundleEnabled(PACKAGE_NAME, false)
    expect(runtime.contributions()).toEqual({ service: false, tool: false, policy: false, page: false })
    expect(selectedBundles(profile)).toEqual([...before.bundles])
    expect(snapshotDefaults(profile)).toEqual(before.defaults)

    // Re-enabling restores every contribution without touching the defaults.
    await manager.setBundleEnabled(PACKAGE_NAME, true)
    expect(runtime.contributions()).toEqual({ service: true, tool: true, policy: true, page: true })
    expect(snapshotDefaults(profile)).toEqual(before.defaults)

    await manager.setBundleEnabled(PACKAGE_NAME, false)
    await manager.removeBundle(PACKAGE_NAME)
    expect(bundleInstalled(profile)).toBe(false)
    expect(selectedBundles(profile)).toEqual([...before.bundles])
    expect(snapshotProfile(profile).dependencies).toEqual({})
    expect(runtime.contributions()).toEqual({ service: false, tool: false, policy: false, page: false })
    expect(snapshotProfile(profile)).toEqual(before)
  })

  it('keeps the standard preset, global model defaults, credentials, and unrelated settings identical', async () => {
    setup()
    const before = snapshotProfile(profile)
    expect(before.defaults.standardPreset).toEqual({ standard: { id: 'standard', agents: ['supervisor'] } })
    expect(before.defaults.globalModelDefaults).toEqual({ default: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    expect(before.defaults.providerCredentials).toEqual({ version: 1, refs: {}, records: {} })
    expect(before.defaults.unrelatedSettings).toEqual({ plugin: 'notes', value: 7 })

    await manager.installBundle(packed.tarball)
    await manager.setBundleEnabled(PACKAGE_NAME, false)
    await manager.setBundleEnabled(PACKAGE_NAME, true)
    await manager.removeBundle(PACKAGE_NAME)

    const after = snapshotProfile(profile)
    expect(after.defaults).toEqual(before.defaults)
    expect(after.patchLayer).toBe(before.patchLayer)
    expect(after.settings).toBe(before.settings)
    expect(after.credentials).toBe(before.credentials)
  })

  it('cancels and settles an active delegated run before disposal, leaving no orphan child', async () => {
    // A manual config whose spec/plan stages use the one provider route the
    // harness's fake LLM serves, so the run reaches the delegated phase without
    // a network call, a real credential, or a CLI.
    const activeConfig: OrcConfig = {
      sessionMode: 'adaptive',
      codeRoute: undefined,
      analysisMode: 'manual',
      manual: { spec: planRoute, plan: planRoute, review: undefined, audit: undefined },
      allowed: [planRoute],
      cliPaths: {},
      catalogMaxAgeDays: 7,
    }
    profile = createProfile()
    owned.push(profile.home)
    runtime = new ProfileRuntime({ config: activeConfig })
    manager = new ProfileManager(profile, runtime)
    await manager.installBundle(packed.tarball)
    const service = runtime.service() as OrcService
    const supervisor = runtime.supervisor
    const signal = new AbortController().signal

    await service.start(supervisor, HIGH_RISK)
    await service.dispatch(supervisor, 'spec', 'spec input', signal)
    await service.dispatch(supervisor, 'plan', 'plan input', signal)
    const lead = await service.createLead(supervisor)
    const peer = await service.createPeer(lead, 'peer-1')
    await service.startTask(lead, peer, 'task-1')
    // The delegated run is live and durable before the bundle is disabled.
    const projected = runtime.projection(supervisor.session)
    expect(projected?.run.started).toBe(true)
    expect(projected?.run.tasks.map(task => task.id)).toEqual(['task-1'])

    // Hold one more child startup in flight so the disable lands mid-delegation.
    const release = runtime.subagents.holdNextStart()
    const pending = service.createPeer(lead, 'peer-2')

    const before = snapshotProfile(profile)
    // Disabling disposes the ORC service — the first unload step the Host
    // composition performs — which cancels the in-flight delegation and settles
    // the run while its durable projection is still mounted.
    service.dispose()
    await expect(pending).rejects.toThrow(/ORC was disabled/)
    release()
    expect(supervisor.session.snapshotEvents().at(-1)?.type).toBe('orc/fail')

    // The rest of the disable removes every runtime contribution.
    await manager.setBundleEnabled(PACKAGE_NAME, false)
    // The cancelled startup materialized no child: the two real children remain.
    expect(runtime.subagents.children.size).toBe(2)
    expect(runtime.contributions()).toEqual({ service: false, tool: false, policy: false, page: false })
    expect(snapshotDefaults(profile)).toEqual(before.defaults)
  })

  it('does not mount the ORC tool, policy, or page while the bundle is disabled', async () => {
    setup()
    await manager.installBundle(packed.tarball)
    await manager.setBundleEnabled(PACKAGE_NAME, false)

    const supervisor = runtime.supervisor
    expect(runtime.ctx.get('orc')).toBeUndefined()
    expect(supervisor.ctx.tools.get('orc')).toBeUndefined()
    expect(supervisor.ctx.systemPrompt.list()).toHaveLength(0)
    expect(runtime.slots.ids('settings.section')).toEqual([])
  })
})
