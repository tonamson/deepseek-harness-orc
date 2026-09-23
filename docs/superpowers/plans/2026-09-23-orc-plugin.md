# Independent ORC Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one independently maintained npm bundle that adds ORC workflow, routing, host CLI support, and an isolated settings page to compatible DeepSeek Harness Web profiles.

**Architecture:** Keep ORC's configuration, risk policy, route selection, and workflow reducer in dependency-free TypeScript modules. A thin Host Cordis plugin connects those modules to DSH settings, agents, tools, session persistence, LLM and subprocess services; a separate browser artifact registers the ORC settings section. One bundle patch mounts the Host and Client contributions without modifying DSH's standard preset or Models Settings.

**Tech Stack:** TypeScript ESM, Node.js, Cordis, published DSH extension packages, React client module, Vitest, npm pack, GitHub Actions. Use the DSH package versions in the compatibility matrix below rather than monorepo source imports.

**Spec:** `docs/superpowers/specs/2026-09-23-orc-plugin-design.md`

## Global Constraints

- One user-facing DSH bundle package in a repository separate from DeepSeek Harness; its `package.json` declares `dsh.bundle.patch`.
- Use documented DSH extension points only. Never import DSH monorepo source paths, change DSH shipped profile files, change standard preset or global model defaults, or store provider or CLI credentials.
- The chat-selected provider/model remains Supervisor for its session. Small, isolated, low-risk work may proceed directly; substantial or high-risk work uses ORC. Money, payments, balances, authentication, authorization, and security-sensitive changes always use ORC.
- ORC owns Supervisor → Lead → Peer authority and durable model-visible decisions, routes, findings, and phase transitions. Review and audit are separate. Critical, high, and medium findings block until fixed and re-reviewed; a failed, missing, malformed, or incomplete report blocks.
- Code defaults to the user's configured DeepSeek Flash v4.1 route at high effort when available. Manual analysis routes are separate for spec, plan, review, and audit; Auto uses only enabled backends and evidence-qualified model/effort combinations.
- The only selected host CLI is required. Minimums are Codex CLI `0.156.1` and Claude Code `2.1.280`; compatible newer versions have no fixed upper bound. Probe invocation, protocol, model, effort, and authentication before dispatch.
- CLI calls use DSH's `ctx.subprocess` with explicit argv, cwd, stdio, grace, and cancellation. Never shell-interpolate, install a CLI, edit native CLI configuration, or silently change backend after failure.
- ORC owns one settings namespace and a localized `settings.section` page, present only while enabled. Provider tests are bound to exact provider/model/config revisions and warn about quota/cost.
- A route is not high-risk-review/audit eligible from availability, marketing claims, price, or a successful connection test alone. Require matching versioned ORC benchmark evidence; missing/stale evidence fails closed.
- Published artifacts contain runtime, patch, browser module, and locales with publishable dependency versions. A clean Web profile must pass enable, disable, remove, full workflow, and default-preservation checks at both declared DSH versions.
- The spec's status requests user approval before implementation. This plan is review material; execution begins only after the user approves the spec and chooses an execution method.

## Review Focus

1. A CLI prints ANSI noise, a prerelease suffix, or malformed version text: reject malformed output, compare valid versions numerically, and never treat a large-looking string as compatible. Task 6 pins this.
2. A configured provider is edited after a green connection test: invalidate the test and refuse stale revision at dispatch. Task 5 pins this.
3. A reviewer repeats a finding ID or emits a clean flag alongside blocking findings: reject the report and keep the phase blocked. Task 4 pins this.
4. A benchmark covers the same model at another effort or an older CLI version: exclude that route for high-risk review/audit. Task 7 pins this.
5. ORC is disabled while a delegated run is active: cancel/settle the owned run, remove tool/prompt/page contributions, and leave unrelated settings untouched. Task 10 pins this.

## File map and ownership

The repository currently contains the spec only. Create these focused files; `src/host/index.ts` is the only Host composition entry and `src/client/index.tsx` is the only browser composition entry.

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `cordis.patch.yml` | Publishable one-package bundle, compilation, tests, and Loader rows |
| `src/domain/types.ts`, `config.ts`, `risk.ts` | Wire contracts, ORC settings validation, direct-versus-ORC policy |
| `src/domain/workflow.ts`, `report.ts` | Pure lifecycle reducer, role authority, report normalization and finding gates |
| `src/domain/evidence.ts`, `routing.ts` | Versioned catalog/benchmark identity, Manual and Auto route selection |
| `src/host/settings.ts`, `provider.ts`, `cli.ts` | DSH settings bridge, custom-provider call/connection result, host CLI probe/invocation |
| `src/host/journal.ts`, `service.ts`, `tool.ts`, `remote-host.ts`, `index.ts` | Durable events, delegated run ownership, model-facing capability/policy, ORC health Remote, Cordis composition |
| `src/client/OrcSettingsPage.tsx`, `index.tsx`, `locales.ts` | ORC-only page, slot registration, English/Chinese text and status presentation |
| `benchmarks/fixtures.json`, `benchmarks/manifest.json`, `scripts/benchmark.mjs` | Reproducible known-bug/false-positive cases and evidence generation job |
| `tests/*.spec.ts`, `tests/fixtures/*`, `tests/integration/*.spec.ts` | Domain, fake CLI/provider, bundle, keyless replay, and compatibility tests |
| `.github/workflows/ci.yml`, `README.md`, `docs/compatibility.md` | Two-version packed-bundle matrix, installation/operation guide, support policy |

**Interfaces shared between tasks:** `Stage = 'code' | 'spec' | 'plan' | 'review' | 'audit'`; `AnalysisStage = Exclude<Stage, 'code'>`; `Route = ProviderRoute | CliRoute`; `OrcConfig`; `CatalogSnapshot`; `RiskDecision`; `OrcEvent`; `OrcState`; `Report`; `RouteDecision`; `BenchmarkSnapshot`. Task 2 defines stage, route, configuration, and catalog shapes; Task 3 defines `RiskDecision`; Task 4 defines the lifecycle types; Task 7 defines benchmark and route-decision shapes. Host adapters consume these contracts without adding alternative copies.

### Task 1: Publishable bundle skeleton and compatibility contract

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `cordis.patch.yml`, `src/host/index.ts`, `src/client/index.tsx`, `tests/bundle.spec.ts`, `docs/compatibility.md`.

**Interfaces:** Produces `@tonamson/dsh-orc` as the provisional publisher-scope package name, Host `apply(ctx)`, browser `apply(ctx)`, and an archive with exactly one bundle patch. The release gate verifies publisher control of this scope before publication. Candidate support set is exactly `0.1.6-alpha.2` and `0.1.7-alpha.2`; the first compatibility run must establish whether both are supportable before the range is published. Do not widen it by semver inference.

