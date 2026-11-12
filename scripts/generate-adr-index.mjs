#!/usr/bin/env node
// Generates docs/adr/adr.md, the index of decision records, from the topic records beside it
// (ADR-026, "Decision records").
//
//   node scripts/generate-adr-index.mjs           write the index
//   node scripts/generate-adr-index.mjs --check   exit 1 when the checked-in index is stale
//
// A topic record is every docs/adr/*.md other than the index:
//
//   # <Topic title>
//
//   Governs: `src/core/automode/`, `src/core/permissions/`
//
//   ## <Decision title> (ADR-085)             one section per current decision
//   ## <Decision title> (ADR-040, ADR-073)    decisions that are one ruling may share a section
//
//   ## Retired                                last; one line per superseded or removed decision
//
//   - ADR-067 — <old title> — <what replaced it, or why it is gone>.
//
// The index maps every ADR number to its section or its tombstone. Source cites numbers and parts
// of them (`ADR-082 §8`, `ADR-054 decision 6`), so the guard test
// (src/shared/__tests__/adr-index.test.ts) also checks every citation against what is parsed here.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADR_DIR = 'docs/adr'
export const INDEX_FILE = 'adr.md'

/**
 * Two decisions were numbered 037 before anything checked numbers, and source cites both. They
 * keep the number; every other number names one section.
 */
const SHARED_NUMBERS = new Map([['037', 2]])

const HEADING_NUMBERS = /\s*\(((?:ADR-\d{3})(?:,\s*ADR-\d{3})*)\)$/
const TOMBSTONE = /^- ADR-(\d{3}) — (.+?) — (.+)$/
// A part label: `§8`, `§8.1`, `decision 6`, `D1`, `part 6`, or a word after the sign (`§sign-in`).
const PART_LABEL = String.raw`§ ?\d+(?:\.\d+)?|[Dd]ecision \d+|D\d+|[Pp]art \d+|§ ?[A-Za-z][A-Za-z-]*`
const CITATION = new RegExp(String.raw`ADR-(\d{3})(?:[ ,]{0,2}(${PART_LABEL}))?`, 'g')
// Where a section defines a label without naming its ADR: at the start of an H3 (or deeper) heading,
// or as a bold lead-in (`**§3.**`, `**Decision 6.**`). A label met anywhere else is a reference,
// often to another document's own numbering, and defines nothing.
const DEFINED_LABEL = new RegExp(String.raw`(?:^#{3,6}[ \t]+|\*\*)\`?(${PART_LABEL})`, 'gm')

/** `§ 3` and `§3`, `Decision 6` and `decision 6`, `§Enrollment` and `§enrollment` are the same label. */
function normalizeLabel(label) {
  const compact = label.replace(/^§ /, '§')
  if (/^§\D/.test(compact)) return compact.toLowerCase()
  return compact.replace(/^(Decision|Part) /, (word) => word.toLowerCase())
}

/**
 * Every `ADR-NNN` in `text`, with the part label that follows it when there is one
 * (`§N`, `§N.M`, `decision N`, `DN`, `part N`, `§word`).
 * @param {string} text
 * @returns {{ number: string, label: string | null }[]}
 */
