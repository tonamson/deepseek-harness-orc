import { expect, it } from 'vitest'
import { ProviderAdapter } from '../src/host/provider.js'
import { fakeLlm } from './fixtures/provider.js'

const route = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' } as const
it('tests the exact route with a harmless request', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const result = await new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal)
  expect(result).toMatchObject({ routeKey: 'provider:custom:m1:high', configRevision: 'rev-1', ok: true })
  expect(llm.calls[0]).toMatchObject({ provider: 'custom', model: 'm1', reasoningEffort: 'high' })
  expect(llm.calls[0].messages[0].content).toContainEqual({ type: 'text', text: 'Reply with OK only.' })
})
it('refuses a green result from a previous revision', async () => {
  const adapter = new ProviderAdapter(fakeLlm({ output: 'OK' }))
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  await expect(adapter.run(route, 'review', 'rev-2', green, new AbortController().signal)).rejects.toThrow(/stale/)
})
it.each([
  ['unknown-model', 'model-unavailable'],
  ['wrong-provider', 'route-mismatch'],
  ['auth', 'authentication'],
  ['network', 'network'],
  ['quota', 'quota'],
  ['empty', 'empty-result'],
] as const)('%s fails closed', async (failure, code) => {
  const llm = fakeLlm({ failure })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code })
  expect(llm.calls.every(call => call.provider === 'custom')).toBe(true)
})

it('maps a degenerate empty response to empty-result', async () => {
  const llm = fakeLlm({ failure: 'empty-response' })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code: 'empty-result' })
})
it('checks the live catalog before the request and again before dispatch', async () => {
  const llm = fakeLlm({ output: 'OK' })
  await new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal)
  expect(llm.reads).toEqual({ providers: 2, models: 2 })
})

it('stamps a failing test with an ISO instant', async () => {
  const result = await new ProviderAdapter(fakeLlm({ failure: 'quota' }))
    .test(route, 'rev-1', new AbortController().signal)
  expect(result.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})
it('refuses a green result bound to another route', async () => {
  const adapter = new ProviderAdapter(fakeLlm({ output: 'OK' }))
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  const other = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'low' } as const
  await expect(adapter.run(other, 'review', 'rev-1', green, new AbortController().signal)).rejects.toThrow(/stale/)
})
it('refuses to dispatch on a failed connection test', async () => {
  const llm = fakeLlm({ failure: 'auth' })
  const adapter = new ProviderAdapter(llm)
  const failed = await adapter.test(route, 'rev-1', new AbortController().signal)
  expect(failed).toMatchObject({ ok: false, code: 'authentication' })
  const dispatched = llm.calls.length
  await expect(adapter.run(route, 'review', 'rev-1', failed, new AbortController().signal))
    .rejects.toThrow(/connection test failed/)
  expect(llm.calls.length).toBe(dispatched)
})
it('keeps a thrown dispatch after a green test a task failure', async () => {
  const llm = fakeLlm({ output: 'OK', delivery: 'throw' })
  const adapter = new ProviderAdapter(llm)
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  expect(green.ok).toBe(true)
  llm.fail('auth')
  await expect(adapter.run(route, 'review', 'rev-1', green, new AbortController().signal))
    .rejects.toThrow(/authentication/)
  expect(llm.calls.every(call => call.provider === 'custom')).toBe(true)
})
it('returns only the accepted final text of a green run', async () => {
  const llm = fakeLlm({ output: 'the reviewed answer' })
  const adapter = new ProviderAdapter(llm)
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  await expect(adapter.run(route, 'review this', 'rev-1', green, new AbortController().signal))
    .resolves.toBe('the reviewed answer')
  expect(llm.calls[1].messages[0].content).toContainEqual({ type: 'text', text: 'review this' })
})
it('sends only the route reference and surfaces no credential', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const result = await new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal)
  expect(Object.keys(llm.calls[0]).sort()).toEqual(['messages', 'model', 'provider', 'reasoningEffort', 'signal'])
  expect(JSON.stringify(result)).not.toMatch(/apiKey|token|secret|password/i)
})
it('catalogs the exact advertised routes without credentials', async () => {
  const snapshot = await new ProviderAdapter(fakeLlm()).catalog('custom')
  expect(snapshot.entries).toEqual([{
    routeKey: 'provider:custom:m1:high',
    backendVersion: '',
    model: 'm1',
    efforts: ['high'],
    accountAccess: true,
    sourceUrl: '',
    retrievedAt: snapshot.observedAt,
  }])
  expect(snapshot.id).toBe(`custom@${snapshot.observedAt}`)
})
it('catalogs nothing for a provider DSH does not register', async () => {
  const snapshot = await new ProviderAdapter(fakeLlm()).catalog('other')
  expect(snapshot.entries).toEqual([])
})
