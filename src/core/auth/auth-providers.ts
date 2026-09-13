/**
 * The provider ids `session:auth-required` names (ADR-068 §4).
 *
 * One literal per provider ClaudeUI can actually drive a sign-in for, so the
 * emitters and the dialog cannot drift on a string. ChatGPT's id is the vault's
 * own (`CHATGPT_PROVIDER_ID`) and is re-exported here rather than copied.
 */
export { CHATGPT_PROVIDER_ID } from './vault/AuthVault'

/** Claude subscriptions — cli.js drives the flow (ADR-014). */
export const ANTHROPIC_AUTH_PROVIDER_ID = 'anthropic'
