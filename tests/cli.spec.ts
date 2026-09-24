/**
 * Host CLI adapter tests.
 *
 * Every test injects a fake DSH `SubprocessRuntime`. The fake records each
 * spawn spec exactly as the adapter passed it, then runs the fixture
 * executable in `tests/fixtures/` for real, so the adapter's version parsing,
 * JSONL/JSON result extraction, and failure classification are exercised
 * against documented CLI output shapes rather than re-implemented here. No
 * real Codex or Claude binary is ever started.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CliAdapter,
  CliError,
  MINIMUM_VERSIONS,
  claudeArgv,
  codexArgv,
  parseCliVersion,
  safeDiagnostic,
  safeExcerpt,
  type CliSubprocessPort,
} from '../src/host/cli.js'

const CWD = process.cwd()
const codexRoute = { kind: 'cli', cli: 'codex', model: 'gpt-6-sol', effort: 'high' } as const
const claudeRoute = { kind: 'cli', cli: 'claude', model: 'claude-sonnet-4-6', effort: 'high' } as const
const signal = () => new AbortController().signal

/* ------------------------------------------------------------------ *
 * Step 1: pinned version and protocol assertions.
 * ------------------------------------------------------------------ */

it.each([
  ['codex 0.156.1', 'codex', true],
  ['codex 0.157.0', 'codex', true],
  ['codex 0.156.0', 'codex', false],
  ['claude 2.1.280', 'claude', true],
  ['claude 2.1.279', 'claude', false],
] as const)('checks %s', (raw, cli, supported) => expect(parseCliVersion(raw, cli).supported).toBe(supported))
it.each(['v0.156.1 garbage', '\u001b[31munknown\u001b[0m', 'codex 1000.bad.1'])('rejects malformed %s', raw => {
  expect(() => parseCliVersion(raw, 'codex')).toThrow(/version/)
})
it('uses argv without a shell and preserves the chosen model and effort', () => {
  expect(codexArgv('/usr/bin/codex', 'gpt-6-sol', 'high', 'Reply OK')).toEqual([
    '/usr/bin/codex', 'exec', '--json', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', 'Reply OK',
  ])
  expect(claudeArgv('/usr/bin/claude', 'claude-sonnet-4-6', 'high', 'Reply OK')).toEqual([
    '/usr/bin/claude', '-p', 'Reply OK', '--output-format', 'json', '--model', 'claude-sonnet-4-6', '--effort', 'high',
  ])
})

it('compares numeric components, never strings or locales', () => {
  // Lexicographically "0.99.0" > "0.156.1"; numerically it is below the floor.
  expect(parseCliVersion('codex 0.99.0', 'codex').supported).toBe(false)
  expect(parseCliVersion('codex 0.1000.0', 'codex').supported).toBe(true)
  expect(parseCliVersion('claude 2.10.0', 'claude').supported).toBe(true)
  expect(parseCliVersion('claude 2.1.1000', 'claude').supported).toBe(true)
  expect(MINIMUM_VERSIONS).toEqual({ codex: '0.156.1', claude: '2.1.280' })
})

it('accepts a documented prerelease but never treats it as the released floor', () => {
  const parsed = parseCliVersion('codex 0.156.1-beta.2', 'codex')
  expect(parsed).toMatchObject({ version: '0.156.1', prerelease: 'beta.2', supported: false })
  expect(parseCliVersion('codex 0.157.0-rc.1', 'codex').supported).toBe(true)
})

it('rejects output that is not the selected product version', () => {
  expect(() => parseCliVersion('claude 2.1.280', 'codex')).toThrow(/version/)
  expect(() => parseCliVersion('\u001b[32mcodex 0.156.1\u001b[0m', 'codex')).toThrow(/version/)
  expect(() => parseCliVersion('codex 0.156.1 extra', 'codex')).toThrow(/version/)
  expect(() => parseCliVersion('', 'codex')).toThrow(/version/)
})

