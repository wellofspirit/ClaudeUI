import { useState, useEffect, useMemo, useCallback } from 'react'
import type { DirEntry } from '../../../shared/types'

export interface UseFileMentionOptions {
  cwd: string
  text: string
  setText: (text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export interface UseFileMentionReturn {
  fileMentionOpen: boolean
  fileMentionIndex: number
  filteredEntries: DirEntry[]
  /** Called from handleInput to update file mention state based on text changes */
  handleInputChange: (value: string, cursorPos: number) => void
  /** Keyboard handler — returns true if the event was consumed by the file mention menu */
  handleKeyDown: (e: React.KeyboardEvent) => boolean
  /** Navigate into a directory (Tab on a dir entry) */
  handleNavigate: (entry: DirEntry) => void
  /** Confirm a selection (Enter / click) */
  handleConfirm: (entry: DirEntry) => void
  /** Close the menu */
  close: () => void
}

export function useFileMention({
  cwd,
  text,
  setText,
  textareaRef
}: UseFileMentionOptions): UseFileMentionReturn {
  const [fileMentionOpen, setFileMentionOpen] = useState(false)
  const [fileMentionIndex, setFileMentionIndex] = useState(0)
  const [fileMentionAnchor, setFileMentionAnchor] = useState(-1) // cursor position of '@'
  const [fileMentionDir, setFileMentionDir] = useState('')        // relative dir being browsed
  const [fileMentionEntries, setFileMentionEntries] = useState<DirEntry[]>([])

  const fileMentionIsAbsolute = /^(\/|[A-Za-z]:)/.test(fileMentionDir)
  const [fileMentionIsRoot, setFileMentionIsRoot] = useState(false)
  const [fileMentionResolvedPath, setFileMentionResolvedPath] = useState('')

  // Fetch directory entries when the browsing dir changes
  useEffect(() => {
    if (!fileMentionOpen || (!cwd && !fileMentionIsAbsolute)) return
    let fullDir: string
    if (fileMentionIsAbsolute) {
      fullDir = /^[A-Za-z]:$/.test(fileMentionDir) ? fileMentionDir + '\\' : fileMentionDir
    } else {
      const separator = cwd.includes('\\') ? '\\' : '/'
      fullDir = fileMentionDir ? cwd + separator + fileMentionDir.replace(/\//g, separator) : cwd
    }
    window.api.listDir(fullDir).then(({ entries, isRoot, resolvedPath }) => {
      setFileMentionEntries(entries)
      setFileMentionIsRoot(isRoot)
      setFileMentionResolvedPath(resolvedPath)
    }).catch(() => {
      setFileMentionEntries([])
      setFileMentionIsRoot(false)
      setFileMentionResolvedPath('')
    })
  }, [fileMentionOpen, fileMentionDir, fileMentionIsAbsolute, cwd])

  // Compute the filter text (last path segment after the last /)
  const fileMentionQuery = useMemo(() => {
    if (!fileMentionOpen || fileMentionAnchor < 0) return ''
    const afterAt = text.slice(fileMentionAnchor + 1)
    const lastSlash = afterAt.lastIndexOf('/')
    return lastSlash >= 0 ? afterAt.slice(lastSlash + 1) : afterAt
  }, [fileMentionOpen, fileMentionAnchor, text])

  // When a relative path resolves to filesystem root, rewrite to absolute
  useEffect(() => {
    if (!fileMentionIsRoot || fileMentionIsAbsolute || !fileMentionResolvedPath) return
    const absDir = fileMentionResolvedPath
    const oldDirWithSlash = fileMentionDir ? fileMentionDir + '/' : ''
    const before = text.slice(0, fileMentionAnchor + 1)
    const after = text.slice(fileMentionAnchor + 1 + oldDirWithSlash.length + fileMentionQuery.length)
    const newPath = absDir + '/'
    const newText = before + newPath + after
    setText(newText)
    setFileMentionDir(absDir)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        const pos = fileMentionAnchor + 1 + newPath.length
        el.selectionStart = pos
        el.selectionEnd = pos
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileMentionIsRoot, fileMentionResolvedPath])

  const filteredEntries = useMemo(() => {
    if (!fileMentionOpen) return []
    const items: DirEntry[] = fileMentionIsRoot
      ? fileMentionEntries
      : [{ name: '..', isDirectory: true }, ...fileMentionEntries]
    if (!fileMentionQuery) return items
    const q = fileMentionQuery.toLowerCase()
    return items.filter((e) => e.name.toLowerCase().includes(q))
  }, [fileMentionOpen, fileMentionIsRoot, fileMentionEntries, fileMentionQuery])

  const close = useCallback(() => {
    setFileMentionOpen(false)
    setFileMentionAnchor(-1)
    setFileMentionDir('')
  }, [])

  /** Navigate into a directory (Tab) — updates text, keeps menu open */
  const handleNavigate = useCallback((entry: DirEntry): void => {
    if (!entry.isDirectory) return
    const isAbsolute = /^(\/|[A-Za-z]:)/.test(fileMentionDir)
    let newDir: string
    if (entry.name === '..') {
      const lastSlash = fileMentionDir.lastIndexOf('/')
      if (isAbsolute) {
        if (lastSlash > 0) newDir = fileMentionDir.slice(0, lastSlash)
        else newDir = fileMentionDir.slice(0, lastSlash + 1) || fileMentionDir
      } else {
        if (fileMentionDir === '') {
          newDir = '..'
        } else if (fileMentionDir === '..') {
          newDir = '../..'
        } else if (fileMentionDir.endsWith('/..')) {
          newDir = fileMentionDir + '/..'
        } else {
          newDir = lastSlash >= 0 ? fileMentionDir.slice(0, lastSlash) : ''
        }
      }
    } else {
      newDir = fileMentionDir ? fileMentionDir + '/' + entry.name : entry.name
    }
    const before = text.slice(0, fileMentionAnchor + 1)
    const after = text.slice(fileMentionAnchor + 1 + (fileMentionDir ? fileMentionDir.length + 1 : 0) + fileMentionQuery.length)
    const newPath = newDir ? newDir + '/' : ''
    const newText = before + newPath + after
    setText(newText)
    setFileMentionDir(newDir)
    setFileMentionIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        const cursorPos = fileMentionAnchor + 1 + newPath.length
        el.selectionStart = cursorPos
        el.selectionEnd = cursorPos
        el.focus()
      }
    })
  }, [text, fileMentionAnchor, fileMentionDir, fileMentionQuery, setText, textareaRef])

