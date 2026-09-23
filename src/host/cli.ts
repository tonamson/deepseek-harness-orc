/**
 * ORC host CLI adapter.
 *
 * The bridge from an ORC {@link CliRoute} to the user's own installed Codex CLI
 * or Claude Code CLI. Subscription-mode work reaches the executable the user
 * already has; ORC never installs, reconfigures, or drives a DSH-pinned
 * Codex/Claude runtime, and it never stores CLI credentials or edits native CLI
 * configuration.
 *
 * Rules that shape the code:
 *
 * - Only the selected CLI is required, resolved, and started. There is no
 *   fallback to the other CLI, to a packaged runtime, or to an API provider.
 * - A green probe is bound to the exact executable path, parsed version, and
 *   auth/account fingerprint it observed. {@link CliAdapter.run} re-inspects
 *   that identity and refuses a result whose revision moved, so a changed path,
 *   version, or account invalidates the probe before dispatch.
 * - Discovery of an executable is not proof of an active subscription. The
 *   probe runs the documented auth-status command and one live harmless run;
 *   only that live run admits a configured model/effort pair to the catalog.
 * - Every failure is a fixed ORC-owned code plus a redacted diagnostic. No
 *   token, no credential, and no path outside the selected executable reaches
 *   the caller.
 */

import { createHash } from 'node:crypto'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { routeKey } from '../domain/config.js'
import type { CatalogEntry, CatalogSnapshot, CliName, CliRoute } from '../domain/types.js'

/**
 * Failure codes safe to surface. Each is a fixed ORC-owned string; the raw CLI
 * payload only ever reaches the caller through a redacted `diagnostic`.
 *
 * `unsupported-protocol` is the fail-closed bucket for "the selected CLI cannot
 * provide what ORC requires right now": an executable that cannot be resolved
 * or started, a capability the account does not accept, and a green probe whose
 * executable/version/account revision has moved. The six-code contract has no
 * separate code for those, and each one must block the selected stage.
 */
export type CliErrorCode =
  | 'unsupported-version'
  | 'invalid-version'
  | 'authentication'
  | 'unsupported-protocol'
  | 'invalid-result'
  | 'quota'

/** A CLI failure carrying an ORC-safe code and a credential-free diagnostic. */
export class CliError extends Error {
  readonly code: CliErrorCode
  /** ANSI-free, token-free, path-redacted excerpt of the CLI output. */
  readonly diagnostic: string

  constructor(code: CliErrorCode, message: string, diagnostic = '') {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.diagnostic = diagnostic
  }
}

/** The minimum released version ORC accepts for each host CLI. */
export const MINIMUM_VERSIONS: Readonly<Record<CliName, string>> = {
  codex: '0.156.1',
  claude: '2.1.280',
}

/**
 * The exact harmless prompt the live capability probe sends. The settings
 * surface warns that probing a CLI may consume subscription quota.
 */
const PROBE_PROMPT = 'Reply OK'

const MAX_STDOUT_BYTES = 1_048_576
const MAX_STDERR_BYTES = 16_384
const PROBE_GRACE_MS = 5_000

/**
 * The subprocess surface this adapter consumes. `ctx.subprocess`
 * (`SubprocessRuntime`) satisfies it structurally; tests supply a fake.
 */
export type CliSubprocessPort = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

/** One parsed host CLI version, with the support verdict already applied. */
export interface ParsedCliVersion {
  readonly cli: CliName
  /** Normalized `major.minor.patch`. */
  readonly version: string
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Documented prerelease suffix, or `''`. */
  readonly prerelease: string
  /** Whether the released version meets the CLI's minimum. */
  readonly supported: boolean
}

/** The credential-free authentication facts the CLI reports. */
export interface CliAuth {
  /** Documented auth method: `chatgpt`, `api-key`, `claudeai`, `none`, … */
  readonly method: string
  /**
   * Stable digest of the account identity the CLI reports, or `''` when the
   * documented interface exposes none. Never the identity itself.
   */
  readonly accountFingerprint: string
}

