import type { PlanComment } from '../../../../../shared/types'

export function composePlanFeedback(comments: PlanComment[]): string {
  const sorted = [...comments].sort((a, b) => a.lineNumber - b.lineNumber)
  const parts: string[] = ['Please revise the plan based on these comments:\n']

  for (const c of sorted) {
    const lineLabel = c.endLineNumber > c.lineNumber
      ? `lines ${c.lineNumber}\u2013${c.endLineNumber}`
      : `line ${c.lineNumber}`

    parts.push(`**${lineLabel}:**`)

    const quoted = c.selectedText.split('\n').map((l) => `> ${l}`).join('\n')
    parts.push(quoted)
    parts.push(`Comment: "${c.comment}"\n`)
  }

  return parts.join('\n')
}
