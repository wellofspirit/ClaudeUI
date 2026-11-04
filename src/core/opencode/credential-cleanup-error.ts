/**
 * The fail-closed refusal for an opencode server whose credentials ClaudeUI has not been able to
 * check for copies of its own ChatGPT sign-in (S7, ADR-097 §5).
 *
 * Thrown by `OpencodeServerManager.acquire` when it will not hand out a server for anything that
 * activates a location, and by the credential store when it refuses a `create` for the same
 * reason: on 2.2.5 `POST /api/credential` boots the global-config location
 * (`packages/server/src/handlers/credential.ts`), whose plugins can resolve — and refresh — the
 * active OAuth connection.
 *
 * Its own module, not `OpencodeServerManager.ts`, so the credential store (and every test that
 * mocks the manager) can throw it without loading the manager.
 */
export class OpencodeCredentialCleanupError extends Error {
  constructor(
    readonly baseUrl: string | undefined,
    refused: 'server' | 'credential-create' = 'server'
  ) {
    super(
      refused === 'credential-create'
        ? 'ClaudeUI could not check opencode’s saved credentials for a copy of its own ChatGPT sign-in, ' +
            'so it will not save a credential yet: saving one makes opencode load its plugins, which can ' +
            'refresh the copy and sign ClaudeUI out. This is usually a busy opencode database — try again ' +
            'in a moment.'
        : 'ClaudeUI could not check opencode’s saved credentials for a copy of its own ChatGPT sign-in, ' +
            'so it will not open opencode sessions on that server yet (opencode could refresh the copy and ' +
            'sign ClaudeUI out). This is usually a busy opencode database — try again in a moment.'
    )
    this.name = 'OpencodeCredentialCleanupError'
  }
}
