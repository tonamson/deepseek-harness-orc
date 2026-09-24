# ORC Question Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ORC child park on a decision only the human can make, instead of breaking its turn, by denying the child the `ask_user_question` tool and giving it a durable question channel the Supervisor answers.

**Architecture:** DSH refuses human interaction to any owned child agent, so the tool fails at call time. ORC removes the tool from every child through DSH's existing per-child `toolFilter`, records an outstanding decision as a new `QuestionRecord` in the durable run state, parks the run until it is answered, and delivers the answer back to the blocked peer through the subagent runtime. Every change is inside the ORC plugin; DSH is only consumed through extension points it already publishes.

**Tech Stack:** TypeScript, Cordis plugins, Vitest, the DSH session/reducer model.

**Spec:** `docs/superpowers/specs/2026-09-24-orc-question-channel-design.md`

## Global Constraints

- Do not modify any `@deepseek-ai/dsh*` package. Consume published extension points only.
- Supported DSH set stays exactly `@deepseek-ai/dsh*` `0.1.6-alpha.2` (ruling R15).
- `src/domain/workflow.ts` is pure: it reads no wall-clock time, generates no identifier, and performs no I/O. Timestamps and identifiers arrive on events.
- The reducer is the single authority for authority and phase order; the service resolves identities but never re-implements a rule the reducer enforces.
- Reducer error messages keep their established prefixes: `authority:`, `phase:`, `blocking:`, `duplicate`, `unknown`, `version:`, `run:`.
- Every existing test must stay green: 464 tests across 19 files.
- Every task ends green on `npx vitest run <file>` and `npm run typecheck`.
- npm on this machine has a root-owned `~/.npm`; always run npm scripts with `npm_config_cache="$PWD/.npm-cache"`.

---

### Task 1: Durable question records, transitions, and gates

**Files:**
- Modify: `src/domain/workflow.ts`
- Test: `tests/workflow.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface QuestionRecord { id: string; taskId: string; peerId: string; question: string; status: 'open' | 'answered'; answer: string | null }`
  - `OrcState.questions: QuestionRecord[]`
  - events `{ type: 'question-raise'; questionId: string; taskId: string; question: string }` and `{ type: 'question-answer'; questionId: string; answer: string }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflow.spec.ts`. First extend the existing `event()` helper with defaults for the two new types — insert these two blocks next to the existing `if (type === 'task-settle')` block:

```ts
  if (type === 'question-raise') {
    defaults.questionId = 'q-1'
    defaults.taskId = 'task-1'
    defaults.question = 'which database?'
  }
  if (type === 'question-answer') {
    defaults.questionId = 'q-1'
    defaults.answer = 'postgres'
  }
```

Then append these tests:

