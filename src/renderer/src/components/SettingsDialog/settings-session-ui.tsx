/**
 * Small pieces the two panes that show a settings-session countdown share
 * (`SessionSecuritySettings`, `RemotePasskeySettings`), so the pill reads the
 * same in both.
 */

/** `m:ss` for the countdown pill. Clamped at zero — a negative clock reads as broken. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The mockup's padlock, at two sizes. */
export function LockIcon({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
    >
      <path d="M12 11c1.7 0 3-1.3 3-3V6a3 3 0 0 0-6 0v2c0 1.7 1.3 3 3 3z" />
      <path d="M5 11h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9z" />
    </svg>
  )
}
