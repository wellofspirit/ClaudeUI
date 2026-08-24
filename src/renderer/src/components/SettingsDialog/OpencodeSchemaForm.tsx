/**
 * OpencodeSchemaForm.tsx
 *
 * A generic, schema-driven form that renders an editor for an opencode config
 * object from its JSON Schema node (vendored draft-2020-12 schema). It renders by
 * SHAPE, resolving `#/$defs/*` refs against the supplied defs map:
 *
 *   boolean            → toggle
 *   string             → text input
 *   number / integer   → numeric input
 *   enum               → select
 *   array<string>      → tag input        array<enum> → checklist
 *   object w/ props    → nested fieldset (collapsible when > 4 fields)
 *   object w/ addl.    → Record key/value list (add / remove rows)
 *   anyOf/oneOf/unknown→ raw-JSON leaf editor (escape hatch — never crashes)
 *
 * Field LABELS are the raw opencode key names verbatim (tool_call, small_model, …)
 * — the raw names are the contract, so we never prettify them. Keys present in the
 * value but ABSENT from the schema render as read-only "unmanaged" rows (never
 * dropped, never editable).
 *
 * The form is fully controlled: it never mutates `value`; every edit produces a
 * new object passed to `onChange`.
 */

import { useState } from 'react'
import { SettingsToggle, SandboxListSetting, InfoTooltip } from './settings-controls'
import { SelectMenu } from '../shared/SelectMenu'

// The vendored schema is loosely typed; a schema node is an open bag of keywords.
export type SchemaNode = Record<string, unknown>
export type SchemaDefs = Record<string, SchemaNode>

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

// ── Schema helpers ───────────────────────────────────────────────────────────

/** Resolve a `#/$defs/Name` ref against the defs map; pass through anything else. */
export function resolveNode(node: SchemaNode | undefined, defs: SchemaDefs): SchemaNode {
  if (!node || typeof node !== 'object') return {}
  const ref = node.$ref
  if (typeof ref === 'string') {
    const m = ref.match(/^#\/\$defs\/(.+)$/)
    if (m && defs[m[1]]) return defs[m[1]]
    // External or unresolved ref (e.g. models.dev) → leave as-is → raw editor.
    return node
  }
  return node
}

export type FieldKind =
  | 'boolean'
  | 'string'
  | 'number'
  | 'enum'
  | 'stringArray'
  | 'enumArray'
  | 'object'
  | 'record'
  | 'raw'

/** Classify a RESOLVED schema node by the control it should render. */
export function detectKind(node: SchemaNode, defs: SchemaDefs): FieldKind {
  if (Array.isArray(node.enum)) return 'enum'
  if (node.anyOf || node.oneOf || node.allOf) return 'raw'
  const t = node.type
  if (t === 'boolean') return 'boolean'
  if (t === 'string') return 'string'
  if (t === 'number' || t === 'integer') return 'number'
  if (t === 'array') {
    const items = resolveNode(node.items as SchemaNode | undefined, defs)
    if (Array.isArray(items.enum)) return 'enumArray'
    if (items.type === 'string') return 'stringArray'
    return 'raw'
  }
  if (t === 'object') {
    if (node.properties && Object.keys(node.properties as object).length > 0) return 'object'
    const ap = node.additionalProperties
    if (ap && typeof ap === 'object') return 'record'
    return 'raw'
  }
  return 'raw'
}

/** A sensible empty value to seed when a Record row / added key is created. */
export function defaultForSchema(node: SchemaNode, defs: SchemaDefs): unknown {
  const r = resolveNode(node, defs)
  switch (detectKind(r, defs)) {
    case 'boolean':
      return false
    case 'string':
      return ''
    case 'number':
      return 0
    case 'enum':
      return (r.enum as unknown[])[0]
    case 'stringArray':
    case 'enumArray':
      return []
    case 'object':
    case 'record':
      return {}
    default:
      return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── Individual field ───────────────────────────────────────────────────────────

interface FieldProps {
  node: SchemaNode
  defs: SchemaDefs
  fieldKey: string
  value: unknown
  onChange: (v: unknown) => void
  depth: number
}

function Description({ text }: { text?: unknown }): React.JSX.Element | null {
  if (typeof text !== 'string' || !text) return null
  return <div className="text-[10px] text-text-muted/60 mt-0.5 leading-relaxed">{text}</div>
}

function RawJsonField({ fieldKey, value, onChange }: FieldProps): React.JSX.Element {
  // Escape hatch: edit the raw JSON value, commit (parse) on blur, inline error.
  // Absent (undefined) values start blank so a focus/blur without edits stays a
  // no-op rather than injecting `null`.
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2)
  )
  const [error, setError] = useState<string | null>(null)

  const commit = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      setError(null)
      onChange(undefined)
      return
    }
    try {
      onChange(JSON.parse(trimmed))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }

  return (
    <div data-testid="OpencodeSchemaForm.rawJson" data-id={fieldKey}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        spellCheck={false}
        className={`${inputClass} w-full font-mono resize-y`}
      />
      {error && <div className="text-[10px] text-red-400 mt-0.5">JSON error: {error}</div>}
    </div>
  )
}