/* R21: real `claude --version` prints a bare `<semver> (Claude Code)`. */

it.each([
  ['2.1.280', true],
  ['2.1.300', true],
  ['2.1.280 (Claude Code)', true],
  ['2.1.300 (Claude Code)', true],
  ['2.1.279', false],
  ['2.1.279 (Claude Code)', false],
  ['2.1.300-rc.1 (Claude Code)', true],
  ['2.1.280-beta.2 (Claude Code)', false],
] as const)('accepts the real Claude Code version shape %s', (raw, supported) => {
  expect(parseCliVersion(raw, 'claude').supported).toBe(supported)
})

it('still accepts the plan-pinned product-prefixed Claude form', () => {
  expect(parseCliVersion('claude 2.1.280', 'claude')).toMatchObject({
    version: '2.1.280',
    prerelease: '',
    supported: true,
  })
  expect(parseCliVersion('claude 2.1.279', 'claude').supported).toBe(false)
})

it.each([
  '2.1.280 (Claude Code) extra',
  '2.1.280 (claude code)',
  '2.1.280 (Claude Code',
  '2.1.280(Claude Code)',
  '2.1.280 claude code',
  'v2.1.280 (Claude Code)',
] as const)('rejects a near-miss Claude product suffix %s', raw => {
  expect(() => parseCliVersion(raw, 'claude')).toThrow(/version/)
})

it('keeps the Codex contract product-prefixed and suffix-free', () => {
  expect(parseCliVersion('codex 0.157.0', 'codex').supported).toBe(true)
  expect(() => parseCliVersion('0.157.0', 'codex')).toThrow(/version/)
  expect(() => parseCliVersion('0.157.0 (Claude Code)', 'codex')).toThrow(/version/)
  expect(() => parseCliVersion('0.157.0 (Codex)', 'codex')).toThrow(/version/)
})

/* R36: real `codex --version` prints `codex-cli <semver>`. */

it.each([
  ['codex-cli 0.156.1', true],
  ['codex-cli 0.157.0', true],
  ['codex-cli 0.156.0', false],
  ['codex-cli 0.99.0', false],
  ['codex-cli 0.1000.0', true],
  ['codex-cli 0.157.0-rc.1', true],
  ['codex-cli 0.156.1-beta.2', false],
] as const)('accepts the real Codex CLI version shape %s', (raw, supported) => {
  expect(parseCliVersion(raw, 'codex').supported).toBe(supported)
})

it('still accepts the plan-pinned product-prefixed Codex form', () => {
  expect(parseCliVersion('codex 0.156.1', 'codex')).toMatchObject({
    version: '0.156.1',
    prerelease: '',
    supported: true,
  })
  expect(parseCliVersion('codex 0.156.0', 'codex').supported).toBe(false)
})

it.each([
  'codex-cli 0.156.1 extra',
  'codex-cli0.156.1',
  'codex-cli  0.156.1',
  'Codex-cli 0.156.1',
  'codex-cli v0.156.1',
  'codex-cli 0.156.1 (Codex)',
  'xcodex-cli 0.156.1',
] as const)('rejects a near-miss Codex product prefix %s', raw => {
  expect(() => parseCliVersion(raw, 'codex')).toThrow(/version/)
})

it('rejects the real Codex shape for the Claude product', () => {
  expect(() => parseCliVersion('codex-cli 0.156.1', 'claude')).toThrow(/version/)
})

/* M2: the fixtures' raw `--version` stdout is the input the adapter parses, so
 * it is pinned here verbatim. Without this, reverting a fixture to the
 * plan-pinned shape (`codex 0.156.1`, `2.1.280`) would keep every other
 * assertion in this suite green — the defect class behind R21 and R36. */

/** Run one fixture executable directly and return its stdout, verbatim. */
function fixtureStdout(fixture: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))
    const child = spawn(process.execPath, [executable, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.once('error', reject)
    child.once('close', () => resolve(stdout))
  })
}

