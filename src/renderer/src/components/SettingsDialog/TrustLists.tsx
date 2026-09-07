/**
 * Trust & protection — the classifier trust lists, edited ONCE for every engine
 * (ADR-065 § Shared trust lists).
 *
 * These three lists used to live in `engines/<engine>.json#autoMode` and were
 * therefore edited twice, under two headings, with nothing keeping them in
 * agreement. They describe the user's ENVIRONMENT rather than an engine's judge,
 * so they now live in `~/.claude/ui/automode.json` and OpencodeSession /
 * PiSession derive them into the classifier environment at session start. Claude
 * cannot consume them — cli.js ships its own classifier — which is what the
 * group's `opencode · pi` badge says.
 *
 * Self-contained, like the auto-mode section it was cut out of: it loads and
 * saves its own file through `window.api` rather than riding the dialog's
 * AppSettings plumbing, because this is not ClaudeUI's settings.json.
 *
 * An emptied list is saved as an ABSENT key, never `[]`: the sessions read the
 * lists behind `?.length`, so the two are indistinguishable downstream and a
 * second encoding of "nothing is trusted" would be a lie waiting to be believed.
 */
import { useEffect, useState } from 'react'
import type { SharedAutoModeConfig } from '../../../../shared/types'
import { SandboxListSetting, SettingRow } from './settings-controls'

/** The three keys `SharedAutoModeConfig` holds. */
type TrustListKey = 'trustedDomains' | 'trustedRegistries' | 'protectedPatterns'

/**
 * One row per list. Each `description` says what an EMPTY list means, because
 * for all three that is the load-bearing, non-obvious half of the semantics —
 * and for `protectedPatterns` a non-empty list REPLACES a built-in heuristic
 * rather than adding to it, which is the one behaviour a user cannot infer from
 * the field name.
 */
const TRUST_LISTS: ReadonlyArray<{
  key: TrustListKey
  label: string
  placeholder: string
  description: string
}> = [
  {
    key: 'trustedDomains',
    label: 'Trusted domains',
    placeholder: 'files.example.com',
    description:
      'Host names the judge may treat as safe destinations for fetches and uploads; empty means no external destination is trusted.'
  },
  {
    key: 'trustedRegistries',
    label: 'Trusted package registries',
    placeholder: 'https://npm.internal.example',
    description:
      "Registries the judge may install from, anything else being an untrusted supply-chain source; empty means only the project manifest's default registry."
  },
  {
    key: 'protectedPatterns',
    label: 'Production patterns',
    placeholder: 'acme-live-*',
    description:
      "Names, hosts or patterns the judge must refuse to mutate without a human; empty uses the built-in heuristic ('prod'/'production' as a whole word or segment), and any pattern REPLACES that heuristic."
  }
]

export function TrustListsSection(): React.JSX.Element {
  // null = still loading. The file is normally tiny, but every DOM-producing
  // branch still carries the component id (ADR-027).
  const [cfg, setCfg] = useState<SharedAutoModeConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .loadSharedAutoMode()
      .then((loaded) => {
        if (!cancelled) setCfg(loaded ?? {})
      })
      .catch(() => {
        if (!cancelled) setCfg({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (cfg === null) {
    return (
      <div data-testid="TrustListsSection">
        <SettingRow description="Loading…" />
      </div>
    )
  }

  const updateList = (key: TrustListKey, items: string[]): void => {
    const next: SharedAutoModeConfig = { ...cfg }
    if (items.length > 0) next[key] = items
    else delete next[key]
    setCfg(next)
    window.api.saveSharedAutoMode(next).catch(() => {})
  }

  return (
    <div data-testid="TrustListsSection" className="divide-y divide-border/55">
      {TRUST_LISTS.map((f) => (
        <SandboxListSetting
          key={f.key}
          testid={`TrustListsSection.${f.key}`}
          label={f.label}
          labelColor="text-text-primary"
          items={cfg[f.key] ?? []}
          placeholder={f.placeholder}
          description={f.description}
          onUpdate={(items) => updateList(f.key, items)}
        />
      ))}
    </div>
  )
}
