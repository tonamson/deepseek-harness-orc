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
 *   selection (`--backend`, `--model`, `--effort`, `--version`) and an input
 *   (`--responses <file>` or a `--command`/`--command-json` invocation), and it
 *   never guesses a route, falls back to another backend, or calls a model on
 *   its own.
 *
 * The fixture digest is SHA-256 over the canonical projection
 * `{ id, scope, code, expected, candidates }`, so a changed code sample,
 * expectation, or candidate list invalidates the manifest. `--write-manifest`
 * regenerates those digests from the fixtures; the manifest is never
 * hand-edited.
 *
 * A recorded responses file is JSON mapping fixture id to either an array of
 * finding ids or raw model text containing one `FINDING: <id>` line per
 * finding.
 *
 * A live invocation is spawned once per fixture with the fixture prompt on
 * stdin. Its stdout is first reduced to the assistant's accepted final text and
 * only then scanned for `FINDING:` lines, because the supported CLIs do not
 * agree on an output shape:
 *
 * - Codex `--json` writes JSONL, one event object per line, and the answer is
 *   the `text` of the `item.completed` event whose item type is
 *   `agent_message`; JSON decoding restores the newlines it escaped. Non-
 *   assistant events are ignored, and a `turn.failed` or top-level `error`
 *   event — the two the Codex schema calls fatal — fails that fixture's run.
 * - Anything else is plain text, and the whole stdout is the answer. That
 *   covers `claude --print` and `codex exec` without `--json`.
 *
 * An invocation that exits 0 but yields no extractable assistant text fails the
 * run and writes no record; it is never scored as a zero-finding (clean) run.
 * A successfully extracted but empty report still scores zero findings, which
 * is the correct reading for a clean fixture. A `--responses` run bypasses all
 * of this and is unchanged.
 *
 * The prompt is deterministic and built from the fixture alone: it carries the
 * scope and the code, and it names
 * that fixture's `candidates` — the exact vocabulary the scorer accepts — so a
 * run measures whether the route found the seeded bug rather than whether it
 * guessed the identifier string.
 *
 * Every fixture's candidate list mixes ids that ARE present in that code
 * (exactly its `expected` set) with distractor ids that are plausible for the
 * fixture's scope but genuinely absent from it. The candidates are never
 * annotated with which are which, so echoing the whole vocabulary scores
 * detection 1.0 only by also reporting every distractor, which drives
 * `falsePositiveScore` far above the 0.2 admissibility floor. A clean fixture
 * carries an `expected` of `[]` and a non-empty candidate list, so it is a
 * control with the same vocabulary as its seeded sibling: reporting nothing is
 * the only way to keep its false positives at zero. The argv is explicit and
 * never shell-interpolated, and there are two equivalent ways to write one:
 *
 * ```
 * --command codex --arg exec --arg --json --arg -
 * --command-json '["codex","exec","--json","-"]'
 * ```
 *
 * `--version` is required for a scoring run: an evidence record whose
 * `backendVersion` is empty can never be admissible (R22), so the runner
 * refuses to write one.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
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

/** The top-level event types Codex `--json` emits (codex-rs `exec_events.rs`). */
const CODEX_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
])

/**
 * The Codex `--json` events that mean the turn produced no answer.
 *
 * The schema distinguishes these two fatal events from an `item` whose type is
 * `error`, which it documents as a *non-fatal* error surfaced as an item: that
 * one is an ignored non-assistant event, and the turn can still carry an
 * `agent_message`.
 */
const CODEX_FAILURE_EVENTS = new Set(['turn.failed', 'error'])

/** The item type whose `text` is the assistant's accepted final message. */
const CODEX_AGENT_MESSAGE = 'agent_message'

/** How much redacted provider output a failure diagnostic may carry. */
const EXCERPT_LIMIT = 200

/**
 * The token-redaction discipline the rest of the repo uses
 * (`src/host/cli.ts:178`), kept local so this runner stays self-contained: raw
 * provider output is never surfaced, only a short excerpt with ANSI escapes
 * stripped, token shapes masked, and absolute paths replaced.
 */
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_*-]{3,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
]
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|~?\/)[^\s"'`,;:)\]}]+/g

/** A short, safe excerpt of raw provider output for a failure diagnostic. */
function safeExcerpt(text, executable = '') {
  let safe = String(text ?? '').replace(ANSI_PATTERN, '')
  for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, '<redacted>')
  safe = safe.replace(
    ABSOLUTE_PATH_PATTERN,
    match => (executable !== '' && (match === executable || match.startsWith(`${executable}/`)) ? match : '<path>'),
  )
  safe = safe.replace(/\s+/g, ' ').trim()
  return safe.length > EXCERPT_LIMIT ? `${safe.slice(0, EXCERPT_LIMIT)}…` : safe
}

/**
 * Read a Codex `--json` JSONL stream, or report that this is not one.
 *
 * Returns `undefined` when the output is not Codex JSONL — no line is an event
 * with a recognised Codex type — so it falls through to plain text. When it IS
 * Codex JSONL it returns the parsed events and the number of lines that could
 * not be read as one: a stream that is recognisably Codex but carries an
 * unreadable line is corrupt, never a plain-text answer to be scored.
 */
