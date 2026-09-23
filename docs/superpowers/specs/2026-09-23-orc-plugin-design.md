# ORC as an independent DeepSeek Harness plugin

## Status

Design approved for user review. This document defines the intended product and integration contract; it does not authorize implementation before the user approves this written spec.

## Problem

ORC currently lives as experimental packages inside the DeepSeek Harness repository. Its profile bundle can be installed separately, but its implementation and release lifecycle are still tied to DSH. The current Codex and Claude Code provider bundles also ship pinned runtimes instead of detecting and invoking the host CLI selected by the user. ORC therefore does not yet meet the goal of an independently maintained npm plugin that can be installed into an ordinary DSH profile and route work using the user's configured providers or subscription CLIs.

## Goals

- Maintain ORC in a repository separate from DeepSeek Harness and publish one npm bundle as the user-facing installation entry point.
- Use DSH's documented bundle, Cordis, settings, subagent, tool, and client extension points; do not fork DSH or patch its core.
- Let a user choose any supported Supervisor model for each chat session without ORC replacing that choice or changing global DSH defaults.
- Let the Supervisor handle small, low-risk coding requests directly and start ORC for substantial or high-risk work.
- Provide an ORC-owned settings page, isolated from DSH Models Settings and other plugins.
- Route code, specification, planning, review, and audit work through user-authorized provider/model choices, with manual and automatic routing.
- For subscription mode, detect and invoke the selected host-installed Codex CLI or Claude Code CLI, using its native login and account configuration.
- Use catalog and repository benchmark evidence for automatic model/effort selection; fail closed when a required stage has no eligible route.
- Verify the plugin against declared DSH versions so DSH upgrades do not silently break ORC.

## Non-goals

- Changing DSH's standard preset, global model defaults, provider credentials, or other profiles during installation or activation.
- Requiring ORC for every chat or every trivial code edit.
- Installing, updating, logging in to, or modifying the user's Codex or Claude CLI configuration.
- Treating a CLI executable, a public model description, model price, or a successful connection test as proof of code-review quality.
- Silently switching to an unconfigured provider or weaker route after an error.
- Guaranteeing compatibility with every future DSH release or every future CLI version without verification.

## Distribution and compatibility

ORC is developed in its own repository. The repository publishes one DSH bundle package whose `package.json` declares `dsh.bundle.patch`; users install that package into a profile through `dsh plugin` or the DSH Plugins page. The bundle is the only package an end user needs to select. Runtime modules may be kept together or split internally if that reduces coupling without adding user installation steps.

The bundle mounts ORC's host service, model-facing tools, host CLI adapters, and Web settings client module. Its patch declares the exact dependencies and rows it adds. Enabling the bundle activates those rows; disabling it removes the runtime contributions and ORC settings page while leaving unrelated profile composition unchanged. Removing the package removes the bundle from the profile according to Plugin Manager behavior.

The plugin must depend only on DSH extension points and packages documented for external consumers. It must not import DSH monorepo source paths, modify shipped profile files, or assume a private app-boot implementation. Each ORC release declares the DSH versions it supports. CI installs the packed npm bundle into Web profiles using the minimum and newest supported DSH versions, then verifies activation, deactivation, and a complete ORC workflow.

DSH currently describes its public APIs as pre-stable. ORC therefore publishes a tested compatibility range, not an unconditional promise for future DSH versions. A DSH release outside that range is unsupported until ORC's integration checks pass and the range is updated.

The bundle's final npm package name is release metadata. It must use a scope controlled by the ORC publisher and must not impersonate the `@deepseek-ai` scope without authorization.

## Session behavior and ORC activation

When the bundle is enabled, the selected session agent receives ORC's decision policy and the ORC tool capability. The model/provider selected by the user in the chat remains the Supervisor for that session. ORC does not require a dedicated preset or change the selected preset.

Before starting implementation, the Supervisor classifies the request:

