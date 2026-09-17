import type { ChatMessage } from '../../../../shared/types'
import { SubagentMessages } from './SubagentMessages'

interface Props {
  msgs: ChatMessage[]
  isRunning: boolean
  isBackground: boolean
  /** Pre-formatted elapsed label (each caller has its own formatElapsed — kept
   *  out of this shared component to avoid a cross-directory import). */
  elapsedLabel?: string
  /** Visual density: 'sm' for the compact inline TaskCard, 'md' for the
   *  full-height TaskDetailPanel entry. Purely cosmetic (text/spinner size). */
  size?: 'sm' | 'md'
}

/**
 * Shared "expanded body" for a running/completed subagent task, used by both
 * TaskCard (chat view card) and TaskEntry (TaskDetailPanel panel view). Order
 * mirrors ChatPanel's main-view convention: accumulated message list, THEN
 * item-stream overlays included in that list.
 */
export function SubagentOutputBody({
  msgs,
  isRunning,
  isBackground,
  elapsedLabel,
  size = 'sm'
}: Props): React.JSX.Element {
  const isCompact = size === 'sm'

  return (
    <>
      {isRunning && isBackground && (
        <div
          className={`flex items-center gap-2 text-text-muted mb-2 ${isCompact ? 'text-[12px]' : 'text-[13px]'}`}
        >
          <span
            className={`rounded-full border-accent border-t-transparent animate-spin-slow ${
              isCompact ? 'w-2.5 h-2.5 border-[1.5px]' : 'w-3 h-3 border-2'
            }`}
          />
          <span>Running in background...</span>
          {elapsedLabel && <span className="font-mono text-[11px]">{elapsedLabel}</span>}
        </div>
      )}
      {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" />}
    </>
  )
}
