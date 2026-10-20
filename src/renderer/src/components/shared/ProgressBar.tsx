/**
 * A thin progress bar: determinate with a percentage, pulsing without. Shared by
 * the harness install surfaces (Settings, the sidebar's update panel, the install
 * banner) and the transcript-load view.
 */
export function ProgressBar({
  percent,
  className,
  testid,
  dataId,
  smooth = false
}: {
  /** 0-100, or null for an indeterminate (pulsing) bar. */
  percent: number | null
  className?: string
  testid?: string
  dataId?: string
  /** Ease the fill between updates — for a bar that is fed several times a second. */
  smooth?: boolean
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={dataId}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={`block h-[3px] rounded-full bg-bg-hover overflow-hidden ${className ?? ''}`}
    >
      <span
        className={`block h-full bg-accent ${percent === null ? 'w-1/3 animate-pulse' : ''} ${smooth ? 'transition-[width] duration-200' : ''}`}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </span>
  )
}
