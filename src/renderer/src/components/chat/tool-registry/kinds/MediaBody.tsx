/**
 * media kind body (custom layout) — ClaudeUI's hosted generate_image / generate_video, the same
 * on every engine. The whole card is `MediaCard`, which follows the job through the session's
 * task records; this body only hands it the call.
 */
import { MediaCard } from '../../MediaCard'
import type { KindBodyProps } from './types'

export function MediaBody({
  view,
  block,
  result,
  approval,
  isPendingApproval,
  permissionMode,
  onApproval
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'media') return null
  return (
    <MediaCard
      block={block}
      result={result}
      view={view}
      approval={approval}
      isPendingApproval={isPendingApproval}
      permissionMode={permissionMode}
      onApproval={onApproval}
    />
  )
}
