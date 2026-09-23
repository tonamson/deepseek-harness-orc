#!/usr/bin/env node
/**
 * ORC benchmark fixture verification and evidence generation.
 *
 * Two jobs, deliberately separated from `npm test`:
 *
 * - `--verify-fixtures` re-hashes every fixture against `benchmarks/manifest.json`
 *   and checks the recorded scope, expected findings, and suite revision. It is
 *   keyless: it reads local JSON only and never opens a network connection.
 * - A scoring run turns a recorded or explicitly invoked route run into one
 *   versioned evidence record. It refuses to run without explicit route
 *   selection (`--backend`, `--model`, `--effort`) and an input
 *   (`--responses <file>` or `--command <executable>`), and it never guesses a
 *   route, falls back to another backend, or calls a model on its own.
 *
 * The fixture digest is SHA-256 over the canonical projection
 * `{ id, scope, code, expected }`, so a changed code sample or expectation
 * invalidates the manifest. `--write-manifest` regenerates those digests from
 * the fixtures; the manifest is never hand-edited.
 *
 * A recorded responses file is JSON mapping fixture id to either an array of
 * finding ids or raw model text containing one `FINDING: <id>` line per
 * finding. `--command` is spawned once per fixture with the fixture prompt on
 * stdin and its stdout parsed the same way.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES_PATH = join(ROOT, 'benchmarks', 'fixtures.json')
const MANIFEST_PATH = join(ROOT, 'benchmarks', 'manifest.json')

/** The only suite revision this runner produces or accepts. */
const SUITE_REVISION = 'orc-review-v1'

/** The risk scopes the suite covers. */
const SCOPE = ['financial', 'security']

const FINDING_LINE = /^\s*FINDING:\s*(\S+)\s*$/i

function fail(message) {
  process.stderr.write(`benchmark: ${message}\n`)
  process.exit(1)
}

/** Parse `--flag value` pairs plus the two boolean flags; reject anything else. */
function parseArgs(argv) {
  const args = { flags: new Set() }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--verify-fixtures' || token === '--write-manifest') {
      args.flags.add(token)
      continue
    }
    if (!token.startsWith('--')) fail(`unexpected argument "${token}"`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`unknown flag or missing value for "${token}"`)
    args[token.slice(2)] = value
    index += 1
  }
  return args
}

const canonicalFixture = fixture =>
  JSON.stringify({ id: fixture.id, scope: fixture.scope, code: fixture.code, expected: fixture.expected })

const digest = fixture => createHash('sha256').update(canonicalFixture(fixture)).digest('hex')

function numeric(args, key, fallback) {
  const raw = args[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`--${key} must be a finite number`)
  return value
}

async function load() {
  const fixtures = JSON.parse(await readFile(FIXTURES_PATH, 'utf8'))
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  if (!Array.isArray(fixtures)) fail('benchmarks/fixtures.json must be an array of fixtures')
  if (manifest.suiteRevision !== SUITE_REVISION) {
    fail(`manifest suite revision "${manifest.suiteRevision}" is not current "${SUITE_REVISION}"`)
  }
  if (!Array.isArray(manifest.fixtures)) fail('benchmarks/manifest.json must record a fixtures array')
  return { fixtures, manifest }
}

/** Every way the manifest and fixtures can disagree, as a list of messages. */
function verify(fixtures, manifest) {
  const problems = []
  const byId = new Map()
  for (const fixture of fixtures) {
    if (byId.has(fixture.id)) problems.push(`fixtures.json repeats fixture id "${fixture.id}"`)
    byId.set(fixture.id, fixture)
    if (!SCOPE.includes(fixture.scope)) problems.push(`fixture "${fixture.id}" has unknown scope "${fixture.scope}"`)
  }
  const recorded = new Set()
  for (const entry of manifest.fixtures) {
    recorded.add(entry.id)
    const fixture = byId.get(entry.id)
    if (fixture === undefined) {
      problems.push(`manifest fixture "${entry.id}" is missing from fixtures.json`)
      continue
    }
    const actual = digest(fixture)
    if (entry.sha256 !== actual) {
      problems.push(`fixture "${entry.id}" digest mismatch: manifest ${entry.sha256}, computed ${actual}`)
    }
    if (entry.scope !== fixture.scope) {
      problems.push(`fixture "${entry.id}" scope mismatch: manifest ${entry.scope}, fixture ${fixture.scope}`)
    }
    if (JSON.stringify(entry.expected) !== JSON.stringify(fixture.expected)) {
      problems.push(`fixture "${entry.id}" expected findings mismatch`)
    }
  }
  for (const fixture of fixtures) {
    if (!recorded.has(fixture.id)) problems.push(`fixture "${fixture.id}" is missing from the manifest`)
  }
  return problems
}

