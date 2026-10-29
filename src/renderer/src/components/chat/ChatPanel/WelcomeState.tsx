import { useState, useMemo, useCallback, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { DirectoryBrowserDialog } from '../../shared/DirectoryBrowserDialog'
import { generateWorktreeName, sanitizeWorktreeName } from '../../../../../shared/worktree-start'
import { requestDraftSend } from '../../../lib/worktree-start'

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

/**
 * Highest `welcomeBrowseToken` any instance has acted on. MODULE scope, not a
 * component ref: the usual order is "sidebar requests, then this component
 * mounts", so the marker has to outlive the mount it was made for — while a
 * later remount (every return to the welcome screen is one) must not re-open
 * the browser off the same stale token.
 */
let lastBrowseTokenConsumed = 0

export function WelcomeState(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const pending = useActiveSession((s) => s.pendingWorktree)
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const directories = useSessionStore((s) => s.directories)
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const setPendingWorktree = useSessionStore((s) => s.setPendingWorktree)
  const defaultStartInWorktree = useSessionStore((s) => s.settings?.startInWorktree === true)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const welcomeBrowseToken = useSessionStore((s) => s.welcomeBrowseToken)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
  // Before a directory is chosen there is no session to hold the choice: it waits here, and
  // `null` means "not touched", so the project's own setting decides for the directory picked.
  const [chosenEnabled, setChosenEnabled] = useState<boolean | null>(null)
  const [chosenName, setChosenName] = useState(() => generateWorktreeName())
  const [chosenNameTouched, setChosenNameTouched] = useState(false)

  const phrase = useMemo(
    () => WELCOME_PHRASES[Math.floor(Math.random() * WELCOME_PHRASES.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId]
  )

  // The toggle and name of the session being set up: the session's own once it has a directory.
  const hasSession = !!cwd && !!pending
  const worktreeEnabled = hasSession ? pending.enabled : (chosenEnabled ?? defaultStartInWorktree)
  const worktreeName = hasSession ? pending.name : chosenName
  const phase = hasSession ? pending.phase : 'idle'
  const showWorktreeToggle = !cwd || (hasSession && isGitRepo && !sdkActive)
  const patchWorktree = (patch: {
    enabled?: boolean
    name?: string
    nameTouched?: boolean
  }): void => {
    if (hasSession && activeSessionId) {
      setPendingWorktree(activeSessionId, patch)
      return
    }
    if (patch.enabled !== undefined) setChosenEnabled(patch.enabled)
    if (patch.name !== undefined) setChosenName(patch.name)
    if (patch.nameTouched !== undefined) setChosenNameTouched(patch.nameTouched)
  }

  // The worktree itself is made at the first send, not here: this only creates the session.
  const startSession = useCallback(
    (dirCwd: string): void => {
      const routingId = uuid()
      createNewSession(routingId, dirCwd)
      // A touched toggle or a typed name is the user's, whatever the project's default says.
      if (chosenEnabled !== null || chosenNameTouched) {
        setPendingWorktree(routingId, {
          ...(chosenEnabled !== null ? { enabled: chosenEnabled } : {}),
          name: chosenName,
          nameTouched: chosenNameTouched
        })
      }
      setChosenEnabled(null)
      setChosenNameTouched(false)
    },
    [chosenEnabled, chosenName, chosenNameTouched, createNewSession, setPendingWorktree]
  )

  // A surface with no native dialog (the sidebar's web double-click) asked for
  // the browser — go straight to the picker. The dropdown stays shut: it was
  // only ever the browser's container, and the dialog is its own surface now.
  useEffect(() => {
    if (welcomeBrowseToken <= lastBrowseTokenConsumed) return
    lastBrowseTokenConsumed = welcomeBrowseToken
    setBrowseDialogOpen(true)
  }, [welcomeBrowseToken])

  const closeDropdown = (): void => {
    setDropdownOpen(false)
  }

  const handleSelectDir = (dirCwd: string): void => {
    closeDropdown()
    startSession(dirCwd)
  }

  // The web client has no native dialog — pickFolder() resolves to null there,
  // so it browses the host's filesystem through file:list-dir instead.
  const isWeb = window.api.platform === 'web'

  const handleBrowse = async (): Promise<void> => {
    if (isWeb) {
      closeDropdown()
      setBrowseDialogOpen(true)
      return
    }
    closeDropdown()
    const folder = await window.api.pickFolder()
    if (folder) startSession(folder)
  }

  return (
    <div
      data-testid="WelcomeState"
      className="flex flex-col items-center gap-4 -mt-16 animate-fade-in"
    >
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

      {/* Creating worktree indicator */}
      {phase === 'creating' && (
        <div
          data-testid="WelcomeState.worktreeCreating"
          className="flex items-center gap-2 text-[12px] text-text-muted animate-fade-in"
        >
          <div className="flex gap-[3px]">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className="w-[4px] h-[4px] rounded-full bg-mode-edit"
                style={{ animation: 'pulse-dot 1.4s infinite', animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
          <span>Creating worktree…</span>
        </div>
      )}

      {/* Directory dropdown */}
      {!cwd && (
        <div className="relative">
          <button
            data-testid="WelcomeState.selectDirectory"
            onClick={() => (dropdownOpen ? closeDropdown() : setDropdownOpen(true))}
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
              <div className="fixed inset-0 z-10" onClick={closeDropdown} />
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-72 max-h-64 overflow-y-auto rounded-lg bg-bg-tertiary border border-border shadow-lg z-20">
                {directories.map((group) => (
                  <button
                    key={group.projectKey || group.cwd}
                    data-testid="WelcomeState.directory"
                    data-id={group.cwd}
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
                  data-testid="WelcomeState.browse"
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
                  <span>{isWeb ? 'Browse path...' : 'Browse...'}</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Worktree toggle: made at the first send, so it stays until then. */}
      {showWorktreeToggle && phase !== 'creating' && (
        <div className="flex flex-col items-center gap-2">
          <label className="flex items-center gap-2 cursor-default select-none">
            <button
              data-testid="WelcomeState.worktreeToggle"
              role="switch"
              aria-checked={worktreeEnabled}
              onClick={() => patchWorktree({ enabled: !worktreeEnabled })}
              className={`relative w-8 h-[18px] rounded-full transition-colors ${worktreeEnabled ? 'bg-mode-edit' : 'bg-bg-hover border border-border'}`}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${worktreeEnabled ? 'left-[15px]' : 'left-[1px]'}`}
              />
            </button>
            <span className="text-[12px] text-text-muted">Start in worktree</span>
          </label>

          {worktreeEnabled && (
            <>
              <div className="flex items-center gap-1.5 animate-fade-in">
                <input
                  data-testid="WelcomeState.worktreeName"
                  type="text"
                  value={worktreeName}
                  onChange={(e) =>
                    patchWorktree({ name: sanitizeWorktreeName(e.target.value), nameTouched: true })
                  }
                  placeholder="worktree-name"
                  className="w-40 px-2 py-1 rounded-md bg-bg-tertiary border border-border text-[12px] text-text-primary font-mono focus:outline-none focus:border-accent"
                />
                <button
                  data-testid="WelcomeState.randomizeName"
                  onClick={() =>
                    patchWorktree({ name: generateWorktreeName(), nameTouched: false })
                  }
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
              <span
                data-testid="WelcomeState.worktreeHint"
                className="text-[11px] text-text-muted animate-fade-in"
              >
                Created from the remote&apos;s default branch when you send.
              </span>
            </>
          )}
        </div>
      )}

      {/* The worktree could not be made: the message is still in the composer, unsent. */}
      {hasSession && phase === 'failed' && (
        <div
          data-testid="WelcomeState.worktreeError"
          role="alert"
          className="flex flex-col items-center gap-2 max-w-sm text-center animate-fade-in"
        >
          <span className="text-[13px] text-text-primary">Couldn&apos;t create the worktree</span>
          <span
            data-testid="WelcomeState.worktreeErrorText"
            className="text-[12px] text-text-muted break-words"
          >
            {pending.error}
          </span>
          <div className="flex items-center gap-3">
            <button
              data-testid="WelcomeState.worktreeRetry"
              onClick={() => activeSessionId && requestDraftSend(activeSessionId)}
              className="text-[13px] text-accent hover:underline"
            >
              Retry
            </button>
            <button
              data-testid="WelcomeState.worktreeSendWithout"
              onClick={() => {
                if (!activeSessionId) return
                setPendingWorktree(activeSessionId, {
                  enabled: false,
                  phase: 'idle',
                  error: undefined
                })
                requestDraftSend(activeSessionId)
              }}
              className="text-[13px] text-accent hover:underline"
            >
              Send without a worktree
            </button>
          </div>
        </div>
      )}

      {/* Current directory */}
      {cwd && (
        <span className="text-[15px] text-text-muted">{cwd.split(/[\\/]/).pop() || cwd}</span>
      )}

      {/* Host browser (web only — desktop never opens it, see handleBrowse).
          Portalled, so it renders here purely for co-location with its state. */}
      {browseDialogOpen && (
        <DirectoryBrowserDialog
          listDir={window.api.listDir}
          listPlaces={window.api.listPlaces}
          recents={directories.map((g) => ({ cwd: g.cwd, folderName: g.folderName }))}
          onConfirm={(picked) => {
            setBrowseDialogOpen(false)
            handleSelectDir(picked)
          }}
          onCancel={() => setBrowseDialogOpen(false)}
        />
      )}
    </div>
  )
}
