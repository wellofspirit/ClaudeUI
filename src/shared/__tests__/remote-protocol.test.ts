/**
 * Guards for the string-matched error predicates in `remote-protocol.ts`.
 *
 * Every one of these is a CROSS-MODULE coupling: main throws a message, a
 * client branches on it, and nothing but a test connects the two. The literals
 * below are copied from the producing call sites, so a rewording there fails
 * here instead of silently turning a UI branch into dead code.
 */

import { describe, it, expect } from 'vitest'
import {
  isEnrollNotPermittedError,
  isNeedsStepUpError,
  isTerminalDisabledError,
  NEEDS_STEP_UP_ERROR,
  TERMINAL_DISABLED_ERROR
} from '../remote-protocol'

/**
 * A hand-written stand-in for `command-registry.ts`'s capability refusal:
 *   `Permission denied: "${channel}" requires the "${entry.capability}" capability`
 * (the dispatcher wraps it in an Error, and the WS transport hands the client
 * back `err.message`).
 *
 * These are SHAPE tests only — a copy of the wording cannot notice the wording
 * changing. The load-bearing pin runs the predicate over a real
 * `registry.dispatch` refusal in `main/ipc/__tests__/command-registry.test.ts`.
 */
const registryDenial = (channel: string, capability: string): string =>
  `Permission denied: "${channel}" requires the "${capability}" capability`

describe('isEnrollNotPermittedError', () => {
  it('matches the registry refusal for both enroll verbs (GUARD)', () => {
    // This is the EXPECTED answer under effective-`legacy`: a break-glass
    // password connection holds no `enroll`, so the first passkey must come
    // from the desktop. The client renders guidance off exactly this predicate.
    expect(isEnrollNotPermittedError(registryDenial('webauthn:register-options', 'enroll'))).toBe(
      true
    )
    expect(
      isEnrollNotPermittedError(new Error(registryDenial('webauthn:register-verify', 'enroll')))
    ).toBe(true)
  })

  it('does NOT match a refusal for a different capability', () => {
    // Otherwise a `shell` or `admin` denial would render "enroll from the
    // desktop", which is advice for a problem the user does not have.
    expect(isEnrollNotPermittedError(registryDenial('terminal:create', 'shell'))).toBe(false)
    expect(isEnrollNotPermittedError(registryDenial('webauthn:revoke', 'admin'))).toBe(false)
    // GUARD for the trap this predicate was tightened to avoid: the channel
    // NAME contains "enroll" while the refused capability is `admin`.
    expect(isEnrollNotPermittedError(registryDenial('webauthn:mint-enroll-token', 'admin'))).toBe(
      false
    )
  })

  it('does not match unrelated failures', () => {
    expect(isEnrollNotPermittedError('Channel not available: webauthn:register-options')).toBe(
      false
    )
    expect(isEnrollNotPermittedError(undefined)).toBe(false)
    expect(isEnrollNotPermittedError(null)).toBe(false)
  })
})

describe('the shell-gate predicates still match their constants', () => {
  it('needs-step-up / terminal-disabled', () => {
    expect(isNeedsStepUpError(new Error(NEEDS_STEP_UP_ERROR))).toBe(true)
    expect(isTerminalDisabledError(new Error(TERMINAL_DISABLED_ERROR))).toBe(true)
    expect(isNeedsStepUpError(new Error(TERMINAL_DISABLED_ERROR))).toBe(false)
  })
})
