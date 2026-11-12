/**
 * @vitest-environment node
 *
 * The `canonical` column of `CHANNEL_SPECS` and the reducer must agree: a channel
 * classified canonical that `applyEvent` does not fold is silently dropped from
 * every snapshot, and a fold for a channel classified otherwise never runs
 * (`applyEvent` returns early on the classification).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalChannels,
  isVolatileStream,
  volatileStreamChannels,
  type FoldedChannel
} from '../channels'

/** The channels `applyEvent` has a branch for, read from its source. */
function reducerCases(): string[] {
  const code = readFileSync(join(process.cwd(), 'src/core/shared/sync/reducer.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  return [...code.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]).sort()
}

describe('reducer coverage', () => {
  it('applyEvent folds exactly the canonical channels of the event lane', () => {
    const eventLane = canonicalChannels().filter((channel) => !isVolatileStream(channel))
    expect(eventLane.length).toBeGreaterThan(30)
    expect(reducerCases()).toEqual(eventLane)
  })

  it('the only canonical channel off the event lane is the item-stream lane', () => {
    // An item delta is folded as a lane frame by `SyncCore.process`, never as an
    // event, which is why it is canonical without a reducer branch.
    expect(canonicalChannels().filter(isVolatileStream)).toEqual(
      volatileStreamChannels('item-stream')
    )
  })

  it('FoldedChannel is the same set, as a type', () => {
    // If the table's literal types were widened, `FoldedChannel` would collapse
    // to `never` (the first line stops compiling) or widen to `string` (the
    // expected errors below stop being errors).
    const folded: FoldedChannel = 'session:message'
    // @ts-expect-error `session:error` is classified `canonical: false`
    const transient: FoldedChannel = 'session:error'
    // @ts-expect-error a canonical volatile channel is not folded by `applyEvent`
    const volatile: FoldedChannel = 'session:item-delta'
    expect(reducerCases()).toContain(folded)
    expect(reducerCases()).not.toContain(transient)
    expect(reducerCases()).not.toContain(volatile)
  })
})
