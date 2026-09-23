# DSH compatibility contract

Status: Task 1 compatibility gate, revised by controller ruling **R15**; host CLI
adapter section added by Task 6. This document records what the **packed** DSH
`0.1.6-alpha.2` packages actually expose, so later tasks can rely on verified
signatures instead of the plan's assumptions. It is a verification record, not a
redesign: later tasks keep their assigned scope, and any mismatch is listed
under [Concerns](#concerns-handed-to-later-tasks).

## Verified environment

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| npm | 12.0.2 |
| Published support set | `@deepseek-ai/dsh*` exactly `0.1.6-alpha.2` (no range, no caret) |
| DSH resolved by `npm install` | `@deepseek-ai/dsh` `0.1.6-alpha.2` |
| Declaration source | `node_modules/@deepseek-ai/*/lib/types/**.d.ts` |
| Archive contract test | `tests/integration/bundle.spec.ts` |
| Compatibility pinning test | `tests/integration/compatibility.spec.ts` |
| Clean-profile smoke | `scripts/clean-profile-smoke.mjs <exact version>` |

`npm install` resolves the manifest's `peerDependencies`/`devDependencies` to
the `0.1.6-alpha.2` line and installs the full DSH tree, so every
`node_modules/@deepseek-ai/...` path below is the published package, not a
monorepo source path. Verified directly:

```
$ node -e "console.log(require('./node_modules/@deepseek-ai/dsh/package.json').version)"
0.1.6-alpha.2
```

`@deepseek-ai/cordis` stays pinned at `4.0.4` and `@deepseek-ai/schemastery` at
`3.18.4`; both satisfy the `0.1.6-alpha.2` peers
(`@deepseek-ai/dsh-settings@0.1.6-alpha.2` declares
`@deepseek-ai/cordis: ^4.0.2` and `@deepseek-ai/schemastery: ^3.18.2`).

## Extension-point gate

One row per name the plan's later tasks depend on. "Found" means the exact name
is present in the installed `0.1.6-alpha.2` declarations. Every row was
re-verified against the installed `0.1.6-alpha.2` tree after the support set was
narrowed by **R15**; the "Δ vs 0.1.7" column records what the previous gate run
against `0.1.7-alpha.2` had recorded differently (line shifts included).

| Name | Status | Exact signature | File | Δ vs 0.1.7 |
|---|---|---|---|---|
| `ctx.settings.installSection` | **Found** | `installSection<const Namespace extends string, T>(owner: Context, ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void`. `ctx.settings` is `SettingsProvider` (`abstract class SettingsProvider extends Service`). `SettingsSectionHooks<T>` is `{ setSource(current: () => T): void; onChange(): void; validate?: (value: T) => void }`. | `node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts:228` (method), `:113` (`interface Context { settings: SettingsProvider }`), `:157` (class), `:315` (hooks) | **Signature difference.** Absent in `0.1.7-alpha.2`, where `ctx.settings` is `SettingsForms` (`configure`/`describe`/`update`/`replace`/`mutate`). |
| `ctx.llm.stream` | Found | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`; `ctx.llm: LlmRuntime`. `GenerateOptions` requires `provider: string`, `model: string`, `messages: Message[]` and accepts `reasoningEffort?: ReasoningEffortId`, `system?: string`, `tools?`, `temperature?`, `maxTokens?`, `stop?`, `signal?: AbortSignal`, `sessionId?: Branded<'SessionId'>`, `purpose?: 'compaction' \| 'session-title'`. | `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:408` (method), `:29` (`interface Context { llm: LlmRuntime }`), `lib/types/types.d.ts:439` (`GenerateOptions`), `:451` (`messages`) | **Signature difference.** `0.1.7-alpha.2` widened `messages` to `RequestMessage[]` where `RequestMessage = Message \| RequestUserInput`; `0.1.6-alpha.2` has **no `RequestMessage` type at all** (0 files reference it), only `Message[]`. |
| `ctx.subagents.startContinuable` | Found | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`; `ctx.subagents: SubagentRuntime`. `ContinuableStartSpec` is `{ provider: string; label: string; childId?: SessionId; request: Omit<SubagentStartRequest, 'label' \| 'signal' \| 'outputSchema'>; signal: AbortSignal }`; `ContinuableStart` is `{ childId: SessionId; messageId: MessageId }`. Note `SubagentStartRequest.prompt` is `ContentBlock[]`, **not** a string, and `parent: Agent` and `signal: AbortSignal` are required. `agentOptions?: AgentOptions` carries `provider?`, `model?`, `reasoningEffort?`, `maxTokens?`. | `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts:133` (method), `:60` (`interface Context { subagents: SubagentRuntime }`); `lib/types/types.d.ts:26` (`ContinuableStartSpec`), `:41` (`request`), `:136` (`SubagentStartRequest`), `:140` (`prompt`), `:146` (`parent`), `:154` (`signal`); `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:21` (`AgentOptions`) | Line shifts only: method `:142`→`:133`, Context `:63`→`:60`. The declared shapes are identical (only unrelated `readonly` on `lastAssistantMessage`/`output` differs). |
| `ctx.subprocess` | Found | `ctx.subprocess: SubprocessRuntime` with `resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>`, `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, `terminalEnvironment(signal?)`, `spawnTerminal(spec)`. `SubprocessSpawnSpec` is `{ argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }` with `SubprocessStdio = { stdin: 'ignore' \| 'pipe' \| { data: string }; stdout: 'pipe' \| 'inherit' \| SubprocessCollect; stderr: …; control?: 'pipe' }`. The handle exposes `control: Duplex \| undefined`, `collected`, `done: Promise<SubprocessOutcome>`, `waitForExit(signal?: AbortSignal): Promise<boolean>`, `terminate(): void`, `stdin`/`stdout`/`stderr`. | `node_modules/@deepseek-ai/dsh-subprocess/lib/types/index.d.ts:43` (`interface Context { subprocess: SubprocessRuntime }`), `:88` (`resolveExecutable`), `:102` (`spawn`), `:94` (`terminalEnvironment`), `:110` (`spawnTerminal`); `lib/types/types.d.ts:69` (`SubprocessSpawnSpec`), `:90` (`signal`), `:98` (`env`), `:56` (`SubprocessStdio`), `:61` (`control`), `:107` (`SubprocessOutcome`), `:156` (`SubprocessHandle`), `:164` (`control`), `:166` (`collected`), `:168` (`done`), `:174` (`terminate`), `:182` (`waitForExit`) | **No change.** Every `lib/types/**.d.ts` file in this package is byte-identical between `0.1.6-alpha.2` and `0.1.7-alpha.2`, so all paths and line numbers carry over. |
| `defineTool` | Found | `defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition`, re-exported from the package root. The registering surface is `ctx.tools: ToolRuntime`. | `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts:239`; re-export `lib/types/index.d.ts:16`; `ctx.tools` at `lib/types/index.d.ts:26` | Line shifts only: `schema.d.ts:248`→`:239`, re-export `:24`→`:16`, `ctx.tools` `:34`→`:26`. Signature identical. |
| `ctx.systemPrompt.section` | Found | `section(section: PromptSection): () => void` returning the Cordis effect disposer; `ctx.systemPrompt: SystemPrompt`. `PromptSection` is `{ name: string; order: number; text: string \| ((context: AssembleContext) => string); interpolate?: boolean; complete?: boolean }`. | `node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:240` (method), `:11` (`interface Context`), `:12` (`systemPrompt: SystemPrompt`), `:47` (`PromptSection`) | Line shift only: method `:239`→`:240`. `PromptSection` is identical. |
| `settings.section` client slot | Found | Slot map entry `'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }` with `SettingsSectionOwnerProps = { close: () => void }`. Registrant options carry `id` (section key), `order` (nav position), and `label` (registrant-localized text). | `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:67`, owner props at `:148` | Line shifts only: entry `:73`→`:67`, owner props `:154`→`:148`; `0.1.7-alpha.2` additionally declared a `settings.launcher` single slot that `0.1.6-alpha.2` does not have. The `settings.section` entry itself is identical. |
| `ctx.settingsScope` | **Found** | `ctx.settingsScope: SettingsScopeBinder`; `class SettingsScopeBinder extends Service` with `bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>` (and `describe()`). `SettingsScopeSpec<T> = { namespace: string; decode?: (section: unknown) => T \| undefined }`. `SettingsScope<T>` exposes `getSnapshot(): SettingsScopeSnapshot<T>`, `subscribe(listener: () => void): () => void`, `mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<void>`, `set(field: string, value: unknown): Promise<void>`, `unset(field: string): Promise<void>`. | `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/settings-scope.d.ts:90` (`interface Context { settingsScope: SettingsScopeBinder }`), `:100` (class), `:139` (`bind`); `lib/types/client/settings-contract.d.ts:34` (`SettingsScopeSpec`), `:36` (`namespace`), `:50` (`SettingsScope`) | **Signature difference.** Absent in `0.1.7-alpha.2`, whose browser settings transport is `ctx.configForms: ConfigForms` (`config-form.d.ts`, a file this version does not ship). |
| `TypertRemoteService` | Found | `abstract class TypertRemoteService<out T = never> extends Service<T>` with `readonly typertRemote: TypertGatewayBinding<this>` and `protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)`. | `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts:62` | Line shift only: `:66`→`:62`. Class declaration identical. |
| `@Remote` | Found | Two overloads: `Remote<This extends object, Args extends unknown[], Result>(_method: (this: This, ...args: Args) => Result, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>): void` and `Remote(option: string \| RemoteMethodOptions): RemoteMethodDecorator`. Standard TC39 method decorators — no `experimentalDecorators`. `RemoteScope(key, exportName?)` is also published. | `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts:78` (bare), `:84` (`@Remote('name')`), `:91` (`RemoteScope`) | Line shifts only: `:82`→`:78`, `:88`→`:84`, `:95`→`:91`. Signatures identical; `0.1.7-alpha.2` only adds a `json-value.ts` re-export and doc-comment text. |
| Published Typert generator | Found (published, not installed by this manifest) | `@deepseek-ai/dsh-typert-generator@0.1.6-alpha.2`; npm `alpha` dist-tag is `0.1.7-alpha.2`, but `0.1.6-alpha.2` is published and is the version matching the supported DSH line. **No `bin`** — it is a library: `.` exports `WorkspaceTypertGenerator` (`constructor(root: string, options?: WorkspaceTypertGeneratorOptions)`, `discover(faces?)`, `generate(packages?, faces?)`), `WorkspaceAnalyzer`, `WorkspaceCaches`, `TypertAnalysisError`, `FaceModelEmitter`, `TypertEmitError`, `TypeGraphRenderer`, `TypeGraphRenderError`; `./tsdown` exports `typertPlugin`. Declares `dependencies.typescript: ^6.0.3` and peer `@deepseek-ai/cordis: ^4.0.2`. No README is published for this version. | Registry metadata + tarball `@deepseek-ai/dsh-typert-generator@0.1.6-alpha.2` (`lib/types/index.d.ts`, `lib/types/workspace.d.ts`, `lib/types/analyzer.d.ts`, `lib/types/tsdown-plugin.d.ts`) | Same API surface and same `typescript: ^6.0.3` requirement as the `0.1.7-alpha.2` row; only the version differs. |

### Service keys confirmed alongside the gate

`ctx.llm`, `ctx.subagents`, `ctx.subprocess`, `ctx.tools`, `ctx.systemPrompt`,
and `ctx.settings` are all declared by their owning packages through
`declare module '@deepseek-ai/cordis' { interface Context { … } }`, so a
consumer package gets them by depending on the owning package and importing it
for the augmentation. `ctx.settingsScope` is declared the same way by
`@deepseek-ai/dsh-client-ui-settings` (`settings-scope.d.ts:88-92`), on the
browser half.

## DSH client artifact format

The browser half of this bundle must be a **lazy-CJS factory registration**, not
a standalone script. The exact format, produced by `scripts/build.mjs` and
committed as the `./client` export (`lib/client.js`):

```js
window.__ModuleLoader__.load({
  id: '@tonamson/dsh-orc',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    /* esbuild CJS bundle of src/client/index.tsx */
    return module.exports
  }
})
```

Reference implementation in the packed runtime,
`node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` (0.1.6-alpha.2):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-modules",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		…
		return module.exports;
	}
});
```

