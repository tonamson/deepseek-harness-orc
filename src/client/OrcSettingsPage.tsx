/**
 * The ORC settings page.
 *
 * This is the bundle's only user-facing surface. It reads and writes exactly
 * one settings namespace (`orc`) through the injected `SettingsScope`, and it
 * never touches DSH Models Settings, a standard preset, or another plugin's
 * namespace. It holds route *references* and ORC policy only: no field, no
 * request, and no rendered string carries a provider token or a native CLI
 * credential, because DSH owns both.
 *
 * The remote face arrives as an injected port ({@link OrcRemotePort}) rather
 * than being resolved from `ctx.remote` here. That keeps the page correct and
 * testable in a clean Web profile, where the DSH-owned client assembly mounts
 * only its own fixed `/remote` import list and therefore exposes no
 * `ctx.remote.orc`; a future DSH client mount path supplies the real face
 * through {@link OrcSettingsPageProps.remote}.
 *
 * Connection-test binding: a green result is stored with the exact config
 * identity ({@link configIdentity}) it was tested against, so any relevant
 * configuration change — including one made outside this page — makes the
 * result stale and the page stops showing `Connected`. The host's own
 * revision fence still governs dispatch; a green test is never a guarantee of
 * future availability.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { AnalysisStage, CatalogEntry, CatalogSnapshot, CliName, OrcConfig, Route } from '../domain/types.js'
import { dictionary, translate, type OrcLocaleKey } from './locales.js'

/** The analysis stages Manual mode assigns one route each. */
export const ANALYSIS_STAGES: readonly AnalysisStage[] = ['spec', 'plan', 'review', 'audit']

/** The host CLI backends ORC can drive. */
export const CLI_NAMES: readonly CliName[] = ['codex', 'claude']

/** Product names as the official CLIs name themselves. */
export const CLI_PRODUCT: Readonly<Record<CliName, string>> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
}

/**
 * The minimum released version ORC accepts for each host CLI.
 *
 * Mirrors the host adapter's floors (`src/host/cli.ts`) so the page can refuse
 * and explain a below-floor executable from the catalog observation alone; the
 * host remains the enforcement authority.
 */
export const MINIMUM_CLI_VERSION: Readonly<Record<CliName, string>> = {
  codex: '0.156.1',
  claude: '2.1.280',
}

/** One credential-free connection result, exactly as the Remote face returns it. */
export interface OrcConnectionView {
  readonly routeKey: string
  readonly revision: string
  readonly testedAt: string
  readonly ok: boolean
  readonly code: string
  readonly diagnostic: string
}

/**
 * The remote face the page consumes.
 *
 * Structurally a subset of the host's `orc` Remote service, so a mount path
 * that supplies the real face satisfies it without any adapter.
 */
export interface OrcRemotePort {
  /** Read the live catalog of routes the account and installed backends can use. */
  getCatalog(signal: AbortSignal): Promise<CatalogSnapshot>
  /** Verify one exact route now and record the result. */
  probe(route: Route, signal: AbortSignal): Promise<OrcConnectionView>
  /** Read the recorded result for one exact host route key, or `null`. */
  getConnectionResult(routeKey: string): Promise<OrcConnectionView | null>
}

/** Props the page receives from the slot framework and its inject face. */
export interface OrcSettingsPageProps {
  /** The bound `orc` settings scope; the only write path. */
  scope: SettingsScope<OrcConfig>
  /** The ORC remote face, absent in profiles that cannot mount one. */
  remote?: OrcRemotePort
  /** Active locale id, used when the framework `t` seat is not installed. */
  locale?: string
  /** Framework-synthesized translate seat for the `settings.orc` namespace. */
  t?: Translate<OrcLocaleKey>
  /** Shell affordance that closes the settings panel. */
  close?: () => void
}

/** The page's staged free-text fields; closed-choice controls write immediately. */
interface Draft {
  readonly codex: string
  readonly claude: string
  readonly maxCost: string
  readonly age: string
}

/** One connection test result bound to the config identity it tested. */
interface TestedResult {
  readonly connection: OrcConnectionView
  readonly identity: string
}