function codexStreamOf(lines) {
  const events = []
  let unreadable = 0
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      unreadable += 1
      continue
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      unreadable += 1
      continue
    }
    events.push(event)
  }
  if (!events.some(event => CODEX_EVENT_TYPES.has(event.type))) return undefined
  return { events, unreadable }
}

/**
 * The assistant's accepted final text from one invocation's raw stdout, or why
 * it could not be extracted.
 *
 * `ok: true` with `text: ''` is a real, successfully extracted empty report —
 * the assistant answered and said nothing, which is the expected answer on a
 * clean fixture and scores zero findings. `ok: false` means the invocation
 * produced no answer at all, which must fail the run rather than be normalised
 * into a clean zero-finding score.
 */
function extractAssistantText(stdout) {
  const source = typeof stdout === 'string' ? stdout : ''
  if (source.trim() === '') return { ok: false, reason: 'it wrote nothing to stdout' }
  const lines = source.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const stream = codexStreamOf(lines)
  // Not Codex JSONL: the whole stdout is the assistant text (`claude --print`,
  // and `codex exec` without `--json`).
  if (stream === undefined) return { ok: true, text: source }
  if (stream.unreadable > 0) {
    return { ok: false, reason: `its Codex JSONL stream carried ${stream.unreadable} unreadable line(s)` }
  }
  const failure = stream.events.find(event => CODEX_FAILURE_EVENTS.has(event.type))
  if (failure !== undefined) {
    return { ok: false, reason: `the turn failed with a Codex "${failure.type}" event` }
  }
  const messages = stream.events
    .filter(event => event.type === 'item.completed' && event.item?.type === CODEX_AGENT_MESSAGE && typeof event.item.text === 'string')
    .map(event => event.item.text)
  if (messages.length === 0) {
    return { ok: false, reason: `its Codex JSONL stream carried no item.completed ${CODEX_AGENT_MESSAGE} event` }
  }
  return { ok: true, text: messages.join('\n') }
}

function fail(message) {
  process.stderr.write(`benchmark: ${message}\n`)
  process.exit(1)
}

/** Parse `--flag value` pairs, the repeated `--arg` list, and the two boolean flags. */
function parseArgs(argv) {
  const args = { flags: new Set(), args: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--verify-fixtures' || token === '--write-manifest') {
      args.flags.add(token)
      continue
    }
    if (!token.startsWith('--')) fail(`unexpected argument "${token}"`)
    const value = argv[index + 1]
    // `--arg` is repeatable and its value is taken verbatim — a CLI flag such
    // as `--json` is exactly the argument it exists to carry.
    if (token === '--arg') {
      if (value === undefined) fail('--arg needs a value')
      args.args.push(value)
      index += 1
      continue
    }
    if (value === undefined || value.startsWith('--')) fail(`unknown flag or missing value for "${token}"`)
    args[token.slice(2)] = value
    index += 1
  }
  return args
}

/**
 * The exact argv a live scoring run spawns, or a refusal.
 *
 * Two spellings, never mixed: `--command <executable>` plus zero or more
 * `--arg <value>` elements, or `--command-json <json string array>` carrying
 * the whole argv including its executable. Both keep the prompt on stdin.
 */
function commandArgv(args) {
  if (args.command !== undefined && args['command-json'] !== undefined) {
    fail('refusing to run: pass either --command or --command-json, not both')
  }
  if (args.args.length > 0 && args.command === undefined) {
    fail('refusing to run: --arg supplies an argument for --command <executable>')
  }
  if (args['command-json'] !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(args['command-json'])
    } catch (error) {
      fail(`--command-json must be a JSON string array: ${String(error)}`)
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(entry => typeof entry !== 'string' || entry.length === 0)) {
      fail('--command-json must be a non-empty JSON array of non-empty strings')
    }
    return [...parsed]
  }
  if (args.command === undefined) return undefined
  return [args.command, ...args.args]
}