- [ ] **Step 1: Create the test harness, then write a failing archive/manifest contract test.** Start with `package.json` containing `"scripts": { "test": "vitest run" }` and `"devDependencies": { "vitest": "^3.2.0" }`; run `npm install`. In `tests/bundle.spec.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const patch = readFileSync('cordis.patch.yml', 'utf8')
describe('one-package DSH bundle', () => {
  it('declares only ORC rows and a Web client', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.exports['./client']).toBeDefined()
    expect(patch).toContain('id: orc-host')
    expect(patch).not.toMatch(/id: (agent-default-model|standard-preset|llm-credentials)/)
    expect(JSON.stringify(pkg.dependencies)).not.toContain('workspace:')
  })
})
```

- [ ] **Step 2: Run `npm test -- tests/bundle.spec.ts`.** Expected: FAIL because `cordis.patch.yml` and the bundle metadata are absent.
- [ ] **Step 3: Create the package and patch.** Use this manifest shape and keep all runtime DSH imports on published package names:

```json
{
  "name": "@tonamson/dsh-orc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "exports": {
    ".": { "types": "./lib/types/host/index.d.ts", "default": "./lib/host/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "pack:check": "npm run build && npm pack --dry-run --json"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh": "0.1.6-alpha.2 || 0.1.7-alpha.2",
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-tools": "0.1.6-alpha.2 || 0.1.7-alpha.2",
    "@deepseek-ai/dsh-typert-protocol": "0.1.6-alpha.2 || 0.1.7-alpha.2",
    "@deepseek-ai/schemastery": "^3.18.4",
    "react": "^18.2.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.4",
    "@deepseek-ai/dsh-agent": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-client-ui-settings": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-llm": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-settings": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-subagent": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-subprocess": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-tools": "0.1.7-alpha.2",
    "@deepseek-ai/dsh-typert-protocol": "0.1.7-alpha.2",
    "@deepseek-ai/schemastery": "3.18.4",
    "@types/react": "~18.3.1",
    "esbuild": "^0.25.0",
    "react": "^18.2.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

```yaml
- insert:
    - id: orc-host
      name: '@tonamson/dsh-orc'
```

Use `tsconfig.json` with `rootDir: "src"`, `outDir: "lib"`, `declaration: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `jsx: "react-jsx"`, and `strict: true`. `scripts/build.mjs` runs `tsc`, then bundles `src/client/index.tsx` in DSH's lazy-CJS format:

```js
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
const result = await build({
  entryPoints: ['src/client/index.tsx'], bundle: true, platform: 'browser',
  format: 'cjs', write: false,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
})
const cjs = result.outputFiles[0].text
await writeFile('lib/client.js', `window.__ModuleLoader__.load({
  id: '@tonamson/dsh-orc',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    ${cjs}
    return module.exports
  }
});`)
```

Keep `src/client/index.tsx` as an empty `apply` for this task. Record the exact DSH client artifact format in `docs/compatibility.md` and test it through the actual client module loader in Task 10.

- [ ] **Step 4: Run `npm install`, `npm test -- tests/bundle.spec.ts`, `npm run typecheck`, and `npm run pack:check`.** Expected: all pass; the dry-run list contains `cordis.patch.yml`, `lib/host/index.js`, and `lib/client.js`, and contains no `workspace:` dependency.
- [ ] **Step 5: Commit.** Run `git add package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs cordis.patch.yml src/host/index.ts src/client/index.tsx tests/bundle.spec.ts docs/compatibility.md && git commit -m "chore: establish standalone ORC bundle"`.

### Task 2: Validate ORC settings without owning credentials

**Files:** Create `src/domain/types.ts`, `src/domain/config.ts`, `src/host/settings.ts`, `tests/config.spec.ts`, `tests/settings.spec.ts`.

**Interfaces:** Produces `parseConfig(input: unknown): OrcConfig`, `routeKey(route: Route): string`, `connectionRevision(config: OrcConfig, route: Route): string`, and `installOrcSettings(ctx: Context, base: OrcConfig): () => void`. `Route` is discriminated by `kind: 'provider' | 'cli'`; a provider has `provider`, `model`, `effort`; a CLI has `cli: 'codex' | 'claude'`, `model`, `effort`. `OrcConfig` has `sessionMode: 'adaptive' | 'always'`, `codeRoute?: Route`, `analysisMode: 'manual' | 'auto'`, `manual: Record<AnalysisStage, Route | undefined>`, `allowed: Route[]`, `cliPaths`, `maxCostUsd?`, and `catalogMaxAgeDays`. `CatalogSnapshot` has `id`, `observedAt`, and entries with exact route key, backend version, model, supported effort values, account access, official capability/pricing source URL, and source retrieval time.

- [ ] **Step 1: Write failing validation and isolation tests.** In `tests/config.spec.ts`:

```ts
import { expect, it } from 'vitest'
import { parseConfig, connectionRevision } from '../src/domain/config.js'

it('stores references and policy, never credentials', () => {
  expect(() => parseConfig({ providerApiKey: 'secret' })).toThrow(/unknown field/)
  const config = parseConfig({ sessionMode: 'adaptive', analysisMode: 'manual', allowed: [] })
  expect(JSON.stringify(config)).not.toMatch(/apiKey|token|password/i)
})
it('changes connection revision when an exact route changes', () => {
  const a = parseConfig({ allowed: [{ kind: 'provider', provider: 'custom', model: 'a', effort: 'high' }] })
  const b = parseConfig({ allowed: [{ kind: 'provider', provider: 'custom', model: 'b', effort: 'high' }] })
  expect(connectionRevision(a, a.allowed[0]!)).not.toBe(connectionRevision(b, b.allowed[0]!))
})
```

- [ ] **Step 2: Run `npm test -- --run tests/config.spec.ts`.** Expected: FAIL with missing `parseConfig`.
- [ ] **Step 3: Implement strict parsing and stable revision hashing.** Define the discriminated types in `types.ts`; in `config.ts` reject unknown top-level/route fields, duplicate allowed route keys, negative cost ceilings, nonpositive max ages, and an analysis Manual stage not present in `allowed`. Build `connectionRevision` from canonical JSON of the exact provider/model/effort or CLI/path/model/effort plus relevant config revision, hashed with `createHash('sha256')`; never hash or persist credentials.

```ts
export const routeKey = (r: Route): string => r.kind === 'provider'
  ? `provider:${r.provider}:${r.model}:${r.effort}`
  : `cli:${r.cli}:${r.model}:${r.effort}`
export const connectionRevision = (c: OrcConfig, r: Route): string =>
  createHash('sha256').update(JSON.stringify({ route: r, path: r.kind === 'cli' ? c.cliPaths[r.cli] : undefined })).digest('hex')
```

- [ ] **Step 4: Add a Host settings test and bridge.** In `tests/settings.spec.ts`, fake `installSection` and assert exactly one call with namespace `orc`, no call to `models`, and no secret field in the schema:

```ts
const sections: string[] = []
installOrcSettings(fakeContext({ installSection: (_owner, ns) => sections.push(ns) }), parseConfig({ allowed: [] }))
expect(sections).toEqual(['orc'])
expect(sections).not.toContain('models')
```