function EnumChecklist({
  fieldKey,
  options,
  value,
  onChange
}: {
  fieldKey: string
  options: string[]
  value: unknown
  onChange: (v: unknown) => void
}): React.JSX.Element {
  const selected = Array.isArray(value) ? (value as string[]) : []
  const toggle = (opt: string): void => {
    const next = selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt]
    onChange(next.length > 0 ? next : undefined)
  }
  return (
    <div
      data-testid="OpencodeSchemaForm.enumArray"
      data-id={fieldKey}
      className="flex flex-wrap gap-1.5"
    >
      {options.map((opt) => {
        const on = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            data-id={opt}
            aria-pressed={on}
            onClick={() => toggle(opt)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              on
                ? 'bg-accent/20 text-accent border-accent/40'
                : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
            }`}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Record-entry key editor with LOCAL draft state. The parent renders rows with
 * `key={recordKey}`, so committing a rename on every keystroke would remount the
 * row (and drop input focus) after each character. The draft lives here instead
 * and the rename commits on blur / Enter. A commit is a no-op when unchanged or
 * empty (draft snaps back to the committed key), and REJECTED with an inline
 * "duplicate key" error — keeping focus — when the new key already exists in the
 * record, so it never silently overwrites the other entry.
 */
function RecordKeyInput({
  recordKey,
  siblingKeys,
  onRename
}: {
  recordKey: string
  /** The record's OTHER keys (excluding this row's committed key). */
  siblingKeys: string[]
  onRename: (newKey: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(recordKey)
  const [error, setError] = useState<string | null>(null)

  const commit = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    const next = draft.trim()
    if (next === recordKey || next === '') {
      // Unchanged / empty → restore the committed key, clear any stale error.
      setDraft(recordKey)
      setError(null)
      return
    }
    if (siblingKeys.includes(next)) {
      setError('duplicate key')
      e.currentTarget.focus()
      return
    }
    setError(null)
    onRename(next)
  }

  return (
    <div className="flex-1 min-w-0">
      <input
        type="text"
        data-testid="OpencodeSchemaForm.recordKey"
        data-id={recordKey}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e)
        }}
        className={`${inputClass} w-full`}
      />
      {error && (
        <div
          data-testid="OpencodeSchemaForm.recordKeyError"
          data-id={recordKey}
          className="text-[10px] text-red-400 mt-0.5"
        >
          {error}
        </div>
      )}
    </div>
  )
}

function RecordField({ node, defs, fieldKey, value, onChange }: FieldProps): React.JSX.Element {
  const entrySchema = resolveNode(node.additionalProperties as SchemaNode, defs)
  const record = isPlainObject(value) ? value : {}
  const entries = Object.entries(record)

  const setKeyValue = (key: string, v: unknown): void => {
    onChange({ ...record, [key]: v })
  }
  const removeKey = (key: string): void => {
    const next = { ...record }
    delete next[key]
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }
  // Only called with a validated newKey (non-empty, no collision — RecordKeyInput
  // enforces both), so the position-preserving rebuild cannot collapse entries.
  const renameKey = (oldKey: string, newKey: string): void => {
    if (newKey === oldKey) return
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) next[k === oldKey ? newKey : k] = v
    onChange(next)
  }
  const addRow = (): void => {
    // Seed a placeholder key so the row renders; user renames it.
    const base = 'key'
    let i = 1
    let key = base
    while (key in record) key = `${base}${i++}`
    onChange({ ...record, [key]: defaultForSchema(entrySchema, defs) })
  }

  return (
    <div data-testid="OpencodeSchemaForm.record" data-id={fieldKey} className="space-y-1.5">
      {entries.map(([key, v]) => (
        <div
          key={key}
          data-testid="OpencodeSchemaForm.recordRow"
          data-id={key}
          className="border border-border/30 rounded-md p-1.5 space-y-1"
        >
          <div className="flex items-center gap-1.5">
            <RecordKeyInput
              recordKey={key}
              siblingKeys={Object.keys(record).filter((k) => k !== key)}
              onRename={(newKey) => renameKey(key, newKey)}
            />
            <button
              type="button"
              data-testid="OpencodeSchemaForm.recordRemove"
              data-id={key}
              onClick={() => removeKey(key)}
              className="text-[10px] text-text-muted/60 hover:text-red-400 transition-colors px-1"
              title="Remove entry"
            >
              ✕
            </button>
          </div>
          <SchemaField
            node={entrySchema}
            defs={defs}
            fieldKey={`${fieldKey}.${key}`}
            value={v}
            onChange={(nv) => setKeyValue(key, nv)}
            depth={0}
          />
        </div>
      ))}
      <button
        type="button"
        data-testid="OpencodeSchemaForm.recordAdd"
        data-id={fieldKey}
        onClick={addRow}
        className="text-[11px] text-accent hover:text-accent/80 transition-colors"
      >
        + Add entry
      </button>
    </div>
  )
}

function ObjectFieldset({
  node,
  defs,
  fieldKey,
  value,
  onChange,
  depth
}: FieldProps): React.JSX.Element {
  const props = (node.properties as Record<string, SchemaNode>) ?? {}
  const keys = Object.keys(props)
  const [open, setOpen] = useState(depth === 0 || keys.length <= 4)
  const obj = isPlainObject(value) ? value : {}

  const body = (
    <ObjectFields
      properties={props}
      defs={defs}
      value={obj}
      onChange={onChange}
      keyPrefix={fieldKey}
      depth={depth + 1}
    />
  )

  if (keys.length <= 4 && depth === 0) return body

  return (
    <div className="border-l border-border/30 pl-2">
      <button
        type="button"
        data-testid="OpencodeSchemaForm.fieldsetToggle"
        data-id={fieldKey}
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
      >
        {open ? '▾' : '▸'} {fieldKey}
      </button>
      {open && <div className="mt-1">{body}</div>}
    </div>
  )
}

export function SchemaField(props: FieldProps): React.JSX.Element {
  const { defs, fieldKey, value, onChange } = props
  const node = resolveNode(props.node, defs)
  const kind = detectKind(node, defs)
  const description = node.description

  switch (kind) {
    case 'boolean':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey}>
          <SettingsToggle
            label={fieldKey}
            checked={value === true}
            onChange={(v) => onChange(v)}
            testid="OpencodeSchemaForm.bool"
          />
          <div className="px-3">
            <Description text={description} />
          </div>
        </div>
      )
    case 'string':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <input
            type="text"
            data-testid="OpencodeSchemaForm.text"
            data-id={fieldKey}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
            className={`${inputClass} w-full`}
          />
        </div>
      )
    case 'number':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <input
            type="number"
            data-testid="OpencodeSchemaForm.number"
            data-id={fieldKey}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => {
              const s = e.target.value
              onChange(s === '' ? undefined : Number(s))
            }}
            className={`${inputClass} w-full tabular-nums`}
          />
        </div>
      )
    case 'enum': {
      const options = (node.enum as unknown[]).map((v) => String(v))
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <SelectMenu
            testid="OpencodeSchemaForm.enum"
            dataAttrs={{ 'data-id': fieldKey }}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(v) => onChange(v === '' ? undefined : v)}
            options={[
              // The schema's "unset" choice, explicit as it was in the markup.
              { value: '', label: '—' },
              ...options.map((o) => ({ value: o, label: o }))
            ]}
            triggerClassName={`${inputClass} w-full`}
          />
        </div>
      )
    }
    case 'stringArray':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="py-0.5">
          <SandboxListSetting
            label={fieldKey}
            labelColor="text-text-secondary"
            items={Array.isArray(value) ? (value as string[]) : []}
            placeholder="Add value…"
            onUpdate={(items) => onChange(items.length > 0 ? items : undefined)}
            tooltip={typeof description === 'string' ? description : undefined}
            testid="OpencodeSchemaForm.stringArray"
          />
        </div>
      )
    case 'enumArray': {
      const items = resolveNode(node.items as SchemaNode, defs)
      const options = (items.enum as unknown[]).map((v) => String(v))
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <EnumChecklist fieldKey={fieldKey} options={options} value={value} onChange={onChange} />
        </div>
      )
    }
    case 'object':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <ObjectFieldset {...props} node={node} />
        </div>
      )
    case 'record':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <RecordField {...props} node={node} />
        </div>
      )
    default:
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey} className="px-3 py-1.5">
          <FieldLabel name={fieldKey} description={description} />
          <RawJsonField {...props} node={node} />
        </div>
      )
  }
}

function FieldLabel({
  name,
  description
}: {
  name: string
  description?: unknown
}): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1">
      <span className="font-mono text-[12px] text-text-secondary">{name}</span>
      {typeof description === 'string' && description && <InfoTooltip text={description} />}
    </div>
  )
}

// ── Object field loop (shared by top-level form and nested fieldsets) ──────────

function ObjectFields({
  properties,
  defs,
  value,
  onChange,
  keyPrefix,
  depth,
  pickKeys
}: {
  properties: Record<string, SchemaNode>
  defs: SchemaDefs
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  keyPrefix: string
  depth: number
  pickKeys?: string[]
}): React.JSX.Element {
  const renderKeys = pickKeys ? pickKeys.filter((k) => k in properties) : Object.keys(properties)
  // Keys present in the value but not modelled by the schema → read-only rows.
  const unmanaged = Object.keys(value).filter((k) => !(k in properties))

  const setField = (key: string, v: unknown): void => {
    if (v === undefined) {
      const next = { ...value }
      delete next[key]
      onChange(next)
    } else {
      onChange({ ...value, [key]: v })
    }
  }

  return (
    <div className="space-y-0.5">
      {renderKeys.map((key) => (
        <SchemaField
          key={key}
          node={properties[key]}
          defs={defs}
          fieldKey={keyPrefix ? `${keyPrefix}.${key}` : key}
          value={value[key]}
          onChange={(v) => setField(key, v)}
          depth={depth}
        />
      ))}
      {unmanaged.map((key) => (
        <div
          key={key}
          data-testid="OpencodeSchemaForm.unmanaged"
          data-id={key}
          className="px-3 py-1.5 text-[11px]"
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[12px] text-text-muted">{key}</span>
            <span className="text-[9px] px-1 py-0.5 rounded bg-bg-hover text-text-muted/70 uppercase tracking-wide">
              unmanaged
            </span>
          </div>
          <pre className="mt-0.5 text-[10px] text-text-muted/60 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(value[key])}
          </pre>
        </div>
      ))}
    </div>
  )
}

// ── Public entry point ─────────────────────────────────────────────────────────

export interface OpencodeSchemaFormProps {
  /** An object schema node (may be a `$ref`; resolved internally). */
  schema: SchemaNode
  defs: SchemaDefs
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** When set, render only these property keys, in this order. */
  pickKeys?: string[]
  /** Prefix for nested field ids (default empty = top-level). */
  keyPrefix?: string
}

export function OpencodeSchemaForm({
  schema,
  defs,
  value,
  onChange,
  pickKeys,
  keyPrefix = ''
}: OpencodeSchemaFormProps): React.JSX.Element {
  const resolved = resolveNode(schema, defs)
  const properties = (resolved.properties as Record<string, SchemaNode>) ?? {}
  return (
    <div data-testid="OpencodeSchemaForm">
      <ObjectFields
        properties={properties}
        defs={defs}
        value={value}
        onChange={onChange}
        keyPrefix={keyPrefix}
        depth={0}
        pickKeys={pickKeys}
      />
    </div>
  )
}
