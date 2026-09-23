/**
 * ORC browser composition entry.
 *
 * `scripts/build.mjs` bundles this module into DSH's lazy-CJS client artifact
 * (`lib/client.js`), which registers one `window.__ModuleLoader__` factory
 * under the package name. Enabling the ORC bundle materializes this module and
 * runs {@link apply}; disabling it unloads the fiber, which disposes every
 * contribution registered here.
 *
 * The plugin owns exactly three browser contributions and nothing else:
 *
 * - the `settings.orc` dictionaries, registered inside a Cordis effect;
 * - the `orc` settings scope, bound on this plugin's lifecycle so its writes
 *   are revision-fenced by the settings transport;
 * - one `settings.section` entry (`id: 'orc'`, order 30) whose component is
 *   {@link OrcSettingsPage}.
 *
 * It never registers a Models Settings surface, writes another namespace, or
 * requests provider credentials.
 *
 * The remote face is supplied through {@link OrcClientMountOptions.remote}
 * rather than resolved from `ctx.remote`: the DSH-owned client assembly mounts
 * a fixed build-time `/remote` import list and discovers nothing at runtime, so
 * a clean Web profile exposes no `ctx.remote.orc`. Declaring a resolution path
 * for a service that cannot exist would be a false claim; the optional mount
 * option lets a future DSH client mount path (or the bundle's own client
 * composition) supply the real face, and the page degrades to an explicit
 * "unavailable" state until one does.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OrcConfig } from '../domain/types.js'
import { OrcSettingsPage, type OrcRemotePort } from './OrcSettingsPage.js'
import { en, ORC_LOCALE_NS, zh } from './locales.js'

/** Optional faces a mount path may supply to the client plugin. */
export interface OrcClientMountOptions {
  /**
   * The ORC remote face the settings page reads. Absent in a clean Web
   * profile, where the DSH client assembly mounts no `orc` Remote namespace.
   */
  remote?: OrcRemotePort
}

/**
 * Services this browser plugin reads.
 *
 * The Cordis declaration, not the informational `dsh.client.inject` manifest
 * field: without it the fiber reaches no service and the dynamic-package
 * facade rejects the access outright. `remote` is deliberately absent —
 * `ctx.remote.orc` cannot exist in a clean Web profile, so the page takes its
 * remote face through {@link OrcClientMountOptions} instead.
 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount every browser-side ORC contribution.
 *
 * @param ctx - the client plugin context; its fiber owns every disposer.
 * @param options - optional faces supplied by the mount path.
 */
export function apply(ctx: Context, options: OrcClientMountOptions = {}): void {
  ctx.effect(() => ctx.locale.register(ORC_LOCALE_NS, { en, zh }), 'orc.dictionaries')

  const t = ctx.locale.bind(ORC_LOCALE_NS)
  const scope: SettingsScope<OrcConfig> = ctx.settingsScope.bind<OrcConfig>({ namespace: 'orc' })
  const remote = options.remote

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'orc',
    order: 30,
    label: () => t('title'),
    locale: ORC_LOCALE_NS,
    inject: () => ({ scope, remote, locale: ctx.locale.getSnapshot().active }),
  }, OrcSettingsPage))
}

/** The DSH client entry, re-exported under its composition name. */
export const applyClient = apply
