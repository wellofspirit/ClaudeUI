/**
 * Per-route reasoning-effort floor, learned at run time. A ChatGPT workspace can refuse the
 * stage-1 effort (`none`/`minimal`) with an HTTP 403; the transport then retries at `low` and
 * files the route here so later calls send `low` first. Process-wide and in-memory, like
 * `judge-cooldown.ts`: a restart forgets it and re-learns with one extra request. Keyed by
 * `judgeRouteKey(route)`, so one account's workspace policy never raises another's effort.
 */

const floors = new Set<string>()

/** The route's floor becomes `low`. Idempotent. */
export function raiseEffortFloor(routeKey: string): void {
  floors.add(routeKey)
}

/** The route's learned floor, or undefined while none was needed. */
export function effortFloor(routeKey: string): 'low' | undefined {
  return floors.has(routeKey) ? 'low' : undefined
}

/** Forget every floor (tests). */
export function clearEffortFloors(): void {
  floors.clear()
}
