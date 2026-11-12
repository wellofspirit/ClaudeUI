export const ADR_DIR: string
export const INDEX_FILE: string

export interface AdrCitation {
  number: string
  /** `§N`, `§N.M`, `decision N`, `DN` or `part N` when the citation names a part. */
  label: string | null
}

export interface TopicSection {
  title: string
  anchor: string
  numbers: string[]
  text: string
}

export interface TopicRecord {
  file: string
  title: string
  governs: string[]
  sections: TopicSection[]
  retired: { number: string; title: string; reason: string }[]
  errors: string[]
}

export interface AdrIndex {
  markdown: string
  errors: string[]
  /** Every ADR number the records hold, with the part labels its section defines. */
  numbers: Map<string, { status: 'current' | 'retired'; labels: Set<string> }>
}

export function findAdrCitations(text: string): AdrCitation[]
export function parseTopicRecord(file: string, source: string): TopicRecord
export function buildAdrIndex(records: TopicRecord[]): AdrIndex
export function generateAdrIndex(repoRoot: string): AdrIndex & { records: TopicRecord[] }
