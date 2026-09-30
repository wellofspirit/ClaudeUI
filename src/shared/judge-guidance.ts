/**
 * The entry rules for text ClaudeUI writes into the auto-mode judge's SYSTEM
 * PROMPT (ADR-083 §3/§4), defined ONCE for every place that enforces them:
 *
 * - the IPC perimeter (`core/ipc/config-commands.ts`), which refuses a bad
 *   `config:save-shared-automode` payload;
 * - the environment builder (`core/automode/environment.ts`), which drops bad
 *   entries again on read, for a hand-edited file that never came through IPC;
 * - the settings UI (`SettingsDialog/TrustLists.tsx`), which refuses to add an
 *   entry the perimeter would reject, so a save can never fail on it silently.
 *
 * In `shared/` rather than `core/` because the renderer needs it too, and the
 * three copies drifting apart is exactly the failure this file exists to stop:
 * a UI that accepts what the perimeter refuses loses the user's entry.
 */

/** At most this many entries per guidance list (`judgeAllow` / `judgeBlock`). */
export const JUDGE_GUIDANCE_MAX_ENTRIES = 50

/** At most this many characters (code points) per guidance entry. */
export const JUDGE_GUIDANCE_MAX_ENTRY_CHARS = 300

/**
 * True when `value` holds a character that could break the one-line rendering
 * every rule, list and guidance entry gets in the judge prompt: the C0 controls
 * (CR, LF and tab included), DEL, the C1 controls (NEL included) and the
 * Unicode line/paragraph separators. An embedded line break is the dangerous one
 * — it could forge a `### Rule` heading or a fake Environment line — the rest
 * are refused because no legitimate entry contains them.
 *
 * A code-point loop rather than a regex so the lint rule against control
 * characters in regular expressions needs no exemption.
 */
export function hasPromptBreakingChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true
    }
  }
  return false
}

/** Length in code points — the unit the user means by "characters". */
export function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * Why one guidance entry is unacceptable, as short user-facing copy, or `null`
 * when it is fine. Checks the per-ENTRY rules only (characters, length); the
 * count cap is a property of the list and is checked by the caller.
 */
export function judgeGuidanceEntryError(entry: string): string | null {
  if (hasPromptBreakingChar(entry)) return 'Use one line of plain text — no tabs or line breaks.'
  if (codePointLength(entry) > JUDGE_GUIDANCE_MAX_ENTRY_CHARS) {
    return `Keep each entry to ${JUDGE_GUIDANCE_MAX_ENTRY_CHARS} characters or fewer.`
  }
  return null
}
