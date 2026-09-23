#!/usr/bin/env node
/**
 * A fake "review CLI" for `scripts/benchmark.mjs` tests.
 *
 * It exists to prove the runner's live-invocation contract end to end without a
 * model, a network call, or a credential:
 *
 * - every id passed as an argv element is reported as one `FINDING: <id>` line,
 *   so a test can prove the runner spawned the exact argv it was given;
 * - the fixture prompt must arrive on stdin, so a runner that stopped piping it
 *   fails loudly here instead of scoring an empty run;
 * - a nonzero exit is available through `--fail` so the runner's failure path
 *   is exercised too.
 */

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  const argv = process.argv.slice(2)
  if (argv.includes('--fail')) {
    process.stderr.write('benchmark-echo: requested failure\n')
    process.exitCode = 3
    return
  }
  if (!input.includes('Code:')) {
    process.stderr.write('benchmark-echo: the fixture prompt did not arrive on stdin\n')
    process.exitCode = 4
    return
  }
  for (const id of argv) {
    if (id === '--fail') continue
    process.stdout.write(`FINDING: ${id}\n`)
  }
})
