import { useState, useCallback, useRef, useEffect } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { GitCommitBoxView } from './View'

interface Props {
  /**
   * Select the first remaining file after a commit (keeps the desktop diff
   * pane populated). Mobile passes false: there the commit box only exists on
   * the list screen, and a post-commit selection would yank the user into the
   * diff of a leftover file they never tapped (selection IS navigation on
   * mobile — see MobileGitView).
   */
  autoSelectNext?: boolean
}

export function GitCommitBox({ autoSelectNext = true }: Props = {}): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const gitCommitMessage = useActiveSession((s) => s.gitCommitMessage)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setGitCommitMessage = useSessionStore((s) => s.setGitCommitMessage)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const selectNextGitFile = useSessionStore((s) => s.selectNextGitFile)
  const gitCommitMode = useSessionStore((s) => s.settings.gitCommitMode)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [toastExiting, setToastExiting] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const [upstreamPrompt, setUpstreamPrompt] = useState<{
    branch: string
    afterCommitHash?: string
  } | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [commitBoxHeight, setCommitBoxHeight] = useState(120)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const stagedCount = gitStatus?.staged.length ?? 0
  const totalChanges = gitStatus?.files.length ?? 0
  const allStaged = totalChanges > 0 && stagedCount === totalChanges

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message: msg, type })
    setToastExiting(false)
    toastTimerRef.current = setTimeout(
      () => {
        setToastExiting(true)
        setTimeout(() => {
          setToast(null)
          setToastExiting(false)
        }, 200)
      },
      type === 'error' ? 5000 : 2500
    )
  }, [])

  // Clean up toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  // Auto-expand commit box to fit content
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const saved = el.style.height
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    el.style.height = saved
    const needed = scrollH + 48
    if (needed > commitBoxHeight) {
      setCommitBoxHeight(Math.min(600, needed))
    }
  }, [gitCommitMessage]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-to-resize commit box
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: commitBoxHeight }
      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return
        const delta = dragRef.current.startY - ev.clientY
        setCommitBoxHeight(Math.max(80, Math.min(600, dragRef.current.startH + delta)))
      }
      const onUp = (): void => {
        dragRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [commitBoxHeight]
  )

  const isNoUpstreamError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err)
    return (
      msg.includes('no upstream branch') ||
      msg.includes('set-upstream') ||
      msg.includes('has no upstream')
    )
  }

  const refreshStatus = useCallback(async () => {
    if (!cwd || !activeSessionId) return
    const status = await window.api.gitGetStatus(cwd)
    setGitStatus(activeSessionId, status)
  }, [cwd, activeSessionId, setGitStatus])

  const handlePushWithUpstreamPrompt = useCallback(async () => {
    if (!cwd || !upstreamPrompt) return
    setLoading(true)
    try {
      await window.api.gitPushWithUpstream(cwd, upstreamPrompt.branch)
      showToast(
        upstreamPrompt.afterCommitHash
          ? `Committed & pushed: ${upstreamPrompt.afterCommitHash}`
          : 'Pushed!',
        'success'
      )
      await refreshStatus()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Push failed', 'error')
    } finally {
      setLoading(false)
      setUpstreamPrompt(null)
    }
  }, [cwd, upstreamPrompt, showToast, refreshStatus])

  const handleToggleStageAll = useCallback(async () => {
    if (!cwd || !activeSessionId || loading) return
    setLoading(true)
    try {
      if (allStaged) {
        await window.api.gitUnstageAll(cwd)
      } else {
        await window.api.gitStageAll(cwd)
      }
      await refreshStatus()
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : allStaged ? 'Failed to unstage' : 'Failed to stage',
        'error'
      )
    } finally {
      setLoading(false)
    }
  }, [cwd, activeSessionId, loading, allStaged, refreshStatus, showToast])

  const handleCommit = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      showToast('No staged changes to commit', 'error')
      return
    }
    setLoading(true)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      showToast(`Committed: ${hash.slice(0, 7)}`)
      await refreshStatus()
      if (autoSelectNext) selectNextGitFile(activeSessionId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Commit failed', 'error')
    } finally {
      setLoading(false)
    }
  }, [
    cwd,
    activeSessionId,
    gitCommitMessage,
    stagedCount,
    loading,
    setGitCommitMessage,
    refreshStatus,
    showToast,
    autoSelectNext,
    selectNextGitFile
  ])

  const handleCommitAndPush = useCallback(async () => {
    if (!cwd || !activeSessionId || !gitCommitMessage.trim() || loading) return
    if (stagedCount === 0) {
      showToast('No staged changes to commit', 'error')
      return
    }
    setLoading(true)
    setDropdownOpen(false)
    try {
      const hash = await window.api.gitCommit(cwd, gitCommitMessage.trim())
      setGitCommitMessage(activeSessionId, '')
      try {
        await window.api.gitPush(cwd)
        showToast(`Committed & pushed: ${hash.slice(0, 7)}`)
      } catch (pushErr) {
        if (isNoUpstreamError(pushErr)) {
          const branch = gitStatus?.branch || 'HEAD'
          setUpstreamPrompt({ branch, afterCommitHash: hash.slice(0, 7) })
          showToast(`Committed: ${hash.slice(0, 7)} — no upstream branch configured`, 'error')
        } else {
          showToast(pushErr instanceof Error ? pushErr.message : 'Push failed', 'error')
        }
      }
      await refreshStatus()
      if (autoSelectNext) selectNextGitFile(activeSessionId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Commit failed', 'error')
    } finally {
      setLoading(false)
    }
  }, [
    cwd,
    activeSessionId,
    gitCommitMessage,
    stagedCount,
    loading,
    gitStatus?.branch,
    setGitCommitMessage,
    refreshStatus,
    showToast,
    autoSelectNext,
    selectNextGitFile
  ])

  const handlePush = useCallback(async () => {
    if (!cwd || loading) return
    setLoading(true)
    setDropdownOpen(false)
    try {
      await window.api.gitPush(cwd)
      showToast('Pushed!')
    } catch (err) {
      if (isNoUpstreamError(err)) {
        const branch = gitStatus?.branch || 'HEAD'
        setUpstreamPrompt({ branch })
      } else {
        showToast(err instanceof Error ? err.message : 'Push failed', 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [cwd, loading, gitStatus?.branch, showToast])

  const handleGenerateMessage = useCallback(async () => {
    if (!cwd || !activeSessionId || generating) return
    const files = gitStatus?.staged ?? []
    if (files.length === 0) {
      showToast('Stage changes first to generate a message', 'error')
      return
    }
    setGenerating(true)
    try {
      let diff = ''
      for (const f of files) {
        if (diff.length > 8000) break
        const { patch } = await window.api.gitGetFilePatch(cwd, f, true, false)
        if (patch) diff += patch + '\n'
      }
      if (!diff.trim()) {
        showToast('No diff content found', 'error')
        return
      }
      const msg = await window.api.generateCommitMessage(diff)
      if (msg) {
        setGitCommitMessage(activeSessionId, msg)
      } else {
        showToast('Failed to generate message', 'error')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Generation failed', 'error')
    } finally {
      setGenerating(false)
    }
  }, [cwd, activeSessionId, generating, gitStatus?.staged, setGitCommitMessage, showToast])

  const commitDisabled = loading || !gitCommitMessage.trim() || stagedCount === 0
  const isPushMode = gitCommitMode === 'commit-push'
  const handlePrimaryCommit = isPushMode ? handleCommitAndPush : handleCommit

  return (
    <GitCommitBoxView
      gitCommitMessage={gitCommitMessage}
      commitBoxHeight={commitBoxHeight}
      stagedCount={stagedCount}
      totalChanges={totalChanges}
      allStaged={allStaged}
      commitDisabled={commitDisabled}
      isPushMode={isPushMode}
      loading={loading}
      generating={generating}
      toast={toast}
      toastExiting={toastExiting}
      upstreamPrompt={upstreamPrompt}
      dropdownOpen={dropdownOpen}
      dropdownRef={dropdownRef}
      textareaRef={textareaRef}
      onCommitMessageChange={(v) => activeSessionId && setGitCommitMessage(activeSessionId, v)}
      onPrimaryCommit={handlePrimaryCommit}
      onSecondaryCommit={isPushMode ? handleCommit : handleCommitAndPush}
      onPush={handlePush}
      onToggleStageAll={handleToggleStageAll}
      onGenerateMessage={handleGenerateMessage}
      onResizeMouseDown={onResizeMouseDown}
      onToggleDropdown={() => setDropdownOpen(!dropdownOpen)}
      onDismissUpstream={() => setUpstreamPrompt(null)}
      onPushWithUpstream={handlePushWithUpstreamPrompt}
    />
  )
}
