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
 *   (R22: an empty live version can never be admissible evidence);
 * - before the finding regex runs, the runner reduces the selected CLI's real
 *   output to the assistant's accepted final text: the `item.completed`
 *   `agent_message` text of a Codex `--json` JSONL stream, or the whole stdout
 *   when the output is plain text (`claude --print`, `codex exec` without
 *   `--json`). An invocation that exits 0 but yields no extractable text fails
 *   the run; an extracted-but-empty report still scores zero findings;
 * - the prompt it sends names that fixture's candidate finding ids as the only
 *   reportable vocabulary and never marks which are present — the candidates
 *   mix the seeded ids with plausible distractors, and a clean fixture offers a
 *   non-empty candidate list of its own — so a route that echoes the whole
 *   vocabulary is caught by the false-positive dimension instead of clearing
 *   both admissibility floors;
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { EVIDENCE_DIR, loadBenchmarks } from '../src/host/index.js'
import { evidenceFilename } from '../scripts/benchmark.mjs'

/** The repository root, so the runner and its fixtures resolve. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The shipped runner. */
const RUNNER = join(ROOT, 'scripts', 'benchmark.mjs')
/** The fake review CLI that proves argv and stdin delivery. */
const ECHO = join(ROOT, 'tests', 'fixtures', 'benchmark-echo.mjs')
/** The fake review CLI that records each fixture prompt it receives. */
const CAPTURE = join(ROOT, 'tests', 'fixtures', 'benchmark-prompt.mjs')
/** The fake review CLI that echoes every candidate id its fixture prompt offers. */
const ECHO_CANDIDATES = join(ROOT, 'tests', 'fixtures', 'benchmark-echo-candidates.mjs')
/** The fake `codex exec --json` CLI, whose answer rides inside a JSONL event. */
const CODEX_JSONL = join(ROOT, 'tests', 'fixtures', 'benchmark-codex-jsonl.mjs')
/** The fake plain-text CLI, the shape `claude --print` and `codex exec` emit. */
const PLAIN_TEXT = join(ROOT, 'tests', 'fixtures', 'benchmark-plain-text.mjs')

/** One seeded or clean fixture as `benchmarks/fixtures.json` ships it. */
interface Fixture {
  id: string
  scope: string
  code: string
  expected: string[]
  candidates: string[]
}

/** The shipped fixture set, in the order the runner scores it. */
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'benchmarks', 'fixtures.json'), 'utf8')) as Fixture[]

/** The candidate ids one fixture prompt offered, read back off its `- <id>` lines. */
function offeredCandidates(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
}

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

/** Every fixture prompt the runner sent, in fixture order, captured through a run. */
function capturedPrompts(): string[] {
  const file = join(scratch(), 'prompts.jsonl')
  const result = run(...ROUTE, '--command', process.execPath, '--arg', CAPTURE, '--arg', file)
  expect(result.status).toBe(0)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as string)
}

/** One well-formed evidence record, with any field overridable per test. */
function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
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
    ...overrides,
  }
}

