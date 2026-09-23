/**
 * Browser tests for the ORC settings page.
 *
 * Every case drives the real page and the real client entry: `OrcSettingsPage`
 * renders against a fake settings scope and a fake remote port, and
 * `applyClient` registers through the real slot/locale/scope path so the
 * enable/disable lifecycle is exercised rather than described.
 *
 * The suite is jsdom-only. `vitest.config.ts` routes `tests/**\/*.spec.tsx`
 * to the jsdom project, so the host suite keeps its node environment.
 */

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcSettingsPage } from '../src/client/OrcSettingsPage.js'
import { apply, applyClient, inject } from '../src/client/index.js'
import { en, zh } from '../src/client/locales.js'
import {
  codexRoute,
  failedConnection,
  fakeClientContext,
  fakeRemote,
  fakeScope,
  fakeSlots,
  fixtureCatalog,
  fixtureConfig,
  greenConnection,
  providerRoute,
  scope,
  scopeWrites,
} from './fixtures/client.js'

afterEach(cleanup)

/** Every field the page must render, by its accessible label. */
const FIELD_LABELS = [
  'Session behavior',
  'Code route',
  'Analysis routing',
  'Spec route',
  'Plan route',
  'Review route',
  'Audit route',
  'Codex CLI path',
  'Claude Code path',
  'Maximum cost (USD)',
  'Catalog maximum age (days)',
]

