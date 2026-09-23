/**
 * Archive contract for the packed ORC bundle.
 *
 * Task 10's release gate: `npm pack --json` must publish exactly one bundle
 * package whose archive carries every runtime, patch, client, localization, and
 * documentation file the bundle needs. The assertions read the real archive
 * (`npm pack` plus an extraction), not the source tree, so a file that is
 * missing from `files` — or a README that was never written — fails here rather
 * than at install time.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  extractBundle,
  packBundle,
  removeOwned,
  BUNDLE_ROWS,
  PACKAGE_NAME,
  REPO_ROOT,
  type PackedBundle,
} from './profile-harness.js'

/** The manifest this repository publishes. */
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
/** The lockfile that must carry no workspace-only dependency. */
const lockfile = readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')
/** The Loader patch the bundle declares. */
const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')

let packed: PackedBundle
let tree: string

beforeAll(() => {
  packed = packBundle()
  tree = join(packed.root, 'tree')
  extractBundle(packed.tarball, tree)
})

afterAll(() => {
  removeOwned(packed.root)
})

/** One archived path's exact bytes. */
function archived(path: string): string {
  return readFileSync(join(tree, path), 'utf8')
}

/** Whether the archive reported one path. */
function archivedPaths(): string[] {
  return packed.files.map(file => file.path)
}

describe('one-package DSH bundle archive', () => {
  it('packs exactly one package under the published name and version', () => {
    expect(packed.name).toBe(PACKAGE_NAME)
    expect(packed.version).toBe(manifest.version)
    expect(packed.filename).toBe(`tonamson-dsh-orc-${manifest.version}.tgz`)
  })

  it('declares one bundle patch and a Web client', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['./client']).toBeDefined()
    expect(manifest.exports['./remote-host']).toBeDefined()
  })

  it('carries the patch, Host JS, lazy-CJS Client JS, locale strings, and README', () => {
    const paths = archivedPaths()
    expect(paths).toContain('cordis.patch.yml')
    expect(paths).toContain('lib/host/index.js')
    expect(paths).toContain('lib/host/remote-host.js')
    expect(paths).toContain('lib/client.js')
    expect(paths).toContain('lib/client/locales.js')
    expect(paths).toContain('README.md')
    expect(paths).toContain('benchmarks/manifest.json')
    expect(paths).toContain('benchmarks/fixtures.json')
    expect(paths).toContain('package.json')

    // The archive extraction agrees: every asserted file is real content, and a
    // missing README cannot pass silently.
    for (const path of ['cordis.patch.yml', 'lib/host/index.js', 'lib/client.js', 'lib/client/locales.js', 'README.md']) {
      expect(existsSync(join(tree, path)), `missing archived ${path}`).toBe(true)
    }
  })

  it('ships the Host rows and only the Host rows', () => {
    expect(patch).toContain('id: orc-host')
    expect(patch).toContain('id: orc-remote-host')
    expect(patch).toContain(`name: '${PACKAGE_NAME}'`)
    expect(patch).toContain(`name: '${PACKAGE_NAME}/remote-host'`)
    for (const row of BUNDLE_ROWS) expect(archived('cordis.patch.yml')).toContain(`id: ${row}`)
    expect(archived('cordis.patch.yml')).not.toMatch(/id: (agent-default-model|standard-preset|llm-credentials)/)
  })

  it('registers a lazy-CJS client factory under the package name', () => {
    const client = archived('lib/client.js')
    expect(client.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(client).toContain(`id: '${PACKAGE_NAME}'`)
    expect(client).toContain('factory(require)')
    // The artifact materializes on demand; evaluating it must not run the module.
    expect(client).toContain('module.exports')
  })

  it('ships the ORC locale namespace and both dictionaries', () => {
    const locales = archived('lib/client/locales.js')
    expect(locales).toContain("'settings.orc'")
    expect(locales).toContain('ORC_LOCALE_NS')
  })

  it('publishes no workspace-only dependency anywhere in the manifest or lockfile', () => {
    // The manifest is asserted whole: stringifying only `dependencies` (which is
    // empty) would make the check vacuous.
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
    expect(lockfile).not.toContain('workspace:')
    expect(JSON.stringify(packed.files)).not.toContain('workspace:')
  })

  it('pins every runtime DSH peer to exactly the supported version', () => {
    const peers = manifest.peerDependencies ?? {}
    const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      expect(range, `${name} must be pinned exactly`).toBe('0.1.6-alpha.2')
    }
    expect(manifest.private).toBe(true)
  })
})
