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
 *   array<string>      → tag input        array<enum> → chip set
 *   object w/ props    → nested fieldset (collapsible when > 4 fields)
 *   object w/ addl.    → Record key/value list (add / remove rows)
 *   anyOf/oneOf/unknown→ raw-JSON leaf editor (escape hatch — never crashes)
 *
 * Field LABELS are the raw opencode key names verbatim (tool_call, small_model, …)
 * — the raw names are the contract, so we never prettify them, and they render in
 * mono where every other page shows a prose label (ADR-065's `labelClassName`).
 * The schema's own `description` is a VISIBLE 12px line rather than an ⓘ: a
 * hover-only explanation is unreachable on a phone. Keys present in the value but
 * ABSENT from the schema render as read-only "unmanaged" rows (never dropped,
 * never editable).
 *
 * The form is fully controlled: it never mutates `value`; every edit produces a
 * new object passed to `onChange`.
 */

import { useState } from 'react'
import {
  Button,
  ChipSet,
  NumberField,
  SandboxListSetting,
  SelectField,
  SettingRow,
  SettingsToggle,
  TextField
} from './settings-controls'

// The vendored schema is loosely typed; a schema node is an open bag of keywords.
export type SchemaNode = Record<string, unknown>
export type SchemaDefs = Record<string, SchemaNode>

/** Shared input look. Exported so the opencode/pi provider editors — which are
 *  NOT part of the settings row vocabulary — match this form's older fields
 *  instead of re-deriving the class string. */
export const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

/** A label that IS a config key: mono, at the row label's size and contrast. */
const KEY_LABEL_CLASS = 'font-mono text-[12px] text-text-primary'

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

/** The schema's `description`, when it has one worth showing. */
function descriptionOf(text: unknown): string | undefined {
  return typeof text === 'string' && text ? text : undefined
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

/** The subset of `FieldProps` the raw-JSON leaf editor actually reads. Named so
 *  call sites outside the schema form (the curated opencode panes) can use it
 *  without fabricating a schema node. */
export interface RawJsonFieldProps {
  fieldKey: string
  value: unknown
  onChange: (v: unknown) => void
}

export function RawJsonField({ fieldKey, value, onChange }: RawJsonFieldProps): React.JSX.Element {
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
        className="w-full bg-bg-input border border-border rounded-md px-2.5 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors resize-y"
      />
      {error && <div className="text-[12px] leading-4 text-danger mt-1">JSON error: {error}</div>}
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
      <TextField
        testid="OpencodeSchemaForm.recordKey"
        dataId={recordKey}
        value={draft}
        onChange={(v) => {
          setDraft(v)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e)
        }}
      />
      {error && (
        <div
          data-testid="OpencodeSchemaForm.recordKeyError"
          data-id={recordKey}
          className="text-[12px] leading-4 text-danger mt-1"
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
          className="border border-border rounded-md p-1.5 space-y-1"
        >
          <div className="flex items-center gap-1.5">
            <RecordKeyInput
              recordKey={key}
              siblingKeys={Object.keys(record).filter((k) => k !== key)}
              onRename={(newKey) => renameKey(key, newKey)}
            />
            <Button
              variant="link"
              testid="OpencodeSchemaForm.recordRemove"
              dataId={key}
              onClick={() => removeKey(key)}
              title="Remove entry"
            >
              ✕
            </Button>
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
      <Button
        variant="link"
        testid="OpencodeSchemaForm.recordAdd"
        dataId={fieldKey}
        onClick={addRow}
      >
        + Add entry
      </Button>
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
    <div className="border-l border-border pl-2">
      <Button
        variant="link"
        testid="OpencodeSchemaForm.fieldsetToggle"
        dataId={fieldKey}
        ariaExpanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} {fieldKey}
      </Button>
      {open && <div className="mt-1">{body}</div>}
    </div>
  )
}

export function SchemaField(props: FieldProps): React.JSX.Element {
  const { defs, fieldKey, value, onChange } = props
  const node = resolveNode(props.node, defs)
  const kind = detectKind(node, defs)
  const description = descriptionOf(node.description)

  switch (kind) {
    case 'boolean':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey}>
          <SettingsToggle
            testid="OpencodeSchemaForm.bool"
            dataId={fieldKey}
            label={fieldKey}
            labelClassName={KEY_LABEL_CLASS}
            description={description}
            checked={value === true}
            onChange={(v) => onChange(v)}
          />
        </div>
      )
    case 'string':
      return (
        <SettingRow
          testid="OpencodeSchemaForm.field"
          dataId={fieldKey}
          layout="stacked"
          label={fieldKey}
          labelClassName={KEY_LABEL_CLASS}
          description={description}
        >
          <TextField
            testid="OpencodeSchemaForm.text"
            dataId={fieldKey}
            value={typeof value === 'string' ? value : ''}
            onChange={(v) => onChange(v === '' ? undefined : v)}
          />
        </SettingRow>
      )
    case 'number':
      return (
        <SettingRow
          testid="OpencodeSchemaForm.field"
          dataId={fieldKey}
          label={fieldKey}
          labelClassName={KEY_LABEL_CLASS}
          description={description}
        >
          <NumberField
            testid="OpencodeSchemaForm.number"
            dataId={fieldKey}
            value={typeof value === 'number' ? value : undefined}
            onChange={(v) => onChange(v)}
          />
        </SettingRow>
      )
    case 'enum': {
      const options = (node.enum as unknown[]).map((v) => String(v))
      // The schema's "unset" choice, explicit as it was in the markup.
      const choices = [{ value: '', label: '—' }, ...options.map((o) => ({ value: o, label: o }))]
      return (
        <SettingRow
          testid="OpencodeSchemaForm.field"
          dataId={fieldKey}
          label={fieldKey}
          labelClassName={KEY_LABEL_CLASS}
          description={description}
        >
          <SelectField
            testid="OpencodeSchemaForm.enum"
            dataId={fieldKey}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(v) => onChange(v === '' ? undefined : v)}
            options={choices}
          />
        </SettingRow>
      )
    }
    case 'stringArray':
      return (
        <div data-testid="OpencodeSchemaForm.field" data-id={fieldKey}>
          <SandboxListSetting
            label={fieldKey}
            labelColor={KEY_LABEL_CLASS}
            items={Array.isArray(value) ? (value as string[]) : []}
            placeholder="Add value…"
            onUpdate={(items) => onChange(items.length > 0 ? items : undefined)}
            description={description}
            testid="OpencodeSchemaForm.stringArray"
          />
        </div>
      )
    case 'enumArray': {
      const items = resolveNode(node.items as SchemaNode, defs)
      const options = (items.enum as unknown[]).map((v) => String(v))
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <SettingRow
          testid="OpencodeSchemaForm.field"
          dataId={fieldKey}
          layout="stacked"
          label={fieldKey}
          labelClassName={KEY_LABEL_CLASS}
          description={description}
        >
          <ChipSet
            testid="OpencodeSchemaForm.enumArray"
            value={selected}
            options={options.map((o) => ({ value: o, label: o }))}
            onToggle={(opt) => {
              const next = selected.includes(opt)
                ? selected.filter((v) => v !== opt)
                : [...selected, opt]
              onChange(next.length > 0 ? next : undefined)
            }}
          />
        </SettingRow>
      )
    }
    case 'object':
      return (
        <div
          data-testid="OpencodeSchemaForm.field"
          data-id={fieldKey}
          className="px-3.5 py-2.5 min-h-[44px]"
        >
          <FieldLabel name={fieldKey} description={description} />
          <ObjectFieldset {...props} node={node} />
        </div>
      )
    case 'record':
      return (
        <div
          data-testid="OpencodeSchemaForm.field"
          data-id={fieldKey}
          className="px-3.5 py-2.5 min-h-[44px]"
        >
          <FieldLabel name={fieldKey} description={description} />
          <RecordField {...props} node={node} />
        </div>
      )
    default:
      return (
        <SettingRow
          testid="OpencodeSchemaForm.field"
          dataId={fieldKey}
          layout="stacked"
          label={fieldKey}
          labelClassName={KEY_LABEL_CLASS}
          description={description}
        >
          <RawJsonField fieldKey={fieldKey} value={value} onChange={onChange} />
        </SettingRow>
      )
  }
}

/**
 * The heading of a CONTAINER (a nested object, a Record) — not a row, so it is
 * typed like one rather than drawn through `SettingRow`: the rows it contains
 * are the settings.
 */
function FieldLabel({
  name,
  description
}: {
  name: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="mb-1.5">
      <div className={`${KEY_LABEL_CLASS} leading-[18px]`}>{name}</div>
      {description && (
        <div className="text-[12px] leading-4 text-text-secondary">{description}</div>
      )}
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
    <div className={depth === 0 ? 'divide-y divide-border/55' : 'space-y-0.5'}>
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
        <SettingRow
          key={key}
          testid="OpencodeSchemaForm.unmanaged"
          dataId={key}
          layout="stacked"
          dimmed
          label={key}
          labelClassName={KEY_LABEL_CLASS}
          description="Unmanaged — not in opencode's schema, and kept in the file exactly as written."
        >
          <span className="block font-mono text-[11px] leading-4 text-text-muted overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(value[key])}
          </span>
        </SettingRow>
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
