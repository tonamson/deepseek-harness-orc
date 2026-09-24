# The ORC question channel

## Status

Design approved for user review. This document defines the intended contract; it does not authorize implementation before the user approves this written spec.

## Problem

ORC's Lead and Peer children are DeepSeek Harness child agents. DSH refuses human
interaction to any agent owned by another live agent, so a child that calls
`ask_user_question` receives a hard error instead of an answer. The refusal is
enforced at call time in the questions service, not by withholding the tool, so
the tool is visible to every child and the failure appears only when a child
reaches for it:

> "human interaction is unavailable while the calling agent is owned by another
> live agent; include the unresolved question or decision in the child agent's
> final result" — `dsh-user-questions/lib/index.js:59`, error code
> `DELEGATED_CALLER`.

Three consequences follow, and ORC currently addresses none of them:

1. A child that needs a human decision breaks its own turn instead of parking.
2. Nothing in ORC records that a decision is outstanding, so a run can stall with
   no visible cause and no way to see what is being waited on.
3. Nothing carries an answer back to the child, so even a Supervisor that learns
   of the question has no supported way to unblock the peer.

`AgentOptions` offers no tool scoping, so ORC cannot remove the tool by
tightening the options it passes to a child
(`dsh-agent/lib/types/runtime-types.d.ts:21`). DSH does, however, expose a
per-child tool filter on the delegation request itself:

> "In-process backends apply it as a scoped `tools.restrict()` in the child's
> creation window: the named tools vanish from the child's prompt AND refuse to
> execute (one visibility)" — `SubagentStartRequest.toolFilter`,
> `dsh-subagent/lib/types/types.d.ts`.

That makes a hard guarantee available without changing DSH.

## Goals

- Guarantee that no ORC child can ask the human: the tool must be absent from the
  child's prompt and refuse to execute if reached another way.
- Record an outstanding decision durably in the run, so a parked run states what
  it is waiting on.
- Park the run while a decision is outstanding: no phase advance and no
  self-contradictory settlement.
- Let the Supervisor answer, and have ORC deliver that answer to the blocked peer
  without depending on the model remembering to relay it.
- Keep every change inside the ORC plugin. Use only DSH extension points that are
  already public; do not fork or patch DSH.

## Non-goals

- Changing DSH's delegation rule, the questions service, or any DSH package.
- Letting a child talk to the human directly, by any route.
- Modelling a question as a review finding, or widening the report parser to
  accept findings without a file and line.
- Guaranteeing that a model chooses to raise a question when it meets ambiguity.
  This spec guarantees the mechanism, not the model's judgement.
- Retrying delivery automatically on a timer. Delivery failure surfaces and is
  retried by calling the answer action again.

## Durable state model

One new record type, one new state field, two new events, two new transitions,
and four gate additions. All of it lives in `src/domain/workflow.ts`.

