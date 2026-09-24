#!/usr/bin/env node
/**
 * Clean Web-profile smoke for the packed ORC bundle.
 *
 * One exact DSH version argument. The run:
 *
 * 1. packs this repository into an owned temporary directory with
 *    `npm pack --pack-destination`;
 * 2. creates a disposable `$DSH_HOME` and Web profile;
 * 3. installs the tarball through the documented
 *    `dsh plugin --profile web add file:<absolute path>` path;
 * 4. inspects the **installed** package archive, never the source tree;
 * 5. boots that profile headlessly through DSH's own public
 *    `@deepseek-ai/dsh/profile-boot` entry and exercises the real Plugin
 *    Manager `setBundleEnabled` operations, its `not-bundle` /
 *    `management-required` guards, and its restart-required reporting, then
 *    recomposes the profile with `dsh --profile web --dump-config`, comparing
 *    the standard preset, global model defaults, provider credentials, and the
 *    unrelated rows byte-for-byte;
 * 6. removes the bundle through the real `dsh plugin` command and lets that
 *    command's own reconciliation drop the selection;
 * 7. drives the complete ORC workflow through the installed service with fake
 *    provider/CLI inputs and keyless recorded reports;
 * 8. removes only the directory it created, in a `finally` block.
 *
 * `dsh plugin` forwards its arguments to pnpm, so `enable`/`disable` exist only
 * as the `pluginManager` service inside a booted profile. This run therefore
 * boots the disposable Web profile with `--no-open --port 0` (an ephemeral port
 * and no browser), calls the service, and disposes the profile again. It never
 * calls a model provider. It fails loudly with an actionable message when the
 * CLI, the packed archive, the boot entry, or the install path is unavailable —
 * it never reports success for a step it could not run.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

/** The repository root, so `npm pack` and the DSH CLI resolve. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The one user-facing bundle package. */
const PACKAGE_NAME = '@tonamson2/dsh-orc'
/** The one DSH version this release supports (R15: no range). */
const SUPPORTED = '0.1.6-alpha.2'
/** The two Loader rows the bundle patch declares. */
const BUNDLE_ROWS = ['orc-host', 'orc-remote-host']
/** The fixed instant every keyless fixture record uses. */
const NOW = '2026-09-23T00:00:00Z'
/** The benchmark suite revision the shipped fixture manifest records. */
const SUITE_REVISION = 'orc-review-v1'
/** The inner arguments the headless profile boot runs with: ephemeral port, no browser. */
const BOOT_ARGS = ['--no-open', '--port', '0']
/** The banner a booted Web profile prints; suppressed so the smoke output stays clean. */
const WEB_BANNER = 'dsh web: '

const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')

/**
 * One refused smoke step.
 *
 * Thrown rather than exiting in place: `main` owns an owned temp directory whose
 * `finally` must run on every failure, and `process.exit` would skip it and leak
 * the profile. The top-level handler below reports the message and the exit code.
 */
class SmokeRefusal extends Error {}

function fail(message) {
  throw new SmokeRefusal(message)
}

function step(message) {
  process.stdout.write(`clean-profile-smoke: ${message}\n`)
}

/** Read the one exact DSH version argument and refuse anything else. */
function requestedVersion() {
  const [version, ...extra] = process.argv.slice(2)
  if (version === undefined) fail(`pass exactly one DSH version, for example "${SUPPORTED}"`)
  if (extra.length > 0) fail(`pass exactly one DSH version; unexpected arguments: ${extra.join(' ')}`)
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)) fail(`"${version}" is not an exact version`)
  if (version !== SUPPORTED) {
    fail(`DSH ${version} is outside the supported set; this release supports exactly ${SUPPORTED}`)
  }
  return version
}

