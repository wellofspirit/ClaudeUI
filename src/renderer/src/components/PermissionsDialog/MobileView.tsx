import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionsDialogViewProps } from './View'
import {
  RULE_TEMPLATES,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  useDirSuggestions,
  type RuleCategory
} from './shared'

/**
 * Mobile (viewport ≤768px) permissions UI.
 *
 * The desktop dialog packs a text input into every section, which does not
 * survive a phone: four inputs compete for the ~40% of the viewport the soft
 * keyboard leaves, and on iOS (which ignores `interactive-widget=
 * resizes-content`) the keyboard covers whatever sits at the bottom of the
 * layout viewport regardless. So this view splits into two fullscreen layers:
 *
 *   • browse — zero text inputs, tap targets only;
 *   • entry sheet — exactly one input, TOP-anchored, with the suggestion list
 *     growing downward beneath it. Top-anchoring is what makes it safe on both
 *     platforms: the input is never in the region the keyboard can cover.
 *
 * Every mutation goes through the same props the desktop view uses, so the
 * container (state, dirty tracking, save-on-close) is shared verbatim.
 */

type SheetCategory = RuleCategory | 'dir'

const CATEGORY_META: Record<SheetCategory, { label: string; noun: string; color: string }> = {
  allow: { label: 'Allow', noun: 'Allow rule', color: 'text-success' },
  ask: { label: 'Ask', noun: 'Ask rule', color: 'text-warning' },
  deny: { label: 'Deny', noun: 'Deny rule', color: 'text-danger' },
  dir: { label: 'Additional Directories', noun: 'directory', color: 'text-text-secondary' }
}

interface SheetState {
  mode: 'add' | 'edit'
  category: SheetCategory
  /** Index of the edited entry; ignored in add mode. */
  index: number
}

