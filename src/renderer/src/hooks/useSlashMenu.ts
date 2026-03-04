import { useState, useMemo, useCallback } from 'react'
import type { SlashCommandInfo } from '../../../shared/types'
import { filterSlashCommands } from '../components/chat/SlashCommandMenu'

export interface UseSlashMenuOptions {
  slashCommands: SlashCommandInfo[]
  text: string
  setText: (text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export interface UseSlashMenuReturn {
  slashMenuOpen: boolean
  slashMenuIndex: number
  slashFilter: string
  filteredCommands: SlashCommandInfo[]
  /** Called from handleInput to update slash menu state based on text changes */
  handleInputChange: (value: string) => void
  /** Keyboard handler — returns true if the event was consumed by the slash menu */
  handleKeyDown: (e: React.KeyboardEvent) => boolean
  /** Select a slash command by name */
  handleSelect: (name: string) => void
}

export function useSlashMenu({
  slashCommands,
  text,
  setText,
  textareaRef
}: UseSlashMenuOptions): UseSlashMenuReturn {
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)

  const slashFilter = slashMenuOpen && text.startsWith('/') ? text.slice(1).split(/\s/)[0] : ''

  const filteredCommands = useMemo(
    () => (slashMenuOpen ? filterSlashCommands(slashCommands, slashFilter) : []),
    [slashMenuOpen, slashCommands, slashFilter]
  )

  const handleSelect = useCallback((name: string): void => {
    setText(name + ' ')
    setSlashMenuOpen(false)
    setSlashMenuIndex(0)
    textareaRef.current?.focus()
  }, [setText, textareaRef])

  /** Called from handleInput to update slash menu state based on text changes */
  const handleInputChange = useCallback((value: string): void => {
    if (value.startsWith('/') && !value.includes(' ')) {
      setSlashMenuOpen(true)
      setSlashMenuIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }, [])

  /** Keyboard handler — returns true if the event was consumed */
  const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!slashMenuOpen || filteredCommands.length === 0) return false

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashMenuIndex((i) => (i + 1) % filteredCommands.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      handleSelect(filteredCommands[slashMenuIndex].name)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlashMenuOpen(false)
      return true
    }
    return false
  }, [slashMenuOpen, filteredCommands, slashMenuIndex, handleSelect])

  return {
    slashMenuOpen,
    slashMenuIndex,
    slashFilter,
    filteredCommands,
    handleInputChange,
    handleKeyDown,
    handleSelect
  }
}
