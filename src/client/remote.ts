/**
 * The ORC Remote contribution the client plugin mounts.
 *
 * DSH's Web client assembly value-imports a fixed, build-time list of `/remote`
 * artifacts and discovers nothing at runtime, so a third-party bundle's Remote
 * face is never mounted for it. The public counterpart is
 * `ctx.remote.$mount(contribution)` — the documented entry the assembly itself
 * calls for every namespace it selects — which lets a client plugin mount its
 * own hand-written contribution in its own fiber.
 *
 * This module is that contribution, and it is deliberately hand-written:
 *
 * - a `./remote` package export would have to be a generated Typert artifact,
 *   and `@deepseek-ai/dsh-typert-loader` fails loud on a declared-but-broken
 *   one, so this package declares none;
 * - the client Gateway validates a contribution *structurally* — endpoint
 *   uniqueness, strict input codecs, namespace collisions — and never by
 *   provenance, so plain data with strict codecs is a first-class contribution.
 *
 * The descriptors mirror the host row's three `@Remote` methods exactly
 * (`orc/getCatalog`, `orc/probe`, `orc/getConnectionResult`, each with its
 * `signal` cancellation parameter), so the wire arguments and the host's
 * source-mode descriptor agree without a generated artifact on either side.
 */

import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot, Route } from '../domain/types.js'
import type { OrcConnectionView, OrcRemotePort } from './OrcSettingsPage.js'

/** The npm package that owns these Remote methods. */
export const ORC_REMOTE_PACKAGE = '@tonamson/dsh-orc'

/** The exact wire namespace the ORC Remote host row exports. */
export const ORC_REMOTE_NAMESPACE = 'orc'

/** The Cordis service key the host row registers its Remote face under. */
const ORC_REMOTE_SERVICE = 'orcRemoteHost'

/** One route reference as it crosses the wire; never a credential. */
const RouteCodec = z.union([
  z.object({
    kind: z.literal('provider'),
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
  }),
  z.object({
    kind: z.literal('cli'),
    cli: z.union([z.literal('codex'), z.literal('claude')]),
    model: z.string(),
    effort: z.string(),
  }),
])

/** One endpoint's strict input codec, keyed by the wire field it decodes. */
const jsonParameter = (endpoint: string, name: string, create: () => z.ZodType) => ({
  name,
  wire: name,
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: `${ORC_REMOTE_PACKAGE}#${endpoint}:${name}`, create },
})

/** The three ORC Remote endpoints, exactly as the host row exports them. */
export const ORC_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: ORC_REMOTE_PACKAGE,
  descriptors: [
    {
      id: `${ORC_REMOTE_PACKAGE}#${ORC_REMOTE_SERVICE}/getCatalog`,
      service: ORC_REMOTE_SERVICE,
      namespace: ORC_REMOTE_NAMESPACE,
      method: 'getCatalog',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: { mode: 'src-json' },
    },
    {
      id: `${ORC_REMOTE_PACKAGE}#${ORC_REMOTE_SERVICE}/probe`,
      service: ORC_REMOTE_SERVICE,
      namespace: ORC_REMOTE_NAMESPACE,
      method: 'probe',
      invocation: { kind: 'direct' },
      parameters: [jsonParameter('orc/probe', 'route', () => RouteCodec)],
      cancellation: { parameter: 'signal' },
      result: { mode: 'src-json' },
    },
    {
      id: `${ORC_REMOTE_PACKAGE}#${ORC_REMOTE_SERVICE}/getConnectionResult`,
      service: ORC_REMOTE_SERVICE,
      namespace: ORC_REMOTE_NAMESPACE,
      method: 'getConnectionResult',
      invocation: { kind: 'direct' },
      parameters: [jsonParameter('orc/getConnectionResult', 'routeKey', () => z.string())],
      result: { mode: 'src-json' },
    },
  ],
}

/**
 * The mounted ORC Remote namespace, as `ctx.remote.orc` exposes it.
 *
 * Every method resolves to a {@link RemoteResult}: the carrier folds a Host
 * failure into the error branch, so a caller unwraps it rather than catching a
 * rejection.
 */