Contract facts that follow from `@deepseek-ai/dsh-client-modules@0.1.6-alpha.2`
and the `DshClientManifest` type
(`node_modules/@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts`, where
`platform` `:60`, `inject?` `:62`, `immediately?` `:64`, and `external?` `:70`
are byte-identical in `0.1.6-alpha.2` and `0.1.7-alpha.2`). One adjacent
difference: `DshBundleManifest.patch` is `string` in `0.1.6-alpha.2` (`:50`) but
`string | string[]` in `0.1.7-alpha.2`; this manifest uses the single-string
form, valid in both:

- Running a bundle only **registers** the factory; module side effects run at
  materialization (first import/require), so ordering needs no external
  sequencing.
- The `id` is the package name. `<id>/client` and the bare id resolve to the
  same exports, so an importing bundle may request either.
- The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and
  static UI libraries). `dsh.client.external` adds non-baseline module requests;
  type-only imports are erased and create no request. Our build marks `react`,
  `react/jsx-runtime`, and `@deepseek-ai/*` external, so any **value** import of
  a non-baseline DSH client package must be listed in `dsh.client.external`.
- `dsh.client.inject` (the field this manifest uses) is documented as
  *"informational package-name dependencies, not Cordis service injection"*
  (`dsh-package-manifest/lib/types/types.d.ts:61-62`). It is valid manifest
  data, but it is not what makes a `require(...)` inside the factory resolvable —
  `dsh.client.external` is.