/** The profile package.json, as DSH persists its bundle selection. */
function readManifest(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

/** Every profile bundle name currently selected. */
function selectedBundles(profileDir) {
  return readManifest(profileDir).dsh?.profile?.bundles ?? []
}

/**
 * The ORC rows the booted profile actually mounted.
 *
 * A row whose entry has no fiber is declared but not live, which is exactly the
 * difference a persisted `dsh.profile.bundles` write cannot show.
 */
function liveOrcRows(ctx) {
  return [...ctx.loader.entries()]
    .filter(entry => BUNDLE_ROWS.includes(String(entry.options.id)) && entry.fiber !== undefined)
    .map(entry => String(entry.options.id))
}

/** Assert one Plugin Manager operation applied in place. */
function assertApplied(label, result) {
  const detail = result.error === undefined ? '' : ` (${result.error.code})`
  if (result.application !== 'applied') fail(`${label} reported ${result.application}${detail}, not applied`)
  if (result.changed !== true) fail(`${label} reported changed=${String(result.changed)}`)
}

/** Assert one Plugin Manager operation was refused with the expected guard code. */
function assertRefused(label, result, code) {
  const detail = result.error === undefined ? 'no error code' : result.error.code
  if (result.application !== 'failed' || detail !== code) {
    fail(`${label} reported ${result.application}/${detail}, not failed/${code}`)
  }
}

/**
 * Suppress only the booted Web server's own `dsh web: <url>` banner.
 *
 * Every other byte still reaches stdout, so a real diagnostic is never hidden.
 *
 * @returns a restore function that flushes any buffered partial line.
 */
function muteWebBanner() {
  const original = process.stdout.write.bind(process.stdout)
  let pending = ''
  process.stdout.write = (chunk) => {
    pending += String(chunk)
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith(WEB_BANNER)) original(`${line}\n`)
    }
    return true
  }
  return () => {
    process.stdout.write = original
    if (pending !== '') original(pending)
  }
}

/**
 * Boot the disposable Web profile headlessly through DSH's public profile-boot
 * entry, exactly as `dsh --profile web --patch <file> --no-open --port 0` would.
 *
 * @param patchFiles absolute `--patch` overlay paths, in order.
 * @returns the booted root context and its shutdown controller.
 */
async function bootProfile(patchFiles) {
  let modules
  try {
    modules = await Promise.all([
      import('@deepseek-ai/dsh/profile-boot'),
      import('@deepseek-ai/dsh-launch-environment'),
    ])
  } catch (error) {
    return fail(`the pinned @deepseek-ai/dsh profile-boot path is unavailable: ${String(error?.message ?? error)}`)
  }
  const [boot, launch] = modules
  const environment = launch.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  return boot.runProfile({ environment, profile: 'web', patchFiles, args: BOOT_ARGS })
}

/**
 * Drive the real Plugin Manager enable/disable operations against the
 * disposable Web profile.
 *
 * `dsh plugin` forwards its arguments to pnpm, so enable and disable exist only
 * as the `pluginManager` service inside a booted profile. This leg boots the
 * profile three times — the normal composition, a composition whose `hmr` row is
 * disabled so the manager must report `restart-required`, and the controlled
 * restart that applies the persisted change — and asserts the real service's
 * results, its guards, and the live runtime contributions.
 *
 * @param options the owned temp root, the disposable harness home, the profile
 *   directory, and the composition/snapshot readers owned by the caller.
 * @returns the stable DSH-owned baseline taken after the first boot, for the
 *   caller's later removal comparison.
 */