Implement `installOrcSettings` using `ctx.settings.installSection(ctx, 'orc', ConfigSchema, base, { setSource, onChange, validate })`; register its disposer through Cordis effect. The bridge emits a new revision to its subscribers on changes so green tests are invalidated.
- [ ] **Step 5: Run `npm test -- --run tests/config.spec.ts tests/settings.spec.ts` and `npm run typecheck`.** Expected: PASS. Commit with `git add src/domain src/host/settings.ts tests/config.spec.ts tests/settings.spec.ts && git commit -m "feat: add isolated ORC settings"`.

### Task 3: Classify direct work and escalate before implementation

**Files:** Create `src/domain/risk.ts`, `tests/risk.spec.ts`.

**Interfaces:** Produces `classifyRequest(input: { text: string; touchedPaths: string[]; plannedFiles: number; hasArchitectureChange: boolean; explicitPlanOrReview: boolean; discoveredRisk?: boolean }): RiskDecision`, where `RiskDecision = { path: 'direct' | 'orc'; risk: 'low' | 'high'; reasons: string[] }`. This is the deterministic guard used by the Supervisor tool, alongside a model-visible policy; it does not claim to infer all semantics from keywords.

- [ ] **Step 1: Write failing table tests.**

```ts
import { expect, it } from 'vitest'
import { classifyRequest } from '../src/domain/risk.js'

const base = { text: 'Correct one typo', touchedPaths: ['README.md'], plannedFiles: 1, hasArchitectureChange: false, explicitPlanOrReview: false }
it.each([
  [base, 'direct'],
  [{ ...base, plannedFiles: 3 }, 'orc'],
  [{ ...base, text: 'Fix balance rounding' }, 'orc'],
  [{ ...base, text: 'Repair withdrawal ledger entries' }, 'orc'],
  [{ ...base, touchedPaths: ['src/auth/permissions.ts'] }, 'orc'],
  [{ ...base, explicitPlanOrReview: true }, 'orc'],
  [{ ...base, discoveredRisk: true }, 'orc'],
] as const)('classifies %#', (input, path) => expect(classifyRequest(input).path).toBe(path))
```

- [ ] **Step 2: Run `npm test -- --run tests/risk.spec.ts`.** Expected: FAIL because `classifyRequest` is absent.
- [ ] **Step 3: Implement the ordered policy.** High-impact paths/text, discovered risk, architecture, explicit planning/review, and multi-file work return ORC; only one-file low-risk work returns direct. Return stable reason codes such as `high-impact`, `substantial`, `explicit-review`, `scope-escalation`, `isolated-low-risk`. Treat unknown/empty `plannedFiles` as ORC.

```ts
const highImpact = /\b(balance(?:s)?|payment(?:s)?|transfer(?:s)?|money|withdrawal(?:s)?|wallet|ledger|billing|auth(?:entication|orization)?|permission(?:s)?|password|security)\b/i
export function classifyRequest(x: RiskInput): RiskDecision {
  if (x.discoveredRisk || highImpact.test(x.text) || x.touchedPaths.some(p => highImpact.test(p)))
    return { path: 'orc', risk: 'high', reasons: ['high-impact'] }
  if (x.explicitPlanOrReview || x.hasArchitectureChange || x.plannedFiles !== 1)
    return { path: 'orc', risk: 'low', reasons: ['substantial'] }
  return { path: 'direct', risk: 'low', reasons: ['isolated-low-risk'] }
}
```

- [ ] **Step 4: Add a second test proving an initially direct task with `discoveredRisk: true` escalates before code execution.** Assert `classifyRequest({ ...base, discoveredRisk: true }).path === 'orc'` and `reasons` includes `high-impact`; run the focused test and `npm run typecheck`; expected PASS. Commit with `git add src/domain/risk.ts tests/risk.spec.ts && git commit -m "feat: classify ORC activation risk"`.

### Task 4: Enforce the durable ORC lifecycle and strict reports

**Files:** Create `src/domain/report.ts`, `src/domain/workflow.ts`, `tests/report.spec.ts`, `tests/workflow.spec.ts`.

**Interfaces:** Produces `parseReport(input: unknown, stage: 'review' | 'audit'): Report`, `reduce(state: OrcState, event: OrcEvent): OrcState`, and `initialState(): OrcState`. Each `OrcEvent` has `version: 1`, `runId`, `actorId`, `at`, and a discriminant. Define roles `supervisor | lead | peer`; phases `spec | plan | implement | review | audit | fix | final-review | final-audit | completed | failed`. Findings have globally unique IDs within a run, severity `critical | high | medium | low | info`, source stage, and status `open | fixed | dismissed`. Every request/result pair carries one correlation ID.

- [ ] **Step 1: Write report tests.** In `tests/report.spec.ts`:

```ts
import { expect, it } from 'vitest'
import { parseReport } from '../src/domain/report.js'

const finding = { id: 'F-1', severity: 'medium', file: 'src/pay.ts', line: 12, evidence: 'rounds up', remediation: 'round down' }
it('rejects contradictory, duplicate and incomplete reports', () => {
  expect(() => parseReport({ status: 'clean', findings: [finding] }, 'review')).toThrow(/contradictory/)
  expect(() => parseReport({ status: 'findings', findings: [finding, finding] }, 'review')).toThrow(/duplicate/)
  expect(() => parseReport({ status: 'findings', findings: [{ id: 'F-2' }] }, 'audit')).toThrow(/severity|evidence/)
  expect(() => parseReport({ status: 'failed', findings: [] }, 'audit')).toThrow(/blocking/)
})
```

- [ ] **Step 2: Run `npm test -- --run tests/report.spec.ts`.** Expected: FAIL because `parseReport` is absent.
- [ ] **Step 3: Implement strict report parsing.** Accept only object records with `status: 'clean' | 'findings'`, exact required finding fields, nonempty evidence/remediation, unique IDs, and no `clean`/finding contradiction. Return a typed `Report` with `blocking = findings.some(f => ['critical','high','medium'].includes(f.severity))`; invalid or unavailable output throws a blocking `ReportError` and never becomes `{status:'clean'}`.
- [ ] **Step 4: Write lifecycle tests in `tests/workflow.spec.ts`.** Use a helper that stamps events with `version: 1`, `runId: 'run-1'`, and increasing timestamps. Assert the following concrete sequences:

```ts
const valid = [
  ['start', 'supervisor'], ['spec-request', 'supervisor'], ['spec-result', 'service'],
  ['plan-request', 'supervisor'], ['plan-result', 'service'], ['lead-create', 'supervisor'],
  ['peer-create', 'lead'], ['task-start', 'lead'], ['task-settle', 'peer'],
  ['review-request', 'lead'], ['review-result', 'service'],
  ['audit-request', 'lead'], ['audit-result', 'service'],
  ['final-review-request', 'supervisor'], ['final-review-result', 'service'],
  ['final-audit-request', 'supervisor'], ['final-audit-result', 'service'],
  ['complete', 'supervisor'],
] as const
expect(replay(valid.map(([type, role]) => event(type, role))).phase).toBe('completed')
expect(() => replay([event('start', 'supervisor'), event('peer-create', 'supervisor')])).toThrow(/authority/)
expect(() => replay([event('start', 'supervisor'), event('complete', 'supervisor')])).toThrow(/phase/)
```