/** One green probe: everything a later dispatch is bound to. */
export interface CliProbe {
  /** Exact {@link CliRoute} key this probe describes. */
  readonly routeKey: string
  readonly cli: CliName
  /** Canonical executable path the selected CLI resolved to. */
  readonly executable: string
  /** Parsed, supported version of that executable. */
  readonly version: string
  readonly auth: CliAuth
  /** Model whose live capability run succeeded. */
  readonly model: string
  /** Effort whose live capability run succeeded. */
  readonly effort: string
  /** Exact account/path/version revision a dispatch is bound to. */
  readonly revision: string
  readonly testedAt: string
}

/**
 * A full product-prefixed semantic version with an optional documented
 * prerelease. Nothing else is accepted: a leading `v`, trailing text, ANSI
 * noise, and non-numeric components are all malformed output.
 */
const VERSION_PATTERN = /^(codex|claude) (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/

/** SGR/CSI escape sequences. Stripped for diagnostics only, never for parsing. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g

const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '')

/**
 * Credential-shaped values. The Codex CLI already masks API keys before
 * printing them, but a masked `sk-proj-***ABCDE` is still token-shaped and must
 * not survive into a diagnostic.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_*-]{3,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
]

/** Absolute POSIX, `~`-relative, and Windows paths, up to the first delimiter. */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|~?\/)[^\s"'`,;:)\]}]+/g

/**
 * Reduce raw CLI output to a diagnostic that is safe to surface: ANSI-free,
 * token-free, and with every path except the selected executable replaced.
 * Without an executable the redaction is strictly stronger.
 */
export function safeDiagnostic(text: string, executable = ''): string {
  let safe = stripAnsi(text)
  for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, '<redacted>')
  safe = safe.replace(
    ABSOLUTE_PATH_PATTERN,
    match => (executable !== '' && (match === executable || match.startsWith(`${executable}/`)) ? match : '<path>'),
  )
  return safe.trim()
}

