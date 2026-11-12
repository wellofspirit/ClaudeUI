/**
 * Guards the decision records (ADR-026, "Decision records").
 *
 * Source and docs cite decisions by number, and often by part (a number followed by `§8`,
 * `decision 6`, `D1`, `part 6` or `§sign-in`). Those citations are only as good as the record they
 * point at, so this fails when:
 *  - a topic record under docs/adr does not parse, or a number sits in two sections;
 *  - the checked-in index docs/adr/adr.md is not what scripts/generate-adr-index.mjs writes;
 *  - a number cited in the scanned files has no index entry, or a cited part of a current decision
 *    is not in its section under that label;
 *  - a path on a record's "Governs:" line no longer exists (the index routes by those paths);
 *  - the index or a topic record has grown past what one read returns.
 *
 * Not checked: a part cited by a phrase with no sign or number ("the 2026-08-18 amendment",
 * "phase 4"), and whether the text under a label still says what the citing code means.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADR_DIR,
  INDEX_FILE,
  buildAdrIndex,
  findAdrCitations,
  generateAdrIndex,
  parseTopicRecord
} from '../../../scripts/generate-adr-index.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
/** Scanned whole, plus the files directly in the repository root (configs, CLAUDE.md). */
const SCANNED_DIRS = ['src', 'docs', 'scripts', 'patch', 'resources', '.github', '.claude/skills']
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|md|json|jsonc|css|html|sh|ya?ml)$/
/** This file's parser cases cite made-up parts. */
const SELF = resolve(__filename)

/** A read returns about 25,000 tokens; these keep the index and each record inside one. */
const INDEX_MAX_BYTES = 48_000
const RECORD_MAX_BYTES = 64_000

function textFiles(dir: string, recurse = true): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return recurse && entry.name !== 'node_modules' ? textFiles(path) : []
    }
    return entry.isFile() && TEXT_FILE.test(entry.name) && path !== SELF ? [path] : []
  })
}

const scannedFiles = (): string[] => [
  ...textFiles(REPO_ROOT, false),
  ...SCANNED_DIRS.flatMap((dir) => textFiles(join(REPO_ROOT, dir)))
]

const record = (file: string, body: string): ReturnType<typeof parseTopicRecord> =>
  parseTopicRecord(file, `# ${file}\n\nGoverns: \`src/core/\`\n\n${body}`)

describe('the decision records in the repository', () => {
  const index = generateAdrIndex(REPO_ROOT)

  it('parse, with every number in one place', () => {
    expect(index.errors).toEqual([])
  })

  it('match the checked-in index', () => {
    const checkedIn = readFileSync(join(REPO_ROOT, ADR_DIR, INDEX_FILE), 'utf8').replace(
      /\r\n/g,
      '\n'
    )
    // A stale index: run `node scripts/generate-adr-index.mjs`.
    expect(checkedIn).toBe(index.markdown)
  })

  it('resolve every ADR number and part cited in source, docs, scripts and config', () => {
    const unresolved = new Set<string>()
    for (const path of scannedFiles()) {
      const text = readFileSync(path, 'utf8')
      if (!text.includes('ADR-')) continue
      const file = relative(REPO_ROOT, path).replace(/\\/g, '/')
      for (const { number, label } of findAdrCitations(text)) {
        const entry = index.numbers.get(number)
        if (!entry) {
          unresolved.add(`${file}: ADR-${number} has no entry in ${ADR_DIR}/${INDEX_FILE}`)
        } else if (label && entry.status === 'current' && !entry.labels.has(label)) {
          unresolved.add(`${file}: ADR-${number} ${label} is not in the section of ADR-${number}`)
        }
      }
    }
    expect([...unresolved].sort()).toEqual([])
  }, 60_000)

  it('govern paths that exist', () => {
    const dead = index.records.flatMap((topic) =>
      topic.governs
        .filter((path) => !existsSync(join(REPO_ROOT, path)))
        .map((path) => `${topic.file}: ${path}`)
    )
    expect(dead).toEqual([])
  })

  it('fit in one read each', () => {
    expect(Buffer.byteLength(index.markdown)).toBeLessThan(INDEX_MAX_BYTES)
    const oversized = index.records
      .map((topic) => ({
        file: topic.file,
        bytes: statSync(join(REPO_ROOT, ADR_DIR, topic.file)).size
      }))
      .filter((topic) => topic.bytes > RECORD_MAX_BYTES)
    // An oversized record: split it by area, or move as-built detail to docs/architecture.
    expect(oversized).toEqual([])
  })
})