- `dsh.client.immediately` selects a boot phase-one registration barrier;
  absent means the shared application batch, which is what this bundle wants.
- The host serves each built `lib/client.js` under `/plugins`, so the artifact
  must exist before launch; a missing bundle fails activation loudly.
- `tests/bundle.spec.ts` pins the manifest half of this contract. Task 10 tests
  the artifact through the real client module loader.

## Support-range finding

The **published** support set is exactly `0.1.6-alpha.2`. Controller ruling
**R15** narrowed it to that single version: the declared range
`0.1.6-alpha.2 || 0.1.7-alpha.2` claimed both, but the settings extension points
this bundle's design depends on exist only in `0.1.6-alpha.2`, so the range was
a false compatibility claim. There is no version-conditional adapter and no
redesigned settings approach — the code targets `0.1.6-alpha.2` only.

`0.1.7-alpha.2` is **NOT supported**, because
`ctx.settings.installSection` and `ctx.settingsScope` are absent there and were
replaced by `SettingsForms`/`ConfigForms`:

| Version | `ctx.settings` | `installSection` | `ctx.settingsScope` |
|---|---|---|---|
| `@deepseek-ai/dsh-settings@0.1.6-alpha.2` | `SettingsProvider` | Present: `installSection<const Namespace extends string, T>(owner: Context, ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void` (`lib/types/index.d.ts:228`) | Present: `ctx.settingsScope: SettingsScopeBinder` with `bind(spec)` (`dsh-client-ui-settings/lib/types/client/settings-scope.d.ts:90`, `:139`) |
| `@deepseek-ai/dsh-settings@0.1.7-alpha.2` | `SettingsForms` | Absent; replaced by `configure`/`describe`/`update`/`replace`/`mutate` over the profile entry's own Config schema | Absent; browser transport replaced by `ctx.configForms: ConfigForms` (`get`/`describe`/`whileServed`) |

The `0.1.7-alpha.2` row was read from the registry tarball
(`npm pack @deepseek-ai/dsh-settings@0.1.7-alpha.2` and
`npm pack @deepseek-ai/dsh-client-ui-settings@0.1.7-alpha.2`), since
`npm install` now resolves only the supported `0.1.6-alpha.2` line. The
`0.1.6-alpha.2` row is the installed declaration cited in the gate table.

### Both settings extension points are present in the installed 0.1.6-alpha.2 tree

Confirmed by reading the now-installed declarations directly:

- `node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts:228` declares
  `installSection<const Namespace extends string, T>(owner: Context, ns:
  Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T,
  hooks: SettingsSectionHooks<T>): void` on
  `abstract class SettingsProvider extends Service` (`:157`), and `:113`
  declares `interface Context { settings: SettingsProvider }`.
- `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/settings-scope.d.ts:90`
  declares `interface Context { settingsScope: SettingsScopeBinder }`,
  `:100` declares `class SettingsScopeBinder extends Service`, and `:139`
  declares `bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>`;
  `lib/types/client/settings-contract.d.ts:34` declares
  `SettingsScopeSpec<T> = { namespace: string; decode?: … }`.

