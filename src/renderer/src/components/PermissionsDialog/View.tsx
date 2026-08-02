import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ClaudePermissions, PermissionScope, DirEntry } from '../../../../shared/types'
import { FileMentionMenu } from '../chat/FileMentionMenu'

export type RuleCategory = 'allow' | 'deny' | 'ask'

const SCOPE_LABELS: Record<PermissionScope, string> = {
  local: 'Local',
  project: 'Project',
  user: 'Global'
}

const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  local: '.claude/settings.local.json (gitignored)',
  project: '.claude/settings.json (committed)',
  user: '~/.claude/settings.json (user-wide)'
}

// Common rule templates for the add helper
const RULE_TEMPLATES = [
  { label: 'Bash command', template: 'Bash(command:*)' },
  { label: 'Edit files', template: 'Edit' },
  { label: 'Edit in path', template: 'Edit(src/**)' },
  { label: 'Read files', template: 'Read' },
  { label: 'Write files', template: 'Write' },
  { label: 'Glob', template: 'Glob' },
  { label: 'WebFetch domain', template: 'WebFetch(domain:example.com)' },
  { label: 'WebSearch', template: 'WebSearch' },
  { label: 'MCP server', template: 'mcp__server__*' },
  { label: 'Agent (subagent)', template: 'Agent' }
]

export interface PermissionsDialogViewProps {
  loading: boolean
  saving: boolean
  activeTab: PermissionScope
  tabs: PermissionScope[]
  perms: ClaudePermissions
  dirty: Record<PermissionScope, boolean>
  hasDirty: boolean
  /** ~/.claude.json trust flag for the current cwd; null = unknown/not probed. */
  workspaceTrusted: boolean | null
  onListDir: (path: string) => Promise<{ entries: DirEntry[]; isRoot: boolean }>
  onChangeTab: (scope: PermissionScope) => Promise<void>
  onUpdateRule: (category: RuleCategory, index: number, value: string) => void
  onDeleteRule: (category: RuleCategory, index: number) => void
  onAddRule: (category: RuleCategory, rule: string) => void
  onUpdateDir: (index: number, value: string) => void
  onDeleteDir: (index: number) => void
  onAddDir: (dir: string) => void
  onSaveAll: () => Promise<void>
  onClose: () => void
}

