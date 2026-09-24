/**
 * Browser-side fakes for the ORC settings page.
 *
 * Three fakes model the *published* client seams rather than the page's
 * assumptions:
 *
 * - {@link fakeScope} is a real `SettingsScope<OrcConfig>` over one namespace:
 *   it caches its snapshot (React's `useSyncExternalStore` contract), records
 *   every revision-fenced `set`/`unset` with the namespace it targeted, and
 *   notifies subscribers, so a page that skipped the write path or wrote
 *   outside `orc` is caught here. `failNextWrite` makes the next write reject
 *   the way the Host transport does, so a refusal is testable too.
 * - {@link fakeRemote} is the injectable ORC remote port. It records every
 *   probe and returns the host-shaped `OrcConnection` a real Remote face
 *   returns; a test overrides `catalog`, `probe`, or `recorded` to drive one
 *   failure case without any network or CLI.
 * - {@link fakeSlots} is the renderer's slot registry: `inject` runs its
 *   callback immediately (the `settings.section` declaration exists in a real
 *   profile), `register` records the entry and returns the disposer the client
 *   plugin owns, and `disposeAll` collapses it.
 *
 * {@link fakeClientContext} composes those three into a Cordis-shaped context
 * with the locale registry, the settings-scope binder, and an effect scope, so
 * `applyClient(ctx)` runs its real registration path and `ctx.dispose()` runs
 * the real unload path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot, OrcConfig, Route } from '../../src/domain/types.js'
import { hostRouteKey, type OrcConnectionView, type OrcRemotePort } from '../../src/client/OrcSettingsPage.js'
import type { OrcRemoteNamespace } from '../../src/client/remote.js'

/** One recorded settings write, including the namespace it targeted. */
export interface ScopeWrite {
  readonly namespace: string
  readonly field: string
  /** Present for `set`; absent for `unset`. */
  readonly value?: unknown
  /** True when the write was `unset`. */
  readonly cleared?: boolean
}

/** A `SettingsScope<OrcConfig>` stand-in with its recorded writes. */
export interface FakeScope {
  readonly namespace: string
  readonly scope: SettingsScope<OrcConfig>
  readonly writes: ScopeWrite[]
  /** Current resolved value, as the host would resolve it. */
  value(): OrcConfig
  /** Replace the resolved value and notify subscribers, as a host push would. */
  push(next: OrcConfig): void
  /** Make the next `set`/`unset` reject with this error instead of applying. */
  failNextWrite(error: Error): void
}

/** The provider code route the fixture config defaults to. */
export const providerRoute: Route = {
  kind: 'provider',
  provider: 'deepseek',
  model: 'deepseek-v4.1-flash',
  effort: 'high',
}

/** The Codex CLI route the fixture catalog advertises. */
export const codexRoute: Route = { kind: 'cli', cli: 'codex', model: 'gpt-6-sol', effort: 'high' }

/** The Claude Code CLI route the fixture catalog advertises. */
export const claudeRoute: Route = { kind: 'cli', cli: 'claude', model: 'claude-opus-4-1', effort: 'high' }

/** The instant every fixture observation carries. */
export const NOW = '2026-09-23T00:00:00Z'

/** The fixture ORC namespace value: Manual mode with every stage assigned. */
export function fixtureConfig(): OrcConfig {
  return {
    sessionMode: 'adaptive',
    codeRoute: providerRoute,
    analysisMode: 'manual',
    manual: { spec: providerRoute, plan: providerRoute, review: claudeRoute, audit: claudeRoute },
    allowed: [providerRoute, codexRoute, claudeRoute],
    cliPaths: {},
    catalogMaxAgeDays: 7,
  }
}

/** The live catalog the fixture remote returns. */
export function fixtureCatalog(): CatalogSnapshot {
  return {
    id: 'catalog-fixture',
    observedAt: NOW,
    entries: [
      {
        routeKey: 'provider:deepseek:deepseek-v4.1-flash:high',
        backendVersion: '',
        model: 'deepseek-v4.1-flash',
        efforts: ['high'],
        accountAccess: true,
        sourceUrl: 'https://example.test/deepseek',
        retrievedAt: NOW,
      },
      {
        routeKey: 'cli:codex:gpt-6-sol:high',
        backendVersion: '0.156.1',
        model: 'gpt-6-sol',
        efforts: ['high', 'medium'],
        accountAccess: true,
        sourceUrl: 'https://example.test/codex',
        retrievedAt: NOW,
      },
      {
        routeKey: 'cli:claude:claude-opus-4-1:high',
        backendVersion: '2.1.280',
        model: 'claude-opus-4-1',
        efforts: ['high'],
        accountAccess: true,
        sourceUrl: 'https://example.test/claude',
        retrievedAt: NOW,
      },
    ],
  }
}

