import { useState, useEffect, useMemo } from 'react'
import { useSessionStore } from '../../stores/session-store'

interface Props {
  text: string
  isActive: boolean
}

const WAVE_DURATION_MS = 2000
const WAVE_CHARS = 20 // how many characters are "lit up" at once in the wave

function WaveText({ text }: { text: string }): React.JSX.Element {
  const chars = useMemo(() => text.split(''), [text])
  const total = chars.length

  return (
    <span className="italic">
      {chars.map((ch, i) => (
        <span
          key={i}
          className="animate-thinking-wave"
          style={{
            animationDelay: `${(i / Math.max(total, WAVE_CHARS)) * WAVE_DURATION_MS}ms`
          }}
        >
          {ch}
        </span>
      ))}
    </span>
  )
}

export function ThinkingBlock({ text, isActive }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const thinkingDurationMs = useSessionStore((s) => s.thinkingDurationMs)
  const thinkingStartedAt = useSessionStore((s) => s.thinkingStartedAt)
  const [elapsed, setElapsed] = useState(0)

  // Live timer while thinking is active
  useEffect(() => {
    if (!isActive || !thinkingStartedAt) {
      setElapsed(0)
      return
    }
    setElapsed(Math.round((Date.now() - thinkingStartedAt) / 1000))
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - thinkingStartedAt) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isActive, thinkingStartedAt])

  const durationSec = isActive
    ? elapsed
    : thinkingDurationMs != null
      ? Math.round(thinkingDurationMs / 1000)
      : null

  const label = isActive
    ? `Thinking\u2009....\u2009(${durationSec}s)`
    : durationSec != null
      ? `Thought for ${durationSec}s`
      : 'Thought'

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        {isActive && (
          <span className="w-3.5 h-3.5 rounded-full border-2 border-text-secondary border-t-transparent shrink-0 animate-spin-slow" />
        )}
        {isActive ? <WaveText text={label} /> : <span>{label}</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && text && (
        <div className="mt-2 pl-3 border-l-2 border-border-bright text-[13px] text-text-secondary leading-[1.6] whitespace-pre-wrap max-h-80 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  )
}
