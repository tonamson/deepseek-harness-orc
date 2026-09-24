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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcSettingsPage } from '../src/client/OrcSettingsPage.js'
import { apply, applyClient, inject } from '../src/client/index.js'
import { en, zh } from '../src/client/locales.js'
import { ORC_REMOTE_CONTRIBUTION, OrcRemoteUnavailableError } from '../src/client/remote.js'
import {
  codexRoute,
  failedConnection,
  fakeClientContext,
  fakeRemote,
  fakeRemoteNamespace,
  fakeRemoteService,
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
  'Route',
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
      recordedByKey: { 'cli:codex:gpt-6-sol:high': failedConnection(codexRoute, 'authentication', 'codex is not authenticated') },
    })
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={remote} locale="en" />)

    await ui.findByText('Version 0.156.1')
    // The page asked under the exact host route keys, so a lookup under the
    // wrong key could not have produced the recorded failure: only Codex is
    // unauthenticated, and Claude falls back to the catalog's own observation.
    expect(remote.lookups).toEqual(['cli:codex:gpt-6-sol:high', 'cli:claude:claude-opus-4-1:high'])
    expect(ui.getAllByText('Not authenticated')).toHaveLength(1)
    expect(ui.getAllByText('Authenticated')).toHaveLength(1)
  })

  it('reports the unavailable state, not a raw error, when no remote face is mounted', async () => {
    const port = {
      getCatalog: async () => {
        throw new OrcRemoteUnavailableError()
      },
      probe: async () => {
        throw new OrcRemoteUnavailableError()
      },
      getConnectionResult: async () => {
        throw new OrcRemoteUnavailableError()
      },
    }
    const ui = render(<OrcSettingsPage scope={scope('orc')} remote={port} locale="en" />)

    expect(await ui.findByText('The ORC remote face is unavailable in this profile')).toBeVisible()
  })

  it('allowlists a typed route without any catalog or discoverable backend', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    // A fresh install: an empty policy and a catalog that discovers nothing.
    fake.push({
      sessionMode: 'adaptive',
      codeRoute: undefined,
      analysisMode: 'auto',
      manual: { spec: undefined, plan: undefined, review: undefined, audit: undefined },
      allowed: [],
      cliPaths: {},
      catalogMaxAgeDays: 7,
    })
    const empty = { id: 'catalog-empty', observedAt: '2026-09-23T00:00:00Z', entries: [] }
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote({ catalog: empty })} locale="en" />)

    await ui.findByText('No backend is discoverable yet; type a route above to allowlist one.')
    expect(ui.queryAllByRole('checkbox')).toHaveLength(0)

    const entry = ui.getByLabelText('Route')
    await user.type(entry, 'provider:bai:deepseek-v4.1-flash:high')
    await user.click(ui.getByRole('button', { name: 'Allowlist route' }))

    expect(fake.writes.map(write => write.field)).toEqual(['allowed'])
    expect(fake.value().allowed).toEqual([
      { kind: 'provider', provider: 'bai', model: 'deepseek-v4.1-flash', effort: 'high' },
    ])
    expect(ui.getByText('Allowlisted bai deepseek-v4.1-flash high')).toBeVisible()
    // The newly allowed route is now a candidate everywhere else on the page.
    expect(ui.getByRole('checkbox', { name: 'bai deepseek-v4.1-flash high' })).toBeChecked()

    // A malformed token is refused before it can reach the host.
    await user.type(entry, 'not-a-route')
    await user.click(ui.getByRole('button', { name: 'Allowlist route' }))
    expect(ui.getByText('A route reads provider:<provider>:<model>:<effort> or codex|claude:<model>:<effort>')).toBeVisible()
    expect(fake.writes).toHaveLength(1)

    // An empty segment is malformed too: the host refuses it, so the page must
    // refuse it before claiming the route was allowlisted.
    for (const malformed of ['provider:::high', 'codex::high']) {
      await user.clear(entry)
      await user.type(entry, malformed)
      await user.click(ui.getByRole('button', { name: 'Allowlist route' }))
      expect(ui.getByText('A route reads provider:<provider>:<model>:<effort> or codex|claude:<model>:<effort>')).toBeVisible()
    }
    expect(fake.writes).toHaveLength(1)

    // An already allowed route is refused too, so the allowlist cannot repeat.
    await user.clear(entry)
    await user.type(entry, 'provider:bai:deepseek-v4.1-flash:high')
    await user.click(ui.getByRole('button', { name: 'Allowlist route' }))
    expect(ui.getByText('That route is already on the allowlist')).toBeVisible()
    expect(fake.writes).toHaveLength(1)
  })

  it('reports a refused write instead of claiming the route was allowlisted', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    fake.failNextWrite(new Error('settings write refused: unknown route'))
    await user.type(ui.getByLabelText('Route'), 'provider:bai:deepseek-v4.1-flash:high')
    await user.click(ui.getByRole('button', { name: 'Allowlist route' }))

    expect(await ui.findByText('The host refused the change: settings write refused: unknown route')).toBeVisible()
    expect(ui.queryByText('Allowlisted bai deepseek-v4.1-flash high')).toBeNull()
    expect(fake.writes).toEqual([])
    expect(fake.value().allowed).toEqual(fixtureConfig().allowed)
  })

  it('reports a refused save instead of showing Saved', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    await user.type(ui.getByLabelText('Codex CLI path'), '/opt/codex')
    await user.click(ui.getByRole('button', { name: 'Save' }))
    await ui.findByText('Saved')

    fake.failNextWrite(new Error('settings write refused: read-only document'))
    await user.type(ui.getByLabelText('Codex CLI path'), '-2')
    await user.click(ui.getByRole('button', { name: 'Save' }))

    expect(await ui.findByText('The host refused the change: settings write refused: read-only document')).toBeVisible()
    expect(ui.queryByText('Saved')).toBeNull()
    expect(fake.writes.map(write => write.field)).toEqual(['cliPaths', 'catalogMaxAgeDays'])
  })

  it('reports a refused control write on the page', async () => {
    const user = userEvent.setup()
    const fake = fakeScope('orc')
    const ui = render(<OrcSettingsPage scope={fake.scope} remote={fakeRemote()} locale="en" />)

    fake.failNextWrite(new Error('settings write refused: manual.review'))
    await user.selectOptions(ui.getByLabelText('Review route'), 'codex:gpt-6-sol:high')

    expect(await ui.findByText('The host refused the change: settings write refused: manual.review')).toBeVisible()
    expect(fake.writes).toEqual([])
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
    // `remote` is deliberately absent: it is an optional dependency taken
    // through `ctx.inject`, so a profile without the Remote client still mounts
    // the settings page.
    expect([...inject].sort()).toEqual(['locale', 'settingsScope', 'slots'])
    expect(inject).not.toContain('remote')
  })

  it('mounts its own Remote contribution through ctx.remote.$mount and disposes it on unload', async () => {
    const slots = fakeSlots()
    const service = fakeRemoteService(fakeRemoteNamespace(fakeRemote()))
    const ctx = fakeClientContext({ slots, inject: [...inject], remote: service })

    applyClient(ctx)

    // The mount goes through the public API with the exact contribution this
    // package owns: three ORC endpoints and nothing else.
    expect(ctx.injections).toEqual(['remote'])
    await vi.waitFor(() => expect(service.mounts).toHaveLength(1))
    const [mount] = service.mounts
    expect(mount.contribution).toBe(ORC_REMOTE_CONTRIBUTION)
    expect(mount.contribution.package).toBe('@tonamson/dsh-orc')
    expect(mount.contribution.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`))
      .toEqual(['orc/getCatalog', 'orc/probe', 'orc/getConnectionResult'])
    expect(mount.disposals).toBe(0)

    ctx.dispose()

    await vi.waitFor(() => expect(mount.disposals).toBe(1))
    expect(slots.ids('settings.section')).toEqual([])
  })

  it('keeps the settings page mounted when the profile has no Remote service', async () => {
    const slots = fakeSlots()
    const ctx = fakeClientContext({ slots, inject: [...inject] })

    applyClient(ctx)

    expect(ctx.injections).toEqual(['remote'])
    expect(slots.ids('settings.section')).toEqual(['orc'])

    // The page's port reports the missing face instead of hanging.
    const [entry] = slots.entries('settings.section')
    const face = entry.inject?.() ?? {}
    const Component = entry.component as React.ComponentType<Record<string, unknown>>
    const ui = render(React.createElement(Component, face))
    expect(await ui.findByText('The ORC remote face is unavailable in this profile')).toBeVisible()
    expect(ui.getByLabelText('Route')).toBeVisible()
  })

  it('serves the page from the mounted contribution, not a stand-in', async () => {
    const slots = fakeSlots()
    const port = fakeRemote()
    const service = fakeRemoteService(fakeRemoteNamespace(port))
    const ctx = fakeClientContext({ slots, inject: [...inject], remote: service })

    applyClient(ctx)
    await vi.waitFor(() => expect(service.mounts).toHaveLength(1))

    const [entry] = slots.entries('settings.section')
    const face = entry.inject?.() ?? {}
    const Component = entry.component as React.ComponentType<Record<string, unknown>>
    const ui = render(React.createElement(Component, face))

    await ui.findByText('Version 0.156.1')
    expect(port.catalogReads()).toBe(1)
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
