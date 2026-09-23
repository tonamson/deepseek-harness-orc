/**
 * ORC provider adapter.
 *
 * The bridge from an ORC {@link ProviderRoute} to a provider/model the user
 * configured in DSH Models Settings. Dispatch goes through the DSH LLM service
 * only: ORC stores route references and policy, never credentials, and this
 * module reads none — DSH owns authentication.
 *
 * Two rules shape the code:
 *
 * - A green connection test is bound to the exact route and config revision it
 *   tested. {@link ProviderAdapter.run} refuses a result whose `routeKey` or
 *   `configRevision` no longer matches, so any relevant configuration change
 *   invalidates it.
 * - A successful test is advisory. A later authentication, network, quota, or
 *   empty response failure stays a task failure: the adapter never falls back
 *   to another provider, model, or backend.
 * - Only a completed review is a result. A response that does not end in a
 *   normal stop — truncated, tool-calling, errored, aborted, or unterminated —
 *   is never returned as accepted text.
 */

import {
  ReasoningEffortId,
  createUserMessage,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { routeKey } from '../domain/config.js'
import type { CatalogEntry, CatalogSnapshot, ProviderRoute } from '../domain/types.js'

/**
 * The exact harmless prompt a connection test sends. The settings UI warns
 * that this request may consume provider quota or incur cost.
 */
const CONNECTION_TEST_PROMPT = 'Reply with OK only.'

/**
 * Failure codes safe to surface. Each is a fixed ORC-owned string: no token, no
 * provider payload, and no raw diagnostic ever reaches the caller.
 */
export type ProviderErrorCode =
  | 'model-unavailable'
  | 'route-mismatch'
  | 'authentication'
  | 'network'
  | 'quota'
  | 'empty-result'

/** A credential-free provider failure carrying only an ORC-safe code. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode

  constructor(code: ProviderErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/**
 * One connection-test outcome, bound to the exact route key and config
 * revision that were tested. A failing test resolves to this shape rather than
 * rejecting, so the settings surface can render it.
 */
export type ConnectionResult =
  | {
    readonly routeKey: string
    readonly configRevision: string
    readonly testedAt: string
    readonly ok: true
  }
  | {
    readonly routeKey: string
    readonly configRevision: string
    readonly testedAt: string
    readonly ok: false
    readonly code: ProviderErrorCode
  }

/**
 * The DSH LLM surface this adapter consumes. `ctx.llm` (`LlmRuntime`) satisfies
 * it structurally; tests supply a fake.
 */
export interface ProviderLlmPort {
  /** Provider routes DSH currently has an adapter registered for. */
  listProviders(): LlmProviderInfo[]
  /** Models one registered provider advertises; membership is advisory. */
  listModels(provider: string): Promise<LlmModelInfo[]>
  /** Exact-route metadata, including the effort values the adapter accepts. */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  /** Stream one fully-assembled model request. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Map a DSH provider-neutral failure code to one of the six ORC-safe codes.
 *
 * The DSH vocabulary is wider than ORC's, so the closest bucket wins:
 * credential and authorization codes are `authentication`, quota and
 * rate-limit codes are `quota`, a degenerate empty response is `empty-result`,
 * an unknown model, a missing adapter, or a rejected reasoning effort is
 * `model-unavailable`, and everything else — transport, timeout, server,
 * cancellation, and unknown codes — is the generic `network` bucket, because
 * the six-code contract has no separate service-failure code. An absent code
 * (a non-error throw) lands there too.
 */
function classifyFailure(code: string): ProviderErrorCode {
  const upper = code.toUpperCase()
  if (upper === 'EMPTY_RESPONSE') return 'empty-result'
  if (upper.includes('QUOTA') || upper.includes('RATE_LIMIT') || upper.includes('BALANCE') || upper.includes('BILLING') || upper.includes('CREDIT')) return 'quota'
  if (upper.includes('AUTH') || upper.includes('CREDENTIAL') || upper.includes('UNAUTHORIZED') || upper.includes('FORBIDDEN') || upper.includes('API_KEY')) return 'authentication'
  if (
    upper.includes('MODEL_NOT_FOUND')
    || upper.includes('MODEL_UNAVAILABLE')
    || upper.includes('NO_ADAPTER')
    || upper.includes('UNSUPPORTED_REASONING_EFFORT')
  ) return 'model-unavailable'
  return 'network'
}

/** Read a DSH failure code from a thrown value without trusting its message. */
function rawCode(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

/** Reduce any thrown value to an ORC-safe code; the raw message never escapes. */
function safeCode(error: unknown): ProviderErrorCode {
  return error instanceof ProviderError ? error.code : classifyFailure(rawCode(error))
}

/** Build the one safe error shape for a dispatch failure. */
const dispatchFailure = (code: ProviderErrorCode): ProviderError =>
  new ProviderError(code, `provider request failed: ${code}`)

/**
 * Dispatches ORC work to a provider/model configured in DSH, and binds a
 * connection test to the exact route and config revision it tested.
 */
export class ProviderAdapter {
  private readonly llm: ProviderLlmPort

  constructor(llm: ProviderLlmPort) {
    this.llm = llm
  }

  /**
   * Live catalog of the exact routes one configured provider advertises.
   *
   * One entry is produced per advertised model/effort pair, because a
   * {@link CatalogEntry} describes an exact route. A model whose adapter
   * advertises no effort cannot be routed without inventing one, so it
   * contributes no entry. A provider DSH does not currently register yields an
   * empty catalog rather than an error: Auto routing excludes it.
   *
   * A live adapter catalog is not an official capability/pricing source and
   * exposes no backend version, so both evidence fields are recorded empty —
   * the observation must not masquerade as a sourced vendor claim.
   *
   * `accountAccess` is recorded `false` for every entry because this read
   * carries no verified account-access signal: `listProviders()` only reports
   * that DSH registered an adapter, and DSH documents catalog membership as
   * advisory. `false` therefore means **unverified**, not known-denied — the
   * field is a boolean, so the fail-closed encoding of "no evidence" is to
   * withhold the claim. The only verified access evidence ORC has is a green
   * {@link test} result, so Task 7's Auto eligibility must require a green
   * `ConnectionResult` bound to this exact `routeKey` and revision; catalog
   * membership alone never admits a route.
   */
  async catalog(provider: string): Promise<CatalogSnapshot> {
    const observedAt = new Date().toISOString()
    const entries: CatalogEntry[] = []
    if (this.llm.listProviders().some(entry => entry.id === provider)) {
      for (const model of await this.llm.listModels(provider)) {
        if (model.provider !== provider) continue
        const efforts = await this.advertisedEfforts(provider, model.id)
        for (const effort of efforts) {
          entries.push({
            routeKey: routeKey({ kind: 'provider', provider, model: model.id, effort }),
            backendVersion: '',
            model: model.id,
            efforts: [...efforts],
            // Unverified: no account-access signal exists in this read. See the
            // method contract above and Task 7's green-test gate.
            accountAccess: false,
            sourceUrl: '',
            retrievedAt: observedAt,
          })
        }
      }
    }
    return { id: `${provider}@${observedAt}`, observedAt, entries }
  }

  /**
   * Send the harmless connection-test request to one exact route.
   *
   * Never rejects: every failure resolves to `{ ok: false, code }`, bound to
   * the route and revision that were tested.
   */
  async test(route: ProviderRoute, revision: string, signal: AbortSignal): Promise<ConnectionResult> {
    const key = routeKey(route)
    const testedAt = new Date().toISOString()
    try {
      await this.dispatch(route, CONNECTION_TEST_PROMPT, signal)
      return { routeKey: key, configRevision: revision, testedAt, ok: true }
    } catch (error) {
      return { routeKey: key, configRevision: revision, testedAt, ok: false, code: safeCode(error) }
    }
  }

  /**
   * Dispatch one prompt to the tested route and return its accepted final text.
   *
   * Rejects when the supplied test result is not bound to this exact route and
   * revision (a stale green result), when it did not pass, and on any dispatch
   * failure. A failure here remains a task failure — there is no fallback.
   *
   * Every dispatch failure is sanitized exactly as {@link test} sanitizes its
   * own: DSH's `listModels` and `resolveModelInfo` await the provider adapter's
   * discovery without normalizing it, so a raw adapter error (network, auth, an
   * HTTP body) would otherwise escape `run` verbatim. Only an ORC-owned
   * {@link ProviderError} — whose message is a fixed ORC string — passes through
   * unchanged; anything else is reduced to a safe code.
   */
  async run(
    route: ProviderRoute,
    prompt: string,
    revision: string,
    test: ConnectionResult,
    signal: AbortSignal,
  ): Promise<string> {
    const key = routeKey(route)
    if (test.routeKey !== key || test.configRevision !== revision) {
      throw new ProviderError(
        'route-mismatch',
        `stale connection test: ${test.routeKey}@${test.configRevision} does not match ${key}@${revision}`,
      )
    }
    if (!test.ok) throw new ProviderError(test.code, `connection test failed: ${test.code}`)
    try {
      return await this.dispatch(route, prompt, signal)
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw dispatchFailure(safeCode(error))
    }
  }

  /** Check the live catalog, build the request, check again, then stream. */
  private async dispatch(route: ProviderRoute, prompt: string, signal: AbortSignal): Promise<string> {
    await this.checkRoute(route)
    const messages: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
    ]
    await this.checkRoute(route)
    return this.collect({
      provider: route.provider,
      model: route.model,
      reasoningEffort: ReasoningEffortId(route.effort),
      messages,
      signal,
    })
  }

  /**
   * Refuse a route the live DSH adapter catalog does not currently serve.
   *
   * Registration and model membership are not enough: `effort` is part of the
   * route identity (it is in the `routeKey`, and a test is invalidated when it
   * changes), so an effort the adapter does not advertise must be refused here
   * rather than dispatched for DSH to reject as `UNSUPPORTED_REASONING_EFFORT`.
   * Resolution failure is sanitized: a model the adapter cannot describe is
   * `model-unavailable`, while a discovery transport/auth failure keeps its own
   * classification. Because {@link dispatch} runs this check before the request
   * is assembled and again immediately before dispatch, both checks validate
   * the effort.
   */
  private async checkRoute(route: ProviderRoute): Promise<void> {
    if (!this.llm.listProviders().some(entry => entry.id === route.provider)) {
      throw new ProviderError('route-mismatch', `provider "${route.provider}" is not registered with DSH`)
    }
    const models = await this.llm.listModels(route.provider)
    if (!models.some(model => model.id === route.model)) {
      throw new ProviderError('model-unavailable', `model "${route.model}" is not available on provider "${route.provider}"`)
    }
    let resolved: LlmResolvedModelInfo
    try {
      resolved = await this.llm.resolveModelInfo(route.provider, route.model)
    } catch (error) {
      throw dispatchFailure(safeCode(error))
    }
    const efforts: string[] = (resolved.reasoning?.efforts ?? []).map(effort => effort.id)
    if (!efforts.includes(route.effort)) {
      throw new ProviderError(
        'model-unavailable',
        `reasoning effort "${route.effort}" is not advertised for provider "${route.provider}" model "${route.model}"`,
      )
    }
  }

  /** Exact efforts the adapter advertises for one model; none means unroutable. */
  private async advertisedEfforts(provider: string, model: string): Promise<string[]> {
    try {
      const resolved = await this.llm.resolveModelInfo(provider, model)
      return (resolved.reasoning?.efforts ?? []).map(effort => effort.id)
    } catch {
      return []
    }
  }

  /**
   * Assemble the accepted final text, or fail on a stream error, an incomplete
   * response, or an empty result.
   *
   * Only a terminal normal `stop` finish is an accepted result. Any other
   * finish — `max-tokens` (reachable in normal operation because DSH
   * materializes an adapter-configured `defaultMaxTokens`), `tool-calls`, a
   * provider-specific reason, or no terminal finish at all — leaves partial
   * text unaccepted and fails as `empty-result`: the six-code contract has no
   * truncation bucket, and the result is not an accepted final result.
   * `error` and `aborted` finishes keep their own classification.
   */
  private async collect(options: GenerateOptions): Promise<string> {
    let text = ''
    let failureCode: string | undefined
    let stopped = false
    try {
      for await (const chunk of this.llm.stream(options)) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failureCode = chunk.reason.failure.code
          } else if (chunk.reason.kind === 'stop') {
            stopped = true
          }
        }
      }
    } catch (error) {
      failureCode = rawCode(error)
    }
    if (failureCode !== undefined) throw dispatchFailure(classifyFailure(failureCode))
    if (!stopped || text.length === 0) throw dispatchFailure('empty-result')
    return text
  }
}