function RulePill({
  value,
  onUpdate,
  onDelete
}: {
  value: string
  onUpdate: (newValue: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = (): void => {
    setDraft(value)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.select())
  }

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onUpdate(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="flex-1 min-w-0 text-[12px] font-mono bg-bg-input border border-accent/50 rounded px-2 py-1 text-text-primary outline-none"
          spellCheck={false}
        />
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-1 bg-bg-tertiary/60 rounded px-2.5 py-1 text-[12px] font-mono text-text-secondary hover:bg-bg-tertiary transition-colors">
      <span
        className="flex-1 min-w-0 truncate cursor-default"
        onDoubleClick={startEditing}
        title={value}
      >
        {value}
      </span>
      <button
        onClick={startEditing}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all cursor-default"
        title="Edit"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-text-muted opacity-0 group-hover:opacity-100 hover:text-danger transition-all cursor-default"
        title="Remove"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function AddRuleInput({
  onAdd,
  onListDir,
  placeholder,
  dirAutocomplete
}: {
  onAdd: (rule: string) => void
  onListDir: (path: string) => Promise<{ entries: DirEntry[]; isRoot: boolean }>
  placeholder: string
  dirAutocomplete?: boolean
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [dirEntries, setDirEntries] = useState<DirEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowTemplates(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const { dirPortion, query } = useMemo(() => {
    if (!dirAutocomplete || !value) return { dirPortion: '', query: '' }
    const normalized = value.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash < 0) return { dirPortion: '', query: normalized }
    return {
      dirPortion: value.slice(0, lastSlash) || '/',
      query: value.slice(lastSlash + 1)
    }
  }, [dirAutocomplete, value])

  const isAbsolutePath = /^(\/|[A-Za-z]:)/.test(value)

  const [dirIsRoot, setDirIsRoot] = useState(false)
  useEffect(() => {
    if (!dirAutocomplete || !isAbsolutePath || !dirPortion) {
      setDirEntries([])
      setDirIsRoot(false)
      return
    }
    const listPath = /^[A-Za-z]:$/.test(dirPortion) ? dirPortion + '\\' : dirPortion
    onListDir(listPath)
      .then(({ entries, isRoot }) => {
        setDirEntries(entries.filter((e) => e.isDirectory))
        setDirIsRoot(isRoot)
        setSelectedIndex(0)
      })
      .catch(() => {
        setDirEntries([])
        setDirIsRoot(false)
      })
  }, [dirAutocomplete, dirPortion, isAbsolutePath, onListDir])

  const filteredEntries = useMemo(() => {
    if (!dirAutocomplete || !isAbsolutePath || dirEntries.length === 0) return []
    const items: DirEntry[] = dirIsRoot
      ? dirEntries
      : [{ name: '..', isDirectory: true }, ...dirEntries]
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((e) => e.name.toLowerCase().includes(q))
  }, [dirAutocomplete, isAbsolutePath, dirEntries, dirIsRoot, query])

  const menuOpen = filteredEntries.length > 0

  const handleDirNavigate = useCallback(
    (entry: DirEntry) => {
      const sep = value.includes('\\') ? '\\' : '/'
      let newValue: string
      if (entry.name === '..') {
        const normalized = dirPortion.replace(/\\/g, '/')
        const lastSlash = normalized.lastIndexOf('/')
        const parent =
          lastSlash > 0 ? dirPortion.slice(0, lastSlash) : dirPortion.slice(0, lastSlash + 1)
        newValue = parent + sep
      } else {
        newValue = dirPortion + sep + entry.name + sep
      }
      newValue = newValue.replace(/[/\\]{2,}/g, sep)
      setValue(newValue)
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [value, dirPortion]
  )

  const handleDirConfirm = useCallback(
    (entry: DirEntry) => {
      if (entry.name === '..') {
        const trimmed = dirPortion.replace(/[/\\]+$/, '')
        if (trimmed) {
          onAdd(trimmed)
          setValue('')
        }
      } else {
        const sep = value.includes('\\') ? '\\' : '/'
        const fullPath = (dirPortion + sep + entry.name).replace(/[/\\]{2,}/g, sep)
        onAdd(fullPath)
        setValue('')
      }
    },
    [value, dirPortion, onAdd]
  )

  const commit = (): void => {
    const trimmed = value.trim()
    if (trimmed) {
      onAdd(trimmed)
      setValue('')
    }
  }

  return (
    <div ref={wrapperRef} className="relative flex items-center gap-1">
      {menuOpen && (
        <FileMentionMenu
          entries={filteredEntries}
          selectedIndex={selectedIndex}
          onSelect={handleDirConfirm}
        />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelectedIndex((i) => (i + 1) % filteredEntries.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelectedIndex((i) => (i - 1 + filteredEntries.length) % filteredEntries.length)
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              const entry = filteredEntries[selectedIndex]
              if (entry) handleDirNavigate(entry)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const entry = filteredEntries[selectedIndex]
              if (entry) handleDirConfirm(entry)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setValue('')
              return
            }
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setValue('')
        }}
        placeholder={placeholder}
        className="flex-1 min-w-0 text-[12px] font-mono bg-bg-input border border-border rounded px-2 py-1 text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
        spellCheck={false}
      />
      <button
        onClick={() => setShowTemplates((s) => !s)}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        title="Insert template"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        onClick={commit}
        disabled={!value.trim()}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-accent disabled:opacity-30 transition-colors cursor-default"
        title="Add rule"
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
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
      {showTemplates && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-bg-primary border border-border rounded-lg shadow-lg py-1 min-w-[220px] animate-fade-in">
          {RULE_TEMPLATES.map((t) => (
            <button
              key={t.template}
              onClick={() => {
                setValue(t.template)
                setShowTemplates(false)
              }}
              className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors cursor-default"
            >
              <span className="text-text-secondary">{t.label}</span>
              <span className="text-text-muted ml-2 font-mono text-[11px]">{t.template}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleSection({
  label,
  labelColor,
  rules,
  onUpdate,
  onDelete,
  onAdd,
  onListDir,
  addPlaceholder
}: {
  label: string
  labelColor: string
  rules: string[]
  onUpdate: (index: number, value: string) => void
  onDelete: (index: number) => void
  onAdd: (rule: string) => void
  onListDir: (path: string) => Promise<{ entries: DirEntry[]; isRoot: boolean }>
  addPlaceholder: string
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${labelColor}`}>
          {label}
        </span>
        <span className="text-[10px] text-text-muted">
          {rules.length} rule{rules.length !== 1 ? 's' : ''}
        </span>
      </div>
      {rules.length > 0 && (
        <div className="space-y-1">
          {rules.map((rule, i) => (
            <RulePill
              key={`${rule}-${i}`}
              value={rule}
              onUpdate={(v) => onUpdate(i, v)}
              onDelete={() => onDelete(i)}
            />
          ))}
        </div>
      )}
      <AddRuleInput onAdd={onAdd} onListDir={onListDir} placeholder={addPlaceholder} />
    </div>
  )
}

function DirectoriesSection({
  dirs,
  onUpdate,
  onDelete,
  onAdd,
  onListDir
}: {
  dirs: string[]
  onUpdate: (index: number, value: string) => void
  onDelete: (index: number) => void
  onAdd: (dir: string) => void
  onListDir: (path: string) => Promise<{ entries: DirEntry[]; isRoot: boolean }>
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Additional Directories
        </span>
        <span className="text-[10px] text-text-muted">
          {dirs.length} path{dirs.length !== 1 ? 's' : ''}
        </span>
      </div>
      {dirs.length > 0 && (
        <div className="space-y-1">
          {dirs.map((dir, i) => (
            <RulePill
              key={`${dir}-${i}`}
              value={dir}
              onUpdate={(v) => onUpdate(i, v)}
              onDelete={() => onDelete(i)}
            />
          ))}
        </div>
      )}
      <AddRuleInput
        onAdd={onAdd}
        onListDir={onListDir}
        placeholder="/absolute/path/to/directory"
        dirAutocomplete
      />
    </div>
  )
}

export function PermissionsDialogView({
  loading,
  saving,
  activeTab,
  tabs,
  perms,
  dirty,
  hasDirty,
  workspaceTrusted,
  onListDir,
  onChangeTab,
  onUpdateRule,
  onDeleteRule,
  onAddRule,
  onUpdateDir,
  onDeleteDir,
  onAddDir,
  onSaveAll,
  onClose
}: PermissionsDialogViewProps): React.JSX.Element {
  // Untrusted workspace: cli.js drops project/local ALLOW rules on the floor
  // (silently — the warning is suppressed non-interactively). Only worth saying
  // on the tabs those rules live in.
  const showTrustWarning = workspaceTrusted === false && activeTab !== 'user'
  return (
    <div
      data-testid="PermissionsDialog"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 680, maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span className="text-[14px] font-medium text-text-primary">Permissions</span>
          </div>
          <button
            data-testid="PermissionsDialog.close"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex items-center gap-0 px-5 border-b border-border bg-bg-secondary/30">
          {tabs.map((scope) => (
            <button
              key={scope}
              data-testid="PermissionsDialog.tab"
              data-id={scope}
              onClick={() => onChangeTab(scope)}
              className={`relative px-4 py-2.5 text-[12px] font-medium transition-colors cursor-default ${
                activeTab === scope ? 'text-accent' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {SCOPE_LABELS[scope]}
              {dirty[scope] && (
                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-accent" />
              )}
              {activeTab === scope && (
                <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-accent rounded-full" />
              )}
            </button>
          ))}
          <span className="flex-1" />
          <span
            className="text-[10px] text-text-muted font-mono truncate max-w-[280px]"
            title={SCOPE_DESCRIPTIONS[activeTab]}
          >
            {SCOPE_DESCRIPTIONS[activeTab]}
          </span>
        </div>

        {/* Untrusted-workspace warning */}
        {showTrustWarning && (
          <div
            data-testid="PermissionsDialog.trustWarning"
            className="shrink-0 flex items-start gap-2 px-5 py-2.5 border-b border-warning/30 bg-warning/10 text-[11px] leading-relaxed text-warning"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 mt-[1px]"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            <span>
              This workspace is not trusted, so Claude Code ignores every{' '}
              <strong className="font-semibold">Allow</strong> rule from the Local and Project
              scopes. Deny and Ask rules still apply, as do Global allows. To trust it, run{' '}
              <code className="font-mono">claude</code> in this directory once and accept the trust
              prompt.
            </span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
              Loading permissions...
            </div>
          ) : (
            <>
              <RuleSection
                label="Allow"
                labelColor="text-success"
                rules={perms.allow}
                onUpdate={(i, v) => onUpdateRule('allow', i, v)}
                onDelete={(i) => onDeleteRule('allow', i)}
                onAdd={(rule) => onAddRule('allow', rule)}
                onListDir={onListDir}
                addPlaceholder="e.g. Bash(git:*), Edit(src/**)"
              />

              <div className="border-t border-border/50" />

              <RuleSection
                label="Ask"
                labelColor="text-warning"
                rules={perms.ask}
                onUpdate={(i, v) => onUpdateRule('ask', i, v)}
                onDelete={(i) => onDeleteRule('ask', i)}
                onAdd={(rule) => onAddRule('ask', rule)}
                onListDir={onListDir}
                addPlaceholder="e.g. Bash(git push:*)"
              />

              <div className="border-t border-border/50" />

              <RuleSection
                label="Deny"
                labelColor="text-danger"
                rules={perms.deny}
                onUpdate={(i, v) => onUpdateRule('deny', i, v)}
                onDelete={(i) => onDeleteRule('deny', i)}
                onAdd={(rule) => onAddRule('deny', rule)}
                onListDir={onListDir}
                addPlaceholder="e.g. Bash(rm -rf /*)"
              />

              <div className="border-t border-border/50" />

              <DirectoriesSection
                dirs={perms.additionalDirectories}
                onUpdate={onUpdateDir}
                onDelete={onDeleteDir}
                onAdd={onAddDir}
                onListDir={onListDir}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-border bg-bg-secondary/30">
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
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
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Changes take effect on next session start
          </div>
          <div className="flex items-center gap-2">
            {hasDirty && (
              <button
                data-testid="PermissionsDialog.save"
                onClick={onSaveAll}
                disabled={saving}
                className="px-3 py-1.5 text-[12px] font-medium text-bg-primary bg-accent hover:bg-accent-hover rounded-md transition-colors cursor-default disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
            <button
              data-testid="PermissionsDialog.closeFooter"
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors cursor-default"
            >
              {hasDirty ? 'Save & Close' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
