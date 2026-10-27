import type { ChatMessage, EngineId } from '../../../../shared/types'
import { ENGINE_META } from '../../../../shared/engine-meta'
import { SubagentMessages } from './SubagentMessages'

/**
 * The engine a dispatch card's child runs on — `view.dispatch.engine`, when it
 * names one of ours. `undefined` for a native (same-engine) subagent and for an
 * engine this build doesn't know, so the child falls back to the session's map.
 */
export function dispatchChildEngine(view: { dispatch?: { engine: string } }): EngineId | undefined {
  const engine = view.dispatch?.engine
  return engine && Object.hasOwn(ENGINE_META, engine) ? (engine as EngineId) : undefined
}

interface Props {
  msgs: ChatMessage[]
  isRunning: boolean
  isBackground: boolean
  /** Pre-formatted elapsed label — callers build it with TaskCard's
   *  `taskElapsedLabel`, so a running task's clock ticks from its start. */
  elapsedLabel?: string
  /** Visual density: 'sm' for the compact inline TaskCard, 'md' for the
   *  full-height TaskDetailPanel entry. Purely cosmetic (text/spinner size). */
  size?: 'sm' | 'md'
  /** The engine the child's messages come from (a dispatch's target); see SubagentMessages. */
  engineId?: EngineId
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
  size = 'sm',
  engineId
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
      {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" engineId={engineId} />}
    </>
  )
}
