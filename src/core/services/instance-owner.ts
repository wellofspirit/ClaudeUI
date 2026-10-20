/**
 * Which ClaudeUI instance owns a `running` X-Agent row (ADR-105 §5).
 *
 * Several instances can share one operational.db (a dev or verifier build beside the packaged
 * app, `claudeui-server` beside the desktop). A row records its owner as the instance's pid plus
 * a per-boot id, because a pid alone is reused: the boot pass interrupts a `running` row only when
 * its owner is gone. A leaf: node built-ins only.
 */
import { randomUUID } from 'node:crypto'

export interface InstanceOwner {
  pid: number
  boot: string
}

let self: InstanceOwner | null = null

/** This process: its pid and a random id minted on first use (one per boot). */
export function currentInstanceOwner(): InstanceOwner {
  self ??= { pid: process.pid, boot: randomUUID() }
  return self
}

/** Is a process with this pid running? A process we may not signal (EPERM) is running. */
export function pidIsAlive(pid: number): boolean {
  // `kill(0)` would signal our own process group, and a negative pid a group: neither is a probe.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Has the instance that owned a `running` row gone?
 *  - No owner (a row written before v39): yes, as the boot pass always treated it.
 *  - This very boot: no (it is ours).
 *  - Our pid under another boot id: yes (the pid was reused by this process).
 *  - Otherwise: when its pid is no longer running. A live pid we cannot tell from a reused one
 *    counts as the owner: leaving a row alone is the safe error (it heals when its turn ends).
 */
export function ownerIsGone(
  owner: InstanceOwner | null,
  me: InstanceOwner = currentInstanceOwner(),
  alive: (pid: number) => boolean = pidIsAlive
): boolean {
  if (!owner) return true
  if (owner.boot === me.boot) return false
  if (owner.pid === me.pid) return true
  return !alive(owner.pid)
}