describe('parseTopicRecord', () => {
  it('reads the title, the governed paths, sections and tombstones', () => {
    const parsed = parseTopicRecord(
      'permissions.md',
      [
        '# Permissions',
        '',
        'Governs: `src/core/permissions/`, `src/core/pi/permission-engine.ts`',
        '',
        '## Deny and ask rules hold: in `every` mode (ADR-085)',
        '',
        '### §3 Plan mode',
        '',
        '## Retired',
        '',
        '- ADR-067 — Codex under the shared permission model — removed with the Codex engine.'
      ].join('\n')
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.title).toBe('Permissions')
    expect(parsed.governs).toEqual(['src/core/permissions/', 'src/core/pi/permission-engine.ts'])
    expect(parsed.sections).toMatchObject([
      {
        title: 'Deny and ask rules hold: in `every` mode',
        numbers: ['085'],
        anchor: 'deny-and-ask-rules-hold-in-every-mode-adr-085'
      }
    ])
    expect(parsed.retired).toEqual([
      {
        number: '067',
        title: 'Codex under the shared permission model',
        reason: 'removed with the Codex engine.'
      }
    ])
  })

  it('rejects a decision heading without numbers, a malformed tombstone and a missing Governs line', () => {
    const parsed = parseTopicRecord(
      'x.md',
      '# X\n\n## A decision\n\ntext\n\n## Retired\n\n- ADR-016: superseded\n'
    )
    expect(parsed.errors).toEqual([
      'x.md:3: H2 "A decision" must end with its ADR numbers, e.g. "(ADR-085)"',
      'x.md:9: a line under "## Retired" must read "- ADR-NNN — <old title> — <reason>."',
      'x.md: no "Governs:" line before the first section'
    ])
  })

  it('ignores headings inside a fenced example', () => {
    const parsed = record('x.md', '## Real (ADR-026)\n\n```markdown\n## Example heading\n```\n')
    expect(parsed.errors).toEqual([])
    expect(parsed.sections).toHaveLength(1)
  })
})

describe('buildAdrIndex', () => {
  it('writes one line per number: a link for a current decision, the tombstone for a retired one', () => {
    const { markdown, errors } = buildAdrIndex([
      record(
        'a.md',
        '## First (ADR-018, ADR-030)\n\n## Retired\n\n- ADR-016 — Old title — superseded by ADR-018.\n'
      )
    ])
    expect(errors).toEqual([])
    expect(markdown).toContain('- ADR-016 · retired · Old title — superseded by ADR-018.')
    expect(markdown).toContain(
      '- ADR-018 · current · [First](a.md#first-adr-018-adr-030) in `a.md`'
    )
    expect(markdown).toContain(
      '- ADR-030 · current · [First](a.md#first-adr-018-adr-030) in `a.md`'
    )
    expect(markdown).toContain('- [a.md](a.md) — a.md. ADRs 016, 018, 030.\n  Governs: `src/core/`')
  })

  it('rejects a number in two sections, and a number both current and retired', () => {
    const { errors } = buildAdrIndex([
      record('a.md', '## One (ADR-085)\n\n## Retired\n\n- ADR-091 — Old — gone.\n'),
      record('b.md', '## Two (ADR-085)\n\n## Three (ADR-091)\n')
    ])
    expect(errors).toEqual([
      'ADR-085 is in 2 places: a.md "One", b.md "Two"',
      'ADR-091 is in 2 places: b.md "Three", a.md "Retired"'
    ])
  })

  it('lets ADR-037 name its two decisions, and no more', () => {
    const two = [record('a.md', '## Policy (ADR-037)\n'), record('b.md', '## Routing (ADR-037)\n')]
    const built = buildAdrIndex(two)
    expect(built.errors).toEqual([])
    expect(built.markdown).toContain(
      '- ADR-037 · current · 2 decisions share this number: [Policy](a.md#policy-adr-037) in `a.md`; [Routing](b.md#routing-adr-037) in `b.md`'
    )
    expect(buildAdrIndex([...two, record('c.md', '## Third (ADR-037)\n')]).errors).toHaveLength(1)
  })

  it('collects the part labels a section defines', () => {
    const { numbers } = buildAdrIndex([
      record(
        'a.md',
        [
          '## Alone (ADR-082)',
          '### §8 Store',
          '**§8.1.** x',
          '4. **Decision 6.** y (see ADR-071 §3)',
          '**§Sign-in.** z',
          'The wire is `01-transport.md` §4.25, part 9 of that page; D7 is a drive.'
        ].join('\n\n')
      ),
      record(
        'b.md',
        '## Shared (ADR-040, ADR-073)\n\n### ADR-073 §5 Roster\n\n### §9 Unprefixed\n\n**D1.** z\n'
      )
    ])
    // A label leads a sub-heading or a bold lead-in. One met in running text is a reference to
    // something else's numbering and defines nothing; neither does a cross-reference to another ADR.
    expect([...numbers.get('082')!.labels].sort()).toEqual(['decision 6', '§8', '§8.1', '§sign-in'])
    expect(numbers.has('071')).toBe(false)
    // A shared section needs the number on each label.
    expect([...numbers.get('073')!.labels]).toEqual(['§5'])
    expect([...numbers.get('040')!.labels]).toEqual([])
  })
})

describe('findAdrCitations', () => {
  it('reads a number and the part that follows it', () => {
    expect(
      findAdrCitations(
        'ADR-082 §8, ADR-097 §8.2; ADR-054 decision 6. ADR-088 D1 and ADR-091 part 6, ADR-082 §2-3, ADR-026, ADR-057 §sign-in, ADR-065 § Shared lists'
      )
    ).toEqual([
      { number: '082', label: '§8' },
      { number: '097', label: '§8.2' },
      { number: '054', label: 'decision 6' },
      { number: '088', label: 'D1' },
      { number: '091', label: 'part 6' },
      { number: '082', label: '§2' },
      { number: '026', label: null },
      { number: '057', label: '§sign-in' },
      { number: '065', label: '§shared' }
    ])
  })
})
