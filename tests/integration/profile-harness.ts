/**
 * Clean-profile harness for the packed ORC bundle.
 *
 * The Task 10 integration specs assert against the **packed archive**, not the
 * source tree: this module packs the bundle with `npm pack`, extracts the
 * tarball into a disposable profile's `node_modules`, and mounts the extracted
 * `lib/host/index.js` and `lib/client.js` artifacts exactly as a profile would.
 *
 * The profile model **mirrors** the persisted operations
 * `@deepseek-ai/dsh-plugin-manager` performs through `dsh plugin`/the Plugins
 * page:
 *
 * - `installBundle` adds the dependency and selects the bundle layer
 *   (`PluginManager.installBundle` → `selectBundle(name, true)`);
 * - `setBundleEnabled` adds/removes the selected layer only
 *   (`PluginManager.setBundleEnabled` → `selectBundle`);
 * - `removeBundle` deletes the installed dependency and its selection
 *   (`PluginManager.removeBundle`).
 *
 * It is a mirror, not the operation: it writes the same bytes and recomposes a
 * live runtime, but it cannot reach the service's guards (`not-bundle`,
 * `management-required`), its install/removal refusals, or its
 * `restart-required` reporting, all of which need the `pluginManager` service
 * inside a booted profile. Those are exercised for real by
 * `scripts/clean-profile-smoke.mjs`, which boots the disposable Web profile
 * through `@deepseek-ai/dsh/profile-boot` and calls the service. This harness
 * stays the test-side mirror so the contribution transitions and the
 * DSH-owned-defaults comparisons run in-process; do not read it as proof of the
 * service contract.
 *
 * DSH owns the harness home's standard preset, global model defaults, provider
 * credentials, and unrelated settings; none of the three operations touches
 * those files, and the specs assert that byte-for-byte.
 *
 * Every owned path is a `mkdtemp(join(tmpdir(), 'orc-profile-'))` directory.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SubagentCapabilities, ContinuableStart, ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import type { OrcConfig } from '../../src/domain/types.js'
import type { OrcState } from '../../src/domain/workflow.js'
import type { OrcSubagentPort } from '../../src/host/service.js'
import { ORC_SECTION_NAME } from '../../src/host/tool.js'
import {
  fakeAgent,
  fakeDshSessionServices,
  session,
  SUPERVISOR_ID,
  type FakeAgent,
} from '../fixtures/ports.js'
import { fakeClientContext, fakeSlots, type FakeClientContext, type FakeSlots } from '../fixtures/client.js'
import { config as fixtureConfig } from '../fixtures/routes.js'

/** The repository root, so `npm pack` and dependency links resolve. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The one user-facing bundle package this repository publishes. */
export const PACKAGE_NAME = '@tonamson/dsh-orc'

/** The two Loader rows the bundle patch declares. */
export const BUNDLE_ROWS = ['orc-host', 'orc-remote-host'] as const

/** One file `npm pack --json` reported in the archive. */
export interface PackedFile {
  readonly path: string
  readonly size: number
}

/** One packed archive plus the owned directory that holds it. */
export interface PackedBundle {
  /** The owned temp directory; callers remove exactly this. */
  readonly root: string
  readonly tarball: string
  readonly filename: string
  readonly name: string
  readonly version: string
  readonly entryCount: number
  readonly files: readonly PackedFile[]
}

/** The four runtime contributions the bundle's enablement controls. */
export interface Contributions {
  readonly service: boolean
  readonly tool: boolean
  readonly policy: boolean
  readonly page: boolean
}

/** The DSH-owned configuration the bundle must never modify. */
export interface ProfileDefaults {
  /** DSH's standard agent preset. */
  readonly standardPreset: unknown
  /** DSH's global model defaults. */
  readonly globalModelDefaults: unknown
  /** DSH's provider credential store. */
  readonly providerCredentials: unknown
  /** A settings entry owned by an unrelated plugin. */
  readonly unrelatedSettings: unknown
}

/** One profile's composition and DSH-owned configuration. */
export interface ProfileSnapshot {
  readonly defaults: ProfileDefaults
  readonly bundles: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
  /** The raw user patch layer. */
  readonly patchLayer: string
  /** The raw DSH settings document. */
  readonly settings: string
  /** The raw DSH credential document. */
  readonly credentials: string
}