```ts
/** The legal prefix through `task-start`, leaving the run in `implement`. */
const throughTaskStart = (): OrcEvent[] => validEvents().slice(0, 8)

it('records a question a peer raises on its own task', () => {
  const state = replay([...throughTaskStart(), event('question-raise', 'peer')])
  expect(state.questions).toHaveLength(1)
  expect(state.questions[0]).toMatchObject({
    id: 'q-1',
    taskId: 'task-1',
    peerId: 'peer-1',
    question: 'which database?',
    status: 'open',
    answer: null,
  })
})

it('rejects a question raised by a peer that does not own the task', () => {
  expect(() => replay([...throughTaskStart(), event('question-raise', 'peer', { actorId: 'peer-2' })])).toThrow(
    /authority/,
  )
})

it('rejects a question on an unknown task', () => {
  expect(() => replay([...throughTaskStart(), event('question-raise', 'peer', { taskId: 'task-9' })])).toThrow(/unknown task/)
})

it('rejects a question on a task that already settled', () => {
  const settled = [...throughTaskStart(), event('task-settle', 'peer')]
  expect(() => replay([...settled, event('question-raise', 'peer')])).toThrow(/already settled/)
})

it('rejects an empty question and a duplicate question id', () => {
  expect(() => replay([...throughTaskStart(), event('question-raise', 'peer', { question: '   ' })])).toThrow(
    /non-empty/,
  )
  const raised = [...throughTaskStart(), event('question-raise', 'peer')]
  expect(() => replay([...raised, event('question-raise', 'peer')])).toThrow(/duplicate question id/)
})

it('rejects a question raised by a non-peer actor', () => {
  for (const actor of ['supervisor', 'lead', 'service'] as const)
    expect(() => replay([...throughTaskStart(), event('question-raise', actor)]), actor).toThrow(/authority/)
})

it('answers an open question', () => {
  const raised = [...throughTaskStart(), event('question-raise', 'peer')]
  const state = replay([...raised, event('question-answer', 'supervisor')])
  expect(state.questions[0]).toMatchObject({ status: 'answered', answer: 'postgres' })
})

it('rejects an answer from a non-supervisor, an unknown question, an already answered question, and an empty answer', () => {
  const raised = [...throughTaskStart(), event('question-raise', 'peer')]
  expect(() => replay([...raised, event('question-answer', 'lead')])).toThrow(/authority/)
  expect(() => replay([...raised, event('question-answer', 'supervisor', { questionId: 'q-9' })])).toThrow(
    /unknown question/,
  )
  expect(() => replay([...raised, event('question-answer', 'supervisor', { answer: '  ' })])).toThrow(/non-empty/)
  const answered = [...raised, event('question-answer', 'supervisor')]
  expect(() => replay([...answered, event('question-answer', 'supervisor')])).toThrow(/already answered/)
})

it('parks the run: an open question refuses the review, the final review, and its own task settlement', () => {
  const raised = [...throughTaskStart(), event('question-raise', 'peer')]
  expect(() => replay([...raised, event('task-settle', 'peer')])).toThrow(/blocking: task task-1 has an open question/)
  expect(() => replay([...raised, event('review-request', 'lead')])).toThrow(/blocking: review cannot start/)
  expect(() => replay([...raised, event('final-review-request', 'supervisor')])).toThrow(/blocking: the final branch review requires every question answered/)
})

it('still settles a task that carries no open question', () => {
  const base = validEvents().slice(0, 7)
  const secondPeer = event('peer-create', 'lead', { peerId: 'peer-2' })
  const secondTask = event('task-start', 'lead', { taskId: 'task-2', peerId: 'peer-2' })
  const raised = [...base, secondPeer, event('task-start', 'lead'), secondTask, event('question-raise', 'peer')]
  const state = replay([...raised, event('task-settle', 'peer', { actorId: 'peer-2', taskId: 'task-2' })])
  expect(state.tasks.find(task => task.id === 'task-2')?.status).toBe('settled')
  expect(state.questions[0]?.status).toBe('open')
})

it('refuses completion while a question is open', () => {
  const complete = replay(validEvents())
  expect(canComplete(complete)).toBe(true)
  const blocked: OrcState = {
    ...complete,
    questions: [
      { id: 'q-1', taskId: 'task-1', peerId: 'peer-1', question: 'why?', status: 'open', answer: null },
    ],
  }
  expect(canComplete(blocked)).toBe(false)
})

it('replays a log written before questions existed', () => {
  const state = replay(validEvents())
  expect(state.questions).toEqual([])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workflow.spec.ts`
Expected: FAIL — `state.questions` is `undefined`, and the reducer throws `unknown: unsupported event type "question-raise"`.

- [ ] **Step 3: Add the record type and state field**

In `src/domain/workflow.ts`, after `RequestRecord`:

```ts
/** One question a peer raised, and the Supervisor's answer. */
export interface QuestionRecord {
  /** Stable identity; derived by the service so a retried raise addresses the same question. */
  id: string
  /** The task whose work is blocked. */
  taskId: string
  /** The peer that raised it. */
  peerId: string
  /** What the peer needs decided. */
  question: string
  status: 'open' | 'answered'
  /** The Supervisor's answer; null while open. */
  answer: string | null
}
```

Add `questions: QuestionRecord[]` to `OrcState` after `requests`, with the comment:

```ts
  /** Questions peers raised, in the order they were raised. */
  questions: QuestionRecord[]
```

Add `questions: []` to `initialState()` after `requests: []`.

- [ ] **Step 4: Add the two events**

In the `OrcEvent` union, after the `task-settle` variant:

```ts
  | (EventBase & { type: 'question-raise'; questionId: string; taskId: string; question: string })
  | (EventBase & { type: 'question-answer'; questionId: string; answer: string })
```

- [ ] **Step 5: Add the open-question helper**

Next to `hasOpenBlocking`:

```ts
const hasOpenQuestion = (state: OrcState): boolean => state.questions.some(question => question.status === 'open')
```

