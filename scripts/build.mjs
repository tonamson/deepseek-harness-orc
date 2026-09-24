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
  id: '@tonamson2/dsh-orc',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    ${cjs}
    return module.exports
  }
});`)
