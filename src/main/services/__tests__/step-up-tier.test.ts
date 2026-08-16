/**
 * @vitest-environment node
 *
 * The ADR-054 step-up tier table, as a table.
 *
 * Everything here is a pure function over an explicit state, which is the whole
 * reason `step-up-tier.ts` is shaped the way it is: the enforcement matrix is
 * tier × dispatch-class × presence, and asserting it through a live socket
 * would cover perhaps a tenth of the cells. The socket-level twin
 * (`remote-step-up-tiers.test.ts`) proves the transport actually CONSULTS this
 * table; this file proves the table is right.
 *
 * The classification pins matter as much as the decisions. The passkeys work
 * shipped a defect where two functions restated one rule and drifted, so the
 * read/act verb sets have exactly one definition and these tests import it —
 * plus a coverage pin, so a new shell verb that nobody classified fails here.
 */

import { describe, it, expect } from 'vitest'
import {
  AUTHCFG_CHANNELS,
  AUTHCFG_FREE_CHANNELS,
  SHELL_ACT_VERBS,
  SHELL_READ_VERBS,
  TERM_INPUT_CLASS,
  TERM_RESIZE_CLASS,
  classifyDispatch,
  evaluateStepUp,
  mutationIdleMs,
  presenceOf,
  MAX_SESSION_MAX_AGE_HOURS,
  MAX_TIMER_MS,
  resolveStepUpTier,
  sessionMaxAgeMs,
  shellActAllowed,
  shellReadAllowed,
  authcfgAllowed,
  tierOf,
  type DispatchClass,
  type PresenceState
} from '../step-up-tier'
import {
  PINNED_CAPABILITIES,
  makeRemoteConnection,
  desktopConnection,
  type Capability,
  type CommandKind
} from '../../ipc/command-registry'
import type { RemoteAuthPolicy, StepUpTier } from '../../../shared/types'

const NOW = 1_000_000

/** A remote connection's presence, with everything armed unless overridden. */
function armed(over: Partial<PresenceState> = {}): PresenceState {
  return {
    exempt: false,
    armedEver: true,
    shellActExpiresAt: NOW + 60_000,
    mutationExpiresAt: NOW + 600_000,
    // Locked by default: the settings editor is a mode you ENTER, so "everything
    // armed" must not quietly include it (ADR-054 §6 amendment).
    settingsSessionExpiresAt: null,
    ...over
  }
}

/** Never armed: the state every remote connection starts in. */
const NEVER_ARMED: PresenceState = {
  exempt: false,
  armedEver: false,
  shellActExpiresAt: null,
  mutationExpiresAt: null,
  settingsSessionExpiresAt: null
}

/** Armed once, then both windows elapsed. */
const DECAYED: PresenceState = {
  exempt: false,
  armedEver: true,
  shellActExpiresAt: NOW - 1,
  mutationExpiresAt: NOW - 1,
  settingsSessionExpiresAt: null
}

/** Armed AND holding an open settings-editing session (the 2026-08-16 amendment). */
const UNLOCKED: PresenceState = {
  exempt: false,
  armedEver: true,
  shellActExpiresAt: NOW + 60_000,
  mutationExpiresAt: NOW + 600_000,
  settingsSessionExpiresAt: NOW + 300_000
}

/** Armed, shell act window elapsed, mutation window still fresh. */
const ACT_DECAYED: PresenceState = {
  exempt: false,
  armedEver: true,
  shellActExpiresAt: NOW - 1,
  mutationExpiresAt: NOW + 600_000,
  settingsSessionExpiresAt: null
}

const decide = (tier: StepUpTier, cls: DispatchClass, presence: PresenceState) =>
  evaluateStepUp({ tier, cls, presence, now: NOW })

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

