import type { DiffComment } from '../../../../../shared/types'

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    if (!result[k]) result[k] = []
    result[k].push(item)
  }
  return result
}

export function composeReviewPrompt(comments: DiffComment[]): string {
  const byFile = groupBy(comments, (c) => c.filePath)
  const parts: string[] = ['Please address these review comments on the current git changes:\n']

  for (const [file, fileComments] of Object.entries(byFile)) {
    for (const c of fileComments) {
      const lineLabel =
        c.endLineNumber > c.lineNumber
          ? `lines ${c.lineNumber}\u2013${c.endLineNumber}`
          : `line ${c.lineNumber}`
      parts.push(`**${file}** (${lineLabel}, ${c.side} side):`)
      if (c.lineContent) {
        const quoted = c.lineContent
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')
        parts.push(quoted)
      }
      parts.push(`Comment: "${c.comment}"\n`)
    }
  }

  return parts.join('\n')
}
