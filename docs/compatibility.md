# DSH compatibility contract

Status: Task 1 compatibility gate, revised by controller ruling **R15**. This
document records what the **packed** DSH `0.1.6-alpha.2` packages actually
expose, so later tasks can rely on verified signatures instead of the plan's
assumptions. It is a verification record, not a redesign: later tasks keep
their assigned scope, and any mismatch is listed under
[Concerns](#concerns-handed-to-later-tasks).

## Verified environment

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| npm | 12.0.2 |
| Published support set | `@deepseek-ai/dsh*` exactly `0.1.6-alpha.2` (no range, no caret) |
| DSH resolved by `npm install` | `@deepseek-ai/dsh` `0.1.6-alpha.2` |
| Declaration source | `node_modules/@deepseek-ai/*/lib/types/**.d.ts` |
| Archive contract test | `tests/bundle.spec.ts` |

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
3. **Task 8 Step 3a — the Typert generator is published but library-only.**
   `@deepseek-ai/dsh-typert-generator@0.1.6-alpha.2` has no CLI (`bin` absent);
   it is consumed as a programmatic API or a tsdown plugin, and it binds to a
   workspace root with host/client **face aggregate tsconfigs**
   (`WorkspaceAnalyzerOptions.hostConfig`/`clientConfig`). Whether it can emit
   the two wire artifacts for a single external package with no aggregate
   configs is unproven by this gate. It also requires `typescript ^6.0.3`,
   while this manifest pins `typescript ^5.9.0`. Its `@deepseek-ai/cordis`
   peer is `^4.0.2`, which the pinned `4.0.4` satisfies. This is the gate Task 8
   Step 3a is meant to resolve; it is not resolved by Task 1.
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
