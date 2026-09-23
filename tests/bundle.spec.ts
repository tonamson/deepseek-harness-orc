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
