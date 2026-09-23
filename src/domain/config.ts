/**
 * ORC settings validation.
 *
 * `parseConfig` is the strict entry point for an untrusted settings document:
 * it rejects unknown fields, duplicate allowlist entries, invalid policy
 * bounds, and a Manual stage that is not on the allowlist. `ConfigSchema` is
 * the same contract expressed as a schemastery schema for DSH's settings
 * provider, which layers defaults, the composition base, and the user section.
 * Cross-field rules the schema cannot express live in {@link assertConfigRules},
 * which both paths share.
 *
 * Nothing here reads, hashes, or stores provider credentials: the config holds
 * route references and ORC policy only.
 */

import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { AnalysisStage, CliName, OrcConfig, Route } from './types.js'

/** Catalog evidence older than this default must be revalidated before Auto uses it. */
const DEFAULT_CATALOG_MAX_AGE_DAYS = 7

const ANALYSIS_STAGES: readonly AnalysisStage[] = ['spec', 'plan', 'review', 'audit']
const CLI_NAMES: readonly CliName[] = ['codex', 'claude']
const SESSION_MODES = ['adaptive', 'always'] as const
const ANALYSIS_MODES = ['manual', 'auto'] as const

const TOP_LEVEL_FIELDS = new Set([
  'sessionMode',
  'codeRoute',
  'analysisMode',
  'manual',
  'allowed',
  'cliPaths',
  'maxCostUsd',
  'catalogMaxAgeDays',
])
const PROVIDER_FIELDS = new Set(['kind', 'provider', 'model', 'effort'])
const CLI_FIELDS = new Set(['kind', 'cli', 'model', 'effort'])

/** The exact identity a route is selected and logged by. */
export const routeKey = (r: Route): string => r.kind === 'provider'
  ? `provider:${r.provider}:${r.model}:${r.effort}`
  : `cli:${r.cli}:${r.model}:${r.effort}`

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reject a non-object and every field outside the declared shape. */
function objectField(value: unknown, path: string, fields: ReadonlySet<string>): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`)
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new TypeError(`${path} has unknown field "${key}"`)
  }
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new TypeError(`${path} must be one of: ${allowed.join(', ')}`)
}

function parseRoute(value: unknown, path: string): Route {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`)
  if (value.kind === 'provider') {
    objectField(value, path, PROVIDER_FIELDS)
    return {
      kind: 'provider',
      provider: nonEmptyString(value.provider, `${path}.provider`),
      model: nonEmptyString(value.model, `${path}.model`),
      effort: nonEmptyString(value.effort, `${path}.effort`),
    }
  }
  if (value.kind === 'cli') {
    objectField(value, path, CLI_FIELDS)
    return {
      kind: 'cli',
      cli: enumValue(value.cli, `${path}.cli`, CLI_NAMES),
      model: nonEmptyString(value.model, `${path}.model`),
      effort: nonEmptyString(value.effort, `${path}.effort`),
    }
  }
  throw new TypeError(`${path}.kind must be "provider" or "cli"`)
}

function parseManual(value: unknown): Record<AnalysisStage, Route | undefined> {
  const manual: Record<AnalysisStage, Route | undefined> = {
    spec: undefined,
    plan: undefined,
    review: undefined,
    audit: undefined,
  }
  if (value === undefined) return manual
  const raw = objectField(value, 'config.manual', new Set(ANALYSIS_STAGES))
  for (const stage of ANALYSIS_STAGES) {
    if (raw[stage] !== undefined) manual[stage] = parseRoute(raw[stage], `config.manual.${stage}`)
  }
  return manual
}

function parseAllowed(value: unknown): Route[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('config.allowed must be an array')
  const allowed: Route[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const route = parseRoute(entry, `config.allowed[${index}]`)
    const key = routeKey(route)
    if (seen.has(key)) throw new TypeError(`config.allowed has duplicate route "${key}"`)
    seen.add(key)
    allowed.push(route)
  })
  return allowed
}

function parseCliPaths(value: unknown): Partial<Record<CliName, string>> {
  const paths: Partial<Record<CliName, string>> = {}
  if (value === undefined) return paths
  const raw = objectField(value, 'config.cliPaths', new Set(CLI_NAMES))
  for (const cli of CLI_NAMES) {
    if (raw[cli] !== undefined) paths[cli] = nonEmptyString(raw[cli], `config.cliPaths.${cli}`)
  }
  return paths
}

function parseCostCeiling(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('config.maxCostUsd must be a non-negative cost ceiling')
  }
  return value
}

function parseCatalogMaxAge(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('config.catalogMaxAgeDays must be a positive number of days')
  }
  return value
}

/**
 * Reject a resolved config this bridge could not act on. Shared by
 * {@link parseConfig} and the settings provider's `validate` hook, which is the
 * only place a stored section can be judged once it bypasses strict parsing.
 */