/**
 * The page's route token.
 *
 * Deliberately identical in shape to the host's `routeKey` for provider routes
 * and one `cli:`-shorter for CLI routes, so a CLI option value reads
 * `codex:gpt-6-sol:high`. The host helper lives in a module that imports
 * `node:crypto`, so the browser cannot import it; the format is mirrored here
 * and the host key is reconstructed by {@link hostRouteKey}.
 */
export const routeToken = (route: Route): string => route.kind === 'provider'
  ? `provider:${route.provider}:${route.model}:${route.effort}`
  : `${route.cli}:${route.model}:${route.effort}`

/** The exact host `routeKey` a route is recorded under. */
export const hostRouteKey = (route: Route): string => route.kind === 'provider'
  ? routeToken(route)
  : `cli:${routeToken(route)}`

/** Parse one {@link routeToken} back into a route, or `undefined` when malformed. */
export function parseRouteToken(token: string): Route | undefined {
  const parts = token.split(':')
  if (parts[0] === 'provider' && parts.length === 4) {
    return { kind: 'provider', provider: parts[1], model: parts[2], effort: parts[3] }
  }
  if ((parts[0] === 'codex' || parts[0] === 'claude') && parts.length === 3) {
    return { kind: 'cli', cli: parts[0], model: parts[1], effort: parts[2] }
  }
  return undefined
}

/**
 * A stable content identity for the whole ORC policy.
 *
 * The client-side analogue of the host's `configRevision` (which hashes with
 * `node:crypto` and cannot ship to the browser): fixed field order, so equal
 * policy always yields an equal string and any relevant change yields a
 * different one. A green connection test is bound to this value.
 */
export function configIdentity(config: OrcConfig): string {
  return JSON.stringify([
    config.sessionMode,
    config.codeRoute === undefined ? null : routeToken(config.codeRoute),
    config.analysisMode,
    ANALYSIS_STAGES.map(stage => {
      const route = config.manual[stage]
      return route === undefined ? null : routeToken(route)
    }),
    config.allowed.map(routeToken),
    config.cliPaths.codex ?? null,
    config.cliPaths.claude ?? null,
    config.maxCostUsd ?? null,
    config.catalogMaxAgeDays,
  ])
}

/** The display label of one route: backend, model, effort. */
const routeLabel = (route: Route): string => route.kind === 'provider'
  ? `${route.provider} ${route.model} ${route.effort}`
  : `${CLI_PRODUCT[route.cli]} ${route.model} ${route.effort}`

/** Reconstruct candidate routes from the catalog's route keys, model, and efforts. */
function catalogRoutes(entries: readonly CatalogEntry[]): Route[] {
  const routes: Route[] = []
  for (const entry of entries) {
    const cli: CliName | undefined = entry.routeKey.startsWith('cli:codex:')
      ? 'codex'
      : entry.routeKey.startsWith('cli:claude:')
        ? 'claude'
        : undefined
    const provider = entry.routeKey.startsWith('provider:') ? entry.routeKey.split(':')[1] : undefined
    for (const effort of entry.efforts) {
      if (cli !== undefined) routes.push({ kind: 'cli', cli, model: entry.model, effort })
      else if (provider !== undefined && provider.length > 0) routes.push({ kind: 'provider', provider, model: entry.model, effort })
    }
  }
  return routes
}

/** Every route the page may offer: the policy's own routes plus the live catalog. */
function candidateRoutes(config: OrcConfig, catalog: CatalogSnapshot | undefined): Route[] {
  const routes: Route[] = [...config.allowed]
  if (config.codeRoute !== undefined) routes.push(config.codeRoute)
  for (const stage of ANALYSIS_STAGES) {
    const route = config.manual[stage]
    if (route !== undefined) routes.push(route)
  }
  if (catalog !== undefined) routes.push(...catalogRoutes(catalog.entries))
  const seen = new Set<string>()
  return routes.filter(route => {
    const token = routeToken(route)
    if (seen.has(token)) return false
    seen.add(token)
    return true
  })
}

