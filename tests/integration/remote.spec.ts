/**
 * Remote-face integration tests (brief Step 3a).
 *
 * What is proved here is everything the published DSH surface allows this
 * package to prove on its own:
 *
 * - `OrcRemoteHost` is a `TypertRemoteService` bound to the `orc` namespace;
 * - its three `@Remote` methods delegate to the injected `ctx.orc` service and
 *   return JSON-safe, credential-free values;
 * - the decorators recorded the wire contract on the class prototype, and the
 *   client contribution this bundle mounts by hand declares exactly that same
 *   three-endpoint contract, so the two halves cannot drift;
 * - the `orc-remote-host` Loader row and the `./remote-host` package export
 *   resolve, and the module default-exports the class a Loader row mounts.
 *
 * The generated `lib/typert.host.js` / `lib/typert.remote-client.js` artifacts
 * do not exist, and are not needed: the host face is served by the Gateway's
 * source-mode discovery over the `@Remote` markers, and the client face is the
 * hand-written contribution `src/client/remote.ts` mounts through the public
 * `ctx.remote.$mount(...)`. The published
 * `@deepseek-ai/dsh-typert-generator@0.1.6-alpha.2` binds generation to a
 * workspace root with host/client face aggregate tsconfigs and only registers
 * packages under `<root>/packages`, so it cannot emit artifacts for a single
 * external package; no `./typert` or `./remote` export is declared, because the
 * typert-loader fails loud on a declared but missing artifact.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ORC_REMOTE_CONTRIBUTION, ORC_REMOTE_NAMESPACE } from '../../src/client/remote.js'
import type { CatalogSnapshot } from '../../src/domain/types.js'
import type { OrcConnection, OrcService } from '../../src/host/service.js'
import { OrcRemoteHost } from '../../src/host/remote-host.js'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const patch = readFileSync('cordis.patch.yml', 'utf8')

const snapshot: CatalogSnapshot = {
  id: 'catalog-1',
  observedAt: '2026-09-23T00:00:00Z',
  entries: [{
    routeKey: 'provider:custom:m1:high',
    backendVersion: '',
    model: 'm1',
    efforts: ['high'],
    accountAccess: false,
    sourceUrl: '',
    retrievedAt: '2026-09-23T00:00:00Z',
  }],
}

const connection: OrcConnection = {
  routeKey: 'provider:custom:m1:high',
  revision: 'revision-1',
  testedAt: '2026-09-23T00:00:00Z',
  ok: true,
  code: '',
  diagnostic: '',
}

/** A minimal stand-in for the ORC service, recording what the face asked for. */
function fakeService(): { service: OrcService; calls: string[] } {
  const calls: string[] = []
  const service = {
    getCatalog: async (signal: AbortSignal) => {
      calls.push(`getCatalog:${String(signal.aborted)}`)
      return snapshot
    },
    probe: async (route: unknown, signal: AbortSignal) => {
      calls.push(`probe:${JSON.stringify(route)}:${String(signal.aborted)}`)
      return connection
    },
    getConnectionResult: (routeKey: string) => {
      calls.push(`getConnectionResult:${routeKey}`)
      return connection
    },
  } as unknown as OrcService
  return { service, calls }
}