it.each([
  ['fake-codex.mjs', 'codex', 'codex-cli 0.156.1', '0.156.1'],
  ['fake-claude.mjs', 'claude', '2.1.280 (Claude Code)', '2.1.280'],
] as const)('prints the real --version stdout from %s', async (fixture, cli, expected, version) => {
  const stdout = await fixtureStdout(fixture, '--version')
  expect(stdout).toBe(`${expected}\n`)
  // The pinned line is exactly what the real parser accepts.
  expect(parseCliVersion(stdout.trim(), cli)).toMatchObject({ version, prerelease: '', supported: true })
})

it('strips ANSI from the diagnostic and reports invalid-version', () => {
  const failure: unknown = (() => {
    try {
      parseCliVersion('\u001b[31munknown\u001b[0m', 'codex')
      return undefined
    } catch (error) {
      return error
    }
  })()
  expect(failure).toBeInstanceOf(CliError)
  expect(failure).toMatchObject({ code: 'invalid-version' })
  expect((failure as CliError).diagnostic).not.toContain('\u001b')
})

/* ------------------------------------------------------------------ *
 * Fake DSH subprocess runtime.
 * ------------------------------------------------------------------ */

/** One recorded spawn spec, copied out of the adapter's own call. */
interface FakeSpawn {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: SubprocessSpawnSpec['stdio']
  readonly graceMs: number
  readonly signal: AbortSignal | undefined
}

interface FakeSubprocess extends CliSubprocessPort {
  readonly started: FakeSpawn[]
  readonly resolved: string[]
  setMode(mode: string): void
  setEnv(env: Readonly<Record<string, string>>): void
}
/** Bounded tail collection with the DSH collect-mode `readFrom` semantics. */
function collectStream(stream: NodeJS.ReadableStream, maxBytes: number) {
  let buffer = Buffer.alloc(0)
  let dropped = 0
  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > maxBytes) {
      dropped += buffer.length - maxBytes
      buffer = buffer.subarray(buffer.length - maxBytes)
    }
  })
  return {
    readFrom(fromByte: number) {
      const start = Math.max(0, fromByte - dropped)
      return {
        text: buffer.subarray(start).toString('utf8'),
        nextOffset: dropped + buffer.length,
        lossy: fromByte < dropped,
      }
    },
  }
}

/**
 * Build a fake `SubprocessRuntime` that runs the fixture executable for real.
 *
 * `resolveExecutable` mirrors the documented contract (absolute paths pass
 * through, bare names resolve to a path that still names the product), and
 * `spawn` runs the fixture under the current Node binary so no Codex or Claude
 * binary is ever started. `ORC_FAKE_MODE` and friends select fixture
 * behaviour; `started` records the exact spec the adapter passed.
 */
function fakeSubprocess(options: {
  selected: 'codex' | 'claude'
  mode?: string
  env?: Readonly<Record<string, string>>
  /** Simulate the provider's bounded tail: collect fewer stdout bytes than the spec cap. */
  stdoutTailBytes?: number
}): FakeSubprocess {
  const started: FakeSpawn[] = []
  const resolved: string[] = []
  let mode = options.mode ?? 'ok'
  let env: Record<string, string> = { ...options.env }

  const fixtureFor = (executable: string): string => {
    if (executable.includes('codex')) return 'fake-codex.mjs'
    if (executable.includes('claude')) return 'fake-claude.mjs'
    throw new Error(`fake subprocess refuses to run "${executable}"`)
  }

  return {
    started,
    resolved,
    setMode: (next) => {
      mode = next
    },
    setEnv: (next) => {
      env = { ...env, ...next }
    },
    resolveExecutable: async (command: string) => {
      resolved.push(command)
      return command.includes('/') ? command : `/fake/bin/${command}`
    },
    spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
      // The documented seam throws synchronously before handle creation.
      if (spec.signal?.aborted === true) throw new Error('fake subprocess refuses a pre-aborted spawn')
      started.push({ argv: spec.argv, cwd: spec.cwd, stdio: spec.stdio, graceMs: spec.graceMs, signal: spec.signal })
      const fixture = fileURLToPath(new URL(`./fixtures/${fixtureFor(spec.argv[0])}`, import.meta.url))
      const child = spawn(process.execPath, [fixture, ...spec.argv.slice(1)], {
        cwd: spec.cwd,
        env: { ...process.env, ORC_FAKE_MODE: mode, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (child.stdout === null || child.stderr === null) throw new Error('fake subprocess failed to pipe stdio')
      const stdout = collectStream(child.stdout, options.stdoutTailBytes ?? 1_048_576)
      const stderr = collectStream(child.stderr, 16_384)
      const done = new Promise<SubprocessOutcome>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal }))
      })
      spec.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout, stderr },
        done,
        terminate: () => {
          child.kill('SIGTERM')
        },
        waitForExit: async () => {
          await done.then(() => undefined, () => undefined)
          return true
        },
      }
    },
  }
}

