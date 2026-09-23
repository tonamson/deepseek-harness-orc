/**
 * ORC wire contracts.
 *
 * This module is the single source of truth for the domain shapes every later
 * task consumes: the ORC host service, the provider and CLI adapters, route
 * selection, and the browser settings page all import these names instead of
 * declaring their own copies.
 *
 * The contracts deliberately hold references and policy only. Provider
 * credentials stay owned by DSH, and no shape here has a field for a secret.
 */

/** A workflow stage. `code` is implementation; the rest are analysis stages. */
export type Stage = 'code' | 'spec' | 'plan' | 'review' | 'audit'

/** The analysis stages that accept a per-stage Manual route. */
export type AnalysisStage = Exclude<Stage, 'code'>

/** A model route exposed by DSH's configured providers. */
export interface ProviderRoute {
  kind: 'provider'
  /** Configured DSH provider name; the credential itself stays with DSH. */
  provider: string
  model: string
  /** Reasoning effort resolved for the subtask, never pinned in ORC source. */
  effort: string
}

/** The host CLI backends ORC can drive. */
export type CliName = 'codex' | 'claude'

/** A subscription route driven through a host CLI executable. */
export interface CliRoute {
  kind: 'cli'
  cli: CliName
  model: string
  effort: string
}

/** One exact backend/model/effort reference. */
export type Route = ProviderRoute | CliRoute

/** Per-session ORC activation policy. */
export type SessionMode = 'adaptive' | 'always'

/** How analysis stages are assigned routes. */
export type AnalysisMode = 'manual' | 'auto'

/** The ORC-owned settings namespace value. */
export interface OrcConfig {
  sessionMode: SessionMode
  /** Code implementation route; analysis stages use `manual`/Auto instead. */
  codeRoute?: Route
  analysisMode: AnalysisMode
  /** One route per analysis stage in Manual mode; `undefined` means unassigned. */
  manual: Record<AnalysisStage, Route | undefined>
  /** The Supervisor's allowlist: routes it may select, and no others. */
  allowed: Route[]
  /** Explicit executable paths for CLIs not discoverable on `PATH`. */
  cliPaths: Partial<Record<CliName, string>>
  /** Optional user cost ceiling; a ceiling may exclude routes, never lower a floor. */
  maxCostUsd?: number
  /** Maximum age of catalog/benchmark evidence before Auto must revalidate it. */
  catalogMaxAgeDays: number
}

/** One live catalog observation for an exact route. */
export interface CatalogEntry {
  /** Exact {@link Route} key this observation describes. */
  routeKey: string
  /** Version of the installed backend the observation was taken against. */
  backendVersion: string
  model: string
  /** Effort values the account and backend actually accept for this model. */
  efforts: string[]
  /** Whether the configured account can use this exact route right now. */
  accountAccess: boolean
  /** Official capability/pricing source the claim came from. */
  sourceUrl: string
  /** When that source was retrieved. */
  retrievedAt: string
}

/** A versioned observation of what the account and installed backends can use. */
export interface CatalogSnapshot {
  /** Stable identity recorded with every route decision made from it. */
  id: string
  observedAt: string
  entries: CatalogEntry[]
}