/** One green connection result for an exact route. */
export function greenConnection(route: Route, revision = 'rev-fixture'): OrcConnectionView {
  return { routeKey: hostRouteKey(route), revision, testedAt: NOW, ok: true, code: '', diagnostic: '' }
}

/** One failed connection result for an exact route. */
export function failedConnection(
  route: Route,
  code: string,
  diagnostic = '',
  revision = 'rev-fixture',
): OrcConnectionView {
  return { routeKey: hostRouteKey(route), revision, testedAt: NOW, ok: false, code, diagnostic }
}

/**
 * Build a namespace-bound `SettingsScope<OrcConfig>` stand-in.
 *
 * @param namespace - the namespace the scope is bound to.
 * @param initial - the resolved value the host would report.
 */
export function fakeScope(namespace: string, initial: OrcConfig = fixtureConfig()): FakeScope {
  const writes: ScopeWrite[] = []
  let value = initial
  let revision = 1
  let failure: Error | undefined
  let snapshot: SettingsScopeSnapshot<OrcConfig> = {
    status: 'ready',
    value,
    base: initial,
    user: {},
    revision,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()

  const publish = (): void => {
    revision += 1
    snapshot = { ...snapshot, value, revision }
    for (const listener of [...listeners]) listener()
  }

  /**
   * Refuse one write exactly as the Host transport does: nothing is applied,
   * nothing is recorded, and the caller's promise rejects.
   */
  const refuse = (): void => {
    if (failure === undefined) return
    const error = failure
    failure = undefined
    throw error
  }

  const scope: SettingsScope<OrcConfig> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: async (field, fieldValue) => {
      refuse()
      writes.push({ namespace, field, value: fieldValue })
      value = { ...value, [field]: fieldValue }
      publish()
    },
    unset: async (field) => {
      refuse()
      writes.push({ namespace, field, cleared: true })
      const next = { ...value } as Record<string, unknown>
      delete next[field]
      value = next as unknown as OrcConfig
      publish()
    },
    mutate: async () => {
      throw new Error('fakeScope: mutate is not part of this page contract')
    },
  }

  return {
    namespace,
    scope,
    writes,
    value: () => value,
    push: (next) => {
      value = next
      publish()
    },
    failNextWrite: (error) => {
      failure = error
    },
  }
}

/** The scope most recently created through {@link scope}. */
let lastScope: FakeScope | undefined

/**
 * Bind one namespace, as `ctx.settingsScope.bind({ namespace })` does.
 *
 * @param namespace - the namespace to bind.
 * @param initial - the resolved value the host would report.
 * @returns the bound scope; its writes are readable through {@link scopeWrites}.
 */
export function scope(namespace: string, initial: OrcConfig = fixtureConfig()): SettingsScope<OrcConfig> {
  lastScope = fakeScope(namespace, initial)
  return lastScope.scope
}

/** Every write the most recently bound scope recorded. */
export function scopeWrites(): ScopeWrite[] {
  return lastScope?.writes ?? []
}

/** The remote port stand-in, with its probe log and overridable answers. */
export interface FakeRemote extends OrcRemotePort {
  /** Every route the page asked to probe, in order. */
  readonly probes: Route[]
  /** Every route key the page asked about, in order. */
  readonly lookups: string[]
  /** How many times the page read the catalog. */
  readonly catalogReads: () => number
  /** The catalog answer; replace to drive an unavailable or stale backend. */
  catalog: CatalogSnapshot
  /**
   * Recorded results keyed by the exact host route key the page asked about.
   *
   * Keying by route key is load-bearing: a page that looked a CLI up under the
   * wrong key would otherwise still be handed an answer.
   */
  recorded: Map<string, OrcConnectionView | null>
  /** The fallback for a route key {@link recorded} does not carry. */
  recordedDefault: OrcConnectionView | null
  /** The probe answer factory; replace to drive a failure. */
  answer: (route: Route) => OrcConnectionView
}

/**
 * Build the injectable remote port stand-in.
 *
 * @param overrides - replace the catalog, the recorded answers, or the probe answer.
 */
