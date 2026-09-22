/**
 * `choose` — the stored accounts, live off the store's copy of them (Slice I),
 * with the one action each row can take. It chooses nothing itself: every
 * button reports back to the state machine that owns the flow.
 */

import type { SignInProviderId } from '../../../stores/session-store'
import { SettingRow, Button } from '../../SettingsDialog/settings-controls'
import { SheetGroup } from '../../SettingsDialog/SheetFrame'
import type { AccountRow } from '../account-rows'
import { DIALOG, PROVIDER_NAME, StateChip } from './shared'

export interface ChooseStageProps {
  providerId: SignInProviderId
  /** null while the account read is in flight — the chooser must not flash empty. */
  accounts: AccountRow[] | null
  canAdd: boolean
  /** The stored account the entry point blamed, when it knew one. */
  blamedAccountId?: string
  busy: boolean
  /** Re-authorise the ACTIVE credential — `reauth` takes no account id. */
  onReauth: () => void
  onSwitch: (id: string) => void
  /** Add a SECOND credential. */
  onAdd: () => void
  /** Sign in with nothing on the list — not the same call as {@link onAdd}. */
  onSignIn: () => void
}

export function ChooseStage({
  providerId,
  accounts,
  canAdd,
  blamedAccountId,
  busy,
  onReauth,
  onSwitch,
  onAdd,
  onSignIn
}: ChooseStageProps): React.JSX.Element {
  /** The account read has SETTLED on nothing — the chooser has to say so. */
  const isEmptyList = accounts !== null && accounts.length === 0

  return (
    <SheetGroup testid={`${DIALOG}.group`} id="accounts" label="Accounts">
      {/* `accounts === null` is the read still in flight, NOT an empty list —
          claiming "no account is signed in" before the answer arrives would be
          a guess, and the wrong one on most hosts. */}
      {/* With multi-account off the Anthropic credential lives in the system
          store and is invisible to this list, so "no account" would be a
          claim the dialog cannot make; the Sign in row alone is honest. */}
      {isEmptyList && canAdd && (
        <SettingRow
          testid={`${DIALOG}.empty`}
          description={`No ${PROVIDER_NAME[providerId]} account is signed in on this host.`}
        />
      )}
      {(accounts ?? []).map((account) => (
        <SettingRow
          key={account.id}
          testid={`${DIALOG}.account`}
          dataId={account.id}
          label={account.label}
          // The active account is a DOT, not a tinted band with a word for it.
          // The inactive rows keep the same gutter so the labels line up.
          leading={
            <span
              data-testid={`${DIALOG}.activeDot`}
              data-id={account.id}
              data-active={account.active ? 'true' : 'false'}
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${account.active ? 'bg-accent' : ''}`}
            />
          }
          labelBadge={
            <>
              {account.plan && (
                <StateChip
                  text={account.plan}
                  tone="neutral"
                  testid={`${DIALOG}.plan`}
                  dataId={account.id}
                />
              )}
              {/* The vault's own dead credential, or the one this request was
                  opened about — both are "this one was refused", and the chip
                  is where that belongs. It used to be a second Re-authorize on
                  the blamed row, which lied twice: two primaries on one
                  screen, and `start('reauth')` takes no account and always
                  acts on the ACTIVE credential. */}
              {(account.expired || account.id === blamedAccountId) && (
                <StateChip
                  text="expired"
                  tone="danger"
                  testid={`${DIALOG}.expired`}
                  dataId={account.id}
                />
              )}
            </>
          }
        >
          {account.active ? (
            <Button
              variant="primary"
              testid={`${DIALOG}.reauth`}
              dataId={account.id}
              disabled={busy}
              onClick={onReauth}
            >
              Re-authorize
            </Button>
          ) : (
            <Button
              variant="tinted"
              testid={`${DIALOG}.switch`}
              dataId={account.id}
              disabled={busy}
              onClick={() => onSwitch(account.id)}
            >
              Switch
            </Button>
          )}
        </SettingRow>
      ))}
      {(canAdd || isEmptyList) && (
        // Rule 2: no sentence that restates its own button. All three
        // descriptions this row used to carry ("Signs in to another ChatGPT
        // account and adds it to the list") said what the button says.
        <SettingRow testid={`${DIALOG}.addRow`}>
          <Button
            variant="link"
            testid={`${DIALOG}.addAccount`}
            disabled={busy}
            // With nothing on the list this is the SAME start the dialog would
            // have run on open — `add` would send Anthropic through
            // `addAccount()`, which adds a second credential to a host that has
            // none.
            onClick={() => {
              if (isEmptyList) onSignIn()
              else onAdd()
            }}
          >
            {isEmptyList ? 'Sign in' : '+ Add account'}
          </Button>
        </SettingRow>
      )}
    </SheetGroup>
  )
}
