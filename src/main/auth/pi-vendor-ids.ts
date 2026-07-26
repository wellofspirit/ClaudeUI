/**
 * pi's built-in vendor id catalog.
 *
 * Extracted from PiAuthProvider.ts so BOTH the auth provider (which offers
 * per-vendor auth options) and the shared-provider adapter (which must REJECT a
 * custom route whose providerId collides with one of these — M-AT4) share one
 * source of truth. A collision means a custom shared provider would vend its
 * API key over — and delete on removal — the user's real native pi credential
 * for that vendor (e.g. `anthropic`).
 */

/**
 * API-key provider ids documented in vendor/pi-cli/docs/providers.md's
 * "API Keys" table (auth.json-key column), in the table's own order. This is
 * the exact, versioned, offline reference the M3 kickoff spec calls out —
 * deliberately NOT derived from the pinned source's ~140 built-in provider
 * definitions (most of which pi supports via env-var-only resolution with no
 * dedicated auth.json UX story documented for end users).
 */
export const PI_API_KEY_VENDOR_IDS: readonly string[] = [
  'anthropic',
  'ant-ling',
  'azure-openai-responses',
  'openai',
  'deepseek',
  'nvidia',
  'google',
  'amazon-bedrock',
  'mistral',
  'groq',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'xai',
  'openrouter',
  'vercel-ai-gateway',
  'zai',
  'zai-coding-cn',
  'opencode',
  'opencode-go',
  'radius',
  'huggingface',
  'fireworks',
  'together',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp'
]

/**
 * Subscription (OAuth-capable) provider ids — VERIFIED against the pinned pi
 * source (`packages/ai/src/providers/{anthropic,openai-codex,github-copilot,
 * xai,radius}.ts`'s `id:` fields; `openai-codex` has NO apiKey auth path at
 * all — oauth only), matching providers.md's "Subscriptions" section (ChatGPT
 * Plus/Pro, Claude Pro/Max, GitHub Copilot, xAI, Radius = 5, not 4 — do not
 * guess, per the kickoff spec). `github-copilot` has no auth.json-key row in
 * providers.md's API-key TABLE (even though its provider source also accepts
 * COPILOT_GITHUB_TOKEN) — so it gets the oauth option only here, consistent
 * with deriving the api-key catalog strictly from the docs table.
 */
export const PI_SUBSCRIPTION_VENDOR_IDS: readonly string[] = [
  'anthropic',
  'openai-codex',
  'github-copilot',
  'xai',
  'radius'
]

/**
 * Every built-in native pi vendor id (api-key ∪ subscription). A custom
 * shared-provider route MUST NOT resolve to one of these — see M-AT4.
 * `openai-codex` is intentionally included: only the built-in ChatGPT shared
 * provider (kind:'subscription', id:'chatgpt') may target it; a *custom*
 * provider colliding with it would hijack the managed ChatGPT credential.
 */
export const PI_NATIVE_VENDOR_IDS: ReadonlySet<string> = new Set([
  ...PI_API_KEY_VENDOR_IDS,
  ...PI_SUBSCRIPTION_VENDOR_IDS
])