export function fakeRemote(overrides: {
  catalog?: CatalogSnapshot
  recorded?: OrcConnectionView | null
  /** Recorded results keyed by exact host route key. */
  recordedByKey?: Record<string, OrcConnectionView | null>
  answer?: (route: Route) => OrcConnectionView
} = {}): FakeRemote {
  const probes: Route[] = []
  const lookups: string[] = []
  let reads = 0
  const remote: FakeRemote = {
    catalog: overrides.catalog ?? fixtureCatalog(),
    recorded: new Map(Object.entries(overrides.recordedByKey ?? {})),
    recordedDefault: overrides.recorded ?? null,
    answer: overrides.answer ?? (route => greenConnection(route)),
    probes,
    lookups,
    catalogReads: () => reads,
    getCatalog: async () => {
      reads += 1
      return remote.catalog
    },
    probe: async (route) => {
      probes.push(route)
      return remote.answer(route)
    },
    getConnectionResult: async (routeKey) => {
      lookups.push(routeKey)
      return remote.recorded.has(routeKey) ? remote.recorded.get(routeKey) ?? null : remote.recordedDefault
    },
  }
  return remote
}

/** One `$mount` the client plugin asked the fake Remote service for. */
export interface FakeMount {
  readonly contribution: TypertRemoteContribution
  /** How many times this mount's disposer ran. */
  disposals: number
}

/** The fake `ctx.remote` service: a real `$mount` shape plus its recorded mounts. */
export interface FakeRemoteService {
  readonly mounts: FakeMount[]
  /** The ORC namespace a mounted contribution publishes. */
  orc?: OrcRemoteNamespace
  /** Make `$mount` refuse instead of publishing a namespace. */
  failNextMount(error: Error | undefined): void
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
}

/**
 * Build the fake Remote service the client plugin mounts through.
 *
 * `$mount` records the contribution it was handed and returns the disposer the
 * real gateway returns, so a test can prove both the exact contribution and the
 * unload path without a browser transport.
 */
export function fakeRemoteService(namespace?: OrcRemoteNamespace): FakeRemoteService {
  const mounts: FakeMount[] = []
  let failure: Error | undefined
  const service: FakeRemoteService = {
    mounts,
    failNextMount: (error) => {
      failure = error
    },
    $mount: async (contribution) => {
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      const record: FakeMount = { contribution, disposals: 0 }
      mounts.push(record)
      service.orc = namespace
      return async () => {
        record.disposals += 1
      }
    },
  }
  return service
}

/** A minimal `ctx.remote.orc` namespace over a fake port. */
export function fakeRemoteNamespace(port: OrcRemotePort): OrcRemoteNamespace {
  return {
    getCatalog: async signal => ({ ok: true, value: await port.getCatalog(signal ?? new AbortController().signal) }),
    probe: async (route, signal) => ({ ok: true, value: await port.probe(route, signal ?? new AbortController().signal) }),
    getConnectionResult: async routeKey => ({ ok: true, value: await port.getConnectionResult(routeKey) }),
  }
}

/** One recorded slot entry, as the registry stores it. */
export interface FakeSlotEntry {
  readonly key: string
  readonly id: string | undefined
  readonly order: number | undefined
  readonly label: (() => string) | undefined
  readonly locale: string | undefined
  readonly inject: (() => Record<string, unknown>) | undefined
  readonly component: unknown
}

/** The renderer slot registry stand-in. */
export interface FakeSlots {
  /** Registered list ids for one slot key, in registration order. */
  ids(key: string): string[]
  /** Resolved list labels for one slot key. */
  labels(key: string): Array<string | undefined>
  /** Recorded entries for one slot key. */
  entries(key: string): FakeSlotEntry[]
  /** Every slot key anything was registered into. */
  registered(): string[]
  /** Every slot key whose declaration was waited on. */
  injections(): string[]
  /** Collapse every injected registration, as plugin unload does. */
  disposeAll(): void
}

/** Build the slot registry stand-in. */
export function fakeSlots(): FakeSlots {
  const byKey = new Map<string, FakeSlotEntry[]>()
  const keys: string[] = []
  const injectionKeys: string[] = []
  const disposers: Array<() => void> = []

  return {
    ids: (key) => (byKey.get(key) ?? []).map(entry => entry.id ?? ''),
    labels: (key) => (byKey.get(key) ?? []).map(entry => entry.label?.()),
    entries: (key) => [...(byKey.get(key) ?? [])],
    registered: () => [...keys],
    injections: () => [...injectionKeys],
    disposeAll: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    ...{
      inject(key: string, callback: () => (() => void) | void): () => void {
        injectionKeys.push(key)
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => disposer?.()
      },
      register(options: {
        name: string
        id?: string
        order?: number
        label?: string | (() => string)
        locale?: string
        inject?: () => Record<string, unknown>
      }, component: unknown): () => void {
        const list = byKey.get(options.name) ?? []
        const entry: FakeSlotEntry = {
          key: options.name,
          id: options.id,
          order: options.order,
          label: typeof options.label === 'function' ? options.label : options.label === undefined ? undefined : () => options.label as string,
          locale: options.locale,
          inject: options.inject,
          component,
        }
        list.push(entry)
        byKey.set(options.name, list)
        if (!keys.includes(options.name)) keys.push(options.name)
        return () => {
          const current = byKey.get(options.name) ?? []
          const index = current.indexOf(entry)
          if (index >= 0) current.splice(index, 1)
        }
      },
    },
  }
}