/** Compare three numeric version components; never a string or locale compare. */
function compareComponents(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

/** Numeric floor comparison, with a prerelease never counting as the release. */
function atOrAbove(parts: readonly number[], floor: readonly number[], prerelease: string): boolean {
  const order = compareComponents(parts, floor)
  if (order !== 0) return order > 0
  return prerelease === ''
}

/**
 * Parse one `--version` line for the selected CLI.
 *
 * Only a full product-prefixed semantic version is accepted, and the product
 * must be the selected CLI. The verdict compares numeric components, so a
 * lexicographically larger `0.99.0` is still below `0.156.1`.
 *
 * @throws {CliError} `invalid-version` when the output is malformed.
 */
export function parseCliVersion(raw: string, cli: CliName): ParsedCliVersion {
  const text = raw.trim()
  const match = VERSION_PATTERN.exec(text)
  if (match === null || match[1] !== cli) {
    throw new CliError(
      'invalid-version',
      `unrecognized ${cli} version output`,
      safeDiagnostic(text),
    )
  }
  const [, , major, minor, patch, prerelease = ''] = match
  const parts = [Number(major), Number(minor), Number(patch)]
  const floor = MINIMUM_VERSIONS[cli].split('.').map(Number)
  return {
    cli,
    version: `${major}.${minor}.${patch}`,
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease,
    supported: atOrAbove(parts, floor, prerelease),
  }
}

/**
 * Codex non-interactive argv. An explicit array, never a shell string, and the
 * selected model and reasoning effort are preserved verbatim.
 */
export const codexArgv = (path: string, model: string, effort: string, prompt: string): string[] => [
  path, 'exec', '--json', '--model', model, '-c', `model_reasoning_effort="${effort}"`, prompt,
]

/**
 * Claude Code non-interactive argv. An explicit array, never a shell string,
 * and the selected model and effort are preserved verbatim.
 */
export const claudeArgv = (path: string, model: string, effort: string, prompt: string): string[] => [
  path, '-p', prompt, '--output-format', 'json', '--model', model, '--effort', effort,
]

/** One collected child run: exit facts plus both collected streams. */
interface CliOutput {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stdoutLossy: boolean
  readonly stderr: string
  readonly stderrLossy: boolean
}

/**
 * A structured reading of one non-interactive run.
 *
 * `failed` is a CLI-reported failure (Codex `turn.failed`, Claude a
 * non-success completion status) and carries the CLI's own reason so it can be
 * classified. `invalid` is an unusable record — unparseable output, no
 * completion, a self-contradictory status, or no accepted final text — and is
 * always `invalid-result`.
 */
type CliRunReading =
  | { readonly kind: 'accepted'; readonly text: string }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly detail: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** First non-empty trimmed line, so a version may arrive on stdout or stderr. */
function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/** Reduce a CLI-reported failure reason to one of the six ORC-safe codes. */
function classifyFailure(text: string): CliErrorCode {
  const lower = text.toLowerCase()
  if (/quota|rate.?limit|usage limit|too many requests|insufficient|billing|credit|payment/.test(lower)) return 'quota'
  if (/unauthor|forbidden|authenticat|\bauth|oauth|not logged in|logged out|credential|api key|subscription|entitle|sign in|login|expired/.test(lower)) return 'authentication'
  return 'unsupported-protocol'
}

/**
 * Read Codex JSONL: the accepted text is the final `item.completed` agent
 * message, and only a completed turn makes it a result. A `turn.failed` or
 * stream `error` event is a failure; a non-fatal `item.completed` error item is
 * not (Codex surfaces warnings that way).
 */
function readCodexRun(stdout: string): CliRunReading {
  let finalMessage: string | undefined
  let turnCompleted = false
  let failure = ''
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return { kind: 'invalid', detail: line }
    }
    if (!isRecord(event)) return { kind: 'invalid', detail: line }
    if (event.type === 'item.completed') {
      const item = event.item
      if (isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
        finalMessage = item.text
      }
    } else if (event.type === 'turn.completed') {
      turnCompleted = true
    } else if (event.type === 'turn.failed') {
      const error = event.error
      failure = isRecord(error) && typeof error.message === 'string' ? error.message : 'turn failed'
    } else if (event.type === 'error') {
      failure = typeof event.message === 'string' ? event.message : 'stream error'
    }
  }
  if (failure !== '') return { kind: 'failed', detail: failure }
  if (!turnCompleted) return { kind: 'invalid', detail: 'the turn did not complete' }
  if (finalMessage === undefined || finalMessage.length === 0) {
    return { kind: 'invalid', detail: 'no accepted final agent message' }
  }
  return { kind: 'accepted', text: finalMessage }
}

/**
 * Read Claude's single JSON result record: `result` is accepted only when the
 * completion status is successful. A successful status paired with `is_error`
 * is self-contradictory and is never accepted.
 */
function readClaudeRun(stdout: string): CliRunReading {
  let payload: unknown
  try {
    payload = JSON.parse(stdout.trim())
  } catch {
    return { kind: 'invalid', detail: stdout.trim() }
  }
  if (!isRecord(payload) || payload.type !== 'result') {
    return { kind: 'invalid', detail: 'no result record' }
  }
  const text = typeof payload.result === 'string' ? payload.result : ''
  if (typeof payload.subtype !== 'string') return { kind: 'invalid', detail: 'no completion status' }
  if (payload.subtype === 'success') {
    // Accept only an explicit `false`/absent error flag: a `true`, a string, or
    // any other value contradicts the successful status.
    if (payload.is_error !== undefined && payload.is_error !== false) {
      return { kind: 'invalid', detail: text }
    }
    if (text.length === 0) return { kind: 'invalid', detail: 'empty result' }
    return { kind: 'accepted', text }
  }
  return { kind: 'failed', detail: text !== '' ? text : `result subtype ${String(payload.subtype)}` }
}

