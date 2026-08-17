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
let proxySubprocesses = false

export function setProxyEnv(env: ProxyEnv | null): void {
  current = env
}

export function getProxyEnv(): ProxyEnv | null {
  return current
}

/**
 * When true, cli.js subprocesses (Bash tool, MCP, LSP, shell-snapshot) inherit
 * the proxy env vars. When false (default), the subprocess-proxy-strip patch
 * strips them so only cli.js's own Anthropic API traffic is proxied.
 */
export function setProxyAllSubprocesses(v: boolean): void {
  proxySubprocesses = v
}

export function getProxyAllSubprocesses(): boolean {
  return proxySubprocesses
}
