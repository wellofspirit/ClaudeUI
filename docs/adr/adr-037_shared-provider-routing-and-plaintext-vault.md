# ADR-037: Shared provider routing and plaintext credential vault

**Status:** Accepted
**Date:** 2026-07-22
**Amends:** ADR-036

## Decision

ClaudeUI owns canonical shared-provider definitions for configurable multi-provider harnesses only: v1 targets are pi and opencode. Claude Code is excluded from shared-provider configuration and credential vending. Future harnesses register a routing adapter/capability rather than expanding `EngineId` assumptions.

Definitions live under `~/.claude/ui/providers/<id>.json`; credentials live in `~/.claude/ui/auth-vault.json`. Definitions have shared models, with optional per-harness model ID, enabled, and default overrides. Adding a model applies it to every enabled compatible route. Each provider has explicit pi and opencode enabled checkboxes. ChatGPT is catalog-backed with shared id `chatgpt`, pi id `openai-codex`, and opencode id `openai`.

Only ClaudeUI-managed providers are compiled, removed, or credential-vended. Native/external providers and unknown fields are preserved; provider-id collisions are errors where practical. Custom definitions declare endpoint, one of `openai-completions`, `openai-responses`, or `anthropic-messages`, models, and API-key credentials. pi compilation targets only `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`, intentionally extending ADR-035. opencode uses its native config and auth files through targeted merge writers.

The central vault is plaintext JSON with 0600 mode (and its directory 0700); Electron `safeStorage` and Keychain are not used. This matches native plaintext stores. Encrypted v1 vault files are never decrypted or passed to safeStorage. Reconciliation recovers Codex OAuth from the newest native pi/opencode copy, otherwise reports disconnected/reconnect. Plaintext v1 Codex data migrates to `chatgpt` in v2.

Disabling one route removes only its ClaudeUI-managed native config and credential and persists disabled state, preventing later re-vending. Global disconnect clears central and all vended copies but retains the nonsecret definition. Status is token-free.

## Consequences

Credential routing is explicit and independently reversible per harness. Phase 1 supplies the domain and persistence foundation; adapters, reconciliation changes, IPC, and UI follow separately.
