#!/usr/bin/env node
/**
 * A fake `codex exec --json` for `scripts/benchmark.mjs` tests.
 *
 * It emits the real Codex JSONL shape without a model, a network call, or a
 * credential: one event object per stdout line, with the assistant's answer
 * carried as a single JSON string field whose newlines JSON.stringify escapes.
 * That is exactly the shape that made the runner score zero on every fixture
 * before it learned to extract the accepted final text first.
 *
 * The fixture prompt must arrive on stdin, so a runner that stopped piping it
 * fails loudly here instead of scoring an empty run. The modes let a test pin
 * each extraction direction:
 *
 * - default: `item.completed` with an `agent_message` whose text is one
 *   `FINDING: <id>` line per non-flag argument;
 * - `--empty-report`: the same event with an empty `text`, i.e. a real answer
 *   that reported nothing;
 * - `--no-message`: a completed turn with no `agent_message` event at all, plus
 *   a token-shaped reasoning item to prove failure diagnostics are redacted;
 * - `--turn-failed`: an `agent_message` followed by a fatal `turn.failed` event,
 *   so a runner that scored it would credit findings from a failed turn;
 * - `--error`: a fatal top-level `error` event.
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
    process.stderr.write('benchmark-codex-jsonl: the fixture prompt did not arrive on stdin\n')
    process.exitCode = 4
    return
  }

  const report = ids.map(id => `FINDING: ${id}`).join('\n')
  const events = [
    { type: 'thread.started', thread_id: 'benchmark-test-thread' },
    { type: 'turn.started' },
  ]

  if (mode === '--turn-failed') {
    events.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: report } })
    events.push({ type: 'turn.failed', error: { message: 'the model stream ended early' } })
  } else if (mode === '--error') {
    events.push({ type: 'error', message: 'unrecoverable stream error' })
  } else if (mode === '--no-message') {
    events.push({
      type: 'item.completed',
      item: { id: 'item_0', type: 'reasoning', text: 'weighing the code with key sk-ant-api03-EXAMPLEONLY0000000000' },
    })
    events.push({ type: 'turn.completed', usage: {} })
  } else if (mode === '--empty-report') {
    events.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '' } })
    events.push({ type: 'turn.completed', usage: {} })
  } else {
    events.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: report } })
    events.push({ type: 'turn.completed', usage: {} })
  }

  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
})
