/**
 * Compatibility pinning for the packed ORC bundle.
 *
 * Task 1 established that the settings extension points this bundle's design
 * requires — `ctx.settings.installSection` and `ctx.settingsScope` — exist only
 * in DSH `0.1.6-alpha.2`; `0.1.7-alpha.2` replaced them with
 * `SettingsForms`/`ConfigForms`. Controller ruling **R15** therefore narrowed
 * the published support set to that single version, and this spec pins it: the
 * declared peers, the installed packages, the CI matrix, and the extension
 * contracts the bundle depends on.
 *
 * The declarations are read from the installed `node_modules`, so a DSH upgrade
 * that removes or reshapes one of these names fails here before it can ship.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './profile-harness.js'

/** The one DSH version this release supports. */
const SUPPORTED = '0.1.6-alpha.2'

/** The DSH line that is explicitly NOT supported. */
const UNSUPPORTED = '0.1.7-alpha.2'

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const compatibility = readFileSync(join(REPO_ROOT, 'docs', 'compatibility.md'), 'utf8')

/** Read one installed package's declaration file. */
function declaration(packageName: string, path: string): string {
  return readFileSync(join(REPO_ROOT, 'node_modules', ...packageName.split('/'), 'lib', 'types', path), 'utf8')
}

/** The version of one installed package. */
function installedVersion(packageName: string): string {
  const raw = readFileSync(join(REPO_ROOT, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')
  return JSON.parse(raw).version
}

describe('supported DSH version set', () => {
  it('pins exactly one DSH version, not a range', () => {
    const dshPeers = Object.entries(manifest.peerDependencies as Record<string, string>)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) expect(range, name).toBe(SUPPORTED)
    // No caret, tilde, range, or OR anywhere in the DSH support set.
    expect(JSON.stringify(dshPeers)).not.toMatch(/[\^~]|\|\|| - /)
  })

  it('installs exactly the supported DSH line', () => {
    expect(installedVersion('@deepseek-ai/dsh')).toBe(SUPPORTED)
    for (const name of [
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-client-ui-settings',
    ]) {
      expect(installedVersion(name), name).toBe(SUPPORTED)
    }
  })

  it('runs the CI matrix over exactly the supported set', () => {
    const matrix = [...workflow.matchAll(/dsh-version:\s*\[([^\]]*)\]/g)]
      .flatMap(match => match[1]!.split(',').map(value => value.trim().replace(/['"]/g, '')))
      .filter(value => value.length > 0)
    expect(matrix).toEqual([SUPPORTED])
    expect(workflow).not.toMatch(/dsh-version:.*0\.1\.7/)
    // The smoke harness runs once per matrix version, with the exact version.
    expect(workflow).toContain('node scripts/clean-profile-smoke.mjs "${{ matrix.dsh-version }}"')
  })

  it('provisions a pinned pnpm before the smoke step', () => {
    // `dsh plugin` forwards to pnpm, so the release gate must not depend on
    // whatever pnpm the runner image happens to provide.
    const pnpm = /PNPM_VERSION:\s*"([^"]+)"/.exec(workflow)
    expect(pnpm?.[1]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(workflow).toContain('uses: pnpm/action-setup@v4')
    expect(workflow).toContain('version: ${{ env.PNPM_VERSION }}')
    // Provisioning precedes the smoke step that needs it.
    expect(workflow.indexOf('pnpm/action-setup')).toBeLessThan(workflow.indexOf('clean-profile-smoke.mjs'))
  })

  it('records the narrowing and why in the compatibility contract', () => {
    expect(compatibility).toContain(SUPPORTED)
    expect(compatibility).toContain(UNSUPPORTED)
    expect(compatibility).toMatch(/NOT supported/i)
    expect(compatibility).toMatch(/installSection/)
    expect(compatibility).toMatch(/settingsScope/)
  })

  it('keeps the release private until an explicit publish instruction', () => {
    expect(manifest.private).toBe(true)
  })
})

describe('extension contracts the bundle depends on', () => {
  it('reads the settings section seam', () => {
    const settings = declaration('@deepseek-ai/dsh-settings', 'index.d.ts')
    expect(settings).toContain('installSection<const Namespace extends string, T>(owner: Context, ns: Namespace & SettingsNamespaceInput<Namespace>, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void')
    expect(settings).toContain('abstract class SettingsProvider extends Service')
  })

  it('reads the browser settings scope seam', () => {
    const scope = declaration('@deepseek-ai/dsh-client-ui-settings', 'client/settings-scope.d.ts')
    expect(scope).toContain('settingsScope: SettingsScopeBinder')
    expect(scope).toContain('bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>')
  })

  it('reads the settings section client slot', () => {
    const slots = declaration('@deepseek-ai/dsh-client-ui-settings', 'client/contract/slots.d.ts')
    expect(slots).toContain("'settings.section'")
    expect(slots).toContain('SettingsSectionOwnerProps')
  })

  it('reads the tool, prompt, provider, subagent, and subprocess seams', () => {
    expect(declaration('@deepseek-ai/dsh-tools', 'schema.d.ts')).toContain('export declare function defineTool')
    expect(declaration('@deepseek-ai/dsh-system-prompt', 'index.d.ts')).toContain('section(section: PromptSection): () => void')
    expect(declaration('@deepseek-ai/dsh-llm', 'index.d.ts')).toContain('stream(options: GenerateOptions): AsyncIterable<StreamChunk>')
    expect(declaration('@deepseek-ai/dsh-subagent', 'index.d.ts')).toContain('startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>')
    expect(declaration('@deepseek-ai/dsh-subprocess', 'index.d.ts')).toContain('spawn(spec: SubprocessSpawnSpec): SubprocessHandle')
  })

  it('reads the child tool filter and the steer seam the question channel depends on', () => {
    // The tool filter is the hard guarantee that no ORC child can ask the human;
    // `sendMessage` is the whole delivery path back to a peer that raised one.
    const types = declaration('@deepseek-ai/dsh-subagent', 'types.d.ts')
    expect(types).toContain('readonly toolFilter: boolean;')
    expect(types).toContain('readonly toolFilter?: ToolRestriction;')
    expect(declaration('@deepseek-ai/dsh-subagent', 'index.d.ts'))
      .toContain('sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>')
  })

  it('reads the Typert remote seams the Remote host row uses', () => {
    const typert = declaration('@deepseek-ai/dsh-typert-protocol', 'index.d.ts')
    expect(typert).toContain('export declare abstract class TypertRemoteService')
    expect(typert).toContain('export declare function Remote')
  })

  it('reads the profile-boot entry the smoke harness boots the Web profile through', () => {
    // `scripts/clean-profile-smoke.mjs` reaches the real Plugin Manager
    // enable/disable operations by booting the disposable profile through this
    // public entry; a DSH upgrade that drops or reshapes it must fail here.
    const dsh = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    expect(dsh.exports['./profile-boot']).toEqual({
      types: './lib/types/profile-boot.d.ts',
      default: './lib/profile-boot.js',
    })
    const boot = declaration('@deepseek-ai/dsh', 'profile-boot.d.ts')
    expect(boot).toContain('export declare function runProfile(options: RunProfileOptions)')
    expect(boot).toContain('profile: string;')
    expect(boot).toContain('patchFiles: readonly string[];')
    expect(boot).toContain('args: readonly string[];')
    expect(declaration('@deepseek-ai/dsh-launch-environment', 'index.d.ts'))
      .toContain('export declare function createLaunchEnvironmentSnapshot')
  })

  it('declares no generated ./typert or ./remote artifact', () => {
    // The published generator cannot build these for an external package, and
    // the loader fails loud on a declared-but-broken artifact.
    expect(manifest.exports['./typert']).toBeUndefined()
    expect(manifest.exports['./remote']).toBeUndefined()
  })
})