- Small, isolated, low-risk work may be handled directly without creating ORC workflow state. Examples include a typo, a small documentation correction, or a contained visual adjustment.
- Multi-step, multi-file, architectural, explicitly planned, or explicitly reviewed work starts ORC.
- Changes involving money movement, balances, payments, authentication, authorization, security-sensitive behavior, or similarly high-impact paths always start ORC, even when the diff is small.
- If a direct task reveals substantial scope or high risk before implementation, the Supervisor escalates it to ORC rather than continuing the direct path.

Once ORC starts, the main session is Supervisor and ORC owns the Supervisor → Lead → Peer hierarchy. The ORC service, not prompt text alone, validates role authority, legal phase transitions, task settlement, review/audit results, fixes, and completion. The existing strict review loop remains: review and security audit are separate; blocking critical, high, or medium findings require a fix and another review/audit cycle; final branch review and audit run after task completion. A failed, malformed, missing, or unavailable report is blocking and cannot be represented as a clean audit.

ORC-authored decision, route, delegation, finding, and phase data that affects model-visible behavior is durably logged. The route decision records the chosen provider/CLI, model, effort, task stage, risk classification, catalog/benchmark identity, and selection reason without logging credentials.

## ORC settings

The Web client registers an ORC-owned page through the supported `settings.section` extension point. The page exists only while the ORC bundle is enabled. ORC configuration uses its own settings namespace and does not write DSH Models Settings, standard preset configuration, or another plugin's namespace.

The page configures:

- Per-session ORC behavior and the direct-versus-ORC risk policy.
- Code implementation routes, defaulting to the user's configured DeepSeek Flash v4.1 provider/model at high effort when available.
- Allowed analysis backends and either manual per-stage assignments or Auto routing for spec, plan, review, and audit.
- DSH provider/model references or host CLI selection for Codex or Claude Code.
- CLI executable path when it cannot be discovered from `PATH`, and the CLI health/authentication result.
- Automatic routing policy limits and optional user cost ceilings.

Provider credentials remain owned by DSH. ORC stores route references and its own policy only. A custom-provider connection test sends a minimal, harmless request through the selected configured provider/model; the UI warns that the request may consume provider quota or incur cost. A green result is tied to the exact provider/model/config revision tested. Any relevant configuration change invalidates it. Runtime dispatch still handles authentication, network, quota, and service failures; a prior green test is not treated as a guarantee of future availability.

## Route configuration and selection

The user may configure one or more allowed backends: a custom provider/model exposed by DSH Models Settings, Codex CLI subscription, and/or Claude Code CLI subscription. For analysis stages, Manual mode assigns a route separately to each of spec, plan, review, and audit. Auto mode selects only among the user-enabled backends and routes they expose. Code implementation has a separate route policy and defaults to DeepSeek Flash v4.1 at high effort when that configured route is available.

Supervisor selection is bounded by the settings allowlist. It cannot add providers, broaden permissions, read provider credentials, or select a model/effort unavailable to the chosen backend. Model and effort are resolved for each subtask, not permanently pinned in ORC source code.

Auto routing uses three distinct evidence classes:

1. Live provider/CLI catalogs establish what the account and installed backend can use and which effort values it accepts.
2. Official provider documentation establishes stated capability, limits, and pricing, with source and retrieval time recorded. These claims do not establish review accuracy.
3. Versioned ORC benchmarks measure known-bug detection, security and financial-risk coverage, false positives, latency, and cost on comparable inputs. Benchmark results record model, effort, backend, CLI/provider version, test-suite revision, date, and evaluated scope.

Auto does not browse for benchmark claims on every task. It uses a versioned verified catalog and benchmark set, refreshes or revalidates stale data at configured maintenance or selection points, and records the exact evidence used for a decision. A newly available model is not eligible for high-risk review/audit until required benchmark evidence exists.

For small, low-risk tasks, Auto may choose the least costly eligible route meeting the stage's quality floor. For money, payment, balance, authorization, or critical security changes, review and audit use independent eligible routes at the highest validated quality and appropriate supported effort. Auto must not downgrade silently to meet a cost limit. If no configured route meets the quality floor, the stage stops and asks the user to select or configure another route.

## Host CLI requirements

Subscription mode invokes the selected executable installed on the host, not a DSH bundle's separately pinned Codex/Claude runtime. ORC discovers the executable on `PATH`; the settings page may accept an explicit executable path. Only the selected CLI is required.