- [ ] **Step 6: Add the two transitions**

In `TRANSITIONS`, after `task-settle`:

```ts
  'question-raise': {
    roles: ['peer'],
    from: ['implement'],
    apply: (state, event) => {
      const task = state.tasks.find(candidate => candidate.id === event.taskId)
      if (!task) throw new WorkflowError(`unknown task ${event.taskId}`)
      if (task.peerId !== event.actorId)
        throw new WorkflowError(
          `authority: peer ${event.actorId} may not raise a question on task ${event.taskId} assigned to ${task.peerId}`,
        )
      if (task.status === 'settled') throw new WorkflowError(`phase: task ${event.taskId} is already settled`)
      if (event.question.trim() === '') throw new WorkflowError('a question requires non-empty text')
      if (state.questions.some(question => question.id === event.questionId))
        throw new WorkflowError(`duplicate question id ${event.questionId}`)
      return {
        ...state,
        questions: [
          ...state.questions,
          {
            id: event.questionId,
            taskId: event.taskId,
            peerId: event.actorId,
            question: event.question,
            status: 'open',
            answer: null,
          },
        ],
      }
    },
  },
  'question-answer': {
    roles: ['supervisor'],
    from: NON_TERMINAL_PHASES,
    authority: requireSupervisor,
    apply: (state, event) => {
      const question = state.questions.find(candidate => candidate.id === event.questionId)
      if (!question) throw new WorkflowError(`unknown question ${event.questionId}`)
      if (question.status !== 'open')
        throw new WorkflowError(`question ${event.questionId} is already ${question.status}`)
      if (event.answer.trim() === '') throw new WorkflowError('an answer requires non-empty text')
      return {
        ...state,
        questions: state.questions.map(candidate =>
          candidate.id === question.id ? { ...candidate, status: 'answered', answer: event.answer } : candidate,
        ),
      }
    },
  },
```

- [ ] **Step 7: Add the three gate rules**

In `task-settle`, after the `already settled` check, add:

```ts
      if (state.questions.some(question => question.status === 'open' && question.taskId === event.taskId))
        throw new WorkflowError(`blocking: task ${event.taskId} has an open question; answer it before settling`)
```

In `review-request`, after the `hasOpenBlocking` check, add:

```ts
      if (hasOpenQuestion(state))
        throw new WorkflowError('blocking: review cannot start while a question is open; answer it first')
```

In `final-review-request`, after `requireAllTasksSettled(state)`, add:

```ts
      if (hasOpenQuestion(state))
        throw new WorkflowError('blocking: the final branch review requires every question answered')
```

- [ ] **Step 8: Add the completion predicate rule**

In `completionBlockers`, before `return blockers`:

```ts
  const unanswered = state.questions.filter(question => question.status === 'open').length
  if (unanswered > 0) blockers.push(`${unanswered} question(s) are unanswered`)
```

In `canComplete`, add the conjunct after the `finalAudit` check:

```ts
    !state.questions.some(question => question.status === 'open') &&
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/workflow.spec.ts`
Expected: PASS, and the pre-existing workflow tests still pass.

- [ ] **Step 10: Typecheck and commit**

```bash
npm_config_cache="$PWD/.npm-cache" npm run typecheck
git add src/domain/workflow.ts tests/workflow.spec.ts
git commit -m "feat: record peer questions and park the run until they are answered

A peer cannot ask the human, so it needs somewhere to park a decision
only the human can make. A question is not a review finding: it has no
file, line, or remediation, and nothing about it needs fixing. It gets
its own record so the report parser keeps refusing findings that lack a
file and line.

An open question refuses the review request, the final review request,
and settlement of the task that raised it, so a run cannot leave
implement on an unanswered decision. Purely additive: the new field is
supplied by initialState, so a log written before this change replays
unchanged."
```

---

### Task 2: Deny the human-question tool to every ORC child

