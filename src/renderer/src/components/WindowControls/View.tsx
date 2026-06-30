export interface WindowControlsViewProps {
  isMaximized: boolean
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
}

export function WindowControlsView({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose
}: WindowControlsViewProps): React.JSX.Element {
  return (
    <div data-testid="WindowControls" className="flex items-center [-webkit-app-region:no-drag]">
      <button
        data-testid="WindowControls.minimize"
        onClick={onMinimize}
        className="w-[46px] h-12 flex items-center justify-center text-text-secondary hover:bg-white/10 transition-colors"
      >
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        data-testid="WindowControls.maximize"
        onClick={onMaximize}
        className="w-[46px] h-12 flex items-center justify-center text-text-secondary hover:bg-white/10 transition-colors"
      >
        {isMaximized ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="2" y="0" width="8" height="8" rx="0.5" />
            <rect x="0" y="2" width="8" height="8" rx="0.5" />
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
          </svg>
        )}
      </button>
      <button
        data-testid="WindowControls.close"
        onClick={onClose}
        className="w-[46px] h-12 flex items-center justify-center text-text-secondary hover:bg-[#e81123] hover:text-white transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  )
}