async function writeManifest(fixtures) {
  const body = {
    suiteRevision: SUITE_REVISION,
    fixtures: fixtures.map(fixture => ({
      id: fixture.id,
      scope: fixture.scope,
      sha256: digest(fixture),
      expected: fixture.expected,
    })),
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(body, null, 2)}\n`)
  process.stdout.write(`benchmark: wrote ${body.fixtures.length} fixture digests to benchmarks/manifest.json\n`)
}

function findingsOf(output) {
  if (Array.isArray(output)) return output.map(String)
  if (typeof output !== 'string') return []
  return output.split('\n').map(line => FINDING_LINE.exec(line)?.[1]).filter(id => id !== undefined)
}

const promptFor = fixture => [
  'Review the code below for the seeded known bugs.',
  'Report each finding on its own line exactly as: FINDING: <finding-id>',
  `Scope: ${fixture.scope}`,
  'Code:',
  fixture.code,
].join('\n')

/** Spawn the explicitly selected route invocation with no shell and no fallback. */
function runCommand(command, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('close', code => code === 0
      ? resolveRun(stdout)
      : rejectRun(new Error(`command exited ${code}: ${stderr.trim()}`)))
    child.stdin.end(input)
  })
}

async function collect(fixtures, args) {
  if (args.responses !== undefined) {
    const recorded = JSON.parse(await readFile(resolve(args.responses), 'utf8'))
    const responses = {}
    for (const fixture of fixtures) responses[fixture.id] = recorded[fixture.id] ?? []
    return { responses, latencyMs: numeric(args, 'latency-ms', 0) }
  }
  const started = Date.now()
  const responses = {}
  for (const fixture of fixtures) responses[fixture.id] = await runCommand(args.command, promptFor(fixture))
  return { responses, latencyMs: Date.now() - started }
}

/** Expected findings detected and findings reported outside the expectation. */
function score(fixtures, responses) {
  let expectedTotal = 0
  let detectedTotal = 0
  let reportedTotal = 0
  let falsePositiveTotal = 0
  const perFixture = []
  for (const fixture of fixtures) {
    const reported = [...new Set(findingsOf(responses[fixture.id] ?? []))]
    const expected = new Set(fixture.expected)
    const detected = reported.filter(id => expected.has(id))
    const falsePositives = reported.filter(id => !expected.has(id))
    expectedTotal += expected.size
    detectedTotal += detected.length
    reportedTotal += reported.length
    falsePositiveTotal += falsePositives.length
    perFixture.push({
      id: fixture.id,
      scope: fixture.scope,
      expected: fixture.expected,
      reported,
      detected,
      falsePositives,
      detection: expected.size === 0 ? null : detected.length / expected.size,
    })
  }
  return {
    detectionScore: expectedTotal === 0 ? 0 : detectedTotal / expectedTotal,
    falsePositiveScore: reportedTotal === 0 ? 0 : falsePositiveTotal / reportedTotal,
    perFixture,
  }
}

const args = parseArgs(process.argv.slice(2))
const { fixtures, manifest } = await load()

if (args.flags.has('--write-manifest')) {
  await writeManifest(fixtures)
  process.exit(0)
}

const problems = verify(fixtures, manifest)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`benchmark: ${problem}\n`)
  process.exit(1)
}
process.stdout.write(
  `benchmark: verified ${fixtures.length} fixtures against benchmarks/manifest.json (${SUITE_REVISION})\n`,
)

if (args.flags.has('--verify-fixtures')) process.exit(0)

const missing = ['backend', 'model', 'effort'].filter(key => args[key] === undefined)
if (missing.length > 0) {
  fail(`refusing to run: select an explicit route with ${missing.map(key => `--${key} <value>`).join(' ')}`)
}
if (args.responses === undefined && args.command === undefined) {
  fail('refusing to run: pass --responses <file> for a recorded run or --command <executable> to invoke the selected route')
}
if (args.responses !== undefined && args.command !== undefined) {
  fail('refusing to run: pass either --responses or --command, not both')
}

const { responses, latencyMs } = await collect(fixtures, args)
const result = score(fixtures, responses)
const date = args.date ?? new Date().toISOString()
const record = {
  id: `${args.backend}:${args.model}:${args.effort}:${date}`,
  suiteRevision: SUITE_REVISION,
  backend: args.backend,
  model: args.model,
  effort: args.effort,
  backendVersion: args.version ?? '',
  date,
  scope: SCOPE,
  detectionScore: result.detectionScore,
  falsePositiveScore: result.falsePositiveScore,
  latencyMs: numeric(args, 'latency-ms', latencyMs),
  costUsd: numeric(args, 'cost-usd', 0),
  perFixture: result.perFixture,
}
const out = args.out ?? join(ROOT, 'benchmarks', 'evidence', `${record.id.replace(/[^a-zA-Z0-9._:-]+/g, '_')}.json`)
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`)
process.stdout.write(`benchmark: wrote evidence for ${record.backend}/${record.model}/${record.effort} to ${out}\n`)