**Files:**
- Modify: `src/host/service.ts` (the `startChild` method and the child prompt)
- Modify: `tests/fixtures/ports.ts` (record the filter, expose a capability toggle)
- Test: `tests/service.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1. This task is independent of the question channel.
- Produces: `FakeSubagents.starts[]` entries gain `toolFilter: ToolRestriction | undefined`; `FakeSubagents.setToolFilter(capable: boolean): void`.

- [ ] **Step 1: Extend the fixture to record the filter and toggle the capability**

In `tests/fixtures/ports.ts`, add the import next to the existing `@deepseek-ai/dsh-tools` import:

```ts
import type { ToolDefinition, ToolRestriction } from '@deepseek-ai/dsh-tools'
```

In `FakeSubagents`, extend the `starts` entry type and add the toggle:

```ts
  /** Every start spec the service handed over, in order. */
  readonly starts: {
    provider: string
    label: string
    childId?: string
    parentId: string
    agentOptions: AgentOptions | undefined
    toolFilter: ToolRestriction | undefined
  }[]
  /** Every published child, keyed by child id. */
  readonly children: Map<string, FakeAgent>
  /** Make the next start fail. */
  failNextStart(error: Error | undefined): void
  /** Withdraw the continuable capability. */
  setCapable(capable: boolean): void
  /** Withdraw the child tool-filter capability. */
  setToolFilter(capable: boolean): void
```

In `fakeSubagents`, add a mutable `filterCapable` beside `capable`:

```ts
  let capable = true
  let filterCapable = true
```

Replace the `capabilities` constant with a getter so the toggle takes effect:

```ts
  const capabilities = (): SubagentCapabilities => ({
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: filterCapable,
    persona: true,
  })
```

Update `getProvider` to call it:

```ts
    getProvider: (name) => {
      if (name !== 'spawn') return undefined
      return {
        capabilities: capabilities(),
        ...capable ? { prepareContinuable: () => ({}) } : {},
      }
    },
```

Add the toggle to the returned object beside `setCapable`:

```ts
    setToolFilter: (next) => {
      filterCapable = next
    },
```

Record the filter in `startContinuable` by adding one line to the `starts.push({...})` call:

```ts
        toolFilter: spec.request.toolFilter,
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/service.spec.ts`:

```ts
it('denies the human-question tool to every ORC child', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  await service.start(ports.supervisor, HIGH_RISK)
  await service.createLead(ports.supervisor)
  expect(ports.subagents.starts[0]?.toolFilter).toEqual({ deny: ['ask_user_question'] })
})

it('refuses to create a child when the provider cannot restrict its tools', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  await service.start(ports.supervisor, HIGH_RISK)
  ports.subagents.setToolFilter(false)
  await expect(service.createLead(ports.supervisor)).rejects.toThrow(/cannot restrict child tools/)
})
```

`HIGH_RISK` is already imported from `./fixtures/ports.js` in this file and is what every other `service.start` call passes. Follow the file's existing style of `const ports = fakePorts()` then `new OrcService(ports)`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/service.spec.ts -t "human-question"`
Expected: FAIL — `toolFilter` is `undefined`, and the guard does not exist so the second test does not reject.

- [ ] **Step 4: Add the filter and the guard**

In `src/host/service.ts`, add the import for the restriction type beside the existing DSH imports:

```ts
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
```

Add the constant beside `ORC_CHILD_PROVIDER`:

```ts
/**
 * The tools no ORC child may hold.
 *
 * DSH refuses human interaction to any agent owned by another live agent, so a
 * child that calls `ask_user_question` fails at call time rather than parking.
 * Removing the tool is the guarantee; the child's prompt only states it.
 */
export const ORC_CHILD_DENIED_TOOLS: ToolRestriction = { deny: ['ask_user_question'] }
```

In `startChild`, after the `prepareContinuable` check and before `startContinuable`:

```ts
      if (provider.capabilities.toolFilter !== true) {
        throw new OrcServiceError(
          `the DSH subagent provider "${ORC_CHILD_PROVIDER}" cannot restrict child tools, so ORC cannot guarantee its children never ask the human`,
        )
      }
```

Add `toolFilter` to the `startContinuable` request, beside `prompt`:

```ts
          toolFilter: ORC_CHILD_DENIED_TOOLS,
```

- [ ] **Step 5: State the contract in the child prompt**

Add the constant near `ORC_CHILD_PROVIDER`:

```ts
/**
 * What every ORC child is told about human interaction.
 *
 * The tool filter above is the guarantee; this text exists so a child that
 * needs a decision knows where to put it instead of guessing.
 */
export const ORC_CHILD_QUESTION_CONTRACT =
  'You are a DSH child agent, so you cannot ask the human a question: `ask_user_question` is not available to you. ' +
  'When you need a decision only the human can make, call the `orc` tool with action "raise-question" (taskId, question) and then stop and wait; ' +
  'the Supervisor answers it and the answer arrives in your inbox. ' +
  'Do not guess on a decision that changes scope, risk, or an irreversible outcome; raise it instead.'
```

