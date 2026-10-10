/**
 * Scoped proxy env state for cli.js spawns.
 *
 * Previously `applyProxyEnv()` mutated `process.env.{HTTP,HTTPS,ALL}_PROXY` on
 * the Electron main process itself, which leaked the proxy into node-pty
 * terminals, simple-git subprocesses, plugin hosts, and our own fetch() calls.
 * Now the proxy is stored here and overlaid only onto the cli.js spawn env
 * via buildEnv().
 */

export interface ProxyEnv {
  HTTP_PROXY: string
  HTTPS_PROXY: string
  ALL_PROXY: string
}

let current: ProxyEnv | null = null

export function setProxyEnv(env: ProxyEnv | null): void {
  current = env
}

export function getProxyEnv(): ProxyEnv | null {
  return current
}
