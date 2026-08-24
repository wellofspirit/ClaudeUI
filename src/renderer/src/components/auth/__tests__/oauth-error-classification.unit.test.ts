/**
 * The joint between the renderer's outcome mapping and the messages the BACKEND
 * actually throws (ADR-057 / S4-UI).
 *
 * `classifyOAuthError` keys the mockup's two named outcomes off substrings of
 * real backend errors. Nothing in the type system connects the two — a reworded
 * throw would silently demote a "start again from step 1" or a "use the desktop"
 * into the generic verbatim branch, which still LOOKS fine on screen and is
 * therefore exactly the kind of drift nobody notices.
 *
 * So this test reads the two source files and asserts (a) the literal is still
 * there, and (b) classifying that same literal still produces the intended kind.
 * Same shape as the sealed-field lint guard, for the same reason.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyOAuthError } from '../OAuthPasteBackFlow'

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), 'utf8')

describe('the CSRF/state rejection', () => {
  const CSRF_MESSAGE = 'Invalid state - potential CSRF attack'

  it('is still what codex-oauth.ts throws on both completion paths', () => {
    const source = read('src', 'core', 'auth', 'vault', 'codex-oauth.ts')
    // The loopback handler and the paste-back path each raise it independently.
    const occurrences = source.split(CSRF_MESSAGE).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('classifies as the mockup state-mismatch outcome', () => {
    expect(classifyOAuthError(CSRF_MESSAGE)).toBe('state-mismatch')
  })
})

describe("the remote refusal of opencode's `auto` method", () => {
  const REFUSAL_FRAGMENT = 'only completes on the host machine'

  it('is still what auth-commands.ts throws for a remote caller', () => {
    const source = read('src', 'core', 'ipc', 'auth-commands.ts')
    expect(source).toContain(REFUSAL_FRAGMENT)
  })

  it('classifies as the desktop-only outcome', () => {
    expect(
      classifyOAuthError(
        `opencode's automatic browser sign-in ${REFUSAL_FRAGMENT}. ` +
          "Choose the 'paste a code' method, or sign in from the desktop app."
      )
    ).toBe('desktop-only')
  })
})
