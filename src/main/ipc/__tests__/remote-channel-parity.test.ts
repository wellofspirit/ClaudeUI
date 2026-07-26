/**
 * @vitest-environment node
 *
 * R5 parity guard — every non-BLOCKED channel the web api-adapter invokes MUST
 * have a registered remote handler. This prevents the whole class of gap the
 * remote client hit before R5 (git:*, account:get, live watching, multi-engine
 * catalogs, title/commit generation, … all threw "Channel not available").
 *
 * It's a static SOURCE scan on purpose: importing the web api-adapter (browser
 * module) and remote-handlers (full Electron/service graph) into one test would
 * be heavy and fragile. The scan pairs the two source files instead, so a future
 * api-adapter invoke with no matching registration fails CI.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const REPO = process.cwd()
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf-8')

/** Channels the web client invokes over the WS (connection.invoke / unwrap). */
function invokedChannels(): Set<string> {
  const src = read('src/web/api-adapter.ts')
  const set = new Set<string>()
  const re = /(?:connection\.invoke|unwrap)\(\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) set.add(m[1])
  return set
}

/** Channels registered on the RemoteDispatcher (dispatcher/activeDispatcher.register). */
function registeredChannels(): Set<string> {
  const src = read('src/main/ipc/remote-handlers.ts')
  const set = new Set<string>()
  const re = /\.register\(\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) set.add(m[1])
  return set
}

/** The dispatcher denylist (parsed from the BLOCKED Set literal in source). */
function blockedChannels(): Set<string> {
  const src = read('src/main/services/remote-dispatcher.ts')
  const body = src.slice(src.indexOf('BLOCKED = new Set(['))
  const literal = body.slice(0, body.indexOf('])'))
  const set = new Set<string>()
  const re = /['"]([^'"]+)['"]/g
  for (let m = re.exec(literal); m; m = re.exec(literal)) set.add(m[1])
  return set
}

describe('remote channel parity (R5)', () => {
  it('the scan actually finds channels (non-vacuity)', () => {
    const invoked = invokedChannels()
    const registered = registeredChannels()
    // If a regex broke, these would be empty and the coverage test below would
    // pass vacuously — anchor on channels we know exist.
    expect(invoked.size).toBeGreaterThan(30)
    expect(invoked.has('git:commit')).toBe(true)
    expect(invoked.has('account:get')).toBe(true)
    expect(registered.has('git:commit')).toBe(true)
    expect(blockedChannels().has('account:add')).toBe(true)
  })

  it('every invoked channel has a registered remote handler', () => {
    const invoked = invokedChannels()
    const registered = registeredChannels()
    const missing = [...invoked].filter((c) => !registered.has(c)).sort()
    // Surfacing the list makes a regression immediately actionable.
    expect(missing, `api-adapter invokes these with no remote handler: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('no invoked channel is on the dispatcher denylist', () => {
    const invoked = invokedChannels()
    const blocked = blockedChannels()
    const conflicting = [...invoked].filter((c) => blocked.has(c)).sort()
    expect(conflicting, `blocked-but-invoked: ${conflicting.join(', ')}`).toEqual([])
  })
})
