#!/usr/bin/env node
/**
 * Fake `codex` executable for the host CLI adapter tests.
 *
 * It speaks the three documented Codex interfaces the adapter probes, with the
 * exact output shapes the real CLI uses, so the adapter's own parsing and
 * classification run for real instead of being re-implemented in the test:
 *
 * - `codex --version`            → `codex-cli <semver>` on stdout (clap's
 *                                  `version` output with
 *                                  `bin_name = "codex-cli"`; the real CLI
 *                                  prints `codex-cli 0.156.1`, not the
 *                                  plan-pinned `codex 0.156.1`).
 * - `codex login status`         → the verdict on **stderr**, exit 0 when
 *                                  signed in and 1 when not
 *                                  (`codex-rs/cli/src/login.rs`).
 * - `codex exec --json …`        → JSONL `thread.started` / `turn.started` /
 *                                  `item.completed` / `turn.completed` events
 *                                  (`codex-rs/exec/src/exec_events.rs`).
 *
 * `ORC_FAKE_MODE` selects a behaviour; the default is a healthy, supported
 * executable. `ORC_FAKE_VERSION` overrides the reported version string, and
 * `ORC_FAKE_REJECT_EFFORT` / `ORC_FAKE_REJECT_MODEL` make the harmless run
 * report a capability mismatch for one exact model or effort.
 */

const args = process.argv.slice(2)
const mode = process.env.ORC_FAKE_MODE ?? 'ok'

/** Version strings per mode, in the real shape `codex --version` prints. */
const VERSIONS = {
  ok: 'codex-cli 0.156.1',
  newer: 'codex-cli 0.157.0',
  'below-floor': 'codex-cli 0.156.0',
  'bad-version': 'v0.156.1 garbage',
  'ansi-version': '\u001b[31munknown\u001b[0m',
  'numeric-version': 'codex-cli 1000.bad.1',
}

const USAGE = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
}

const write = (text) => process.stdout.write(`${text}\n`)
const warn = (text) => process.stderr.write(`${text}\n`)
const emit = (event) => write(JSON.stringify(event))
const finish = (code) => process.exit(code)

/** The version this run reports, in the real product-prefixed shape. */
const version = () => process.env.ORC_FAKE_VERSION ?? VERSIONS[mode] ?? VERSIONS.ok

/** Value of a `--flag value` pair, when present. */
function flagValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** The `-c model_reasoning_effort="…"` override the adapter passes. */
function effortOverride() {
  const match = /model_reasoning_effort="([^"]*)"/.exec(args.join(' '))
  return match?.[1]
}

/** A turn failure whose message names the reason the run could not proceed. */
function failTurn(message) {
  emit({ type: 'turn.failed', error: { message } })
  finish(1)
}

if (args[0] === '--version') {
  if (mode === 'version-fail') {
    warn('codex: unable to report a version')
    finish(1)
  }
  write(version())
  finish(0)
}

if (args[0] === 'login' && args[1] === 'status') {
  // The real command writes its verdict to stderr and exits 1 when signed out.
  if (mode === 'auth-fail') {
    warn('Not logged in')
    finish(1)
  }
  if (mode === 'auth-apikey') {
    warn('Logged in using an API key - sk-proj-***ABCDE')
    finish(0)
  }
  warn('Logged in using ChatGPT')
  finish(0)
}

if (args[0] === 'exec') {
  // A test can make one exact prompt behave differently, so a green harmless
  // capability probe can be followed by a failing real dispatch.
  const prompt = args[args.length - 1]
  const runMode = process.env.ORC_FAKE_RUN_PROMPT !== undefined && prompt === process.env.ORC_FAKE_RUN_PROMPT
    ? process.env.ORC_FAKE_RUN_MODE ?? mode
    : mode

  emit({ type: 'thread.started', thread_id: 'thread-1' })
  emit({ type: 'turn.started' })

  if (runMode === 'cancel') {
    // A child that never finishes on its own; SIGTERM ends it.
    setInterval(() => {}, 1_000)
  } else if (runMode === 'bad-protocol') {
    failTurn("unknown option '--model'")
  } else if (runMode === 'quota') {
    failTurn('usage limit reached: quota exceeded')
  } else if (runMode === 'leaky') {
    failTurn('auth failed for key sk-test-secret at /Users/someone/.codex/auth.json')
  } else if (runMode === 'bad-json') {
    write('{"type":"item.completed","item":')
    emit({ type: 'turn.completed', usage: USAGE })
    finish(0)
  } else if (runMode === 'no-turn-completed') {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } })
    finish(0)
  } else if (runMode === 'no-message') {
    emit({ type: 'turn.completed', usage: USAGE })
    finish(0)
  } else if (runMode === 'two-messages') {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first' } })
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'second' } })
    emit({ type: 'turn.completed', usage: USAGE })
    finish(0)
  } else {
    const model = flagValue('--model')
    const effort = effortOverride()
    if (process.env.ORC_FAKE_REJECT_EFFORT !== undefined && process.env.ORC_FAKE_REJECT_EFFORT === effort) {
      failTurn(`unsupported reasoning effort "${effort}" for model "${model}"`)
    }
    if (process.env.ORC_FAKE_REJECT_MODEL !== undefined && process.env.ORC_FAKE_REJECT_MODEL === model) {
      failTurn(`unsupported model "${model}" for this account`)
    }
    // A non-fatal warning item must not be mistaken for the accepted answer.
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } })
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } })
    emit({ type: 'turn.completed', usage: USAGE })
    finish(0)
  }
}

warn(`fake-codex: unsupported invocation: ${args.join(' ')}`)
finish(2)