/** Stable digest of the account identity, so no identity is ever surfaced. */
const fingerprint = (identity: string): string =>
  createHash('sha256').update(identity).digest('hex').slice(0, 16)

/** The exact account/path/version revision a dispatch is bound to. */
function revisionOf(key: string, executable: string, version: string, auth: CliAuth): string {
  return createHash('sha256')
    .update(JSON.stringify({
      routeKey: key,
      executable,
      version,
      auth: { method: auth.method, accountFingerprint: auth.accountFingerprint },
    }))
    .digest('hex')
}

/** Propagate cancellation as cancellation, never as an ORC failure code. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Read one collected stream; the caller decides whether lossiness is fatal. */
function readCollected(reader: SubprocessOutputReader | undefined): { text: string; lossy: boolean } {
  if (reader === undefined) return { text: '', lossy: false }
  const read = reader.readFrom(0)
  return { text: read.text, lossy: read.lossy }
}

/**
 * Probes and invokes exactly one selected host CLI through the DSH subprocess
 * port. Holds the last green probe per route key, which is what binds a
 * dispatch to the path, version, and account it was tested against.
 */
export class CliAdapter {
  private readonly subprocess: CliSubprocessPort
  private readonly green = new Map<string, CliProbe>()

  constructor(subprocess: CliSubprocessPort) {
    this.subprocess = subprocess
  }

  /**
   * Run the documented version, authentication, and live capability probes for
   * one route, and record the result as that route's green probe.
   *
   * The probe runs in the harness working directory: the pinned probe signature
   * carries no `cwd`, and version, auth-status, and the harmless capability
   * prompt are directory-independent. Rejects with a {@link CliError} on any
   * failure; there is no fallback.
   */
  async probe(route: CliRoute, path: string | undefined, signal: AbortSignal): Promise<CliProbe> {
    const probe = await this.inspect(route, path, signal)
    await this.dispatch(route, probe.executable, PROBE_PROMPT, process.cwd(), signal)
    this.green.set(probe.routeKey, probe)
    return probe
  }

  /**
   * Live catalog of the configured CLI routes that passed their own harmless
   * capability probe.
   *
   * One entry per configured model/effort pair, in configured order, and only
   * for pairs whose live run succeeded. The documented interfaces expose no
   * full-account enumeration, so ORC does not invent one: a pair ORC was not
   * configured with is never advertised. `accountAccess` is `true` because the
   * entry exists only after this account's own successful run.
   *
   * A pair that fails its probe contributes no entry rather than failing the
   * whole read, because Auto routing must exclude it while the remaining pairs
   * stay usable. The pinned signature carries no explicit CLI path, so the
   * catalog discovers the executable on `PATH`.
   */
  async catalog(
    cli: CliName,
    configuredRoutes: readonly CliRoute[],
    signal: AbortSignal,
  ): Promise<CatalogSnapshot> {
    const observedAt = new Date().toISOString()
    const entries: CatalogEntry[] = []
    for (const route of configuredRoutes) {
      if (route.kind !== 'cli' || route.cli !== cli) continue
      let probe: CliProbe
      try {
        probe = await this.probe(route, undefined, signal)
      } catch (error) {
        if (signal.aborted) throw error
        continue
      }
      entries.push({
        routeKey: probe.routeKey,
        backendVersion: probe.version,
        model: route.model,
        // Only the configured effort has live evidence; nothing else is claimed.
        efforts: [route.effort],
        accountAccess: true,
        // A live probe is not an official capability/pricing source.
        sourceUrl: '',
        retrievedAt: observedAt,
      })
    }
    return { id: `${cli}@${observedAt}`, observedAt, entries }
  }