  /** Confirm a mention selection (Enter / click) */
  const handleConfirm = useCallback((entry: DirEntry): void => {
    let fullPath: string
    if (entry.isDirectory && entry.name === '..') {
      fullPath = fileMentionDir || '.'
    } else {
      fullPath = fileMentionDir ? fileMentionDir + '/' + entry.name : entry.name
    }
    const before = text.slice(0, fileMentionAnchor)
    const cursorInText = fileMentionAnchor + 1 + (fileMentionDir ? fileMentionDir.length + 1 : 0) + fileMentionQuery.length
    const after = text.slice(cursorInText)
    const needsQuotes = fullPath.includes(' ')
    const mention = needsQuotes ? `@"${fullPath}"` : `@${fullPath}`
    const newText = before + mention + ' ' + after
    setText(newText)
    setFileMentionOpen(false)
    setFileMentionAnchor(-1)
    setFileMentionDir('')
    setFileMentionIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        const cursorPos = before.length + mention.length + 1
        el.selectionStart = cursorPos
        el.selectionEnd = cursorPos
        el.focus()
      }
    })
  }, [text, fileMentionAnchor, fileMentionDir, fileMentionQuery, setText, textareaRef])

  /** Called from handleInput to update file mention state based on text changes */
  const handleInputChange = useCallback((value: string, cursorPos: number): void => {
    if (fileMentionOpen) {
      // Check if user deleted back past the @ anchor
      if (cursorPos <= fileMentionAnchor) {
        setFileMentionOpen(false)
        setFileMentionAnchor(-1)
        setFileMentionDir('')
      } else {
        // Update dir from the text between anchor+1 and cursor.
        const rawAfterAt = value.slice(fileMentionAnchor + 1, cursorPos)
        const afterAt = rawAfterAt.replace(/\\/g, '/')

        // If backslashes were present, rewrite the text to use forward slashes
        if (afterAt !== rawAfterAt) {
          const before = value.slice(0, fileMentionAnchor + 1)
          const afterCursor = value.slice(cursorPos)
          setText(before + afterAt + afterCursor)
        }

        const lastSlash = afterAt.lastIndexOf('/')
        let newDir = lastSlash >= 0 ? afterAt.slice(0, lastSlash) : ''

        // For absolute paths, resolve .. segments that would go above filesystem root
        const isAbs = /^(\/|[A-Za-z]:)/.test(newDir)
        if (isAbs && newDir.includes('..')) {
          const prefix = newDir.match(/^(\/|[A-Za-z]:)/)?.[0] ?? ''
          const rest = newDir.slice(prefix.length).replace(/^\//, '')
          const parts = rest.split('/').reduce<string[]>((acc, seg) => {
            if (seg === '..' && acc.length > 0) acc.pop()
            else if (seg !== '..' && seg !== '.' && seg !== '') acc.push(seg)
            return acc
          }, [])
          const resolved = prefix + (parts.length ? '/' + parts.join('/') : '')
          if (resolved !== newDir) {
            newDir = resolved
            const query = afterAt.slice(lastSlash + 1)
            const before = value.slice(0, fileMentionAnchor + 1)
            const afterCursor = value.slice(cursorPos)
            const rewritten = newDir ? newDir + '/' + query : query
            const newText = before + rewritten + afterCursor
            if (newText !== value) {
              setText(newText)
              requestAnimationFrame(() => {
                const ta = textareaRef.current
                if (ta) {
                  const pos = fileMentionAnchor + 1 + rewritten.length
                  ta.selectionStart = pos
                  ta.selectionEnd = pos
                }
              })
            }
          }
        }

        if (newDir !== fileMentionDir) {
          setFileMentionDir(newDir)
          setFileMentionIndex(0)
        }
      }
    } else {
      // Detect a newly typed '@' preceded by whitespace or at start
      if (cursorPos > 0 && value[cursorPos - 1] === '@') {
        const charBefore = cursorPos >= 2 ? value[cursorPos - 2] : undefined
        if (charBefore === undefined || /\s/.test(charBefore)) {
          setFileMentionOpen(true)
          setFileMentionAnchor(cursorPos - 1)
          setFileMentionDir('')
          setFileMentionIndex(0)
        }
      }
    }
  }, [fileMentionOpen, fileMentionAnchor, fileMentionDir, setText, textareaRef])

  /** Keyboard handler — returns true if the event was consumed */
  const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!fileMentionOpen || filteredEntries.length === 0) return false

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFileMentionIndex((i) => (i + 1) % filteredEntries.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFileMentionIndex((i) => (i - 1 + filteredEntries.length) % filteredEntries.length)
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const entry = filteredEntries[fileMentionIndex]
      if (entry.isDirectory) handleNavigate(entry)
      else handleConfirm(entry)
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm(filteredEntries[fileMentionIndex])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return true
    }
    return false
  }, [fileMentionOpen, filteredEntries, fileMentionIndex, handleNavigate, handleConfirm, close])

  return {
    fileMentionOpen,
    fileMentionIndex,
    filteredEntries,
    handleInputChange,
    handleKeyDown,
    handleNavigate,
    handleConfirm,
    close
  }
}
