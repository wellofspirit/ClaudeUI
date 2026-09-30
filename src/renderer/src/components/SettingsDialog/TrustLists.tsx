/**
 * Trust & protection — the classifier trust lists and the judge guidance lists,
 * edited ONCE for every engine (ADR-065 § Shared trust lists, ADR-083 §4).
 *
 * The three trust lists used to live in `engines/<engine>.json#autoMode` and were
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
 * Below the trust lists sit the two guidance lists (ADR-083 §4): plain-language
 * kinds of action the user calls routine (`judgeAllow`, the User-Specified
 * Allow exception) or wants to approve personally (`judgeBlock`, the
 * User-Specified Block soft rule). They are not about the environment, but they
 * live in the same shared file for the same reason — one judge policy, every
 * engine — and so ride the same rows and the same save path.
 *
 * Above them sits one switch, the ADR-084 read-only bypass: plainly read-only
 * shell commands in the workspace skip the judge. It is on by default and
 * stored only as `readOnlyBypass: false`, so "on" has one encoding (absent).
 *
 * An emptied list is saved as an ABSENT key, never `[]`: the sessions read the
 * lists behind `?.length`, so the two are indistinguishable downstream and a
 * second encoding of "nothing is trusted" would be a lie waiting to be believed.
 *
 * The guidance rows are held to the IPC perimeter's own entry rules
 * (`shared/judge-guidance.ts`), so the editor refuses what the save would.
 * A save that fails anyway is not swallowed: the section says so and reloads
 * the file, so what it shows is what the judge will read.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharedAutoModeConfig } from '../../../../shared/types'
import {
  JUDGE_GUIDANCE_MAX_ENTRIES,
  judgeGuidanceEntryError
} from '../../../../shared/judge-guidance'
import {
  SandboxListSetting,
  SettingRow,
  SettingsToggle,
  type ListEntryRules
} from './settings-controls'

/** The five list keys `SharedAutoModeConfig` holds. */
type TrustListKey =
  'trustedDomains' | 'trustedRegistries' | 'protectedPatterns' | 'judgeAllow' | 'judgeBlock'

/** The perimeter's entry rules for a guidance list, applied before saving. */
const GUIDANCE_ENTRY_RULES: ListEntryRules = {
  validate: judgeGuidanceEntryError,
  maxItems: JUDGE_GUIDANCE_MAX_ENTRIES
}

/**
 * One row per list. Each trust-list `description` says what an EMPTY list
 * means, because for all three that is the load-bearing, non-obvious half of
 * the semantics — and for `protectedPatterns` a non-empty list REPLACES a
 * built-in heuristic rather than adding to it, which is the one behaviour a
 * user cannot infer from the field name. The two guidance rows instead state
 * their LIMIT: "routine" never overrides the judge's exfiltration and boundary
 * rules, and "ask me first" is a block the user's own chat reply clears.
 */
const TRUST_LISTS: ReadonlyArray<{
  key: TrustListKey
  label: string
  placeholder: string
  description: string
  rules?: ListEntryRules
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
  },
  {
    key: 'judgeAllow',
    label: 'Routine for me',
    placeholder: 'creating and switching git branches',
    description:
      'Kinds of action the judge should always treat as routine, in plain words. It still blocks data leaving your trust boundary and anything you told the agent not to do.',
    rules: GUIDANCE_ENTRY_RULES
  },
  {
    key: 'judgeBlock',
    label: 'Ask me first',
    placeholder: 'running database migrations',
    description:
      'Kinds of action the judge should block unless you asked for them in the chat. The agent sees the block and can ask you; your reply clears it.',
    rules: GUIDANCE_ENTRY_RULES
  }
]

/** The ADR-084 §1 switch's copy. The description names the escape hatch: an
 *  Ask rule still reaches the user, bypass or not. */
const READ_ONLY_BYPASS_LABEL = 'Skip the judge for read-only commands'
const READ_ONLY_BYPASS_DESCRIPTION =
  'Plainly read-only commands in your workspace (git status, ls, reading source files) run without a judge call. Commands that touch secrets, other folders, the network or anything else still go to the judge; to review a read yourself, add an Ask rule.'

/** Shown when a save is rejected; the section has already reloaded the file. */
const SAVE_ERROR = "Couldn't save that change — showing what is saved."

export function TrustListsSection(): React.JSX.Element {
  // null = still loading. The file is normally tiny, but every DOM-producing
  // branch still carries the component id (ADR-027).
  const [cfg, setCfg] = useState<SharedAutoModeConfig | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Bumped by every save. A failed save reloads the file, and that reload may
  // only land if no newer save was issued meanwhile — otherwise it would paint
  // the pre-edit file over an edit that is still on its way to disk.
  const saveSeq = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    window.api
      .loadSharedAutoMode()
      .then((loaded) => {
        if (mounted.current) setCfg(loaded ?? {})
      })
      .catch(() => {
        if (mounted.current) setCfg({})
      })
    return () => {
      mounted.current = false
    }
  }, [])

  const reloadAfterFailedSave = useCallback((seq: number): void => {
    window.api
      .loadSharedAutoMode()
      .then((loaded) => {
        if (mounted.current && saveSeq.current === seq) setCfg(loaded ?? {})
      })
      // The file cannot be read either: keep the edit on screen, the error
      // already says it is not saved.
      .catch(() => {})
  }, [])

  if (cfg === null) {
    return (
      <div data-testid="TrustListsSection">
        <SettingRow description="Loading…" />
      </div>
    )
  }

  const save = (next: SharedAutoModeConfig): void => {
    setCfg(next)
    setSaveError(null)
    const seq = ++saveSeq.current
    window.api.saveSharedAutoMode(next).catch(() => {
      if (!mounted.current) return
      setSaveError(SAVE_ERROR)
      reloadAfterFailedSave(seq)
    })
  }

  const updateList = (key: TrustListKey, items: string[]): void => {
    const next: SharedAutoModeConfig = { ...cfg }
    if (items.length > 0) next[key] = items
    else delete next[key]
    save(next)
  }

  const setReadOnlyBypass = (on: boolean): void => {
    const next: SharedAutoModeConfig = { ...cfg }
    if (on) delete next.readOnlyBypass
    else next.readOnlyBypass = false
    save(next)
  }

  return (
    <div data-testid="TrustListsSection" className="divide-y divide-border/55">
      <SettingsToggle
        testid="TrustListsSection.readOnlyBypass"
        label={READ_ONLY_BYPASS_LABEL}
        description={READ_ONLY_BYPASS_DESCRIPTION}
        checked={cfg.readOnlyBypass !== false}
        onChange={setReadOnlyBypass}
      />
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
          validate={f.rules?.validate}
          maxItems={f.rules?.maxItems}
        />
      ))}
      {saveError && (
        <div
          data-testid="TrustListsSection.saveError"
          role="alert"
          className="px-3 py-2 text-[12px] leading-4 text-danger"
        >
          {saveError}
        </div>
      )}
    </div>
  )
}