  /**
   * Dispatch one prompt through the selected CLI and return its accepted final
   * text.
   *
   * Rejects before starting any work when this route has no green probe, and
   * rejects after re-inspecting the live identity when its revision moved: a
   * changed executable path, parsed version, or auth/account fingerprint
   * invalidates the probe. A failure after a green probe stays a task failure —
   * it never falls back to the other CLI, a packaged runtime, or a provider.
   */
  async run(
    route: CliRoute,
    path: string | undefined,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const key = routeKey(route)
    const prior = this.green.get(key)
    if (prior === undefined) {
      throw new CliError('unsupported-protocol', `no green ${route.cli} probe for ${key}`)
    }
    const current = await this.inspect(route, path, signal)
    if (prior.revision !== current.revision) {
      throw new CliError('unsupported-protocol', `stale ${route.cli} probe for ${key}`)
    }
    return this.dispatch(route, current.executable, prompt, cwd, signal)
  }

  /**
   * Resolve the selected executable and read its live identity. Never touches
   * the other CLI: a route can only ever reach its own product.
   */
  private async inspect(route: CliRoute, path: string | undefined, signal: AbortSignal): Promise<CliProbe> {
    const command = path ?? route.cli
    let executable: string
    try {
      executable = await this.subprocess.resolveExecutable(command, undefined, signal)
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      throw new CliError(
        'unsupported-protocol',
        `the selected ${route.cli} executable could not be resolved`,
        safeDiagnostic(String(error), command),
      )
    }

    const versionOutput = await this.execute([executable, '--version'], process.cwd(), signal)
    if (versionOutput.exitCode !== 0) {
      throw new CliError(
        'invalid-version',
        `${route.cli} did not report a version`,
        safeDiagnostic(versionOutput.stderr !== '' ? versionOutput.stderr : versionOutput.stdout, executable),
      )
    }
    if (versionOutput.stdoutLossy) {
      throw new CliError('invalid-version', `${route.cli} version output exceeded the collection limit`)
    }
    const rawVersion = firstNonEmptyLine(versionOutput.stdout) ?? firstNonEmptyLine(versionOutput.stderr) ?? ''
    const parsed = parseCliVersion(rawVersion, route.cli)
    if (!parsed.supported) {
      throw new CliError(
        'unsupported-version',
        `${route.cli} ${parsed.version} is below the required ${MINIMUM_VERSIONS[route.cli]}`,
      )
    }

    const auth = await this.authenticate(route.cli, executable, signal)
    const key = routeKey(route)
    return {
      routeKey: key,
      cli: route.cli,
      executable,
      version: parsed.version,
      auth,
      model: route.model,
      effort: route.effort,
      revision: revisionOf(key, executable, parsed.version, auth),
      testedAt: new Date().toISOString(),
    }
  }

  /**
   * Run the documented auth-status command and reduce it to a credential-free
   * method plus account fingerprint.
   *
   * Codex writes its verdict to stderr and exits 1 when signed out; Claude
   * prints a JSON payload and exits 1 when signed out. Both are
   * `authentication` here, and a signed-out state is never read as a transport
   * or protocol failure.
   */
  private async authenticate(cli: CliName, executable: string, signal: AbortSignal): Promise<CliAuth> {
    const argv = cli === 'codex' ? [executable, 'login', 'status'] : [executable, 'auth', 'status']
    const output = await this.execute(argv, process.cwd(), signal)

    if (cli === 'codex') {
      if (output.stderrLossy) {
        throw new CliError('authentication', 'codex auth status output exceeded the collection limit')
      }
      const source = output.stderr.trim() !== '' ? output.stderr : output.stdout
      const line = source.split('\n').map(entry => entry.trim()).find(entry => entry.startsWith('Logged in'))
      if (line === undefined || output.exitCode !== 0) {
        throw new CliError('authentication', 'codex is not authenticated', safeDiagnostic(source, executable))
      }
      const method = line.includes('ChatGPT')
        ? 'chatgpt'
        : line.includes('API key') ? 'api-key' : 'unknown'
      // `codex login status` exposes no account identity, so none is claimed.
      return { method, accountFingerprint: '' }
    }

    if (output.stdoutLossy) {
      throw new CliError('authentication', 'claude auth status output exceeded the collection limit')
    }
    let payload: unknown
    try {
      payload = JSON.parse(output.stdout.trim())
    } catch {
      throw new CliError(
        'authentication',
        'claude auth status was not readable',
        safeDiagnostic(output.stdout !== '' ? output.stdout : output.stderr, executable),
      )
    }
    if (!isRecord(payload) || payload.loggedIn !== true || output.exitCode !== 0) {
      throw new CliError('authentication', 'claude is not authenticated', safeDiagnostic(output.stdout, executable))
    }
    const identity = [payload.email, payload.orgId, payload.subscriptionType]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .join('|')
    return {
      method: typeof payload.authMethod === 'string' ? payload.authMethod : 'unknown',
      accountFingerprint: identity === '' ? '' : fingerprint(identity),
    }
  }

