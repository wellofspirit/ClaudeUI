import { codexHostSupported } from '../../core/codex/codex-locate'

/**
 * The gate every real-binary Codex integration shares.
 *
 * `CODEX_INTEGRATION=1` is the opt-in (these suites spawn the pinned binary and
 * are not part of the default run), and the host question is the SAME one
 * acquisition and the runtime gate ask: a host the reviewed manifest covers has
 * `vendor/codex-cli` installed, and no other host has anything to run. Reusing
 * `codexHostSupported()` rather than listing platforms here is what stops a newly
 * pinned host being provisioned but never exercised.
 *
 * Containment differs per host and is each suite's own business: macOS wraps the
 * child in `sandbox-exec`, while Windows and Linux rely on the fixture's own
 * isolation — a replacement environment, a temp `CODEX_HOME`, a config whose only
 * provider is a localhost fixture, and every network feature off.
 */
export const codexIntegrationEnabled = process.env.CODEX_INTEGRATION === '1' && codexHostSupported()