/** How many harmless runs (as opposed to probes) were started. */
const execRuns = (subprocess: FakeSubprocess): number =>
  subprocess.started.filter(spec => spec.argv[1] === 'exec' || spec.argv[1] === '-p').length

/** Poll until the fake child reaches an observable state. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fake CLI did not reach the expected state')
}

/* ------------------------------------------------------------------ *
 * Process boundary: explicit argv, pinned spec, no shell, no other binary.
 * ------------------------------------------------------------------ */

it('spawns only the selected executable with the pinned subprocess spec', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const controller = new AbortController()
  await new CliAdapter(subprocess).probe(codexRoute, undefined, controller.signal)
  const first = subprocess.started[0]
  expect(first.argv).toEqual(['/fake/bin/codex', '--version'])
  expect(first.cwd).toBe(CWD)
  expect(first.stdio).toEqual({ stdin: 'ignore', stdout: { maxBytes: 1_048_576 }, stderr: { maxBytes: 16_384 } })
  expect(first.graceMs).toBe(5_000)
  expect(first.signal).toBe(controller.signal)
  expect(subprocess.resolved).toEqual(['codex'])
  expect(subprocess.started.every(spec => spec.argv[0].includes('codex'))).toBe(true)
})

it.each([
  ['codex', codexRoute, '0.156.1', 'chatgpt'],
  ['claude', claudeRoute, '2.1.280', 'claudeai'],
] as const)('probes %s with the documented commands and a live capability run', async (cli, route, version, method) => {
  const subprocess = fakeSubprocess({ selected: cli, mode: 'ok' })
  const probe = await new CliAdapter(subprocess).probe(route, undefined, signal())
  expect(probe).toMatchObject({ cli, executable: `/fake/bin/${cli}`, version, model: route.model, effort: route.effort })
  expect(probe.auth.method).toBe(method)
  expect(probe.revision).toMatch(/^[0-9a-f]{64}$/)
  const invocations = subprocess.started.map(spec => spec.argv.slice(1).join(' '))
  expect(invocations).toContain('--version')
  expect(invocations).toContain(cli === 'codex' ? 'login status' : 'auth status')
  expect(invocations.some(line => line.startsWith(cli === 'codex' ? 'exec --json' : '-p '))).toBe(true)
})

it.each([
  ['codex', codexRoute, 'newer'],
  ['claude', claudeRoute, 'newer'],
] as const)('accepts a compatible newer %s version after the live probe', async (cli, route, mode) => {
  const probe = await new CliAdapter(fakeSubprocess({ selected: cli, mode })).probe(route, undefined, signal())
  expect(probe.version).toBe(cli === 'codex' ? '0.157.0' : '2.1.300')
})

