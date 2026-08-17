/**
 * The vendor-credential / account / native-OAuth command surface — ONE
 * declaration, both transports (ADR-057, the S4 vendor-OAuth series).
 *
 * These verbs used to be inline `handleIpc({...})` registrations in
 * `session.ipc.ts` with no remote twin — desktop-only by omission. The headless
 * admission ruling (2026-08-17) makes everything except host-PHYSICAL verbs
 * changeable from the remote UI, and ADR-056 reclassified this whole family from
 * `admin` to `config` (it is engine/vendor configuration — which model account
 * the host bills — not the session-security area `admin` now names exactly). So
 * they moved here, as transport-agnostic registrations in the
 * `stream-watch.ts` / `config-commands.ts` shape: `session.ipc.ts` spreads them
 * with `handleIpc`, `remote-handlers.ts` with `handleRemote`, both spreading the
 * SAME declaration. The registry's declaration-conflict throw is what makes the
 * two surfaces unable to disagree.
 *
 * **Flows, not just data.** Three of these verbs open an OAuth flow, and a
 * remote caller must not trigger a host-physical browser open:
 *
 *  - `auth:sign-in` / `account:add` (native Claude OAuth, cli.js-owned): the
 *    handler reads `connection.identity.method` — the desktop connection opens
 *    the host browser (byte-identical to before), a remote connection skips
 *    `shell.openExternal` and gets `manualUrl` back on the state instead
 *    (threaded through `signIn({ remote })`). The token EXCHANGE stays host-side
 *    either way. This is the "origin-derived flag" of the ADR-057 §sign-in
 *    ruling — ONE shared body whose behaviour derives from WHO called, never a
 *    second handler.
 *  - `vendor-auth:oauth-authorize`: for opencode's `auto` method the loopback
 *    lives inside the host's opencode server, unreachable from a remote browser,
 *    so a remote caller is refused with an actionable message (use the `code`
 *    method, or the desktop). pi's Codex `auto` is NOT refused — it completes
 *    remotely via the paste-back path (`vendor-auth:oauth-callback` carries the
 *    pasted URL as its `code` arg; see `codex-oauth.ts`).
 *
 * **Token material NEVER crosses the wire.** `probe` / `list-keys` return
 * booleans / credential-kind / labels only; the mutations return void/void-ish.
 * No handler here returns `access` / `refresh` / a key.
 *
 * `requireEngineAuth` and `setAccountEnabled` are INJECTED (the desktop auth
 * subsystem — `engineAuthRegistry`, `account-manager` — stays in `src/main`
 * because it opens the OAuth browser). `session.ipc.ts` passes the real
 * singletons; `remote-handlers.ts` receives them from `boot-core`. The shape
 * mirrors `config-commands.ts` taking the `SessionManager` explicitly.
 *
 * NOT here: `account:get` (a query already registered on both transports) and
 * `shared-provider:list` / `statuses` / `models` (queries, already on both) —
 * those never moved. Only the MUTATIONS the S1b sweep deferred land here.
 */

import { safeHandler } from './safe-handler'
import type { CommandConnection, CommandRegistration } from './command-registry'
import type { EngineAuthProvider } from '../auth/EngineAuthProvider'
import { sharedProviderService } from '../shared-providers'
import type {
  AccountsState,
  AuthFlowState,
  EngineId,
  VendorAuthMap,
  VendorAuthOption
} from '../../shared/types'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition
} from '../../shared/shared-provider'

/**
 * The desktop-auth capabilities this family needs, injected from the boot seam
 * so the (Electron-free) core registrar never imports the `src/main` singletons.
 */
export interface AuthCommandDeps {
  /** `engineAuthRegistry.require(engineId)` — throws if the engine has no provider. */
  requireEngineAuth(engineId: EngineId): EngineAuthProvider
  /** `accountManager.setEnabled(enabled)` — toggles multi-account (file-credential) mode. */
  setAccountEnabled(enabled: boolean): Promise<AccountsState> | AccountsState
}

/** True for any transport other than the in-process desktop renderer. */
function isRemote(connection: CommandConnection): boolean {
  return connection.identity.method !== 'desktop'
}