  /**
   * Start one fully-specified child, await its exit and quiescence, then read
   * the collected streams. Cancellation propagates as an `AbortError`, never as
   * an ORC failure code, so a cancelled stage is not reported as a CLI fault.
   */
  private async execute(argv: readonly string[], cwd: string, signal: AbortSignal): Promise<CliOutput> {
    const spec: SubprocessSpawnSpec = {
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: PROBE_GRACE_MS,
      signal,
    }
    const executable = argv[0]
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn(spec)
    } catch (error) {
      // A pre-aborted signal makes the seam throw synchronously; that is
      // cancellation, not a CLI fault.
      if (signal.aborted) throw abortError(signal)
      throw new CliError(
        'unsupported-protocol',
        'the selected CLI could not be started',
        safeDiagnostic(String(error), executable),
      )
    }
    let exitCode: number | null
    try {
      exitCode = (await handle.done).exitCode
    } catch (error) {
      handle.terminate()
      throw new CliError(
        'unsupported-protocol',
        'the selected CLI failed while running',
        safeDiagnostic(String(error), executable),
      )
    }
    await handle.waitForExit()
    if (signal.aborted) throw abortError(signal)

    const stdout = readCollected(handle.collected.stdout)
    const stderr = readCollected(handle.collected.stderr)
    return {
      exitCode,
      stdout: stdout.text,
      stdoutLossy: stdout.lossy,
      stderr: stderr.text,
      // stderr is collected as a bounded diagnostic tail, so a lossy read there
      // is only fatal where the caller must read a verdict from it.
      stderrLossy: stderr.lossy,
    }
  }

  /**
   * Run the selected CLI once with an explicit argv and return its accepted
   * final text.
   *
   * A nonzero exit is never accepted, and a CLI-reported failure is classified
   * from its own reason. Protocol output is parsed from stdout, which is
   * rejected outright when the collection limit truncated it: a truncated
   * JSONL or JSON record cannot be trusted. stderr stays a diagnostic tail.
   */
  private async dispatch(
    route: CliRoute,
    executable: string,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const argv = route.cli === 'codex'
      ? codexArgv(executable, route.model, route.effort, prompt)
      : claudeArgv(executable, route.model, route.effort, prompt)
    const output = await this.execute(argv, cwd, signal)
    if (output.stdoutLossy) {
      throw new CliError('invalid-result', `${route.cli} output exceeded the collection limit`)
    }
    const reading = route.cli === 'codex' ? readCodexRun(output.stdout) : readClaudeRun(output.stdout)
    if (reading.kind === 'accepted') {
      if (output.exitCode !== 0) {
        throw new CliError('invalid-result', `${route.cli} exited with code ${String(output.exitCode)}`)
      }
      return reading.text
    }
    if (reading.kind === 'failed') {
      const code = classifyFailure(reading.detail)
      throw new CliError(code, `${route.cli} run failed: ${code}`, safeDiagnostic(reading.detail, executable))
    }
    throw new CliError('invalid-result', `${route.cli} returned no accepted result`, safeDiagnostic(reading.detail, executable))
  }
}