Replace the `prompt` line in `startContinuable` with:

```ts
          prompt: [
            {
              type: 'text',
              text: `${label} (${idOf(childId)}) owns work delegated by ORC run ${runId}.\n\n${ORC_CHILD_QUESTION_CONTRACT}`,
            },
          ],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/service.spec.ts`
Expected: PASS, including the pre-existing service tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npm_config_cache="$PWD/.npm-cache" npm run typecheck
git add src/host/service.ts tests/fixtures/ports.ts tests/service.spec.ts
git commit -m "feat: deny ask_user_question to every ORC child

A DSH child agent owned by another live agent cannot ask the human, and
the refusal happens at call time rather than by withholding the tool, so
a child that reaches for it breaks its own turn.

Deny the tool through DSH's per-child toolFilter, which removes it from
the child's prompt and refuses execution, and fail loudly when the
provider cannot honour the filter. The prompt states the contract so a
child that needs a decision knows to raise it instead of guessing."
```

---

### Task 3: The service question channel and answer delivery

**Files:**
- Modify: `src/host/service.ts` (`OrcSubagentPort`, `questionIdentity`, `raiseQuestion`, `answerQuestion`, delivery)
- Modify: `tests/fixtures/ports.ts` (record `sendMessage`)
- Test: `tests/service.spec.ts`

**Interfaces:**
- Consumes: `QuestionRecord` and the `question-raise` / `question-answer` events from Task 1.
- Produces:
  - `OrcSubagentPort.sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: { signal: AbortSignal }): Promise<MessageId>`
  - `OrcService.raiseQuestion(peer: Agent, taskId: string, question: string): Promise<OrcState>`
  - `OrcService.answerQuestion(supervisor: Agent, questionId: string, answer: string): Promise<OrcState>`
  - `questionIdentity(peer: Agent, taskId: string, question: string): string`
  - `FakeSubagents.sent: { from: string; to: string; text: string }[]`, `FakeSubagents.failNextSend(error: Error): void`

- [ ] **Step 1: Extend the fixture with a recording, failing sender**

In `tests/fixtures/ports.ts`, add to the `FakeSubagents` interface:

```ts
  /** Every message the service delivered, in order. */
  readonly sent: { from: string; to: string; text: string }[]
  /** Make the next delivery fail. */
  failNextSend(error: Error | undefined): void
```

In `fakeSubagents`, add the state beside `failure`:

```ts
  const sent: FakeSubagents['sent'] = []
  let sendFailure: Error | undefined
```

Add the returned members beside `starts`:

```ts
    sent,
    failNextSend: (error) => {
      sendFailure = error
    },
    sendMessage: async (sender, targetId, content) => {
      if (sendFailure !== undefined) {
        const error = sendFailure
        sendFailure = undefined
        throw error
      }
      sent.push({
        from: String(sender.id),
        to: String(targetId),
        text: content.map(block => (block.type === 'text' ? block.text : '')).join(''),
      })
      return MessageId(`message-${sent.length}`)
    },
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/service.spec.ts`. Build a run through `createPeer` and `startTask` using the same helpers the file already uses for those calls, then:

```ts
it('records a peer question and delivers the Supervisor answer to that peer', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  await service.start(ports.supervisor, HIGH_RISK)
  const lead = await service.createLead(ports.supervisor)
  const peer = await service.createPeer(lead, 'impl')
  await service.startTask(lead, peer, 'task-1')

  const raised = await service.raiseQuestion(peer, 'task-1', 'which database?')
  const questionId = raised.questions[0]?.id
  expect(questionId).toBeDefined()
  expect(raised.questions[0]).toMatchObject({ status: 'open', taskId: 'task-1' })

  await service.answerQuestion(ports.supervisor, questionId!, 'postgres')
  expect(ports.subagents.sent).toHaveLength(1)
  expect(ports.subagents.sent[0]?.to).toBe(String(peer.id))
  expect(ports.subagents.sent[0]?.text).toContain('postgres')
  expect(service.state(ports.supervisor).questions[0]).toMatchObject({ status: 'answered', answer: 'postgres' })
})

