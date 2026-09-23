/**
 * ORC settings bridge.
 *
 * The bridge owns one ORC-only settings namespace (`orc`) and nothing else: it
 * never writes DSH Models Settings, a preset, or another plugin's namespace,
 * and it stores route references and policy rather than credentials.
 *
 * The settings provider owns the namespace registration; the bridge owns the
 * source thunk, the emitted revisions, and its observers. Its teardown is a
 * Cordis effect on the calling plugin's fiber, so unloading the plugin removes
 * the bridge, and the returned disposer removes it explicitly.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import { ConfigSchema, configRevision, connectionRevision, parseConfig } from '../domain/config.js'
import type { OrcConfig, Route } from '../domain/types.js'

/** Observer notified with the new config revision after a committed change. */
export type OrcSettingsListener = (revision: string) => void

/** Live view of the installed ORC settings section. */
export interface OrcSettingsBridge {
  /** Current resolved config: the settings scope while attached, else the base entry. */
  config(): OrcConfig
  /** Current revision of one exact route; a green connection test is tied to it. */
  connectionRevision(route: Route): string
  /** Observe committed changes; returns the unsubscribe disposer. */
  subscribe(listener: OrcSettingsListener): () => void
  /** Remove every observer. */
  dispose(): void
}

/**
 * The Cordis effect disposer {@link installOrcSettings} returns, carrying the
 * bridge it installed so the host can read revisions and observe changes.
 */
export type OrcSettingsInstall = (() => void) & { readonly bridge: OrcSettingsBridge }

/**
 * Install the ORC settings section and return its disposer.
 *
 * @param ctx - the calling plugin's context; it owns the registration effect.
 * @param base - the composition entry used as the base and fallback value.
 * @returns the Cordis effect disposer, with the live bridge attached.
 */
export function installOrcSettings(ctx: Context, base: OrcConfig): OrcSettingsInstall {
  let source: () => OrcConfig = () => base
  let revision = configRevision(base)
  let disposed = false
  const listeners = new Set<OrcSettingsListener>()

  const bridge: OrcSettingsBridge = {
    config: () => source(),
    connectionRevision: route => connectionRevision(source(), route),
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }

  const hooks: SettingsSectionHooks<OrcConfig> = {
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      if (disposed) return
      const next = configRevision(source())
      if (next === revision) return
      revision = next
      for (const listener of [...listeners]) listener(next)
    },
    validate: (value) => {
      parseConfig(value)
    },
  }

  const disposeEffect = ctx.effect(() => {
    ctx.settings.installSection(ctx, 'orc', ConfigSchema, base, hooks)
    return () => bridge.dispose()
  }, 'orc.settings')

  return Object.assign(() => {
    void disposeEffect()
  }, { bridge })
}
