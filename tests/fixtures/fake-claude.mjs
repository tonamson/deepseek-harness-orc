#!/usr/bin/env node
/**
 * Fake `claude` executable for the host CLI adapter tests.
 *
 * It speaks the three documented Claude Code interfaces the adapter probes,
 * with the exact output shapes the real CLI uses:
 *
 * - `claude --version`        → `<product> <semver>` on stdout.
 * - `claude auth status`      → authentication status as JSON on stdout, exit
 *                               0 when logged in and 1 when not
 *                               (https://code.claude.com/docs/en/cli-reference).
 *                               Field names follow the documented camelCase
 *                               payload (`loggedIn`, `authMethod`,
 *                               `subscriptionType`, `email`, `orgId`).
 * - `claude -p … --output-format json` → one JSON result record whose
 *                               completion status is `subtype` and whose text
 *                               is `result`
 *                               (https://code.claude.com/docs/en/headless).
 *
 * `ORC_FAKE_MODE` selects a behaviour; the default is a healthy, supported
 * executable. `ORC_FAKE_VERSION` overrides the reported version string, and
 * `ORC_FAKE_REJECT_EFFORT` / `ORC_FAKE_REJECT_MODEL` make the harmless run
 * report a capability mismatch for one exact model or effort.
 */

const args = process.argv.slice(2)
const mode = process.env.ORC_FAKE_MODE ?? 'ok'

/** Version strings per mode, in the shape `claude --version` prints. */
const VERSIONS = {
  ok: 'claude 2.1.280',
  newer: 'claude 2.1.300',
  'below-floor': 'claude 2.1.279',
  'bad-version': 'v2.1.280 garbage',
  'ansi-version': '\u001b[31munknown\u001b[0m',
  'numeric-version': 'claude 1000.bad.1',
}

const write = (text) => process.stdout.write(`${text}\n`)
const warn = (text) => process.stderr.write(`${text}\n`)
const emit = (payload) => write(JSON.stringify(payload))
const finish = (code) => process.exit(code)

/** The version this run reports, in the real product-prefixed shape. */
const version = () => process.env.ORC_FAKE_VERSION ?? VERSIONS[mode] ?? VERSIONS.ok

/** Value of a `--flag value` pair, when present. */
function flagValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** A completed run that did not succeed, carrying the failure in `result`. */
function failRun(text) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text })
  finish(1)
}

if (args[0] === '--version') {
  write(version())
  finish(0)
}

if (args[0] === 'auth' && args[1] === 'status') {
  // Signed out is documented as exit 1 with a valid JSON payload.
  if (mode === 'auth-fail') {
    emit({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
    finish(1)
  }
  const email = mode === 'auth-other-account' ? 'other@example.com' : 'dev@example.com'
  emit({
    loggedIn: true,
    authMethod: 'claudeai',
    apiProvider: 'firstParty',
    email,
    orgId: 'org-1',
    orgName: 'Example',
    subscriptionType: 'max',
  })
  finish(0)
}

if (args[0] === '-p') {
  // A test can make one exact prompt behave differently, so a green harmless
  // capability probe can be followed by a failing real dispatch.
  const prompt = args[1]
  const runMode = process.env.ORC_FAKE_RUN_PROMPT !== undefined && prompt === process.env.ORC_FAKE_RUN_PROMPT
    ? process.env.ORC_FAKE_RUN_MODE ?? mode
    : mode

  if (runMode === 'cancel') {
    // A child that never finishes on its own; SIGTERM ends it.
    setInterval(() => {}, 1_000)
  } else if (runMode === 'bad-protocol') {
    failRun(`unsupported model "${flagValue('--model')}" for this account`)
  } else if (runMode === 'quota') {
    failRun('usage limit reached: quota exceeded')
  } else if (runMode === 'leaky') {
    failRun('auth failed for key sk-test-secret at /Users/someone/.claude/settings.json')
  } else if (runMode === 'bad-json') {
    write('not json at all')
    finish(0)
  } else if (runMode === 'error-success') {
    // A self-contradictory record: successful completion status with is_error.
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })
    finish(1)
  } else if (runMode === 'no-subtype') {
    emit({ type: 'result', is_error: false, result: 'OK' })
    finish(0)
  } else if (runMode === 'empty-result') {
    emit({ type: 'result', subtype: 'success', is_error: false, result: '' })
    finish(0)
  } else {
    const model = flagValue('--model')
    const effort = flagValue('--effort')
    if (process.env.ORC_FAKE_REJECT_EFFORT !== undefined && process.env.ORC_FAKE_REJECT_EFFORT === effort) {
      failRun(`unsupported reasoning effort "${effort}" for model "${model}"`)
    }
    if (process.env.ORC_FAKE_REJECT_MODEL !== undefined && process.env.ORC_FAKE_REJECT_MODEL === model) {
      failRun(`unsupported model "${model}" for this account`)
    }
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 'session-1',
      num_turns: 1,
      total_cost_usd: 0.001,
    })
    finish(0)
  }
}

warn(`fake-claude: unsupported invocation: ${args.join(' ')}`)
finish(2)
