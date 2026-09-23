/**
 * Benchmark evidence reachability.
 *
 * The release criterion that high-risk review and audit need validated evidence
 * is only reachable if two things hold together: the packaged bundle can load
 * evidence records, and the shipped runner can produce one from a real CLI
 * invocation. Both are pinned here, keylessly:
 *
 * - {@link loadBenchmarks} reads `benchmarks/evidence/` (the directory the
 *   archive ships and `scripts/benchmark.mjs` writes into), returns an empty
 *   snapshot when it does not exist, and refuses a malformed record;
 * - `scripts/benchmark.mjs` spawns the exact argv it is given — `--command`
 *   plus repeated `--arg`, or `--command-json` — with the fixture prompt on
 *   stdin, and refuses to write a record whose `backendVersion` would be empty
 *   (R22: an empty live version can never be admissible evidence).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { EVIDENCE_DIR, loadBenchmarks } from '../src/host/index.js'

/** The repository root, so the runner and its fixtures resolve. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The shipped runner. */
const RUNNER = join(ROOT, 'scripts', 'benchmark.mjs')
/** The fake review CLI that proves argv and stdin delivery. */
const ECHO = join(ROOT, 'tests', 'fixtures', 'benchmark-echo.mjs')

/** One owned temp directory, removed after the suite. */
const owned: string[] = []

/** Create one owned temp directory. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orc-benchmark-'))
  owned.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One evidence record the runner wrote, plus the process result. */
interface RunResult {
  status: number
  stdout: string
  stderr: string
  record?: Record<string, unknown>
}

/** Run the shipped benchmark runner and read back the record it wrote, if any. */
function run(...args: string[]): RunResult {
  const out = join(scratch(), 'record.json')
  const argv = [RUNNER, ...args, '--out', out]
  let status = 0
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    status = failure.status ?? -1
    stdout = failure.stdout ?? ''
    stderr = failure.stderr ?? ''
  }
  // A refusal writes no record; that is a result, not a harness failure.
  let record: Record<string, unknown> | undefined
  try {
    record = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
  } catch {
    record = undefined
  }
  return { status, stdout, stderr, record }
}

/** The route selection every live scoring run in this suite names. */
const ROUTE = ['--backend', 'codex', '--model', 'gpt-5.2-codex', '--effort', 'high', '--version', '0.156.1']

describe('shipped benchmark evidence', () => {
  it('resolves the evidence directory the archive ships', () => {
    // `benchmarks/` is in the manifest's `files`, so the archive carries this
    // exact directory; a package-relative URL keeps it resolvable after install.
    expect(resolve(fileURLToPath(EVIDENCE_DIR))).toBe(join(ROOT, 'benchmarks', 'evidence'))
  })

  it('loads every shipped record and refuses a malformed one', () => {
    const dir = scratch()
    expect(loadBenchmarks(new URL(`file://${dir}/`))).toMatchObject({ records: [] })

    writeFileSync(join(dir, 'codex.json'), JSON.stringify({
      id: 'codex:gpt-5.2-codex:high',
      suiteRevision: 'orc-review-v1',
      backend: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high',
      backendVersion: '0.156.1',
      date: '2026-09-23T00:00:00Z',
      scope: ['financial', 'security'],
      detectionScore: 0.9,
      falsePositiveScore: 0.1,
      latencyMs: 1200,
      costUsd: 0.5,
    }))

    const snapshot = loadBenchmarks(new URL(`file://${dir}/`))
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({ backend: 'codex', backendVersion: '0.156.1' })
    // The snapshot identity is a content digest, so two loads of the same
    // records agree and a changed record moves it.
    expect(snapshot.id).toMatch(/^orc-evidence:[0-9a-f]{16}$/)

    writeFileSync(join(dir, 'broken.json'), '{ not json')
    expect(() => loadBenchmarks(new URL(`file://${dir}/`))).toThrow(/broken\.json is not readable JSON/)
  })

  it('verifies the fixture manifest keylessly', () => {
    const result = run('--verify-fixtures')
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('verified 6 fixtures')
  })
})

describe('benchmark runner live invocation', () => {
  it('spawns the exact argv --command/--arg names, with the prompt on stdin', () => {
    const one = run(...ROUTE, '--command', process.execPath, '--arg', ECHO, '--arg', 'rounding-overpays')
    expect(one.status).toBe(0)
    // One expected id reported for every one of the six fixtures: 1/4 detected.
    expect(one.record).toMatchObject({ backendVersion: '0.156.1', detectionScore: 0.25 })
    expect((one.record?.perFixture as unknown[]).length).toBe(6)

    const all = run(
      ...ROUTE,
      '--command', process.execPath, '--arg', ECHO,
      '--arg', 'rounding-overpays', '--arg', 'duplicate-credit',
      '--arg', 'authorization-bypass', '--arg', 'secret-in-log',
    )
    expect(all.status).toBe(0)
    // A different argv produced a different score, so the args really reach the
    // spawned process rather than being dropped.
    expect(all.record).toMatchObject({ detectionScore: 1 })
  })

  it('accepts the same argv through --command-json', () => {
    const json = JSON.stringify([process.execPath, ECHO, 'rounding-overpays', 'duplicate-credit'])
    const result = run(...ROUTE, '--command-json', json)
    expect(result.status).toBe(0)
    expect(result.record).toMatchObject({ detectionScore: 0.5 })
  })

  it('refuses a scoring run with no backend version, and a failed route run', () => {
    const missing = run('--backend', 'codex', '--model', 'gpt-5.2-codex', '--effort', 'high', '--command', process.execPath)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--version <value>')

    const empty = run(...ROUTE.slice(0, -1), '', '--command', process.execPath)
    expect(empty.status).toBe(1)
    expect(empty.stderr).toMatch(/--version must name the exact backend version/)

    const failed = run(...ROUTE, '--command', process.execPath, '--arg', ECHO, '--arg', '--fail')
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/^benchmark: the selected route run failed: /)
  })

  it('refuses to mix the two argv spellings or an --arg without a --command', () => {
    const both = run(...ROUTE, '--command', process.execPath, '--command-json', '["node"]')
    expect(both.status).toBe(1)
    expect(both.stderr).toContain('either --command or --command-json')

    const orphan = run(...ROUTE, '--arg', 'x', '--responses', 'recorded.json')
    expect(orphan.status).toBe(1)
    expect(orphan.stderr).toContain('--arg supplies an argument for --command')
  })
})