function ChevronPlus(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function CrossIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function Section({
  category,
  values,
  onAdd,
  onEdit,
  onDelete
}: {
  category: SheetCategory
  values: string[]
  onAdd: () => void
  onEdit: (index: number) => void
  onDelete: (index: number) => void
}): React.JSX.Element {
  const meta = CATEGORY_META[category]
  const unit = category === 'dir' ? 'path' : 'rule'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`text-[11px] font-semibold uppercase tracking-wider ${meta.color} flex-1 min-w-0 truncate`}
        >
          {meta.label}
        </span>
        <span className="text-[10px] text-text-muted shrink-0">
          {values.length} {unit}
          {values.length !== 1 ? 's' : ''}
        </span>
        <button
          data-testid="PermissionsDialog.mobileAdd"
          data-category={category}
          onClick={onAdd}
          className="shrink-0 w-10 h-10 -my-1 flex items-center justify-center rounded-md text-text-muted hover:text-accent hover:bg-bg-hover transition-colors"
          title={`Add ${meta.noun}`}
        >
          <ChevronPlus />
        </button>
      </div>
      {values.length > 0 && (
        <div className="space-y-1">
          {values.map((value, i) => (
            <div
              key={`${value}-${i}`}
              className="flex items-stretch gap-1 bg-bg-tertiary/60 rounded overflow-hidden"
            >
              <button
                data-testid="PermissionsDialog.mobileRule"
                data-category={category}
                data-index={i}
                onClick={() => onEdit(i)}
                className="flex-1 min-w-0 text-left px-2.5 py-2.5 min-h-[40px] text-[12px] font-mono text-text-secondary truncate"
                title={value}
              >
                {value}
              </button>
              <button
                data-testid="PermissionsDialog.mobileDelete"
                data-category={category}
                data-index={i}
                onClick={() => onDelete(i)}
                className="shrink-0 w-10 flex items-center justify-center text-text-muted hover:text-danger transition-colors"
                title="Remove"
              >
                <CrossIcon size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function PermissionsMobileView({
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
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [sheetValue, setSheetValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const showTrustWarning = workspaceTrusted === false && activeTab !== 'user'

  const openSheet = useCallback((state: SheetState, initialValue: string) => {
    setSheet(state)
    setSheetValue(initialValue)
  }, [])

  const closeSheet = useCallback(() => {
    setSheet(null)
    setSheetValue('')
  }, [])

  // Switching scope tab out from under an open sheet would apply the edit to
  // the wrong scope — close it first.
  useEffect(() => {
    setSheet(null)
    setSheetValue('')
  }, [activeTab])

  const isDirSheet = sheet?.category === 'dir'
  const {
    entries: dirEntries,
    navigate,
    confirmPath
  } = useDirSuggestions(sheetValue, onListDir, !!isDirSheet)

  const commitSheet = useCallback(
    (rawValue?: string) => {
      if (!sheet) return
      const value = (rawValue ?? sheetValue).trim()
      if (!value) return
      if (sheet.category === 'dir') {
        if (sheet.mode === 'add') onAddDir(value)
        else onUpdateDir(sheet.index, value)
      } else {
        if (sheet.mode === 'add') onAddRule(sheet.category, value)
        else onUpdateRule(sheet.category, sheet.index, value)
      }
      closeSheet()
    },
    [sheet, sheetValue, onAddDir, onUpdateDir, onAddRule, onUpdateRule, closeSheet]
  )

  const values = (category: SheetCategory): string[] =>
    category === 'dir' ? perms.additionalDirectories : perms[category]

  const sectionProps = (
    category: SheetCategory
  ): {
    category: SheetCategory
    values: string[]
    onAdd: () => void
    onEdit: (index: number) => void
    onDelete: (index: number) => void
  } => ({
    category,
    values: values(category),
    onAdd: () => openSheet({ mode: 'add', category, index: -1 }, ''),
    onEdit: (index) => openSheet({ mode: 'edit', category, index }, values(category)[index] ?? ''),
    onDelete: (index) => (category === 'dir' ? onDeleteDir(index) : onDeleteRule(category, index))
  })

  const sheetMeta = sheet ? CATEGORY_META[sheet.category] : null

  return (
    <div
      data-testid="PermissionsDialog"
      className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent shrink-0"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span className="flex-1 text-[14px] font-medium text-text-primary">Permissions</span>
        <button
          data-testid="PermissionsDialog.close"
          onClick={onClose}
          className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Close"
        >
          <CrossIcon />
        </button>
      </div>

      {/* Scope tabs */}
      <div className="shrink-0 flex items-center px-2 border-b border-border bg-bg-secondary/30">
        {tabs.map((scope) => (
          <button
            key={scope}
            data-testid="PermissionsDialog.tab"
            data-id={scope}
            onClick={() => onChangeTab(scope)}
            className={`relative flex-1 px-3 py-2.5 text-[12px] font-medium transition-colors ${
              activeTab === scope ? 'text-accent' : 'text-text-muted'
            }`}
          >
            {SCOPE_LABELS[scope]}
            {dirty[scope] && (
              <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-accent" />
            )}
            {activeTab === scope && (
              <span className="absolute bottom-0 left-3 right-3 h-[2px] bg-accent rounded-full" />
            )}
          </button>
        ))}
      </div>
      <div className="shrink-0 px-3 py-1.5 border-b border-border/50">
        <span className="text-[10px] text-text-muted font-mono block truncate">
          {SCOPE_DESCRIPTIONS[activeTab]}
        </span>
      </div>

      {/* Untrusted-workspace warning */}
      {showTrustWarning && (
        <div
          data-testid="PermissionsDialog.trustWarning"
          className="shrink-0 flex items-start gap-2 px-3 py-2.5 border-b border-warning/30 bg-warning/10 text-[11px] leading-relaxed text-warning"
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
            <strong className="font-semibold">Allow</strong> rule from the Local and Project scopes.
            Deny and Ask rules still apply, as do Global allows. To trust it, run{' '}
            <code className="font-mono">claude</code> in this directory once and accept the trust
            prompt.
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
            Loading permissions...
          </div>
        ) : (
          <>
            <Section {...sectionProps('allow')} />
            <div className="border-t border-border/50" />
            <Section {...sectionProps('ask')} />
            <div className="border-t border-border/50" />
            <Section {...sectionProps('deny')} />
            <div className="border-t border-border/50" />
            <Section {...sectionProps('dir')} />
          </>
        )}
      </div>

      {/* Footer */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-t border-border bg-bg-secondary/30"
        style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}
      >
        <span className="flex-1 min-w-0 text-[10px] leading-tight text-text-muted">
          Changes take effect on next session start
        </span>
        {hasDirty && (
          <button
            data-testid="PermissionsDialog.save"
            onClick={onSaveAll}
            disabled={saving}
            className="shrink-0 px-3 py-2 text-[12px] font-medium text-bg-primary bg-accent rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
        <button
          data-testid="PermissionsDialog.closeFooter"
          onClick={onClose}
          className="shrink-0 px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary rounded-md"
        >
          {hasDirty ? 'Save & Close' : 'Close'}
        </button>
      </div>

      {/* Entry sheet — one input, top-anchored (see the file header comment) */}
      {sheet && sheetMeta && (
        <div
          data-testid="PermissionsDialog.entrySheet"
          className="fixed inset-0 z-[110] bg-bg-primary flex flex-col animate-fade-in"
        >
          <div
            className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <button
              data-testid="PermissionsDialog.sheetCancel"
              onClick={closeSheet}
              className="shrink-0 px-1 py-2 text-[13px] text-text-secondary"
            >
              Cancel
            </button>
            <span className="flex-1 min-w-0 text-center text-[12px] truncate">
              <span className={sheetMeta.color}>
                {sheet.mode === 'add' ? 'Add' : 'Edit'} {sheetMeta.noun}
              </span>
              <span className="text-text-muted"> · {SCOPE_LABELS[activeTab]}</span>
            </span>
            <button
              data-testid="PermissionsDialog.sheetConfirm"
              onClick={() => commitSheet()}
              disabled={!sheetValue.trim()}
              className="shrink-0 px-2 py-2 text-[13px] font-medium text-accent disabled:opacity-30"
            >
              {sheet.mode === 'add' ? 'Add' : 'Save'}
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 px-3 pt-3">
              <input
                ref={inputRef}
                autoFocus
                value={sheetValue}
                onChange={(e) => setSheetValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitSheet()
                  }
                }}
                placeholder={
                  sheet.category === 'dir'
                    ? '/absolute/path/to/directory'
                    : 'e.g. Bash(git:*), Edit(src/**)'
                }
                className="w-full text-[13px] font-mono bg-bg-input border border-border rounded px-2.5 py-2.5 text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
              />
            </div>

            {sheet.category === 'dir' ? (
              <div className="flex-1 min-h-0 overflow-y-auto mt-2">
                {dirEntries.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-stretch border-b border-border/40 last:border-b-0"
                  >
                    <button
                      data-testid="PermissionsDialog.dirEntry"
                      data-name={entry.name}
                      onClick={() => {
                        setSheetValue(navigate(entry))
                        requestAnimationFrame(() => inputRef.current?.focus())
                      }}
                      className="flex-1 min-w-0 text-left px-3 py-3 text-[13px] font-mono text-text-secondary truncate"
                    >
                      {entry.name}
                      {entry.name === '..' ? '' : '/'}
                    </button>
                    <button
                      data-testid="PermissionsDialog.dirEntrySelect"
                      data-name={entry.name}
                      onClick={() => commitSheet(confirmPath(entry))}
                      className="shrink-0 w-12 flex items-center justify-center text-text-muted hover:text-accent transition-colors"
                      title="Use this directory"
                    >
                      <svg
                        width="15"
                        height="15"
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
                  </div>
                ))}
              </div>
            ) : (
              <div className="shrink-0 flex gap-1.5 overflow-x-auto px-3 py-3">
                {RULE_TEMPLATES.map((t) => (
                  <button
                    key={t.template}
                    data-testid="PermissionsDialog.templateChip"
                    data-template={t.template}
                    onClick={() => setSheetValue(t.template)}
                    className="shrink-0 px-2.5 py-1.5 rounded-full border border-border bg-bg-tertiary/60 text-[11px] text-text-secondary whitespace-nowrap"
                    title={t.template}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