The plan's `installSection(ctx, 'orc', ConfigSchema, base, { setSource,
onChange, validate })` call shape and
`ctx.settingsScope.bind({ namespace: 'orc' })` both type-check against these
declarations. The plan's settings design therefore stands unchanged.

## Host CLI adapter gate (Task 6)

Task 6 is the first task to import `@deepseek-ai/dsh-subprocess` at runtime, so
by ruling **R17** the package is now a `peerDependencies` entry pinned to exactly
`"0.1.6-alpha.2"` (it was already a `devDependencies` entry, so
`package-lock.json` changes only by that one added peer line).

### Verified `ctx.subprocess` surface the adapter consumes

Read from the installed `node_modules/@deepseek-ai/dsh-subprocess/lib/types/`
declarations (the same files the Task 1 gate cites at
`lib/types/index.d.ts:88`/`:102` and `lib/types/types.d.ts:69`/`:156`):

| Call | Exact shape used |
|---|---|
| `resolveExecutable` | `resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>`. The adapter passes the explicit `cliPaths` value when one is configured, otherwise the bare `codex`/`claude` name, and always passes `undefined` for `env` and the caller's `signal`. |
| `spawn` | `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, with `{ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 1_048_576 }, stderr: { maxBytes: 16_384 } }, graceMs: 5_000, signal }` exactly as the plan pins it. No `env` is passed, so the child inherits the service's own scrubbed parent environment. |
| outcome | `done: Promise<SubprocessOutcome>` is awaited first, then `waitForExit(): Promise<boolean>`, then `collected.stdout`/`collected.stderr` are read with `readFrom(0)`. `terminate()` is called when `done` rejects. |

`collected` readers are offset-based and non-consuming, and a read is `lossy`
only when the requested offset slid out of the retained tail. The adapter
rejects a lossy **stdout** read, because that stream carries the protocol record
(JSONL/JSON) it must parse. A lossy **stderr** read is kept as a diagnostic tail
(the DSH declarations describe a `SubprocessCollect` without `spill` as exactly
"the diagnostic-tail shape") and is fatal only where a verdict must be read from
stderr — the Codex auth probe, which is the one documented interface that
reports on stderr.

### Official CLI reference recheck

Rechecked 2026-09-23, before writing the probe commands, against:

- Codex CLI: <https://github.com/openai/codex> — the CLI source at
  `codex-rs/cli/src/main.rs` and `codex-rs/cli/src/login.rs`, and the JSONL event
  vocabulary at `codex-rs/exec/src/exec_events.rs`.
- Claude Code: <https://code.claude.com/docs/en/cli-reference>, plus
  <https://code.claude.com/docs/en/headless> and
  <https://code.claude.com/docs/en/agent-sdk/python>.