describe('resolveStepUpTier', () => {
  it('auth-mode `off` FORCES tier `off`, whatever is stored', () => {
    // ADR-054 decision 3, flat and with no origin carve-outs: you cannot demand
    // a ceremony from an identity that was never established.
    for (const stored of ['strong', 'medium', 'off'] as const) {
      expect(resolveStepUpTier('off', stored), stored).toBe('off')
    }
  })

  it('passes the stored tier through under every OTHER mode', () => {
    for (const policy of ['legacy', 'passkey-always'] as const satisfies RemoteAuthPolicy[]) {
      for (const stored of ['strong', 'medium', 'off'] as const) {
        expect(resolveStepUpTier(policy, stored), `${policy}/${stored}`).toBe(stored)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Classification — ONE source, and it covers the surface
// ---------------------------------------------------------------------------

describe('classifyDispatch', () => {
  const cases: Array<[string, Capability | undefined, CommandKind | undefined, DispatchClass]> = [
    // Shell reads: watching costs one arming proof, never freshness.
    ['terminal:attach', 'shell', 'command', 'shell-read'],
    ['terminal:detach', 'shell', 'command', 'shell-read'],
    ['terminal:resize', 'shell', 'command', 'shell-read'],
    ['terminal:pool', 'shell', 'query', 'shell-read'],
    // Shell acts.
    ['terminal:create', 'shell', 'command', 'shell-act'],
    ['terminal:write', 'shell', 'command', 'shell-act'],
    ['terminal:kill', 'shell', 'command', 'shell-act'],
    ['terminal:kill-by-cwd', 'shell', 'command', 'shell-act'],
    // The settings area.
    ['authcfg:apply', 'admin', 'command', 'authcfg'],
    ['authcfg:end', 'admin', 'command', 'read'],
    ['authcfg:set-password', 'admin', 'command', 'authcfg'],
    // Ordinary mutations and reads.
    ['session:send', 'chat', 'command', 'mutation'],
    ['git:commit', 'git', 'command', 'mutation'],
    ['webauthn:revoke', 'admin', 'command', 'mutation'],
    ['config:load-settings', 'config', 'query', 'read'],
    ['terminal:availability', 'config', 'query', 'read'],
    ['webauthn:credentials', 'admin', 'query', 'read']
  ]

  it.each(cases)('%s (%s/%s) → %s', (channel, capability, kind, expected) => {
    expect(classifyDispatch({ channel, capability, kind })).toBe(expected)
  })

  it('classifies an UNKNOWN shell verb as ACTING (fail closed)', () => {
    // The failure mode of forgetting to classify a new terminal channel must be
    // "it demands freshness", never "it is free forever".
    expect(
      classifyDispatch({ channel: 'terminal:brand-new', capability: 'shell', kind: 'query' })
    ).toBe('shell-act')
  })

  it('lets the explicit verb set beat `kind` in BOTH directions', () => {
    // `terminal:attach` is a `command` that reads (declared `command` so the
    // audit trail carries terminal lifecycle); `terminal:pool` is a `query` that
    // is still a shell read (the operator's live-shell inventory is sensitive).
    // Deriving the split from `kind` would be wrong in exactly these two cases.
    expect(classifyDispatch({ channel: 'terminal:attach', capability: 'shell', kind: 'command' }))
      .toBe('shell-read')
    expect(classifyDispatch({ channel: 'terminal:pool', capability: 'shell', kind: 'query' }))
      .toBe('shell-read')
  })

  it('the read and act verb sets are disjoint', () => {
    const both = [...SHELL_READ_VERBS].filter((v) => SHELL_ACT_VERBS.has(v))
    expect(both, `these verbs are classified BOTH ways: ${both.join(', ')}`).toEqual([])
  })

  it('every `shell`-PINNED channel is classified explicitly', () => {
    // The pinned table is the static half of the surface (it includes the
    // desktop-only `terminal:kill-by-cwd`); the live-registry twin of this pin
    // lives in `ipc/__tests__/remote-handlers.ipc.test.ts`, where every channel
    // is actually registered. A new shell verb has to fail one of the two.
    const pinnedShell = Object.entries(PINNED_CAPABILITIES)
      .filter(([, cap]) => cap === 'shell')
      .map(([channel]) => channel)
    const unclassified = pinnedShell.filter(
      (c) => !SHELL_READ_VERBS.has(c) && !SHELL_ACT_VERBS.has(c)
    )
    expect(unclassified, `unclassified shell verbs: ${unclassified.join(', ')}`).toEqual([])
  })

  it('the terminal FRAMES mirror their invoke twins', () => {
    // A frame and the invoke that does the same thing must never be judged
    // differently — `term-input` is `terminal:write`, `term-resize` is
    // `terminal:resize`.
    expect(TERM_INPUT_CLASS).toBe(
      classifyDispatch({ channel: 'terminal:write', capability: 'shell', kind: 'command' })
    )
    expect(TERM_RESIZE_CLASS).toBe(
      classifyDispatch({ channel: 'terminal:resize', capability: 'shell', kind: 'command' })
    )
  })

  it('the authcfg namespace splits into GATED mutations and FREE verbs', () => {
    // `authcfg:get` reads, and `authcfg:end` only gives authority back — gating
    // a revocation would mean an operator whose mutation window had lapsed could
    // open an editor under `strong` and then be refused permission to close it.
    expect([...AUTHCFG_CHANNELS].sort()).toEqual(['authcfg:apply', 'authcfg:set-password'])
    expect([...AUTHCFG_FREE_CHANNELS].sort()).toEqual(['authcfg:end', 'authcfg:get'])
  })
})

// ---------------------------------------------------------------------------
// The enforcement matrix
// ---------------------------------------------------------------------------

describe('evaluateStepUp — the tier × class × state matrix', () => {
  it('the desktop MessagePort is exempt from every cell', () => {
    const exempt = armed({ exempt: true, armedEver: false, shellActExpiresAt: null, mutationExpiresAt: null })
    for (const tier of ['strong', 'medium', 'off'] as const) {
      for (const cls of ['read', 'shell-read', 'shell-act', 'authcfg', 'mutation'] as const) {
        const d = decide(tier, cls, exempt)
        expect(d.allow, `${tier}/${cls}`).toBe(true)
        // …and nothing is written to windows that do not exist.
        expect(d.refresh, `${tier}/${cls}`).toEqual([])
      }
    }
  })

  it('a `query` is free on every tier, in every state, and refreshes nothing', () => {
    for (const tier of ['strong', 'medium', 'off'] as const) {
      for (const [name, presence] of Object.entries({ armed: armed(), NEVER_ARMED, DECAYED })) {
        const d = decide(tier, 'read', presence as PresenceState)
        expect(d.allow, `${tier}/${name}`).toBe(true)
        expect(d.refresh, `${tier}/${name}`).toEqual([])
      }
    }
  })

  describe('tier `off` — nothing is gated post-login', () => {
    it('allows every NON-settings class in every state, and writes no window state', () => {
      for (const cls of ['read', 'shell-read', 'shell-act', 'mutation'] as const) {
        for (const [name, presence] of Object.entries({ armed: armed(), NEVER_ARMED, DECAYED })) {
          const d = decide('off', cls, presence as PresenceState)
          expect(d.allow, `${cls}/${name}`).toBe(true)
          expect(d.refresh, `${cls}/${name}`).toEqual([])
        }
      }
    })

    it('still demands a fresh proof for the SETTINGS area', () => {
      // ADR-054 decisions 3 and 6 collide on an explicitly-`off` tier, and the
      // order is resolved in favour of 6: an operator choosing "don't nag me
      // post-login" chose it for chat and shell, not for the surface that
      // decides who may connect at all.
      //
      // Decision 3's flat waiver is untouched in SUBSTANCE: under auth-MODE
      // `off` a connection holds the as-built grant set and never `admin`, so it
      // can never administer this surface. The ORDER is the other way round from
      // the obvious telling, though — the transport checks freshness before
      // capability, so such a connection sees `needs-step-up` first and
      // `Permission denied` only after a step-up. Both walls are pinned over a
      // real socket in remote-step-up-tiers.test.ts.
      expect(decide('off', 'authcfg', NEVER_ARMED).allow).toBe(false)
      expect(decide('off', 'authcfg', DECAYED).allow).toBe(false)
      // The 2026-08-16 amendment: a live EDITING SESSION is the test now, not
      // the window. `armed()` deliberately leaves the editor locked.
      expect(decide('off', 'authcfg', armed()).allow).toBe(false)
      expect(decide('off', 'authcfg', UNLOCKED).allow).toBe(true)
    })
  })

  describe('the shell read/act split (medium AND strong)', () => {
    for (const tier of ['medium', 'strong'] as const) {
      it(`${tier}: an armed connection READS after the act window decays`, () => {
        // The ratified liberation: an attached view keeps streaming and
        // `terminal:pool` keeps answering long after the last keystroke.
        expect(decide(tier, 'shell-read', ACT_DECAYED).allow).toBe(true)
        expect(decide(tier, 'shell-read', DECAYED).allow).toBe(true)
      })

      it(`${tier}: reads never slide either window`, () => {
        expect(decide(tier, 'shell-read', armed()).refresh).toEqual([])
      })

      it(`${tier}: a NEVER-armed connection cannot even read`, () => {
        // First access ever costs one arming proof: scrollback and the live-shell
        // inventory are sensitive.
        expect(decide(tier, 'shell-read', NEVER_ARMED).allow).toBe(false)
      })

      it(`${tier}: acting demands the act window`, () => {
        expect(decide(tier, 'shell-act', armed()).allow).toBe(true)
        expect(decide(tier, 'shell-act', ACT_DECAYED).allow).toBe(false)
        expect(decide(tier, 'shell-act', NEVER_ARMED).allow).toBe(false)
      })

      it(`${tier}: an act refreshes BOTH windows (acting is presence)`, () => {
        expect([...decide(tier, 'shell-act', armed()).refresh].sort()).toEqual([
          'mutation',
          'shellAct'
        ])
      })

      it(`${tier}: the strong-tier mutation window never double-gates a shell verb`, () => {
        // Shell channels are governed EXCLUSIVELY by the split. A fresh act
        // window with a DEAD mutation window still acts.
        const actFreshMutationDead = armed({ mutationExpiresAt: NOW - 1 })
        expect(decide(tier, 'shell-act', actFreshMutationDead).allow).toBe(true)
        expect(decide(tier, 'shell-read', actFreshMutationDead).allow).toBe(true)
      })
    }
  })

  describe('tier `medium` — today’s shipped behavior, named', () => {
    it('lets every non-shell mutation through regardless of freshness', () => {
      expect(decide('medium', 'mutation', NEVER_ARMED).allow).toBe(true)
      expect(decide('medium', 'mutation', DECAYED).allow).toBe(true)
      expect(decide('medium', 'mutation', armed()).allow).toBe(true)
    })

    it('writes NO window state for an unarmed connection (byte-identical dispatch)', () => {
      // The zero-regression pin: a token connection under the default tier takes
      // exactly the pre-ADR-054 path — allowed, and nothing recorded.
      const d = decide('medium', 'mutation', NEVER_ARMED)
      expect(d).toEqual({ allow: true, refresh: [] })
    })

    it('an ARMED connection still slides its mutation window on a mutation', () => {
      expect(decide('medium', 'mutation', armed()).refresh).toEqual(['mutation'])
    })
  })

  describe('tier `strong` — nothing stays alive forever', () => {
    it('demands the mutation window for every non-shell command', () => {
      expect(decide('strong', 'mutation', armed()).allow).toBe(true)
      expect(decide('strong', 'mutation', DECAYED).allow).toBe(false)
      expect(decide('strong', 'mutation', NEVER_ARMED).allow).toBe(false)
    })

    it('leaves reads and the act window independent of it', () => {
      // Mutation window dead, act window alive: shell acts still work, chat does
      // not. The two windows are separate proofs of separate things.
      const s = armed({ mutationExpiresAt: NOW - 1 })
      expect(decide('strong', 'shell-act', s).allow).toBe(true)
      expect(decide('strong', 'mutation', s).allow).toBe(false)
      expect(decide('strong', 'read', s).allow).toBe(true)
    })
  })

  describe('the settings area (`authcfg`) demands a live EDITING SESSION on EVERY tier', () => {
    for (const tier of ['medium', 'strong', 'off'] as const) {
      it(`${tier}: only an unlocked editor gets through`, () => {
        expect(decide(tier, 'authcfg', UNLOCKED).allow).toBe(true)
        expect(decide(tier, 'authcfg', armed()).allow).toBe(false)
        expect(decide(tier, 'authcfg', DECAYED).allow).toBe(false)
        expect(decide(tier, 'authcfg', NEVER_ARMED).allow).toBe(false)
      })
    }

    it('a FRESH MUTATION WINDOW does not open it — the amendment, in one cell', () => {
      // THE regression this amendment exists to make impossible. Before it, this
      // exact presence — armed, mutation window fresh — WAS the whole test, which
      // made administering an ambient capability held by any connection that had
      // recently done anything at all. A session is the only key now, and a
      // window cannot be mistaken for one.
      const windowFresh = armed({ mutationExpiresAt: NOW + 600_000 })
      expect(decide('medium', 'mutation', windowFresh).allow).toBe(true)
      expect(decide('medium', 'authcfg', windowFresh).allow).toBe(false)
      expect(decide('strong', 'authcfg', windowFresh).allow).toBe(false)
    })

    it('an EXPIRED session is refused — expiry is lazy, not remembered', () => {
      // No timer clears the field; the table simply stops honouring it. A
      // deadline one millisecond in the past is a locked editor.
      expect(
        decide('medium', 'authcfg', armed({ settingsSessionExpiresAt: NOW - 1 })).allow
      ).toBe(false)
      expect(
        decide('medium', 'authcfg', armed({ settingsSessionExpiresAt: NOW + 1 })).allow
      ).toBe(true)
    })

    it('refuses with `settings-session`, never with the ambient `step-up`', () => {
      // The client's generic gate cures `step-up` transparently and must NOT
      // cure this one. The table names the refusal so the transport cannot pair
      // the wrong two.
      for (const tier of ['medium', 'strong', 'off'] as const) {
        expect(decide(tier, 'authcfg', NEVER_ARMED).refusal, tier).toBe('settings-session')
      }
      expect(decide('strong', 'mutation', DECAYED).refusal).toBe('step-up')
      expect(decide('medium', 'shell-act', DECAYED).refusal).toBe('step-up')
    })

    it('nothing REFRESHES the session — it is a fixed-length mode', () => {
      // A sliding session would be the ambient authority again, wearing a
      // countdown. No decision may ever ask for one.
      for (const tier of ['medium', 'strong', 'off'] as const) {
        for (const cls of ['read', 'shell-read', 'shell-act', 'authcfg', 'mutation'] as const) {
          const d = decide(tier, cls, UNLOCKED)
          expect(d.refresh as readonly string[], `${tier}/${cls}`).not.toContain('settings')
        }
      }
    })
  })

  it('a refusal never asks for a refresh', () => {
    for (const tier of ['strong', 'medium', 'off'] as const) {
      for (const cls of ['read', 'shell-read', 'shell-act', 'authcfg', 'mutation'] as const) {
        for (const presence of [armed(), NEVER_ARMED, DECAYED, ACT_DECAYED]) {
          const d = decide(tier, cls, presence)
          if (!d.allow) expect(d.refresh, `${tier}/${cls}`).toEqual([])
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Connection adapters
// ---------------------------------------------------------------------------

describe('presenceOf / tierOf', () => {
  it('reads a fresh remote connection as unarmed, medium, nothing held', () => {
    const conn = makeRemoteConnection('token', null)
    expect(presenceOf(conn)).toEqual({
      exempt: false,
      armedEver: false,
      shellActExpiresAt: null,
      mutationExpiresAt: null,
      settingsSessionExpiresAt: null
    })
    expect(tierOf(conn)).toBe('medium')
  })

  it('reads the desktop connection as EXEMPT (the ADR-052 sentinel, unchanged)', () => {
    // `shellGrantExpiresAt === undefined` stays the ONE exemption test, so the
    // two axes cannot disagree about who is the host surface.
    expect(presenceOf(desktopConnection()).exempt).toBe(true)
    expect(shellReadAllowed(desktopConnection())).toBe(true)
    expect(shellActAllowed(desktopConnection())).toBe(true)
    expect(authcfgAllowed(desktopConnection())).toBe(true)
  })

  it('carries the tier the connection was admitted under', () => {
    expect(tierOf(makeRemoteConnection('webauthn', 'Phone', undefined, { stepUpTier: 'strong' })))
      .toBe('strong')
  })

  it('the convenience predicates agree with the table they wrap', () => {
    const conn = makeRemoteConnection('webauthn', 'Phone', undefined, { stepUpTier: 'medium' })
    expect(shellReadAllowed(conn)).toBe(false)
    expect(shellActAllowed(conn)).toBe(false)
    conn.armedEver = true
    conn.shellGrantExpiresAt = Date.now() - 1
    expect(shellReadAllowed(conn)).toBe(true)
    expect(shellActAllowed(conn)).toBe(false)
    conn.shellGrantExpiresAt = Date.now() + 60_000
    expect(shellActAllowed(conn)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Window sizing
// ---------------------------------------------------------------------------

describe('window sizing', () => {
  it('defaults, clamps and rejects nonsense for the mutation window', () => {
    expect(mutationIdleMs(undefined)).toBe(60 * 60_000)
    expect(mutationIdleMs(Number.NaN)).toBe(60 * 60_000)
    expect(mutationIdleMs(15)).toBe(15 * 60_000)
    // 0 ("never expires") is not on offer — freshness is the point.
    expect(mutationIdleMs(0)).toBe(60_000)
    expect(mutationIdleMs(99_999)).toBe(24 * 60 * 60_000)
  })

  it('defaults and clamps the session max-age', () => {
    expect(sessionMaxAgeMs(undefined)).toBe(4 * 3_600_000)
    expect(sessionMaxAgeMs(2)).toBe(2 * 3_600_000)
    expect(sessionMaxAgeMs(0)).toBe(3_600_000)
  })

  it('never produces a budget `setTimeout` would silently wrap', () => {
    // `setTimeout` takes a SIGNED 32-BIT delay. Above 2^31-1 ms it wraps and the
    // timer fires on the next tick — which for the max-age cut means every
    // strong-tier socket is closed ~1 ms after accept and the client's reconnect
    // loop hammers the server forever. A legal setting must never be able to
    // produce that, so the ceiling is a week and every value at or above it
    // clamps well under the wrap point.
    expect(sessionMaxAgeMs(MAX_SESSION_MAX_AGE_HOURS)).toBe(
      MAX_SESSION_MAX_AGE_HOURS * 3_600_000
    )
    expect(sessionMaxAgeMs(MAX_SESSION_MAX_AGE_HOURS)).toBeLessThan(MAX_TIMER_MS)
    // The range that used to pass validation and detonate: 597–720 hours.
    for (const hours of [597, 700, 720, 100_000]) {
      expect(sessionMaxAgeMs(hours), `${hours}h`).toBe(MAX_SESSION_MAX_AGE_HOURS * 3_600_000)
      expect(sessionMaxAgeMs(hours), `${hours}h`).toBeLessThan(MAX_TIMER_MS)
    }
    // A row hand-edited (or written by an older build) to the old 30-day
    // ceiling degrades on READ rather than detonating.
    expect(sessionMaxAgeMs(24 * 30)).toBe(MAX_SESSION_MAX_AGE_HOURS * 3_600_000)
  })
})
