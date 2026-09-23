/**
 * ORC Host composition entry.
 *
 * One Loader row (`orc-host`) mounts this module, which owns every host-side
 * ORC contribution:
 *
 * - the ORC settings section and its live bridge (Task 2);
 * - the durable journal and its `orc` session projection;
 * - the `orc` run service, published as `ctx.orc`;
 * - the model-facing `orc` tool, policy section, and pre-step gate, installed
 *   per Agent;
 * - the provider and host-CLI adapters the service dispatches through.
 *
 * The Remote face is a separate row (`orc-remote-host`) so the wire boundary is
 * its own composition unit. Unloading this plugin disposes all of the above:
 * the settings section, the projection, the service, and every Agent-scoped
 * contribution — nothing else in the profile is touched.
 *
 * `inject` declares every service this module reads, including `settings`, so a
 * profile where the settings provider applies later cannot load ORC before its
 * configuration exists (R18).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { parseConfig, ConfigSchema } from '../domain/config.js'
import { BENCHMARK_SUITE_REVISION, type BenchmarkEvidence, type BenchmarkSnapshot } from '../domain/evidence.js'
import type { OrcConfig } from '../domain/types.js'
import { CliAdapter } from './cli.js'
import { installOrcJournal } from './journal.js'
import { ProviderAdapter } from './provider.js'
import { OrcService } from './service.js'
import { installOrcSettings } from './settings.js'
import { installOrcTool } from './tool.js'

/** The Cordis plugin name shown in Loader and fiber diagnostics. */
export const name = 'orc-host'

/**
 * Services this module reads.
 *
 * `settings` is first because ORC's configuration must exist before anything is
 * installed; `sessionProjections` and `sessions` are the journal's read and
 * durability seams; `llm` and `subprocess` back the provider and CLI adapters.
 * `subagents` is deliberately absent: a deployment without it still mounts ORC
 * and refuses child creation with an actionable error.
 */
export const inject = ['settings', 'tools', 'systemPrompt', 'sessions', 'sessionProjections', 'agents', 'llm', 'subprocess']

/** The composition config is the ORC settings base, validated by the same schema. */
export const Config = ConfigSchema

/** One evidence record as the benchmark runner writes it. */
const EvidenceSchema = z.object({
  id: z.string(),
  suiteRevision: z.string(),
  backend: z.string(),
  model: z.string(),
  effort: z.string(),
  backendVersion: z.string(),
  date: z.string(),
  scope: z.array(z.string()),
  detectionScore: z.number(),
  falsePositiveScore: z.number(),
  latencyMs: z.number(),
  costUsd: z.number(),
})

/** The directory the benchmark runner writes evidence records into. */
export const EVIDENCE_DIR = new URL('../../benchmarks/evidence/', import.meta.url)

/**
 * Load the versioned benchmark evidence this bundle ships.
 *
 * One record per file, as `scripts/benchmark.mjs` writes them. The runner's
 * per-fixture detail is not a routing input, so it is ignored; every field the
 * router reads is validated, and a malformed record fails the load loudly
 * rather than silently weakening the evidence set. A bundle with no evidence
 * directory yields an empty snapshot, which excludes every high-risk review and
 * audit instead of admitting an unmeasured route.
 *
 * @param directory - the evidence directory to read; defaults to the one this
 *   package ships (`benchmarks/evidence/`), which the archive carries because
 *   `scripts/` and `benchmarks/` are both in the manifest's `files`.
 */
export function loadBenchmarks(directory: URL = EVIDENCE_DIR): BenchmarkSnapshot {
  let files: string[]
  try {
    files = readdirSync(fileURLToPath(directory)).filter(file => file.endsWith('.json')).sort()
  } catch {
    return { id: 'orc-evidence:none', suiteRevision: BENCHMARK_SUITE_REVISION, records: [] }
  }
  const records: BenchmarkEvidence[] = []
  for (const file of files) {
    const path = fileURLToPath(new URL(file, directory))
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`orc: benchmark evidence ${file} is not readable JSON: ${String(error)}`)
    }
    const result = EvidenceSchema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`orc: benchmark evidence ${file} is malformed: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
    }
    records.push(result.data)
  }
  const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16)
  return { id: `orc-evidence:${digest}`, suiteRevision: BENCHMARK_SUITE_REVISION, records }
}

/**
 * Mount every host-side ORC contribution.
 *
 * @param ctx - the plugin context; its injections are declared above.
 * @param config - the ORC settings base from the Loader row, validated strictly.
 */
export function apply(ctx: Context, config: OrcConfig): void {
  const base = parseConfig(config)
  const settings = installOrcSettings(ctx, base)
  const journal = installOrcJournal(ctx)
  const service = new OrcService({
    journal: journal.journal,
    settings: settings.bridge,
    benchmarks: loadBenchmarks(),
    providers: new ProviderAdapter(ctx.llm),
    clis: new CliAdapter(ctx.subprocess),
    ...ctx.get('subagents') === undefined ? {} : { subagents: ctx.get('subagents') },
    agents: ctx.agents,
  })

  ctx.effect(() => {
    const unprovide = ctx.provide('orc', service)
    return () => {
      unprovide()
      service.dispose()
    }
  }, 'orc.service')

  const installed = new Map<Agent, () => void>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, installOrcTool(agent, service))
  }
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'orc.tools()')
}
