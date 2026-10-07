/**
 * The one {@link OpencodeCredentialStore} of the process (ADR-093 §5), on the
 * pooled server for ClaudeUI's own directory — a lease per operation that runs
 * no turn. The slot records default to memory so a test touches no home; the
 * boot seam (`core-services.ts`) wires the file.
 */
import { OpencodeClient } from './OpencodeClient'
import { opencodeServerManager } from './OpencodeServerManager'
import { READ_LINGER_MS } from './read-linger'
import { OpencodeCredentialStore, type CredentialLease } from './credential-store'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'

async function connectPooled(): Promise<CredentialLease> {
  // Lingers idle after the last read: a burst of credential reads reuses one server.
  const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, {
    waitForHostedTools: false,
    lingerMs: READ_LINGER_MS
  })
  const client = new OpencodeClient(conn)
  return {
    api: {
      list: () => client.listCredentials(),
      create: (input) => client.createCredential(input),
      remove: (id) => client.removeCredential(id),
      activate: (id) => client.activateCredential(id)
    },
    release: () => opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
  }
}

export const opencodeCredentialStore = new OpencodeCredentialStore({
  connect: connectPooled,
  available: () => opencodeServerManager.isBinaryAvailable()
})