it.each([
  ['codex', codexRoute, 'ansi-version'],
  ['codex', codexRoute, 'numeric-version'],
  ['claude', claudeRoute, 'ansi-version'],
  ['claude', claudeRoute, 'numeric-version'],
] as const)('rejects malformed %s version output with invalid-version (%s)', async (cli, route, mode) => {
  await expect(new CliAdapter(fakeSubprocess({ selected: cli, mode })).probe(route, undefined, signal()))
    .rejects.toMatchObject({ code: 'invalid-version' })
})

it.each([
  ['below-floor', 'unsupported-version'],
  ['bad-version', 'invalid-version'],
  ['auth-fail', 'authentication'],
  ['bad-protocol', 'unsupported-protocol'],
  ['bad-json', 'invalid-result'],
  ['quota', 'quota'],
] as const)('blocks %s', async (mode, code) => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode })
  await expect(new CliAdapter(subprocess).probe(codexRoute, undefined, new AbortController().signal))
    .rejects.toMatchObject({ code })
  expect(subprocess.started.every(p => p.argv[0].includes('codex'))).toBe(true)
})

it.each([
  ['below-floor', 'unsupported-version'],
  ['bad-version', 'invalid-version'],
  ['auth-fail', 'authentication'],
  ['bad-protocol', 'unsupported-protocol'],
  ['bad-json', 'invalid-result'],
  ['quota', 'quota'],
] as const)('blocks Claude %s', async (mode, code) => {
  const subprocess = fakeSubprocess({ selected: 'claude', mode })
  await expect(new CliAdapter(subprocess).probe(claudeRoute, undefined, new AbortController().signal))
    .rejects.toMatchObject({ code })
  expect(subprocess.started.every(p => p.argv[0].includes('claude'))).toBe(true)
})

it('refuses to dispatch without a prior green probe', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  await expect(new CliAdapter(subprocess).run(codexRoute, undefined, 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
  expect(execRuns(subprocess)).toBe(0)
})

it('rejects a nonzero version probe instead of guessing a version', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'version-fail' })
  await expect(new CliAdapter(subprocess).probe(codexRoute, undefined, signal()))
    .rejects.toMatchObject({ code: 'invalid-version' })
})

it('rejects a truncated version line rather than parsing a lossy read', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok', stdoutTailBytes: 4 })
  await expect(new CliAdapter(subprocess).probe(codexRoute, undefined, signal()))
    .rejects.toMatchObject({ code: 'invalid-version' })
})

it('rejects lossy protocol output instead of parsing a truncated record', async () => {
  // The provider keeps only the tail once a stream exceeds its cap, so a
  // truncated JSONL/JSON record must never be accepted as a result.
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok', stdoutTailBytes: 64 })
  await expect(new CliAdapter(subprocess).probe(codexRoute, undefined, signal()))
    .rejects.toMatchObject({ code: 'invalid-result' })
})

/* ------------------------------------------------------------------ *
 * Cancellation.
 * ------------------------------------------------------------------ */

it('aborts a waiting CLI child and observes its managed range empty', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'cancel' })
  const controller = new AbortController()
  const handle = subprocess.spawn({
    argv: ['/fake/bin/codex', 'exec', '--json', 'Reply OK'],
    cwd: CWD,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1_048_576 }, stderr: { maxBytes: 16_384 } },
    graceMs: 5_000,
    signal: controller.signal,
  })
  controller.abort()
  await expect(handle.waitForExit()).resolves.toBe(true)
})

it('rejects a probe whose waiting child is cancelled instead of reporting a result', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'cancel' })
  const controller = new AbortController()
  const pending = new CliAdapter(subprocess).probe(codexRoute, undefined, controller.signal)
  await until(() => execRuns(subprocess) === 1)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})

it('propagates an already-aborted signal as cancellation, not as a CLI fault', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const controller = new AbortController()
  controller.abort()
  const failure: unknown = await new CliAdapter(subprocess).probe(codexRoute, undefined, controller.signal)
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(CliError)
  expect((failure as Error).name).toBe('AbortError')
  expect(subprocess.started).toEqual([])
})

