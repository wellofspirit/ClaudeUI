/**
 * The useful half of a rejected channel call, and the two rejections a caller
 * has to tell apart from a real failure.
 *
 * On the desktop, `ipcRenderer.invoke` wraps a handler's throw as
 * "Error invoking remote method '<channel>': <ClassName>: <message>". The web
 * transport rejects with the handler's message as-is, so both wrappers are
 * optional. The message is the part a handler wrote for the person reading it
 * ("the hub must be https, or http on localhost").
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '')
}

/**
 * The command registry refused the call for want of a capability
 * (`command-registry.ts`: `Permission denied: "<channel>" requires …`). A
 * remote connection that lacks one is refused on every write, so a pane shows
 * this once as a read-only state, not as an error per click.
 */
export function isPermissionDenied(error: unknown): boolean {
  return /^Permission denied\b/.test(ipcErrorMessage(error))
}

/**
 * The web transport gave up waiting (`src/web/connection.ts`, 30 s): the call
 * may still be running on the host. Only the remote client produces this; the
 * desktop's `invoke` has no timeout.
 */
export function isInvokeTimeout(error: unknown): boolean {
  return /^Timeout: /.test(ipcErrorMessage(error))
}
