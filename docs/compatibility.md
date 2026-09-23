# DSH compatibility contract

Status: Task 1 compatibility gate. This document records what the **packed**
DSH `0.1.7-alpha.2` packages actually expose, so later tasks can rely on
verified signatures instead of the plan's assumptions. It is a verification
record, not a redesign: later tasks keep their assigned scope, and any mismatch
is listed under [Concerns](#concerns-handed-to-later-tasks).

## Verified environment

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| npm | 12.0.2 |
| DSH resolved by `npm install` | `@deepseek-ai/dsh` `0.1.7-alpha.2` |
| Declaration source | `node_modules/@deepseek-ai/*/lib/types/**.d.ts` |
| Archive contract test | `tests/bundle.spec.ts` |

`npm install` resolves the manifest's `peerDependencies`/`devDependencies` to
the `0.1.7-alpha.2` line and installs the full DSH tree, so every
`node_modules/@deepseek-ai/...` path below is the published package, not a
monorepo source path.

## Extension-point gate

One row per name the plan's later tasks depend on. "Found" means the exact name
is present in the installed `0.1.7-alpha.2` declarations.

| Name | Status | Exact signature | File |
|---|---|---|---|
| `ctx.settings.installSection` | **NOT FOUND** | Absent. `ctx.settings` is `SettingsForms`, whose surface is `configure(presentation: { auto?: boolean }, owner?: Fiber): () => void`, `describe(options?: SettingsDescribeOptions): SettingsDescriptor[]`, `update(ns: string, patch: object, expectedRevision?: number): Promise<void>`, `replace(ns: string, section: object, expectedRevision?: number): Promise<void>`, `mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>`, plus `writable`, `documentPath`, `prepareDocument()`. | `node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts` (`interface Context { settings: SettingsForms }`, class `SettingsForms`) |
| `ctx.llm.stream` | Found | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`; `ctx.llm: LlmRuntime`. `GenerateOptions` requires `provider: string`, `model: string`, `messages: RequestMessage[]` and accepts `reasoningEffort?: ReasoningEffortId`, `system?: string`, `tools?`, `temperature?`, `maxTokens?`, `stop?`, `signal?: AbortSignal`, `sessionId?`, `purpose?`. | `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:408` (method), `:29` (`interface Context { llm: LlmRuntime }`), `lib/types/types.d.ts:466` (`GenerateOptions`) |
| `ctx.subagents.startContinuable` | Found | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`; `ctx.subagents: SubagentRuntime`. `ContinuableStartSpec` is `{ provider: string; label: string; childId?: SessionId; request: Omit<SubagentStartRequest, 'label' \| 'signal' \| 'outputSchema'>; signal: AbortSignal }`; `ContinuableStart` is `{ childId: SessionId; messageId: MessageId }`. Note `SubagentStartRequest.prompt` is `ContentBlock[]`, **not** a string, and `parent: Agent` and `signal: AbortSignal` are required. `agentOptions?: AgentOptions` carries `provider?`, `model?`, `reasoningEffort?`, `maxTokens?`. | `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts:142`; `lib/types/types.d.ts:26` (`ContinuableStartSpec`), `:136` (`SubagentStartRequest`); `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:21` (`AgentOptions`) |
| `ctx.subprocess` | Found | `ctx.subprocess: SubprocessRuntime` with `resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>`, `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, `terminalEnvironment(signal?)`, `spawnTerminal(spec)`. `SubprocessSpawnSpec` is `{ argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal }` with `SubprocessStdio = { stdin: 'ignore' \| 'pipe' \| { data: string }; stdout: 'pipe' \| 'inherit' \| SubprocessCollect; stderr: … }` and `SubprocessCollect = { maxBytes: number; spill?: { maxBytes: number } }`. The handle exposes `done: Promise<SubprocessOutcome>`, `waitForExit(signal?: AbortSignal): Promise<boolean>`, `terminate(): void`, `collected`, `stdin`/`stdout`/`stderr`, `control`. | `node_modules/@deepseek-ai/dsh-subprocess/lib/types/index.d.ts:43` (`interface Context { subprocess: SubprocessRuntime }`), `:88` (`resolveExecutable`), `:102` (`spawn`); `lib/types/types.d.ts:69` (`SubprocessSpawnSpec`), `:56` (`SubprocessStdio`), `:156` (`SubprocessHandle.done` `:168`, `waitForExit` `:182`) |
| `defineTool` | Found | `defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition`, re-exported from the package root. The registering surface is `ctx.tools: ToolRuntime`. | `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts:248`; re-export `lib/types/index.d.ts:24`; `ctx.tools` at `lib/types/index.d.ts:34` |
| `ctx.systemPrompt.section` | Found | `section(section: PromptSection): () => void` returning the Cordis effect disposer; `ctx.systemPrompt: SystemPrompt`. `PromptSection` is `{ name: string; order: number; text: string \| ((context: AssembleContext) => string); interpolate?: boolean; complete?: boolean }`. | `node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:239` (method), `:12` (`interface Context { systemPrompt: SystemPrompt }`), `:47` (`PromptSection`) |
| `settings.section` client slot | Found | Slot map entry `'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }` with `SettingsSectionOwnerProps = { close: () => void }`. Registrant options carry `id` (section key), `order` (nav position), and `label` (registrant-localized text). | `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73`, owner props at `:154` |
| `ctx.settingsScope` | **NOT FOUND** | Absent from every installed `@deepseek-ai` declaration. The browser settings transport is `ctx.configForms: ConfigForms` (`get<T>(entryId: string): ConfigForm<T>`, `describe(): SettingsDescribeFace`, `whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void`), and `ConfigForm<T>` exposes `getSnapshot()`, `subscribe(listener)`, `set(field: string, value: unknown): Promise<boolean>`, `unset(field: string): Promise<boolean>`, `mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>`. Writes are revision-fenced against the latest known namespace revision. | `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/config-form.d.ts:96` (`interface Context { configForms: ConfigForms }`), class at `:106`, `get` at `:142`, `whileServed` at `:156`, `set`/`unset`/`mutate` at `:67`/`:74`/`:81` |
| `TypertRemoteService` | Found | `abstract class TypertRemoteService<out T = never> extends Service<T>` with `readonly typertRemote: TypertGatewayBinding<this>` and `protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)`. | `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts:66` |
| `@Remote` | Found | Two overloads: `Remote<This extends object, Args extends unknown[], Result>(_method: (this: This, ...args: Args) => Result, context: ClassMethodDecoratorContext<…>): void` and `Remote(option: string \| RemoteMethodOptions): RemoteMethodDecorator`. Standard TC39 method decorators — no `experimentalDecorators`. `RemoteScope(key, exportName?)` is also published. | `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts:82` (bare), `:88` (`@Remote('name')`), `:95` (`RemoteScope`) |
| Published Typert generator | Found (published, not installed by this manifest) | `@deepseek-ai/dsh-typert-generator`; npm `alpha` dist-tag is `0.1.7-alpha.2`, matching the supported DSH line. **No `bin`** — it is a library: `.` exports `WorkspaceTypertGenerator` (`constructor(root: string, options?: WorkspaceTypertGeneratorOptions)`, `discover(faces?)`, `generate(packages?, faces?)`), `WorkspaceAnalyzer`, `FaceModelEmitter`, `TypeGraphRenderer`; `./tsdown` exports a tsdown plugin. Declares `typescript: ^6.0.3` and peer `@deepseek-ai/cordis ^4.0.1-rc.1`. No README is published for this version. | Registry metadata + tarball `@deepseek-ai/dsh-typert-generator@0.1.7-alpha.2` (`lib/types/index.d.ts`, `lib/types/workspace.d.ts`, `lib/types/analyzer.d.ts`) |

### Service keys confirmed alongside the gate

`ctx.llm`, `ctx.subagents`, `ctx.subprocess`, `ctx.tools`, `ctx.systemPrompt`,
and `ctx.settings` are all declared by their owning packages through
`declare module '@deepseek-ai/cordis' { interface Context { … } }`, so a
consumer package gets them by depending on the owning package and importing it
for the augmentation.

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
`node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` (0.1.7-alpha.2):

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

Contract facts that follow from `@deepseek-ai/dsh-client-modules@0.1.7-alpha.2`
and the `DshClientManifest` type
(`node_modules/@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts`):

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
  *"informational package-name dependencies, not Cordis service injection"*.
  It is valid manifest data, but it is not what makes a `require(...)` inside
  the factory resolvable — `dsh.client.external` is.
- `dsh.client.immediately` selects a boot phase-one registration barrier;
  absent means the shared application batch, which is what this bundle wants.
- The host serves each built `lib/client.js` under `/plugins`, so the artifact
  must exist before launch; a missing bundle fails activation loudly.
- `tests/bundle.spec.ts` pins the manifest half of this contract. Task 10 tests
  the artifact through the real client module loader.

## Support-range finding

The declared range is exactly `0.1.6-alpha.2 || 0.1.7-alpha.2`, with no widening
by semver inference. The gate shows the two ends are **not** API-uniform for the
settings extension point:

| Version | `ctx.settings` | `installSection` |
|---|---|---|
| `@deepseek-ai/dsh-settings@0.1.6-alpha.2` | `SettingsProvider` | Present: `installSection<const Namespace extends string, T>(owner: Context, ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void` (`lib/types/index.d.ts:228`) |
| `@deepseek-ai/dsh-settings@0.1.7-alpha.2` | `SettingsForms` | Absent; replaced by `configure`/`describe`/`update`/`replace`/`mutate` over the profile entry's own Config schema |

The `0.1.6-alpha.2` row was read from the registry tarball
(`npm pack @deepseek-ai/dsh-settings@0.1.6-alpha.2`), since `npm install`
resolves only the newest supported version. The `0.1.7-alpha.2` row is the
installed declaration cited in the gate table.

In `0.1.7-alpha.2` the settings surface for a plugin that owns a page is: the
plugin's own Cordis `Config` schema declared on its Loader row (which becomes
the namespace's `base`), plus `ctx.settings.configure({ auto: false }, ctx.fiber)`
when the plugin ships its own page instead of the auto-generated one. This is
how the shipped `@deepseek-ai/dsh-llm-deepseek@0.1.7-alpha.2` composes its page
(`node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:2173`).

## Concerns handed to later tasks

These are recorded here as gate output. Task 1 does not change later tasks.

1. **Task 2 — `ctx.settings.installSection` is absent from `0.1.7-alpha.2`.**
   The plan's Task 2 Step 4 signature (`installSection(ctx, 'orc', ConfigSchema,
   base, { setSource, onChange, validate })`) exists only on `0.1.6-alpha.2`.
   Task 2's settings bridge needs a version-conditional path (or a decision to
   narrow the published range), and the isolated-namespace assertion
   (`sections === ['orc']`) has no direct equivalent on the newer API.
2. **Task 9 — `ctx.settingsScope` is absent from `0.1.7-alpha.2`.** The browser
   write path is `ctx.configForms.get(entryId)` with revision-fenced
   `set`/`unset`/`mutate`, and `ctx.configForms.whileServed([...])` for a page
   that follows a namespace the Host serves. `ctx.settingsScope.bind({ namespace:
   'orc' })` does not resolve. Note `ConfigForms.get` is documented as taking a
   *profile entry id*, while `whileServed` takes *namespaces*; Task 9 must
   confirm which key the ORC row produces.
3. **Task 8 Step 3a — the Typert generator is published but library-only.**
   `@deepseek-ai/dsh-typert-generator@0.1.7-alpha.2` has no CLI (`bin` absent);
   it is consumed as a programmatic API or a tsdown plugin, and it binds to a
   workspace root with host/client **face aggregate tsconfigs**
   (`WorkspaceAnalyzerOptions.hostConfig`/`clientConfig`). Whether it can emit
   the two wire artifacts for a single external package with no aggregate
   configs is unproven by this gate. It also requires `typescript ^6.0.3`,
   while this manifest pins `typescript ^5.9.0`.
4. **Task 8 — `startContinuable` request shape.** `request.prompt` is
   `ContentBlock[]`, not a string, and `request.parent` is an `Agent` object
   (not an id); `signal` sits on the spec, not on the request.
5. **Manifest `inject` vs `external`.** `dsh.client.inject` is informational.
   If Task 9 value-imports any non-baseline client package, the request must be
   added to `dsh.client.external` or the module loader will reject it at
   materialization.
