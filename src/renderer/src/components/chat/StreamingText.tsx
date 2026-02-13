import { useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'

export function StreamingText(): React.JSX.Element | null {
  const text = useActiveSession((s) => s.streamingText)
  if (!text) return null

  return (
    <div className="animate-fade-in">
      <div className="text-[13px] text-text-primary leading-[1.6]">
        <MarkdownRenderer content={text} />
      </div>
    </div>
  )
}
