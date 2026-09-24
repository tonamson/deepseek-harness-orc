#!/usr/bin/env node
/**
 * A fake `claude --print --output-format json` for `scripts/benchmark.mjs`
 * tests.
 *
 * It emits the real Claude Code result-envelope shape without a model, a
 * network call, or a credential: exactly one JSON object on stdout whose
 * `type` is `result`, whose `result` string carries the assistant's answer, and
 * whose `subtype`/`is_error` pair reports completion status
 * (https://code.claude.com/docs/en/headless). `JSON.stringify` escapes the
 * newlines inside `result`, which is precisely the shape a plain-text reader
 * cannot see: no stdout line starts with `FINDING:`, so a runner that fell
 * through to the plain-text path used to score a silent zero.
 *
 * The fixture prompt must arrive on stdin, so a runner that stopped piping it
 * fails loudly here instead of scoring an empty run. The modes let a test pin
 * each extraction direction:
 *
 * - default: `subtype: "success"`, `is_error: false`, and a `result` carrying
 *   one `FINDING: <id>` line per non-flag argument;
 * - `--empty-result`: the same success envelope with an empty `result`, i.e. a
 *   real answer that reported nothing;
 * - `--is-error`: `is_error: true` with a non-success subtype and a `result`,
 *   the shape a failed run writes;
 * - `--non-success-subtype`: `is_error: false` but a non-success `subtype`;
 * - `--no-result`: a success envelope with no `result` field at all;
 * - `--non-string-result`: a success envelope whose `result` is not a string;
 * - `--no-subtype`: a `result` envelope with no `subtype` field;
 * - `--unknown-json`: a JSON object that matches no supported shape;
 * - `--malformed`: a recognisably-Claude envelope truncated mid-JSON.
 */

const argv = process.argv.slice(2)
const mode = argv.find(token => token.startsWith('--')) ?? ''
const ids = argv.filter(token => !token.startsWith('--'))

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  if (!input.includes('Candidate finding ids for this fixture')) {
    process.stderr.write('benchmark-claude-json: the fixture prompt did not arrive on stdin\n')
    process.exitCode = 4
    return
  }

  if (mode === '--unknown-json') {
    process.stdout.write(`${JSON.stringify({ type: 'some-other-tool', answer: 'FINDING: ignored' })}\n`)
    return
  }
  if (mode === '--malformed') {
    // A recognisably-Claude envelope cut short: the runner must fail it as
    // malformed JSON rather than read the visible `result` text as plain text.
    process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"FINDING: demo-id"\n')
    return
  }

  const report = ids.map(id => `FINDING: ${id}`).join('\n')
  const envelope = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: report,
    session_id: 'benchmark-test-session',
    num_turns: 1,
    total_cost_usd: 0.001,
  }

  if (mode === '--empty-result') envelope.result = ''
  if (mode === '--is-error') {
    envelope.subtype = 'error_during_execution'
    envelope.is_error = true
    envelope.result = 'the run failed before answering'
  }
  if (mode === '--non-success-subtype') envelope.subtype = 'error_max_turns'
  if (mode === '--no-result') delete envelope.result
  if (mode === '--non-string-result') envelope.result = 42
  if (mode === '--no-subtype') delete envelope.subtype

  process.stdout.write(`${JSON.stringify(envelope)}\n`)
})