/**
 * Every channel in this family, transport-agnostic. Takes its desktop-auth
 * dependencies explicitly (see the module header) rather than closing over
 * module state.
 */
export function authCommands(
  deps: AuthCommandDeps
): Array<Omit<CommandRegistration, 'transport'>> {
  const claude = (): EngineAuthProvider => deps.requireEngineAuth('claude')

  return [
    // -----------------------------------------------------------------------
    // Native Anthropic OAuth (ADR-014) — cli.js owns the flow; we drive it.
    // `auth:sign-in` is remote-aware (openExternal skip + manualUrl surfacing).
    // -----------------------------------------------------------------------
    {
      channel: 'auth:sign-in',
      capability: 'config',
      kind: 'command',
      withConnection: true,
      handler: async (connection: CommandConnection): Promise<AuthFlowState | undefined> =>
        claude().signIn?.({ remote: isRemote(connection) })
    },
    {
      channel: 'auth:submit-code',
      capability: 'config',
      kind: 'command',
      handler: async (code: string): Promise<AuthFlowState | undefined> =>
        claude().submitCode?.(code)
    },
    {
      channel: 'auth:cancel',
      capability: 'config',
      kind: 'command',
      handler: async (): Promise<void> => claude().cancelSignIn?.()
    },

    // -----------------------------------------------------------------------
    // Multi-account (ADR-015). `account:get` (query) stays in the transport
    // registrars; the MUTATIONS land here. `account:add` is remote-aware for
    // the same reason `auth:sign-in` is (it kicks off a login).
    // -----------------------------------------------------------------------
    {
      channel: 'account:set-enabled',
      capability: 'config',
      kind: 'command',
      handler: async (enabled: boolean): Promise<AccountsState> => deps.setAccountEnabled(enabled)
    },
    {
      channel: 'account:add',
      capability: 'config',
      kind: 'command',
      withConnection: true,
      handler: async (connection: CommandConnection): Promise<AccountsState | undefined> =>
        claude().addAccount?.({ remote: isRemote(connection) })
    },
    {
      channel: 'account:switch',
      capability: 'config',
      kind: 'command',
      handler: async (id: string): Promise<AccountsState | undefined> =>
        claude().switchAccount?.(id)
    },
    {
      channel: 'account:delete',
      capability: 'config',
      kind: 'command',
      handler: async (id: string): Promise<AccountsState | undefined> =>
        claude().deleteAccount?.(id)
    },

    // -----------------------------------------------------------------------
    // Engine-routed per-vendor auth (opencode / pi multi-vendor). Each guards
    // the optional provider method and throws a clear error when absent —
    // identical bodies to the pre-S4 inline handlers in session.ipc.ts.
    // -----------------------------------------------------------------------
    {
      channel: 'vendor-auth:probe',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async (engineId: EngineId): Promise<VendorAuthMap> => {
        return deps.requireEngineAuth(engineId).probe()
      })
    },
    {
      channel: 'vendor-auth:list-options',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(
        async (engineId: EngineId): Promise<Record<string, VendorAuthOption[]>> => {
          const provider = deps.requireEngineAuth(engineId)
          if (!provider.listVendorAuthOptions) {
            throw new Error(`Engine "${engineId}" does not support listVendorAuthOptions`)
          }
          return provider.listVendorAuthOptions()
        }
      )
    },
    {
      channel: 'vendor-auth:list-keys',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(
        async (engineId: EngineId): Promise<Record<string, 'api' | 'oauth'>> => {
          const provider = deps.requireEngineAuth(engineId)
          if (!provider.listVendorCredentialIds) {
            throw new Error(`Engine "${engineId}" does not support listVendorCredentialIds`)
          }
          return provider.listVendorCredentialIds()
        }
      )
    },
    {
      channel: 'vendor-auth:set-key',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(
        async (engineId: EngineId, vendorId: string, key: string): Promise<void> => {
          const provider = deps.requireEngineAuth(engineId)
          if (!provider.setVendorApiKey) {
            throw new Error(`Engine "${engineId}" does not support setVendorApiKey`)
          }
          return provider.setVendorApiKey(vendorId, key)
        }
      )
    },
    {
      channel: 'vendor-auth:oauth-authorize',
      capability: 'config',
      kind: 'command',
      withConnection: true,
      handler: safeHandler(
        async (
          connection: CommandConnection,
          engineId: EngineId,
          vendorId: string,
          method: number,
          inputs?: Record<string, string>
        ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> => {
          const provider = deps.requireEngineAuth(engineId)
          if (!provider.oauthAuthorize) {
            throw new Error(`Engine "${engineId}" does not support oauthAuthorize`)
          }
          const result = await provider.oauthAuthorize(vendorId, method, inputs)
          // opencode's `auto` method drives a loopback INSIDE the host's opencode
          // server process — a remote browser can never reach it (ADR-057). Tear
          // the just-started flow down and refuse with an actionable message.
          // pi's Codex `auto` is deliberately NOT refused: it completes remotely
          // via the paste-back path on `vendor-auth:oauth-callback`.
          if (isRemote(connection) && engineId === 'opencode' && result.method === 'auto') {
            await provider.cancelVendorOauth?.()
            throw new Error(
              "opencode's automatic browser sign-in only completes on the host machine. " +
                "Choose the 'paste a code' method, or sign in from the desktop app."
            )
          }
          return result
        }
      )
    },
    {
      channel: 'vendor-auth:oauth-callback',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(
        async (
          engineId: EngineId,
          vendorId: string,
          method: number,
          code?: string
        ): Promise<boolean> => {
          const provider = deps.requireEngineAuth(engineId)
          if (!provider.oauthCallback) {
            throw new Error(`Engine "${engineId}" does not support oauthCallback`)
          }
          // `code` may be a bare code OR a whole pasted callback URL — the
          // provider (pi Codex / opencode) decides how to consume it (ADR-057).
          return provider.oauthCallback(vendorId, method, code)
        }
      )
    },
    {
      channel: 'vendor-auth:oauth-cancel',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (engineId: EngineId): Promise<void> => {
        // No-op if the engine doesn't drive OAuth flows.
        await deps.requireEngineAuth(engineId).cancelVendorOauth?.()
      })
    },
    {
      channel: 'vendor-auth:remove',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (engineId: EngineId, vendorId: string): Promise<void> => {
        const provider = deps.requireEngineAuth(engineId)
        if (!provider.removeVendorAuth) {
          throw new Error(`Engine "${engineId}" does not support removeVendorAuth`)
        }
        return provider.removeVendorAuth(vendorId)
      })
    },

    // -----------------------------------------------------------------------
    // Shared-provider MUTATIONS (the reads — list/statuses/models — stay in the
    // transport registrars). `sharedProviderService` is a core singleton, so no
    // injection needed. `set-key` stores an API key host-side; it never returns
    // one. ADR-056 reclassified this family admin→config with the rest.
    // -----------------------------------------------------------------------
    {
      channel: 'shared-provider:save',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (definition: SharedProviderDefinition) =>
        sharedProviderService.saveDefinition(definition)
      )
    },
    {
      channel: 'shared-provider:remove',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (id: string) => sharedProviderService.removeDefinition(id))
    },
    {
      channel: 'shared-provider:set-route',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(
        async (id: string, harness: ConfigurableHarnessId, enabled: boolean) =>
          sharedProviderService.setRouteEnabled(id, harness, enabled)
      )
    },
    {
      channel: 'shared-provider:set-key',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (id: string, key: string) =>
        sharedProviderService.setApiKey(id, key)
      )
    },
    {
      channel: 'shared-provider:sync',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (id: string) => sharedProviderService.syncProvider(id))
    },
    {
      channel: 'shared-provider:disconnect',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(async (id: string) => sharedProviderService.disconnectProvider(id))
    },
    {
      channel: 'shared-provider:set-default',
      capability: 'config',
      kind: 'command',
      handler: safeHandler(
        async (id: string, harness: ConfigurableHarnessId, modelId?: string) =>
          sharedProviderService.setRouteDefaultModel(id, harness, modelId)
      )
    }
  ]
}
