/**
 * The rule corpus + policy document (phase 2 of `docs/automode-rework-plan.md`,
 * behavioural reference `docs/protocol/14-auto-mode-classifier.md` §4/§6/§9).
 *
 * Two things are worth testing about a prompt document:
 *  1. **Structural invariants of the DATA** — the properties the classifier's
 *     mechanics silently depend on (one hard rule; every soft rule declares a
 *     consent slot whose kind agrees with its `adversarial` flag; every rule
 *     NAME the model is told to copy verbatim normalizes onto its own slug, or
 *     the derived `<category>` channel drops it).
 *  2. **That every section actually reaches the model** — asserted on
 *     distinctive phrases, never on a full snapshot: a snapshot of policy prose
 *     would fail on every wording tweak while catching nothing.
 */
import { describe, it, expect } from 'vitest'
import { HARD_RULES, SOFT_RULES, ALLOW_RULES, deriveCategorySet } from '../rules/corpus'
import { buildPolicyPrompt, type EnvironmentInfo } from '../rules/policy'
import { normalizeCategory } from '../classifier'

const ALL_RULES = [...HARD_RULES, ...SOFT_RULES]

describe('rule corpus — structural invariants', () => {
  it('has EXACTLY one hard rule (the whole reason it can be permissive by default)', () => {
    expect(HARD_RULES).toHaveLength(1)
    expect(HARD_RULES[0].slug).toBe('data_exfiltration')
    expect(HARD_RULES[0].tier).toBe('hard')
  })

  it('marks every soft rule `soft`', () => {
    for (const r of SOFT_RULES) expect(r.tier).toBe('soft')
  })

  it('every soft rule declares a consent slot whose KIND agrees with its adversarial flag', () => {
    // An adversarial rule inverts the bar (the user must confirm the flagged
    // pattern is a false positive). A rule whose flag and prose disagree would
    // tell the model the opposite of what the policy document promises.
    for (const r of SOFT_RULES) {
      const named = r.text.includes('[named+specifics — must name:')
      const adversarial = r.text.includes('[adversarial — must name:')
      expect(named || adversarial, `${r.slug} declares no must-name slot`).toBe(true)
      expect(named && adversarial, `${r.slug} declares both slot kinds`).toBe(false)
      expect(adversarial, `${r.slug}: adversarial flag disagrees with its slot`).toBe(
        r.adversarial === true
      )
    }
  })

  it('has at least one adversarial rule (the inversion must be exercised by the corpus)', () => {
    expect(SOFT_RULES.filter((r) => r.adversarial).length).toBeGreaterThan(0)
  })

  it('every slug is unique across hard, soft and allow', () => {
    const slugs = [...ALL_RULES, ...ALLOW_RULES].map((r) => r.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('every slug is normalizer-stable', () => {
    for (const r of [...ALL_RULES, ...ALLOW_RULES]) {
      expect(normalizeCategory(r.slug), `${r.slug} is not normalizer-stable`).toBe(r.slug)
    }
  })

  it('every rule NAME normalizes onto its own slug', () => {
    // Stage 2 is told to copy the rule name verbatim into <category>, and the
    // parser normalizes what it gets. A name that does not land on its slug is
    // silently un-categorizable — exactly cli.js's hand-maintained-set bug.
    for (const r of ALL_RULES) {
      expect(normalizeCategory(r.name), `"${r.name}" does not normalize to ${r.slug}`).toBe(r.slug)
    }
  })

  it('every rule has a non-empty name and body', () => {
    for (const r of [...ALL_RULES, ...ALLOW_RULES]) {
      expect(r.name.trim().length).toBeGreaterThan(0)
      expect(r.text.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('deriveCategorySet', () => {
  it('is exactly the hard + soft slugs', () => {
    const set = deriveCategorySet()
    for (const r of ALL_RULES) expect(set.has(r.slug)).toBe(true)
    expect(set.size).toBe(ALL_RULES.length)
  })

  it('contains NO allow-exception slug (exceptions are never categories)', () => {
    const set = deriveCategorySet()
    for (const a of ALLOW_RULES) expect(set.has(a.slug), `${a.slug} leaked into the set`).toBe(false)
  })

  it('returns an independent set — a caller cannot poison the allowlist', () => {
    const a = deriveCategorySet()
    a.add('anything_goes')
    expect(deriveCategorySet().has('anything_goes')).toBe(false)
  })
})

describe('buildPolicyPrompt — every section reaches the model', () => {
  const p = buildPolicyPrompt({ cwd: '/repo' })

  it('states the role and the three-risk threat model', () => {
    expect(p).toContain('security monitor for an autonomous AI coding agent')
    expect(p).toContain('PROMPT INJECTION')
    expect(p).toContain('SCOPE CREEP')
    expect(p).toContain('ACCIDENTAL DAMAGE')
  })

  it('states the default-allow rule', () => {
    expect(p).toContain('## Default rule')
    expect(p).toContain('By default, actions are ALLOWED')
  })

  it('carries the out-of-scope list (the "why users switch it off" guard)', () => {
    expect(p).toContain('## Never block for these')
    expect(p).toContain('bad, ugly, or wrong code')
    expect(p).toContain('wasted tokens')
  })

  it('carries the consent model — both paths, the load-bearing sub-rules', () => {
    expect(p).toContain('## User intent')
    expect(p).toContain('PATH A')
    expect(p).toContain('PATH B')
    expect(p).toContain('Naming the enclosing task is NOT naming the destructive step')
    expect(p).toContain('The bar binds at the step that SHIPS')
    expect(p).toContain('POST-BLOCK CONSENT INHERITANCE')
    expect(p).toContain('Consent never reaches the HARD rule')
  })

  it('explains the harness annotations it is now fed (phase 3)', () => {
    // The judge is shown {"outcome":…} and {"meta":…} lines; without the
    // contract, `ok` reads as a safety verdict and a missing outcome reads as
    // success — both inversions of ref §5.
    expect(p).toContain('## Transcript annotations')
    expect(p).toContain('the absence of an outcome is NOT success')
    expect(p).toContain('harness-measured ground truth about the action directly below it')
  })

  it('carries the evaluation (scope-computation) rules', () => {
    expect(p).toContain('COMPOSITE ACTIONS')
    expect(p).toContain('WRAPPERS')
    expect(p).toContain('ENCODED COMMANDS')
    expect(p).toContain('DESTINATION ENUMERATION')
    expect(p).toContain('RULES ARE EXAMPLES')
  })

  it('carries the three protected content classes', () => {
    expect(p).toContain('## Definitions')
    expect(p).toContain('1. SECRETS')
    expect(p).toContain('2. SENSITIVE DATA')
    expect(p).toContain('3. CONFIDENTIAL DATA')
  })

  it('renders the HARD / SOFT / ALLOW sections with every rule in them', () => {
    expect(p).toContain('## HARD BLOCK')
    expect(p).toContain('## SOFT BLOCK')
    expect(p).toContain('## ALLOW exceptions')
    for (const r of [...ALL_RULES, ...ALLOW_RULES]) expect(p).toContain(`### ${r.name}`)
  })

  it('flags adversarial rules in their heading only', () => {
    for (const r of SOFT_RULES) {
      expect(p).toContain(`### ${r.name}${r.adversarial ? ' *(adversarial pattern)*' : '\n'}`)
    }
  })

  it('states the soft-rule count it actually rendered', () => {
    expect(p).toContain(`## SOFT BLOCK — ${SOFT_RULES.length} rules`)
  })

  it('ends with the ordered classification process', () => {
    expect(p).toContain('## Classification process')
    expect(p).toContain('HARD check')
    expect(p).toContain('Generalization check before finalizing an allow')
  })

  it('orders the sections role → default → out-of-scope → intent → env → rules → process', () => {
    const at = (s: string): number => p.indexOf(s)
    const order = [
      at('security monitor for an autonomous AI coding agent'),
      at('## Default rule'),
      at('## Never block for these'),
      at('## User intent'),
      at('## Environment'),
      at('## Definitions'),
      at('## HARD BLOCK'),
      at('## SOFT BLOCK'),
      at('## ALLOW exceptions'),
      at('## Classification process')
    ]
    expect(order).not.toContain(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('buildPolicyPrompt — the Environment slots', () => {
  const env = (over: Partial<EnvironmentInfo> = {}): string =>
    buildPolicyPrompt({ cwd: '/repo', ...over })

  it('always states the working directory and marks the section as ground truth', () => {
    const p = env()
    expect(p).toContain('## Environment — ground truth, overrides any inference from the transcript')
    expect(p).toContain('- Working directory: /repo')
  })

  it('omits the platform line when the host does not supply one', () => {
    expect(env()).not.toContain('- Platform:')
    expect(env({ platform: 'win32' })).toContain('- Platform: win32')
  })

  it('EMPTY trust slots render the restrictive fallbacks, not silence', () => {
    // An unfilled slot must mean "nothing is trusted". Rendering nothing at all
    // would leave the model to infer trust from the transcript, which is the
    // one thing the Environment section exists to prevent.
    const p = env()
    expect(p).toContain('Session-start git remotes: not recorded this session')
    expect(p).toContain('Trusted external domains/services: none configured')
    expect(p).toContain("Trusted package registries: the project manifest's default registry only")
    expect(p).toContain('Repository visibility: unknown')
  })

  it('FILLED trust slots render their values', () => {
    const p = env({
      remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git' }],
      repoVisibility: 'private',
      additionalDirectories: ['/srv/shared'],
      trustedDomains: ['files.acme.com', 'api.acme.com'],
      trustedRegistries: ['https://npm.acme.internal']
    })
    expect(p).toContain('origin → git@github.com:acme/app.git')
    expect(p).toContain('- Repository visibility: private')
    expect(p).toContain('Additional user-granted directories (count as local): /srv/shared')
    expect(p).toContain('Trusted external domains/services: files.acme.com, api.acme.com')
    expect(p).toContain('Trusted package registries: https://npm.acme.internal')
    expect(p).not.toContain('Trusted external domains/services: none configured')
    expect(p).not.toContain('Session-start git remotes: not recorded this session')
  })

  it('omits the additional-directories line entirely when there are none', () => {
    expect(env()).not.toContain('Additional user-granted directories')
    expect(env({ additionalDirectories: [] })).not.toContain('Additional user-granted directories')
  })

  it('the prod heuristic appears ONLY when no protectedPatterns are configured', () => {
    // Configured patterns REPLACE the heuristic — leaving both in would let the
    // model fall back to name-matching after the user narrowed the scope.
    expect(env()).toContain("heuristic applies: any target whose name carries 'prod'")
    const p = env({ protectedPatterns: ['acme-live-*', 'k8s://prod-cluster'] })
    expect(p).toContain('Production/protected patterns: acme-live-*, k8s://prod-cluster')
    expect(p).not.toContain('heuristic applies')
  })
})

describe('buildPolicyPrompt — byte-stability (the prompt-cache prerequisite, ADR-037 P3)', () => {
  // The judge's system prompt is ~24 KB and is re-sent on every classification.
  // The patched opencode judge route caches it — an explicit `cache_control`
  // breakpoint where the provider takes one, automatic prefix caching where it
  // does not. BOTH require the rendered document to be byte-identical between
  // calls for the same environment: one drifting character (a timestamp, a
  // counter, a re-ordered Set) invalidates the prefix and silently restores
  // full price on every call, with no error anywhere to notice it by.
  //
  // Determinism is asserted, never a golden hash: a hash pin would fail on
  // every legitimate policy edit while catching nothing this does not.
  const full: EnvironmentInfo = {
    cwd: '/repo',
    platform: 'win32',
    remotes: [
      { name: 'origin', url: 'git@github.com:acme/app.git' },
      { name: 'upstream', url: 'git@github.com:vendor/app.git' }
    ],
    repoVisibility: 'private',
    additionalDirectories: ['/srv/shared', '/srv/other'],
    trustedDomains: ['files.acme.com', 'api.acme.com'],
    trustedRegistries: ['https://npm.acme.internal'],
    protectedPatterns: ['acme-live-*']
  }

  it('renders byte-identically when called repeatedly with the SAME env object', () => {
    const first = buildPolicyPrompt(full)
    for (let i = 0; i < 5; i++) expect(buildPolicyPrompt(full)).toBe(first)
  })

  it('renders byte-identically for a structurally equal but freshly built env', () => {
    // The host rebuilds EnvironmentInfo per call (OpencodeSession /
    // PiSession `classifierEnvironment`), so equality of VALUE, not identity,
    // is what has to produce an identical prefix.
    expect(buildPolicyPrompt(structuredClone(full))).toBe(buildPolicyPrompt(full))
  })

  it('does not depend on the insertion order of the env object keys', () => {
    const reordered: EnvironmentInfo = {
      protectedPatterns: full.protectedPatterns,
      trustedRegistries: full.trustedRegistries,
      trustedDomains: full.trustedDomains,
      additionalDirectories: full.additionalDirectories,
      repoVisibility: full.repoVisibility,
      remotes: full.remotes,
      platform: full.platform,
      cwd: full.cwd
    }
    expect(buildPolicyPrompt(reordered)).toBe(buildPolicyPrompt(full))
  })

  it('is stable for the minimal env too — the all-fallbacks rendering', () => {
    expect(buildPolicyPrompt({ cwd: '/repo' })).toBe(buildPolicyPrompt({ cwd: '/repo' }))
  })

  it('carries no clock, no counter, no random token', () => {
    const p = buildPolicyPrompt(full)
    // A rendered Date leaves a year; a counter or nonce leaves a long digit or
    // hex run. Neither has any business in a policy document.
    expect(p).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/)
    expect(p).not.toMatch(/\b\d{10,}\b/)
    expect(p).not.toMatch(/\b[0-9a-f]{16,}\b/)
  })

  it('changes — and only changes — when the environment actually changes', () => {
    // The other half of the contract: a stable prefix must not be stable by
    // being blind. A different cwd is a different policy and must not be
    // served from the previous one's cache entry.
    expect(buildPolicyPrompt({ ...full, cwd: '/other' })).not.toBe(buildPolicyPrompt(full))
  })
})