const canonicalFixture = fixture =>
  JSON.stringify({
    id: fixture.id,
    scope: fixture.scope,
    code: fixture.code,
    expected: fixture.expected,
    candidates: fixture.candidates,
  })

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
    if (!Array.isArray(fixture.candidates) || fixture.candidates.length === 0) {
      problems.push(`fixture "${fixture.id}" must offer a non-empty candidates list`)
    } else {
      if (new Set(fixture.candidates).size !== fixture.candidates.length) {
        problems.push(`fixture "${fixture.id}" repeats a candidate id`)
      }
      for (const id of fixture.expected) {
        if (!fixture.candidates.includes(id)) {
          problems.push(`fixture "${fixture.id}" expected finding "${id}" is missing from its candidates`)
        }
      }
    }
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
    if (JSON.stringify(entry.candidates) !== JSON.stringify(fixture.candidates)) {
      problems.push(`fixture "${entry.id}" candidates mismatch`)
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
      candidates: fixture.candidates,
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

/**
 * The deterministic prompt for one fixture.
 *
 * It states the report syntax, the scope, and the code, and it presents the
 * fixture's own `candidates` — the exact vocabulary the scorer accepts — so a
 * run measures whether the route found the seeded bug rather than whether it
 * guessed the identifier string. Each list mixes the ids that are present with
 * distractor ids that are plausible for the scope but absent from the code, and
 * the prompt never says which are which: the route still has to decide that
 * from the code, is told to report a candidate only when it actually finds it,
 * and is told an empty report is valid. A clean fixture's `expected` is empty
 * but its candidate list is not, so it presents distractors exactly like every
 * other fixture and a report of any of them is a false positive.
 */
function promptFor(fixture) {
  return [
    'Review the code below for the seeded known bugs.',
    'Report each finding on its own line exactly as: FINDING: <finding-id>',
    '',
    'Candidate finding ids for this fixture (report only ids from this list):',
    ...fixture.candidates.map(id => `- ${id}`),
    '',
    'Some of the candidate ids name bugs the code contains and some do not. Report a candidate id only if the code actually contains that bug. Do not report an id whose bug is absent, and do not report an id that is not on the list. If the code contains no candidate bug, report nothing — an empty report is a valid and expected answer.',
    '',
    `Scope: ${fixture.scope}`,
    'Code:',
    fixture.code,
  ].join('\n')
}

/** Spawn the explicitly selected route invocation with no shell and no fallback. */
function runCommand(argv, input) {
  return new Promise((resolveRun, rejectRun) => {
    const [executable, ...rest] = argv
    let child
    try {
      child = spawn(executable, rest, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      rejectRun(new Error(`could not start "${executable}": ${String(error?.message ?? error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => rejectRun(new Error(`could not start "${executable}": ${String(error?.message ?? error)}`)))
    child.on('close', code => code === 0
      ? resolveRun(stdout)
      : rejectRun(new Error(`command exited ${code}: ${safeExcerpt(stderr) || '<no stderr>'}`)))
    child.stdin.end(input)
  })
}

async function collect(fixtures, args, argv) {
  if (args.responses !== undefined) {
    const recorded = JSON.parse(await readFile(resolve(args.responses), 'utf8'))
    const responses = {}
    for (const fixture of fixtures) responses[fixture.id] = recorded[fixture.id] ?? []
    return { responses, latencyMs: numeric(args, 'latency-ms', 0) }
  }
  const started = Date.now()
  const responses = {}
  for (const fixture of fixtures) {
    const stdout = await runCommand(argv, promptFor(fixture))
    const extracted = extractAssistantText(stdout)
    if (!extracted.ok) {
      // Fail closed: a spawned invocation that exited 0 but yielded no
      // assistant text is a broken run, not a clean report. Scoring it would
      // normalise unparseable output into a zero-finding (clean) result.
      throw new Error(
        `fixture "${fixture.id}" produced no extractable assistant text: ${extracted.reason}. `
        + 'Expected Codex --json JSONL carrying an item.completed agent_message event, or plain text on stdout '
        + '(the whole output is the answer for claude --print and for codex exec without --json). '
        + `Diagnostic: ${safeExcerpt(stdout) || '<no stdout>'}`,
      )
    }
    // `ok: true` with empty text is a real answer that reported nothing — the
    // expected shape for a clean fixture — so it is scored, not failed.
    responses[fixture.id] = extracted.text
  }
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

/**
 * True when this file is the process entry point rather than an imported
 * module, so the extraction and scoring helpers can be imported and checked
 * directly (see the fix report's real-output proof) without the CLI driver
 * running and exiting the process.
 */
const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
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

  const missing = ['backend', 'model', 'effort', 'version'].filter(key => args[key] === undefined)
  if (missing.length > 0) {
    fail(`refusing to run: select an explicit route with ${missing.map(key => `--${key} <value>`).join(' ')}`)
  }
  if (args.version.trim() === '') {
    // R22: an empty backend version can never be admissible evidence, so writing
    // such a record would only produce a file the router must refuse.
    fail('refusing to run: --version must name the exact backend version the run measured (an empty version is never admissible evidence)')
  }
  const argv = commandArgv(args)
  if (args.responses === undefined && argv === undefined) {
    fail('refusing to run: pass --responses <file> for a recorded run, or --command <executable> [--arg <value> …] / --command-json <json argv> to invoke the selected route')
  }
  if (args.responses !== undefined && argv !== undefined) {
    fail('refusing to run: pass either --responses or --command/--command-json, not both')
  }

  let outcome
  try {
    outcome = await collect(fixtures, args, argv)
  } catch (error) {
    fail(`the selected route run failed: ${String(error?.message ?? error)}`)
  }
  const { responses, latencyMs } = outcome
  const result = score(fixtures, responses)
  const date = args.date ?? new Date().toISOString()
  const record = {
    id: `${args.backend}:${args.model}:${args.effort}:${date}`,
    suiteRevision: SUITE_REVISION,
    backend: args.backend,
    model: args.model,
    effort: args.effort,
    backendVersion: args.version,
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
}

export { extractAssistantText, findingsOf, safeExcerpt }
