/**
 * Layer 1: the per-session ChatGPT account picker (ADR-068 §2) — slice 2b
 * guard 6, desktop half.
 *
 * What it has to get right is the one thing the session status cannot be asked
 * for: "follow the active account" and "pinned to the account that happens to be
 * active" are DIFFERENT states carrying the same account id, so the trigger and
 * the checked row must come from the pin, never from the account.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccountPicker, type AccountChoice } from '../InlinePickers'

const accounts: AccountChoice[] = [
  { id: 'acct-a', email: 'a@example.test', planType: 'pro' },
  { id: 'acct-b', email: 'b@example.test', planType: 'plus' }
]

function open(props: Partial<Parameters<typeof AccountPicker>[0]> = {}): {
  onSelectAccount: ReturnType<typeof vi.fn>
  onAddAccount: ReturnType<typeof vi.fn>
  onOpen: ReturnType<typeof vi.fn>
} {
  const onSelectAccount = vi.fn()
  const onAddAccount = vi.fn()
  const onOpen = vi.fn()
  render(
    <AccountPicker
      accounts={accounts}
      activeAccountId="acct-a"
      pinned={null}
      onSelectAccount={onSelectAccount}
      onAddAccount={onAddAccount}
      onOpen={onOpen}
      {...props}
    />
  )
  return { onSelectAccount, onAddAccount, onOpen }
}

const options = (): HTMLElement[] => screen.getAllByTestId('AccountPicker.option')
const checked = (): string | undefined =>
  options()
    .find((option) => option.getAttribute('aria-checked') === 'true')
    ?.getAttribute('data-value') ?? undefined

describe('AccountPicker', () => {
  it('says which account follow-active resolves to, and does not read as a pin', () => {
    open()
    expect(screen.getByTestId('AccountPicker.trigger').textContent).toContain(
      'Active · a@example.test'
    )
    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    expect(options().map((option) => option.getAttribute('data-value'))).toEqual([
      '__active__',
      'acct-a',
      'acct-b'
    ])
    // The checked row is follow-active, NOT acct-a — even though the two resolve
    // to the same account today.
    expect(checked()).toBe('__active__')
  })

  it('shows the pinned account on the trigger and checks its row', () => {
    open({ pinned: 'acct-b' })
    expect(screen.getByTestId('AccountPicker.trigger').textContent).toContain('b@example.test')
    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    expect(checked()).toBe('acct-b')
  })

  it('sends the id for an account and null for follow-active, closing either way', () => {
    const { onSelectAccount } = open({ pinned: 'acct-b' })
    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    fireEvent.click(options().find((o) => o.getAttribute('data-value') === 'acct-a')!)
    expect(onSelectAccount).toHaveBeenCalledWith('acct-a')
    expect(screen.queryAllByTestId('AccountPicker.option')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    fireEvent.click(options()[0])
    expect(onSelectAccount).toHaveBeenLastCalledWith(null)
  })

  it('re-reads the list as the menu opens, and offers the way to add one', () => {
    const { onOpen, onAddAccount } = open()
    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('AccountPicker.add'))
    expect(onAddAccount).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('AccountPicker.add')).toBeNull()
  })

  it('falls back to a neutral label when the JWT carried no email', () => {
    open({ accounts: [{ id: 'acct-x' }], activeAccountId: 'acct-x' })
    expect(screen.getByTestId('AccountPicker.trigger').textContent).toContain('Active · Account')
  })

  // Slice J: `accountLabel` read `account?.email ?? 'Account'`, so an EMPTY
  // email — which every wire type can carry — reached the trigger and the row
  // as a blank string while Settings named the same account `Account`. The
  // assertion is on the rendered label, not on the helper, because a helper
  // test passes whether or not this call site was converted.
  it('falls back for an EMPTY email too, on the trigger and in the row', () => {
    open({
      accounts: [{ id: 'acct-blank', email: '' }],
      activeAccountId: 'acct-blank',
      pinned: 'acct-blank'
    })
    expect(screen.getByTestId('AccountPicker.trigger').textContent).toContain('Account')
    fireEvent.click(screen.getByTestId('AccountPicker.trigger'))
    expect(
      options().find((option) => option.getAttribute('data-value') === 'acct-blank')?.textContent
    ).toContain('Account')
  })
})
