/**
 * The ORC Remote face.
 *
 * One `TypertRemoteService` bound to the `orc` namespace exposes the ORC
 * service's credential-free reads to the Web client: the live catalog, one
 * explicit route probe, and the recorded connection result for an exact route
 * key. Every result is plain JSON — a route reference, a version, a timestamp,
 * an ORC-owned failure code, and a redacted diagnostic. No provider token,
 * native CLI credential, or raw backend payload can cross this boundary,
 * because the service never holds one.
 *
 * The class is mounted by its own `orc-remote-host` Loader row, which injects
 * `orc`, so the Remote face exists only while the ORC service does.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot, Route } from '../domain/types.js'
import type { OrcConnection } from './service.js'

/** The credential-free ORC Remote face. */
export class OrcRemoteHost extends TypertRemoteService {
  static inject = ['orc']

  constructor(ctx: Context) {
    super(ctx, 'orcRemoteHost', { namespace: 'orc' })
  }

  /**
   * Read the live catalog of every route ORC may select.
   *
   * @param signal - ends the catalog read early.
   */
  @Remote('getCatalog')
  async getCatalog(signal: AbortSignal): Promise<CatalogSnapshot> {
    return await this.ctx.orc.getCatalog(signal)
  }

  /**
   * Verify one exact route now and record the result.
   *
   * @param route - the provider/CLI route to test.
   * @param signal - ends the probe early.
   */
  @Remote('probe')
  async probe(route: Route, signal: AbortSignal): Promise<OrcConnection> {
    return await this.ctx.orc.probe(route, signal)
  }

  /**
   * Read the recorded connection result for one exact route key.
   *
   * @param routeKey - the route key returned by the catalog or a decision.
   * @returns the recorded result, or `null` when the route was never tested.
   */
  @Remote('getConnectionResult')
  async getConnectionResult(routeKey: string): Promise<OrcConnection | null> {
    return this.ctx.orc.getConnectionResult(routeKey)
  }
}

export default OrcRemoteHost
