/**
 * ProviderLogo — a small inline SVG mark identifying a session's backend.
 *
 * Claude: simplified Anthropic logomark, tinted #D97757 (Claude orange)
 * Codex : simplified OpenAI mark (interlocking circles), tinted #0A84FF (system blue)
 *
 * Sizes: 'sm' (12px, sidebar rows), 'md' (14px, TopBar), 'lg' (16px, other uses)
 */

import type { ProviderId } from '../../../../shared/types'

interface ProviderLogoProps {
  provider: ProviderId
  /** Tailwind/inline class passthrough for positioning, margin, etc. */
  className?: string
  /** px size of the icon. Default: 12 */
  size?: number
}

export function ProviderLogo({ provider, className = '', size = 12 }: ProviderLogoProps): React.JSX.Element {
  if (provider === 'codex') {
    return <CodexMark size={size} className={className} />
  }
  return <ClaudeMark size={size} className={className} />
}

// ── Claude mark ───────────────────────────────────────────────────────────────
// A simplified version of the Anthropic / Claude logomark: two radiating lines
// forming the characteristic "A"-shape that Claude Code uses in its UI.
// Tinted with Claude orange (#D97757).

function ClaudeMark({ size, className }: { size: number; className: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Claude"
      style={{ flexShrink: 0 }}
    >
      {/* Stylised anthropic diamond / Claude mark: two slanted bars meeting at top */}
      <path
        d="M12 3 L5 19 H8.5 L12 10.5 L15.5 19 H19 Z"
        fill="#D97757"
        opacity="0.95"
      />
    </svg>
  )
}

// ── Codex / OpenAI mark ───────────────────────────────────────────────────────
// A simplified OpenAI-inspired mark: an encircled starburst / gear shape
// that evokes the OpenAI logo without requiring trademark graphics.
// Tinted with system blue (#0A84FF).

function CodexMark({ size, className }: { size: number; className: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Codex"
      style={{ flexShrink: 0 }}
    >
      {/* Simplified OpenAI-inspired polygon star */}
      <path
        d="M12 2 L14.4 9.2 L22 9.2 L16 13.8 L18.4 21 L12 16.4 L5.6 21 L8 13.8 L2 9.2 L9.6 9.2 Z"
        fill="#0A84FF"
        opacity="0.95"
      />
    </svg>
  )
}