/* ------------------------------------------------------------------ *
 * Result extraction.
 * ------------------------------------------------------------------ */

it('returns the final Codex agent message only after turn completion', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'two-messages' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, undefined, signal())
  await expect(adapter.run(codexRoute, undefined, 'review this', CWD, signal())).resolves.toBe('second')
  expect(subprocess.started.at(-1)?.argv).toEqual([
    '/fake/bin/codex', 'exec', '--json', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', 'review this',
  ])
})

it('returns the Claude result only for a successful completion status', async () => {
  const subprocess = fakeSubprocess({ selected: 'claude', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(claudeRoute, undefined, signal())
  await expect(adapter.run(claudeRoute, undefined, 'review this', CWD, signal())).resolves.toBe('OK')
  expect(subprocess.started.at(-1)?.argv).toEqual([
    '/fake/bin/claude', '-p', 'review this', '--output-format', 'json', '--model', 'claude-sonnet-4-6', '--effort', 'high',
  ])
})

it.each([
  ['no-turn-completed', 'invalid-result'],
  ['no-message', 'invalid-result'],
  ['bad-json', 'invalid-result'],
  ['bad-protocol', 'unsupported-protocol'],
  ['quota', 'quota'],
  ['leaky', 'authentication'],
] as const)('keeps a failing Codex run after a green probe a task failure (%s)', async (runMode, code) => {
  const subprocess = fakeSubprocess({
    selected: 'codex',
    mode: 'ok',
    env: { ORC_FAKE_RUN_PROMPT: 'review this', ORC_FAKE_RUN_MODE: runMode },
  })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, undefined, signal())
  await expect(adapter.run(codexRoute, undefined, 'review this', CWD, signal())).rejects.toMatchObject({ code })
  expect(subprocess.started.every(spec => spec.argv[0].includes('codex'))).toBe(true)
})

it.each([
  ['error-success', 'invalid-result'],
  ['empty-result', 'invalid-result'],
  ['bad-json', 'invalid-result'],
  ['bad-protocol', 'unsupported-protocol'],
  ['quota', 'quota'],
  ['leaky', 'authentication'],
] as const)('keeps a failing Claude run after a green probe a task failure (%s)', async (runMode, code) => {
  const subprocess = fakeSubprocess({
    selected: 'claude',
    mode: 'ok',
    env: { ORC_FAKE_RUN_PROMPT: 'review this', ORC_FAKE_RUN_MODE: runMode },
  })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(claudeRoute, undefined, signal())
  await expect(adapter.run(claudeRoute, undefined, 'review this', CWD, signal())).rejects.toMatchObject({ code })
  expect(subprocess.started.every(spec => spec.argv[0].includes('claude'))).toBe(true)
})

it('refuses a Claude record whose completion status contradicts is_error', async () => {
  await expect(new CliAdapter(fakeSubprocess({ selected: 'claude', mode: 'error-success' }))
    .probe(claudeRoute, undefined, signal())).rejects.toMatchObject({ code: 'invalid-result' })
})

it('refuses an empty Claude result', async () => {
  await expect(new CliAdapter(fakeSubprocess({ selected: 'claude', mode: 'empty-result' }))
    .probe(claudeRoute, undefined, signal())).rejects.toMatchObject({ code: 'invalid-result' })
})

it('refuses a Claude record with no completion status', async () => {
  await expect(new CliAdapter(fakeSubprocess({ selected: 'claude', mode: 'no-subtype' }))
    .probe(claudeRoute, undefined, signal())).rejects.toMatchObject({ code: 'invalid-result' })
})

/* ------------------------------------------------------------------ *
 * Diagnostics: credential-free and path-redacted.
 * ------------------------------------------------------------------ */

it('redacts token-shaped data and paths outside the selected executable', async () => {
  const failure: unknown = await new CliAdapter(fakeSubprocess({ selected: 'codex', mode: 'leaky' }))
    .probe(codexRoute, undefined, signal())
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(CliError)
  expect(failure).toMatchObject({ code: 'authentication' })
  const diagnostic = (failure as CliError).diagnostic
  expect(diagnostic).not.toContain('sk-test-secret')
  expect(diagnostic).not.toContain('/Users/someone')
  expect(diagnostic).toContain('<redacted>')
  expect(JSON.stringify(failure)).not.toContain('sk-test-secret')
})

it('redacts a secret even when the failing run follows a green probe', async () => {
  const subprocess = fakeSubprocess({
    selected: 'claude',
    mode: 'ok',
    env: { ORC_FAKE_RUN_PROMPT: 'review this', ORC_FAKE_RUN_MODE: 'leaky' },
  })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(claudeRoute, undefined, signal())
  const failure: unknown = await adapter.run(claudeRoute, undefined, 'review this', CWD, signal())
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code: 'authentication' })
  expect((failure as CliError).diagnostic).not.toContain('sk-test-secret')
  expect((failure as CliError).diagnostic).not.toContain('/Users/someone')
})

