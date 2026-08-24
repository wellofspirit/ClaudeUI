/**
 * MobileConfigSheet — the mobile-only combined Engine/Model/Thinking/Variant/
 * Effort control. Replaces the crowded row of individual desktop pickers
 * (InlinePickers.tsx) with one compact trigger that opens a bottom sheet.
 *
 * Root page lists capability-gated rows; tapping a row drills into a
 * submenu (root -> submenu, never nested further). Selecting an option
 * applies it and returns to root so the user can keep tuning. Desktop is
 * entirely unaffected — this component is only mounted when isMobile.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  EFFORT_LEVELS,
  THINKING_MODES,
  type EffortLevel,
  type ThinkingMode
} from '../../../../../shared/model-capabilities'
import type { EngineId, PermissionMode } from '../../../../../shared/types'
import {
  PERMISSION_MODE_CYCLE,
  PERMISSION_MODE_LABELS
} from '../../../../../shared/permission-modes'
import { ENGINE_META, engineMeta } from '../../../../../shared/engine-meta'
import { EngineLogo } from '../../shared/EngineLogo'
import {
  ADAPTIVE_UNSUPPORTED_TOOLTIP,
  deriveModelGroups,
  unsupportedTooltip,
  type ModelDisplay
} from '../../shared/InlinePickers'

const ENGINE_LOCKED_TOOLTIP =
  'Engine cannot change after session initialization or for historical sessions'

type Page = 'root' | 'mode' | 'engine' | 'model' | 'thinking' | 'variant' | 'effort'

const PAGE_HEADING: Record<Page, string> = {
  root: 'Run configuration',
  mode: 'Autonomy mode',
  engine: 'Engine',
  model: 'Model',
  thinking: 'Thinking mode',
  variant: 'Reasoning variant',
  effort: 'Effort level'
}

export interface MobileConfigSheetProps {
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  selectedEngineId: EngineId
  engineLocked: boolean
  showModePicker: boolean
  permissionMode: PermissionMode
  canPlan: boolean
  autoAvailable: boolean
  showEnginePicker: boolean
  showModelPicker: boolean
  showThinkingPicker: boolean
  thinkingMode: ThinkingMode
  adaptiveSupported: boolean
  reasoningVariants: string[]
  reasoningVariant: string | null
  effort: string
  effortSupported: boolean
  allowedEffortLevels: readonly EffortLevel[]
  onSelectMode: (mode: PermissionMode) => void
  onSelectEngine: (engineId: EngineId) => void
  onSelectModel: (value: string) => void
  onSelectThinking: (mode: ThinkingMode) => void
  onSelectReasoningVariant: (variant: string | null) => void
  onSelectEffort: (level: EffortLevel) => void
}

// ---------------------------------------------------------------------------
// Shared row/option primitives
// ---------------------------------------------------------------------------

function ChevronRight(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-primary"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function RootRow({
  testId,
  label,
  value,
  subtext,
  disabled,
  title,
  onClick
}: {
  testId: string
  label: string
  value: string
  subtext?: string
  disabled?: boolean
  title?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 px-4 min-h-[56px] text-left transition-colors border-b border-border/50 last:border-b-0 ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-pointer hover:bg-bg-hover active:bg-bg-hover'
      }`}
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-[13px] text-text-primary truncate">{label}</span>
        {subtext && <span className="text-[11px] text-text-muted truncate">{subtext}</span>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 min-w-0 max-w-[55%]">
        <span className="text-[12px] text-text-muted truncate whitespace-nowrap capitalize">
          {value}
        </span>
        {!disabled && <ChevronRight />}
      </div>
    </button>
  )
}

function OptionButton({
  testId,
  dataValue,
  active,
  disabled,
  title,
  onClick,
  children
}: {
  testId: string
  dataValue: string
  active: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-value={dataValue}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 px-4 min-h-[52px] text-left transition-colors border-b border-border/50 last:border-b-0 ${
        disabled
          ? 'opacity-40 cursor-not-allowed text-text-muted'
          : active
            ? 'text-text-primary bg-bg-hover cursor-pointer'
            : 'text-text-secondary hover:bg-bg-hover cursor-pointer'
      }`}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {active && !disabled && <CheckIcon />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Submenu pages
// ---------------------------------------------------------------------------

function ModePage({
  permissionMode,
  canPlan,
  autoAvailable,
  onSelect
}: {
  permissionMode: PermissionMode
  canPlan: boolean
  autoAvailable: boolean
  onSelect: (mode: PermissionMode) => void
}): React.JSX.Element {
  return (
    <div>
      {PERMISSION_MODE_CYCLE.map((mode) => {
        const enabled = (mode !== 'plan' || canPlan) && (mode !== 'auto' || autoAvailable)
        return (
          <OptionButton
            key={mode}
            testId="MobileConfigSheet.modeOption"
            dataValue={mode}
            active={mode === permissionMode}
            disabled={!enabled}
            title={
              enabled
                ? undefined
                : mode === 'plan'
                  ? "Engine doesn't support plan mode"
                  : 'Auto mode is unavailable for this account/organization'
            }
            onClick={() => enabled && onSelect(mode)}
          >
            <span className="text-[13px] truncate">{PERMISSION_MODE_LABELS[mode]}</span>
          </OptionButton>
        )
      })}
    </div>
  )
}

function EnginePage({
  selectedEngineId,
  onSelect
}: {
  selectedEngineId: EngineId
  onSelect: (engineId: EngineId) => void
}): React.JSX.Element {
  return (
    <div>
      {Object.values(ENGINE_META).map((meta) => (
        <OptionButton
          key={meta.id}
          testId="MobileConfigSheet.engineOption"
          dataValue={meta.id}
          active={meta.id === selectedEngineId}
          onClick={() => onSelect(meta.id)}
        >
          <span className="flex items-center gap-2 min-w-0">
            <EngineLogo engineId={meta.id} size={14} className="shrink-0" />
            <span className="text-[13px] truncate">{meta.label}</span>
          </span>
        </OptionButton>
      ))}
    </div>
  )
}

function ModelPage({
  models,
  selectedModel,
  onSelect
}: {
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  onSelect: (value: string) => void
}): React.JSX.Element {
  const [freeOnly, setFreeOnly] = useState(false)
  const groups = useMemo(() => deriveModelGroups(models), [models])
  const isGrouped = groups.length > 1
  const hasFreeModels = useMemo(() => models.some((m) => m.free), [models])
  const displayedGroups = useMemo(() => {
    if (!freeOnly || !hasFreeModels) return groups
    return groups
      .map((g) => ({ ...g, items: g.items.filter((m) => m.free) }))
      .filter((g) => g.items.length > 0)
  }, [groups, freeOnly, hasFreeModels])

  return (
    <div>
      {hasFreeModels && (
        <div className="px-4 pt-3 pb-2 flex items-center border-b border-border/50">
          <button
            type="button"
            data-testid="MobileConfigSheet.modelFreeFilter"
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide transition-colors cursor-pointer border ${
              freeOnly
                ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
            }`}
          >
            Free
          </button>
        </div>
      )}
      {displayedGroups.map((group) => (
        <div key={group.key}>
          {isGrouped && (
            <div className="px-4 pt-3 pb-1 text-[10px] text-text-muted font-medium uppercase tracking-wider">
              {group.label}
            </div>
          )}
          {group.items.map((m) => (
            <OptionButton
              key={m.value}
              testId="MobileConfigSheet.modelOption"
              dataValue={m.value}
              active={m.value === selectedModel.value}
              onClick={() => onSelect(m.value)}
            >
              <div className="min-w-0 flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] truncate">{m.shortName}</span>
                  {m.free && (
                    <span
                      data-testid="MobileConfigSheet.modelFreeBadge"
                      className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium uppercase tracking-wide"
                    >
                      Free
                    </span>
                  )}
                </span>
                {m.description && (
                  <span className="text-[11px] text-text-muted truncate">
                    {m.description.split('·')[1]?.trim()}
                  </span>
                )}
              </div>
            </OptionButton>
          ))}
        </div>
      ))}
    </div>
  )
}

function ThinkingPage({
  thinkingMode,
  adaptiveSupported,
  onSelect
}: {
  thinkingMode: ThinkingMode
  adaptiveSupported: boolean
  onSelect: (mode: ThinkingMode) => void
}): React.JSX.Element {
  return (
    <div>
      {THINKING_MODES.map((mode) => {
        const enabled = mode !== 'adaptive' || adaptiveSupported
        return (
          <OptionButton
            key={mode}
            testId="MobileConfigSheet.thinkingOption"
            dataValue={mode}
            active={mode === thinkingMode}
            disabled={!enabled}
            title={enabled ? undefined : ADAPTIVE_UNSUPPORTED_TOOLTIP}
            onClick={() => enabled && onSelect(mode)}
          >
            <span className="text-[13px] capitalize truncate">{mode}</span>
          </OptionButton>
        )
      })}
    </div>
  )
}

function VariantPage({
  variants,
  selected,
  onSelect
}: {
  variants: string[]
  selected: string | null
  onSelect: (variant: string | null) => void
}): React.JSX.Element {
  return (
    <div>
      {(['Default', ...variants] as const).map((option) => {
        const value = option === 'Default' ? null : (option as string)
        return (
          <OptionButton
            key={option}
            testId="MobileConfigSheet.variantOption"
            dataValue={option}
            active={value === selected}
            onClick={() => onSelect(value)}
          >
            <span className="text-[13px] capitalize truncate">{option}</span>
          </OptionButton>
        )
      })}
    </div>
  )
}

function EffortPage({
  effort,
  allowedEffortLevels,
  onSelect
}: {
  effort: string
  allowedEffortLevels: readonly EffortLevel[]
  onSelect: (level: EffortLevel) => void
}): React.JSX.Element {
  const allowed = new Set<EffortLevel>(allowedEffortLevels)
  return (
    <div>
      {EFFORT_LEVELS.map((level) => {
        const enabled = allowed.has(level)
        return (
          <OptionButton
            key={level}
            testId="MobileConfigSheet.effortOption"
            dataValue={level}
            active={level === effort}
            disabled={!enabled}
            title={enabled ? undefined : unsupportedTooltip(level)}
            onClick={() => enabled && onSelect(level)}
          >
            <span className="text-[13px] capitalize truncate">{level}</span>
          </OptionButton>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MobileConfigSheet(props: MobileConfigSheetProps): React.JSX.Element | null {
  const {
    models,
    selectedModel,
    selectedEngineId,
    engineLocked,
    showModePicker,
    permissionMode,
    canPlan,
    autoAvailable,
    showEnginePicker,
    showModelPicker,
    showThinkingPicker,
    thinkingMode,
    adaptiveSupported,
    reasoningVariants,
    reasoningVariant,
    effort,
    effortSupported,
    allowedEffortLevels,
    onSelectMode,
    onSelectEngine,
    onSelectModel,
    onSelectThinking,
    onSelectReasoningVariant,
    onSelectEffort
  } = props

  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Page>('root')

  const showVariantRow = reasoningVariants.length > 0
  const anyRowApplicable =
    showModePicker ||
    showEnginePicker ||
    showModelPicker ||
    showThinkingPicker ||
    showVariantRow ||
    effortSupported

  // Reset to root whenever the sheet closes, and fail safe if an external
  // prop change (e.g. a model/engine switch) makes the current submenu
  // invalid while the sheet is open — never leave the user stranded on a
  // now-nonexistent page.
  useEffect(() => {
    if (!open) {
      setPage('root')
      return
    }
    if (page === 'mode' && !showModePicker) setPage('root')
    else if (page === 'engine' && !showEnginePicker) setPage('root')
    else if (page === 'model' && !showModelPicker) setPage('root')
    else if (page === 'thinking' && !showThinkingPicker) setPage('root')
    else if (page === 'variant' && !showVariantRow) setPage('root')
    else if (page === 'effort' && !effortSupported) setPage('root')
  }, [
    open,
    page,
    showModePicker,
    showEnginePicker,
    showModelPicker,
    showThinkingPicker,
    showVariantRow,
    effortSupported
  ])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // If every grouped setting becomes inapplicable while the sheet is open
  // (e.g. an engine switch strips all capabilities), close it — otherwise
  // `open` stays true on this still-mounted-but-render-null instance, and
  // the dialog reappears unprompted the moment capabilities return.
  useEffect(() => {
    if (!anyRowApplicable) setOpen(false)
  }, [anyRowApplicable])

  if (!anyRowApplicable) return null

  const close = (): void => setOpen(false)
  const goRoot = (): void => setPage('root')

  return (
    <div data-testid="MobileConfigSheet" className="relative min-w-0 flex-1">
      <button
        type="button"
        data-testid="MobileConfigSheet.trigger"
        title="Run configuration"
        aria-label="Run configuration"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="h-8 w-full min-w-0 max-w-[180px] px-2 flex items-center gap-1.5 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <EngineLogo engineId={selectedEngineId} size={11} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
          {selectedModel.shortName}
          {effortSupported && (
            <>
              {' · '}
              <span className="capitalize">{effort}</span>
            </>
          )}
        </span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="shrink-0"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          data-testid="MobileConfigSheet.dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="MobileConfigSheet-heading"
          className="fixed inset-0 z-[200] flex flex-col justify-end"
        >
          <div
            data-testid="MobileConfigSheet.backdrop"
            onClick={close}
            className="absolute inset-0 bg-black/50"
          />
          <div
            className="relative flex flex-col rounded-t-2xl bg-bg-secondary border-t border-border shadow-2xl max-h-[min(80dvh,32rem)]"
            style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
          >
            <div className="flex justify-center pt-2 pb-1 shrink-0">
              <div className="w-9 h-1 rounded-full bg-border" />
            </div>
            <div className="flex items-center gap-2 px-3 py-3 border-b border-border shrink-0">
              {page !== 'root' && (
                <button
                  type="button"
                  data-testid="MobileConfigSheet.back"
                  onClick={goRoot}
                  aria-label="Back"
                  className="w-9 h-9 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              )}
              <h2
                id="MobileConfigSheet-heading"
                className="flex-1 min-w-0 truncate text-[14px] font-medium text-text-primary"
              >
                {PAGE_HEADING[page]}
              </h2>
              <button
                type="button"
                data-testid="MobileConfigSheet.close"
                onClick={close}
                aria-label="Close"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
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
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain">
              {page === 'root' && (
                <div>
                  {showModePicker && (
                    <RootRow
                      testId="MobileConfigSheet.mode"
                      label="Mode"
                      value={PERMISSION_MODE_LABELS[permissionMode]}
                      onClick={() => setPage('mode')}
                    />
                  )}
                  {showEnginePicker && (
                    <RootRow
                      testId="MobileConfigSheet.engine"
                      label="Engine"
                      value={engineMeta(selectedEngineId).label}
                      disabled={engineLocked}
                      title={engineLocked ? ENGINE_LOCKED_TOOLTIP : undefined}
                      subtext={engineLocked ? ENGINE_LOCKED_TOOLTIP : undefined}
                      onClick={() => !engineLocked && setPage('engine')}
                    />
                  )}
                  {showModelPicker && (
                    <RootRow
                      testId="MobileConfigSheet.model"
                      label="Model"
                      value={selectedModel.shortName}
                      onClick={() => setPage('model')}
                    />
                  )}
                  {showThinkingPicker && (
                    <RootRow
                      testId="MobileConfigSheet.thinking"
                      label="Thinking"
                      value={thinkingMode}
                      onClick={() => setPage('thinking')}
                    />
                  )}
                  {showVariantRow && (
                    <RootRow
                      testId="MobileConfigSheet.variant"
                      label="Reasoning variant"
                      value={reasoningVariant ?? 'Default'}
                      onClick={() => setPage('variant')}
                    />
                  )}
                  {effortSupported && (
                    <RootRow
                      testId="MobileConfigSheet.effort"
                      label="Effort"
                      value={effort}
                      onClick={() => setPage('effort')}
                    />
                  )}
                </div>
              )}

              {page === 'mode' && (
                <ModePage
                  permissionMode={permissionMode}
                  canPlan={canPlan}
                  autoAvailable={autoAvailable}
                  onSelect={(mode) => {
                    onSelectMode(mode)
                    goRoot()
                  }}
                />
              )}

              {page === 'engine' && (
                <EnginePage
                  selectedEngineId={selectedEngineId}
                  onSelect={(id) => {
                    onSelectEngine(id)
                    goRoot()
                  }}
                />
              )}

              {page === 'model' && (
                <ModelPage
                  models={models}
                  selectedModel={selectedModel}
                  onSelect={(value) => {
                    onSelectModel(value)
                    goRoot()
                  }}
                />
              )}

              {page === 'thinking' && (
                <ThinkingPage
                  thinkingMode={thinkingMode}
                  adaptiveSupported={adaptiveSupported}
                  onSelect={(mode) => {
                    onSelectThinking(mode)
                    goRoot()
                  }}
                />
              )}

              {page === 'variant' && (
                <VariantPage
                  variants={reasoningVariants}
                  selected={reasoningVariant}
                  onSelect={(variant) => {
                    onSelectReasoningVariant(variant)
                    goRoot()
                  }}
                />
              )}

              {page === 'effort' && (
                <EffortPage
                  effort={effort}
                  allowedEffortLevels={allowedEffortLevels}
                  onSelect={(level) => {
                    onSelectEffort(level)
                    goRoot()
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