Add cases where a medium review finding enters `fix`, a fix must be followed by a new review and a new audit, audit cannot reuse the review correlation, all tasks must settle before final branch gates, and a missing or malformed final audit blocks completion.

- [ ] **Step 5: Run `npm test -- --run tests/workflow.spec.ts`.** Expected: FAIL on missing reducer.
- [ ] **Step 6: Implement a transition table in `workflow.ts`.** `reduce` rejects unknown event versions, duplicate correlations/finding IDs, wrong actor ancestry, skipped phases, results without matching requests, and unresolved blocking findings. It owns the only `completed` transition. Use immutable state and make replay deterministic; no current clock or random ID inside the reducer.

```ts
export function replay(events: readonly OrcEvent[]): OrcState {
  return events.reduce(reduce, initialState())
}
export function canComplete(s: OrcState): boolean {
  return s.tasks.every(t => t.status === 'settled') && s.finalReview === 'clean'
    && s.finalAudit === 'clean' && !s.findings.some(f => f.status === 'open' && isBlocking(f.severity))
}
```

- [ ] **Step 7: Run both focused suites and `npm run typecheck`.** Expected: PASS. Commit with `git add src/domain/report.ts src/domain/workflow.ts tests/report.spec.ts tests/workflow.spec.ts && git commit -m "feat: enforce ORC workflow gates"`.

### Task 5: Call configured DSH providers and bind connection tests to revisions

**Files:** Create `src/host/provider.ts`, `tests/provider.spec.ts`, `tests/fixtures/provider.ts`.

**Interfaces:** Produces `ProviderAdapter.catalog(provider: string): Promise<CatalogSnapshot>`, `test(route: ProviderRoute, revision: string, signal: AbortSignal): Promise<ConnectionResult>`, and `run(route: ProviderRoute, prompt: string, revision: string, test: ConnectionResult, signal: AbortSignal): Promise<string>`. `ConnectionResult` contains exact `routeKey`, `configRevision`, `testedAt`, `ok`, and a safe error code. The DSH implementation uses the configured `ctx.llm` route and reads no credentials; Task 7 defines `CatalogSnapshot` before the adapter's catalog method is wired.

- [ ] **Step 1: Write failing fake-provider tests.**

```ts
import { expect, it } from 'vitest'
import { ProviderAdapter } from '../src/host/provider.js'
import { fakeLlm } from './fixtures/provider.js'

const route = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' } as const
it('tests the exact route with a harmless request', async () => {
  const llm = fakeLlm({ output: 'OK' })
  const result = await new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal)
  expect(result).toMatchObject({ routeKey: 'provider:custom:m1:high', configRevision: 'rev-1', ok: true })
  expect(llm.calls[0]).toMatchObject({ provider: 'custom', model: 'm1', reasoningEffort: 'high' })
  expect(llm.calls[0].messages[0].content).toContainEqual({ type: 'text', text: 'Reply with OK only.' })
})
it('refuses a green result from a previous revision', async () => {
  const adapter = new ProviderAdapter(fakeLlm({ output: 'OK' }))
  const green = await adapter.test(route, 'rev-1', new AbortController().signal)
  await expect(adapter.run(route, 'review', 'rev-2', green, new AbortController().signal)).rejects.toThrow(/stale/)
})
```

- [ ] **Step 2: Run `npm test -- --run tests/provider.spec.ts`.** Expected: FAIL with missing adapter.
- [ ] **Step 3: Implement the DSH LLM bridge.** Call `ctx.llm.stream({ provider, model, reasoningEffort, messages, signal })`; collect accepted final text and treat missing final text or stream error as failure. The test prompt is exactly `Reply with OK only.` and UI copy warns about quota/cost. Check the route against a live DSH adapter catalog before request and again before dispatch. The provider/model/config revision must match; a successful test is advisory and a later network/auth/quota error remains a task failure.
- [ ] **Step 4: Add a table test for unknown model, provider/model mismatch, auth, network, quota, empty output, and a thrown dispatch after a green test.** Use this fixture table and assert no call to another backend:

```ts
it.each([
  ['unknown-model', 'model-unavailable'],
  ['wrong-provider', 'route-mismatch'],
  ['auth', 'authentication'],
  ['network', 'network'],
  ['quota', 'quota'],
  ['empty', 'empty-result'],
] as const)('%s fails closed', async (failure, code) => {
  const llm = fakeLlm({ failure })
  await expect(new ProviderAdapter(llm).test(route, 'rev-1', new AbortController().signal))
    .resolves.toMatchObject({ ok: false, code })
  expect(llm.calls.every(call => call.provider === 'custom')).toBe(true)
})
```

Run focused tests and `npm run typecheck`; expected PASS.
- [ ] **Step 5: Commit.** Run `git add src/host/provider.ts tests/provider.spec.ts tests/fixtures/provider.ts && git commit -m "feat: dispatch configured DSH providers"`.

### Task 6: Probe and invoke only the selected host CLI

**Files:** Create `src/host/cli.ts`, `tests/cli.spec.ts`, `tests/fixtures/fake-codex.mjs`, `tests/fixtures/fake-claude.mjs`.

**Interfaces:** Produces `CliAdapter.probe(route: CliRoute, path: string | undefined, signal): Promise<CliProbe>`, `CliAdapter.catalog(cli: 'codex' | 'claude', configuredRoutes: readonly CliRoute[], signal): Promise<CatalogSnapshot>`, and `CliAdapter.run(route: CliRoute, path: string | undefined, prompt: string, cwd: string, signal): Promise<string>`. `CliProbe` includes resolved executable, parsed version, auth, model/effort capability, and exact account/path/version revision but no tokens. Both methods use an injected DSH `SubprocessRuntime` port (`resolveExecutable`, `spawn`). The CLI catalog contains only configured model/effort pairs that passed a live capability probe; it does not invent an undocumented full-account enumeration endpoint.

- [ ] **Step 1: Write failing version/protocol tests.**

```ts
import { expect, it } from 'vitest'
import { parseCliVersion, codexArgv, claudeArgv } from '../src/host/cli.js'

it.each([
  ['codex 0.156.1', 'codex', true],
  ['codex 0.157.0', 'codex', true],
  ['codex 0.156.0', 'codex', false],
  ['claude 2.1.280', 'claude', true],
  ['claude 2.1.279', 'claude', false],
] as const)('checks %s', (raw, cli, supported) => expect(parseCliVersion(raw, cli).supported).toBe(supported))
it.each(['v0.156.1 garbage', '\u001b[31munknown\u001b[0m', 'codex 1000.bad.1'])('rejects malformed %s', raw => {
  expect(() => parseCliVersion(raw, 'codex')).toThrow(/version/)
})
it('uses argv without a shell and preserves the chosen model and effort', () => {
  expect(codexArgv('/usr/bin/codex', 'gpt-6-sol', 'high', 'Reply OK')).toEqual([
    '/usr/bin/codex', 'exec', '--json', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', 'Reply OK',
  ])
  expect(claudeArgv('/usr/bin/claude', 'claude-sonnet-4-6', 'high', 'Reply OK')).toEqual([
    '/usr/bin/claude', '-p', 'Reply OK', '--output-format', 'json', '--model', 'claude-sonnet-4-6', '--effort', 'high',
  ])
})
```

