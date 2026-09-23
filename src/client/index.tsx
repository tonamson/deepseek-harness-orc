/**
 * ORC browser composition entry.
 *
 * `scripts/build.mjs` bundles this module into DSH's lazy-CJS client artifact
 * (`lib/client.js`), which registers one `window.__ModuleLoader__` factory
 * under the package name. Enabling the ORC bundle materializes this module and
 * runs {@link apply}; disabling it unloads the fiber, which disposes every
 * contribution registered here.
 *
 * The plugin owns exactly four browser contributions and nothing else:
 *
 * - the `settings.orc` dictionaries, registered inside a Cordis effect;
 * - the `orc` settings scope, bound on this plugin's lifecycle so its writes
 *   are revision-fenced by the settings transport;
 * - one `settings.section` entry (`id: 'orc'`, order 30) whose component is
 *   {@link OrcSettingsPage};
 * - the ORC Remote contribution, mounted through the public
 *   `ctx.remote.$mount(...)` inside an injected child fiber.
 *
 * It never registers a Models Settings surface, writes another namespace, or
 * requests provider credentials.
 *
 * The Remote mount is what makes the page able to read a catalog, probe a route
 * and show CLI health. DSH's Web client assembly value-imports a fixed
 * build-time `/remote` list and discovers nothing at runtime, so `ctx.remote.orc`
 * does not exist until this plugin mounts its own contribution. `remote` is
 * therefore an *optional* dependency: the settings page is registered
 * unconditionally, and a profile that mounts no Remote service gets the page's
 * explicit "unavailable" state plus its catalog-independent route entry.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { OrcConfig } from '../domain/types.js'
import { OrcSettingsPage, type OrcRemotePort } from './OrcSettingsPage.js'
import { en, ORC_LOCALE_NS, zh } from './locales.js'
import { createOrcRemoteBridge, ORC_REMOTE_CONTRIBUTION, type OrcRemoteNamespace } from './remote.js'

/** Optional faces a mount path may supply to the client plugin. */
export interface OrcClientMountOptions {
  /**
   * An explicitly supplied ORC remote face, used instead of mounting the
   * bundle's own contribution. A composition that already mounts the ORC
   * namespace (or a test) passes one; a clean Web profile does not.
   */
  remote?: OrcRemotePort
}

/**
 * Services this browser plugin reads.
 *
 * The Cordis declaration, not the informational `dsh.client.inject` manifest
 * field: without it the fiber reaches no service and the dynamic-package
 * facade rejects the access outright. `remote` is deliberately absent — it is
 * an optional dependency taken through `ctx.inject(['remote'], …)`, so a
 * profile without the Remote client still mounts the ORC settings page.
 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount every browser-side ORC contribution.
 *
 * @param ctx - the client plugin context; its fiber owns every disposer.
 * @param options - an explicitly supplied remote face, when the composition has one.
 */
export function apply(ctx: Context, options: OrcClientMountOptions = {}): void {
  ctx.effect(() => ctx.locale.register(ORC_LOCALE_NS, { en, zh }), 'orc.dictionaries')

  const t = ctx.locale.bind(ORC_LOCALE_NS)
  const scope: SettingsScope<OrcConfig> = ctx.settingsScope.bind<OrcConfig>({ namespace: 'orc' })

  // One identity-stable port: the page is registered before a mount can
  // resolve, so its calls await the mount instead of seeing a missing face.
  const bridge = createOrcRemoteBridge()
  const remote = options.remote ?? bridge.port

  /**
   * Mount the bundle's own contribution when this profile has a Remote face.
   *
   * `$mount` is the documented public API the DSH client assembly itself calls
   * for every namespace it selects. It registers its effects on the Remote
   * service's own fiber, so the disposer it returns is what unmounts the
   * contribution when this plugin unloads.
   */
  const mount = (remoteCtx: Context): Promise<void> => bridge.mount(async () => {
    const dispose = await remoteCtx.remote.$mount(ORC_REMOTE_CONTRIBUTION)
    const namespace: OrcRemoteNamespace | undefined = remoteCtx.remote.orc
    if (namespace === undefined) {
      await dispose()
      throw new Error('the mounted ORC remote namespace did not materialize')
    }
    return { namespace, dispose }
  })

  if (options.remote === undefined) {
    // `remote` is optional: the injected fiber runs as soon as the service
    // exists and is unloaded with this plugin, which unmounts the contribution.
    ctx.inject(['remote'], (remoteCtx) => {
      void mount(remoteCtx)
      return () => {
        void bridge.unmount()
      }
    })
  }

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
