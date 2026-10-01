import { useEffect, useReducer } from 'react'
import type { RemoteAuthMethod } from '../../../../shared/types'
import { getEnrollBridge } from './enroll-flow'
import { isWebClient } from './remote-settings-transport'

/**
 * Does THIS connection hold the `admin` capability (ADR-052)?
 *
 * The desktop renderer's host connection holds every capability. A remote
 * connection's grants are a function of how it authenticated, and nothing
 * else (`grantsFor` in `core/services/auth-policy.ts`, security.md §Grant
 * bundles): a passkey, a resumed passkey and the break-glass password get the
 * full remote set, which includes `admin`; an enrollment link and a connection
 * to a server with authentication off do not. The server is the enforcement:
 * this only decides whether a pane offers its write controls, so a drift here
 * costs a "Permission denied", which the panes latch into the same read-only
 * state (`isPermissionDenied`).
 *
 * The web entry hands shared settings components the connection's method
 * through the enrolment bridge (`enroll-flow.ts`), the one surface both builds
 * share; it is a live read, so a reconnect that changes the method is seen.
 */
export function methodHoldsAdmin(method: RemoteAuthMethod | undefined): boolean {
  return method === 'webauthn' || method === 'webauthn-resumed' || method === 'password'
}

/** `true` on the desktop; on the web, whether the current socket's method grants `admin`. */
export function connectionHoldsAdmin(): boolean {
  if (!isWebClient()) return true
  return methodHoldsAdmin(getEnrollBridge()?.authMethod())
}

/** {@link connectionHoldsAdmin}, re-read whenever the web connection's facts may have moved. */
export function useConnectionHoldsAdmin(): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => getEnrollBridge()?.subscribe(bump), [])
  return connectionHoldsAdmin()
}