export function assertConfigRules(config: OrcConfig): void {
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_FIELDS.has(key)) throw new TypeError(`config has unknown field "${key}"`)
  }
  if (config.maxCostUsd !== undefined && !(Number.isFinite(config.maxCostUsd) && config.maxCostUsd >= 0)) {
    throw new TypeError('config.maxCostUsd must be a non-negative cost ceiling')
  }
  if (!(Number.isFinite(config.catalogMaxAgeDays) && config.catalogMaxAgeDays > 0)) {
    throw new TypeError('config.catalogMaxAgeDays must be a positive number of days')
  }
  for (const cli of Object.keys(config.cliPaths)) {
    if (!(CLI_NAMES as readonly string[]).includes(cli)) {
      throw new TypeError(`config.cliPaths has unknown field "${cli}"`)
    }
  }
  const allowedKeys = new Set(config.allowed.map(routeKey))
  if (allowedKeys.size !== config.allowed.length) {
    throw new TypeError('config.allowed must not repeat a route')
  }
  for (const stage of ANALYSIS_STAGES) {
    const route = config.manual[stage]
    if (route !== undefined && !allowedKeys.has(routeKey(route))) {
      throw new TypeError(`config.manual.${stage} is not present in config.allowed`)
    }
  }
}

/** Parse one untrusted settings document into a validated {@link OrcConfig}. */
export function parseConfig(input: unknown): OrcConfig {
  const raw = objectField(input, 'config', TOP_LEVEL_FIELDS)
  const config: OrcConfig = {
    sessionMode: raw.sessionMode === undefined
      ? 'adaptive'
      : enumValue(raw.sessionMode, 'config.sessionMode', SESSION_MODES),
    codeRoute: raw.codeRoute === undefined ? undefined : parseRoute(raw.codeRoute, 'config.codeRoute'),
    analysisMode: raw.analysisMode === undefined
      ? 'auto'
      : enumValue(raw.analysisMode, 'config.analysisMode', ANALYSIS_MODES),
    manual: parseManual(raw.manual),
    allowed: parseAllowed(raw.allowed),
    cliPaths: parseCliPaths(raw.cliPaths),
    maxCostUsd: raw.maxCostUsd === undefined ? undefined : parseCostCeiling(raw.maxCostUsd),
    catalogMaxAgeDays: raw.catalogMaxAgeDays === undefined
      ? DEFAULT_CATALOG_MAX_AGE_DAYS
      : parseCatalogMaxAge(raw.catalogMaxAgeDays),
  }
  assertConfigRules(config)
  return config
}

/** Fixed-order projection of one route, so equal routes always hash equally. */
function canonicalRoute(route: Route): Record<string, string> {
  return route.kind === 'provider'
    ? { kind: route.kind, provider: route.provider, model: route.model, effort: route.effort }
    : { kind: route.kind, cli: route.cli, model: route.model, effort: route.effort }
}

/** Fixed-order projection of the whole policy, for a stable config revision. */
function canonicalConfig(config: OrcConfig): Record<string, unknown> {
  return {
    sessionMode: config.sessionMode,
    codeRoute: config.codeRoute === undefined ? null : canonicalRoute(config.codeRoute),
    analysisMode: config.analysisMode,
    manual: Object.fromEntries(
      ANALYSIS_STAGES.map(stage => [stage, config.manual[stage] === undefined ? null : canonicalRoute(config.manual[stage])]),
    ),
    allowed: config.allowed.map(canonicalRoute),
    cliPaths: {
      codex: config.cliPaths.codex ?? null,
      claude: config.cliPaths.claude ?? null,
    },
    maxCostUsd: config.maxCostUsd ?? null,
    catalogMaxAgeDays: config.catalogMaxAgeDays,
  }
}

/**
 * Revision of the whole policy. Any relevant configuration change advances it,
 * which is what invalidates a previously green connection test.
 */
export const configRevision = (config: OrcConfig): string =>
  createHash('sha256').update(JSON.stringify(canonicalConfig(config))).digest('hex')

/**
 * Revision of one exact connection: the route, the executable path a CLI route
 * resolves to, and the config revision they were read from. A green result is
 * tied to this value and refused once it moves.
 */
export const connectionRevision = (config: OrcConfig, route: Route): string =>
  createHash('sha256').update(JSON.stringify({
    configRevision: configRevision(config),
    route: canonicalRoute(route),
    path: route.kind === 'cli' ? config.cliPaths[route.cli] ?? null : null,
  })).digest('hex')

const RouteSchema = z.union([
  z.object({
    kind: z.const('provider'),
    provider: z.string().required(),
    model: z.string().required(),
    effort: z.string().required(),
  }),
  z.object({
    kind: z.const('cli'),
    cli: z.union([z.const('codex'), z.const('claude')]),
    model: z.string().required(),
    effort: z.string().required(),
  }),
])

/**
 * The ORC namespace schema DSH renders and resolves. It carries no secret
 * field: provider credentials remain owned by DSH.
 */
export const ConfigSchema = z.object({
  sessionMode: z.union([z.const('adaptive'), z.const('always')]).default('adaptive'),
  codeRoute: RouteSchema,
  analysisMode: z.union([z.const('manual'), z.const('auto')]).default('auto'),
  manual: z.object({
    spec: RouteSchema,
    plan: RouteSchema,
    review: RouteSchema,
    audit: RouteSchema,
  }).default({}),
  allowed: z.array(RouteSchema).default([]),
  cliPaths: z.dict(z.string()).default({}),
  maxCostUsd: z.number().min(0),
  catalogMaxAgeDays: z.natural().min(1).default(DEFAULT_CATALOG_MAX_AGE_DAYS),
})