async function exercisePluginManager({ ownedDir, home, profileDir, dumpConfig, snapshot }) {
  const restoreBanner = muteWebBanner()
  // The in-process boot resolves `$DSH_HOME` from `process.env` at call time, so
  // it must be scoped here: without this the boot would load the developer's own
  // profile instead of the disposable one.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const managerOf = (ctx, label) => {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) fail(`${label} exposed no pluginManager service`)
    return manager
  }
  let baseline
  try {
    step('booting the profile and exercising the Plugin Manager enable/disable operations')
    const applied = await bootProfile([])
    try {
      if (applied.ctx.get('orc') === undefined) fail('the booted profile did not activate the ORC service')
      if (liveOrcRows(applied.ctx).length !== BUNDLE_ROWS.length) {
        fail(`the booted profile mounted ${liveOrcRows(applied.ctx).length} of ${BUNDLE_ROWS.length} ORC rows`)
      }
      const manager = managerOf(applied.ctx, 'the booted profile')
      const listed = (await manager.listBundles()).find(bundle => bundle.name === PACKAGE_NAME)
      if (listed === undefined) fail('the Plugin Manager does not list the installed bundle')
      if (listed.error !== undefined) fail(`the Plugin Manager reports the bundle as ${listed.error.code}`)
      if (!listed.enabled || !listed.installed || !listed.removable) {
        fail(`the Plugin Manager reports the bundle enabled=${listed.enabled} installed=${listed.installed} removable=${listed.removable}`)
      }
      const rowIds = (listed.rows ?? []).map(row => row.rowId)
      if (rowIds.length !== BUNDLE_ROWS.length || !BUNDLE_ROWS.every(row => rowIds.includes(row))) {
        fail(`the Plugin Manager reports rows ${rowIds.join(', ')}, not ${BUNDLE_ROWS.join(', ')}`)
      }

      // The DSH-owned baseline is taken here, after the first boot. A booted Web
      // profile mints its own `client-connection/browser-session` grant into
      // `.credentials.yaml` (DSH's credentials-local provider, not this bundle),
      // so the raw credential bytes legitimately move once on the first boot and
      // are stable from then on. Every ORC action below is compared against this
      // baseline, and the caller reuses it after removal.
      baseline = snapshot()

      assertApplied('Plugin Manager setBundleEnabled(false)', await manager.setBundleEnabled(PACKAGE_NAME, false))
      if (applied.ctx.get('orc') !== undefined) fail('disabling through the Plugin Manager left the ORC service mounted')
      if (liveOrcRows(applied.ctx).length !== 0) fail('disabling through the Plugin Manager left ORC rows mounted')
      if (selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('the Plugin Manager did not persist the disable')
      if (orcRows(dumpConfig()).length !== 0) fail('the Plugin Manager disable left ORC rows in the composed profile')
      assertDefaultsUnchanged('Plugin Manager disable', snapshot(), baseline)

      assertApplied('Plugin Manager setBundleEnabled(true)', await manager.setBundleEnabled(PACKAGE_NAME, true))
      if (applied.ctx.get('orc') === undefined) fail('re-enabling through the Plugin Manager did not mount the ORC service')
      if (liveOrcRows(applied.ctx).length !== BUNDLE_ROWS.length) fail('re-enabling through the Plugin Manager did not remount every ORC row')
      if (!selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('the Plugin Manager did not persist the enable')
      if (orcRows(dumpConfig()).length !== BUNDLE_ROWS.length) fail('the Plugin Manager enable left ORC rows out of the composed profile')
      assertDefaultsUnchanged('Plugin Manager enable', snapshot(), baseline)

      // The service's own guards, which a file-level mirror cannot reach.
      assertRefused('setBundleEnabled on a package with no bundle patch', await manager.setBundleEnabled('zod', true), 'not-bundle')
      assertRefused('setBundleEnabled on a manager-owned bundle', await manager.setBundleEnabled('@deepseek-ai/dsh-base', false), 'management-required')
      if (!selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('a refused Plugin Manager operation changed the selection')
    } finally {
      await applied.shutdown.shutdown(0)
    }

    step('verifying the Plugin Manager restart requirement and a controlled profile restart')
    const noHmr = join(ownedDir, 'no-hmr.patch.yml')
    writeFileSync(noHmr, [
      '# The smoke overlay removes the live-reload row, so the Plugin Manager must',
      '# report its restart requirement instead of applying the change in place.',
      '- id: hmr',
      '  disabled: true',
      '',
    ].join('\n'))
    const restarting = await bootProfile([noHmr])
    try {
      if (restarting.ctx.get('hmr') !== undefined) fail('the no-HMR overlay did not remove the hmr service')
      const manager = managerOf(restarting.ctx, 'the no-HMR boot')
      const required = await manager.setBundleEnabled(PACKAGE_NAME, false)
      if (required.application !== 'restart-required') {
        fail(`disabling without live reload reported ${required.application}, not restart-required`)
      }
      if (required.changed !== true) fail(`the restart-required disable reported changed=${String(required.changed)}`)
      if (selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('the restart-required disable was not persisted')
    } finally {
      await restarting.shutdown.shutdown(0)
    }

    const restarted = await bootProfile([])
    try {
      if (restarted.ctx.get('orc') !== undefined) fail('the controlled restart still mounted the disabled ORC service')
      if (liveOrcRows(restarted.ctx).length !== 0) fail('the controlled restart still mounted the disabled ORC rows')
      const manager = managerOf(restarted.ctx, 'the restarted profile')
      assertApplied('Plugin Manager setBundleEnabled(true) after the restart', await manager.setBundleEnabled(PACKAGE_NAME, true))
      if (restarted.ctx.get('orc') === undefined) fail('re-enabling after the restart did not mount the ORC service')
      if (liveOrcRows(restarted.ctx).length !== BUNDLE_ROWS.length) fail('re-enabling after the restart did not remount every ORC row')
      if (!selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('re-enabling after the restart was not persisted')
      assertDefaultsUnchanged('the booted profile', snapshot(), baseline)
    } finally {
      await restarted.shutdown.shutdown(0)
    }
  } finally {
    restoreBanner()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  return baseline
}

/** Remove the ORC layer from one composed profile dump. */
function withoutOrcLayer(dump) {
  const lines = dump.split('\n')
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('# == ')) skipping = line.trim() === `# == ${PACKAGE_NAME}`
    if (!skipping) kept.push(line)
  }
  // The ORC layer is the last layer, so removing it also removes the trailing
  // newline the dump ended with; compare on content, not trailing whitespace.
  return kept.join('\n').trimEnd()
}

/** The ORC rows present in one composed profile dump. */
function orcRows(dump) {
  return BUNDLE_ROWS.filter(row => new RegExp(`^- id: ${row}$`, 'm').test(dump))
}

/** Compare one action's composed profile against the pre-install snapshot. */
function assertDefaultsUnchanged(label, snapshot, before) {
  for (const key of ['patchLayer', 'credentials', 'otherRows']) {
    if (snapshot[key] !== before[key]) fail(`${label} changed the profile's ${key}; the bundle must not touch it`)
  }
}

/** A keyless fake deployment that drives the installed service. */
function fakeDeployment(serviceModule, workflowModule, journalModule, reports) {
  const { initialState, reduce } = workflowModule
  const { hasStartRisk, orcEventName } = journalModule
  const events = []
  const states = new Map()
  const risks = new Map()
  const decisions = new Map()

  const fold = () => {
    states.clear()
    risks.clear()
    decisions.clear()
    for (const record of events) {
      const runId = record.data.runId
      if (record.type === 'orc/route') {
        decisions.set(runId, [...(decisions.get(runId) ?? []), record.data.decision])
        continue
      }
      // A refused report is an observation, not a lifecycle transition: the real
      // projection folds it to the same state, so this fold skips it too.
      if (record.type === 'orc/report-rejected') continue
      if (hasStartRisk(record.data)) risks.set(runId, record.data.risk)
      states.set(runId, reduce(states.get(runId) ?? initialState(), record.data))
    }
  }

  const journal = {
    events,
    state: (session) => states.get(String(session.id)) ?? initialState(),
    risk: (session) => risks.get(String(session.id)) ?? null,
    decisions: (session) => decisions.get(String(session.id)) ?? [],
    commit: async (session, record) => {
      const name = record.type === 'orc/route' ? 'orc/route' : orcEventName(record)
      session.append(name, record)
      events.push({ type: name, data: record })
      fold()
    },
  }

  const providerRoute = { kind: 'provider', provider: 'deepseek', model: 'deepseek-v4.1-flash', effort: 'high' }
  const planRoute = { kind: 'provider', provider: 'custom', model: 'm1', effort: 'high' }
  const codexRoute = { kind: 'cli', cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' }
  const claudeRoute = { kind: 'cli', cli: 'claude', model: 'claude-opus-4-1', effort: 'high' }
  const config = {
    sessionMode: 'adaptive',
    codeRoute: undefined,
    // Manual routing keeps the analysis stages deterministic: spec/plan use the
    // provider route (whose canned answer is never parsed as a report) and the
    // CLI stages pop the recorded review/audit reports in order.
    analysisMode: 'manual',
    manual: { spec: planRoute, plan: planRoute, review: codexRoute, audit: claudeRoute },
    allowed: [planRoute, codexRoute, claudeRoute],
    cliPaths: {},
    catalogMaxAgeDays: 7,
  }
  const key = route => route.kind === 'provider'
    ? `provider:${route.provider}:${route.model}:${route.effort}`
    : `cli:${route.cli}:${route.model}:${route.effort}`
  const benchmarks = {
    id: 'benchmarks-smoke',
    suiteRevision: SUITE_REVISION,
    records: [
      {
        id: 'codex-high', suiteRevision: SUITE_REVISION, backend: 'codex', model: 'gpt-5.2-codex', effort: 'high',
        backendVersion: '0.156.1', date: '2026-09-20T00:00:00Z', scope: ['financial', 'security'],
        detectionScore: 0.9, falsePositiveScore: 0.1, latencyMs: 1200, costUsd: 0.5,
      },
      {
        id: 'claude-high', suiteRevision: SUITE_REVISION, backend: 'claude', model: 'claude-opus-4-1', effort: 'high',
        backendVersion: '2.1.280', date: '2026-09-21T00:00:00Z', scope: ['financial', 'security'],
        detectionScore: 0.92, falsePositiveScore: 0.08, latencyMs: 1500, costUsd: 0.6,
      },
    ],
  }
  const catalog = {
    id: 'catalog-smoke',
    observedAt: NOW,
    entries: [
      { routeKey: key(providerRoute), backendVersion: '', model: providerRoute.model, efforts: [providerRoute.effort], accountAccess: false, sourceUrl: '', retrievedAt: NOW },
      { routeKey: key(planRoute), backendVersion: '', model: planRoute.model, efforts: [planRoute.effort], accountAccess: false, sourceUrl: '', retrievedAt: NOW },
      { routeKey: key(codexRoute), backendVersion: '0.156.1', model: codexRoute.model, efforts: [codexRoute.effort], accountAccess: true, sourceUrl: '', retrievedAt: NOW },
      { routeKey: key(claudeRoute), backendVersion: '2.1.280', model: claudeRoute.model, efforts: [claudeRoute.effort], accountAccess: true, sourceUrl: '', retrievedAt: NOW },
    ],
  }

  const live = new Map()
  const supervisorSession = Session.create(SessionId('session-supervisor'), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-supervisor'),
    createdAt: 0,
    isSeeded: false,
  })
  const fakeAgent = (id, options) => ({
    id: SessionId(id),
    session: id === 'session-supervisor'
      ? supervisorSession
      : Session.create(SessionId(id), undefined, { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, parentSession: SessionId('session-supervisor') }),
    options,
    ctx: {
      agents: { get: (sessionId) => live.get(String(sessionId)) },
      // The profile this harness boots composes the standard preset, which
      // registers `ask_user_question`; ORC probes the parent's registry before
      // it denies the tool to a child, so the fake parent states the same
      // registry the real one would.
      tools: { get: (name) => name === 'ask_user_question' ? { name } : undefined },
    },
  })
  const supervisor = fakeAgent('session-supervisor', { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  live.set('session-supervisor', supervisor)

  const capabilities = { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true }
  let counter = 0
  const subagents = {
    getProvider: (name) => name === 'spawn' ? { capabilities, prepareContinuable: () => ({}) } : undefined,
    startContinuable: async (spec) => {
      if (spec.signal.aborted) throw spec.signal.reason instanceof Error ? spec.signal.reason : new Error('aborted')
      counter += 1
      const childId = String(spec.childId ?? `child-${counter}`)
      const child = fakeAgent(childId, spec.request.agentOptions ?? {})
      live.set(childId, child)
      return { childId: SessionId(childId), messageId: `message-${childId}` }
    },
  }

  const settings = {
    config: () => config,
    connectionRevision: () => 'rev-smoke',
    subscribe: () => () => {},
    dispose: () => {},
  }

  const providers = {
    catalog: async (provider) => ({
      id: `${provider}@${NOW}`,
      observedAt: NOW,
      entries: catalog.entries.filter(entry => entry.routeKey.startsWith(`provider:${provider}:`)),
    }),
    test: async (route, revision) => ({ routeKey: key(route), configRevision: revision, testedAt: NOW, ok: true }),
    // spec/plan run on the provider route; their answer is never parsed as a
    // report, so it is a constant keyless string.
    run: async () => 'stage output',
  }

  const clis = {
    catalog: async (cli, routes) => ({
      id: `${cli}@${NOW}`,
      observedAt: NOW,
      entries: routes.map(route => ({
        routeKey: key(route),
        backendVersion: route.cli === 'codex' ? '0.156.1' : '2.1.280',
        model: route.model,
        efforts: [route.effort],
        accountAccess: true,
        sourceUrl: '',
        retrievedAt: NOW,
      })),
    }),
    probe: async (route, path) => ({
      routeKey: key(route),
      cli: route.cli,
      executable: path ?? `/usr/local/bin/${route.cli}`,
      version: route.cli === 'codex' ? '0.156.1' : '2.1.280',
      auth: { method: 'test', accountFingerprint: '' },
      model: route.model,
      effort: route.effort,
      revision: `${key(route)}@smoke`,
      testedAt: NOW,
    }),
    run: async () => JSON.stringify(reports.shift() ?? 'stage output'),
  }

  const service = new serviceModule.OrcService({
    journal,
    settings,
    benchmarks,
    providers,
    clis,
    subagents,
    agents: { get: (sessionId) => live.get(String(sessionId)) },
    cwd: ROOT,
    now: () => NOW,
  })
  return { service, supervisor }
}

/** Drive spec -> plan -> lead/peer -> review -> audit -> final gates -> complete. */
async function driveWorkflow(serviceModule, workflowModule, journalModule) {
  const mediumReport = {
    status: 'findings',
    findings: [{ id: 'F-1', severity: 'medium', file: 'src/pay.ts', line: 12, evidence: 'double credit', remediation: 'settle once' }],
  }
  const cleanReport = { status: 'clean', findings: [] }
  // Five routed dispatches: the blocking review, the re-review, the task audit,
  // and then the final branch review and audit, which ORC routes and dispatches
  // itself rather than accepting a report from its caller.
  const reports = [mediumReport, cleanReport, cleanReport, cleanReport, cleanReport]
  const { service, supervisor } = fakeDeployment(serviceModule, workflowModule, journalModule, reports)
  const signal = new AbortController().signal
  const high = { path: 'orc', risk: 'high', reasons: ['high-impact'] }

  await service.start(supervisor, high)
  await service.dispatch(supervisor, 'spec', 'spec input', signal)
  await service.dispatch(supervisor, 'plan', 'plan input', signal)
  const lead = await service.createLead(supervisor)
  const peer = await service.createPeer(lead, 'peer-1')
  await service.startTask(lead, peer, 'task-1')
  await service.settleTask(peer, 'task-1')
  await service.dispatch(supervisor, 'review', 'review task-1', signal)

  let blocked = false
  try {
    await service.complete(supervisor)
  } catch (error) {
    blocked = /blocking/.test(String(error?.message ?? error))
  }
  if (!blocked) fail('a medium finding did not block completion; the review gate is not enforced')

  await service.fix(lead, 'F-1')
  await service.dispatch(supervisor, 'review', 'review task-1 again', signal)
  await service.dispatch(supervisor, 'audit', 'audit task-1', signal)
  await service.finalBranchReview(supervisor, 'final branch review', signal)
  await service.finalBranchAudit(supervisor, 'final branch audit', signal)
  const completed = await service.complete(supervisor)
  if (completed.phase !== 'completed') fail(`the workflow did not complete: phase is ${completed.phase}`)
  return completed
}

async function main() {
  const version = requestedVersion()

  if (!existsSync(DSH_BIN)) fail(`the DSH CLI is not installed at ${DSH_BIN}; run npm ci first`)
  const cliVersion = execFileSync(DSH_BIN, ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (cliVersion !== version) {
    fail(`the installed DSH CLI reports ${cliVersion}, not the requested ${version}`)
  }

  const owned = mkdtempSync(join(tmpdir(), 'orc-profile-'))
  try {
    const env = { ...process.env, DSH_HOME: join(owned, 'home'), npm_config_cache: join(owned, 'npm-cache') }
    const home = env.DSH_HOME
    const profileDir = join(home, 'profiles', 'web')
    const packageDir = join(owned, 'package')
    const npmEnv = { ...process.env, npm_config_cache: env.npm_config_cache }

    const dumpConfig = () => execFileSync(DSH_BIN, ['--profile', 'web', '--dump-config'], { cwd: ROOT, env, encoding: 'utf8' })

    step(`packing ${PACKAGE_NAME}`)
    mkdirSync(packageDir, { recursive: true })
    const packed = JSON.parse(execFileSync('npm', ['pack', '--pack-destination', packageDir, '--json'], {
      cwd: ROOT, encoding: 'utf8', env: npmEnv,
    }))
    const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
    if (entry === undefined) fail('npm pack reported no package')
    const tarball = join(packageDir, entry.filename)

    step(`initializing a disposable Web profile at ${home}`)
    dumpConfig()

    // Seed the DSH-owned configuration the bundle must never modify: the user
    // patch layer carries the global model default, and the credentials file is
    // a valid empty document (no real credential). The credentials file must be
    // owner-only: a booted profile refuses a store readable beyond its owner.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# user layer: global model default and standard preset override',
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '',
    ].join('\n'))
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n', { mode: 0o600 })

    const snapshot = () => ({
      patchLayer: readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'),
      credentials: readFileSync(join(home, '.credentials.yaml'), 'utf8'),
      otherRows: withoutOrcLayer(dumpConfig()),
    })
    const before = snapshot()

    step(`installing the tarball through dsh plugin --profile web add`)
    execFileSync(DSH_BIN, ['plugin', '--profile', 'web', 'add', `file:${tarball}`], { cwd: ROOT, env, stdio: 'pipe' })

    const installedDir = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'))
    if (!existsSync(installedDir)) fail(`the install did not create ${installedDir}`)
    for (const file of ['package.json', 'cordis.patch.yml', 'lib/host/index.js', 'lib/client.js', 'lib/client/locales.js', 'README.md']) {
      if (!existsSync(join(installedDir, file))) fail(`the installed archive is missing ${file}`)
    }
    const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
    if (installedManifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('the installed bundle declares no cordis.patch.yml')
    const installedPatch = readFileSync(join(installedDir, 'cordis.patch.yml'), 'utf8')
    for (const row of BUNDLE_ROWS) {
      if (!installedPatch.includes(`id: ${row}`)) fail(`the installed patch is missing the ${row} row`)
    }
    if (!selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('the install did not select the bundle layer')

    // The fixture manifest ships with the bundle; the real high-risk evidence is
    // produced separately by scripts/benchmark.mjs.
    const benchmarkManifest = JSON.parse(readFileSync(join(installedDir, 'benchmarks', 'manifest.json'), 'utf8'))
    if (benchmarkManifest.suiteRevision !== SUITE_REVISION || !Array.isArray(benchmarkManifest.fixtures)) {
      fail('the installed benchmark fixture manifest is malformed')
    }
    const scopes = new Set(benchmarkManifest.fixtures.map(fixture => fixture.scope))
    if (!scopes.has('financial') || !scopes.has('security')) {
      fail('the installed benchmark fixture manifest does not cover financial and security risk')
    }

    // The disposable profile links the harness's own DSH packages so the
    // installed bundle's declared peers resolve without a second DSH install.
    const profileModules = join(profileDir, 'node_modules')
    for (const [name, target] of [
      ['@deepseek-ai', join(ROOT, 'node_modules', '@deepseek-ai')],
      ['zod', join(ROOT, 'node_modules', 'zod')],
    ]) {
      const link = join(profileModules, name)
      if (!existsSync(link)) symlinkSync(target, link, 'dir')
    }

    step('verifying activation in the composed profile')
    const enabledDump = dumpConfig()
    const enabledRows = orcRows(enabledDump)
    if (enabledRows.length !== BUNDLE_ROWS.length) fail(`activation composed ${enabledRows.length} of ${BUNDLE_ROWS.length} ORC rows`)
    assertDefaultsUnchanged('install', snapshot(), before)

    // The real enable/disable/restart surface: the Plugin Manager service inside
    // a booted profile. Every persisted-selection assertion below is the
    // service's own write, never a hand-edit of `dsh.profile.bundles`. The
    // returned baseline is the post-first-boot DSH-owned configuration.
    const booted = await exercisePluginManager({ ownedDir: owned, home, profileDir, dumpConfig, snapshot })

    step('driving the complete ORC workflow through the installed service')
    const require = createRequire(join(installedDir, 'package.json'))
    const serviceModule = require(join(installedDir, 'lib', 'host', 'service.js'))
    const workflowModule = require(join(installedDir, 'lib', 'domain', 'workflow.js'))
    const journalModule = require(join(installedDir, 'lib', 'host', 'journal.js'))
    const completed = await driveWorkflow(serviceModule, workflowModule, journalModule)
    step(`workflow completed at phase ${completed.phase}`)

    step('removing the bundle')
    // The bundle is selected here on purpose: `dsh plugin remove` runs pnpm and
    // then reconciles the selection itself (a removed dependency whose bundle
    // metadata is gone is dropped from `dsh.profile.bundles`). Clearing the
    // selection first would satisfy the assertion below by hand and hide exactly
    // the behaviour it claims to check. The precondition is asserted so a later
    // refactor cannot quietly make the check vacuous again.
    if (!selectedBundles(profileDir).includes(PACKAGE_NAME)) {
      fail('the bundle was not selected before removal; the reconciliation assertion would be vacuous')
    }
    execFileSync(DSH_BIN, ['plugin', '--profile', 'web', 'remove', PACKAGE_NAME], { cwd: ROOT, env, stdio: 'pipe' })
    const removedManifest = readManifest(profileDir)
    if (removedManifest.dependencies?.[PACKAGE_NAME] !== undefined) fail('removal left the bundle dependency in the profile')
    if (selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('removal left the bundle selected')
    if (orcRows(dumpConfig()).length !== 0) fail('removal left ORC rows in the composed profile')
    assertDefaultsUnchanged('remove', snapshot(), booted)

    step(`PASS: ${PACKAGE_NAME} on DSH ${version} (install, Plugin Manager enable/disable/restart, remove, full workflow)`)
  } finally {
    rmSync(owned, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  if (!(error instanceof SmokeRefusal)) throw error
  process.stderr.write(`clean-profile-smoke: ${error.message}\n`)
  process.exitCode = 1
}