it('raises the same question idempotently for the same peer, task, and text', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  await service.start(ports.supervisor, HIGH_RISK)
  const lead = await service.createLead(ports.supervisor)
  const peer = await service.createPeer(lead, 'impl')
  await service.startTask(lead, peer, 'task-1')
  const first = await service.raiseQuestion(peer, 'task-1', 'which database?')
  const second = await service.raiseQuestion(peer, 'task-1', 'which database?')
  expect(second.questions).toHaveLength(1)
  expect(second.questions[0]?.id).toBe(first.questions[0]?.id)
})

it('keeps the answer durable when delivery fails and re-delivers the recorded answer on retry', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  await service.start(ports.supervisor, HIGH_RISK)
  const lead = await service.createLead(ports.supervisor)
  const peer = await service.createPeer(lead, 'impl')
  await service.startTask(lead, peer, 'task-1')
  const raised = await service.raiseQuestion(peer, 'task-1', 'which database?')
  const questionId = raised.questions[0]!.id

  ports.subagents.failNextSend(new Error('inbox closed'))
  await expect(service.answerQuestion(ports.supervisor, questionId, 'postgres')).rejects.toThrow(/inbox closed/)
  expect(service.state(ports.supervisor).questions[0]).toMatchObject({ status: 'answered', answer: 'postgres' })

  await service.answerQuestion(ports.supervisor, questionId, 'mysql')
  expect(ports.subagents.sent).toHaveLength(1)
  expect(ports.subagents.sent[0]?.text).toContain('postgres')
  expect(ports.subagents.sent[0]?.text).not.toContain('mysql')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/service.spec.ts -t "question"`
Expected: FAIL — `service.raiseQuestion is not a function`.

- [ ] **Step 4: Extend the subagent port**

In `src/host/service.ts`, add to `OrcSubagentPort`:

```ts
  sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: { signal: AbortSignal }): Promise<MessageId>
```

Both `ContentBlock` and `MessageId` are exported from `@deepseek-ai/dsh-llm` (verified at `dsh-llm/lib/types/types.d.ts:102` for `ContentBlock`). Add them to the existing DSH import block in `src/host/service.ts`, as type-only imports if the file's existing style separates type imports.

- [ ] **Step 5: Add the deterministic identity**

Place it beside `peerIdentity` at the bottom of the file:

```ts
/**
 * The durable identity of one peer question.
 *
 * Derived from the peer, the task, and the question text so a retried raise
 * addresses the same question instead of appending a duplicate. The separator is
 * a NUL byte so no combination of task id and question text can collide with a
 * different pair.
 */
export function questionIdentity(peer: Agent, taskId: string, question: string): string {
  const digest = createHash('sha256').update(`${taskId}\u0000${question}`).digest('hex').slice(0, 16)
  return `${idOf(peer.id)}-orc-q-${digest}`
}
```

`createHash` is already imported for `freshCorrelation`; reuse that import.

- [ ] **Step 6: Add the two service methods**

Place them beside `settleTask`:

```ts
  /**
   * Record one question a peer cannot answer itself.
   *
   * The peer cannot ask the human: DSH refuses human interaction to any owned
   * child. A repeated raise with the same task and text is the same question, so
   * it returns the committed state instead of appending a duplicate.
   */
  async raiseQuestion(peer: Agent, taskId: string, question: string): Promise<OrcState> {
    const runId = this.runIdOf(peer)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      const questionId = questionIdentity(peer, taskId, question)
      if (state.questions.some(candidate => candidate.id === questionId)) return state
      return await this.commit(session, {
        ...this.envelope(runId, 'peer', peer.id),
        type: 'question-raise',
        questionId,
        taskId,
        question,
      })
    })
  }

  /**
   * Answer one open question and deliver the answer to the peer that raised it.
   *
   * The answer is committed before it is delivered, so a crash between the two
   * leaves a durable answer. An already-answered question is not an error: the
   * recorded answer is delivered again, which is the retry path when a delivery
   * fails. Re-delivering the recorded answer means a second call can never
   * overwrite a decision the run already committed.
   */
  async answerQuestion(supervisor: Agent, questionId: string, answer: string): Promise<OrcState> {
    const runId = this.runIdOf(supervisor)
    return await this.serialize(runId, async () => {
      const session = this.sessionOf(runId)
      const state = this.ports.journal.state(session)
      const existing = state.questions.find(candidate => candidate.id === questionId)
      if (existing?.status === 'answered') {
        await this.deliverAnswer(supervisor, existing)
        return state
      }
      const next = await this.commit(session, {
        ...this.envelope(runId, 'supervisor', supervisor.id),
        type: 'question-answer',
        questionId,
        answer,
      })
      const answered = next.questions.find(candidate => candidate.id === questionId)
      if (answered !== undefined) await this.deliverAnswer(supervisor, answered)
      return next
    })
  }