| Probe | Documented shape | Verdict |
|---|---|---|
| `codex --version` | clap `#[clap(version, bin_name = "codex")]` prints `codex <semver>` on stdout (`codex-rs/cli/src/main.rs`). | **Matches** the plan's `codex 0.156.1` shape. |
| `codex login status` | `LoginSubcommand::Status` → `run_login_status` writes the verdict with `eprintln!` to **stderr** and exits `0` when signed in, `1` when not (`codex-rs/cli/src/login.rs`). Signed-in lines include `Logged in using ChatGPT` and `Logged in using an API key - sk-proj-***ABCDE`; signed-out is `Not logged in`. | Command **matches**; the stream is stderr, not stdout (recorded below). |
| `codex exec --json` | JSONL events `#[serde(tag = "type")]`: `thread.started`, `turn.started`, `turn.completed` (with `usage`), `turn.failed` (with `error.message`), `item.started`, `item.updated`, `item.completed`, `error` (`exec_events.rs`). `ThreadItem` is `{ id, #[serde(flatten)] details }` with `ThreadItemDetails` tagged `rename_all = "snake_case"`, so an agent answer is `{"type":"item.completed","item":{"id":…,"type":"agent_message","text":…}}`. | **Matches**; the fixtures emit exactly this. Non-fatal warnings arrive as `item.completed` items of `type: "error"` (`collect_warning`), not as top-level `error` events, so only `turn.failed`/`error` are fatal. |
| `claude --version` | The CLI reference documents a version flag, but the fetched page truncates that row; the exact stdout could not be confirmed from the official page. Independently observed output is the bare `<semver> (Claude Code)` — for example `2.1.119 (Claude Code)` — with no product prefix. | Command **matches** the plan. By **R21** the parser accepts both the plan-pinned `claude <semver>` and the real bare `<semver>` (optionally with the exact ` (Claude Code)` suffix); see below. |
| `claude auth status` | "Show authentication status as JSON. Use `--text` for human-readable output. Exits with code 0 if logged in, 1 if not" (`cli-reference`). The payload is camelCase — `loggedIn`, `authMethod`, `apiProvider`, `email`, `orgId`, `orgName`, `subscriptionType` — and signed out is exit 1 **with valid JSON** (`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`). | Command **matches**; the fixtures emit this payload, and the adapter reads `loggedIn` rather than treating exit 1 as unreadable output. |
| `claude -p <prompt> --output-format json --model <m> --effort <e>` | `--print`/`-p` runs non-interactively; `--output-format` accepts `text`, `json`, `stream-json`; with `json` the payload is "structured JSON with result, session ID, and metadata" and the text is in the `result` field (`headless`). `--effort` accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`; `--model` sets the model (`cli-reference`). | **Matches** the plan's argv, including `--effort high`. |
| Claude result completion status | The Agent SDK checks `message.subtype == "success"` for a successful completion (`agent-sdk/python`, `receive_response`), and `ResultMessage` carries `subtype`, `is_error`, and `result`. The official `anthropics/claude-code-action` commit *"fix(sdk): fail step when result has is_error:true despite success subtype"* confirms `is_error: true` can accompany `subtype: "success"`. | The adapter accepts `result` only when `subtype === 'success'` **and** `is_error !== true`, and rejects the contradictory pair as `invalid-result`. |

### Contradictions with the plan's pinned assertions

**R11 keeps the plan's exact argv arrays.** The two pinned `*Argv` assertions
were rechecked against the documented flags above and hold byte-for-byte, so no
assertion was changed. One documented output shape did conflict with the Step 1
version table and is now resolved by ruling:

1. **`claude --version` output shape — RESOLVED by R21 (parser widening, not an
   argv change).** The Step 1 table pins the accepted form as the
   product-prefixed `claude 2.1.280`, but real Claude Code prints the bare
   version followed by a parenthesised product name — `2.1.280 (Claude Code)`,
   independently observed as `2.1.119 (Claude Code)` — with no `claude `
   prefix. Under the original pinned parser a genuine Claude host threw
   `invalid-version`, so the Claude backend was unusable regardless of
   subscription. R21 directed a widening: for `claude`, `parseCliVersion` now
   accepts **both** the plan-pinned `claude <semver>[-prerelease]` form and the
   real-world bare `<semver>` optionally followed by an **exact**
   ` (Claude Code)` suffix. This is a parser widening only. It leaves the
   pinned argv contract intact — `codexArgv` and `claudeArgv` are byte-for-byte
   unchanged (R11) — and it leaves the numeric component-by-component
   comparison, the `2.1.280` floor (`2.1.280` supported, `2.1.279` refused),
   and the malformed-input rejections unchanged: `v0.156.1 garbage`,
   ANSI-wrapped `unknown`, and every non-exact suffix (for example
   ` (Claude Code) extra`, ` (claude code)`, or `2.1.280(Claude Code)`) still
   throw `/version/`. The `codex` forms are unchanged. The vendor CLI-reference
   page still truncates the `--version` row, so **this ruling rests on the
   observed output, not on a confirmable vendor statement**. The fixture
   `tests/fixtures/fake-claude.mjs` now emits the real
   `<semver> (Claude Code)` shape, so a regression in this contract cannot
   recur untested.
2. **`codex login status` reports on stderr, not stdout.** The plan pins the
   command but no stream, so this is not a contradicted assertion; it is an
   implementation constraint now recorded. The adapter reads the verdict from
   stderr with a stdout fallback, and the pinned `stderr: { maxBytes: 16_384 }`
   collect limit is sufficient for the one-line verdict.

## Task 8 Step 3a: Typert wire artifacts and the manual contribution path

Status: **the published generator cannot build the two artifacts for this
external package** — the attempts, their exact output, and the conclusion are
recorded in `.superpowers/sdd/2026-09-23-orc-plugin/task-8-report.md`. This
section records the *other* published path the Task 8 report never addressed:
the manual `ctx.typert.register()` route the loader's own module documentation
names, and exactly how far it reaches.

> Manual `ctx.typert.register()` remains available for contributions that do
> not use a `./typert` artifact (hand-written wire schemas, tests, non-loader
> compositions).
> — `node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js:27-29`

The loader only *discovers and registers*: it resolves each mounted Loader
entry's package.json, imports its `./typert` export, validates it
(`lib/index.js:77-118`), and calls `ctx.typert.register(manifest)`
(`lib/index.js:299`). Nothing about the registry requires the generator, and
the registry README states the general rule: "Generated artifacts register
through the loader in Loader compositions; **any other owner calls
`ctx.typert.register(contribution)` directly** and receives the exact disposer
that withdraws it" (`node_modules/@deepseek-ai/dsh-typert-registry/README.md:44`).
The loader README says the same for packages "not loaded by the Loader at all":
they need "an explicit `packages` entry or direct `ctx.typert.register()`
ownership" (`node_modules/@deepseek-ai/dsh-typert-loader/README.md:115`).

### (a) The Host face is servable without any generated artifact — verified

`TypertContribution` is a plain data object — `{ package, face, schemas,
model, invocations }` (`node_modules/@deepseek-ai/dsh-typert-registry/lib/types/types.d.ts:70-77`)
— and `register(contribution)` is a public method on the published registry
service (`.../lib/types/service.d.ts:59`). Nothing in the type is
generator-produced.

Verified against the installed `0.1.6-alpha.2` packages with a throwaway probe
(not committed) that loaded `@deepseek-ai/cordis`, the published
`@deepseek-ai/dsh-typert-registry`, the published `@deepseek-ai/dsh-api-gateway`
host, and this package's built `lib/host/remote-host.js`:

```
$ node ./.typert-probe.mjs
[a1] strict definitions registered: 0
[a1] orc/getCatalog claimed: true
[a1] descriptor: {"id":"src:orcRemoteHost#orc/getCatalog","cancellation":{"parameter":"signal"},"result":{"mode":"src-json"}}
[a1] receiver is ctx.get(orcRemoteHost): false | arg count: 1
[a2] package record: @tonamson/dsh-orc#host
[a2] strict endpoint: @tonamson/dsh-orc#orcRemoteHost.getCatalog
[a2] schema keys: ["@tonamson/dsh-orc#CatalogSnapshot"]
[a2] gateway now resolves: @tonamson/dsh-orc#orcRemoteHost.getCatalog
[a2] after dispose -> endpoint: undefined | package: undefined
```

Two independent results, both stronger than the report's BLOCKED verdict:

1. **SRC discovery (no contribution at all).** With **zero** registered strict
   definitions, the Gateway host claims all three decorated endpoints
   (`claimsEndpoint`, `dsh-api-gateway/lib/index.js:510-516`, via
   `collectSrcClaims` `:518-530`) and `prepareInvocation` resolves
   `orc/getCatalog` to a source-mode descriptor
   (`src:orcRemoteHost#orc/getCatalog`, `result: { mode: 'src-json' }`,
   `cancellation: { parameter: 'signal' }`) through `resolveDescriptor`'s
   fallback (`:758-763`) and `resolveSrcDescriptor` (`:764-782`). The
   `@Remote` markers and the `typertRemote` binding that `OrcRemoteHost`
   already carries are the entire host-side requirement; the strict branch is
   only taken when a definition is registered, and SRC is refused only for an
   endpoint whose strict definition was *withdrawn* after being seen
   (`:761`). The probe's `receiver is ctx.get(...)` line compares a service
   proxy against the raw instance and is not a finding; `prepareInvocation`
   succeeded, which includes `validateBinding`.
