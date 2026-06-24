import { useState, useMemo, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { EngineToggle } from '../../shared/EngineToggle'

const WELCOME_PHRASES = [
  "Let's build",
  "What's the plan?",
  'Ready when you are',
  'Where to next?',
  "Let's ship it",
  'What shall we make?',
  'Got an idea?',
  "Let's get started",
  "What's on your mind?",
  'Time to create'
]

const ADJECTIVES = [
  'swift',
  'calm',
  'bold',
  'keen',
  'warm',
  'cool',
  'wild',
  'soft',
  'fair',
  'deep',
  'pure',
  'dark',
  'safe',
  'firm',
  'vast'
]
const NOUNS = [
  'river',
  'stone',
  'cloud',
  'flame',
  'frost',
  'ridge',
  'creek',
  'grove',
  'bloom',
  'cedar',
  'maple',
  'cliff',
  'brook',
  'trail',
  'haven'
]

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

function sanitizeWorktreeName(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30)
}

export function WelcomeState(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const directories = useSessionStore((s) => s.directories)
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const setWorktreeInfo = useSessionStore((s) => s.setWorktreeInfo)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [worktreeEnabled, setWorktreeEnabled] = useState(false)
  const [worktreeName, setWorktreeName] = useState(() => generateRandomName())
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false)

  const phrase = useMemo(
    () => WELCOME_PHRASES[Math.floor(Math.random() * WELCOME_PHRASES.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId]
  )

  const startSession = useCallback(
    async (dirCwd: string): Promise<void> => {
      const routingId = uuid()
      if (worktreeEnabled && worktreeName.trim()) {
        setIsCreatingWorktree(true)
        try {
          const info = await window.api.createWorktree(dirCwd, worktreeName.trim())
          createNewSession(routingId, info.worktreePath)
          setWorktreeInfo(routingId, info)
        } catch (err) {
          window.api.logError('WelcomeState', `Failed to create worktree: ${err}`)
          createNewSession(routingId, dirCwd)
        } finally {
          setIsCreatingWorktree(false)
        }
      } else {
        createNewSession(routingId, dirCwd)
      }
    },
    [worktreeEnabled, worktreeName, createNewSession, setWorktreeInfo]
  )

  const handleSelectDir = (dirCwd: string): void => {
    setDropdownOpen(false)
    startSession(dirCwd)
  }

  const handleBrowse = async (): Promise<void> => {
    setDropdownOpen(false)
    const folder = await window.api.pickFolder()
    if (folder) startSession(folder)
  }

  return (
    <div className="flex flex-col items-center gap-4 -mt-16 animate-fade-in">
      {/* Icon */}
      <div
        style={{ width: 56, height: 56, borderRadius: 16 }}
        className="bg-bg-tertiary border border-border flex items-center justify-center"
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-accent"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Title */}
      <p className="text-[22px] text-text-secondary font-light tracking-tight">{phrase}</p>

      {/* Provider toggle — only show when no directory is set yet */}
      {!cwd && !isCreatingWorktree && <EngineToggle />}

      {/* Creating worktree indicator */}
      {isCreatingWorktree && (
        <div className="flex items-center gap-2 text-[12px] text-text-muted animate-fade-in">
          <div className="flex gap-[3px]">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className="w-[4px] h-[4px] rounded-full bg-mode-edit"
                style={{ animation: 'pulse-dot 1.4s infinite', animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
          <span>Creating worktree...</span>
        </div>
      )}

      {/* Directory dropdown */}
      {!cwd && !isCreatingWorktree && (
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1 text-[14px] text-accent hover:text-accent/80 transition-colors cursor-default"
          >
            <span>Select a project directory</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="mt-px"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-72 max-h-64 overflow-y-auto rounded-lg bg-bg-tertiary border border-border shadow-lg z-20">
                {directories.map((group) => (
                  <button
                    key={group.projectKey || group.cwd}
                    onClick={() => handleSelectDir(group.cwd)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0 text-text-muted"
                    >
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{group.folderName}</span>
                      <span className="text-[11px] text-text-muted truncate">{group.cwd}</span>
                    </div>
                  </button>
                ))}
                {directories.length > 0 && <div className="border-t border-border" />}
                <button
                  onClick={handleBrowse}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="shrink-0 text-text-muted"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <span>Browse...</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Worktree toggle */}
      {!cwd && !isCreatingWorktree && (
        <div className="flex flex-col items-center gap-2">
          <label className="flex items-center gap-2 cursor-default select-none">
            <button
              onClick={() => setWorktreeEnabled(!worktreeEnabled)}
              className={`relative w-8 h-[18px] rounded-full transition-colors ${worktreeEnabled ? 'bg-mode-edit' : 'bg-bg-hover border border-border'}`}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${worktreeEnabled ? 'left-[15px]' : 'left-[1px]'}`}
              />
            </button>
            <span className="text-[12px] text-text-muted">Start in worktree</span>
          </label>

          {worktreeEnabled && (
            <div className="flex items-center gap-1.5 animate-fade-in">
              <input
                type="text"
                value={worktreeName}
                onChange={(e) => setWorktreeName(sanitizeWorktreeName(e.target.value))}
                placeholder="worktree-name"
                className="w-40 px-2 py-1 rounded-md bg-bg-tertiary border border-border text-[12px] text-text-primary font-mono focus:outline-none focus:border-accent"
              />
              <button
                onClick={() => setWorktreeName(generateRandomName())}
                className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
                title="Randomize name"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1" y="1" width="22" height="22" rx="4" />
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="8" r="1.5" fill="currentColor" />
                  <circle cx="8" cy="16" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="16" r="1.5" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Current directory */}
      {cwd && (
        <span className="text-[15px] text-text-muted">{cwd.split(/[\\/]/).pop() || cwd}</span>
      )}
    </div>
  )
}
