/**
 * @vitest-environment node
 *
 * Golden replay — SyncCore phase 4a item 9.
 *
 * Each fixture is a RECORDED event stream plus the canonical state it must fold
 * to. Fixtures beat hand-written assertions for the scenarios that broke the
 * as-built layer, because the input is the wire shape verbatim: if a payload
 * changes, the fixture is the thing that has to be edited, which makes the change
 * visible in review instead of absorbed by a test helper.
 *
 * Fixtures live in `./fixtures/*.json` and are committed. The required set (from
 * the phase-4a plan) is asserted below, so deleting one fails the suite.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { applyEvent, emptyAux, checkDerivedFields } from '../reducer'
import { isVolatileStream } from '../channels'
import { applyStreamFrame, streamFrameFrom } from '../stream'
import { emptyCanonicalState, type CanonicalState } from '../state'

interface Fixture {
  name: string
  why: string
  events: Array<{ channel: string; args: unknown[] }>
  expectSessionIds: string[]
  expectSession: Record<string, Record<string, unknown>>
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

function loadFixtures(): Array<{ file: string; fixture: Fixture }> {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8')) as Fixture
    }))
}

/**
 * Replay a fixture the way the HOST does — routed by the channel's class.
 *
 * A fixture records an EMISSION stream, not an event stream, so a `volatile`
 * channel (phase 5 S1) belongs on the stream lane rather than in `applyEvent`.
 * Routing here instead of deleting those lines keeps `mid-stream-rekey.json`
 * honest: its deltas are what make the rekey a MID-STREAM one, and they still
 * exercise the aux the two lanes share.
 */
function replay(fixture: Fixture): CanonicalState {
  const aux = emptyAux()
  let state = emptyCanonicalState()
  fixture.events.forEach((event, i) => {
    if (isVolatileStream(event.channel)) {
      const frame = streamFrameFrom(state, aux, event.channel, event.args)
      if (frame) state = applyStreamFrame(state, aux, frame).state
      return
    }
    state = applyEvent(state, { channel: event.channel, args: event.args, seq: i + 1 }, aux)
  })
  return state
}

describe('golden replay fixtures', () => {
  const fixtures = loadFixtures()

  it('the required scenario set is present', () => {
    expect(fixtures.map((f) => f.file)).toEqual([
      'cost-replace-not-add.json',
      'derived-todos-and-files.json',
      'mid-stream-rekey.json',
      'queue-take-back.json'
    ])
  })

  for (const { file, fixture } of fixtures) {
    describe(`${file} — ${fixture.name}`, () => {
      it('folds to the committed canonical state', () => {
        const state = replay(fixture)
        expect(Object.keys(state.sessions).sort()).toEqual([...fixture.expectSessionIds].sort())
        for (const [routingId, expected] of Object.entries(fixture.expectSession)) {
          const session = state.sessions[routingId]
          expect(session, `no session ${routingId}`).toBeDefined()
          for (const [field, value] of Object.entries(expected)) {
            expect(
              session[field as keyof typeof session],
              `${file}: ${routingId}.${field}`
            ).toEqual(value)
          }
        }
      })

      it('replays deterministically (same stream ⇒ same state)', () => {
        expect(JSON.stringify(replay(fixture))).toBe(JSON.stringify(replay(fixture)))
      })

      it('leaves no derived-field drift', () => {
        // The tripwire runs against every fixture, so a change to either the
        // derivation or a trigger shows up here rather than at a user's resync.
        expect(checkDerivedFields(replay(fixture))).toEqual([])
      })

      it('is incrementally consistent — a prefix fold then the tail equals the whole', () => {
        // Catchup replays a SUFFIX on top of an existing state. If folding
        // 1..k then k+1..n differed from folding 1..n, every reconnect would
        // diverge from the client that stayed connected.
        const aux = emptyAux()
        let state = emptyCanonicalState()
        const half = Math.floor(fixture.events.length / 2)
        fixture.events.forEach((event, i) => {
          if (i < half) {
            state = applyEvent(state, { channel: event.channel, args: event.args, seq: i + 1 }, aux)
          }
        })
        fixture.events.forEach((event, i) => {
          if (i >= half) {
            state = applyEvent(state, { channel: event.channel, args: event.args, seq: i + 1 }, aux)
          }
        })
        expect(JSON.stringify(state)).toBe(JSON.stringify(replay(fixture)))
      })
    })
  }
})