2. **A hand-written strict contribution is accepted.** Registering a
   hand-authored `TypertContribution` (one schema factory, one `orcRemoteHost`
   service model, one `orc/getCatalog` invocation with strict codecs) through
   `ctx.typert.register()` produced package record `@tonamson/dsh-orc#host`,
   schema key `@tonamson/dsh-orc#CatalogSnapshot`, and strict endpoint
   `@tonamson/dsh-orc#orcRemoteHost.getCatalog`; the Gateway then resolves the
   strict descriptor in preference to SRC (`:758-759`), and the returned
   disposer withdraws all three atomically.

So **(a) is yes**: `ctx.typert.register()` can serve this package's Host face
with no generated `./typert` artifact, and the Host face does not even need it.

### (b) A client `./remote` contribution is hand-producible, but the clean Web profile will not mount it

The client artifact is likewise plain data: `TypertRemoteContribution` is
`{ package, descriptors }` (`dsh-typert-protocol/lib/types/types.d.ts:225-230`),
and a real generated example (`node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js`)
is a literal object of descriptors whose keys the probe read back as
`["id","service","namespace","method","invocation","scope","parameters","result","sourceLocation"]`
with `mode: 'strict'` codecs. The client Gateway validates a contribution
**structurally, never by provenance**: `validateContribution`
(`dsh-api-gateway/lib/types/client/index.js:136-176`) rejects duplicate or
conflicting endpoints and requires strict input codecs
(`requireStrictInputs`/`requireStrictCodec`, `:499-512`); it does not consult
the generator, a package name allowlist, or any generated manifest.
`$mount(contribution)` itself is public and generic (`:80-88`), and
`assertMethodAvailable` only guards name collisions on the namespace service
(`:353-368`). A hand-written `./remote` artifact is therefore *producible* and
*mountable* by any client plugin that holds `ctx.remote`.

What does **not** exist is discovery. The DSH Web client assembly value-imports
a fixed, explicit list of `/remote` artifacts and mounts exactly that list
(`node_modules/@deepseek-ai/dsh-api-remotes/lib/types/client/index.js:1-45`);
its README states the rule outright:

> The capability set is fixed by explicit build-time value imports; the Client
> does not discover the Host's active Services or Remote definitions at
> runtime.
> Additional capabilities require an explicit `/remote` value import and mount
> in this assembly.
> — `node_modules/@deepseek-ai/dsh-api-remotes/README.md:73-74`

This package cannot add itself to that list: the assembly is DSH-owned code,
and there is no client-side counterpart of the host `typert-loader` that scans
Loader entries for `./remote` exports (the loader is host-only —
`inject: ['typert', 'loader']`, `require.resolve` against `ctx.baseUrl`).
Consequently a clean Web profile does **not** expose `ctx.remote.orc`, which is
exactly what Step 3a's stated proof requires.

### Corrected verdict for Step 3a

- The report's **generator** finding stands: no published generator entry point
  builds the two artifacts for an external single-package repository.
- The report's **BLOCKED** framing was incomplete. The Host face needs no
  artifact at all (SRC discovery) and can additionally be served by a
  hand-written `ctx.typert.register()` contribution; a client `./remote`
  contribution can be hand-authored and is validated structurally.
- What is genuinely unavailable is the **client mount path in a clean Web
  profile**: `ctx.remote.orc` appears only if DSH adds this package to
  `@deepseek-ai/dsh-api-remotes`, or if this bundle's own client plugin mounts
  its own hand-written contribution through the public `ctx.remote.$mount()`
  (API-permitted, but a composition decision the controller must make, and not
  the proof Step 3a describes).
- `./typert` and `./remote` therefore stay **undeclared** in `package.json`:
  the loader imports a declared `./typert` export and fails loud on a broken
  artifact, and this bundle has none to declare.

## Task 10 release gate

Status: **PASS** on the single supported version. The gate is
`tests/integration/bundle.spec.ts` (archive contract),
`tests/integration/compatibility.spec.ts` (support set and extension
contracts), `tests/integration/disabled.spec.ts` (profile lifecycle against the
packed archive), and `scripts/clean-profile-smoke.mjs` (clean-profile
installation and the real Plugin Manager enable/disable/restart operations),
driven by `.github/workflows/ci.yml`.

### Supported set and CI matrix