```

- [ ] **Step 7: Add the delivery helper**

Place it beside `startChild`:

```ts
  /** Send one answered question to the peer it blocks. */
  private async deliverAnswer(supervisor: Agent, question: QuestionRecord): Promise<void> {
    const subagents = this.ports.subagents
    if (subagents === undefined) {
      throw new OrcServiceError('the DSH subagent runtime is not mounted; ORC cannot deliver an answer')
    }
    await subagents.sendMessage(
      supervisor,
      SessionId(question.peerId),
      [{ type: 'text', text: `ORC question ${question.id} was answered: ${question.answer ?? ''}` }],
      { signal: this.lifetime.signal },
    )
  }
```

Add `QuestionRecord` to the existing `./domain/workflow.js` type import.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/service.spec.ts`
Expected: PASS, including the pre-existing service tests.

- [ ] **Step 9: Typecheck and commit**

```bash
npm_config_cache="$PWD/.npm-cache" npm run typecheck
git add src/host/service.ts tests/fixtures/ports.ts tests/service.spec.ts
git commit -m "feat: answer a parked peer and deliver the answer to it

The answer is committed before it is delivered, matching the rule ORC
already states for itself: a request is durable before the work it
authorizes starts.

A failed delivery would otherwise strand the peer, leave its task
unsettled, and block the final review forever. An already-answered
question therefore re-delivers the recorded answer instead of raising,
which gives the Supervisor a retry without new state or a new action,
and makes it impossible for a second call to overwrite a committed
decision."
```

---

### Task 4: Expose the channel on the orc tool

**Files:**
- Modify: `src/host/tool.ts`
- Test: `tests/tool.spec.ts`

**Interfaces:**
- Consumes: `OrcService.raiseQuestion` and `OrcService.answerQuestion` from Task 3; `OrcState.questions` from Task 1.
- Produces: `orc` tool actions `raise-question` and `answer-question`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tool.spec.ts`, following the file's existing pattern for invoking an action through the registered tool:

```ts
it('raises a question as the peer that owns the task', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  const { agent, tool } = install(ports, service)
  await service.start(agent, HIGH_RISK)
  const lead = await service.createLead(agent)
  const peer = await service.createPeer(lead, 'peer-1')
  await service.startTask(lead, peer, 'task-1')

  const value = (await tool.execute(
    { action: 'raise-question', taskId: 'task-1', question: 'which database?' },
    execFor(peer),
  )) as { questions: string[] }
  expect(value.questions).toHaveLength(1)
  expect(value.questions[0]).toMatch(/:open$/)
})

it('answers a question as the supervisor and refuses a non-supervisor', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  const { agent, tool } = install(ports, service)
  await service.start(agent, HIGH_RISK)
  const lead = await service.createLead(agent)
  const peer = await service.createPeer(lead, 'peer-1')
  await service.startTask(lead, peer, 'task-1')

  const raised = (await tool.execute(
    { action: 'raise-question', taskId: 'task-1', question: 'which database?' },
    execFor(peer),
  )) as { questions: string[] }
  const questionId = raised.questions[0]!.split(':')[0]!

  await expect(tool.execute({ action: 'answer-question', questionId, answer: 'postgres' }, execFor(peer))).rejects.toThrow(
    /authority/,
  )
  const answered = (await tool.execute(
    { action: 'answer-question', questionId, answer: 'postgres' },
    execFor(agent),
  )) as { questions: string[] }
  expect(answered.questions[0]).toBe(`${questionId}:answered`)
})

