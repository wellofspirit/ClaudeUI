/**
 * The seam between the session base class and the session links (slice 1c).
 *
 * `BaseSession` knows when the engine takes a queued prompt the user typed; the
 * link bookkeeping that wants to hear of it (`session-links`, which registers on
 * core's rekey notifications at load) must not become a dependency of every
 * engine session. The links module installs itself here when it loads; a process
 * that never loads it simply has nobody listening.
 */
let observer: ((sessionId: string) => void) | null = null

export function setClientPromptObserver(next: ((sessionId: string) => void) | null): void {
  observer = next
}

/** A client prompt (not a host instruction, not a tool's brief) reached this session. */
export function clientPromptReached(sessionId: string): void {
  observer?.(sessionId)
}
