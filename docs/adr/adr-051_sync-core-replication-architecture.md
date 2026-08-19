# ADR-051 — SyncCore: main-process canonical state, closed wire contracts, desktop as client #1

**Status:** Accepted (2026-08-13) — design; implemented in phases per `docs/architecture/sync-core.md`. **Phases 0-4 landed 2026-08-14** (canonical state is the state of record, the desktop renderer is client #1 folding the shared reducer, and the app runs windowless); **phase 5 landed 2026-08-17** — contract 3's volatile stream lane as refined by ADR-055 (two flavors, lossy tails, per-connection subscriptions, remote voice). **The named follow-on phase landed 2026-08-18** — decision 5 below ("Headless-first") is realized physically: the service graph lives in `src/core` behind the `host.ts` seams and boots under two hosts, the Electron app (`src/main`) and `claudeui-server` (`src/server`); see ADR-058, and `docs/architecture/sync-core.md` §Topology / §Follow-ons.
**Relates to:** ADR-008 (typed web client — retired as a mirror, kept as a belt), ADR-030 (capability honesty), ADR-038/040/045 (event-driven lifecycle discipline — SyncCore generalizes it), ADR-050 (web-client default derivation — absorbed by snapshot-from-core), ADR-052 (security companion), ADR-053 (queue subsystem)
**Supersedes in part:** ADR-041 (desktop-renderer snapshot + resync merge), ADR-043 (the "renderer store is the single source of truth; main stays a pure relay" doctrine)

## Context

The 2026-08-13 sync-drift review (`docs/architecture/remote.md`) found the remote layer is an **IPC mirror with a privileged desktop renderer**, not the event-sourced hub it was designed as: client actions are RPC invokes that never enter the event stream; events are an opt-in mirror of `webContents.send` traffic; full-state snapshots are the desktop renderer's Zustand store pulled via `executeJavaScript` (racy seq watermark, silently empty when the renderer is busy); the web client drops events while advancing `lastSeq`. Consequences included ghost queued messages, unsynced model/effort/thinking changes, and resyncs that erase remote clients' own state. The owner additionally requires remote terminals and an eventual **headless Linux server** deployment, and confirms **single-operator** scope.

## Decision

Rebuild the sync layer as **SyncCore** (normative spec: `docs/architecture/sync-core.md`):

1. **Closed wire-contract set.** Every interaction is exactly one of: **command** (validated, capability-checked, identity-attached, audited; never mutates client state), **domain event** (`{seq,…}`, append → apply → broadcast; the *only* replicated-state mutation path), **volatile stream** (streaming deltas / PTY bytes; subscription-scoped, never logged — their coalesced value lives in canonical state, with `{turnId, offset}` self-healing), or **query** (RPC read). No fifth path.
2. **Canonical state in the main process**, maintained by a **shared pure reducer** (`applyEvent`) that every client replica also runs. Snapshots serialize core state at a consistent seq, in-process — the watermark invariant (snapshot at N contains all events ≤ N) holds by construction.
3. **The desktop renderer becomes client #1** — same protocol, same client library (MessagePort transport; web uses WebSocket+E2E). No privileged client; per-client view state (selection, drafts, layout) stays local by design.
4. **Cursor discipline:** `lastSeq` advances only after apply; pre-mount events buffer; gap ⇒ resync. Ring buffer holds domain events only (streams excluded) and stays **memory-only** — a durable event log is rejected (per-process epoch forces sync-full across restarts anyway; transcripts/DB already persist what matters). The audit log is the durable addition.
5. **Headless-first:** `src/core` carries no Electron imports (lint-enforced); the desktop app is a host shell; `claudeui-server` boots core alone on Linux behind `tailscale serve`. Admin/host-only surfaces become `admin`/`host` capabilities instead of "desktop-only channels".

## Consequences

- Model/effort/thinking/queue changes become ordinary domain events — the per-field sync gaps and the H15-class whole-blob clobber bugs become unrepresentable; granular commands replace `config:save-sessions` round-trips.
- ADR-041's merge semantics and ADR-050's web-side default derivation dissolve: reconnect is snapshot + replay from core, and per-client selection survives because it was never replicated.
- The `api-adapter` hand-mirror is retired; parity is by construction (ADR-008's typecheck stays as a belt).
- Migration is phased (0–5, sized in the design doc). With phase 4 landed, `docs/architecture/sync-core.md` IS the as-built record for sync; ADR-041/043 describe the pre-cutover system in the parts their own status lines name, and `docs/architecture/remote.md` is now the transport + auth record rather than a parallel sync description.
- review.md's remote findings (watermark race, drop-before-mount, structural-not-semantic parity) are resolved by construction rather than patched.