describe('OrcRemoteHost', () => {
  it('binds the orc namespace as a Typert remote service', () => {
    const ctx = new Context()
    const { service } = fakeService()
    ctx.provide('orc', service)
    const host = new OrcRemoteHost(ctx)
    expect(host.typertRemote).toMatchObject({ serviceKey: 'orcRemoteHost', namespace: 'orc' })
    expect(ctx.get('orcRemoteHost')).toBeDefined()
  })

  it('delegates each Remote method to the ORC service', async () => {
    const ctx = new Context()
    const { service, calls } = fakeService()
    ctx.provide('orc', service)
    const host = new OrcRemoteHost(ctx)
    const signal = new AbortController().signal

    await expect(host.getCatalog(signal)).resolves.toEqual(snapshot)
    await expect(host.probe({ kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' }, signal))
      .resolves.toEqual(connection)
    await expect(host.getConnectionResult('provider:custom:m1:high')).resolves.toEqual(connection)
    expect(calls).toEqual([
      'getCatalog:false',
      'probe:{"kind":"provider","provider":"custom","model":"m1","effort":"high"}:false',
      'getConnectionResult:provider:custom:m1:high',
    ])
  })

  it('returns JSON-safe, credential-free results', async () => {
    const ctx = new Context()
    const { service } = fakeService()
    ctx.provide('orc', service)
    const host = new OrcRemoteHost(ctx)
    const catalog = await host.getCatalog(new AbortController().signal)
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey|api_key|token|password|credential/i)
  })

  it('records the Remote wire contract the Typert generator models', () => {
    const ctx = new Context()
    const { service } = fakeService()
    ctx.provide('orc', service)
    const host = new OrcRemoteHost(ctx)
    // `exportName` is omitted when the endpoint name equals the member name.
    expect(remoteMethods(host)).toEqual([
      { method: 'getCatalog', invocation: { kind: 'direct' } },
      { method: 'probe', invocation: { kind: 'direct' } },
      { method: 'getConnectionResult', invocation: { kind: 'direct' } },
    ])
  })

  it('declares a client contribution that matches the host markers endpoint for endpoint', () => {
    const ctx = new Context()
    const { service } = fakeService()
    ctx.provide('orc', service)
    const host = new OrcRemoteHost(ctx)
    const endpoints = remoteMethods(host).map(marker => `${ORC_REMOTE_NAMESPACE}/${marker.exportName ?? marker.method}`)
    const declared = ORC_REMOTE_CONTRIBUTION.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`)

    // The hand-written contribution is the client half of this exact host
    // contract: a renamed or added host endpoint must fail here.
    expect(declared).toEqual(endpoints)
    expect(ORC_REMOTE_CONTRIBUTION.package).toBe(pkg.name)
    // `getCatalog` and `probe` take the host's trailing cancellation parameter;
    // `getConnectionResult` is unary.
    expect(ORC_REMOTE_CONTRIBUTION.descriptors.map(descriptor => descriptor.cancellation !== undefined))
      .toEqual([true, true, false])
    // Every input codec is strict, which the client Gateway requires.
    for (const descriptor of ORC_REMOTE_CONTRIBUTION.descriptors) {
      for (const parameter of descriptor.parameters) expect(parameter.codec.mode).toBe('strict')
    }
  })

  it('is the module default export a Loader row mounts', async () => {
    const module = await import('../../src/host/remote-host.js')
    expect(module.default).toBe(module.OrcRemoteHost)
    expect(module.default.inject).toEqual(['orc'])
  })
})

describe('bundle wiring', () => {
  it('declares the remote-host export and its Loader row', () => {
    expect(pkg.exports['./remote-host']).toEqual({
      types: './lib/types/host/remote-host.d.ts',
      default: './lib/host/remote-host.js',
    })
    expect(patch).toContain('id: orc-remote-host')
    expect(patch).toContain("name: '@tonamson/dsh-orc/remote-host'")
    expect(patch).toContain('inject: [orc]')
    expect(patch).toContain('inject: [settings]')
  })

  it('declares no typert artifact it cannot generate', () => {
    // The typert-loader imports the `./typert` export of every mounted row and
    // fails loud when a declared artifact is broken, so a hand-written or
    // fabricated manifest would break the bundle instead of extending it.
    expect(pkg.exports['./typert']).toBeUndefined()
    expect(pkg.exports['./remote']).toBeUndefined()
  })

  it('pins the DSH packages this module imports at runtime', () => {
    expect(pkg.peerDependencies['@deepseek-ai/dsh-session']).toBe('0.1.6-alpha.2')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-tools']).toBe('0.1.6-alpha.2')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol']).toBe('0.1.6-alpha.2')
    expect(pkg.peerDependencies['zod']).toBe('^4.4.3')
  })
})
