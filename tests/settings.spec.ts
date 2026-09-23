import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ConfigSchema, configRevision, parseConfig } from '../src/domain/config.js'
import { installOrcSettings } from '../src/host/settings.js'

const provider = { kind: 'provider', provider: 'custom', model: 'm', effort: 'high' } as const

interface SettingsHooks {
  setSource: (current: () => unknown) => void
  onChange: () => void
  validate?: (value: unknown) => void
}

interface InstallCall {
  owner: unknown
  ns: string
  schema: unknown
  entry: unknown
  hooks: SettingsHooks
}

interface FakeContext extends Context {
  calls: InstallCall[]
  effectLabels: string[]
  disposeEffects: () => void
}

/** Minimal Context stand-in: a settings provider, a Cordis effect scope, and a call log. */
function fakeContext(
  overrides: { installSection?: (owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: SettingsHooks) => void } = {},
): FakeContext {
  const calls: InstallCall[] = []
  const effectLabels: string[] = []
  const effects: Array<() => void> = []
  const ctx = {
    settings: {
      installSection: overrides.installSection ?? ((owner, ns, schema, entry, hooks) => {
        calls.push({ owner, ns, schema, entry, hooks })
      }),
    },
    effect: (execute: () => (() => void) | void, label?: string) => {
      effectLabels.push(label ?? '')
      const disposer = execute()
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        disposer?.()
      }
      effects.push(dispose)
      return dispose
    },
    calls,
    effectLabels,
    disposeEffects: () => {
      for (const dispose of [...effects].reverse()) dispose()
    },
  }
  return ctx as unknown as FakeContext
}

it('installs exactly one orc section and never another namespace', () => {
  const sections: string[] = []
  installOrcSettings(fakeContext({ installSection: (_owner, ns) => sections.push(ns) }), parseConfig({ allowed: [] }))
  expect(sections).toEqual(['orc'])
  expect(sections).not.toContain('models')
})

it('hands the owner context, schema, base entry, and hooks to installSection', () => {
  const ctx = fakeContext()
  const base = parseConfig({ allowed: [provider] })
  const dispose = installOrcSettings(ctx, base)
  expect(ctx.calls).toHaveLength(1)
  const call = ctx.calls[0]!
  expect(call.owner).toBe(ctx)
  expect(call.ns).toBe('orc')
  expect(call.schema).toBe(ConfigSchema)
  expect(call.entry).toBe(base)
  expect(typeof call.hooks.setSource).toBe('function')
  expect(typeof call.hooks.onChange).toBe('function')
  expect(typeof call.hooks.validate).toBe('function')
  expect(typeof dispose).toBe('function')
})

it('registers a schema with no credential field', () => {
  const ctx = fakeContext()
  installOrcSettings(ctx, parseConfig({ allowed: [] }))
  const serialized = JSON.stringify((ctx.calls[0]!.schema as { toJSON(): unknown }).toJSON())
  expect(serialized).not.toMatch(/apiKey|token|password|secret/i)
})

it('reads the settings source and emits a new revision only when it changes', () => {
  const ctx = fakeContext()
  const installed = installOrcSettings(ctx, parseConfig({ allowed: [provider] }))
  const seen: string[] = []
  installed.bridge.subscribe(revision => seen.push(revision))
  const before = installed.bridge.connectionRevision(provider)

  const next = parseConfig({ allowed: [provider], maxCostUsd: 3 })
  ctx.calls[0]!.hooks.setSource(() => next)
  ctx.calls[0]!.hooks.onChange()
  expect(installed.bridge.config()).toBe(next)
  expect(installed.bridge.connectionRevision(provider)).not.toBe(before)
  expect(seen).toEqual([configRevision(next)])

  ctx.calls[0]!.hooks.onChange()
  expect(seen).toEqual([configRevision(next)])
})

it('rejects a resolved section a schema-valid but disallowed Manual stage produced', () => {
  const ctx = fakeContext()
  installOrcSettings(ctx, parseConfig({ allowed: [provider] }))
  const validate = ctx.calls[0]!.hooks.validate!
  const stored = ConfigSchema({ analysisMode: 'manual', manual: { audit: provider }, allowed: [] })
  expect(() => validate(stored)).toThrow(/config\.allowed/)
  expect(() => validate(ConfigSchema({ allowed: [provider] }))).not.toThrow()
})

it('rejects a stored section that smuggles in a credential field', () => {
  const ctx = fakeContext()
  installOrcSettings(ctx, parseConfig({ allowed: [] }))
  const validate = ctx.calls[0]!.hooks.validate!
  expect(() => validate(ConfigSchema({ providerApiKey: 'secret' }))).toThrow(/unknown field/)
})

it('registers its teardown as a Cordis effect and disposes the bridge on unload', () => {
  const ctx = fakeContext()
  const installed = installOrcSettings(ctx, parseConfig({ allowed: [provider] }))
  expect(ctx.effectLabels).toEqual(['orc.settings'])
  const seen: string[] = []
  installed.bridge.subscribe(revision => seen.push(revision))
  ctx.disposeEffects()
  installed.bridge.subscribe(revision => seen.push(revision))
  ctx.calls[0]!.hooks.setSource(() => parseConfig({ allowed: [provider], maxCostUsd: 9 }))
  ctx.calls[0]!.hooks.onChange()
  expect(seen).toEqual([])
})

it('returns a disposer that runs the same teardown', () => {
  const ctx = fakeContext()
  const installed = installOrcSettings(ctx, parseConfig({ allowed: [provider] }))
  const seen: string[] = []
  installed.bridge.subscribe(revision => seen.push(revision))
  installed()
  ctx.calls[0]!.hooks.setSource(() => parseConfig({ allowed: [provider], maxCostUsd: 9 }))
  ctx.calls[0]!.hooks.onChange()
  expect(seen).toEqual([])
})