describe('OrcSettingsPage', () => {
  it('renders every ORC field, the quota warning, and the CLI health status', async () => {
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={fakeRemote()} locale="en" />)

    for (const label of FIELD_LABELS) {
      expect(ui.getByLabelText(label)).toBeVisible()
    }
    expect(ui.getByRole('group', { name: 'Allowed backends' })).toBeVisible()
    expect(ui.getByText('This test may use provider quota or incur cost')).toBeVisible()

    await ui.findByText('Version 0.156.1')
    expect(ui.getByText('Version 2.1.280')).toBeVisible()
    expect(ui.getAllByText('Authenticated')).toHaveLength(2)
    expect(ui.getByText(/^Catalog observed /)).toBeVisible()
  })

  it('shows the quota warning before sending the harmless probe', async () => {
    const user = userEvent.setup()
    const remote = fakeRemote()
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    expect(ui.getByText('This test may use provider quota or incur cost')).toBeVisible()
    expect(remote.probes).toEqual([])

    await user.click(ui.getByRole('button', { name: 'Test code route connection' }))

    expect(remote.probes).toEqual([providerRoute])
    await ui.findByText('Connected')
    expect(ui.getByText(/rev-fixture/)).toBeVisible()
    expect(ui.getByText(/^Route provider:deepseek:deepseek-v4.1-flash:high$/)).toBeVisible()
    expect(ui.getByText(/^Tested /)).toBeVisible()
  })

  it('clears the green result and writes exactly one orc field when a route changes', async () => {
    const user = userEvent.setup()
    const remote = fakeRemote()
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    await user.click(ui.getByRole('button', { name: 'Test code route connection' }))
    await ui.findByText('Connected')

    await user.selectOptions(ui.getByLabelText('Review route'), 'codex:gpt-6-sol:high')

    expect(ui.queryByText('Connected')).toBeNull()
    expect(ui.getByText('Configuration changed; retest required')).toBeVisible()
    expect(scopeWrites()).toEqual([expect.objectContaining({ namespace: 'orc', field: 'manual' })])
    expect(scopeWrites()).toHaveLength(1)
  })

  it('clears a green result when the host config changes underneath the page', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    await user.click(ui.getByRole('button', { name: 'Test code route connection' }))
    await ui.findByText('Connected')

    act(() => {
      fake.push({ ...fixtureConfig(), maxCostUsd: 3 })
    })

    expect(ui.queryByText('Connected')).toBeNull()
    expect(ui.getByText('Configuration changed; retest required')).toBeVisible()
  })

  it('shows the recorded CLI authentication result from the remote face', async () => {
    const remote = fakeRemote({
      recorded: failedConnection(codexRoute, 'authentication', 'codex is not authenticated'),
    })
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    await ui.findByText('Version 0.156.1')
    expect(ui.getAllByText('Not authenticated')).toHaveLength(2)
  })

  it('displays the exact failure code and diagnostic a probe returned', async () => {
    const user = userEvent.setup()
    const remote = fakeRemote({
      answer: route => failedConnection(route, 'authentication', 'codex is not authenticated'),
    })
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    await user.click(ui.getByRole('button', { name: 'Test code route connection' }))

    await ui.findByText('Test failed: authentication')
    expect(ui.getByText('codex is not authenticated')).toBeVisible()
    expect(ui.queryByText('Connected')).toBeNull()
  })

  it('shows an explicit path field for an unavailable CLI', async () => {
    const catalog = fixtureCatalog()
    catalog.entries = catalog.entries.filter(entry => !entry.routeKey.startsWith('cli:codex:'))
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={fakeRemote({ catalog })} locale="en" />)

    await ui.findByText('Not found on PATH; set an explicit path below')
    expect(ui.getByLabelText('Codex CLI path')).toBeVisible()
  })

  it('reports the exact minimum version for a below-floor CLI', async () => {
    const catalog = fixtureCatalog()
    catalog.entries = catalog.entries.map(entry => {
      if (entry.routeKey.startsWith('cli:codex:')) return { ...entry, backendVersion: '0.150.0' }
      if (entry.routeKey.startsWith('cli:claude:')) return { ...entry, backendVersion: '2.1.279' }
      return entry
    })
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={fakeRemote({ catalog })} locale="en" />)

    await ui.findByText('Codex CLI 0.156.1 required')
    expect(ui.getByText('Claude Code 2.1.280 required')).toBeVisible()
  })

  it('disables save while the staged fields are invalid and commits them when valid', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)
    const save = ui.getByRole('button', { name: 'Save' })

    expect(save).toBeEnabled()

    await user.type(ui.getByLabelText('Maximum cost (USD)'), '-1')
    expect(save).toBeDisabled()
    expect(ui.getByText('Maximum cost must be a non-negative number')).toBeVisible()

    await user.clear(ui.getByLabelText('Maximum cost (USD)'))
    await user.type(ui.getByLabelText('Maximum cost (USD)'), '5')
    await user.clear(ui.getByLabelText('Catalog maximum age (days)'))
    expect(save).toBeDisabled()
    expect(ui.getByText('Catalog maximum age must be a positive number')).toBeVisible()

    await user.type(ui.getByLabelText('Catalog maximum age (days)'), '14')
    await user.type(ui.getByLabelText('Codex CLI path'), '/opt/codex')
    expect(save).toBeEnabled()

    await user.click(save)

    await ui.findByText('Saved')
    expect(fake.value().cliPaths.codex).toBe('/opt/codex')
    expect(fake.value().catalogMaxAgeDays).toBe(14)
    expect(fake.value().maxCostUsd).toBe(5)
    expect(fake.writes.map(write => write.field)).toEqual(['cliPaths', 'catalogMaxAgeDays', 'maxCostUsd'])
    expect(fake.writes.every(write => write.namespace === 'orc')).toBe(true)
  })

  it('clears a manual stage before removing its backend from the allowlist', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    // The Claude route is the review and audit assignment in the fixture config.
    await user.click(ui.getByLabelText('Claude Code claude-opus-4-1 high'))

    expect(fake.writes.map(write => write.field)).toEqual(['manual', 'allowed'])
    expect(fake.value().manual.review).toBeUndefined()
    expect(fake.value().manual.audit).toBeUndefined()
    expect(fake.value().allowed.map(route => JSON.stringify(route))).not.toContain(
      JSON.stringify({ kind: 'cli', cli: 'claude', model: 'claude-opus-4-1', effort: 'high' }),
    )
  })

  it('adds a backend to the allowlist without clearing any stage', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    fake.push({
      ...fixtureConfig(),
      allowed: [providerRoute],
      manual: { spec: undefined, plan: undefined, review: undefined, audit: undefined },
    })
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    await user.click(await ui.findByLabelText('Codex CLI gpt-6-sol high'))

    expect(fake.writes.map(write => write.field)).toEqual(['allowed'])
    expect(fake.value().allowed).toHaveLength(2)
  })

  it('never requests or renders provider tokens or native CLI credentials', async () => {
    const remote = fakeRemote()
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    await ui.findByText('Version 0.156.1')

    expect(ui.container.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(ui.container.textContent ?? '').not.toMatch(/token|secret|api[-_ ]?key|password|credential/i)
    expect(scopeWrites().every(write => write.namespace === 'orc')).toBe(true)
  })

  it('renders the Chinese dictionary when the active locale is zh', async () => {
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={fakeRemote()} locale="zh" />)

    expect(ui.getByLabelText('分析路由')).toBeVisible()
    expect(ui.getByLabelText('评审路由')).toBeVisible()
    expect(ui.queryByLabelText('Analysis routing')).toBeNull()
    await ui.findByText('版本 0.156.1')
  })

  it('reports an unavailable remote face instead of failing to render', () => {
    const ui = render(<OrcSettingsPage scope={scope('orc')} locale="en" />)

    expect(ui.getByText('The ORC remote face is unavailable in this profile')).toBeVisible()
    expect(ui.getByLabelText('Analysis routing')).toBeVisible()
  })

  it('reports the settings namespace state instead of rendering fields', () => {
    const states = [
      ['loading', 'Loading ORC settings…'],
      ['unavailable', 'ORC settings are unavailable in this profile'],
    ] as const

    for (const [status, text] of states) {
      const fake = fakeScope('orc')
      const pending = {
        status,
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host' as const,
      }
      const pendingScope = { ...fake.scope, getSnapshot: () => pending, subscribe: () => () => {} }
      const ui = render(<OrcSettingsPage scope={pendingScope} remote={fakeRemote()} locale="en" />)

      expect(ui.getByText(text)).toBeVisible()
      cleanup()
    }
  })
})

