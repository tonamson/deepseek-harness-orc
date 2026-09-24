#!/usr/bin/env node
/**
 * A prompt-capturing "review CLI" for `scripts/benchmark.mjs` tests.
 *
 * The runner spawns it once per fixture with that fixture's prompt on stdin. It
 * appends each received prompt as one JSON line to the file named by its first
 * argument, so a test can assert exactly what the prompt told the model without
 * a model, a network call, or a credential:
 *
 * - the prompts land in fixture order, so a test can pair each one with the
 *   fixture it was built from;
 * - it reports no findings and exits 0, so capturing a run never changes the
 *   scoring path it is observed alongside.
 */

import { appendFileSync } from 'node:fs'

const out = process.argv[2]

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  appendFileSync(out, `${JSON.stringify(input)}\n`)
})
