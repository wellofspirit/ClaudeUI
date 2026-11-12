/**
 * The host-neutral part of shutting the service graph down, shared by both
 * hosts (the desktop's quit teardown and the headless server's signal handler).
 *
 * Two methods, not one async `stop()`: the desktop's quit is two-phase by design
 * (`quit-coordinator.ts`) — `prepareStop` runs while services are alive and the
 * HOST bounds it; `stop` is synchronous and runs inside the confirmed
 * `before-quit`. Host-only steps (the desktop's log viewer and plugins) stay in
 * the host. Deps are injected so the order is testable without mocking modules.
 */

export interface CoreStopDeps {
  credentialSync: { prepareQuit(): Promise<void>; stop(): void }
  automationManager: { stopAll(): void }
  hostAnchor: { stop(): void }
  usageHubClient: { stop(): void }
  releaseDispatchParents: () => void
  serviceSession: { stop(): void }
  opencodeServerManager: { dispose(): void }
  localVoiceServer: { stop(): Promise<unknown> }
  /** Reports a `prepareStop` failure; it never rejects. */
  onPrepareError: (err: unknown) => void
}

export interface CoreStop {
  /** Needs the services alive; the host bounds it. Never rejects. */
  prepareStop(): Promise<void>
  stop(): void
}

export function createCoreStop(deps: CoreStopDeps): CoreStop {
  return {
    // opencode 2.x shares its credential table with the user's own opencode:
    // hand the ChatGPT slot back to their credential while a server can still
    // run (ADR-097 §5). A crash skips it and the next start re-asserts.
    prepareStop: async () => {
      try {
        await deps.credentialSync.prepareQuit()
      } catch (err) {
        deps.onPrepareError(err)
      }
    },
    stop: () => {
      deps.automationManager.stopAll()
      deps.credentialSync.stop()
      // Fire-and-forget by design (see host-anchor): the exit is not gated on
      // peers that may never close their sockets.
      deps.hostAnchor.stop()
      // The usage hub's timers (ADR-072 §7). Nothing waits on the client: a
      // push in flight is idempotent on the hub, so the worst a killed one
      // costs is a batch re-sent as duplicates on the next launch.
      deps.usageHubClient.stop()
      deps.releaseDispatchParents()
      // Stop the service session (lightweight CLI subprocess for usage polling)
      deps.serviceSession.stop()
      // Reap any shared opencode servers (Windows tree-kill) so opencode.exe
      // children don't orphan on quit. Idempotent — safe to run on every invocation.
      deps.opencodeServerManager.dispose()
      // The on-device speech worker (~0.8 GB while loaded). Fire-and-forget:
      // stdin EOF ends it anyway once this process is gone.
      void deps.localVoiceServer.stop()
    }
  }
}
