import { mockupOriginFor } from '../../../shared/mockup-url'

/**
 * Platform-specific knobs for the mockup preview iframe, shared by the inline
 * card and the side panel.
 *
 * Desktop loads mockups from the privileged `mockup-asset://` scheme, where
 * each mockup gets its own sub-origin — so `allow-same-origin` is safe and the
 * postMessage origin is the concrete sub-origin.
 *
 * The web client serves mockups over HTTP from the remote server's own origin.
 * To stop a mockup's arbitrary scripts from reaching the web client's window /
 * storage (where the WS token lives), the iframe is sandboxed WITHOUT
 * `allow-same-origin`, giving it an opaque origin (`"null"`). That changes the
 * postMessage targeting/validation, captured here.
 */
const isWeb = (): boolean => typeof window !== 'undefined' && window.api?.platform === 'web'

/** `sandbox` attribute for the preview iframe. */
export const MOCKUP_IFRAME_SANDBOX = isWeb() ? 'allow-scripts' : 'allow-scripts allow-same-origin'

/**
 * Parent → iframe reload target origin. A sandboxed opaque-origin iframe can't
 * be addressed by a concrete origin, so we broadcast with `'*'` on web — the
 * payload is a bare `{type:'mockup:reload'}` signal carrying no sensitive data.
 */
export function mockupReloadTarget(id: string): string {
  return isWeb() ? '*' : mockupOriginFor(id)
}

/** Origin the bridge validates incoming iframe messages against. */
export function mockupExpectedOrigin(id: string): string {
  return isWeb() ? 'null' : mockupOriginFor(id)
}
