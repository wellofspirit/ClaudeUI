/**
 * The one {@link OpencodeCredentialStore} of the process (ADR-097 §5), on the
 * pooled server for ClaudeUI's own directory — a lease per operation that runs
 * no turn. The slot records default to memory so a test touches no home; the
 * boot seam (`core-services.ts`) wires the file.
 */
import { OpencodeClient } from './OpencodeClient'
import {
  opencodeServerManager,
  type Endpoint,
  type OpencodeServerManager
} from './OpencodeServerManager'
import { READ_LINGER_MS } from './read-linger'
import {
  OpencodeCredentialStore,
  type CredentialApi,
  type CredentialLease
} from './credential-store'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'

async function connectPooled(): Promise<CredentialLease> {
  // Lingers idle after the last read: a burst of credential reads reuses one server.
  // Credential routes only: served even by a server whose first-contact cleanup
  // has not succeeded yet — except `create`, which boots a location (2.2.5), so the
  // lease carries the manager's verdict and the store refuses a create on an unclean one.
  const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, {
    waitForHostedTools: false,
    lingerMs: READ_LINGER_MS,
    credentialRoutesOnly: true
  })
  return {
    api: credentialApi(new OpencodeClient(conn)),
    cleaned: conn.cleaned,
    release: () => opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
  }
}

/**
 * The credential routes. `create` boots the global-config location on 2.2.5 (and can refresh the
 * active OAuth connection); list/remove/activate/relabel never activate one (probed).
 */
function credentialApi(client: OpencodeClient): CredentialApi {
  return {
    list: () => client.listCredentials(),
    create: (input) => client.createCredential(input),
    remove: (id) => client.removeCredential(id),
    activate: (id) => client.activateCredential(id),
    relabel: (id, label) => client.updateCredentialLabel(id, label)
  }
}

export const opencodeCredentialStore = new OpencodeCredentialStore({
  connect: connectPooled,
  available: () => opencodeServerManager.isBinaryAvailable()
})

/**
 * First contact with every new server (ADR-097 §5, owner decision 2026-10-07):
 * proven copies of ClaudeUI's own sign-in are deleted through the credential
 * routes BEFORE the server serves anything that can activate a location.
 * opencode resolves (and so may refresh) the active OAuth credential when a
 * location activates its plugins — never at boot, never on `credential.list`,
 * `remove`, `activate` or relabel; `credential.create` is the one credential
 * route that boots the global-config location (2.2.5), so the store fails that
 * one closed until this hook has succeeded. Without the store's recogniser (not
 * wired yet) the hook FAILS, so the manager keeps the server uncleaned and
 * retries — it never counts as clean.
 */
export function installCopyCleanupHook(
  manager: Pick<OpencodeServerManager, 'setServerStartedHook'>,
  store: OpencodeCredentialStore,
  apiFor: (endpoint: Endpoint) => CredentialApi = (endpoint) =>
    credentialApi(new OpencodeClient({ ...endpoint, directory: PERSISTED_SESSIONS_DIR }))
): void {
  manager.setServerStartedHook(async (endpoint) => {
    if (!store.recognisesCopies()) throw new Error('the copy recogniser is not wired yet')
    await store.deleteProvenCopies(apiFor(endpoint), 'first contact')
  })
}

installCopyCleanupHook(opencodeServerManager, opencodeCredentialStore)
