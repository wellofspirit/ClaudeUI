import type { ClaudePermissions, SharedAutoModeConfig } from '../../shared/types'
import {
  JUDGE_GUIDANCE_MAX_ENTRIES,
  JUDGE_GUIDANCE_MAX_ENTRY_CHARS,
  codePointLength,
  hasPromptBreakingChar
} from '../../shared/judge-guidance'
import type { RepoVisibility } from './ground-truth'
import type { EnvironmentInfo } from './rules/policy'

/**
 * The classifier's Environment section, built ONCE for every engine that runs
 * ClaudeUI's own judge (opencode and pi — ADR-023, ADR-083 §3/§4).
 *
 * The two sessions used to carry near-identical copies of this body, which is
 * exactly the shape where a fix lands in one engine and misses the other. The
 * sessions still own WHERE each input comes from — and therefore its freshness:
 * opencode re-reads the user's permission scopes on every approval, pi serves
 * them from its `cachedRules` until a rule write invalidates it — and this
 * function owns only what the judge is told. It is pure: no file, git or
 * process access, so the whole mapping is unit-testable from plain objects.
 *
 * Omission is the load-bearing encoding throughout. The policy renders the
 * restrictive fallback text for an ABSENT slot ("nothing is trusted", "none
 * configured", the unknown-visibility guidance), so an empty list or an
 * unknown visibility is left out rather than reported — and the policy prompt's
 * byte-stability across approvals depends on the same inputs always producing
 * the same object.
 */
export interface ClassifierEnvironmentInput {
  cwd: string
  /** `process.platform` of the host that runs the tools. */
  platform: string
  /** Session-start git remotes (the push-rule trust anchor). */
  remotes: Array<{ name: string; url: string }>
  /**
   * The session's resolved visibility, or `null`/`undefined` while resolution
   * has not finished. Only a DEFINITE answer is reported: `'unknown'` (and
   * not-yet-resolved) render the policy's "assume PRIVATE for confidentiality,
   * assume PUBLIC for secret exposure" guidance, which is strictly more useful
   * than the bare word.
   */
  repoVisibility: RepoVisibility | null | undefined
  /** The user's merged allow/ask/deny rules and granted directories (all scopes). */
  permissions: Pick<ClaudePermissions, 'allow' | 'ask' | 'deny' | 'additionalDirectories'>
  /** The engine-shared `~/.claude/ui/automode.json`. */
  shared: SharedAutoModeConfig
}

/**
 * The per-list read rules. Every list drops non-strings, blank entries and
 * entries carrying a prompt-breaking character; the rest is list-specific.
 */
interface ListRules {
  /** Dedupe on the exact string, keeping the FIRST occurrence. */
  dedupe?: boolean
  /** Drop entries longer than this many code points. */
  maxChars?: number
  /** Keep at most the first this-many surviving entries. */
  maxEntries?: number
}

/** The judge guidance lists: deduped and held to the perimeter's caps on read. */
const GUIDANCE_RULES: ListRules = {
  dedupe: true,
  maxChars: JUDGE_GUIDANCE_MAX_ENTRY_CHARS,
  maxEntries: JUDGE_GUIDANCE_MAX_ENTRIES
}

/**
 * One list as the judge sees it: strings only, non-blank, no prompt-breaking
 * characters, then the list's own {@link ListRules}. Dedupe keeps the FIRST
 * occurrence (merged scopes arrive user → project → local, and the first scope
 * to state a rule is where the user will look for it). Surviving entries keep
 * their order and are never rewritten.
 *
 * Defence in depth, not validation: the settings UI and the IPC perimeter never
 * produce a bad entry, but `settings.json` and `automode.json` are hand-editable
 * files that never pass that perimeter — `loadClaudePermissions` even hands its
 * arrays through uncast. A dropped entry is dropped silently; the entry's value
 * is the user's own text and is not logged.
 */
function promptSafeList(list: readonly unknown[] | undefined, rules: ListRules = {}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // A hand-edited non-array (`"trustedDomains": "x"`) is no list at all.
  for (const entry of Array.isArray(list) ? list : []) {
    if (rules.maxEntries !== undefined && out.length >= rules.maxEntries) break
    if (typeof entry !== 'string' || entry.trim() === '') continue
    if (hasPromptBreakingChar(entry)) continue
    if (rules.maxChars !== undefined && codePointLength(entry) > rules.maxChars) continue
    if (rules.dedupe) {
      if (seen.has(entry)) continue
      seen.add(entry)
    }
    out.push(entry)
  }
  return out
}

/**
 * `{ key: list }` for each non-empty list, or `undefined` when all are empty,
 * so the caller can omit the whole slot and the policy renders its "none"
 * fallback rather than an empty section.
 */
function nonEmptyLists<K extends string>(
  lists: Record<K, readonly unknown[] | undefined>,
  rules: ListRules
): Partial<Record<K, string[]>> | undefined {
  const out: Partial<Record<K, string[]>> = {}
  let any = false
  for (const key of Object.keys(lists) as K[]) {
    const cleaned = promptSafeList(lists[key], rules)
    if (cleaned.length) {
      out[key] = cleaned
      any = true
    }
  }
  return any ? out : undefined
}

/**
 * Host-supplied ground truth for the classifier's Environment section.
 *
 * The trust slots and additional directories publish what the two sessions
 * published before this module existed — additional directories deduplicated,
 * trust lists as stored, empty lists omitted — except that an entry carrying a
 * prompt-breaking character (or a non-string / blank one) is dropped: each list
 * renders on one prompt line, so a hand-edited newline could forge the next
 * line. Valid entries pass unchanged and in order. New in ADR-083:
 *
 * - `permissionRules` — the user's allow / ask / deny rules, as judge CONTEXT.
 *   The engine ruleset is unaffected: auto mode still strips every allow rule
 *   from it (`withoutAllowRules`), so an allowed action reaches the judge, which
 *   now reads the allow rule as standing consent instead of blocking blind.
 * - `judgeGuidance` — `automode.json`'s `judgeAllow` / `judgeBlock`, rendered
 *   as the User-Specified Allow exception and Block soft rule, held on read to
 *   the same caps the IPC perimeter enforces on write (over-long entries
 *   dropped, at most the first {@link JUDGE_GUIDANCE_MAX_ENTRIES} kept).
 */
export function buildClassifierEnvironment(input: ClassifierEnvironmentInput): EnvironmentInfo {
  const { shared, permissions, remotes, repoVisibility } = input
  const additionalDirectories = promptSafeList(permissions.additionalDirectories, { dedupe: true })
  const trustedDomains = promptSafeList(shared.trustedDomains)
  const trustedRegistries = promptSafeList(shared.trustedRegistries)
  const protectedPatterns = promptSafeList(shared.protectedPatterns)
  const permissionRules = nonEmptyLists(
    { allow: permissions.allow, ask: permissions.ask, deny: permissions.deny },
    { dedupe: true }
  )
  const judgeGuidance = nonEmptyLists(
    { allow: shared.judgeAllow, block: shared.judgeBlock },
    GUIDANCE_RULES
  )
  return {
    cwd: input.cwd,
    platform: input.platform,
    ...(remotes.length ? { remotes } : {}),
    ...(repoVisibility && repoVisibility !== 'unknown' ? { repoVisibility } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(trustedDomains.length ? { trustedDomains } : {}),
    ...(trustedRegistries.length ? { trustedRegistries } : {}),
    ...(protectedPatterns.length ? { protectedPatterns } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    ...(judgeGuidance ? { judgeGuidance } : {})
  }
}
