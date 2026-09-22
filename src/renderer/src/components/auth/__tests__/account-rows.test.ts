/**
 * The account mapping, on its own (ADR-070 Slice I).
 *
 * It was inside `SignInDialog`'s open-time effect, which is why the only way to
 * test the ADR-068 rulings it carries was to render a dialog and read the DOM.
 * They are rulings, not incidental shaping — multi-account off collapses to a
 * chooser of one, and that same case must NOT offer "+ Add account", because
 * `addAccount()` would flip the host to file-based multi-account as a side
 * effect of a sign-in — so they get assertions of their own here.
 */
import { describe, it, expect } from 'vitest'
import { UNREADABLE_ACCOUNTS, anthropicAccountsView, chatgptAccountsView } from '../account-rows'
import type { AccountsState } from '../../../../../shared/types'
import type { SharedProviderAccountList } from '../../../../../shared/shared-provider'

const account = (
  over: Partial<AccountsState['accounts'][number]>
): AccountsState['accounts'][number] => ({
  id: 'a1',
  email: 'one@example.com',
  subscriptionType: 'Claude Max',
  organization: null,
  createdAt: 0,
  ...over
})

const claude = (over: Partial<AccountsState>): AccountsState => ({
  enabled: true,
  activeId: 'a1',
  accounts: [account({})],
  ...over
})

const vault = (over: Partial<SharedProviderAccountList>): SharedProviderAccountList => ({
  activeId: 'v1',
  perSession: true,
  accounts: [
    { id: 'v1', email: 'one@example.com', planType: 'pro', expiresAt: 0, needsReauth: false }
  ],
  ...over
})

describe('anthropicAccountsView', () => {
  it('multi-account OFF collapses to the ACTIVE row, auto-starting and unable to add', () => {
    const view = anthropicAccountsView(
      claude({
        enabled: false,
        activeId: 'a2',
        accounts: [account({}), account({ id: 'a2', email: 'two@example.com' })]
      })
    )
    // The chooser would be a list of one with no alternative, so the dialog
    // goes to its confirm screen — and it still NAMES the credential, which is
    // what makes that screen "sign in as this" rather than "sign in".
    expect(view.rows.map((row) => row.id)).toEqual(['a2'])
    expect(view.rows[0].label).toBe('two@example.com')
    expect(view.autoStart).toBe(true)
    // `addAccount()` would silently turn multi-account ON: a Settings decision.
    expect(view.canAdd).toBe(false)
  })

  it('multi-account OFF with only a NON-active row on file still reports that one', () => {
    // `activeId` pointing nowhere is not "nobody is signed in" — the credential
    // lives in the system store, invisible to this list — so the one row on
    // file is reported, and reported as the active one.
    const view = anthropicAccountsView(claude({ enabled: false, activeId: null }))
    expect(view.rows.map((row) => [row.id, row.active])).toEqual([['a1', true]])
    expect(view.autoStart).toBe(true)
    expect(view.canAdd).toBe(false)
  })

  it('multi-account OFF with nothing on file reports nothing, and claims nothing', () => {
    const view = anthropicAccountsView(claude({ enabled: false, accounts: [] }))
    expect(view.rows).toEqual([])
    expect(view.autoStart).toBe(true)
    expect(view.canAdd).toBe(false)
  })

  it('multi-account ON with no rows auto-starts; with rows it does not', () => {
    expect(anthropicAccountsView(claude({ accounts: [] }))).toEqual({
      rows: [],
      autoStart: true,
      canAdd: true
    })
    const several = anthropicAccountsView(
      claude({ accounts: [account({}), account({ id: 'a2', email: 'two@example.com' })] })
    )
    expect(several.rows.map((row) => [row.id, row.active])).toEqual([
      ['a1', true],
      ['a2', false]
    ])
    expect(several.autoStart).toBe(false)
    expect(several.canAdd).toBe(true)
  })

  it('passes a PLACEHOLDER label through — it is the truth until the login lands', () => {
    // `AccountManager.addAccount` stores `Account 2` as the email, because the
    // real one is not knowable until the OAuth completes. Hiding it here would
    // be inventing an answer; the fix for the owner's report is that the
    // backfill now reaches the open dialog, not that the renderer guesses.
    const view = anthropicAccountsView(
      claude({
        activeId: 'a2',
        accounts: [account({}), account({ id: 'a2', email: 'Account 2', subscriptionType: null })]
      })
    )
    expect(view.rows[1]).toEqual({ id: 'a2', label: 'Account 2', plan: undefined, active: true })
  })

  it('falls back to "Account" only when there is no stored label at all', () => {
    const view = anthropicAccountsView(claude({ accounts: [account({ email: null })] }))
    expect(view.rows[0].label).toBe('Account')
  })
})

describe('chatgptAccountsView', () => {
  it('maps the vault rows, marking the active one and splitting the two facts', () => {
    const view = chatgptAccountsView(
      vault({
        accounts: [
          { id: 'v1', email: 'one@example.com', planType: 'Plus', expiresAt: 0, needsReauth: true },
          { id: 'v2', email: 'two@example.com', planType: 'pro', expiresAt: 0, needsReauth: false }
        ]
      })
    )
    expect(view.rows).toEqual([
      { id: 'v1', label: 'one@example.com', plan: 'Plus', expired: true, active: true },
      { id: 'v2', label: 'two@example.com', plan: 'pro', expired: false, active: false }
    ])
    expect(view.autoStart).toBe(false)
    expect(view.canAdd).toBe(true)
  })

  it('an empty vault auto-starts and can always add — there is no collapse case here', () => {
    expect(chatgptAccountsView(vault({ activeId: null, accounts: [] }))).toEqual({
      rows: [],
      autoStart: true,
      canAdd: true
    })
  })
})

describe('UNREADABLE_ACCOUNTS', () => {
  it('lands on the chooser with its one affordance, never on a confirm', () => {
    // A read that REJECTED: there is no answer to confirm a flow against, but
    // the chooser must still be able to act. This is what the dialog rendered
    // when its own read threw, kept verbatim.
    expect(UNREADABLE_ACCOUNTS).toEqual({ rows: [], autoStart: false, canAdd: true })
  })
})
