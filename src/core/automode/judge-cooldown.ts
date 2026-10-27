/**
 * Process-wide rate-limit cooldowns for judge routes.
 *
 * A 429 that says when the route recovers (ChatGPT's `usage_limit_reached` carries a `resets_at`
 * days away) is not worth retrying on every gated action: each call would pay a network round
 * trip to learn the same thing. `makeSessionJudgeTransport` files the route here on such a 429
 * and answers every later call for it as unavailable until the reset, so the judge pipeline goes
 * straight to the fallback judge (or the human).
 *
 * Keyed by `judgeRouteKey(route)` — provider, model and the account that pays — so one route
 * resting never silences another. In memory only: a restart forgets the rest, and the first call
 * after it learns the reset time again from the same 429. Nothing here holds a credential.
 */

/** No cooldown outlasts this, whatever the server claims: a bogus `resets_at` must not silence a route for good. */
const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000

const cooldowns = new Map<string, number>()

/**
 * Rest `routeKey` until `retryAtMs` (epoch ms), capped at {@link MAX_COOLDOWN_MS} from `now`. A
 * time that is not in the future is ignored, so a stale or malformed hint never starts a cooldown.
 * A newer 429 replaces an earlier one: the latest reset time is the server's current word.
 */
export function noteRateLimited(
  routeKey: string,
  retryAtMs: number,
  now: number = Date.now()
): void {
  if (!Number.isFinite(retryAtMs) || retryAtMs <= now) return
  cooldowns.set(routeKey, Math.min(retryAtMs, now + MAX_COOLDOWN_MS))
}

/** The epoch ms `routeKey` rests until, or undefined when it is not cooling down at `now`. */
export function coolingUntil(routeKey: string, now: number = Date.now()): number | undefined {
  const until = cooldowns.get(routeKey)
  if (until === undefined) return undefined
  if (until <= now) {
    cooldowns.delete(routeKey)
    return undefined
  }
  return until
}

/** Forget every cooldown — for tests. */
export function clearCooldowns(): void {
  cooldowns.clear()
}
