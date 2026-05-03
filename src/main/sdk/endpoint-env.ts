/**
 * Scoped Anthropic endpoint env state for cli.js spawns.
 *
 * Mirrors the proxy.ts pattern: keep `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN` out of the Electron main process env so they don't
 * leak into node-pty terminals, simple-git subprocesses, or plugin hosts. They
 * are overlaid only onto the cli.js spawn env via buildEnv().
 */

export interface AnthropicEndpointEnv {
  ANTHROPIC_BASE_URL: string
  ANTHROPIC_AUTH_TOKEN: string
}

let current: AnthropicEndpointEnv | null = null

export function setEndpointEnv(env: AnthropicEndpointEnv | null): void {
  current = env
}

export function getEndpointEnv(): AnthropicEndpointEnv | null {
  return current
}