it('keeps the selected executable and redacts every other path', () => {
  expect(safeDiagnostic('key sk-test-secret at /Users/someone/.codex/auth.json', '/usr/bin/codex'))
    .toBe('key <redacted> at <path>')
  expect(safeDiagnostic('cannot start /usr/bin/codex', '/usr/bin/codex')).toBe('cannot start /usr/bin/codex')
  expect(safeDiagnostic('\u001b[31mboom\u001b[0m')).toBe('boom')
  expect(safeDiagnostic('Bearer abcdefghijklmnop')).toBe('<redacted>')
})

it('bounds an excerpt of raw output for a failure diagnostic', () => {
  // R37: an unparseable stage answer is surfaced as a bounded, redacted
  // excerpt, never as the model's whole reply.
  const tail = 'TAIL-MARKER'
  const excerpt = safeExcerpt(`sk-test-secret at /Users/someone/notes.md\n\n${'word '.repeat(200)}${tail}`)
  expect(excerpt).toContain('<redacted>')
  expect(excerpt).toContain('<path>')
  expect(excerpt).not.toContain(tail)
  expect(excerpt).not.toContain('\n')
  expect(excerpt.length).toBeLessThanOrEqual(201)
  // Short answers are carried whole.
  expect(safeExcerpt('No findings')).toBe('No findings')
})

it('returns a credential-free probe for an API-key account', async () => {
  const probe = await new CliAdapter(fakeSubprocess({ selected: 'codex', mode: 'auth-apikey' }))
    .probe(codexRoute, undefined, signal())
  expect(probe.auth).toEqual({ method: 'api-key', accountFingerprint: '' })
  const serialized = JSON.stringify(probe)
  expect(serialized).not.toContain('sk-')
  expect(serialized).not.toMatch(/token|secret|password/i)
})

it('fingerprints the account identity without exposing it', async () => {
  const probe = await new CliAdapter(fakeSubprocess({ selected: 'claude', mode: 'ok' }))
    .probe(claudeRoute, undefined, signal())
  expect(probe.auth.method).toBe('claudeai')
  expect(probe.auth.accountFingerprint).toMatch(/^[0-9a-f]{16}$/)
  expect(JSON.stringify(probe)).not.toContain('dev@example.com')
})

/* ------------------------------------------------------------------ *
 * Catalog: only configured pairs that passed a live capability probe.
 * ------------------------------------------------------------------ */

const catalogRoutes = [
  { kind: 'cli', cli: 'codex', model: 'gpt-6-sol', effort: 'high' },
  { kind: 'cli', cli: 'codex', model: 'gpt-6-sol', effort: 'low' },
] as const