The initial minimum versions are Codex CLI `0.156.1` and Claude Code `2.1.280`, based on releases available on 2026-09-23. A selected CLI below its minimum is refused. Newer versions have no fixed upper-version limit, but ORC verifies the required invocation and protocol/model/effort capabilities at connection testing and before dispatch. A nominally newer version that fails the compatibility probe is refused until ORC supports it.

The version check, authentication check, model discovery, and harmless test run use documented product interfaces. ORC never stores CLI credentials or edits native CLI settings. The exact commands/protocols are selected during implementation only after checking the then-current official Codex and Claude Code documentation. Discovery of an executable alone is not proof of an active subscription or usable account. Authentication, entitlement, model access, quota, or required-capability failures block the selected stage.

The CLI adapter runs processes through DSH's subprocess service, uses an explicit argv rather than a shell command string, follows DSH process ownership/cancellation rules, and returns only the accepted final text or a safe diagnostic. It does not silently fall back to another CLI, a packaged DSH runtime, or an API provider.

## Failure behavior

- Missing or invalid settings, unavailable providers, failed connection tests, unsupported CLI versions, failed compatibility probes, and missing authentication are shown as actionable errors.
- A provider config change invalidates its connection-test result. A CLI path/version/account change invalidates the corresponding CLI result.
- A failure after a successful test remains a task failure. It does not trigger hidden backend switching.
- A missing catalog or benchmark can exclude a route from Auto. If no eligible route remains, ORC stops and requests user action.
- A failed, incomplete, malformed, or non-completed review/audit is never normalized to success.
- Disabled ORC removes its tool, policy contribution, service, and Settings page. It does not reset DSH defaults or unrelated settings.

## Verification requirements

The implementation plan must include:

- Package archive inspection and installation into a clean Web profile using Plugin Manager; verify one-package installation, activation, deactivation, removal, and absence of changes to DSH defaults.
- Integration coverage for per-session Supervisor model preservation and ORC tools/prompt appearing only while the bundle is enabled.
- Direct-path tests for small low-risk tasks; escalation and mandatory ORC tests for high-risk and substantial tasks.
- State-machine tests proving role/phase authority, separate review and audit, finding-ID uniqueness, fix/re-review cycles, and final branch gates.
- Settings tests proving ORC namespace isolation, localized page registration, connection-test invalidation, and no credential persistence.
- Custom-provider tests for success, provider/model/config mismatch, network/auth/quota failure, and no hidden fallback.
- Fake Codex/Claude executables covering version floors, higher compatible versions, below-floor versions, malformed version output, missing executable, auth failure, protocol/capability mismatch, cancellation, process cleanup, and safe diagnostics.
- Manual and Auto route tests, including allowlist enforcement, model/effort availability, deterministic route evidence, stale/missing benchmark data, high-risk independent routes, cost ceilings, and fail-closed behavior when no qualifying route exists.
- Benchmark fixtures with known financial/security bugs and expected findings, false-positive cases, and reproducible metadata. External model runs are evidence-generation jobs, not ordinary keyless unit tests.
- Keyless recorded-session snapshots for model-visible ORC decisions, routes, tool schemas, and failure results.
- A DSH compatibility matrix that runs package install and end-to-end profile composition at the minimum and newest supported DSH releases.

## Release criteria

An ORC npm release is ready only when the clean-profile installation and full workflow pass on the declared DSH compatibility range; CLI and provider failures remain blocking; high-risk routing has validated benchmark evidence; package metadata contains publishable dependencies rather than workspace-only references; and the published archive contains every runtime, patch, client module, and localization file required by the bundle.

## Source references

- [DSH development: basic plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
- [DSH package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish/)
- [DSH settings extension cookbook](https://deepseek-harness.github.io/deepseek-harness/en/develop/cookbook/adding-a-settings-card/)
- [Codex CLI changelog, including 0.156.1 on 2026-09-23](https://learn.chatgpt.com/docs/changelog)
- [Claude Code releases, including 2.1.280 on 2026-09-22](https://github.com/anthropics/claude-code/releases)
