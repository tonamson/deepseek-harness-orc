import { expect, it } from 'vitest'
import { ConfigSchema, connectionRevision, parseConfig, routeKey } from '../src/domain/config.js'

const provider = { kind: 'provider', provider: 'custom', model: 'm', effort: 'high' } as const
const codex = { kind: 'cli', cli: 'codex', model: 'gpt-5', effort: 'high' } as const

it('stores references and policy, never credentials', () => {
  expect(() => parseConfig({ providerApiKey: 'secret' })).toThrow(/unknown field/)
  const config = parseConfig({ sessionMode: 'adaptive', analysisMode: 'manual', allowed: [] })
  expect(JSON.stringify(config)).not.toMatch(/apiKey|token|password/i)
})
it('changes connection revision when an exact route changes', () => {
  const a = parseConfig({ allowed: [{ kind: 'provider', provider: 'custom', model: 'a', effort: 'high' }] })
  const b = parseConfig({ allowed: [{ kind: 'provider', provider: 'custom', model: 'b', effort: 'high' }] })
  expect(connectionRevision(a, a.allowed[0]!)).not.toBe(connectionRevision(b, b.allowed[0]!))
})

it('fills every policy field with a credential-free default', () => {
  expect(parseConfig({})).toEqual({
    sessionMode: 'adaptive',
    codeRoute: undefined,
    analysisMode: 'auto',
    manual: { spec: undefined, plan: undefined, review: undefined, audit: undefined },
    allowed: [],
    cliPaths: {},
    maxCostUsd: undefined,
    catalogMaxAgeDays: 7,
  })
})

it('keys a provider route and a CLI route by backend, model, and effort', () => {
  expect(routeKey(provider)).toBe('provider:custom:m:high')
  expect(routeKey(codex)).toBe('cli:codex:gpt-5:high')
})

it('accepts a Manual stage that is present in the allowlist', () => {
  const config = parseConfig({ analysisMode: 'manual', manual: { review: provider }, allowed: [provider] })
  expect(config.manual.review).toEqual(provider)
})

it('accepts a CLI route with a configured executable path', () => {
  const config = parseConfig({ allowed: [codex], cliPaths: { codex: '/opt/codex' } })
  expect(config.allowed[0]).toEqual(codex)
  expect(config.cliPaths.codex).toBe('/opt/codex')
})

it.each([
  ['an unknown top-level field', { providerToken: 'secret' }, /unknown field/],
  [
    'an unknown route field',
    { allowed: [{ kind: 'provider', provider: 'p', model: 'm', effort: 'e', apiKey: 'secret' }] },
    /unknown field/,
  ],
  ['an unknown route kind', { allowed: [{ kind: 'gemini', model: 'm', effort: 'e' }] }, /kind/],
  ['a duplicate allowed route', { allowed: [provider, provider] }, /duplicate/],
  ['a negative cost ceiling', { maxCostUsd: -1 }, /maxCostUsd/],
  ['a nonpositive catalog max age', { catalogMaxAgeDays: 0 }, /catalogMaxAgeDays/],
  [
    'a Manual stage outside the allowlist',
    { analysisMode: 'manual', manual: { audit: codex }, allowed: [provider] },
    /allowed/,
  ],
  ['an unknown CLI path key', { cliPaths: { gemini: '/opt/gemini' } }, /unknown field/],
])('rejects %s', (_name, input, message) => {
  expect(() => parseConfig(input)).toThrow(message)
})

it('changes the revision when the selected CLI path changes', () => {
  const a = parseConfig({ allowed: [codex], cliPaths: { codex: '/opt/codex' } })
  const b = parseConfig({ allowed: [codex], cliPaths: { codex: '/usr/local/bin/codex' } })
  expect(connectionRevision(a, codex)).not.toBe(connectionRevision(b, codex))
})

it('keeps the revision stable for an unchanged policy and route', () => {
  const a = parseConfig({ allowed: [provider], maxCostUsd: 5 })
  const b = parseConfig({ allowed: [provider], maxCostUsd: 5 })
  expect(connectionRevision(a, provider)).toBe(connectionRevision(b, provider))
})

it('keeps the DSH settings schema and the strict parser on the same defaults', () => {
  expect(parseConfig(ConfigSchema({}))).toEqual(ConfigSchema({}))
})