The published support set is exactly **`@deepseek-ai/dsh*` `0.1.6-alpha.2`**.
The CI matrix is a **single entry** for that version; there is no second
candidate and no range. The narrowing and its cause (absent
`ctx.settings.installSection` / `ctx.settingsScope` in `0.1.7-alpha.2`) are
recorded in [Support-range finding](#support-range-finding). The workflow
comments state that adding a version means adding a matrix entry only after the
smoke passes for it; it is never widened by semver inference.

### Exact passing versions

The gate ran with:

| Item | Version |
|---|---|
| `@deepseek-ai/dsh` (CLI and `./profile-boot` entry used by the smoke harness) | `0.1.6-alpha.2` |
| `@deepseek-ai/dsh-settings`, `dsh-tools`, `dsh-llm`, `dsh-session`, `dsh-subagent`, `dsh-subprocess`, `dsh-typert-protocol`, `dsh-system-prompt`, `dsh-client-ui-settings` | `0.1.6-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.4` |
| `@deepseek-ai/schemastery` | `3.18.4` |
| Node.js / npm / pnpm | v24.19.0 / 12.0.2 / 11.7.0 |

`tests/integration/compatibility.spec.ts` asserts every one of these exact
versions and every DSH peer pin (`"0.1.6-alpha.2"`, no caret, tilde, range, or
`||`).

### Extension contracts the gate pins

Read from the installed `0.1.6-alpha.2` declarations, so a DSH upgrade that
removes or reshapes one fails before it can ship:

| Contract | Pinned declaration |
|---|---|
| `ctx.settings.installSection` | `installSection<const Namespace extends string, T>(owner: Context, ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void` on `abstract class SettingsProvider extends Service` |
| `ctx.settingsScope` | `settingsScope: SettingsScopeBinder` with `bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>` |
| `settings.section` client slot | `'settings.section'` and `SettingsSectionOwnerProps` |
| `defineTool` | `export declare function defineTool` |
| `ctx.systemPrompt.section` | `section(section: PromptSection): () => void` |
| `ctx.llm.stream` | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` |
| `ctx.subagents.startContinuable` | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` |
| `ctx.subprocess.spawn` | `spawn(spec: SubprocessSpawnSpec): SubprocessHandle` |
| Typert host seams | `export declare abstract class TypertRemoteService` and `export declare function Remote` |
| Profile-boot entry the smoke boots through | `@deepseek-ai/dsh` export `./profile-boot` → `runProfile(options: RunProfileOptions)` with `profile`, `patchFiles`, and `args`, plus `createLaunchEnvironmentSnapshot` from `@deepseek-ai/dsh-launch-environment` |

`./typert` and `./remote` stay undeclared: the published generator cannot build
them for this external package, and the loader fails loud on a declared-but-
broken artifact (see [Task 8 Step 3a](#task-8-step-3a-typert-wire-artifacts-and-the-manual-contribution-path)).

### Archive contract

`tests/integration/bundle.spec.ts` packs the repository with `npm pack --json`
and extracts the archive. It asserts one package under the published name and
version; the presence of `cordis.patch.yml`, `lib/host/index.js`,
`lib/host/remote-host.js`, the lazy-CJS `lib/client.js`, `lib/client/locales.js`
(the `settings.orc` namespace), `README.md`, and the benchmark fixtures; the two
Loader rows and only those rows; the lazy-CJS factory shape
(`window.__ModuleLoader__.load({ id: '@tonamson/dsh-orc', factory(require) … })`);
and that the whole manifest and lockfile contain no `workspace:` dependency.
The `README.md` assertion is load-bearing: it is listed in `package.json`
`files`, so a missing README cannot pass silently.

### Clean-profile smoke result

`node scripts/clean-profile-smoke.mjs "0.1.6-alpha.2"` completed:

- packed the bundle into its own `mkdtemp` directory;
- created a disposable `$DSH_HOME` and Web profile;
- installed the tarball through `dsh plugin --profile web add file:<absolute>`;
- inspected the **installed** archive (manifest, patch rows, Host JS, lazy-CJS
  Client JS, locale strings, README, benchmark fixture manifest);
- composed the profile with `dsh --profile web --dump-config` and confirmed both
  ORC rows appear after install, disappear after a Plugin Manager disable,
  reappear after a Plugin Manager enable, and disappear after removal, while the
  non-ORC composed rows stay byte-identical;
- confirmed the seeded user patch layer (global model default) is byte-identical
  before install and after removal, and the credentials document is
  byte-identical across install and across every Plugin Manager action and
  removal (see the baseline note below);
- drove spec → plan → Lead/Peer → task settle → review (medium finding blocks
  completion) → fix → review → audit → final branch review and audit →
  `completed` through the installed `OrcService` with keyless fake ports;
- removed the bundle and confirmed the dependency is gone **and that the
  removal command's own reconciliation dropped the selection**, with no
  hand-edit of `dsh.profile.bundles` anywhere in the run.

### Real Plugin Manager operations (enable, disable, restart requirement)

`dsh plugin` forwards its arguments straight to pnpm (`runPlugin` →
`runPluginCommand` → `runProfilePnpm`), so `enable` and `disable` have no CLI
surface: they exist only as the `pluginManager` service inside a booted profile.
The smoke therefore boots the disposable Web profile headlessly through DSH's
public `@deepseek-ai/dsh/profile-boot` entry with `--no-open --port 0` (an
ephemeral port and no browser), calls the service, and disposes the profile
again. Three boots are used:

1. the normal composition, where `hmr` is live: `setBundleEnabled(false)` and
   `setBundleEnabled(true)` must report `application: "applied"` and
   `changed: true`, must persist `dsh.profile.bundles`, and must mount/unmount
   the `orc-host` and `orc-remote-host` loader rows and the `orc` service for
   real. The same boot asserts the service's guards:
   `setBundleEnabled('zod', true)` must be refused with `not-bundle` and
   `setBundleEnabled('@deepseek-ai/dsh-base', false)` with `management-required`,
   neither of which may change the selection;
2. a composition booted with a `- id: hmr / disabled: true` overlay, so the
   manager must report `application: "restart-required"` and still persist the
   disable;
3. the controlled restart of the normal composition, which must come up with no
   ORC row and no `orc` service, after which a Plugin Manager enable must apply
   and remount them.

`tests/integration/profile-harness.ts` keeps its `ProfileManager` as the
**test-side mirror** of the persisted writes: it writes the same bytes and
recomposes a live in-process runtime, so the contribution transitions and the
DSH-owned-defaults comparisons can run in vitest, but it does not call the
service and cannot observe the guards or the restart requirement. The smoke's
booted leg is the verification for those; the mirror's own doc comment says so,
so it is not mistaken for the real operation.

The smoke never calls a model provider. It fails loudly with an actionable
message when the CLI, the archive, the boot entry, or the install path is
unavailable; it never reports success for a step it could not run.

**DSH-owned baseline note.** A booted Web profile mints its own
`client-connection/browser-session` grant into `$DSH_HOME/.credentials.yaml`
(DSH's `credentials-local` provider, not this bundle), so the raw credential
bytes legitimately move once on the first boot and are stable afterwards. The
smoke's DSH-owned baseline for the booted leg — and for the later removal
comparison — is therefore taken immediately after the first boot settles, and
every ORC action is compared against it byte-for-byte. The install comparison
still runs from the pre-install baseline, before any boot.

### Lifecycle note: disable ordering

The bundle's unload disposes the ORC service (which aborts the run lifetime and
settles an in-flight delegated child startup durably) and the ORC session
projection in the same Cordis fiber unload. The settlement write is a microtask
triggered by the abort, while the projection effect's disposer runs in the same
unload batch, so a startup cancelled *by the unload itself* can lose the race to
write `orc/fail`. `tests/integration/disabled.spec.ts` therefore pins the
settlement at the point the ORC service is disposed — the first unload step the
Host composition performs — and pins contribution removal, the absence of an
orphan child, and unchanged DSH defaults across the full disable. A future Host
change that settles active runs before the projection is disposed should move
that assertion after the complete disable.

## Concerns handed to later tasks

These are recorded here as gate output. Task 1 does not change later tasks.

1. **Task 2 — `ctx.settings.installSection`: RESOLVED by narrowing to
   `0.1.6-alpha.2`.** The signature the plan assumes
   (`installSection(ctx, 'orc', ConfigSchema, base, { setSource, onChange,
   validate })`) is present in the installed tree at
   `dsh-settings/lib/types/index.d.ts:228` with exactly that shape, so Task 2
   keeps its assigned scope with no version-conditional path. The isolation
   assertion (`sections === ['orc']`) is supported by
   `SettingsProvider.describe()` (`:236`) over registered namespaces.
2. **Task 9 — `ctx.settingsScope`: RESOLVED by narrowing to `0.1.6-alpha.2`.**
   `ctx.settingsScope.bind({ namespace: 'orc' })` resolves against the installed
   `settings-scope.d.ts:139` / `settings-contract.d.ts:34`, and the returned
   `SettingsScope<T>` provides the reactive `getSnapshot`/`subscribe` plus
   `set`/`unset`/`mutate` write path Task 9 needs. No `configForms` port is
   required.
3. **Task 8 Step 3a — RESOLVED with a corrected verdict; see
   [Task 8 Step 3a](#task-8-step-3a-typert-wire-artifacts-and-the-manual-contribution-path).**
   The published generator is library-only and requires the DSH monorepo
   workspace shape, so it cannot emit the two wire artifacts for this external
   single-package repository (evidence in the Task 8 report). The manual
   `ctx.typert.register()` path *can* serve the Host face with no artifact at
   all (verified: the Gateway's SRC discovery claims and resolves the decorated
   `orcRemoteHost` endpoints with zero registered definitions), and a client
   `./remote` contribution is hand-producible. The remaining gap is the client
   mount path: the clean Web profile's assembly mounts only its own explicit
   build-time `/remote` imports and discovers nothing, so `ctx.remote.orc` is
   unavailable there without a DSH-side assembly change or a self-mounting
   client plugin. `./typert` and `./remote` stay undeclared.
4. **Task 8 — `startContinuable` request shape.** `request.prompt` is
   `ContentBlock[]`, not a string, and `request.parent` is an `Agent` object
   (not an id); `signal` sits on the spec, not on the request.
5. **`ctx.llm.stream` message typing differs from the `0.1.7-alpha.2` line.**
   In `0.1.6-alpha.2`, `GenerateOptions.messages` is `Message[]` and the
   `RequestMessage` union does not exist. Any later task written against
   `RequestMessage` must use `Message[]` instead.
6. **Manifest `inject` vs `external`.** `dsh.client.inject` is informational.
   If Task 9 value-imports any non-baseline client package, the request must be
   added to `dsh.client.external` or the module loader will reject it at
   materialization.
7. **npm 12 blocks install scripts** (`esbuild` postinstall, and DSH packages
   such as `dsh-subprocess-local`'s spawn-helper postinstall). The esbuild JS
   API still builds this bundle without its postinstall, so `build` and
   `pack:check` pass. If a later task needs a blocked postinstall (for example
   `dsh-subprocess-local`'s spawn helper in Task 10 integration),
   `npm install-scripts approve <pkg>` will be required in that environment.
   No repository config was added for this, since the brief does not ask for it.
8. **Environment.** All npm commands were run with
   `npm_config_cache="$PWD/.npm-cache"` (R2); `.npm-cache/` is gitignored (R3).
   Pre-existing untracked `.serena/` and `docs/superpowers/plans/` were left
   alone as outside this task's commit list.
9. **Task 9 — a missing CLI executable has no dedicated code.** The six-code
   contract has no not-found bucket, so `CliAdapter.probe` reports an
   unresolvable or unstartable executable as `unsupported-protocol`, with the
   redacted resolution diagnostic naming the executable. If the settings page
   needs to render "not installed" differently from "capability mismatch", the
   controller should add a seventh code rather than overload this one.
10. **Task 8 — `CliAdapter.catalog(cli, routes, signal)` carries no CLI path.**
    The pinned signature has no `path` parameter, so the catalog discovers the
    executable on `PATH` and cannot honour `config.cliPaths`. Threading an
    explicit path into the catalog is a Task 8 concern; the pinned interface was
    not changed here.
11. **Task 8 — `CliAdapter.probe(route, path, signal)` carries no `cwd`.** The
    pinned signature has no working directory, so version, auth-status, and the
    harmless capability prompt all run in the harness working directory.
12. **A green probe is held in adapter memory, keyed by route key.** `probe`
    records it and `run` re-inspects the live identity (path, parsed version,
    auth/account fingerprint) and refuses a moved revision before dispatch. A
    fresh `CliAdapter` therefore has no green probe and `run` rejects until
    `probe` or `catalog` has succeeded; Task 8 must persist or re-derive that
    evidence if a probe is expected to survive a process restart.
13. **Task 10 — disable-time settlement ordering.** The Host's fiber unload
    disposes the ORC service and the ORC session projection in the same batch,
    and the projection effect's disposer runs before the aborted child startup's
    settlement microtask. An active delegated run is therefore cancelled on
    disable (no orphan child, no completion), but the durable `orc/fail` write
    for a startup cancelled *by that same unload* cannot land after the
    projection is gone. See
    [Lifecycle note: disable ordering](#lifecycle-note-disable-ordering). A
    future Host change should settle active runs before disposing the
    projection; Task 10 pins the settlement at the service-disposal step and
    reports the gap rather than weakening the assertion.
