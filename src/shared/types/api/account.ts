import type {
  OpenRouterEndpointRow,
  OpenRouterModelRow,
  OpenRouterModelScope,
  OpenRouterOverview
} from '../../openrouter'
import type { AccountLimits, ChatgptRateLimits } from '../usage-limits'
import type {
  AccountUsage,
  DashboardRange,
  DashboardScope,
  UsageDashboardData
} from '../usage-dashboard'
import type { AccountsState, AuthFlowState } from '../auth'
import type { BlockUsageData } from '../usage-blocks'
import type {
  UsageHubConfigureInput,
  UsageHubStatus,
  UsageWindowQuery,
  UsageWindowSummaryRow
} from '../usage-hub'

export interface AccountAPI {
  fetchAccountUsage(): Promise<AccountUsage>
  /**
   * Per-account ChatGPT rate limits (ADR-068 §2). `refresh` asks the host to
   * read them from the ChatGPT backend first; without it the last known map comes back.
   */
  fetchChatgptLimits(refresh?: boolean): Promise<ChatgptRateLimits>
  fetchBlockUsage(): Promise<BlockUsageData>
  /** Filter usage analytics to one account email (null = all accounts) */
  setUsageAccountFilter(account: string | null): Promise<void>
  // --- Native Anthropic OAuth (ADR-014) ---
  /** Start the subscription login flow: opens the browser and awaits the
   *  loopback redirect. Resolves once cli.js has stored fresh credentials. */
  signIn(): Promise<AuthFlowState>
  /** Manual fallback: submit the authorization code pasted by the user.
   *  `state` is recovered internally from the login URL. */
  submitOAuthCode(code: string): Promise<AuthFlowState>
  /** Abort an in-flight login flow. */
  cancelSignIn(): Promise<void>
  /** Subscribe to login-flow state transitions. */
  onAuthState(cb: (state: AuthFlowState) => void): () => void
  // --- Multiple-account support (ADR-015) ---
  /** Current accounts + active id + enabled flag. */
  getAccounts(): Promise<AccountsState>
  /** Toggle multi-account (file-based credential) mode. */
  setMultiAccountEnabled(enabled: boolean): Promise<AccountsState>
  /** Create a new account and start its login flow (resolves once login starts). */
  addAccount(): Promise<AccountsState>
  /** Make an existing account active (sessions respawn against it). */
  switchAccount(id: string): Promise<AccountsState>
  /** Delete a persisted account and its credentials. */
  deleteAccount(id: string): Promise<AccountsState>
  /** Subscribe to account list / active / enabled changes. */
  onAccountsChanged(cb: (state: AccountsState) => void): () => void
  /** Fired when the active account changed — renderer should respawn sessions. */
  onAccountRespawnSessions(cb: () => void): () => void
  /**
   * Fetch the models.dev price catalog (the one opencode reads, ADR-071 §5),
   * persist it, and register it as supplemental pricing so equivalentCostUsd
   * resolves opencode model costs. Phase 9b.
   */
  refreshPrices(): Promise<{ count: number; refreshedAt: number }>
  /**
   * Every account's limits, across vendors (ADR-071 §6).
   *
   * `refresh: true` is the ONLY thing that reads an inactive Claude account's
   * credentials, and it spends a refresh grant doing it — the owner's rule is
   * that a person pressing Refresh is the only reason to. Without it the answer
   * comes from the last persisted reading and costs nothing.
   */
  fetchAccountLimits(refresh?: boolean): Promise<AccountLimits[]>
  // --- OpenRouter tab (Usage Analytics) ---
  /** Whether the vault holds an OpenRouter API key. Reads nothing from the network. */
  openrouterStatus(): Promise<{ configured: boolean }>
  /** The key's budget and spend, the account's credits and the ledger's figure for the key. */
  openrouterOverview(): Promise<OpenRouterOverview>
  /** The model catalog: the account's allowed models, or all of them, with benchmark indices. */
  openrouterModels(scope: OpenRouterModelScope): Promise<OpenRouterModelRow[]>
  /** The providers serving one model, with their live health figures. */
  openrouterModelEndpoints(modelId: string): Promise<OpenRouterEndpointRow[]>
  /**
   * The window-value ledger (ADR-071 §7): one row per limit window with its
   * peak percent, what the ledger saw inside it, and the two derived figures.
   * Closed windows are included and are most of the answer.
   */
  fetchUsageWindows(query?: UsageWindowQuery): Promise<UsageWindowSummaryRow[]>
  /**
   * The dashboard's one read over the ledger's hourly buckets (ADR-071 §8),
   * grouped provider → account → model for the given range.
   *
   * `scope` defaults to `local`, this machine's own ledger. `all` folds the
   * cached rows of every other machine the hub knows about into the same totals
   * (ADR-072 §3); a machine with no hub answers `local` and says so.
   */
  fetchUsageDashboard(range: DashboardRange, scope?: DashboardScope): Promise<UsageDashboardData>
  /** The usage hub's client state (ADR-072 §7). Never carries the device secret. */
  usageHubStatus(): Promise<UsageHubStatus>
  /** Write the hub's URL, this device's name, the service-token id, and the on/off switch. */
  configureUsageHub(input: UsageHubConfigureInput): Promise<UsageHubStatus>
  /**
   * Store the device secret. WRITE-ONLY: nothing reads it back, and the answer
   * is the status, whose `hasSecret` is all a surface is told.
   */
  setUsageHubSecret(secret: string): Promise<UsageHubStatus>
  /** Push then pull, now. Ignores the non-essential-traffic gate — the user asked. */
  syncUsageHubNow(): Promise<UsageHubStatus>
  /** ADR-072 §2's repair: have the hub drop this device's recent rows and re-push them. */
  resyncUsageHub(): Promise<UsageHubStatus>
  /** Forget the hub: the config, the secret and every cached remote row. */
  forgetUsageHub(): Promise<UsageHubStatus>
}