describe('shipped benchmark evidence', () => {
  it('resolves the evidence directory the archive ships', () => {
    // `benchmarks/` is in the manifest's `files`, so the archive carries this
    // exact directory; a package-relative URL keeps it resolvable after install.
    expect(resolve(fileURLToPath(EVIDENCE_DIR))).toBe(join(ROOT, 'benchmarks', 'evidence'))
  })

  it('loads every shipped record and refuses a malformed one', () => {
    const dir = scratch()
    expect(loadBenchmarks(new URL(`file://${dir}/`))).toMatchObject({ records: [] })

    writeFileSync(join(dir, 'codex.json'), JSON.stringify(record('codex:gpt-5.2-codex:high')))

    const snapshot = loadBenchmarks(new URL(`file://${dir}/`))
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({ backend: 'codex', backendVersion: '0.156.1' })
    // The snapshot identity is a content digest, so two loads of the same
    // records agree and a changed record moves it.
    expect(snapshot.id).toMatch(/^orc-evidence:[0-9a-f]{16}$/)

    writeFileSync(join(dir, 'broken.json'), '{ not json')
    expect(() => loadBenchmarks(new URL(`file://${dir}/`))).toThrow(/broken\.json is not readable JSON/)
  })

  it('loads a record whose filename contains colons', () => {
    // The defect this test closes: the runner names a file after the record id,
    // and the id separates route fields with colons. A loader that resolved the
    // entry with `new URL(file, directory)` parsed `codex:` as a URL scheme and
    // threw ERR_INVALID_URL_SCHEME, so a real record crashed the load instead of
    // being read. The name here is byte-for-byte the one on disk for the record
    // the bundle ships.
    const dir = scratch()
    const name = 'codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z.json'
    const id = 'codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z'
    writeFileSync(join(dir, name), JSON.stringify(record(id, {
      model: 'gpt-6-sol',
      date: '2026-09-24T02:44:02.851Z',
      detectionScore: 1,
      falsePositiveScore: 0.2,
    })))

    const snapshot = loadBenchmarks(new URL(`file://${dir}/`))
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      id: 'codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z',
      backend: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
      backendVersion: '0.156.1',
    })
  })

  it('reads the record the bundle actually ships', () => {
    // The shipped directory is the one the archive carries and the Host loads
    // from at profile start, so this is the real path, not a temp stand-in.
    const snapshot = loadBenchmarks()
    expect(snapshot.suiteRevision).toBe('orc-review-v1')
    const shipped = snapshot.records.find(entry => entry.id === 'codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z')
    expect(shipped).toMatchObject({
      backend: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
      backendVersion: '0.156.1',
      date: '2026-09-24T02:44:02.851Z',
      detectionScore: 1,
      falsePositiveScore: 0.2,
    })
  })

  it('fails loudly on a malformed record and on a missing directory', () => {
    // A record that is readable JSON but not a valid record is a hard error: a
    // silently skipped record would weaken the evidence set without saying so.
    const malformed = scratch()
    writeFileSync(join(malformed, 'bad-shape.json'), JSON.stringify({ id: 'x', backend: 'codex' }))
    expect(() => loadBenchmarks(new URL(`file://${malformed}/`))).toThrow(/bad-shape\.json is malformed/)

    // A directory that does not exist is not a fault: the fail-closed snapshot
    // excludes every high-risk review and audit rather than crashing the Host.
    const absent = join(scratch(), 'absent')
    expect(loadBenchmarks(new URL(`file://${absent}/`))).toMatchObject({ id: 'orc-evidence:none', records: [] })
  })

  it('verifies the fixture manifest keylessly', () => {
    const result = run('--verify-fixtures')
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('verified 6 fixtures')
  })
})

