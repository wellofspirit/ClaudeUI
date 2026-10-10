/**
 * ADR-085 §3 — over-approximating opencode globs for the user's Bash DENY and
 * ASK rules, so no server-side allow can outrank them.
 *
 * ## Why
 *
 * opencode evaluates a session's ruleset server-side, last-match-wins, over
 * glob TEXT: one resource per shell statement (`resources` = one per parsed
 * command — `vendor/opencode-src/packages/core/src/tool/plugin/shell.ts`
 * `permission.assert`; `sudo git push --force` is ONE resource), matched
 * by `Wildcard.match` (`vendor/opencode-src/packages/core/src/util/wildcard.ts`:
 * `*` → `.*` crosses everything including `/` and spaces, `?` → `.`, a pattern
 * ending ` *` makes that tail optional, `\` → `/` on both sides, case-folded on
 * win32 only), over the agent's, the session's and the saved rules
 * (`vendor/opencode-src/packages/core/src/permission.ts` `evaluate`).
 * The verbatim compile of `Bash(git push --force:*)` is `git push --force*`,
 * which `git push origin main --force` does not match — so a user allow
 * `Bash(git:*)` (`git*`) answered it and the force-push ran with no ask (S2
 * verifier F1): the host pre-check never saw a call the server allowed.
 *
 * Each deny/ask rule therefore also compiles to the globs below. They are
 * appended in the rule's own tier, after every allow rule, so under
 * last-match-wins they beat any user allow (the compiler emits allow → ask →
 * deny).
 *
 * ## Shape
 *
 * `<anchor><program> <t1>…` and `<anchor><program> * <t1>…`, then ` <tk>…` for
 * every later token: the program at a token start (the statement's start,
 * after a space, after `/`, after a quote: anchors `''`, `'* '`, `'*\/'`,
 * `'*"'`, `"*'"`) and followed by a space; the rule's words in the rule's
 * order, each token-anchored by a leading space (the first either right after
 * the program or after a gap — two bodies, since a glob cannot say "an
 * optional gap ending in a space"). Every token is loose-ended (`t*`: the
 * `--force` → `--force-with-lease` prefix, and a middle word followed by
 * anything), except the rule's own LAST word when it is positional (no
 * leading `-`), which ends at a token boundary: ` run *`, opencode's optional
 * tail — so `Bash(docker run:*)` matches `docker run` and
 * `docker --context x run alpine` but not `docker build -t runtime .` (the
 * host matcher's whole-word rule for positional words). Under a quote anchor
 * that last word stays loose too (`sh -c "docker run"` ends in a quote, and a
 * quoted mention is over-refused anyway). Each word contributes its
 * alternative spellings (`bashRuleWordAlternatives` in
 * `permissions/shell-rules.ts`: the synonym table, cluster permutations and
 * splits), one glob per combination. A rule with no words is
 * `<anchor><program> *` — the optional tail again, so it matches `rm` and
 * `rm -rf x`.
 *
 * ## Accepted over-approximations (a false hit costs a prompt or a refusal)
 *
 * - The program may sit after ANY space: `git rm -rf dir` is refused by a
 *   `Bash(rm -rf:*)` deny, and so is a quoted mention
 *   (`git commit -m "git push --force"`); the model rephrases.
 * - Word order follows the rule. `git --force push` is not matched here; the
 *   host matcher (§1) covers other orders for anything that still asks.
 * - Program families (`rm` ↔ `Remove-Item`, `del`), long-form spellings of a
 *   cluster's letters (`-rf` ↔ `--recursive --force`) and a cluster's letter
 *   synonyms (`-Rf` for `-rf`, case-folded on win32 only) are not broadened
 *   server-side; the host matcher covers them when the call asks.
 * - Tokens are separated by a plain space in the globs; a tab or a `\`-newline
 *   continuation between the program and its words is not matched here.
 * - A rule with a glob word (`rm -rf /*`) or a program with `*`/`?` keeps
 *   today's verbatim form only (`[]` here): broadening a glob into more globs
 *   would not be over-approximating anything specific.
 */
import { bashRuleWordAlternatives, parseBashRule } from '../permissions/shell-rules'