/** One disposable Web profile under an owned DSH home. */
export interface Profile {
  /** The owned harness home (`$DSH_HOME`). */
  readonly home: string
  /** `$DSH_HOME/profiles/web`. */
  readonly dir: string
  readonly packagePath: string
  readonly patchPath: string
  readonly settingsPath: string
  readonly credentialsPath: string
}

/**
 * Pack this repository with `npm pack --json`.
 *
 * @returns the archive, its file manifest, and the owned directory holding it.
 */
export function packBundle(): PackedBundle {
  const root = mkdtempSync(join(tmpdir(), 'orc-profile-'))
  const destination = join(root, 'package')
  mkdirSync(destination, { recursive: true })
  const stdout = execFileSync('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  })
  // npm 11 reports an array; newer npm reports a name-keyed object. Accept both.
  const parsed = JSON.parse(stdout) as unknown
  const reports = (Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>)) as Array<{
    name: string
    version: string
    filename: string
    entryCount: number
    files: PackedFile[]
  }>
  const [entry] = reports
  if (entry === undefined) throw new Error('npm pack reported no package')
  return {
    root,
    tarball: join(destination, entry.filename),
    filename: entry.filename,
    name: entry.name,
    version: entry.version,
    entryCount: entry.entryCount,
    files: entry.files,
  }
}

/** Extract one packed archive into a destination directory. */
export function extractBundle(tarball: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'], { stdio: 'pipe' })
}

/**
 * Create one disposable Web profile with DSH-owned defaults seeded.
 *
 * The seeded documents are valid JSON, which is also valid YAML, so the same
 * bytes DSH would read as `settings.yaml`/`.credentials.yaml` are readable here
 * without a YAML dependency. They contain no real credential.
 */
export function createProfile(): Profile {
  const home = mkdtempSync(join(tmpdir(), 'orc-profile-'))
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const profile: Profile = {
    home,
    dir,
    packagePath: join(dir, 'package.json'),
    patchPath: join(dir, 'cordis.patch.yml'),
    settingsPath: join(home, 'settings.yaml'),
    credentialsPath: join(home, '.credentials.yaml'),
  }
  writeFileSync(profile.packagePath, `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`)
  writeFileSync(profile.patchPath, `${JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  ], null, 2)}\n`)
  writeFileSync(profile.settingsPath, `${JSON.stringify({
    version: 1,
    preset: { standard: { id: 'standard', agents: ['supervisor'] } },
    models: { default: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    unrelated: { plugin: 'notes', value: 7 },
  }, null, 2)}\n`)
  writeFileSync(profile.credentialsPath, `${JSON.stringify({ version: 1, refs: {}, records: {} }, null, 2)}\n`)
  return profile
}

/** Read the profile manifest as DSH persists it. */
function readManifest(profile: Profile): {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
} {
  return JSON.parse(readFileSync(profile.packagePath, 'utf8'))
}