export function findAdrCitations(text) {
  return [...text.matchAll(CITATION)].map((match) => ({
    number: match[1],
    label: match[2] ? normalizeLabel(match[2]) : null
  }))
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, each space a hyphen. */
function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/**
 * The part labels a section defines for `number`: any label written with the number (`ADR-085 §3`),
 * and, when the section holds that ADR alone, a label that leads a sub-heading or a bold lead-in.
 */
function sectionLabels(section, number) {
  const labels = new Set()
  const add = (label) => {
    labels.add(label)
    // `§8.1` also answers a citation of `§8`.
    if (/^§\d+\./.test(label)) labels.add(label.replace(/\..*$/, ''))
  }
  for (const citation of findAdrCitations(section.text)) {
    if (citation.number === number && citation.label) add(citation.label)
  }
  if (section.numbers.length === 1) {
    for (const match of section.text.matchAll(DEFINED_LABEL)) add(normalizeLabel(match[1]))
  }
  return labels
}

/**
 * Parse one topic record.
 * @param {string} file the record's file name inside docs/adr
 * @param {string} source its text
 */
export function parseTopicRecord(file, source) {
  const errors = []
  const fail = (line, message) => errors.push(`${file}:${line}: ${message}`)
  const lines = source.replace(/\r\n/g, '\n').split('\n')

  let title = null
  let governs = null
  const sections = []
  const retired = []
  let current = null
  let inRetired = false
  let inFence = false

  lines.forEach((line, index) => {
    const at = index + 1
    if (/^(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) {
      current?.lines.push(line)
      return
    }
    if (line.startsWith('# ')) {
      if (title === null) title = line.slice(2).trim()
      else fail(at, 'a second H1')
      return
    }
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim()
      if (inRetired) fail(at, '"## Retired" must be the last H2')
      if (heading === 'Retired') {
        inRetired = true
        current = null
        return
      }
      const numbers = HEADING_NUMBERS.exec(heading)
      if (!numbers) {
        fail(at, `H2 "${heading}" must end with its ADR numbers, e.g. "(ADR-085)"`)
        current = null
        return
      }
      current = {
        title: heading.slice(0, numbers.index).trim(),
        anchor: headingAnchor(heading),
        numbers: numbers[1].split(/,\s*/).map((name) => name.slice(4)),
        lines: [line]
      }
      if (sections.some((section) => section.anchor === current.anchor)) {
        fail(at, `two sections share the anchor #${current.anchor}`)
      }
      sections.push(current)
      return
    }
    if (inRetired) {
      if (line.trim() === '') return
      const tombstone = TOMBSTONE.exec(line)
      if (tombstone)
        retired.push({ number: tombstone[1], title: tombstone[2], reason: tombstone[3] })
      else fail(at, 'a line under "## Retired" must read "- ADR-NNN — <old title> — <reason>."')
      return
    }
    if (current) {
      current.lines.push(line)
      return
    }
    if (line.startsWith('Governs:')) {
      governs = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      if (governs.length === 0) fail(at, '"Governs:" lists no path in backticks')
    }
  })

  if (title === null) errors.push(`${file}: no H1 title`)
  if (governs === null) errors.push(`${file}: no "Governs:" line before the first section`)
  return {
    file,
    title: title ?? file,
    governs: governs ?? [],
    sections: sections.map(({ lines: body, ...section }) => ({
      ...section,
      text: body.join('\n')
    })),
    retired,
    errors
  }
}

/**
 * Build the index from parsed records.
 * @param {ReturnType<typeof parseTopicRecord>[]} records
 */
export function buildAdrIndex(records) {
  const errors = records.flatMap((record) => record.errors)
  /** number -> { sections: [{ record, section }], tombstones: [{ record, tombstone }] } */
  const byNumber = new Map()
  const slot = (number) => {
    if (!byNumber.has(number)) byNumber.set(number, { sections: [], tombstones: [] })
    return byNumber.get(number)
  }
  for (const record of records) {
    for (const section of record.sections) {
      for (const number of section.numbers) slot(number).sections.push({ record, section })
    }
    for (const tombstone of record.retired)
      slot(tombstone.number).tombstones.push({ record, tombstone })
  }

  const numbers = new Map()
  const lines = []
  for (const number of [...byNumber.keys()].sort()) {
    const { sections, tombstones } = byNumber.get(number)
    const places = [
      ...sections.map(({ record, section }) => `${record.file} "${section.title}"`),
      ...tombstones.map(({ record }) => `${record.file} "Retired"`)
    ]
    const allowed = tombstones.length > 0 ? 1 : (SHARED_NUMBERS.get(number) ?? 1)
    if (places.length > allowed)
      errors.push(`ADR-${number} is in ${places.length} places: ${places.join(', ')}`)

    if (sections.length > 0) {
      const labels = new Set()
      for (const { section } of sections)
        for (const label of sectionLabels(section, number)) labels.add(label)
      numbers.set(number, { status: 'current', labels })
      const links = sections.map(
        ({ record, section }) =>
          `[${section.title}](${record.file}#${section.anchor}) in \`${record.file}\``
      )
      lines.push(
        links.length === 1
          ? `- ADR-${number} · current · ${links[0]}`
          : `- ADR-${number} · current · ${links.length} decisions share this number: ${links.join('; ')}`
      )
    } else {
      const { tombstone } = tombstones[0]
      numbers.set(number, { status: 'retired', labels: new Set() })
      lines.push(`- ADR-${number} · retired · ${tombstone.title} — ${tombstone.reason}`)
    }
  }

  const highest = [...byNumber.keys()].sort().at(-1) ?? '000'
  const topics = [...records]
    .sort((a, b) => a.file.localeCompare(b.file, 'en'))
    .map((record) => {
      const held = [
        ...new Set([
          ...record.sections.flatMap((section) => section.numbers),
          ...record.retired.map((tombstone) => tombstone.number)
        ])
      ].sort()
      const governs = record.governs.map((path) => `\`${path}\``).join(', ')
      return `- [${record.file}](${record.file}) — ${record.title}. ADRs ${held.join(', ')}.\n  Governs: ${governs}`
    })

  const markdown = `# Decision records

<!-- Generated by scripts/generate-adr-index.mjs from the topic records in this directory. Do not edit: run \`node scripts/generate-adr-index.mjs\`. -->

Decisions are kept in topic records, one file per area. A current decision is a section of its topic
record, headed by its title and ADR numbers; a superseded or removed one is a line under that record's
"Retired" heading. ADR numbers are permanent, because source and docs cite them: find a number under
"By number", or find the record for a directory under "Topic records". A cited part (\`ADR-082 §8\`,
\`ADR-054 decision 6\`) is under the same label inside the section.

Adding or changing a decision: ADR-026, "Decision records" (\`development-workflow.md\`). The highest
number here is ADR-${highest}; a new decision takes the next number that is free on every remote branch.

Until 2026-11-12 each ADR was its own file, \`docs/adr/adr-NNN_<slug>.md\`. Git history keeps them:
\`git log --diff-filter=D --name-only -- docs/adr\` finds the commit that removed them.

## Topic records

<!-- prettier-ignore-start -->
${topics.join('\n')}
<!-- prettier-ignore-end -->

## By number

<!-- prettier-ignore-start -->
${lines.join('\n')}
<!-- prettier-ignore-end -->
`
  return { markdown, errors, numbers }
}

/**
 * Read the topic records under `<repoRoot>/docs/adr` and build the index.
 * @param {string} repoRoot
 */
export function generateAdrIndex(repoRoot) {
  const dir = join(repoRoot, ADR_DIR)
  const records = readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== INDEX_FILE)
    .sort()
    .map((file) => parseTopicRecord(file, readFileSync(join(dir, file), 'utf8')))
  return { ...buildAdrIndex(records), records }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const indexPath = join(repoRoot, ADR_DIR, INDEX_FILE)
  const { markdown, errors } = generateAdrIndex(repoRoot)
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  if (process.argv.includes('--check')) {
    let checkedIn = ''
    try {
      checkedIn = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      // A missing index is a stale index.
    }
    if (checkedIn !== markdown) {
      console.error(`${ADR_DIR}/${INDEX_FILE} is stale: run node scripts/generate-adr-index.mjs`)
      process.exit(1)
    }
  } else {
    writeFileSync(indexPath, markdown)
    console.log(`wrote ${ADR_DIR}/${INDEX_FILE} (${Buffer.byteLength(markdown)} bytes)`)
  }
}
