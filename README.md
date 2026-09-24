# ORC workflow plugin for DeepSeek Harness

**English** | [Tiếng Việt](README.vi.md)

`@tonamson2/dsh-orc` is one DSH bundle package that adds the ORC workflow to a
DeepSeek Harness profile: a Supervisor → Lead → Peer run with separate review
and security audit, routed through the provider/model or host CLI you choose.

The bundle is the only package a user installs. It mounts two Loader rows —
`orc-host` (settings, journal, `orc` service, `orc` tool, policy, pre-step gate)
and `orc-remote-host` (the Remote face) — and one Web settings page.

## Requirements

| Requirement | Value |
|---|---|
| DSH | exactly `0.1.6-alpha.2` (see [Supported DSH versions](#supported-dsh-versions)) |
| Node.js | 20 or newer (the DSH CLI's own requirement) |
| pnpm | required by `dsh plugin` for profile package management |
| Codex CLI (optional) | `0.156.1` or newer, when you select the Codex subscription backend |
| Claude Code CLI (optional) | `2.1.280` or newer, when you select the Claude Code subscription backend |

Only the CLI you actually select is required. Newer CLI versions have no fixed
upper bound, but ORC re-runs its version, authentication, and capability probe
before dispatch and refuses a version that fails it.

A version minimum is not admissible evidence. High-risk review and audit accept a
route only when its live version is *exactly equal* to the version a benchmark
record measured, so Claude Code `2.1.280` and any Codex newer than `0.156.1`
lose the high-risk route until you measure that version — see
[Benchmark evidence](#benchmark-evidence).

## Install

Install the one bundle package into a Web profile:

```sh
dsh plugin --profile web add @tonamson2/dsh-orc
```

From a local build, install the packed tarball by absolute path:

```sh
npm pack
dsh plugin --profile web add file:/absolute/path/to/tonamson2-dsh-orc-0.1.0.tgz
```

The same installation is available from the DSH **Plugins** page. Installing
selects the bundle layer and activates both ORC rows.

## Enable and disable

Disabling the bundle removes every runtime contribution — the `orc` service, the
`orc` tool, the decision policy, the journal projection, and the ORC settings
page — while leaving the rest of the profile composition, the standard preset,
the global model defaults, and provider credentials untouched. Re-enabling
restores them. Removing the package removes it from the profile.

- Plugins page: toggle the `@tonamson2/dsh-orc` bundle.
- Profile file: add or remove `@tonamson2/dsh-orc` in
  `$DSH_HOME/profiles/web/package.json` under `dsh.profile.bundles`, then
  restart the profile.

The bundle never edits shipped profile files, the standard preset, global model
defaults, or provider credentials, and it stores route references and policy
only — never a credential.

## Session behavior

The model and provider you selected in the chat stay the **Supervisor** for that
session. Enabling ORC does not replace the selected preset, change the model, or
change global defaults; the run's Lead and Peers inherit the Supervisor's live
provider/model route.

The session's ORC mode decides how early a run opens:

- **Adaptive** (default): the classification below decides.
- **Always**: an ORC run opens for every admitted request, however small — the
  pre-step gate sees only the request text, so it does not guess whether a
  request is trivially direct and honors the mode you chose.

Before implementing, the Supervisor classifies the request:

- Small, isolated, low-risk work — a typo, a small documentation fix, one
  contained visual adjustment — may be handled directly, with no ORC state.
- Multi-step, multi-file, architectural, explicitly planned, or explicitly
  reviewed work starts ORC.
- Money movement, balances, payments, authentication, authorization, and
  security-sensitive changes always start ORC, however small the diff.
- If direct work reveals substantial scope or high risk before implementation,
  the Supervisor escalates to ORC before continuing.

Once ORC starts, review and security audit are separate stages. Critical, high,
and medium findings block until they are fixed and re-reviewed. A failed,
malformed, missing, or unavailable report is blocking and is never represented
as a clean audit: ORC states the required report format to each review and audit
backend it dispatches to, and a malformed report leaves the run blocked in its
stage, so the same stage can be dispatched again once the cause is fixed.

An ORC child — Lead or Peer — cannot ask the human: DSH refuses human interaction
to any agent another agent owns, so `ask_user_question` is not available to them.
A Peer that needs a decision only the human can make raises it with the ORC tool
and waits, and the run parks — the review, the final review, and settlement of
that task are refused until the question is answered. The Supervisor puts the
question to the human and answers it, and ORC delivers the answer to the peer that
raised it. A Lead owns no task, so it states the decision it needs in its final
result instead.

## Settings

The ORC page lives in the Web settings section and owns only the `orc` settings
namespace. It configures:

- per-session ORC behavior (`adaptive` or `always`) and the direct-versus-ORC
  risk policy;
- the code implementation route, defaulting to the configured DeepSeek Flash
  v4.1 provider/model at high effort when available. **This route governs one
  thing only: an explicit `dispatch` with `stage: 'code'`.** The run's Lead and
  Peer children inherit the route you selected in the chat instead, because a
  DSH child agent can only be given a DSH provider route — a CLI-selected
  backend never reaches one;
- allowed backends, and **Manual** per-stage assignments (spec, plan, review,
  audit) or **Auto** routing;
- a free-text **route entry**, so the page can allowlist a route the live
  catalog cannot discover yet — including on a fresh install, where nothing is
  discoverable and no route is configured;
- DSH provider/model references or a Codex/Claude Code CLI selection;
- a CLI executable path when it is not discoverable on `PATH`, plus the CLI
  health/authentication result;
- Auto-routing limits and an optional cost ceiling.

Auto routing uses live provider/CLI catalogs and versioned ORC benchmark
evidence, and it records the exact catalog snapshot and benchmark record behind
every decision. **Recorded official capability and pricing claims are not
implemented**: every catalog entry carries an empty `sourceUrl`, and
`retrievedAt` is the moment ORC observed the route live, not the moment a source
was retrieved. The only capability evidence ORC uses is a route's own live probe
(version, authentication, and a harmless capability run), and the only cost it
uses is a benchmark record's measured cost. A newly available model is not
eligible for high-risk review or audit until the required benchmark evidence
exists. If no allowed route meets the stage's quality floor, the stage stops and
asks you to configure another route.

### Provider connection test

The connection test sends a minimal, harmless request through the selected
provider/model. The page warns before sending it:

> This test may use provider quota or incur cost

A green result is bound to the exact provider/model/configuration revision
tested; any relevant configuration change invalidates it. A green test is not a
guarantee of future availability, and a later authentication, network, quota, or
service failure remains a task failure.

### Failure states

Missing or invalid settings, unavailable providers, failed connection tests,
unsupported CLI versions, failed capability probes, and missing authentication
are shown as actionable errors. A failure after a successful test stays a task
failure: ORC never silently switches to another provider, model, or CLI, and it
never falls back to a packaged runtime.

A **route refusal** is not a run failure. When no allowed route meets a stage's
evidence, cost, or independence rule, the stage stops with an actionable
`no-qualifying-route` / `no-independent-route` / `no-code-route` error and the
run keeps its phase, so you can configure a route or generate the missing
evidence and dispatch the same stage again — no restart, and no lost work. Every
other routing failure, such as a provider discovery fault, remains blocking.

**One ORC run per session, and a failed or completed run ends ORC for that
session.** `OrcService.start` returns the run a session already recorded whenever
one has started, so a session that has run ORC cannot start a second run. The
`failed` phase is terminal, and so is `completed`: a single transient provider or
CLI error during a dispatch therefore ends ORC in that session, and the only
recovery is to start a new chat session. Route refusals (above) and refused
reports are the recoverable cases — they leave the run in its phase, so the same
stage can be dispatched again.

## Benchmark evidence

The bundle ships known-bug and false-positive fixtures under `benchmarks/` and
the runner that scores a route against them under `scripts/`. Verify the fixture
manifest keylessly — no model, no network, no credential:

```sh
node scripts/benchmark.mjs --verify-fixtures
```

**What the score measures.** Each fixture's prompt offers that fixture's
candidate finding ids — the exact vocabulary the scorer accepts — and every list
mixes ids whose bugs are present in the code (exactly the fixture's seeded
`expected` set) with plausible distractor ids that are absent from it. A clean
fixture is not announced as candidate-free: it offers a non-empty list of
distractors too. The score is therefore a **recognition-with-distractors**
measure: it says whether the selected route reported the seeded bug(s) that are
present *and* rejected the absent candidates offered alongside them, which is
why echoing the whole vocabulary now produces false positives instead of a
perfect score.

It is **not** a free-form review-accuracy score. A correct finding reported
under an identifier outside the offered vocabulary is not credited, so the
number says nothing about how a route names, ranks, or explains issues on real
code, and nothing about whether it can surface a real bug the suite did not
seed. Read it as a floor on discrimination, not as a quality ranking.

**The bundle ships two measured records**, and it is the pair that makes the
high-risk path complete. `benchmarks/evidence/` carries
`codex_gpt-6-sol_high_2026-09-24T02_44_02.851Z.json` (backend `codex`, model
`gpt-6-sol`, effort `high`, backend version `0.156.1`, detection `1.0`,
false-positive `0.2`) and
`claude_claude-sonnet-5_high_2026-09-24T03_09_19.373Z.json` (backend `claude`,
model `claude-sonnet-5`, effort `high`, backend version `2.1.281`, detection
`1.0`, false-positive `0.0`). Each also records its date, the suite revision
`orc-review-v1`, the scopes it covers (`financial` and `security`), and its
measured latency and cost.

Two records ship because **a high-risk review and its paired audit must run on
different backends**: the audit must be independent of the review. With only one
evidence-qualified backend the audit is refused with `no-independent-route`, so
the pair is what lets a fresh install run the full money/security gate.

Admissibility requires **exact version equality**: a record matches a route only
when its `backendVersion` equals the live catalog's observation for that exact
backend, model, and effort, its date is inside `catalogMaxAgeDays`, and its scope
covers the required risk areas. The documented CLI minimums are therefore not
evidence. Claude Code `2.1.280` — the minimum this bundle supports — and any
Codex newer than `0.156.1` do not match the shipped records, so those routes are
excluded from high-risk review and audit until you measure them with the runner
below. That is the fail-closed behavior, not a defect: an unmeasured version may
behave differently.

**The two shipped records expire on 2026-10-01.** They were measured on
2026-09-24 and the default `catalogMaxAgeDays` is 7, so from 2026-10-01 they are
no longer fresh and every high-risk review and audit fails closed with
`no-qualifying-route` until the routes are re-measured. Re-measure both shipped
routes with the runner — the version must be the exact version the installed CLI
reports:

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-6-sol --effort high --version 0.156.1 \
  --command codex --arg exec --arg --json --arg -

node scripts/benchmark.mjs \
  --backend claude --model claude-sonnet-5 --effort high --version 2.1.281 \
  --command-json '["claude","--print","--output-format","json","--model","claude-sonnet-5","--effort","high"]'
```

Each score is a measurement, not a promise. It was taken on one specific machine,
account, and CLI build against this suite revision, so a record is evidence that
this exact route cleared the floors — not a general quality guarantee about the
model, and not a claim about any other route. A bundle with no evidence directory
at all still yields the fail-closed empty snapshot, which refuses high-risk
review and audit with `no-qualifying-route` rather than admitting an unmeasured
route.

**A DSH provider route can never serve high-risk review or audit.** The live
provider catalog exposes no backend version — every provider catalog entry
records an empty `backendVersion` — and admissibility requires a real, non-empty
version equal to that live observation (R22). No record you generate can change
that, because there is no provider version for a record to match; that path is
served by a host CLI (Codex or Claude Code), whose live catalog does carry a
version. Provider routes remain usable for `spec`, `plan`, `code`, and for a
review or audit the classifier does not mark high-risk.

Generate one additional versioned record per **host CLI** route you want
high-risk review and audit routed to. From a recorded run:

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-5.2-codex --effort high --version 0.156.1 \
  --responses recorded-responses.json
```

Or by invoking the selected CLI directly. The argv is explicit and is never
shell-interpolated: pass the executable with `--command` and each argument with
its own repeated `--arg`, or pass the whole argv as JSON with `--command-json`.
The fixture prompt stays on stdin in both forms.

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-5.2-codex --effort high --version 0.156.1 \
  --command codex --arg exec --arg --json --arg -

node scripts/benchmark.mjs \
  --backend claude --model claude-opus-4-1 --effort high --version 2.1.281 \
  --command-json '["claude","--print","--output-format","json","--model","claude-opus-4-1","--effort","high"]'
```

**Output formats the runner understands.** Before it looks for `FINDING:` lines,
the runner reduces a spawned invocation's stdout to the assistant's accepted
final text. Three shapes are understood:

- **Claude Code `--output-format json`** — a single JSON object whose `type` is
  `result`; the answer is its `result` string, JSON-decoded so the newlines it
  escaped become real finding lines. This is the shape ORC itself dispatches to
  Claude (`--output-format json`; see `claudeArgv` in `src/host/cli.ts`), and the
  shape was confirmed against a real `claude` `2.1.281` invocation. An
  `is_error: true`, a `subtype` other than `success`, or a `result` that is
  missing or not a string fails that fixture's run; an empty `result` is a real
  "reported nothing" answer and scores zero without failing.
- **Codex `--json` JSONL** — one event object per stdout line. The answer is the
  `text` of the `item.completed` event whose item type is `agent_message`, with
  the newlines JSON escaped decoded; every non-assistant event is ignored. A
  `turn.failed` or top-level `error` event fails that fixture's run.
- **Plain text** — the whole stdout is the answer. This is what `claude --print`
  emits at `--output-format text`, and what `codex exec` emits without `--json`.

A stdout that opens a JSON object is an envelope attempt, never plain text:
malformed JSON, or a JSON object that matches none of the shapes above, **fails
the run**, naming the fixture and the supported formats. It is never read as
plain text and silently scored as zero findings.

An invocation that exits 0 but yields **no extractable assistant text fails the
run** and writes no record; it is never scored as a zero-finding (clean) result.
An extracted report that happens to be **empty still scores zero findings**,
which is the correct reading for a clean fixture. The two are deliberately
different outcomes, so a mis-specified `--command` fails loudly instead of
silently producing an inadmissible zero.

`--version` is required for a scoring run: an evidence record whose
`backendVersion` is empty can never be admissible, so the runner refuses to
write one. The runner never guesses a route, never calls a model on its own, and
never falls back to another backend. Records are written to
`benchmarks/evidence/` — the directory the bundle ships, alongside its own
record — and are read by the Host when the profile loads, so restart the profile
after generating them.

## Supported DSH versions

This release supports **exactly `@deepseek-ai/dsh*` `0.1.6-alpha.2`** — the
minimum and the newest tested version are the same. There is no supported range:
DSH `0.1.7-alpha.2` removed `ctx.settings.installSection` and
`ctx.settingsScope`, which this bundle's settings design requires, so it is
**not supported**. The exact passing package versions and extension contracts
are recorded in [`docs/compatibility.md`](docs/compatibility.md). A DSH release
outside the supported set is unsupported until ORC's integration checks pass and
the set is updated.

## Known limitations

1. **The ORC Remote face is mounted by this bundle's own client plugin, and by
   nothing else.** DSH's Web client assembly value-imports a fixed build-time
   list of `/remote` artifacts and discovers nothing at runtime, so
   `ctx.remote.orc` does not exist in a clean profile until the ORC client
   plugin mounts its own hand-written contribution through the public
   `ctx.remote.$mount(...)` API. That is exactly what the shipped plugin does,
   so the settings page reads the live catalog, probes a route, and shows CLI
   health in a clean Web profile. Two consequences remain. `./typert` and
   `./remote` are still deliberately **not** declared as package exports: the
   Typert loader fails loud on a declared-but-missing artifact, and the
   published generator cannot build them for an external package — the
   contribution is hand-written plain data instead, which the client Gateway
   validates structurally. And a profile that mounts no Remote client service
   at all shows the page's explicit *"The ORC remote face is unavailable in this
   profile"* state: the page still works there, because its route entry control
   does not depend on the catalog. Evidence: the Step 3a section of
   [`docs/compatibility.md`](docs/compatibility.md).
2. **A session that ran ORC cannot be resumed by DSH `0.1.6-alpha.2`.** ORC's
   `orc/*` session events are outside DSH's `KNOWN_SESSION_EVENT_TYPES`, and the
   only compatibility mechanism is the persisted `SessionEvent.ignorable` marker,
   which `Session.append` cannot set. A session whose log contains `orc/*`
   events therefore fails to resume until DSH exposes an ignorable-append path.
3. **The two shipped benchmark records expire on 2026-10-01.** They are dated
   2026-09-24 and the default `catalogMaxAgeDays` is 7, so from 2026-10-01 every
   high-risk review and audit fails closed with `no-qualifying-route` until the
   routes are re-measured with the runner (see
   [Benchmark evidence](#benchmark-evidence)).
4. **One ORC run per session.** A session whose ORC run reached `failed` or
   `completed` cannot start another one: `OrcService.start` returns the existing
   run, and both phases are terminal. A single transient provider or CLI error
   during a dispatch therefore ends ORC for that session, and the only recovery
   is a new chat session. Route refusals and refused reports are recoverable in
   place, because they leave the run in its phase.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run pack:check
node scripts/clean-profile-smoke.mjs "0.1.6-alpha.2"
```

The smoke script packs the bundle, installs it into a disposable Web profile
through `dsh plugin`, boots that profile headlessly (ephemeral port, no browser)
to drive the real Plugin Manager enable/disable operations and their
restart-required reporting, exercises removal, and drives the complete ORC
workflow with keyless fake inputs. It never calls a model provider, and it
cleans up the directory it created on failure as well as on success. `dsh plugin`
forwards to pnpm, so pnpm must be on `PATH`; CI provisions an explicitly pinned
version (`.github/workflows/ci.yml`) rather than relying on the runner image.

`tests/integration/*` exercise the packed archive, so they build `lib/` before
packing — `npm test` is self-contained and never tests a stale build.

## Publishing

The package is `private: true` and is **not** published by this repository's
automation. Publishing requires an explicit release instruction; the bundle must
use a scope controlled by the publisher and must not impersonate the
`@deepseek-ai` scope.
