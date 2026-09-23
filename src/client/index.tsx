import type { Context } from '@deepseek-ai/cordis'

/**
 * ORC browser composition entry.
 *
 * `scripts/build.mjs` bundles this module into DSH's lazy-CJS client artifact
 * (`lib/client.js`), which registers one `window.__ModuleLoader__` factory
 * under the package name. Task 1 keeps the plugin empty; Task 9 registers the
 * ORC settings section here.
 */
export function apply(_ctx: Context): void {}
