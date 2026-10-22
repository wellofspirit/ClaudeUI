/**
 * `judge-cooldown` — the process-wide rest a rate-limited judge route is put on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clearCooldowns, coolingUntil, noteRateLimited } from '../judge-cooldown'

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

afterEach(() => clearCooldowns())

describe('judge-cooldown', () => {
  it('a route with no cooldown is not cooling', () => {
    expect(coolingUntil('route-a', NOW)).toBeUndefined()
  })

  it('rests the route until the reset time, and only that route', () => {
    noteRateLimited('route-a', NOW + 5 * DAY, NOW)
    expect(coolingUntil('route-a', NOW)).toBe(NOW + 5 * DAY)
    expect(coolingUntil('route-a', NOW + 5 * DAY - 1)).toBe(NOW + 5 * DAY)
    expect(coolingUntil('route-b', NOW)).toBeUndefined()
  })

  it('expires at the reset time and forgets it', () => {
    noteRateLimited('route-a', NOW + 1000, NOW)
    expect(coolingUntil('route-a', NOW + 1000)).toBeUndefined()
    // Gone for good, not merely not-yet: an earlier clock reading finds nothing either.
    expect(coolingUntil('route-a', NOW)).toBeUndefined()
  })

  it('ignores a reset time that is already past, now, or not a number', () => {
    noteRateLimited('route-a', NOW - 1, NOW)
    noteRateLimited('route-b', NOW, NOW)
    noteRateLimited('route-c', Number.NaN, NOW)
    noteRateLimited('route-d', Number.POSITIVE_INFINITY, NOW)
    for (const key of ['route-a', 'route-b', 'route-c', 'route-d']) {
      expect(coolingUntil(key, NOW)).toBeUndefined()
    }
  })

  it('a stale hint does not shorten a cooldown already running', () => {
    noteRateLimited('route-a', NOW + 3 * DAY, NOW)
    noteRateLimited('route-a', NOW - DAY, NOW)
    expect(coolingUntil('route-a', NOW)).toBe(NOW + 3 * DAY)
  })

  it('caps a cooldown at 8 days', () => {
    noteRateLimited('route-a', NOW + 400 * DAY, NOW)
    expect(coolingUntil('route-a', NOW)).toBe(NOW + 8 * DAY)
    expect(coolingUntil('route-a', NOW + 8 * DAY)).toBeUndefined()
  })

  it('a newer 429 replaces the earlier reset time', () => {
    noteRateLimited('route-a', NOW + 5 * DAY, NOW)
    noteRateLimited('route-a', NOW + 2 * DAY, NOW + 1000)
    expect(coolingUntil('route-a', NOW + 1000)).toBe(NOW + 2 * DAY)
  })

  it('clearCooldowns forgets every route', () => {
    noteRateLimited('route-a', NOW + DAY, NOW)
    noteRateLimited('route-b', NOW + DAY, NOW)
    clearCooldowns()
    expect(coolingUntil('route-a', NOW)).toBeUndefined()
    expect(coolingUntil('route-b', NOW)).toBeUndefined()
  })
})