describe('benchmark evidence filenames', () => {
  it('sanitizes a record id to a colon-free, portable filename', () => {
    // Colons are illegal in a Windows filename, so the runner must not emit
    // them. The id keeps its identity inside the JSON; only the name changes.
    const name = evidenceFilename('codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z')
    expect(name).toBe('codex_gpt-6-sol_high_2026-09-24T02_44_02.851Z.json')
    expect(name).not.toContain(':')
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('names a record so the loader reads it back', () => {
    const dir = scratch()
    const id = 'codex:gpt-6-sol:high:2026-09-24T02:44:02.851Z'
    writeFileSync(join(dir, evidenceFilename(id)), JSON.stringify(record(id)))
    const snapshot = loadBenchmarks(new URL(`file://${dir}/`))
    expect(snapshot.records.map(entry => entry.id)).toEqual([id])
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

describe('benchmark fixture prompt', () => {
  it('offers every fixture exactly its candidate vocabulary, expected included', () => {
    const prompts = capturedPrompts()
    expect(prompts).toHaveLength(FIXTURES.length)

    for (const [index, fixture] of FIXTURES.entries()) {
      const prompt = prompts[index] ?? ''
      // Every prompt still carries the report syntax, the scope, and the code.
      expect(prompt).toContain('FINDING: <finding-id>')
      expect(prompt).toContain(`Scope: ${fixture.scope}`)
      expect(prompt).toContain(fixture.code)

      // The prompt offers every candidate this fixture ships, and nothing else:
      // a fixture that dropped or added a candidate would fail here.
      expect(offeredCandidates(prompt)).toEqual(fixture.candidates)
      for (const id of fixture.candidates) expect(prompt).toContain(id)
    }
  })

  it('keeps every fixture\'s expected set inside its candidate list, with absent distractors', () => {
    for (const fixture of FIXTURES) {
      // The scorer credits an id only if it was offered, so an expected id that
      // is not a candidate could never be detected.
      for (const id of fixture.expected) expect(fixture.candidates).toContain(id)
      // Guessing must not be viable: every fixture offers several candidates,
      // and at least one offered candidate is never the correct answer.
      expect(fixture.candidates.length).toBeGreaterThanOrEqual(3)
      expect(fixture.candidates.length).toBeGreaterThan(fixture.expected.length)
      expect(new Set(fixture.candidates).size).toBe(fixture.candidates.length)
    }
  })

  it('gives a clean fixture a non-empty candidate list instead of a "none" announcement', () => {
    const prompts = capturedPrompts()
    const clean = FIXTURES.filter(fixture => fixture.expected.length === 0)
    expect(clean.length).toBeGreaterThan(0)

    for (const fixture of clean) {
      // A clean fixture is a control with the same shape as its seeded sibling,
      // so it tests restraint rather than being handed an empty vocabulary.
      expect(fixture.candidates.length).toBeGreaterThan(0)
      const prompt = prompts[FIXTURES.indexOf(fixture)] ?? ''
      expect(offeredCandidates(prompt)).toEqual(fixture.candidates)
      expect(prompt).toMatch(/report nothing/)
      // The old announcement is gone, so no fixture is told its list is empty.
      expect(prompt).not.toContain('Candidate finding ids for this fixture: none.')
      expect(prompt).not.toMatch(/\bnone\b/i)
    }
  })

  it('does not make the expected id\'s position, or a clean fixture\'s lead, the answer', () => {
    // R32: the expected id used to sit at index 0 of every seeded fixture, and
    // each clean fixture led with its sibling's expected id. A route that never
    // read the code could classify buggy-vs-clean and then report
    // `candidates[0]` for full detection with no false positives. The position
    // oracle is now closed: the expected id's index is spread across the seeded
    // fixtures, and a clean fixture leads with a non-sibling distractor.
    const seeded = FIXTURES.filter(fixture => fixture.expected.length > 0)
    expect(seeded.length).toBeGreaterThan(1)

    // The expected id's index is not constant, so no single position answers
    // every seeded fixture. Re-ordering the lists back to the positional layout
    // (every expected id at index 0) collapses this set to one value and fails.
    const expectedIndices = seeded.map(fixture => fixture.candidates.indexOf(fixture.expected[0] ?? ''))
    for (const index of expectedIndices) expect(index).toBeGreaterThanOrEqual(0)
    expect(new Set(expectedIndices).size).toBeGreaterThan(1)

    // Every clean fixture leads with a candidate that is NOT the expected id of
    // any seeded fixture in its own scope, so `candidates[0]` cannot be the
    // sibling's bug on the control fixtures either.
    const clean = FIXTURES.filter(fixture => fixture.expected.length === 0)
    expect(clean.length).toBeGreaterThan(0)
    for (const fixture of clean) {
      const siblingExpected = seeded
        .filter(entry => entry.scope === fixture.scope)
        .flatMap(entry => entry.expected)
      expect(siblingExpected.length).toBeGreaterThan(0)
      expect(siblingExpected).not.toContain(fixture.candidates[0])
    }
  })

  it('scores a report of the expected ids as full detection and no false positives', () => {
    // The prompt change must not move the score: reporting exactly the expected
    // ids is still 1.0 detection with 0.0 false positives.
    const file = join(scratch(), 'responses.json')
    writeFileSync(file, JSON.stringify(Object.fromEntries(FIXTURES.map(fixture => [fixture.id, fixture.expected]))))

    const result = run(...ROUTE, '--responses', file)
    expect(result.status).toBe(0)
    expect(result.record).toMatchObject({ detectionScore: 1, falsePositiveScore: 0 })

    const perFixture = result.record?.perFixture as { id: string; detected: string[]; falsePositives: string[] }[]
    for (const scored of perFixture) {
      const fixture = FIXTURES.find(entry => entry.id === scored.id)
      expect(scored.detected).toEqual(fixture?.expected)
      expect(scored.falsePositives).toEqual([])
    }
  })

  it('scores a route that echoes every offered candidate above the false-positive floor', () => {
    // The exploit R31 closes: a route that never reads the code and reports the
    // whole vocabulary the prompt offers used to score 1.0 detection with 0.0
    // false positives, clearing both floors at src/domain/routing.ts:98-99.
    // With distractors in every list it must now exceed the 0.2 floor.
    const result = run(...ROUTE, '--command', process.execPath, '--arg', ECHO_CANDIDATES)
    expect(result.status).toBe(0)

    const record = result.record as { detectionScore: number; falsePositiveScore: number }
    // Detection is still perfect — every expected id was offered and echoed.
    expect(record.detectionScore).toBe(1)
    // ...but echoing the distractors is now a false positive on every fixture.
    expect(record.falsePositiveScore).toBeGreaterThan(0.2)

    // The old exploit cleared both admissibility floors; it no longer does.
    const floors = { detection: 0.8, falsePositive: 0.2 }
    expect(record.detectionScore >= floors.detection && record.falsePositiveScore <= floors.falsePositive).toBe(false)
  })
})

describe('benchmark runner output extraction', () => {
  /** Every id the suite seeds, in fixture order. */
  const EXPECTED = FIXTURES.flatMap(fixture => fixture.expected)

  /** One scored fixture as the runner records it. */
  interface ScoredFixture {
    id: string
    reported: string[]
    detected: string[]
    falsePositives: string[]
  }

  it('extracts findings from a Codex --json JSONL response', () => {
    // The defect this fix closes: Codex carries the answer as one JSON string
    // field with escaped newlines, so a runner that splits raw stdout on real
    // newlines sees no `FINDING:` line at all and scores zero. All four seeded
    // ids are sent to every fixture, so detection reaches 1.0 only if the JSON
    // string was decoded into four separate finding lines before the regex ran;
    // undecoded, the whole answer would be one blob and detection would be 0.
    const result = run(...ROUTE, '--command', process.execPath, '--arg', CODEX_JSONL, ...EXPECTED.flatMap(id => ['--arg', id]))
    expect(result.status).toBe(0)
    expect(result.record).toMatchObject({ detectionScore: 1 })

    const perFixture = result.record?.perFixture as ScoredFixture[]
    for (const scored of perFixture) {
      const fixture = FIXTURES.find(entry => entry.id === scored.id)
      // Each fixture decoded the same four findings and credited exactly its own.
      expect(scored.reported).toEqual(EXPECTED)
      expect(scored.detected).toEqual(fixture?.expected)
    }
  })

  it('extracts findings from a plain-text response', () => {
    // `claude --print` (default `--output-format text`) and `codex exec`
    // without `--json` write prose and findings as ordinary stdout text, so the
    // whole output is the answer. The fake wraps each finding in prose to prove
    // the extraction does not require the first line to be a finding.
    const result = run(...ROUTE, '--command', process.execPath, '--arg', PLAIN_TEXT, ...EXPECTED.flatMap(id => ['--arg', id]))
    expect(result.status).toBe(0)
    expect(result.record).toMatchObject({ detectionScore: 1 })

    const perFixture = result.record?.perFixture as ScoredFixture[]
    for (const scored of perFixture) {
      const fixture = FIXTURES.find(entry => entry.id === scored.id)
      expect(scored.reported).toEqual(EXPECTED)
      expect(scored.detected).toEqual(fixture?.expected)
    }
  })

  it('fails a run whose exit-0 output carries no extractable assistant text', () => {
    // A Codex stream that completed its turn without ever producing an
    // agent_message: nothing to score, so the run must fail loudly rather than
    // record zero findings. The diagnostic names the fixture and the format it
    // expected, and redacts the token-shaped reasoning text it echoes.
    const noMessage = run(...ROUTE, '--command', process.execPath, '--arg', CODEX_JSONL, '--arg', '--no-message')
    expect(noMessage.status).toBe(1)
    expect(noMessage.record).toBeUndefined()
    expect(noMessage.stderr).toMatch(/^benchmark: the selected route run failed: /)
    expect(noMessage.stderr).toContain('fixture "fin-round-up" produced no extractable assistant text')
    expect(noMessage.stderr).toContain('no item.completed agent_message event')
    expect(noMessage.stderr).toContain('item.completed agent_message event, or plain text on stdout')
    // Requirement 3: the excerpt is a short, safe diagnostic, never raw output.
    expect(noMessage.stderr).not.toContain('sk-ant-api03-EXAMPLEONLY0000000000')
    expect(noMessage.stderr).toContain('<redacted>')

    // A plain-text invocation that exits 0 having written nothing is the same
    // failure, not a clean zero.
    const silent = run(...ROUTE, '--command', process.execPath, '--arg', PLAIN_TEXT, '--arg', '--silent')
    expect(silent.status).toBe(1)
    expect(silent.record).toBeUndefined()
    expect(silent.stderr).toContain('fixture "fin-round-up" produced no extractable assistant text')
    expect(silent.stderr).toContain('it wrote nothing to stdout')
  })

  it('scores an extracted but empty report as zero findings without failing', () => {
    // The other direction of the distinction: the assistant answered and said
    // nothing. That is a real report — the expected one on a clean fixture — so
    // it must score zero findings and write a record, not fail the run.
    const result = run(...ROUTE, '--command', process.execPath, '--arg', CODEX_JSONL, '--arg', '--empty-report')
    expect(result.status).toBe(0)
    expect(result.record).toMatchObject({ detectionScore: 0, falsePositiveScore: 0 })

    const perFixture = result.record?.perFixture as ScoredFixture[]
    for (const scored of perFixture) expect(scored.reported).toEqual([])
    // The clean fixtures are the ones this reading exists for, and they are
    // scored rather than skipped.
    const clean = FIXTURES.filter(fixture => fixture.expected.length === 0).map(fixture => fixture.id)
    expect(clean.length).toBeGreaterThan(0)
    expect(perFixture.filter(scored => clean.includes(scored.id)).length).toBe(clean.length)
  })

  it('fails a Codex JSONL stream carrying a turn.failed or error event', () => {
    // A failed turn is not an empty report: a runner that ignored the failure
    // would credit the findings the doomed turn had already emitted.
    const failed = run(
      ...ROUTE,
      '--command', process.execPath, '--arg', CODEX_JSONL,
      '--arg', '--turn-failed', '--arg', 'rounding-overpays',
    )
    expect(failed.status).toBe(1)
    expect(failed.record).toBeUndefined()
    expect(failed.stderr).toContain('the turn failed with a Codex "turn.failed" event')

    const errored = run(...ROUTE, '--command', process.execPath, '--arg', CODEX_JSONL, '--arg', '--error')
    expect(errored.status).toBe(1)
    expect(errored.record).toBeUndefined()
    expect(errored.stderr).toContain('the turn failed with a Codex "error" event')
  })
})