it('exposes open questions in every tool result', async () => {
  const ports = fakePorts()
  const service = new OrcService(ports)
  const { agent, tool } = install(ports, service)
  await service.start(agent, HIGH_RISK)
  const lead = await service.createLead(agent)
  const peer = await service.createPeer(lead, 'peer-1')
  await service.startTask(lead, peer, 'task-1')
  await tool.execute({ action: 'raise-question', taskId: 'task-1', question: 'which database?' }, execFor(peer))

  const status = (await tool.execute({ action: 'status' }, execFor(agent))) as { questions: string[] }
  expect(status.questions).toHaveLength(1)
})
```

This file already provides `install(ports, service)` returning `{ dispose, agent, tool }`, `execFor(agent)`, and `HIGH_RISK`; follow the pattern its `'refuses a peer tool call'` test uses. `install` returns the fixture supervisor as `agent`, which is the identity `answer-question` requires.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tool.spec.ts -t "question"`
Expected: FAIL — `raise-question` is not an accepted action.

- [ ] **Step 3: Add the two actions**

In `src/host/tool.ts`, add to `ACTIONS` after `'settle-task'`:

```ts
  'raise-question',
  'answer-question',
```

Add the parameters beside `peerId`:

```ts
  questionId: {
    type: 'string',
    description: 'answer-question: the id of the question to answer, as reported by status.',
  },
  question: {
    type: 'string',
    description: 'raise-question: the decision you need from the human before you can continue.',
  },
  answer: {
    type: 'string',
    description: 'answer-question: the human decision, delivered to the peer that raised the question.',
  },
```

Add the two cases to `runAction` after `settle-task`:

```ts
    case 'raise-question': {
      const taskId = required(args.taskId, 'taskId')
      const peer = peerForTask(caller, state, taskId)
      const next = await service.raiseQuestion(peer, taskId, required(args.question, 'question'))
      return valueOf(args.action, next, risk, `question raised on task ${taskId}`)
    }
    case 'answer-question': {
      const questionId = required(args.questionId, 'questionId')
      const next = await service.answerQuestion(caller, questionId, required(args.answer, 'answer'))
      return valueOf(args.action, next, risk, `question ${questionId} answered`)
    }
```

- [ ] **Step 4: Expose the questions in every result**

In `valueOf`, after the `findings` line:

```ts
    questions: state.questions.map(question => `${question.id}:${question.status}`),
```

- [ ] **Step 5: Extend the model-facing policy**

In `ORC_POLICY`, append to the final paragraph:

```text

A Lead or Peer cannot ask the human: DSH refuses human interaction to any agent another agent owns, so `ask_user_question` is not available to them. A peer that needs a decision only the human can make raises it with `action: "raise-question"` and stops. While a question is open the run is parked — the review, the final review, and settlement of that task are all refused. Put the question to the human yourself, then answer it with `action: "answer-question"`; ORC delivers the answer to the peer that raised it.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/tool.spec.ts`
Expected: PASS, including the pre-existing tool tests.

- [ ] **Step 7: Run the whole suite, typecheck, and pack check**

```bash
npx vitest run
npm_config_cache="$PWD/.npm-cache" npm run typecheck
npm_config_cache="$PWD/.npm-cache" npm run pack:check
```

Expected: every test passes, typecheck is clean, and the pack check reports the same archive entry count as before this change.

- [ ] **Step 8: Commit**

```bash
git add src/host/tool.ts tests/tool.spec.ts
git commit -m "feat: expose the ORC question channel on the orc tool

The Supervisor drives the hierarchy through the tool, so the question
channel needs the same surface as every other transition. A peer raises
through peerForTask, which already resolves the peer that owns a task
for settle-task; the Supervisor answers, and both the service and the
reducer refuse any other caller.

Status now reports every question with its state, so a parked run says
what it is waiting on."
```

---

## Verification after all four tasks

Three tiers, each proving a different property. Do not skip the third.

- [ ] **Tier 1 — deterministic integration.** Add one test that drives the whole loop through `OrcService` with the recording fixture: raise, confirm each of the four gates refuses, answer, confirm delivery reached the correct peer, confirm the run can then settle and leave `implement`.
- [ ] **Tier 2 — real child mechanism check.** Create a real child through the real subagent runtime and read its assembled prompt and tool schema. Assert `ask_user_question` is absent and `orc` is present. This is the deterministic evidence for the hard guarantee.
- [ ] **Tier 3 — real end-to-end.** Re-run the live harness against the real `codex` and `claude` CLIs through to `completed`, confirming the established `orc/*` event path is unchanged.

This plan does not claim a real model will choose to raise a question when it meets ambiguity. That is model behaviour and is not deterministic. The mechanism is what is guaranteed and what is verified.
