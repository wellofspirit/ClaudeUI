/**
 * @vitest-environment node
 *
 * Pins the strings ClaudeUI recognises in Claude Code's auto-mode fallbacks against the vendored
 * `vendor/claude-cli/cli.js` (ADR-105 §3, slice B-3c).
 *
 * The frame of a denied `hand_back` carries no flag for "the classifier refused" or "the classifier
 * gave no verdict": `handBackReviewOf` tells them apart by cli.js's own wording. A Claude Code bump
 * that rewords one would silently downgrade a flagged report to a note (the other tell still
 * matches), so this fails loudly instead, in the harness bump's gates. The constants are imported
 * from the source, not copied, so the test cannot drift from what the code matches.
 */

import { describe, it, expect } from 'vitest'
import { cliJsExists, readCliJs } from '../../test/helpers/patch-harness'
import {
  CLASSIFIER_UNAVAILABLE_REASON,
  COULD_NOT_EVALUATE_REASON,
  NO_VERDICT_MESSAGE_TELL,
  NO_VERDICT_STREAK_REASON,
  REFUSED_MESSAGE_TELL,
  TRANSCRIPT_TOO_LONG_CODE
} from '../../core/services/claude-permission-decision'

// ~40 MB: read once.
const src = cliJsExists() ? readCliJs() : ''

/** The text as cli.js spells it in a string literal: non-ASCII characters are `\uXXXX` escapes. */
function asLiteral(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

describe.skipIf(!cliJsExists())(
  'Claude Code auto-mode fallbacks ClaudeUI recognises (vendor/claude-cli/cli.js)',
  () => {
    const wording: Array<[string, string]> = [
      ['refusal tell (message, yGt refused)', REFUSED_MESSAGE_TELL],
      ['no-verdict tell (message, yGt / Tvn / transcript too long)', NO_VERDICT_MESSAGE_TELL],
      ['"could not evaluate" reason (RHn)', COULD_NOT_EVALUATE_REASON],
      ['"classifier unavailable" reason (fFe)', CLASSIFIER_UNAVAILABLE_REASON],
      ['no-verdict streak reason (CHn)', NO_VERDICT_STREAK_REASON],
      ['transcript-too-long code', TRANSCRIPT_TOO_LONG_CODE]
    ]
    it.each(wording)('%s is still in cli.js, as ClaudeUI matches it', (_what, text) => {
      expect(
        src.includes(text) || src.includes(asLiteral(text)),
        `cli.js no longer contains ${JSON.stringify(text)}: update claude-permission-decision.ts (and docs/protocol-cc/14 §11) for the new wording`
      ).toBe(true)
    })
  }
)
