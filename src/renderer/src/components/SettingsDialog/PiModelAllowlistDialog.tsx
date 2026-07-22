import { useEffect, useRef, useState } from 'react'

interface PiModelAllowlistEntry {
  id: string
  name: string
  provider: string
  reasoning?: boolean
  toolCalling?: boolean
}

export function PiModelAllowlistDialog({
  providerName,
  current,
  onSave,
  onClose
}: {
  providerName: string
  current: string[] | undefined
  onSave: (ids: string[]) => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [models, setModels] = useState<PiModelAllowlistEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set(current ?? []))
  const [search, setSearch] = useState('')
  const seededRef = useRef(current !== undefined)

  useEffect(() => {
    let cancelled = false
    window.api
      .getPiModelCatalogGroups()
      .then((groups) =>
        groups.flatMap((group) =>
          group.models.map((model) => ({
            id: model.value,
            name: model.displayName,
            provider: group.vendorName || group.vendorId,
            reasoning: model.supportsEffort,
            toolCalling: model.toolCalling
          }))
        )
      )
      .then((list) => {
        if (cancelled) return
        setModels(list)
        if (!seededRef.current) {
          seededRef.current = true
          setChecked(new Set(list.map((model) => model.id)))
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Failed to load model catalog')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = (models ?? []).filter((model) => {
    const query = search.trim().toLowerCase()
    if (!query) return true
    return (
      model.id.toLowerCase().includes(query) ||
      model.name.toLowerCase().includes(query) ||
      model.provider?.toLowerCase().includes(query)
    )
  })

  const toggle = (id: string): void => {
    setChecked((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave([...checked])
      setSaving(false)
      onClose()
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'Failed to save model selection')
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="ModelAllowlistDialog"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] max-h-[80vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-text-primary">Models · {providerName}</div>
            <div className="text-[11px] text-text-muted/70">
              Pick which models appear in ClaudeUI&rsquo;s picker. {checked.size} selected.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close model manager"
            className="text-text-muted/60 hover:text-text-primary transition-colors text-[16px] leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
          <input
            type="text"
            data-testid="ModelAllowlistDialog.search"
            placeholder="Search models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="flex-1 px-2 py-1 text-[11px] rounded bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60"
          />
          <button
            data-testid="ModelAllowlistDialog.selectAll"
            onClick={() => setChecked(new Set((models ?? []).map((model) => model.id)))}
            className="text-[10px] text-accent hover:text-accent/80 transition-colors whitespace-nowrap"
          >
            Select all
          </button>
          <button
            data-testid="ModelAllowlistDialog.clear"
            onClick={() => setChecked(new Set())}
            className="text-[10px] text-text-muted/70 hover:text-text-primary transition-colors whitespace-nowrap"
          >
            Clear
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {error || saveError ? (
            <div
              data-testid="ModelAllowlistDialog.error"
              className="px-2 py-3 text-[11px] text-danger"
            >
              {error || saveError}
            </div>
          ) : models === null ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">Loading models…</div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-text-muted/60">No models match.</div>
          ) : (
            filtered.map((model) => (
              <button
                key={model.id}
                data-testid="ModelAllowlistDialog.modelRow"
                data-id={model.id}
                onClick={() => toggle(model.id)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-hover transition-colors text-left cursor-default"
              >
                <span
                  className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] ${
                    checked.has(model.id)
                      ? 'bg-accent border-accent text-white'
                      : 'border-border/60 text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] text-text-secondary truncate">{model.name}</span>
                  </span>
                  <span className="text-[10px] text-text-muted/50 truncate block">
                    {model.id}
                    {model.provider ? ` · ${model.provider}` : ''}
                    {model.toolCalling ? ' · tools' : ''}
                    {model.reasoning ? ' · reasoning' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border/50 flex items-center justify-end gap-2">
          <button
            data-testid="ModelAllowlistDialog.cancel"
            onClick={onClose}
            className="px-3 py-1 text-[11px] rounded hover:bg-bg-hover text-text-muted transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="ModelAllowlistDialog.save"
            disabled={models === null || error !== null || saving}
            onClick={() => void save()}
            className="px-3 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
