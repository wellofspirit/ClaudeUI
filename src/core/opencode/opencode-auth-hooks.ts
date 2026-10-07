/**
 * The two places an opencode session meets ClaudeUI's ChatGPT vault (ADR-093
 * §5), as a seam so the session imports no vault: the boot seam
 * (`core-services.ts`) wires them to `credentialSync`. Defaults let every turn
 * go and ignore failures (tests, a host with no vault).
 */
export interface OpencodeAuthHooks {
  /**
   * Before a new turn on `providerID`'s model: `null` lets it go, a string
   * holds it with that notice (the ChatGPT token could not be made fresh).
   */
  beforeTurn(providerID: string): Promise<string | null>
  /** A turn on `providerID` failed `provider.auth`: recover (refresh and rotate). */
  authFailed(providerID: string): void
}

const NONE: OpencodeAuthHooks = {
  beforeTurn: async () => null,
  authFailed: () => {}
}

let hooks: OpencodeAuthHooks = NONE

export function setOpencodeAuthHooks(next: OpencodeAuthHooks | null): void {
  hooks = next ?? NONE
}

export function opencodeAuthHooks(): OpencodeAuthHooks {
  return hooks
}
