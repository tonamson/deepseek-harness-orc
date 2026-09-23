/**
 * Fake DSH LLM runtime for the provider adapter tests.
 *
 * It implements exactly the live surface `ProviderAdapter` reads — the provider
 * and model catalog plus one streaming dispatch — and records every dispatch so
 * a test can prove which route was called and that no other backend was.
 * Failures reproduce DSH's provider-neutral failure vocabulary, so the
 * adapter's own classification is exercised rather than re-implemented here.
 */

import {
  HarnessError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProviderLlmPort } from '../../src/host/provider.js'

/** The one provider route the fake advertises. */
export const FAKE_PROVIDER = 'custom'
export const FAKE_MODEL = 'm1'
export const FAKE_EFFORT = 'high'

/** Failure modes the fake reproduces. */
export type FakeFailure =
  | 'unknown-model'
  | 'wrong-provider'
  | 'auth'
  | 'network'
  | 'quota'
  | 'empty'
  | 'empty-response'
  | 'discovery'
  | 'effort-rejected'

/** Terminal finish reasons a test can make the fake report; `none` emits no finish at all. */
export type FakeFinishReason = 'stop' | 'max-tokens' | 'tool-calls' | 'none'

/** DSH provider-neutral code behind each in-band failure mode. */
const FAILURE_CODES: Partial<Record<FakeFailure, string>> = {
  auth: 'MISSING_CREDENTIAL',
  network: 'TRANSPORT',
  quota: 'QUOTA',
  'empty-response': 'EMPTY_RESPONSE',
  discovery: 'TRANSPORT',
  'effort-rejected': 'UNSUPPORTED_REASONING_EFFORT',
}

/**
 * One recorded dispatch: the exact `GenerateOptions` object the adapter passed,
 * not a hand-picked subset. A test that pins the recorded keys therefore proves
 * what the adapter actually sent — including that it sent no credential field.
 */
export type FakeLlmCall = GenerateOptions

/** The fake runtime, plus the dispatch log and its mutable switches. */
export interface FakeLlm extends ProviderLlmPort {
  readonly calls: FakeLlmCall[]
  /** How many live catalog reads were served, so a test can pin the pre-flight check. */
  readonly reads: { providers: number; models: number; resolves: number }
  /** Change the failure mode of later dispatches, keeping recorded calls. */
  fail(failure: FakeFailure | undefined): void
  /** Make later model resolution throw a raw DSH failure code, as a real adapter can. */
  failResolve(code: string | undefined): void
  /** Replace the advertised effort ids, so a test can invalidate a route mid-flight. */
  setEfforts(efforts: readonly string[]): void
  /** Replace the terminal finish reason later dispatches report. */
  setFinishReason(reason: FakeFinishReason): void
  /**
   * Runs after every `resolveModelInfo`, so a test can change state between the
   * pre-request and pre-dispatch route checks.
   */
  afterResolve: (() => void) | undefined
}

export interface FakeLlmOptions {
  /** Accepted final text streamed on success (default `OK`). */
  output?: string
  /** Failure mode reproduced on dispatch; omitted means success. */
  failure?: FakeFailure
  /** Deliver a dispatch failure as a terminal `error` finish (default) or a thrown error. */
  delivery?: 'finish' | 'throw'
  /** Effort ids the adapter advertises for the fake model (default `['high']`). */
  efforts?: readonly string[]
  /** Terminal finish reason reported after streamed text (default `stop`). */
  finishReason?: FakeFinishReason
}

/** Build a live fake of the DSH `ctx.llm` surface the provider adapter consumes. */
export function fakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const output = options.output ?? 'OK'
  const delivery = options.delivery ?? 'finish'
  let failure = options.failure
  let efforts: readonly string[] = options.efforts ?? [FAKE_EFFORT]
  let finishReason: FakeFinishReason = options.finishReason ?? 'stop'
  let resolveFailure: string | undefined
  const calls: FakeLlmCall[] = []
  const reads = { providers: 0, models: 0, resolves: 0 }
  const runtime: FakeLlm = {
    calls,
    reads,
    fail: (next) => {
      failure = next
    },
    failResolve: (code) => {
      resolveFailure = code
    },
    setEfforts: (next) => {
      efforts = [...next]
    },
    setFinishReason: (next) => {
      finishReason = next
    },
    afterResolve: undefined,
    listProviders: (): LlmProviderInfo[] => {
      reads.providers += 1
      return failure === 'wrong-provider'
        ? [{ id: 'other', name: 'Other' }]
        : [{ id: FAKE_PROVIDER, name: 'Custom' }]
    },
    listModels: async (provider: string): Promise<LlmModelInfo[]> => {
      reads.models += 1
      // A real adapter's discovery can fail before DSH normalizes anything, so
      // the throw here is raw — the adapter under test must sanitize it.
      if (failure === 'discovery') throw new HarnessError('fake provider discovery failed', 'TRANSPORT')
      if (provider !== FAKE_PROVIDER || failure === 'unknown-model' || failure === 'wrong-provider') return []
      return [{ provider: FAKE_PROVIDER, id: FAKE_MODEL, name: FAKE_MODEL }]
    },
    resolveModelInfo: async (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
      reads.resolves += 1
      // A raw adapter discovery failure, exactly as DSH would let one escape.
      if (resolveFailure !== undefined) throw new HarnessError('fake model resolution failed', resolveFailure)
      if (provider !== FAKE_PROVIDER || model !== FAKE_MODEL) {
        throw new HarnessError(`no such model "${model}"`, 'MODEL_NOT_FOUND')
      }
      const advertised = [...efforts]
      const resolved: LlmResolvedModelInfo = {
        provider: FAKE_PROVIDER,
        id: FAKE_MODEL,
        name: FAKE_MODEL,
        reasoning: {
          efforts: advertised.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
          defaultEffort: ReasoningEffortId(advertised[0] ?? FAKE_EFFORT),
        },
      }
      runtime.afterResolve?.()
      return resolved
    },
    stream: (request: GenerateOptions): AsyncIterable<StreamChunk> => {
      calls.push(request)
      const mode = failure
      const code = mode === undefined ? undefined : FAILURE_CODES[mode]
      const terminal = finishReason
      return (async function* generate(): AsyncIterable<StreamChunk> {
        if (code !== undefined && delivery === 'throw') {
          throw new HarnessError('fake provider dispatch failed', code)
        }
        if (code !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fake provider failure', code } } }
          return
        }
        if (mode === 'empty') {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: output }
        if (terminal === 'none') return
        yield { type: 'finish', reason: { kind: terminal } }
      })()
    },
  }
  return runtime
}
