/**
 * @vitest-environment node
 *
 * R5 parity guard — every channel the web api-adapter invokes MUST have a
 * registered remote handler. This prevents the whole class of gap the remote
 * client hit before R5 (git:*, account:get, live watching, multi-engine
 * catalogs, title/commit generation, … all threw "Channel not available").
 *
 * It's a static SOURCE scan on purpose: importing the web api-adapter (browser
 * module) and remote-handlers (full Electron/service graph) into one test would
 * be heavy and fragile. The scan pairs the two source files instead, so a future
 * api-adapter invoke with no matching registration fails CI.
 *
 * Since SyncCore phase 1 the dispatcher denylist is gone: reachability is
 * "registered for the remote transport AND capability ∈ grants". The third test
 * below therefore checks the CAPABILITY each invoked channel declares instead
 * of denylist membership — the capability is what can now silently make a
 * channel unreachable. (The behavioral twin of this file, running against the
 * real registry, is the parity pin in remote-handlers.ipc.test.ts.)
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { LEGACY_REMOTE_GRANTS, type Capability } from '../command-registry'

const REPO = process.cwd()
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf-8')

/**
 * Remote channels whose capability (`shell`) is deliberately NOT in the base
 * grant set — they are reachable only after the step-up ceremony. Sorted, and
 * kept in sync with the registrations in remote-handlers.ts.
 */
const SHELL_GATED_REMOTE_CHANNELS = [
  'terminal:attach',
  'terminal:create',
  'terminal:detach',
  'terminal:kill'
]

/** Channels the web client invokes over the WS (connection.invoke / unwrap). */
function invokedChannels(): Set<string> {
  const src = read('src/web/api-adapter.ts')
  const set = new Set<string>()
  const re = /(?:connection\.invoke|unwrap)\(\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) set.add(m[1])
  return set
}

/** channel → declared capability, parsed from remote-handlers.ts registrations. */
function remoteDeclarations(): Map<string, Capability> {
  const src = read('src/main/ipc/remote-handlers.ts')
  const map = new Map<string, Capability>()
  const re = /channel:\s*['"]([^'"]+)['"],\s*capability:\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) map.set(m[1], m[2] as Capability)
  return map
}

describe('remote channel parity (R5)', () => {
  it('the scan actually finds channels (non-vacuity)', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    // If a regex broke, these would be empty and the coverage test below would
    // pass vacuously — anchor on channels we know exist.
    expect(invoked.size).toBeGreaterThan(30)
    expect(invoked.has('git:commit')).toBe(true)
    expect(invoked.has('account:get')).toBe(true)
    expect(declared.get('git:commit')).toBe('git')
    expect(declared.size).toBeGreaterThan(50)
  })

  it('every invoked channel has a registered remote handler', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    const missing = [...invoked].filter((c) => !declared.has(c)).sort()
    // Surfacing the list makes a regression immediately actionable.
    expect(missing, `api-adapter invokes these with no remote handler: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('no invoked channel declares a capability remote connections lack', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    const ungranted = [...invoked]
      .filter((c) => declared.has(c) && !LEGACY_REMOTE_GRANTS.has(declared.get(c)!))
      .sort()
    // The terminal channels are the ONE deliberate exception (SyncCore phase 2,
    // ADR-052 decision 6): they declare `shell`, which authentication alone
    // never grants. The web client invokes them only after
    // `terminal:availability` says the toggle is on and a step-up has armed the
    // grant — "not grantable at connect time" is the point, not a gap.
    expect(
      ungranted,
      `invoked but not grantable: ${ungranted.map((c) => `${c}(${declared.get(c)})`).join(', ')}`
    ).toEqual(SHELL_GATED_REMOTE_CHANNELS)
  })
})