/** Write the profile manifest back, preserving unrelated fields. */
function writeManifest(profile: Profile, manifest: Record<string, unknown>): void {
  writeFileSync(profile.packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The bundle layer selection currently persisted in the profile. */
export function selectedBundles(profile: Profile): string[] {
  return [...readManifest(profile).dsh?.profile?.bundles ?? []]
}

/** Whether the bundle's dependency is installed in the profile. */
export function bundleInstalled(profile: Profile): boolean {
  return existsSync(join(profile.dir, 'node_modules', ...PACKAGE_NAME.split('/')))
}

/** Snapshot one profile's DSH-owned defaults. */
export function snapshotDefaults(profile: Profile): ProfileDefaults {
  const settings = JSON.parse(readFileSync(profile.settingsPath, 'utf8'))
  const credentials = JSON.parse(readFileSync(profile.credentialsPath, 'utf8'))
  return {
    standardPreset: settings.preset,
    globalModelDefaults: settings.models,
    providerCredentials: credentials,
    unrelatedSettings: settings.unrelated,
  }
}

/** Snapshot one profile's composition and DSH-owned configuration. */
export function snapshotProfile(profile: Profile): ProfileSnapshot {
  const manifest = readManifest(profile)
  return {
    defaults: snapshotDefaults(profile),
    bundles: [...manifest.dsh?.profile?.bundles ?? []],
    dependencies: { ...manifest.dependencies ?? {} },
    patchLayer: readFileSync(profile.patchPath, 'utf8'),
    settings: readFileSync(profile.settingsPath, 'utf8'),
    credentials: readFileSync(profile.credentialsPath, 'utf8'),
  }
}

/** The shape the packed Host module exports. */
interface PackedHost {
  name: string
  inject: string[]
  apply(ctx: CordisContext, config: OrcConfig): void
  Config: unknown
}

/** The shape the packed lazy-CJS Client module exports. */
interface PackedClient {
  inject: string[]
  apply(ctx: CordisContext, options?: { remote?: unknown }): void
}

/**
 * Load one extracted package's Host artifact.
 *
 * `require` of the extracted ESM entry keeps the packed artifact on Node's own
 * loader, so the profile harness exercises the shipped file and never the
 * TypeScript source.
 */
function loadPackedHost(packageDir: string): PackedHost {
  const require = createRequire(join(packageDir, 'package.json'))
  return require(join(packageDir, 'lib', 'host', 'index.js')) as PackedHost
}

/**
 * Load one extracted package's lazy-CJS Client artifact through the module
 * loader contract: evaluating the file only registers a factory, and the
 * factory materializes the module when the profile loads it.
 */
function loadPackedClient(packageDir: string): PackedClient {
  const source = readFileSync(join(packageDir, 'lib', 'client.js'), 'utf8')
  // The shell seeds React as a platform module; this harness resolves it from
  // the repository's own installation, exactly as the loader would.
  const require = createRequire(import.meta.url)
  let registration: { id: string; factory(require: (id: string) => unknown): unknown } | undefined
  const loader = {
    load(entry: { id: string; factory(require: (id: string) => unknown): unknown }) {
      registration = entry
    },
  }
  new Function('window', source)({ __ModuleLoader__: loader })
  if (registration === undefined) throw new Error('the packed Client artifact registered no module factory')
  if (registration.id !== PACKAGE_NAME) {
    throw new Error(`the packed Client artifact registered "${registration.id}", not "${PACKAGE_NAME}"`)
  }
  return registration.factory(require) as PackedClient
}

/** A promise that resolves once one signal aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** A continuable-child port that can hold one startup in flight. */
export interface HarnessSubagents extends OrcSubagentPort {
  /** Every start spec handed over, in order. */
  readonly starts: { label: string; childId: string | undefined; parentId: string }[]
  /** Every published child, keyed by child id. */
  readonly children: Map<string, FakeAgent>
  /** Hold the next child startup until the returned release runs. */
  holdNextStart(): () => void
}

/** Build the continuable-child port over one live-agent registry. */
function harnessSubagents(agents: Map<string, FakeAgent>): HarnessSubagents {
  const starts: HarnessSubagents['starts'] = []
  const children = new Map<string, FakeAgent>()
  let gate: { promise: Promise<void>; release: () => void } | undefined
  let counter = 0
  const capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  return {
    starts,
    children,
    holdNextStart: () => {
      let release = (): void => {}
      const promise = new Promise<void>((settle) => {
        release = settle
      })
      gate = { promise, release }
      return () => {
        gate = undefined
        release()
      }
    },
    getProvider: (name) => name === 'spawn'
      ? { capabilities, prepareContinuable: () => ({}) }
      : undefined,
    startContinuable: async (spec: ContinuableStartSpec): Promise<ContinuableStart> => {
      starts.push({
        label: spec.label,
        childId: spec.childId === undefined ? undefined : String(spec.childId),
        parentId: String(spec.request.parent.id),
      })
      const held = gate
      if (held !== undefined) {
        gate = undefined
        // A real continuable runtime aborts in-flight work when its signal
        // aborts; the hold releases on either the abort or an explicit release.
        await Promise.race([held.promise, aborted(spec.signal)])
      }
      if (spec.signal.aborted) {
        throw spec.signal.reason instanceof Error ? spec.signal.reason : new Error('aborted')
      }
      counter += 1
      const childId = String(spec.childId ?? `child-${counter}`)
      const options: AgentOptions = spec.request.agentOptions ?? {}
      const child = fakeAgent({
        id: childId,
        role: spec.label.includes('lead') ? 'lead' : 'peer',
        session: session(childId, String(spec.request.parent.id)),
        agents: { get: (id: SessionId) => agents.get(String(id)) },
        options,
      })
      children.set(childId, child)
      agents.set(childId, child)
      return { childId: SessionId(childId), messageId: MessageId(`message-${childId}`) }
    },
  }
}

/**
 * One live profile: the fake DSH services the packed Host injects, plus the
 * mounted bundle contributions.
 */
export class ProfileRuntime {
  /** The profile context the Host row mounts into. */
  readonly ctx: CordisContext
  /** The Supervisor every contribution is scoped to. */
  readonly supervisor: FakeAgent
  /** Every live agent, as `ctx.agents` reports them. */
  readonly agents = new Map<string, FakeAgent>()
  /** The continuable-child port the packed Host reads through `ctx.get('subagents')`. */
  readonly subagents: HarnessSubagents
  /** The renderer slot registry the packed Client registers into. */
  readonly slots: FakeSlots
  /** Every settings section the packed Host installed. */
  readonly installs: string[] = []

  private readonly config: OrcConfig
  private fiber: { dispose(): Promise<void> } | undefined
  private client: FakeClientContext | undefined

  constructor(options: { config?: OrcConfig } = {}) {
    this.config = options.config ?? fixtureConfig('auto')
    const { ctx } = fakeDshSessionServices()
    this.ctx = ctx
    this.subagents = harnessSubagents(this.agents)
    this.slots = fakeSlots()
    this.supervisor = fakeAgent({
      id: SUPERVISOR_ID,
      role: 'supervisor',
      session: ctx.get('sessions')!.create(SessionId(SUPERVISOR_ID)),
      agents: { get: (id: SessionId) => this.agents.get(String(id)) },
      options: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    })
    this.agents.set(SUPERVISOR_ID, this.supervisor)

    const provide = (name: string, value: unknown): void => {
      ctx.provide(name, value)
    }
    provide('settings', {
      installSection: (_owner: unknown, ns: string) => {
        this.installs.push(ns)
      },
    })
    provide('tools', {})
    provide('systemPrompt', {})
    provide('agents', {
      list: () => [...this.agents.values()],
      get: (id: SessionId) => this.agents.get(String(id)),
    })
    provide('llm', {
      // One configured provider route, enough for the packed Host to route a
      // spec/plan stage without a network call or a real credential.
      listProviders: () => [{ id: 'custom' }],
      listModels: async (provider: string) => provider === 'custom' ? [{ id: 'm1', provider }] : [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
      stream: () => (async function* () {
        yield { type: 'text-delta', text: 'stage output' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    })
    provide('subprocess', {})
    provide('subagents', this.subagents)
  }

  /** The ORC service the packed Host published, while the bundle is enabled. */
  service(): unknown {
    return this.ctx.get('orc')
  }

  /** The packed Host's durable ORC projection for one session, while mounted. */
  projection(session: Session): { run: OrcState } | undefined {
    const registry = this.ctx.get('sessionProjections')
    return registry?.stateOf(session, 'orc') as { run: OrcState } | undefined
  }

  /** Mount the packed Host and Client artifacts into this profile. */
  async mount(packageDir: string): Promise<void> {
    await this.unmount()
    const host = loadPackedHost(packageDir)
    this.fiber = await this.ctx.plugin(
      { name: host.name, inject: host.inject, apply: host.apply, Config: host.Config },
      this.config,
    )
    const client = loadPackedClient(packageDir)
    this.client = fakeClientContext({ slots: this.slots, initial: this.config })
    client.apply(this.client, {})
  }

  /** Unload every bundle contribution, as disabling the bundle does. */
  async unmount(): Promise<void> {
    const fiber = this.fiber
    this.fiber = undefined
    if (fiber !== undefined) await fiber.dispose()
    const client = this.client
    this.client = undefined
    client?.dispose()
  }

  /** The four contributions currently live in this profile. */
  contributions(): Contributions {
    return {
      service: this.ctx.get('orc') !== undefined,
      tool: this.supervisor.ctx.tools.get('orc') !== undefined,
      policy: this.supervisor.ctx.systemPrompt.list().some(section => section.name === ORC_SECTION_NAME),
      page: this.slots.ids('settings.section').includes('orc'),
    }
  }
}

/**
 * The persisted profile operations Task 10 exercises, mirroring the Plugin
 * Manager's `installBundle`/`setBundleEnabled`/`removeBundle` file effects and
 * applying them to a live {@link ProfileRuntime}.
 *
 * **Mirror, not the service.** These methods write the same persisted bytes the
 * real operations write and recompose a live runtime from them. They do not
 * call the Plugin Manager and cannot observe its guards
 * (`not-bundle`/`management-required`) or its `restart-required` reporting;
 * `scripts/clean-profile-smoke.mjs` boots the profile and calls the real
 * `pluginManager` service for that surface.
 */
export class ProfileManager {
  constructor(
    private readonly profile: Profile,
    private readonly runtime: ProfileRuntime,
  ) {}

  /** The installed bundle's directory in the profile. */
  packageDir(): string {
    return join(this.profile.dir, 'node_modules', ...PACKAGE_NAME.split('/'))
  }

  /** Install the packed tarball and activate its bundle layer. */
  async installBundle(tarball: string): Promise<void> {
    extractBundle(tarball, this.packageDir())
    linkRuntimeDeps(this.profile)
    const manifest = readManifest(this.profile)
    manifest.dependencies = { ...manifest.dependencies ?? {}, [PACKAGE_NAME]: `file:${tarball}` }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...new Set([...bundles, PACKAGE_NAME])] },
    }
    writeManifest(this.profile, manifest)
    await this.apply()
  }

  /**
   * Select or unselect the installed bundle layer without removing it.
   *
   * Mirror of `PluginManager.setBundleEnabled` → `selectBundle`; the real
   * service is exercised by `scripts/clean-profile-smoke.mjs`.
   */
  async setBundleEnabled(name: string, enabled: boolean): Promise<void> {
    const manifest = readManifest(this.profile)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const next = enabled ? [...new Set([...bundles, name])] : bundles.filter(bundle => bundle !== name)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
    writeManifest(this.profile, manifest)
    await this.apply()
  }

  /** Remove the installed bundle dependency and its selection. */
  async removeBundle(name: string): Promise<void> {
    rmSync(this.packageDir(), { recursive: true, force: true })
    const manifest = readManifest(this.profile)
    const dependencies = { ...manifest.dependencies ?? {} }
    delete dependencies[name]
    manifest.dependencies = dependencies
    const bundles = manifest.dsh?.profile?.bundles ?? []
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: bundles.filter(bundle => bundle !== name) },
    }
    writeManifest(this.profile, manifest)
    await this.apply()
  }

  /** Re-compose the profile, as a controlled profile restart does. */
  private async apply(): Promise<void> {
    await this.runtime.unmount()
    if (bundleInstalled(this.profile) && selectedBundles(this.profile).includes(PACKAGE_NAME)) {
      await this.runtime.mount(this.packageDir())
    }
  }
}

/**
 * Make the profile's installed bundle resolve the DSH peers and runtime
 * dependencies the harness's own installation provides. A booted profile has
 * these through its DSH installation; this disposable profile links the same
 * packages so the packed artifacts load without a second full DSH install.
 */
function linkRuntimeDeps(profile: Profile): void {
  const modules = join(profile.dir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const links: [string, string][] = [
    ['@deepseek-ai', join(REPO_ROOT, 'node_modules', '@deepseek-ai')],
    ['zod', join(REPO_ROOT, 'node_modules', 'zod')],
  ]
  for (const [name, target] of links) {
    const link = join(modules, name)
    if (!existsSync(link)) symlinkSync(target, link, 'dir')
  }
}

/** Remove one owned temp directory, ignoring a path that is already gone. */
export function removeOwned(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
