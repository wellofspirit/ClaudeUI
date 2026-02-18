import { memo, useDeferredValue } from 'react'
import { useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'

export const StreamingText = memo(function StreamingText({ textOverride }: { textOverride?: string }): React.JSX.Element | null {
  const storeText = useActiveSession((s) => s.streamingText)
  const text = textOverride ?? storeText
  const deferred = useDeferredValue(text)
  if (!deferred) return null

  return (
    <div className="animate-fade-in">
      <div className="text-[13px] text-text-primary leading-[1.6]">
        <MarkdownRenderer content={deferred} />
      </div>
    </div>
  )
})
