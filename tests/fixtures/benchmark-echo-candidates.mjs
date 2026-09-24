#!/usr/bin/env node
/**
 * A "route that never reads the code" for `scripts/benchmark.mjs` tests.
 *
 * It is the exploit R31 closes, made executable: it reads the fixture prompt
 * from stdin, extracts every candidate finding id the prompt offers, and reports
 * all of them without looking at the code. Under the pre-distractor suite that
 * scored `detectionScore: 1` with `falsePositiveScore: 0` and cleared both
 * admissibility floors at `src/domain/routing.ts:98-99`. With a distractor in
 * every candidate list the same strategy must exceed the 0.2 false-positive
 * floor, which is what `tests/benchmark.spec.ts` asserts.
 *
 * It requires the prompt on stdin, so a runner that stopped piping the prompt
 * fails loudly here instead of silently scoring an empty run.
 */

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  if (!input.includes('Candidate finding ids for this fixture')) {
    process.stderr.write('benchmark-echo-candidates: the fixture prompt did not arrive on stdin\n')
    process.exitCode = 4
    return
  }
  const offered = input
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
  for (const id of offered) process.stdout.write(`FINDING: ${id}\n`)
})
