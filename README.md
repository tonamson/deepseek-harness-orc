# ORC workflow plugin for DeepSeek Harness

`@tonamson/dsh-orc` is one DSH bundle package that adds the ORC workflow to a
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

## Install

Install the one bundle package into a Web profile:

```sh
dsh plugin --profile web add @tonamson/dsh-orc
```

From a local build, install the packed tarball by absolute path:

```sh
npm pack
dsh plugin --profile web add file:/absolute/path/to/tonamson-dsh-orc-0.1.0.tgz
```

The same installation is available from the DSH **Plugins** page. Installing
selects the bundle layer and activates both ORC rows.

## Enable and disable

Disabling the bundle removes every runtime contribution — the `orc` service, the
`orc` tool, the decision policy, the journal projection, and the ORC settings
page — while leaving the rest of the profile composition, the standard preset,
the global model defaults, and provider credentials untouched. Re-enabling
restores them. Removing the package removes it from the profile.

- Plugins page: toggle the `@tonamson/dsh-orc` bundle.
- Profile file: add or remove `@tonamson/dsh-orc` in
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
as a clean audit.

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

Auto routing uses live provider/CLI catalogs, recorded official capability
claims, and versioned ORC benchmark evidence. It never browses for claims on
each task, and it records the exact evidence behind every decision. A newly
available model is not eligible for high-risk review or audit until the required
benchmark evidence exists. If no allowed route meets the stage's quality floor,
the stage stops and asks you to configure another route.

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

## Benchmark evidence

The bundle ships known-bug and false-positive fixtures under `benchmarks/` and
the runner that scores a route against them under `scripts/`. Verify the fixture
manifest keylessly — no model, no network, no credential:

```sh
node scripts/benchmark.mjs --verify-fixtures
```

**What the score measures.** Each fixture's prompt names that fixture's
candidate finding ids — the exact vocabulary the scorer accepts — so a run
measures whether the selected route found the seeded bugs when it was handed
that vocabulary, and whether it kept an empty report on the fixtures that have
no seeded bug. It is **not** a free-form review-accuracy score: a correct
finding reported under an identifier outside the vocabulary is not credited, so
the number says nothing about how a route names, ranks, or explains issues on
real code.

**A fresh install ships no evidence records.** `benchmarks/evidence/` does not
exist until you generate a record, so the fail-closed evidence snapshot excludes
every high-risk review and audit: Auto routing refuses those stages with
`no-qualifying-route`, and the run stops and asks you to configure another route
or generate evidence. ORC does not ship a record because a benchmark score is
only meaningful when it measures a real run of the route you selected; an
invented score would be worse than none.

Generate one versioned record per route you want high-risk review and audit
routed to. From a recorded run:

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
  --backend claude --model claude-opus-4-1 --effort high --version 2.1.280 \
  --command-json '["claude","--print"]'
```

`--version` is required for a scoring run: an evidence record whose
`backendVersion` is empty can never be admissible, so the runner refuses to
write one. The runner never guesses a route, never calls a model on its own, and
never falls back to another backend. Records are written to
`benchmarks/evidence/` (gitignored) and are read by the Host when the profile
loads, so restart the profile after generating them.

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
