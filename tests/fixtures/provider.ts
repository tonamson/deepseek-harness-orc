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
  type Message,
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

/** DSH provider-neutral code behind each in-band failure mode. */
const FAILURE_CODES: Partial<Record<FakeFailure, string>> = {
  auth: 'MISSING_CREDENTIAL',
  network: 'TRANSPORT',
  quota: 'QUOTA',
  'empty-response': 'EMPTY_RESPONSE',
}

/** One recorded dispatch, reduced to the facts a test asserts on. */
export interface FakeLlmCall {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly messages: readonly Message[]
  readonly signal?: AbortSignal
}

/** The fake runtime, plus the dispatch log and a failure switch. */
export interface FakeLlm extends ProviderLlmPort {
  readonly calls: FakeLlmCall[]
  /** How many live catalog reads were served, so a test can pin the pre-flight check. */
  readonly reads: { providers: number; models: number }
  /** Change the failure mode of later dispatches, keeping recorded calls. */
  fail(failure: FakeFailure | undefined): void
}

export interface FakeLlmOptions {
  /** Accepted final text streamed on success (default `OK`). */
  output?: string
  /** Failure mode reproduced on dispatch; omitted means success. */
  failure?: FakeFailure
  /** Deliver a dispatch failure as a terminal `error` finish (default) or a thrown error. */
  delivery?: 'finish' | 'throw'
}

/** Build a live fake of the DSH `ctx.llm` surface the provider adapter consumes. */
export function fakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const output = options.output ?? 'OK'
  const delivery = options.delivery ?? 'finish'
  let failure = options.failure
  const calls: FakeLlmCall[] = []
  const reads = { providers: 0, models: 0 }

  const listProviders = (): LlmProviderInfo[] => {
    reads.providers += 1
    return failure === 'wrong-provider'
      ? [{ id: 'other', name: 'Other' }]
      : [{ id: FAKE_PROVIDER, name: 'Custom' }]
  }

  const listModels = async (provider: string): Promise<LlmModelInfo[]> => {
    reads.models += 1
    if (provider !== FAKE_PROVIDER || failure === 'unknown-model' || failure === 'wrong-provider') return []
    return [{ provider: FAKE_PROVIDER, id: FAKE_MODEL, name: FAKE_MODEL }]
  }

  const resolveModelInfo = async (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
    if (provider !== FAKE_PROVIDER || model !== FAKE_MODEL) {
      throw new HarnessError(`no such model "${model}"`, 'MODEL_NOT_FOUND')
    }
    return {
      provider: FAKE_PROVIDER,
      id: FAKE_MODEL,
      name: FAKE_MODEL,
      reasoning: {
        efforts: [{ id: ReasoningEffortId(FAKE_EFFORT), name: 'High' }],
        defaultEffort: ReasoningEffortId(FAKE_EFFORT),
      },
    }
  }

  const stream = (request: GenerateOptions): AsyncIterable<StreamChunk> => {
    calls.push({
      provider: request.provider,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      messages: request.messages,
      signal: request.signal,
    })
    const mode = failure
    const code = mode === undefined ? undefined : FAILURE_CODES[mode]
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
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  return {
    calls,
    reads,
    fail: (next) => {
      failure = next
    },
    listProviders,
    listModels,
    resolveModelInfo,
    stream,
  }
}
