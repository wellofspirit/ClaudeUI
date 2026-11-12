/**
 * @vitest-environment node
 *
 * The `canonical` column of `CHANNEL_SPECS` and the reducer must agree: a channel
 * classified canonical that `applyEvent` does not fold is silently dropped from
 * every snapshot, and a fold for a channel classified otherwise never runs.
 * The compiler holds the handler map to `FoldedChannel`; this suite pins the same
 * set at runtime and the type itself.
 */

import { describe, it, expect } from 'vitest'
import {
  canonicalChannels,
  isVolatileStream,
  volatileStreamChannels,
  type FoldedChannel
} from '../channels'
import { applyEvent, foldedChannels } from '../reducer'
import { emptyCanonicalState } from '../state'

describe('reducer coverage', () => {
  it('applyEvent folds exactly the canonical channels of the event lane', () => {
    const eventLane = canonicalChannels().filter((channel) => !isVolatileStream(channel))
    expect(eventLane.length).toBeGreaterThan(30)
    expect(foldedChannels()).toEqual(eventLane)
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
    expect(foldedChannels()).toContain(folded)
    expect(foldedChannels()).not.toContain(transient)
    expect(foldedChannels()).not.toContain(volatile)
  })

  it('a channel named after an Object.prototype member is not found on the prototype', () => {
    const state = emptyCanonicalState()
    for (const channel of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(applyEvent(state, { channel, args: ['rid', {}] })).toBe(state)
    }
  })
})