- [ ] **Step 2: Run `npm test -- --run tests/cli.spec.ts`.** Expected: FAIL with missing `parseCliVersion`.
- [ ] **Step 3: Implement strict version parsing and argv builders.** Strip ANSI only for diagnostics; accept a full product-prefixed semantic version and optional documented prerelease, compare numeric components, and reject arbitrary suffix text. The command builders use the exact argv arrays in Step 1; probes use `codex --version`, `codex login status`, `claude --version`, and `claude auth status`. Before coding these commands, recheck the current [official Codex CLI source](https://github.com/openai/codex) and [Claude CLI](https://code.claude.com/docs/en/cli-reference) references, and capture the exact supported output shape in the fake fixtures. If a documented invocation differs, update this task's command assertions before implementation and record why in `docs/compatibility.md`.
- [ ] **Step 4: Implement the DSH process boundary.** Resolve only the selected executable through `ctx.subprocess.resolveExecutable(path ?? cli)`. Call `spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 1_048_576 }, stderr: { maxBytes: 16_384 } }, graceMs: 5_000, signal })`. Await `done` and `waitForExit`; reject lossy output, nonzero exit, aborted signal, failed compatibility/auth probe, or missing accepted final text. Parse Codex JSONL only from its final `item.completed` agent message after turn completion; parse Claude JSON's `result` only when its completion status is successful. Redact token-shaped data and paths outside the selected executable from diagnostics.
- [ ] **Step 5: Add fake-executable tests.** The two fixtures accept `--version`, auth status, and one harmless run; environment flags select compatible newer, below-floor, malformed version, auth failure, capability mismatch, malformed JSON, quota failure, and a child that waits for cancellation. A catalog test configures two model/effort pairs and admits only the one that passes its live harmless probe. Use this case table and assert no alternate executable starts:

```ts
it.each([
  ['below-floor', 'unsupported-version'], ['bad-version', 'invalid-version'],
  ['auth-fail', 'authentication'], ['bad-protocol', 'unsupported-protocol'],
  ['bad-json', 'invalid-result'], ['quota', 'quota'],
] as const)('blocks %s', async (mode, code) => {
  const subprocess = fakeSubprocess({ selected: 'codex', mode })
  await expect(new CliAdapter(subprocess).probe(codexRoute, undefined, new AbortController().signal))
    .rejects.toMatchObject({ code })
  expect(subprocess.started.every(p => p.argv[0].includes('codex'))).toBe(true)
})
```

The cancellation case aborts a waiting fake child and asserts `waitForExit()` returns true. Run `npm test -- tests/cli.spec.ts` and `npm run typecheck`; expected PASS.

Add revision cases with the same selected model/effort but a changed executable path, parsed CLI version, or auth/account fingerprint; each must invalidate the prior green probe before dispatch. Feed a diagnostic containing `sk-test-secret` and assert the returned safe diagnostic omits that string.
- [ ] **Step 6: Commit.** Run `git add src/host/cli.ts tests/cli.spec.ts tests/fixtures/fake-codex.mjs tests/fixtures/fake-claude.mjs docs/compatibility.md && git commit -m "feat: probe host Codex and Claude CLIs"`.

### Task 7: Select Manual and Auto routes from versioned evidence

**Files:** Create `src/domain/evidence.ts`, `src/domain/routing.ts`, `tests/evidence.spec.ts`, `tests/routing.spec.ts`, `tests/fixtures/routes.ts`, `benchmarks/fixtures.json`, `benchmarks/manifest.json`, `scripts/benchmark.mjs`.

**Interfaces:** Produces `selectRoute(stage: Stage, risk: RiskDecision, config: OrcConfig, catalog: CatalogSnapshot, benchmarks: BenchmarkSnapshot, now: string, prior?: RouteDecision): RouteDecision`. `RouteDecision` contains route, stage, risk, catalog identity, benchmark identity or `null` for low-risk code, reason, and estimated cost; caller logs it before dispatch. `CatalogSnapshot` comes from Task 2 and is populated by the provider/CLI adapters. `BenchmarkSnapshot` records suite revision, model, effort, backend/version, date, scope, detection score, false-positive score, latency, and cost.

- [ ] **Step 1: Write failing route tests.**

```ts
import { expect, it } from 'vitest'
import { selectRoute } from '../src/domain/routing.js'
import { config, catalog, benchmarks } from './fixtures/routes.js'

it('uses only allowed exact routes in Manual mode', () => {
  const selected = selectRoute('plan', { path: 'orc', risk: 'low', reasons: [] }, config('manual'), catalog, benchmarks, '2026-09-23T00:00:00Z')
  expect(selected.route).toEqual(config('manual').manual.plan)
  expect(selected.catalogId).toBe(catalog.id)
})
it('requires independent evidence-qualified review and audit for money changes', () => {
  const risk = { path: 'orc', risk: 'high', reasons: ['high-impact'] } as const
  const review = selectRoute('review', risk, config('auto'), catalog, benchmarks, '2026-09-23T00:00:00Z')
  const audit = selectRoute('audit', risk, config('auto'), catalog, benchmarks, '2026-09-23T00:00:00Z', review)
  expect(audit.route.kind === review.route.kind && routeBackend(audit.route) === routeBackend(review.route)).toBe(false)
  expect(review.benchmarkId).toBeTruthy()
  expect(audit.benchmarkId).toBeTruthy()
})
```

- [ ] **Step 2: Run `npm test -- --run tests/routing.spec.ts tests/evidence.spec.ts`.** Expected: FAIL because route/evidence modules are absent.
- [ ] **Step 3: Implement evidence admission and deterministic ranking.** Normalize only live catalog entries that the user allowed and that support the exact model/effort. For high-risk review/audit, require benchmark entries with matching backend, model, effort, backend version, scope including financial/security, current suite revision, and age at most `config.catalogMaxAgeDays`. Reject unknown or stale official-claim data as a routing input; claim text never becomes a quality score. Rank by validated detection/false-positive quality first, then lower cost and latency, then lexical `routeKey` for deterministic ties. Low-risk stages may choose the least costly route meeting their configured quality floor. A cost ceiling may exclude routes but may not lower the floor or silently substitute an unallowed route.

```ts
const eligible = config.allowed.filter(route =>
  catalogHasExactModelEffort(catalog, route) &&
  (risk.risk !== 'high' || (stage !== 'review' && stage !== 'audit') ||
    benchmarkMatches(benchmarks, route, catalog, now, ['financial', 'security']))
)
if (eligible.length === 0) throw new RouteError('no-qualifying-route', stage)
```

- [ ] **Step 4: Add failure tests.** Mutate one verified fixture field per case so the cause is unambiguous:

```ts
it.each([
  ['unlisted', { allowed: [] }],
  ['missing-model', { catalogModels: [] }],
  ['wrong-effort', { catalogEfforts: ['low'] }],
  ['stale-benchmark', { benchmarkDate: '2025-01-01' }],
  ['wrong-backend-version', { benchmarkVersion: '0.155.1' }],
  ['cost-cap', { maxCostUsd: 0 }],
] as const)('%s has no qualifying route', (_name, change) => {
  expect(() => selectFixtureRoute('audit', 'high', change)).toThrow(/no-qualifying-route/)
})
expect(() => selectFixtureRoute('audit', 'high', { benchmarkEffort: 'low' })).toThrow(/no-qualifying-route/)
expect(() => selectFixtureRoute('audit', 'high', { priorBackend: 'codex', onlyBackend: 'codex' })).toThrow(/independent/)
```

Add deterministic tie-order and `code` tests: when the configured DeepSeek Flash v4.1 high route exists it wins; when absent, the UI asks for a route rather than inventing one.
- [ ] **Step 5: Create reproducible benchmark fixtures and runner.** `benchmarks/fixtures.json` contains at least two seeded financial bugs (incorrect rounding and double settlement), two security bugs (authorization bypass and secret leak), and two clean cases that must not produce findings. Use these exact fixture IDs and expected findings:

```json
[
  { "id": "fin-round-up", "scope": "financial", "code": "return Math.ceil(amount * 100) / 100", "expected": ["rounding-overpays"] },
  { "id": "fin-double-settle", "scope": "financial", "code": "await credit(user, amount); await credit(user, amount)", "expected": ["duplicate-credit"] },
  { "id": "sec-auth-bypass", "scope": "security", "code": "if (user || user.isAdmin) approve()", "expected": ["authorization-bypass"] },
  { "id": "sec-secret-log", "scope": "security", "code": "logger.info({ apiKey })", "expected": ["secret-in-log"] },
  { "id": "clean-round", "scope": "financial", "code": "return Math.round(amount * 100) / 100", "expected": [] },
  { "id": "clean-auth", "scope": "security", "code": "if (user?.isAdmin === true) approve()", "expected": [] }
]
```

`benchmarks/manifest.json` records fixture SHA-256, expected finding IDs, scope, and suite revision `orc-review-v1`. `scripts/benchmark.mjs` reads the manifest, invokes only an explicitly selected configured route, scores expected findings and false positives, and writes an evidence record with backend/model/effort/version/date/latency/cost. It refuses to run without explicit route selection; external model calls are an evidence-generation job, not part of `npm test`.
- [ ] **Step 6: Run the focused tests, `npm run typecheck`, and a fixture-only manifest verification command `node scripts/benchmark.mjs --verify-fixtures`.** Expected: PASS without a model key. Commit with `git add src/domain/evidence.ts src/domain/routing.ts tests/evidence.spec.ts tests/routing.spec.ts tests/fixtures/routes.ts benchmarks scripts/benchmark.mjs && git commit -m "feat: route from verified catalog evidence"`.

### Task 8: Bind the domain to DSH sessions, tools, and delegated runs

**Files:** Create `src/host/journal.ts`, `src/host/service.ts`, `src/host/tool.ts`, `src/host/remote-host.ts`; modify `src/host/index.ts`, `cordis.patch.yml`, `package.json`, `scripts/build.mjs`; create `tests/service.spec.ts`, `tests/tool.spec.ts`, `tests/integration/session.spec.ts`, `tests/integration/remote.spec.ts`, `tests/fixtures/ports.ts`, `tests/fixtures/session.json`.

**Interfaces:** Produces `OrcService.start(supervisor: Agent, risk: RiskDecision): Promise<OrcState>`, `createLead(supervisor: Agent): Promise<Agent>`, `createPeer(lead: Agent, name: string): Promise<Agent>`, `startTask(lead: Agent, peer: Agent, taskId: string): Promise<OrcState>`, `settleTask(peer: Agent, taskId: string): Promise<OrcState>`, `dispatch(supervisor: Agent, stage: Stage, prompt: string, signal: AbortSignal): Promise<OrcState>`, `recordReport(supervisor: Agent, stage: 'review' | 'audit', correlationId: string, raw: unknown): Promise<OrcState>`, `fix(lead: Agent, findingId: string): Promise<OrcState>`, `finalBranchReview(supervisor: Agent, raw: unknown): Promise<OrcState>`, `finalBranchAudit(supervisor: Agent, raw: unknown): Promise<OrcState>`, `complete(supervisor: Agent): Promise<OrcState>`, `state(supervisor: Agent): OrcState`, and `getCatalog(signal: AbortSignal): Promise<CatalogSnapshot>`. The service is the sole caller of `reduce` and the sole writer of `orc/*` session events. `installOrcTool(agent, service): () => void` registers the ORC tool and policy in the exact Agent scope. `OrcRemoteHost` exposes `getCatalog`, `probe`, and `getConnectionResult` as `@Remote` methods under `ctx.remote.orc`; all results are JSON-safe and credential-free. The public tool accepts action/IDs only; it never accepts arbitrary provider credentials or an unapproved route.

- [ ] **Step 1: Write failing service tests with a fake journal and fake dispatchers.** A Supervisor starts a run, can create one Lead, and that Lead can create Peers; a Peer cannot create a child or advance phase. Assert request event is committed before a delegated run starts and result event is committed before the next phase becomes visible. Verify replay from events recovers a blocked request without duplicating an already-correlated child.

```ts
const ports = fakePorts()
const svc = new OrcService(ports)
await svc.start(supervisor, { path: 'orc', risk: 'high', reasons: ['high-impact'] })
await expect(svc.createPeer(supervisor, 'peer-1')).rejects.toThrow(/authority/)
const lead = await svc.createLead(supervisor)
await expect(svc.createPeer(lead, 'peer-1')).resolves.toMatchObject({ role: 'peer' })
expect(ports.journal.events[0].type).toBe('orc/start')
```

- [ ] **Step 2: Run `npm test -- --run tests/service.spec.ts`.** Expected: FAIL because `OrcService` is absent.
- [ ] **Step 3: Implement serialized journal and service.** The journal registers one `orc` projection through DSH's public session-projection seam, appends versioned `orc/*` events to the Supervisor's exact session, and awaits `ctx.sessions.flush` before publication. Serialize mutations per root session; use committed correlations for retry/recovery. Use `ctx.subagents.startContinuable({ provider: 'spawn', label, request: { parent, prompt, agentOptions: { provider, model, reasoningEffort } }, signal })` only for eligible DSH child routes and verify provider capability before start. Use the Task 5 adapter for configured provider routes and Task 6 for selected host CLI routes at any stage, including code; never route CLI work through DSH's pinned Codex/Claude subagent bundles. Any child startup or result failure appends a blocking event.
- [ ] **Step 3a: Prove the external Remote build contract before wiring the page.** Add `OrcRemoteHost extends TypertRemoteService` with `super(ctx, 'orcRemoteHost', { namespace: 'orc' })` and one `@Remote('getCatalog')` method that delegates to the service:

```ts
export class OrcRemoteHost extends TypertRemoteService {
  static inject = ['orc']
  constructor(ctx: Context) { super(ctx, 'orcRemoteHost', { namespace: 'orc' }) }
  @Remote('getCatalog')
  async getCatalog(signal: AbortSignal): Promise<CatalogSnapshot> {
    return await this.ctx.orc.getCatalog(signal)
  }
}
```

Add separate `orc-remote-host` Loader row and `./remote-host`, `./typert`, `./remote` package exports; use the published Typert generator to produce the two wire artifacts and test that a clean Web profile can call `ctx.remote.orc.getCatalog()`. If no documented published generator can build these artifacts for an external package, stop here and obtain a DSH public extension; do not import DSH build scripts or private app-boot paths. This proof is a compatibility gate, not permission to weaken the settings page.
- [ ] **Step 4: Add tool, pre-step, and model-visible snapshot tests.** Register one `orc` tool through `defineTool` on `agent.ctx.tools` and a `systemPrompt.section` on that same Agent when `agent/created` fires; dispose both on `agent/disposed`. Add a scoped `agent/pre-step` gate that inspects the admitted user request: a high-impact request starts ORC before model execution; an ambiguous request presents the classification tool and policy, and a direct task that later discovers scope must call ORC before continuing implementation. The hook returns DSH's `next()` decision after the durable ORC start and rejects the step if that start fails. Test the high-impact gate with `Fix payment authorization before release` and assert the first journal event is `orc/start` before any model step. Assert a Peer tool call attempting `create-lead`, `create-peer`, or `complete` is refused by the service. Assert the current chat `provider` and `model` are byte-for-byte unchanged after installation and after an ORC call. Snapshot exact tool schema, policy, route decision, and failure result from a keyless recorded session in `tests/fixtures/session.json`.

```ts
const before = { provider: agent.options.provider, model: agent.options.model }
const dispose = installOrcTool(agent, svc)
expect({ provider: agent.options.provider, model: agent.options.model }).toEqual(before)
expect(agent.ctx.tools.list().map(t => t.name)).toContain('orc')
dispose()
expect(agent.ctx.tools.list().map(t => t.name)).not.toContain('orc')
```

- [ ] **Step 5: Add a complete fake workflow integration test.** Feed spec → plan → Lead/Peer implementation → separate review and audit → medium finding → fix → new review and audit → final branch review and audit → complete:

```ts
const ports = fakePorts()
const svc = new OrcService(ports)
const supervisor = ports.supervisor
const signal = new AbortController().signal
const mediumReport = { status: 'findings', findings: [{ id: 'F-1', severity: 'medium', file: 'src/pay.ts', line: 12, evidence: 'double credit', remediation: 'settle once' }] }
const cleanReport = { status: 'clean', findings: [] }
await svc.start(supervisor, { path: 'orc', risk: 'high', reasons: ['high-impact'] })
await svc.dispatch(supervisor, 'spec', 'spec input', signal)
await svc.dispatch(supervisor, 'plan', 'plan input', signal)
const lead = await svc.createLead(supervisor)
const peer = await svc.createPeer(lead, 'peer-1')
await svc.startTask(lead, peer, 'task-1')
await svc.settleTask(peer, 'task-1')
ports.reports.push(mediumReport)
await svc.dispatch(supervisor, 'review', 'review task-1', signal)
await expect(svc.complete(supervisor)).rejects.toThrow(/blocking/)
await svc.fix(lead, 'F-1')
ports.reports.push(cleanReport, cleanReport)
await svc.dispatch(supervisor, 'review', 'review task-1 again', signal)
await svc.dispatch(supervisor, 'audit', 'audit task-1', signal)
await svc.finalBranchReview(supervisor, cleanReport)
await svc.finalBranchAudit(supervisor, cleanReport)
await expect(svc.complete(supervisor)).resolves.toMatchObject({ phase: 'completed' })
```

Assert every route decision logs provider/CLI, model, effort, stage, risk, catalog/benchmark identities, and reason without credentials. Assert a malformed, failed, or unavailable review/audit blocks. Assert no task advances before both gates are clean.
- [ ] **Step 6: Run `npm test -- tests/service.spec.ts tests/tool.spec.ts tests/integration/session.spec.ts tests/integration/remote.spec.ts` and `npm run typecheck`.** Expected: PASS. Commit with `git add src/host cordis.patch.yml package.json scripts/build.mjs tests/service.spec.ts tests/tool.spec.ts tests/integration/session.spec.ts tests/integration/remote.spec.ts tests/fixtures/ports.ts tests/fixtures/session.json && git commit -m "feat: integrate ORC workflow with DSH sessions"`.

### Task 9: Add the isolated localized ORC settings page

**Files:** Create `src/client/OrcSettingsPage.tsx`, `src/client/locales.ts`, `tests/client.spec.tsx`, `tests/fixtures/client.ts`; modify `src/client/index.tsx`, `src/host/index.ts`, `package.json` for the ORC remote probe face and Client injection.

**Interfaces:** The Host remote face exposes `getCatalog()`, `probe(route)`, and `getConnectionResult(routeKey)` without credentials. The browser plugin injects `remote`, `remote.orc`, `slots`, `locale`, and `settingsScope`; its type-only import of the generated `./remote` contribution supplies the `ctx.remote.orc` type. The page binds `ctx.settingsScope.bind({ namespace: 'orc' })`; saves use the scope's revision-fenced `set`/`unset`. The page registers `settings.section` with `id: 'orc'`, a localized label, and a disposer owned by the Client plugin.

- [ ] **Step 1: Write failing browser tests.** Render the page with a fake settings scope and remote face. Assert fields for session behavior, code route, Manual/Auto, spec/plan/review/audit routes, allowed backends, CLI path, health/auth status, max cost, and catalog age. Assert a probe button displays `This test may use provider quota or incur cost` before sending a harmless request; a route edit clears the green result. Assert English and Chinese nav labels and no Models Settings mutation.

```tsx
const ui = render(<OrcSettingsPage scope={scope('orc')} remote={fakeRemote()} locale="en" />)
expect(ui.getByLabelText('Analysis routing')).toBeVisible()
expect(ui.getByText(/may use provider quota or incur cost/i)).toBeVisible()
await userEvent.selectOptions(ui.getByLabelText('Review route'), 'codex:gpt-6-sol:high')
expect(ui.queryByText('Connected')).toBeNull()
expect(scopeWrites()).toEqual([expect.objectContaining({ namespace: 'orc' })])
```

- [ ] **Step 2: Run `npm test -- --run tests/client.spec.tsx`.** Expected: FAIL because the page is absent.
- [ ] **Step 3: Implement the page and registration.** Add `@deepseek-ai/dsh-api-remotes` to `dsh.client.inject`. Bind `const scope = ctx.settingsScope.bind({ namespace: 'orc' })`, then use `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'orc', order: 30, label: () => t('title'), locale: 'settings.orc', inject: () => ({ scope, remote: ctx.remote.orc, locale: ctx.locale.getSnapshot().active }) }, OrcSettingsPage))`. Register dictionaries through `ctx.locale.register('settings.orc', { en, zh })` inside a Cordis effect. The page uses the ORC namespace only, shows exact route/version/revision status, displays actionable probe errors, and disables save on invalid settings. It never requests or renders provider tokens or native CLI credentials.
- [ ] **Step 4: Add mount/unmount tests.** Simulate enabling and disabling the Client module with a slot recorder:

```ts
const slots = fakeSlots()
const ctx = fakeClientContext({ slots })
applyClient(ctx)
expect(slots.ids('settings.section')).toEqual(['orc'])
ctx.dispose()
expect(slots.ids('settings.section')).toEqual([])
expect(slots.ids('models.section')).toEqual([])
```

Test that an unavailable CLI displays a path field and a below-floor version displays `Codex CLI 0.156.1 required` or `Claude Code 2.1.280 required`. Run focused browser tests and `npm run typecheck`; expected PASS.
- [ ] **Step 5: Commit.** Run `git add src/client src/host/index.ts package.json tests/client.spec.tsx tests/fixtures/client.ts && git commit -m "feat: add ORC settings section"`.

### Task 10: Verify the packed plugin across clean Web profiles and release gates

**Files:** Create `tests/integration/bundle.spec.ts`, `tests/integration/compatibility.spec.ts`, `tests/integration/disabled.spec.ts`, `scripts/clean-profile-smoke.mjs`, `.github/workflows/ci.yml`, `README.md`; modify `docs/compatibility.md`, `package.json` only if the first matrix run establishes a narrower tested set.

**Interfaces:** `scripts/clean-profile-smoke.mjs` takes one exact DSH version argument, packs the package into its own temporary directory, creates a disposable DSH_HOME and Web profile, installs that tarball through Plugin Manager/dsh plugin, exercises enable/disable/remove, drives the fake full workflow, compares default/preset/provider configuration before/after, and cleans only its owned temporary directory. CI uses exact version matrix `0.1.6-alpha.2`, `0.1.7-alpha.2`.

- [ ] **Step 1: Write failing package and profile tests.** Parse `npm pack --json` and assert one bundle package, patch, Host JS, lazy-CJS Client JS, and locale strings. Use the same profile snapshot before and after each plugin action:

```ts
const before = await snapshotProfile(profile)
await manager.installBundle(tarball)
expect(await contributions(profile)).toEqual({ service: true, tool: true, policy: true, page: true })
await manager.setBundleEnabled('@tonamson/dsh-orc', false)
expect(await contributions(profile)).toEqual({ service: false, tool: false, policy: false, page: false })
await manager.removeBundle('@tonamson/dsh-orc')
expect(await snapshotDefaults(profile)).toEqual(before.defaults)
```

Assert standard preset, global model defaults, provider credentials, and unrelated settings are identical. A disabled bundle with an active delegated run cancels and settles that run before disposal; no orphan child remains.
- [ ] **Step 2: Run `npm test -- --run tests/integration/bundle.spec.ts tests/integration/disabled.spec.ts`.** Expected: FAIL until the package and runtime satisfy the assertions.
- [ ] **Step 3: Implement the smoke harness.** Use `mkdtemp(join(tmpdir(), 'orc-profile-'))` for owned package and profile paths, run `npm pack --pack-destination` in that directory, then install the tarball through documented `dsh plugin --profile web add file:` plus its absolute path. Use the Plugin Manager's enable/disable/remove operations. Use fake provider/CLI inputs and keyless recorded sessions; no personal account, real credentials, or live model call is needed. Inspect the installed package archive itself rather than the source tree. Wait for activation/deactivation results; a reported restart requirement triggers a controlled profile restart before checking runtime contributions. Remove only the owned temporary directory in `finally` after process cleanup.
- [ ] **Step 4: Add a two-version CI matrix.** The workflow runs `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `npm run pack:check`, then `node scripts/clean-profile-smoke.mjs "$DSH_VERSION"` for `0.1.6-alpha.2` and `0.1.7-alpha.2`. Record the exact passing DSH package versions and extension contracts in `docs/compatibility.md`. If either candidate fails because a required external API is absent, stop release, correct the plan/spec support claim, and test an exact narrower support set; never silently claim a range the matrix did not pass.
- [ ] **Step 5: Complete documentation and release checks.** `README.md` documents one-package installation, enabling/disabling, session Supervisor preservation, direct/ORC policy, Manual/Auto settings, provider quota warning, selected CLI prerequisites and minimums, actionable failure states, and no hidden fallback. Verify `npm pack --dry-run --json` contains no `workspace:` dependency and no missing runtime/client/locale file. Verify the benchmark fixture manifest and the high-risk quality evidence required by the selected routes. Verify the npm scope is controlled by the publisher; only then remove `private: true` for the release candidate. Publishing itself requires an explicit release instruction.
- [ ] **Step 6: Run the full gate and inspect evidence.** Run `npm test`, `npm run typecheck`, `npm run build`, `npm run pack:check`, `node scripts/clean-profile-smoke.mjs 0.1.6-alpha.2`, `node scripts/clean-profile-smoke.mjs 0.1.7-alpha.2`, `git diff --check`, and `git status --short`. Expected: all pass and only intended files change. Commit with `git add .github README.md docs/compatibility.md scripts/clean-profile-smoke.mjs tests/integration package.json && git commit -m "test: gate ORC releases against DSH profiles"`.

## Implementation notes and source contracts

- [DSH plugin packaging and profile installation](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) and [settings cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md) establish the `dsh.bundle.patch`, Host, and Client packaging pattern. The spec intentionally chooses a full `settings.section` page rather than a Plugins settings card.
- DSH's published `@deepseek-ai/dsh-subprocess` contract requires explicit `argv`, `cwd`, `stdio`, and `graceMs`, and exposes `done` plus `waitForExit`. Use that boundary for both CLIs.
- DSH's public `@deepseek-ai/dsh-tools` `defineTool`, `ctx.systemPrompt.section`, `ctx.settings.installSection`, `ctx.llm.stream`, and `ctx.subagents.startContinuable` are the intended integration seams. Confirm the packed versions expose these names in Task 1's compatibility gate; the neighboring DSH checkout is reference material, not a dependency.
- [Codex CLI's official repository](https://github.com/openai/codex) and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) are the command/protocol authorities for Task 6. Probe the installed executable, not a pinned DSH CLI bundle. Official capability/pricing claims are recorded with source and retrieval time but do not substitute for ORC benchmark scores.

## Self-review results

- [x] Each spec section maps to a task: distribution/compatibility (1, 10), settings (2, 9), activation/risk (3, 8), strict hierarchy and gates (4, 8), provider/CLI (5, 6), evidence routing (7), failure behavior (4–10), release evidence (7, 10).
- [x] Placeholder scan found no open design step. Every task names files, interfaces, a failing test, a failure command, a concrete implementation action, a passing command, and a commit.
- [x] Route, stage, revision, finding ID, and event names are used consistently across tasks; Task 2 types are the single source of truth.
- [x] The five Review Focus cases each appear in their owning task's test step.
- [x] The spec remains a user-review document and no implementation task starts until the user approves it.