/** Where the program may start: the statement start, after a space, a `/` or a quote. */
const ANCHORS = ['', '* ', '*/', '*"', "*'"] as const

/**
 * Upper bound on word-alternative combinations per rule. opencode compiles one
 * RegExp per rule per `match` call, for every statement of every ask
 * (`Wildcard.match` has no cache), so each compiled rule costs every shell call
 * — `MAX_COMBINATIONS × 2 bodies × ANCHORS.length` = 240 globs per rule at
 * most (a three-letter cluster, the largest single word, gives 12 × 2 × 5).
 */
const MAX_COMBINATIONS = 24

/** A character opencode's matcher treats as a wildcard. */
const WILDCARD_RE = /[*?]/

function product(lists: readonly (readonly string[][])[]): number {
  return lists.reduce((n, l) => n * l.length, 1)
}

function cartesian(lists: readonly (readonly string[][])[]): string[][] {
  let acc: string[][] = [[]]
  for (const alternatives of lists) {
    acc = acc.flatMap((prefix) => alternatives.map((alt) => [...prefix, ...alt]))
  }
  return acc
}

/**
 * A word whose alternatives are its cluster permutations and splits rather
 * than synonyms — the multi-letter case of shell-rules' `isClusterWord`
 * (`bashRuleWordAlternatives` gives such a word no synonym alternatives).
 */
const CLUSTER_WORD_RE = /^-[A-Za-z0-9]{2,3}$/

/**
 * The word alternatives, capped at {@link MAX_COMBINATIONS}: first drop the
 * synonym alternatives (keep the word itself + cluster permutations and
 * splits), then keep the word itself only.
 */
function cappedAlternatives(perWord: string[][][], words: readonly string[]): string[][][] {
  if (product(perWord) <= MAX_COMBINATIONS) return perWord
  const clusterOnly = perWord.map((alts, i) =>
    CLUSTER_WORD_RE.test(words[i]) ? alts : alts.slice(0, 1)
  )
  if (product(clusterOnly) <= MAX_COMBINATIONS) return clusterOnly
  return perWord.map((alts) => alts.slice(0, 1))
}

/** ADR-085 §3 — over-approximating opencode globs for ONE Bash deny/ask specifier. [] when not broadenable. */
export function broadBashGlobs(specifier: string): string[] {
  const parsed = parseBashRule(specifier)
  if (!parsed) return []
  const program = parsed.program
  if (!program || WILDCARD_RE.test(program)) return []
  // A glob word keeps the verbatim form only; so does a quoted `*`/`?`, which
  // opencode's matcher would read as a wildcard anyway.
  if (parsed.words.some((w) => w.glob || WILDCARD_RE.test(w.text))) return []
  if (parsed.words.length === 0) return ANCHORS.map((anchor) => `${anchor}${program} *`)
  const perWord = parsed.words.map((_, i) => bashRuleWordAlternatives(parsed, i))
  if (perWord.some((alts) => alts.length === 0)) return []
  const words = parsed.words.map((w) => w.text)
  const capped = cappedAlternatives(perWord, words)
  const lastWord = words[words.length - 1]
  // Only the last word's own spelling (alternative 0) of a positional word
  // ends at a token boundary; its synonyms (`+`, `-f`) and every flag stay
  // prefixes.
  const strictLast = !lastWord.startsWith('-')
  const out = new Set<string>()
  for (const head of cartesian(capped.slice(0, -1))) {
    capped[capped.length - 1].forEach((alt, k) => {
      const tokens = [...head, ...alt]
      const strict = strictLast && k === 0
      for (const anchor of ANCHORS) {
        const quoted = anchor === '*"' || anchor === "*'"
        const tail = strict && !quoted ? ' *' : '*'
        const rest = tokens.map((t, i) => ` ${t}${i === tokens.length - 1 ? tail : '*'}`).join('')
        // `rest` starts with the first token's space: right after the program,
        // or after a gap.
        out.add(`${anchor}${program}${rest}`)
        out.add(`${anchor}${program} *${rest}`)
      }
    })
  }
  return [...out]
}
