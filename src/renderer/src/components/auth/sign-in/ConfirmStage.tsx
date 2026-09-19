/**
 * `confirm` — the screen a one-click sign-in used to skip (ADR-070 Ruling 1,
 * owner 2026-09-19). It names the credential, names the step, and offers the
 * one primary that starts the flow; it starts nothing itself.
 */

import type { SignInProviderId } from '../../../stores/session-store'
import { SettingRow, Button } from '../../SettingsDialog/settings-controls'
import { SheetGroup } from '../../SettingsDialog/SheetFrame'
import type { AccountRow } from '../account-rows'
import { DIALOG, PROVIDER_NAME, StateChip } from './shared'

export interface ConfirmStageProps {
  providerId: SignInProviderId
  /** The ENTRY's intent, not a stage — `add` names no credential by construction. */
  mode: 'reauth' | 'add'
  /** null while the account read is in flight. */
  accounts: AccountRow[] | null
  isWeb: boolean
  /** The device-code flow is the one a start would run (web + ChatGPT only). */
  deviceFlow: boolean
  busy: boolean
  onStart: () => void
}

export function ConfirmStage({
  providerId,
  mode,
  accounts,
  isWeb,
  deviceFlow,
  busy,
  onStart
}: ConfirmStageProps): React.JSX.Element {
  /**
   * What the confirm screen's one primary PROMISES, and the step it promises —
   * ONE branch, both values (Slice H).
   *
   * ADR-057: the host never `openExternal`s for a remote caller, so a web
   * client must not be told a browser is about to open — nothing opens; the
   * host hands back a link to copy, or a device code to type. Naming the wrong
   * one is the same defect as the missing screen, one step further along. The
   * sentence is the same promise as the label, so a second branch for it is a
   * second chance to get it wrong: a reworded button that left a stale sentence
   * behind would promise the browser ADR-057 forbids, in prose.
   *
   * The web arms are keyed on `deviceFlow` — the SAME condition that picks
   * which panel the click lands on — rather than on a re-derivation of it.
   */
  const confirmNext: { action: string; step: string } = !isWeb
    ? // The host drives its own browser and waits on the loopback.
      { action: 'Open browser', step: 'Your browser opens; the sign-in finishes there.' }
    : deviceFlow
      ? // `DeviceCodeFlow`: open a link, type the code, the host polls.
        { action: 'Get a code', step: 'You’ll enter the code on the page it opens.' }
      : // `OAuthPasteBackFlow`: open a link, bring what it hands back.
        { action: 'Get a sign-in link', step: 'You’ll paste a code back here.' }

  /**
   * The credential the confirm screen NAMES, when it knows one.
   *
   * Only the single-row case: `anthropicAccountsView` collapses Anthropic-with-
   * multi-account-off to exactly the credential the flow will re-authorise, so
   * naming it is the difference between "sign in" and "sign in as this". An
   * `add` names nobody by construction — that is the point of adding — and a
   * host with no stored account has nobody to name.
   */
  const confirmAccount = mode === 'add' ? null : accounts?.length === 1 ? accounts[0] : null

  /**
   * The row's SUBJECT, so the confirm always has one (Slice H, mockup
   * `ebde050f` option C, owner 2026-09-19).
   *
   * Without this the `add` screen was an invisible dot, an empty `flex-1` and a
   * floating button: the design named a credential, and `add` has none to name
   * by construction. What it does have is the credential it is about to CREATE,
   * so the row names that instead and both confirm modes stay the same screen —
   * dot, subject, step, button.
   *
   * ONE label for `add` and for an empty list, deliberately. It is a statement
   * about what the flow produces, not a claim about what is on file, which is
   * the only version that is honest on a host whose credential this dialog
   * cannot see (Anthropic with multi-account off keeps it in the system store);
   * "your first account" would be that claim. Which of the two brought the user
   * here is already the group's caption, and a second copy of that distinction
   * is a second thing to keep true. Named from `PROVIDER_NAME`, so this cannot
   * call the provider something the header does not.
   */
  const confirmSubject = confirmAccount?.label ?? `A new ${PROVIDER_NAME[providerId]} account`

  return (
    <SheetGroup
      testid={`${DIALOG}.group`}
      id="confirm"
      label={mode === 'add' ? 'Add account' : 'Sign in'}
    >
      {/* One row, one primary (rule 6): the header names the provider, the row
          names its SUBJECT — the credential, or the one about to exist — the
          description names the step, and the button names what happens next.
          The sentence is load-bearing here rather than a restatement of the
          button (ADR-070 §5 rule 2): the button says what to press, the step
          says what the user will then be doing. No new markup — this is the
          existing row with its `description` slot filled. There is
          deliberately no Cancel — `×`, the scrim and Escape are the three
          closes this dialog has, and a screen that has started nothing has
          nothing to cancel. */}
      <SettingRow
        testid={`${DIALOG}.confirm`}
        label={confirmSubject}
        description={confirmNext.step}
        {...(confirmAccount ? { dataId: confirmAccount.id } : {})}
        leading={
          // A hollow ring when there is no credential yet, so the gutter reads
          // as "nothing here" rather than as a dot that failed to render —
          // which is exactly how the unstyled `add` case looked.
          <span
            data-testid={`${DIALOG}.activeDot`}
            // The account when there is one; otherwise the stage, because the
            // testid repeats on the account rows (ADR-027).
            data-id={confirmAccount?.id ?? 'confirm'}
            data-active={confirmAccount ? 'true' : 'false'}
            className={`shrink-0 w-1.5 h-1.5 rounded-full ${
              confirmAccount ? 'bg-accent' : 'border border-text-muted'
            }`}
          />
        }
        labelBadge={
          confirmAccount?.plan ? (
            <StateChip
              text={confirmAccount.plan}
              tone="neutral"
              testid={`${DIALOG}.plan`}
              dataId={confirmAccount.id}
            />
          ) : undefined
        }
      >
        <Button
          variant="primary"
          testid={`${DIALOG}.confirmStart`}
          disabled={busy}
          onClick={onStart}
        >
          {confirmNext.action}
        </Button>
      </SettingRow>
    </SheetGroup>
  )
}