/** Whether one observed version is below a floor, by numeric components. */
function belowFloor(version: string, floor: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const actual = parse(version)
  const minimum = parse(floor)
  if (actual === undefined || minimum === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] < minimum[index]
  }
  return false
}

/** The catalog observation for one exact route. */
const entryFor = (catalog: CatalogSnapshot | undefined, route: Route): CatalogEntry | undefined =>
  catalog?.entries.find(entry => entry.routeKey === hostRouteKey(route))

/** The catalog observation for one host CLI. */
const cliEntry = (catalog: CatalogSnapshot | undefined, cli: CliName): CatalogEntry | undefined =>
  catalog?.entries.find(entry => entry.routeKey.startsWith(`cli:${cli}:`))

/** Humanize how long ago one catalog observation was taken. */
function ageText(observedAt: string, t: Translate<OrcLocaleKey>): string {
  const observed = Date.parse(observedAt)
  if (!Number.isFinite(observed)) return t('catalogNotLoaded')
  const minutes = Math.max(0, Math.round((Date.now() - observed) / 60_000))
  if (minutes < 1) return t('ageNow')
  if (minutes < 60) return t('ageMinutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('ageHours', { n: hours })
  return t('ageDays', { n: Math.round(hours / 24) })
}

/** The staged fields derived from a resolved config. */
const draftOf = (config: OrcConfig): Draft => ({
  codex: config.cliPaths.codex ?? '',
  claude: config.cliPaths.claude ?? '',
  maxCost: config.maxCostUsd === undefined ? '' : String(config.maxCostUsd),
  age: String(config.catalogMaxAgeDays),
})

/** The first validation problem in the staged fields, or `undefined`. */
function draftProblem(draft: Draft): OrcLocaleKey | undefined {
  const cost = draft.maxCost.trim()
  if (cost !== '' && !(Number.isFinite(Number(cost)) && Number(cost) >= 0)) return 'invalidCost'
  const age = draft.age.trim()
  if (!(Number.isFinite(Number(age)) && Number(age) > 0)) return 'invalidAge'
  return undefined
}

/**
 * Render the ORC settings page.
 *
 * @param props - the injected scope, remote port, locale, and framework seats.
 */
export function OrcSettingsPage(props: OrcSettingsPageProps): ReactElement {
  const { scope, remote, t: injected, locale } = props
  const t = useMemo<Translate<OrcLocaleKey>>(
    () => injected ?? ((key, params) => translate(dictionary(locale ?? 'en'), key, params)),
    [injected, locale],
  )
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const config = snapshot.value

  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [catalog, setCatalog] = useState<CatalogSnapshot | undefined>(undefined)
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined)
  const [auth, setAuth] = useState<Partial<Record<CliName, OrcConnectionView | null>>>({})
  const [tested, setTested] = useState<TestedResult | undefined>(undefined)
  const [probeError, setProbeError] = useState<string | undefined>(undefined)
  const [probing, setProbing] = useState(false)
  const probeController = useRef<AbortController | undefined>(undefined)

  useEffect(() => () => probeController.current?.abort(), [])

  useEffect(() => {
    if (remote === undefined) return
    let live = true
    const controller = new AbortController()
    const initial = scope.getSnapshot().value
    void (async () => {
      const liveCatalog = await remote.getCatalog(controller.signal)
      if (!live) return
      setCatalog(liveCatalog)
      if (initial === undefined) return
      const routes = candidateRoutes(initial, undefined)
      const recorded: Partial<Record<CliName, OrcConnectionView | null>> = {}
      for (const cli of CLI_NAMES) {
        const route = routes.find(candidate => candidate.kind === 'cli' && candidate.cli === cli)
        if (route === undefined) continue
        recorded[cli] = await remote.getConnectionResult(hostRouteKey(route))
      }
      if (live) setAuth(recorded)
    })().catch((error: unknown) => {
      if (live) setCatalogError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [remote, scope])

  if (config === undefined) {
    return (
      <section aria-label={t('title')}>
        <p>{snapshot.status === 'unavailable' ? t('settingsUnavailable') : t('loading')}</p>
      </section>
    )
  }

  const staged = draft ?? draftOf(config)
  const problem = draftProblem(staged)
  const identity = configIdentity(config)
  const green = tested !== undefined && tested.identity === identity ? tested.connection : undefined
  const stale = tested !== undefined && green === undefined
  const candidates = candidateRoutes(config, catalog)
  const allowedTokens = new Set(config.allowed.map(routeToken))
  const testedEntry = config.codeRoute === undefined ? undefined : entryFor(catalog, config.codeRoute)

  const stage = (next: Partial<Draft>): void => {
    setDraft({ ...staged, ...next })
    setSaved(false)
  }

  const writeStage = (stageName: AnalysisStage, token: string): void => {
    const route = token === '' ? undefined : parseRouteToken(token)
    void scope.set('manual', { ...config.manual, [stageName]: route })
  }

  /**
   * Add or remove one route from the Supervisor's allowlist.
   *
   * Removing a route a Manual stage still uses would leave the document in a
   * state the host rejects (`manual.<stage>` must be on the allowlist), so the
   * stage assignment is cleared FIRST and the allowlist entry second: every
   * intermediate document the provider validates is valid on its own. The
   * scope preserves write order, so the sequence is deterministic.
   */
  const writeAllowed = (route: Route, enabled: boolean): void => {
    if (enabled) {
      void scope.set('allowed', [...config.allowed, route])
      return
    }
    const token = routeToken(route)
    const nextManual = { ...config.manual }
    let cleared = false
    for (const stageName of ANALYSIS_STAGES) {
      const assigned = nextManual[stageName]
      if (assigned !== undefined && routeToken(assigned) === token) {
        nextManual[stageName] = undefined
        cleared = true
      }
    }
    if (cleared) void scope.set('manual', nextManual)
    void scope.set('allowed', config.allowed.filter(entry => routeToken(entry) !== token))
  }

  const onProbe = async (): Promise<void> => {
    if (remote === undefined || config.codeRoute === undefined) return
    const route = config.codeRoute
    setProbing(true)
    setProbeError(undefined)
    const controller = new AbortController()
    probeController.current = controller
    try {
      const connection = await remote.probe(route, controller.signal)
      setTested({ connection, identity: configIdentity(config) })
    } catch (error: unknown) {
      setProbeError(error instanceof Error ? error.message : String(error))
    } finally {
      setProbing(false)
    }
  }

  const onSave = async (): Promise<void> => {
    const cliPaths: OrcConfig['cliPaths'] = { ...config.cliPaths }
    if (staged.codex.trim() === '') delete cliPaths.codex
    else cliPaths.codex = staged.codex.trim()
    if (staged.claude.trim() === '') delete cliPaths.claude
    else cliPaths.claude = staged.claude.trim()
    await scope.set('cliPaths', cliPaths)
    await scope.set('catalogMaxAgeDays', Number(staged.age.trim()))
    if (staged.maxCost.trim() === '') {
      if (config.maxCostUsd !== undefined) await scope.unset('maxCostUsd')
    } else {
      await scope.set('maxCostUsd', Number(staged.maxCost.trim()))
    }
    setDraft(undefined)
    setSaved(true)
  }

  const cliStatus = (cli: CliName): OrcLocaleKey => {
    const entry = cliEntry(catalog, cli)
    if (catalog === undefined) return 'catalogNotLoaded'
    if (entry === undefined) return 'cliNotFound'
    if (entry.backendVersion !== '' && belowFloor(entry.backendVersion, MINIMUM_CLI_VERSION[cli])) return 'cliRequired'
    if (entry.backendVersion !== '') return 'cliVersion'
    return 'cliVersionUnknown'
  }

  const cliAuth = (cli: CliName): OrcLocaleKey => {
    const recorded = auth[cli]
    if (recorded !== undefined && recorded !== null) {
      if (recorded.ok) return 'cliAuthOk'
      return recorded.code === 'authentication' ? 'cliAuthFailed' : 'cliAuthUnknown'
    }
    const entry = cliEntry(catalog, cli)
    if (entry === undefined) return 'cliAuthUnknown'
    return entry.accountAccess ? 'cliAuthOk' : 'cliAuthFailed'
  }

  return (
    <section aria-label={t('title')}>
      <h2>{t('title')}</h2>

      <p>
        <label htmlFor="orc-session-mode">{t('sessionBehavior')}</label>
        <select
          id="orc-session-mode"
          value={config.sessionMode}
          onChange={event => {
            void scope.set('sessionMode', event.target.value)
            setSaved(false)
          }}
        >
          <option value="adaptive">{t('sessionAdaptive')}</option>
          <option value="always">{t('sessionAlways')}</option>
        </select>
      </p>

      <p>
        <label htmlFor="orc-code-route">{t('codeRoute')}</label>
        <select
          id="orc-code-route"
          value={config.codeRoute === undefined ? '' : routeToken(config.codeRoute)}
          onChange={event => {
            const route = parseRouteToken(event.target.value)
            if (route === undefined) void scope.unset('codeRoute')
            else void scope.set('codeRoute', route)
            setSaved(false)
          }}
        >
          <option value="">{t('codeRouteNone')}</option>
          {candidates.map(route => (
            <option key={routeToken(route)} value={routeToken(route)}>{routeLabel(route)}</option>
          ))}
        </select>
      </p>

      <p>
        <label htmlFor="orc-analysis-mode">{t('analysisRouting')}</label>
        <select
          id="orc-analysis-mode"
          value={config.analysisMode}
          onChange={event => {
            void scope.set('analysisMode', event.target.value)
            setSaved(false)
          }}
        >
          <option value="manual">{t('analysisManual')}</option>
          <option value="auto">{t('analysisAuto')}</option>
        </select>
      </p>

      <p>
        <label htmlFor="orc-route-spec">{t('specRoute')}</label>
        <select
          id="orc-route-spec"
          value={config.manual.spec === undefined ? '' : routeToken(config.manual.spec)}
          onChange={event => writeStage('spec', event.target.value)}
        >
          <option value="">{t('unassigned')}</option>
          {config.allowed.map(route => (
            <option key={routeToken(route)} value={routeToken(route)}>{routeLabel(route)}</option>
          ))}
        </select>
      </p>

      <p>
        <label htmlFor="orc-route-plan">{t('planRoute')}</label>
        <select
          id="orc-route-plan"
          value={config.manual.plan === undefined ? '' : routeToken(config.manual.plan)}
          onChange={event => writeStage('plan', event.target.value)}
        >
          <option value="">{t('unassigned')}</option>
          {config.allowed.map(route => (
            <option key={routeToken(route)} value={routeToken(route)}>{routeLabel(route)}</option>
          ))}
        </select>
      </p>

      <p>
        <label htmlFor="orc-route-review">{t('reviewRoute')}</label>
        <select
          id="orc-route-review"
          value={config.manual.review === undefined ? '' : routeToken(config.manual.review)}
          onChange={event => writeStage('review', event.target.value)}
        >
          <option value="">{t('unassigned')}</option>
          {config.allowed.map(route => (
            <option key={routeToken(route)} value={routeToken(route)}>{routeLabel(route)}</option>
          ))}
        </select>
      </p>

      <p>
        <label htmlFor="orc-route-audit">{t('auditRoute')}</label>
        <select
          id="orc-route-audit"
          value={config.manual.audit === undefined ? '' : routeToken(config.manual.audit)}
          onChange={event => writeStage('audit', event.target.value)}
        >
          <option value="">{t('unassigned')}</option>
          {config.allowed.map(route => (
            <option key={routeToken(route)} value={routeToken(route)}>{routeLabel(route)}</option>
          ))}
        </select>
      </p>

      <fieldset>
        <legend>{t('allowedBackends')}</legend>
        {candidates.length === 0 ? <p>{t('allowedBackendsEmpty')}</p> : null}
        {candidates.map(route => {
          const token = routeToken(route)
          return (
            <label key={token} htmlFor={`orc-allowed-${token}`}>
              <input
                id={`orc-allowed-${token}`}
                type="checkbox"
                checked={allowedTokens.has(token)}
                onChange={event => writeAllowed(route, event.target.checked)}
              />
              {routeLabel(route)}
            </label>
          )
        })}
      </fieldset>

      <fieldset>
        <legend>{t('cliHealth')}</legend>
        <ul>
          {CLI_NAMES.map(cli => (
            <li key={cli}>
              <span>{CLI_PRODUCT[cli]}</span>
              {': '}
              <span>
                {cliStatus(cli) === 'cliRequired'
                  ? t('cliRequired', { product: CLI_PRODUCT[cli], version: MINIMUM_CLI_VERSION[cli] })
                  : t(cliStatus(cli), { version: cliEntry(catalog, cli)?.backendVersion ?? '' })}
              </span>
              {' — '}
              <span>{t(cliAuth(cli))}</span>
            </li>
          ))}
        </ul>
        {CLI_NAMES.map(cli => (
          <p key={cli}>
            <label htmlFor={`orc-cli-path-${cli}`}>{t('cliPath', { product: CLI_PRODUCT[cli] })}</label>
            <input
              id={`orc-cli-path-${cli}`}
              type="text"
              value={cli === 'codex' ? staged.codex : staged.claude}
              onChange={event => stage(cli === 'codex' ? { codex: event.target.value } : { claude: event.target.value })}
            />
          </p>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('policy')}</legend>
        <p>
          <label htmlFor="orc-max-cost">{t('maxCost')}</label>
          <input
            id="orc-max-cost"
            type="number"
            min="0"
            value={staged.maxCost}
            onChange={event => stage({ maxCost: event.target.value })}
          />
          <span>{t('maxCostHint')}</span>
        </p>
        <p>
          <label htmlFor="orc-catalog-age">{t('catalogAge')}</label>
          <input
            id="orc-catalog-age"
            type="number"
            min="1"
            value={staged.age}
            onChange={event => stage({ age: event.target.value })}
          />
        </p>
        <p>
          <span>
            {catalog === undefined
              ? t('catalogNotLoaded')
              : t('catalogObserved', { age: ageText(catalog.observedAt, t) })}
          </span>
        </p>
      </fieldset>

      <fieldset>
        <legend>{t('connection')}</legend>
        <p>{t('probeWarning')}</p>
        <button
          type="button"
          disabled={remote === undefined || config.codeRoute === undefined || probing}
          onClick={() => {
            void onProbe()
          }}
        >
          {t('probeCodeRoute')}
        </button>
        {remote === undefined ? <p>{t('unavailable')}</p> : null}
        {remote !== undefined && config.codeRoute === undefined ? <p>{t('noCodeRoute')}</p> : null}
        {green === undefined ? null : green.ok ? <strong>{t('connected')}</strong> : <span>{`${t('testFailed')}: ${green.code}`}</span>}
        {green === undefined ? null : green.diagnostic === '' ? null : <span>{green.diagnostic}</span>}
        {green === undefined ? null : (
          <ul>
            <li><span>{t('route', { route: green.routeKey })}</span></li>
            <li><span>{t('revision', { revision: green.revision })}</span></li>
            {testedEntry === undefined || testedEntry.backendVersion === ''
              ? null
              : <li><span>{t('version', { version: testedEntry.backendVersion })}</span></li>}
            <li><span>{t('testedAt', { time: green.testedAt })}</span></li>
          </ul>
        )}
        {stale ? <p>{t('stale')}</p> : null}
        {tested === undefined ? <p>{t('notTested')}</p> : null}
        {probeError === undefined ? null : <p>{probeError}</p>}
        {catalogError === undefined ? null : <p>{catalogError}</p>}
      </fieldset>

      <p>
        <button type="button" disabled={problem !== undefined} onClick={() => { void onSave() }}>
          {t('save')}
        </button>
        <span>{t('saveHint')}</span>
        {problem === undefined ? null : <span>{t(problem)}</span>}
        {saved ? <span>{t('saved')}</span> : null}
      </p>
    </section>
  )
}

export default OrcSettingsPage
