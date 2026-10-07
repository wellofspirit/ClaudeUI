/**
 * A spy `OpencodeChatgptTarget` (opencode 2.x, ADR-097 §5) for CredentialSync
 * tests. Its spies keep the 1.x feed-target call shape — `feed('openai', cred)`,
 * `remove('openai')` — so an assertion reads the same for both engines; the
 * credential store behind the real target is tested on its own
 * (`core/opencode/__tests__/credential-store.test.ts`).
 */
import { vi } from 'vitest'
import type {
  CodexCredentialInput,
  OpencodeChatgptTarget
} from '../../../../../core/auth/vault/CredentialSync'
import { OpencodeCredentialStore } from '../../../../../core/opencode/credential-store'
import { fakeCredentialTable } from '../../../../../core/opencode/__tests__/fixtures/fake-credential-table'

export function fakeOpencodeTarget(): {
  target: OpencodeChatgptTarget
  feed: ReturnType<typeof vi.fn<(vendorId: string, cred: CodexCredentialInput) => Promise<void>>>
  remove: ReturnType<typeof vi.fn<(vendorId: string) => Promise<void>>>
  /** The token-check each vend/removal was handed, last first. */
  checks: Array<(refresh: string) => Promise<boolean>>
  /** What the target holds as vended (the gate's input). */
  vended: () => { access: string; realExpires: number } | null
} {
  const feed = vi.fn(async (_vendorId: string, _cred: CodexCredentialInput) => {})
  const remove = vi.fn(async (_vendorId: string) => {})
  const checks: Array<(refresh: string) => Promise<boolean>> = []
  let vended: { access: string; realExpires: number } | null = null
  const target: OpencodeChatgptTarget = {
    vendChatgpt: async (cred, check) => {
      checks.unshift(check)
      await feed('openai', cred)
      vended = { access: cred.access, realExpires: cred.expires }
    },
    removeChatgpt: async (_context, check) => {
      checks.unshift(check)
      await remove('openai')
      vended = null
      return true
    },
    vendedChatgpt: () => vended
  }
  return { target, feed, remove, checks, vended: () => vended }
}

/**
 * opencode 2.x as far as CredentialSync can tell: the REAL credential store
 * over an in-memory credential table (`fakeCredentialTable`). `holdsOurs`
 * vends ClaudeUI's row through the store; `holdsOwn` seeds a sign-in of the
 * user's own (`cred_user_*`, active, with its refresh token). `held()` names
 * what the active `openai` row holds — the token tag of ClaudeUI's access
 * (`fake-access-<tag>`), or the user's refresh token.
 */
export function storeBackedOpencode(available: () => boolean = () => true) {
  const table = fakeCredentialTable()
  const store = new OpencodeCredentialStore({ connect: table.connect, available })
  const feed = vi.fn(async (_vendorId: string, _cred: CodexCredentialInput) => {})
  const remove = vi.fn(async (_vendorId: string) => {})
  let own = 0
  const target: OpencodeChatgptTarget = {
    vendChatgpt: async (cred, check) => {
      await feed('openai', cred)
      await store.vendChatgpt(
        { access: cred.access, expires: cred.expires, accountId: cred.accountId ?? 'acct-test' },
        check
      )
    },
    removeChatgpt: async (context, check) => {
      await remove('openai')
      return store.removeSlot('openai', 'oauth', context, check)
    },
    vendedChatgpt: () => store.vendedChatgpt()
  }
  const tag = (access: string): string => access.replace(/^fake-access-/, '')
  return {
    target,
    table,
    store,
    feed,
    remove,
    holdsOurs: async (refresh: string, accountId = 'acct-test'): Promise<void> => {
      await store.vendChatgpt({
        access: `fake-access-${refresh}`,
        expires: Date.now() + 86_400_000,
        accountId
      })
    },
    holdsOwn: (refresh: string): void => {
      table.seed({
        id: `cred_user_${++own}`,
        integrationID: 'openai',
        label: 'mine',
        value: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          refresh,
          access: `fake-user-access-${refresh}`,
          expires: Date.now() + 86_400_000
        }
      })
    },
    held: (): string | undefined => {
      const active = table.active('openai')
      if (!active || active.value.type !== 'oauth') return undefined
      return active.id.startsWith('cred_claudeui_')
        ? tag(active.value.access)
        : active.value.refresh
    },
    /** ClaudeUI's own rows left in the table. */
    ours: (): string[] =>
      table
        .rows()
        .filter((row) => row.id.startsWith('cred_claudeui_'))
        .map((row) => row.id)
  }
}
