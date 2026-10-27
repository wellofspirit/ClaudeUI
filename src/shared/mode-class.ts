/**
 * The one ranking of permission modes by how much they let an agent do without asking
 * (session tools, dispatch runs): plan < default < acceptEdits < auto < bypassPermissions
 * (the auto gate of the sessions still applies). Pure, so main and shared code can both
 * import it.
 *
 * Two vocabularies name these modes and both reach a dispatch run: the sessions' own
 * (Claude `PermissionMode`: what `getAutonomyMode()` and a ledger row's `launch_mode`
 * carry) and `AutonomyMode` (`ask` / `autoEdit` / `full`, shared/model-capabilities.ts),
 * which `permission-modes.ts` maps one-to-one onto it (`full` IS `auto`, classifier-gated,
 * below `bypassPermissions`; the permission engine grants both the same base).
 */
const MODE_CLASS: Record<string, number> = {
  plan: 0,
  default: 1,
  dontAsk: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4
}

/**
 * {@link MODE_CLASS} plus the `AutonomyMode` names, for comparing two modes that may be
 * spelled in either vocabulary. Not exported as a table: `modeClass` (the session tools'
 * answer, null for a name it does not know) keeps its original table.
 */
const COMPARABLE_CLASS: Record<string, number> = {
  ...MODE_CLASS,
  ask: 1,
  autoEdit: 2,
  full: 3
}

/** The rank of a mode the session tools' table does not know: the ordinary ask-first mode. */
export const DEFAULT_MODE_CLASS = MODE_CLASS.default

/** A mode's rank, or null for a mode this table does not know. */
export function modeClass(mode: string | null | undefined): number | null {
  return mode && Object.hasOwn(MODE_CLASS, mode) ? MODE_CLASS[mode] : null
}

/**
 * The stricter of two modes (the one that lets the agent do less unasked), in either
 * vocabulary. A mode neither table knows ranks as the LOOSEST, so a known mode always wins
 * over it; two unknown modes answer `default`, which is what the permission engine treats
 * any unrecognised mode as (fail toward asking). On a tie `a` wins.
 */
export function stricterMode(a: string, b: string): string {
  const rank = (mode: string): number =>
    Object.hasOwn(COMPARABLE_CLASS, mode) ? COMPARABLE_CLASS[mode] : Infinity
  const ra = rank(a)
  const rb = rank(b)
  if (ra === Infinity && rb === Infinity) return 'default'
  return rb < ra ? b : a
}