export interface OrcRemoteNamespace {
  getCatalog(signal?: AbortSignal): Promise<RemoteResult<CatalogSnapshot>>
  probe(route: Route, signal?: AbortSignal): Promise<RemoteResult<OrcConnectionView>>
  getConnectionResult(routeKey: string): Promise<RemoteResult<OrcConnectionView | null>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** The ORC Remote reads this package's own contribution mounts. */
  interface TypertRemoteNamespace$6f7263 {
    getCatalog: (signal?: AbortSignal) => Promise<RemoteResult<CatalogSnapshot>>
    probe: (route: Route, signal?: AbortSignal) => Promise<RemoteResult<OrcConnectionView>>
    getConnectionResult: (routeKey: string) => Promise<RemoteResult<OrcConnectionView | null>>
  }
  interface TypertRemoteNamespaceMap {
    /** ORC's credential-free catalog, probe, and connection reads. */
    orc: TypertRemoteNamespace$6f7263
  }
}

/** Raised when this profile mounts no ORC Remote face at all. */
export class OrcRemoteUnavailableError extends Error {
  constructor() {
    super('the ORC remote face is unavailable in this profile')
    this.name = 'OrcRemoteUnavailableError'
  }
}

/**
 * The bridge between the asynchronous mount and the page's stable prop.
 *
 * The settings page is registered synchronously, before a mount can resolve, so
 * it takes one stable {@link OrcRemotePort} whose calls await the mount. When
 * no namespace is attached and no mount is in flight the call fails immediately
 * with {@link OrcRemoteUnavailableError}, which the page renders as its
 * "unavailable" state rather than hanging.
 *
 * The bridge also owns the mount's disposer: `ctx.remote.$mount(...)` registers
 * its effects on the Remote service's own fiber, so unloading the ORC client
 * plugin has to call the disposer it returns explicitly.
 */
export interface OrcRemoteBridge {
  /** The port the settings page reads; identity-stable for the page's lifetime. */
  readonly port: OrcRemotePort
  /**
   * Run one mount and publish its namespace.
   *
   * The call is recorded synchronously, so a page rendered while the mount is
   * still resolving waits for it instead of reporting the face missing. A
   * failed mount leaves the port reporting the face unavailable. A mount that
   * settles after {@link unmount} is disposed immediately instead of
   * republishing a namespace nothing owns.
   *
   * @param start - the mount operation, resolving the namespace and its disposer.
   */
  mount(start: () => Promise<OrcRemoteMount>): Promise<void>
  /** Withdraw the published namespace and dispose its mount. */
  unmount(): Promise<void>
}

/** One settled `$mount`: the namespace it published and the disposer it returned. */
export interface OrcRemoteMount {
  readonly namespace: OrcRemoteNamespace
  readonly dispose: () => Promise<void>
}

/** Unwrap one Remote result, or throw the failure's safe message. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/** Build the identity-stable port over the mount lifecycle. */
export function createOrcRemoteBridge(): OrcRemoteBridge {
  let attached: OrcRemoteNamespace | undefined
  let inFlight: Promise<void> | undefined
  let disposeMount: (() => Promise<void>) | undefined
  /** Identifies the mount allowed to publish; every unmount retires one. */
  let generation = 0

  /** The mounted namespace, waiting only while a mount is actually in flight. */
  const namespace = async (): Promise<OrcRemoteNamespace> => {
    if (attached !== undefined) return attached
    if (inFlight !== undefined) await inFlight
    if (attached !== undefined) return attached
    throw new OrcRemoteUnavailableError()
  }

  return {
    port: {
      getCatalog: async (signal) => unwrap(await (await namespace()).getCatalog(signal)),
      probe: async (route, signal) => unwrap(await (await namespace()).probe(route, signal)),
      getConnectionResult: async (routeKey) => unwrap(await (await namespace()).getConnectionResult(routeKey)),
    },
    mount: (start) => {
      const mine = (generation += 1)
      const attempt = start().then(
        async (mounted) => {
          if (generation !== mine) {
            // Unmounted while this mount was resolving: nothing owns it now.
            await mounted.dispose()
            return
          }
          attached = mounted.namespace
          disposeMount = mounted.dispose
        },
        () => {
          // The mount refused; the port reports the face unavailable.
        },
      )
      inFlight = attempt
      return attempt
    },
    unmount: async () => {
      generation += 1
      attached = undefined
      inFlight = undefined
      const dispose = disposeMount
      disposeMount = undefined
      if (dispose !== undefined) await dispose()
    },
  }
}