```ts
/** One open question a peer raised, and the Supervisor's answer. */
export interface QuestionRecord {
  /** Stable identity; derived so a retried raise addresses the same question. */
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

`OrcState` gains `questions: QuestionRecord[]`, and `initialState()` returns
`questions: []`.

Two events are added to `OrcEvent`:

```ts
| (EventBase & { type: 'question-raise'; questionId: string; taskId: string; question: string })
| (EventBase & { type: 'question-answer'; questionId: string; answer: string })
```

`question-raise` deliberately does not carry `peerId`. The transition derives it
from `event.actorId`, exactly as `task-settle` derives the settling peer. A field
that cannot be carried cannot be lied about.

### Transitions

**`question-raise`** — `roles: ['peer']`, `from: NON_TERMINAL_PHASES`

- The task must exist and must not already be `settled`. A peer that has reported
  its work finished cannot then declare itself blocked on it; otherwise the
  reducer throws `phase: task T is already settled`.
- `task.peerId` must equal `event.actorId`; otherwise the reducer throws
  `authority: peer X may not raise a question on task Y assigned to Z`.
- `question` must be non-empty after trimming.
- `questionId` must not already exist in the run.
- The record is appended with `peerId: event.actorId`, `status: 'open'`,
  `answer: null`.

`from: NON_TERMINAL_PHASES` is as wide as `question-answer`'s gate, and the
guards below are what make it safe: the task must exist, must not already be
settled, and must be owned by the raising peer. A narrower `['implement']` gate
would be false protection, not a restriction. `review-request` requires only
`!hasOpenBlocking` and `!hasOpenQuestion`, not `requireAllTasksSettled`, so in a
two-peer run peer-1 can settle, the lead can dispatch review, and the run can be
in `review` while peer-2's task is still `started`. A peer in that position
could not raise the question it needs to park on if the gate were
`['implement']`.

**`question-answer`** — `roles: ['supervisor']`, `from: NON_TERMINAL_PHASES`,
`authority: requireSupervisor`

- The question must exist and be `open`.
- `answer` must be non-empty after trimming.
- The record moves to `answered` with the answer recorded.

The `from` gate is intentionally wide. Answering a question is not a lifecycle
advance; it resolves a pending decision, and must remain possible in every
non-terminal phase. This also keeps the transition valid if ORC later gains a
resume path out of `failed`.

### Gates

A helper `hasOpenQuestion(state)` returns whether any question is `open`.

| Transition | Added rule |
| --- | --- |
| `review-request` | refuse while `hasOpenQuestion` — `blocking: review cannot start while a question is open; answer it first` |
| `final-review-request` | refuse while `hasOpenQuestion` — `blocking: the final branch review requires every question answered` |
| `task-settle` | refuse when this task has an open question — `blocking: task T has an open question; answer it before settling` |
| `canComplete` / `completionBlockers` | add `${n} question(s) are unanswered` |

Because `review-request` and `final-review-request` refuse while a question is
open, a run cannot leave `implement` until every question is answered. The
completion predicate still states the blocker: it is documented as the single
completion predicate, and a predicate that omits a blocker misleads every later
reader.

`task-settle` is gated only for the task that carries the open question. A peer
that has finished work unaffected by the question may still settle, because
recording finished work is not progress on an unanswered decision, and gating it
would add a tool-call failure path that buys nothing.

### Compatibility

The change is purely additive. The new field is supplied by `initialState()`, and
no new event appears in an existing log. A log written before this change replays
to `questions: []`, and every existing gate behaves exactly as before. The event
`version` stays `1` and no migration is required.

## Service operations and delivery

Two methods are added to `OrcService`, following the existing pattern of
resolving the run, serializing on it, and letting the reducer validate authority.

**`raiseQuestion(peer, taskId, question)`**

- Resolve the run from the peer and serialize on it.
- Derive the identity deterministically, so a retried raise addresses the same
  question instead of creating a duplicate:

```ts
export function questionIdentity(peer: Agent, taskId: string, question: string): string {
  const digest = createHash('sha256').update(`${taskId}\u0000${question}`).digest('hex').slice(0, 16)
  return `${idOf(peer.id)}-orc-q-${digest}`
}
```

- If a question with that identity already exists, return the current state
  without committing. This mirrors `createPeer`, which returns the existing child
  when its derived identity is already present.
- Otherwise commit `question-raise` with `actor: 'peer'` and `actorId: peer.id`.

**`answerQuestion(supervisor, questionId, answer)`**

Delivery is ordered commit-first, matching the rule ORC already states for
itself: a request is committed before the delegated run starts, so a crash
mid-operation stays recoverable. The answer must be durable before it is sent.

- If the question is already `answered`, do not commit again. Re-deliver the
  **recorded** answer, ignoring the newly supplied text, and return the current
  state.
- Otherwise commit `question-answer`, then deliver.

Re-delivery is the retry path. A failed delivery otherwise leaves the peer
unwoken, its task unsettled, and `requireAllTasksSettled` permanently blocking
`final-review-request` — the run could never finish. Making the answer action
idempotent gives the Supervisor a retry without new state and without a new
action, and re-delivering the recorded answer means a second call can never
overwrite an already-recorded decision.

**Delivery** calls the subagent runtime directly:

```ts
await subagents.sendMessage(supervisor, SessionId(peerId), [{ type: 'text', text: … }], { signal })
```

`OrcSubagentPort` gains `sendMessage` to match the runtime ORC already receives
from `ctx.get('subagents')`. That interface is ORC's own seam; extending it is an
ORC change, and the object ORC already holds satisfies it.

## Tool surface

Two actions are added to the `orc` tool: `raise-question` (`taskId`, `question`)
and `answer-question` (`questionId`, `answer`).

- `raise-question` resolves the peer with the existing `peerForTask(caller, state,
  taskId)` helper, already used by `settle-task`, and passes that peer to the
  service as the acting identity.
- `answer-question` passes the caller; the service's `requireSupervisor` and the
  reducer both refuse a non-supervisor.

`valueOf` gains one line so every result exposes outstanding decisions:

```ts
questions: state.questions.map(question =>
  `${question.id}:${question.status}:${question.question.replace(/\s+/g, ' ').slice(0, MAX_STATED_QUESTION_CHARS)}`,
),
```

`MAX_STATED_QUESTION_CHARS` is 200. The readout has to carry the question's text
because the Supervisor is the one who puts it to the human, but the text is
model-authored and unbounded, and it enters both the durable session log and,
through the answer, another agent's context; the bound keeps one raise from
flooding either. Collapsing whitespace to a single space keeps the readout on one
line.

`ORC_POLICY` gains a paragraph describing the flow: a peer raises, the run parks,
the Supervisor puts the question to the human, and ORC delivers the answer back.

## Child contract

`startChild` adds the hard guarantee to the delegation request whenever the
profile actually registers the tool:

```ts
toolFilter: { deny: ['ask_user_question'] },
```

`tools.restrict()` rejects an unknown name, so a preset that omits
`ask_user_question` — the `minimal` preset, or a user-authored one — is a
supported configuration in which the filter is omitted and the guarantee holds
vacuously (see Known risks). A tool present in the parent's view still carries the
filter.

A capability guard fails loudly when the provider cannot honour it, matching
ORC's fail-closed stance on capabilities it depends on:

```ts
if (provider.capabilities.toolFilter !== true)
  throw new OrcServiceError(`the DSH subagent provider "${ORC_CHILD_PROVIDER}" cannot restrict child tools, so ORC cannot guarantee its children never ask the human`)
