#!/usr/bin/env node
/**
 * A fake plain-text review CLI for `scripts/benchmark.mjs` tests.
 *
 * It emits the shape `claude --print` produces at its default
 * `--output-format text`, and the shape `codex exec` produces without `--json`:
 * the assistant's prose and its `FINDING:` lines arrive as ordinary stdout text,
 * so the whole stdout is the answer. The prose around the finding lines proves
 * the runner does not require the first line to be a finding.
 *
 * The fixture prompt must arrive on stdin, so a runner that stopped piping it
 * fails loudly here instead of scoring an empty run. `--silent` exits 0 having
 * written nothing, which is the invocation the runner must fail rather than
 * score as a clean zero.
 */

const argv = process.argv.slice(2)
const ids = argv.filter(token => !token.startsWith('--'))

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  if (!input.includes('Candidate finding ids for this fixture')) {
    process.stderr.write('benchmark-plain-text: the fixture prompt did not arrive on stdin\n')
    process.exitCode = 4
    return
  }
  if (argv.includes('--silent')) return

  process.stdout.write('Here is what I found while reading the code.\n\n')
  for (const id of ids) process.stdout.write(`FINDING: ${id}\n`)
  process.stdout.write(`\nThat is ${ids.length} finding(s) in total.\n`)
})
