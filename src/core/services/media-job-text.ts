/**
 * What a media job's end says in words: the notice the agent reads, the card's summary, and the shape of
 * an outcome. A leaf (shared types only) so the cold-load card rebuild can use it without the job service.
 */
import type { MediaJobResult, MediaKind } from '../../shared/media-generation'

export type MediaFinal =
  { status: 'completed'; result: MediaJobResult } | { status: 'failed' | 'stopped'; error: string }

function kindWord(kind: MediaKind): string {
  return kind === 'video' ? 'Video' : 'Image'
}

/** What the agent (and the card's summary) reads when a job ends. */
export function noticeText(
  job: { id: string; kind: MediaKind; modelLabel: string; inputPaths: readonly string[] },
  final: MediaFinal
): string {
  const word = kindWord(job.kind)
  if (final.status === 'completed') {
    const r = final.result
    const edited = job.inputPaths.length > 0 ? ` from ${job.inputPaths.length} input image(s)` : ''
    return (
      `${word} job ${job.id} finished: ${job.modelLabel} made the ${job.kind}${edited}. ` +
      `It is saved at ${r.path}.` +
      (r.revisedPrompt ? ` The model rewrote the prompt as: ${r.revisedPrompt}` : '')
    )
  }
  if (final.status === 'stopped') {
    return `${word} job ${job.id} was stopped by the user before it finished. Nothing was saved.`
  }
  return `${word} job ${job.id} failed (${job.modelLabel}): ${final.error}`
}
