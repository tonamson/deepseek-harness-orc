import { expect, it } from 'vitest'
import { ProviderAdapter, ProviderError } from '../src/host/provider.js'
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
it('checks the live catalog and the advertised effort before the request and again before dispatch', async () => {
  const llm = fakeLlm({ output: 'OK' })
  await new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal)
  expect(llm.reads).toEqual({ providers: 2, models: 2, resolves: 2 })
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

// Important 1: a raw adapter discovery failure must never escape `run`.
it('sanitizes a catalog lookup failure during a connection test', async () => {
  const llm = fakeLlm({ failure: 'discovery' })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code: 'network' })
})
it('sanitizes a raw catalog lookup failure during dispatch instead of leaking it from run', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const adapter = new ProviderAdapter(llm)
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  expect(green.ok).toBe(true)
  // The adapter's own discovery now throws a raw transport error, as DSH's
  // listModels does when the provider adapter fails without normalization.
  llm.fail('discovery')
  const failure: unknown = await adapter.run(route, 'review', 'rev-1', green, new AbortController().signal)
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(ProviderError)
  expect(failure).toMatchObject({ code: 'network', message: 'provider request failed: network' })
  expect((failure as Error).message).not.toMatch(/fake provider discovery failed/)
})

// Important 2: only a normal stop finish is an accepted result.
it.each(['max-tokens', 'tool-calls'] as const)(
  'rejects a %s finish instead of accepting partial text',
  async (finishReason) => {
    const llm = fakeLlm({ output: 'partial review', finishReason })
    await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'empty-result' })
  },
)
it('rejects a stream that ends without any terminal finish', async () => {
  const llm = fakeLlm({ output: 'partial review', finishReason: 'none' })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code: 'empty-result' })
})
it('never returns partial text when a green route truncates during the run', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const adapter = new ProviderAdapter(llm)
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  llm.setFinishReason('max-tokens')
  await expect(adapter.run(route, 'review', 'rev-1', green, new AbortController().signal))
    .rejects.toThrow(/empty-result/)
})

// Important 3: catalog membership is not account-access evidence.
it('records account access as unverified because catalog membership is advisory', async () => {
  const adapter = new ProviderAdapter(fakeLlm())
  const snapshot = await adapter.catalog('custom')
  expect(snapshot.entries).toEqual([{
    routeKey: 'provider:custom:m1:high',
    backendVersion: '',
    model: 'm1',
    efforts: ['high'],
    accountAccess: false,
    sourceUrl: '',
    retrievedAt: snapshot.observedAt,
  }])
  expect(snapshot.id).toBe(`custom@${snapshot.observedAt}`)
  // The only verified access evidence is a green connection test bound to the
  // exact catalog route key; Task 7 must gate Auto eligibility on it.
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  expect(green).toMatchObject({ ok: true, routeKey: snapshot.entries[0].routeKey })
})
it('catalogs nothing for a provider DSH does not register', async () => {
  const snapshot = await new ProviderAdapter(fakeLlm()).catalog('other')
  expect(snapshot.entries).toEqual([])
})

// Important 4: the route check checks the effort, not just provider and model.
it('rejects an unadvertised effort before the request with model-unavailable', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const low = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'low' } as const
  await expect(new ProviderAdapter(llm).test(low, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code: 'model-unavailable' })
  expect(llm.calls).toEqual([])
})
it('rejects a route whose effort stops being advertised before dispatch', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const adapter = new ProviderAdapter(llm)
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  expect(green.ok).toBe(true)
  const dispatched = llm.calls.length
  // Flip the advertised efforts only after the pre-request check resolved, so
  // the rejection can only come from the pre-dispatch check.
  llm.afterResolve = () => {
    llm.afterResolve = undefined
    llm.setEfforts(['low'])
  }
  await expect(adapter.run(route, 'review', 'rev-1', green, new AbortController().signal))
    .rejects.toMatchObject({ code: 'model-unavailable' })
  expect(llm.calls.length).toBe(dispatched)
})
it('classifies an effort DSH rejects at dispatch as model-unavailable', async () => {
  const llm = fakeLlm({ failure: 'effort-rejected' })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code: 'model-unavailable' })
})