```

The child's prompt gains one of two role-specific contracts. A Peer is told it
cannot ask the human, that `ask_user_question` is not available to it, and that
when it needs a decision only the human can make it must call the `orc` tool with
action `raise-question` (`taskId`, `question`) and then stop and wait; the
Supervisor answers it and the answer arrives in its inbox; and it must not guess
on a decision that changes scope, risk, or an irreversible outcome. The Lead is
told the same about the human, and additionally that it owns no task in this run,
so it cannot raise an ORC question either — a raise resolves its peer through the
task's owner, so a Lead that raised one anyway would attribute it to that peer and
the answer would be delivered to the peer while the Lead waited for it. The Lead's
path is DSH's own guidance for an owned child: state the decision it needs in the
final result. A Peer that owns a task raises its own question; the Lead must not
raise one on its behalf.

The prompt states the contract; `toolFilter` enforces it. The guarantee does not
depend on the model reading the prompt.

## Failure behavior

| Situation | Outcome |
| --- | --- |
| Peer raises on a task it does not own | reducer throws `authority: peer X may not raise a question on task Y assigned to Z` |
| Task does not exist | `unknown task X` |
| Empty question text | `a question requires non-empty text` |
| Duplicate raise (retry) | no-op; current state returned |
| Answer from a non-supervisor | `authority: X is not the run's supervisor` |
| Unknown question | `unknown question X` |
| Answer an already-answered question | not an error; recorded answer re-delivered |
| `review-request` with a question open | `blocking: review cannot start while a question is open; answer it first` |
| Delivery fails | error surfaces; the answer stays durable; calling the action again retries |
| Provider lacks `toolFilter` | child startup fails loudly; the run blocks with the reason |

## Verification requirements

Three tiers, each proving a different property.

**Deterministic integration.** Drive `OrcService` directly with a stub subagent
port that records `sendMessage` calls. Prove the whole loop: raise, every gate
refusing, answer, delivery reaching the correct peer, and the run then able to
proceed. A stub that throws proves the delivery-failure path: the error surfaces,
the recorded answer is already durable, and a second `answer-question` call
re-delivers the recorded answer rather than overwriting it. This is the only tier
that proves the complete loop, because it does not depend on a model.

**Real child, mechanism check.** Create a real child through the real subagent
runtime and read its assembled prompt and tool schema. Assert `ask_user_question`
is absent and `orc` is present. This is deterministic evidence for the hard
guarantee, and does not depend on whether a model would have chosen to ask.

**Real end-to-end.** Re-run the existing live harness against the real `codex` and
`claude` CLIs through to `completed`, confirming the established `orc/*` event
path is unchanged.

This spec does not claim that a real model will choose to raise a question when it
meets ambiguity. That is model behaviour and is not deterministic. The mechanism
is what is guaranteed and what is verified.

Regression that must stay green: the existing test suite, `npm run typecheck`,
`npm run pack:check`, `node scripts/benchmark.mjs --verify-fixtures`, and
`node scripts/clean-profile-smoke.mjs 0.1.6-alpha.2`.

## Known risks

| Risk | Mitigation |
| --- | --- |
| The `spawn` provider does not advertise `toolFilter` | fail-loud guard; the `spawn` provider already advertises `toolFilter: true` |
| An older log has no `questions` | additive change; an explicit replay test covers it |
| A failed delivery strands a peer | idempotent re-answer is the retry path |
| A model ignores the prompt contract | the guarantee is `toolFilter`, not the prompt |
| The deny filter is applied only when the profile registers `ask_user_question` | `tools.restrict()` rejects an unknown name, and a preset that omits the tool is a supported configuration; the filter is omitted there and the guarantee holds vacuously |
| A child created before this change has no filter in its durable descriptor | cold-resuming it regains the tool and fails with the old loud `DELEGATED_CALLER` refusal; ORC cannot fix it without patching DSH |

## Source references

- `dsh-user-questions/lib/index.js:59` — the `DELEGATED_CALLER` refusal.
- `dsh-agent/lib/types/runtime-types.d.ts:21` — `AgentOptions` carries no tool scoping.
- `dsh-subagent/lib/types/types.d.ts` — `SubagentStartRequest.toolFilter`.
- `dsh-tools/lib/types/index.d.ts` — `ToolRestriction`.
- `dsh-subagent-spawn-in-process/lib/index.js` — the `spawn` provider advertises `toolFilter: true`.
- `dsh-subagent-in-process-driver/lib/index.js` — the provider applies the filter.
- `dsh-tool-ask-user/lib/index.js` — the tool's registered name, `ask_user_question`.
