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
 * 5. exercises enable/disable/remove and recomposes the profile with
 *    `dsh --profile web --dump-config` after each action, comparing the
 *    standard preset, global model defaults, provider credentials, and the
 *    unrelated rows byte-for-byte;
 * 6. drives the complete ORC workflow through the installed service with fake
 *    provider/CLI inputs and keyless recorded reports;
 * 7. removes only the directory it created, in a `finally` block.
 *
 * The profile is composed by the real DSH CLI; the run never boots a Web server
 * and never calls a model provider. It fails loudly with an actionable message
 * when the CLI, the packed archive, or the install path is unavailable — it
 * never reports success for a step it could not run.
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
const PACKAGE_NAME = '@tonamson/dsh-orc'
/** The one DSH version this release supports (R15: no range). */
const SUPPORTED = '0.1.6-alpha.2'
/** The two Loader rows the bundle patch declares. */
const BUNDLE_ROWS = ['orc-host', 'orc-remote-host']
/** The fixed instant every keyless fixture record uses. */
const NOW = '2026-09-23T00:00:00Z'
/** The benchmark suite revision the shipped fixture manifest records. */
const SUITE_REVISION = 'orc-review-v1'

const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')

function fail(message) {
  process.stderr.write(`clean-profile-smoke: ${message}\n`)
  process.exit(1)
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

function writeManifest(profileDir, manifest) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Every profile bundle name currently selected. */
function selectedBundles(profileDir) {
  return readManifest(profileDir).dsh?.profile?.bundles ?? []
}

/**
 * Persist one bundle's enablement, the field the Plugin Manager writes.
 *
 * The Plugin Manager service is only reachable inside a booted profile, and
 * this smoke run must not start a server, so enable/disable persist the same
 * `dsh.profile.bundles` selection its `selectBundle` writes. Installation and
 * removal still go through the real `dsh plugin` command.
 */
function selectBundle(profileDir, name, enabled) {
  const manifest = readManifest(profileDir)
  const previous = manifest.dsh?.profile?.bundles ?? []
  const bundles = enabled
    ? [...new Set([...previous, name])]
    : previous.filter(bundle => bundle !== name)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  writeManifest(profileDir, manifest)
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
    ctx: { agents: { get: (sessionId) => live.get(String(sessionId)) } },
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
  const reports = [mediumReport, cleanReport, cleanReport]
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
  await service.finalBranchReview(supervisor, cleanReport)
  await service.finalBranchAudit(supervisor, cleanReport)
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
    // a valid empty document (no real credential).
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# user layer: global model default and standard preset override',
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '',
    ].join('\n'))
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n')

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

    step('disabling the bundle')
    selectBundle(profileDir, PACKAGE_NAME, false)
    const disabledDump = dumpConfig()
    if (orcRows(disabledDump).length !== 0) fail('disabling left ORC rows in the composed profile')
    assertDefaultsUnchanged('disable', snapshot(), before)

    step('re-enabling the bundle')
    selectBundle(profileDir, PACKAGE_NAME, true)
    if (orcRows(dumpConfig()).length !== BUNDLE_ROWS.length) fail('re-enabling did not restore the ORC rows')
    assertDefaultsUnchanged('enable', snapshot(), before)

    step('driving the complete ORC workflow through the installed service')
    const require = createRequire(join(installedDir, 'package.json'))
    const serviceModule = require(join(installedDir, 'lib', 'host', 'service.js'))
    const workflowModule = require(join(installedDir, 'lib', 'domain', 'workflow.js'))
    const journalModule = require(join(installedDir, 'lib', 'host', 'journal.js'))
    const completed = await driveWorkflow(serviceModule, workflowModule, journalModule)
    step(`workflow completed at phase ${completed.phase}`)

    step('removing the bundle')
    selectBundle(profileDir, PACKAGE_NAME, false)
    execFileSync(DSH_BIN, ['plugin', '--profile', 'web', 'remove', PACKAGE_NAME], { cwd: ROOT, env, stdio: 'pipe' })
    const removedManifest = readManifest(profileDir)
    if (removedManifest.dependencies?.[PACKAGE_NAME] !== undefined) fail('removal left the bundle dependency in the profile')
    if (selectedBundles(profileDir).includes(PACKAGE_NAME)) fail('removal left the bundle selected')
    if (orcRows(dumpConfig()).length !== 0) fail('removal left ORC rows in the composed profile')
    assertDefaultsUnchanged('remove', snapshot(), before)

    step(`PASS: ${PACKAGE_NAME} on DSH ${version} (install, enable, disable, remove, full workflow)`)
  } finally {
    rmSync(owned, { recursive: true, force: true })
  }
}

await main()