describe('ORC client entry', () => {
  it('declares exactly the client services it consumes', () => {
    expect([...inject].sort()).toEqual(['locale', 'settingsScope', 'slots'])
    expect(inject).not.toContain('remote')
  })

  it('cannot mount when its declared services are not seated', () => {
    const slots = fakeSlots()
    const ctx = fakeClientContext({ slots, inject: [] })

    expect(() => applyClient(ctx)).toThrow()
  })

  it('registers exactly the orc settings section while enabled and removes it on dispose', () => {
    const slots = fakeSlots()
    const ctx = fakeClientContext({ slots, inject: [...inject] })

    applyClient(ctx)

    expect(slots.ids('settings.section')).toEqual(['orc'])
    expect(slots.ids('models.section')).toEqual([])

    const [entry] = slots.entries('settings.section')
    expect(entry.order).toBe(30)
    expect(entry.locale).toBe('settings.orc')
    expect(entry.label?.()).toBe(en.title)
    expect(ctx.locales.map(registration => registration.ns)).toEqual(['settings.orc'])
    expect(Object.keys(ctx.locales[0].dicts).sort()).toEqual(['en', 'zh'])
    expect(ctx.boundNamespaces).toEqual(['orc'])

    ctx.dispose()

    expect(slots.ids('settings.section')).toEqual([])
    expect(slots.ids('models.section')).toEqual([])
  })

  it('registers English and Chinese nav labels and never touches Models Settings', () => {
    expect(en.title).not.toBe(zh.title)
    expect(en.title.length).toBeGreaterThan(0)
    expect(zh.title.length).toBeGreaterThan(0)

    const slots = fakeSlots()
    const ctx = fakeClientContext({ slots, inject: [...inject] })
    applyClient(ctx)

    expect(slots.registered()).toEqual(['settings.section'])
    expect(slots.injections()).toEqual(['settings.section'])
    expect(slots.labels('settings.section')).toEqual([en.title])
    expect(ctx.boundNamespaces).toEqual(['orc'])
  })

  it('mounts a working page through the registered inject face', async () => {
    const slots = fakeSlots()
    const remote = fakeRemote()
    const ctx = fakeClientContext({ slots, inject: [...inject] })

    applyClient(ctx, { remote })

    const [entry] = slots.entries('settings.section')
    const face = entry.inject?.() ?? {}
    const Component = entry.component as React.ComponentType<Record<string, unknown>>
    const ui = render(React.createElement(Component, face))

    expect(ui.getByLabelText('Analysis routing')).toBeVisible()
    await ui.findByText('Version 0.156.1')
    expect(ui.getByText('This test may use provider quota or incur cost')).toBeVisible()
  })

  it('exports the DSH client entry as both apply and applyClient', () => {
    expect(typeof apply).toBe('function')
    expect(applyClient).toBe(apply)
  })

  it('never binds a namespace other than orc', () => {
    const slots = fakeSlots()
    const ctx = fakeClientContext({ slots, inject: [...inject] })
    applyClient(ctx, { remote: fakeRemote() })

    expect(ctx.boundNamespaces).toEqual(['orc'])
    expect(ctx.locales.every(registration => registration.ns === 'settings.orc')).toBe(true)
    expect(slots.registered()).not.toContain('models.section')
    expect(slots.ids('models.section')).toEqual([])
    expect(fixtureConfig().allowed).toContain(codexRoute)
  })
})