/** One locale registration the plugin made. */
export interface FakeLocaleRegistration {
  readonly ns: string
  readonly dicts: Record<string, Record<string, string>>
}

/** The client context stand-in. */
export interface FakeClientContext extends Context {
  readonly slots: FakeSlots
  readonly locales: FakeLocaleRegistration[]
  readonly boundNamespaces: string[]
  /** Every service name an injected child fiber declared, in order. */
  readonly injections: string[]
  /** Run every installed effect in reverse, then collapse the slot registry. */
  dispose(): void
}

/**
 * Build a Cordis-shaped client context over the supplied slot registry.
 *
 * @param options - the slot registry to use, the resolved scope value, the
 * services the plugin declared in its Cordis `inject`, and an optional `remote`
 * service the plugin can mount its own contribution through.
 */
export function fakeClientContext(options: {
  slots: FakeSlots
  initial?: OrcConfig
  activeLocale?: string
  inject?: readonly string[]
  remote?: unknown
}): FakeClientContext {
  const effects: Array<() => void> = []
  const locales: FakeLocaleRegistration[] = []
  const boundNamespaces: string[] = []
  const injections: string[] = []
  const scopes = new Map<string, FakeScope>()
  let active = options.activeLocale ?? 'en'

  const translate = (ns: string, key: string, params?: Record<string, unknown>): string => {
    const dicts = locales.filter(registration => registration.ns === ns).at(-1)?.dicts
    const template = dicts?.[active]?.[key] ?? dicts?.en?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }

  const declared = new Set(options.inject ?? ['slots', 'locale', 'settingsScope'])
  const services: Record<string, unknown> = {
    slots: options.slots,
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => {
        const registration = { ns, dicts }
        locales.push(registration)
        return () => {
          const index = locales.indexOf(registration)
          if (index >= 0) locales.splice(index, 1)
        }
      },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => translate(ns, key, params),
      getSnapshot: () => ({ active, locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }], revision: 0 }),
      setLocale: (id: string) => {
        active = id
      },
    },
    settingsScope: {
      bind: (spec: { namespace: string }) => {
        boundNamespaces.push(spec.namespace)
        const existing = scopes.get(spec.namespace)
        if (existing !== undefined) return existing.scope
        const created = fakeScope(spec.namespace, options.initial ?? fixtureConfig())
        scopes.set(spec.namespace, created)
        return created.scope
      },
    },
    ...options.remote === undefined ? {} : { remote: options.remote },
  }

  // Only the declared services are seated, exactly as the Cordis fiber (and the
  // dynamic-package facade) gate them: an undeclared read is undefined here.
  // `remote` is deliberately *not* in `declared`: it is an optional dependency
  // the plugin takes through `ctx.inject(['remote'], …)`, so it is reachable
  // from the injected child context only.
  const seated = new Set([...declared, ...(options.remote === undefined ? [] : ['remote'])])
  const child = (deps: readonly string[]): Record<string, unknown> => ({
    get: (name: string) => (seated.has(name) ? services[name] : undefined),
    ...Object.fromEntries(Object.entries(services).filter(([name]) => seated.has(name) && deps.includes(name))),
  })
  const ctx = {
    effect: (execute: () => (() => void) | void) => {
      const disposer = execute()
      let live = true
      const dispose = (): void => {
        if (!live) return
        live = false
        disposer?.()
      }
      effects.push(dispose)
      return dispose
    },
    get: (name: string) => (seated.has(name) ? services[name] : undefined),
    inject: (deps: string | readonly string[], callback: (childCtx: unknown) => unknown) => {
      const names = typeof deps === 'string' ? [deps] : [...deps]
      injections.push(...names)
      const missing = names.filter(name => !seated.has(name))
      let dispose: (() => void) | undefined
      if (missing.length === 0) {
        const returned = callback(child(names))
        if (typeof returned === 'function') dispose = returned as () => void
      }
      const teardown = (): void => dispose?.()
      effects.push(teardown)
      return teardown
    },
    ...Object.fromEntries(Object.entries(services).filter(([name]) => declared.has(name))),
    dispose: () => {
      for (const dispose of [...effects].reverse()) dispose()
      effects.length = 0
      options.slots.disposeAll()
    },
    locales,
    boundNamespaces,
    injections,
  }
  return ctx as unknown as FakeClientContext
}