it('admits only the configured model/effort pair that passes its live probe', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok', env: { ORC_FAKE_REJECT_EFFORT: 'low' } })
  const snapshot = await new CliAdapter(subprocess).catalog('codex', catalogRoutes, signal())
  expect(snapshot.entries).toEqual([{
    routeKey: 'cli:codex:gpt-6-sol:high',
    backendVersion: '0.156.1',
    model: 'gpt-6-sol',
    efforts: ['high'],
    accountAccess: true,
    sourceUrl: '',
    retrievedAt: snapshot.observedAt,
  }])
  expect(snapshot.id).toBe(`codex@${snapshot.observedAt}`)
  // No undocumented full-account enumeration: only the documented version,
  // auth-status, and harmless-run invocations were ever started.
  const shapes = subprocess.started.map(spec => spec.argv.slice(1).join(' '))
  expect(shapes.every(shape => shape === '--version' || shape === 'login status' || shape.startsWith('exec --json'))).toBe(true)
  expect(subprocess.resolved).toEqual(['codex', 'codex'])
})

it('catalogs nothing when no configured pair passes its live probe', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'auth-fail' })
  const snapshot = await new CliAdapter(subprocess).catalog('codex', catalogRoutes, signal())
  expect(snapshot.entries).toEqual([])
  expect(snapshot.id).toBe(`codex@${snapshot.observedAt}`)
})

it('ignores configured routes for the other CLI', async () => {
  const subprocess = fakeSubprocess({ selected: 'claude', mode: 'ok' })
  const snapshot = await new CliAdapter(subprocess).catalog('claude', catalogRoutes, signal())
  expect(snapshot.entries).toEqual([])
  expect(subprocess.started).toEqual([])
})

/* ------------------------------------------------------------------ *
 * Revision: a green probe is bound to path, version, and account.
 * ------------------------------------------------------------------ */

it('dispatches normally when the green probe still matches', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, undefined, signal())
  await expect(adapter.run(codexRoute, undefined, 'review', CWD, signal())).resolves.toBe('OK')
  expect(execRuns(subprocess)).toBe(2)
})

it('invalidates a green probe when the executable path changes', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, '/fake/bin/codex', signal())
  const dispatched = execRuns(subprocess)
  await expect(adapter.run(codexRoute, '/other/bin/codex', 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
  expect(execRuns(subprocess)).toBe(dispatched)
})

it('invalidates a green probe when the parsed CLI version changes', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, undefined, signal())
  subprocess.setEnv({ ORC_FAKE_VERSION: 'codex-cli 0.157.0' })
  const dispatched = execRuns(subprocess)
  await expect(adapter.run(codexRoute, undefined, 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
  expect(execRuns(subprocess)).toBe(dispatched)
})

it('invalidates a green probe when the auth method changes', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  await adapter.probe(codexRoute, undefined, signal())
  subprocess.setMode('auth-apikey')
  const dispatched = execRuns(subprocess)
  await expect(adapter.run(codexRoute, undefined, 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
  expect(execRuns(subprocess)).toBe(dispatched)
})

it('invalidates a green probe when the account fingerprint changes', async () => {
  const subprocess = fakeSubprocess({ selected: 'claude', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  const green = await adapter.probe(claudeRoute, undefined, signal())
  subprocess.setMode('auth-other-account')
  const dispatched = execRuns(subprocess)
  await expect(adapter.run(claudeRoute, undefined, 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
  expect(execRuns(subprocess)).toBe(dispatched)
  // The changed account really does move the revision, not just the run.
  const changed = await adapter.probe(claudeRoute, undefined, signal())
  expect(changed.auth.accountFingerprint).not.toBe(green.auth.accountFingerprint)
  expect(changed.revision).not.toBe(green.revision)
})

it('keeps a green probe and a stale probe separate per route', async () => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode: 'ok' })
  const adapter = new CliAdapter(subprocess)
  const low = { kind: 'cli', cli: 'codex', model: 'gpt-6-sol', effort: 'low' } as const
  await adapter.probe(codexRoute, undefined, signal())
  await expect(adapter.run(low, undefined, 'review', CWD, signal()))
    .rejects.toMatchObject({ code: 'unsupported-protocol' })
})
