# ADR-092: Model catalogs load per engine and survive boot; pi is ended through stdin

**Status:** Accepted (2026-10-05). Built on branch `pre-release`: `1ca491ef`, `466d9822`, `adf12a7b`,
`e615edaa`, `f2503fa1`.
**Amends:** [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) (a harness change
re-fetches only that engine's models, not every engine's), [ADR-074](adr-074_provider-surfaces-v3.md)
(the shared-provider boot sync is idempotent), [ADR-035](adr-035_pi-engine-backend.md) (how a pi
process is ended).
**Relates to:** [ADR-045](adr-045_engine-disconnect-status-contract.md) (pi's `cancel()` now
reports `disconnected`, `542e96ec`), [ADR-036](adr-036_unified-auth-vault.md) (the credential feed
whose writes this makes idempotent), [ADR-059](adr-059_no-silent-model-fallback.md) (the composer
keeps showing a session's model while its catalog is missing).

## Context

After a restart, a pi session's composer showed the raw model value
`openrouter/deepseek/deepseek-v4.1-flash` instead of "DeepSeek: DeepSeek V4.1 Flash" for about 75 s,
then recovered without anyone doing anything. The composer can only name a model it finds in
`availableModels`. Otherwise it shows the stored value (`InputBox.tsx`, `missingSelection`). That list
was missing because of a chain of five faults, found with the app log, temporary timing probes and
the pi source at the tag that runs (`vendor/pi-src`, v0.99.2):

1. **Boot rewrote unchanged credentials, and every write cleared a model cache.** `CredentialSync.feedAll`
   re-feeds each engine's OAuth entry, and `SharedProviderService.syncAll` re-vends every API key
   and re-removes the key of every route that is off. Each write or removal called
   `invalidate{Pi,Opencode}ModelCache()` whether or not anything changed, and the opencode adapter
   called it a second time. An invalidation kills the catalog probe in flight (ADR-082
   "Generations"). Measured: opencode started three `opencode serve` processes to answer one
   lookup at boot. opencode's `setVendorApiKey` also started a server just to PUT the identical key,
   then `recycleAll()`.
2. **A pi killed during startup leaks a lock.** pi takes `proper-lockfile` locks on
   `~/.pi/agent/models-store.json` (and `auth.json`) while it starts. Even a read goes through
   `withLockAsync` (`coding-agent/src/core/models-store.ts`, reusing `auth-storage.ts`; 30 s stale,
   retried until a 30 s deadline). pi installs its SIGTERM handler only once RPC mode runs
   (`modes/rpc/rpc-mode.ts`). `PiRpcClient.dispose()` sent SIGTERM straight away, so a probe killed
   by one of those invalidations died holding the lock dir. Every pi started in the next 30 s then
   blocked on it. Measured: 14.5 s for a probe that answers in 0.24 s, against ClaudeUI's 15 s probe
   timeout.
3. **A failed probe was cached as "no models" for 60 s.** `model-discovery.ts` negative-cached a
   timeout or crash exactly like pi's legitimate "no credentials" answer.
4. **Nothing asked again.** The renderer re-read models only on a cwd change or a reload nonce bump.
5. **One reply for all engines.** `session:get-engine-models` awaited Claude, opencode, pi and
   Codex in turn and answered once, so a stuck pi probe also hid Claude's, opencode's and Codex's
   models.

## Decision

### 1. One catalog request per engine

`getEngineModels(engineId?)` keeps its channel and gains an optional engine id. With one, only that
engine's lookup runs and only its groups come back. Without one, all four run concurrently into one
reply (`src/core/ipc/engine-models.ts` `listEngineModels`, shared by the desktop and remote
handlers). The argument is untrusted. An unknown id rejects rather than answering `[]`, because an
empty answer reads as "this engine has no models". `null` means all engines, since a JSON wire turns
an `undefined` argument into `null`.

The composer sends one request per engine. Each answer replaces only that engine's slice of
`availableModels` (`setEngineModels`), rebuilt in `HARNESS_IDS` order (claude, opencode, pi, codex)
whatever order the answers arrive in. Answers are filtered to the requested engine, so a host that
predates the argument still works. Each request carries its own token: one engine's reload must not
orphan another engine's answer still in flight. Settings panes that filtered the full catalog to one
engine ask for that engine.

Reloads are per engine too. `engineModelReloadNonces[engine]` drives the composer, and
`reloadEngineModels(engine)` bumps that engine's counter and the global `modelReloadNonce` (what
open Settings panes follow). `reloadModels()` bumps every counter. A harness change (ADR-082
`followRunChanges`) and a recovered catalog (§2) reload only their engine.

### 2. A degraded catalog heals itself and says so

pi's discovery tells pi's own "I have no models" apart from a failed probe:

- **Successful empty answer** (no credentials): keeps the 60 s negative cache.
- **Failure** (spawn error, `success:false`, timeout, exit): a 5 s backoff
  (`FAILED_PROBE_BACKOFF_MS`) and one background re-probe. The re-probe is unref'd, never stacked,
  re-armed by an invalidation while a degraded answer is outstanding, and never chained after its
  own failure, so a broken pi is not polled.
- **Probe cancelled by an invalidation**: not cached, as before.

When the catalog fills after some caller was answered a degraded `[]`, main emits
`engine:models-changed { engineId }` (`replicated`, rings like `harness:changed`). Every client,
desktop or remote, reloads that engine. A warm-cache read never emits, so the reload cannot loop.
The recovery logs one info line.

### 3. The boot reconciliation is idempotent

Applying the configuration again must change nothing when nothing changed:

- **Writes:** opencode's and pi's `setVendorApiKey` / `feedOauthCredential` compare the entry they
  would write with `auth.json` as read at call time, never a remembered copy, because the engines
  rotate their own tokens. An unchanged entry writes nothing and invalidates nothing. For opencode
  it also starts no server, sends no PUT and recycles nothing. pi's `applyDefinition` skips an
  unchanged `models.json` entry, as opencode's `applyDefinitionRoute` already did.
- **Removals:** opencode's `removeVendorAuth` returns before anything when `auth.json` holds no
  entry for the vendor. A missing `auth.json` is an empty store. An unreadable one still takes the
  server path, so a corrupt file never silently skips a removal. pi's removal was already a no-op
  on an absent entry.
- **Invalidation lives in the auth target**, and only for a real change. The opencode adapter adds
  none of its own after a vend or a removal.

The equality reuses `deepEqual` (`src/shared/opencode-config-diff.ts`). opencode's PUT replaces an
entry whole, so for `setVendorApiKey` the stored entry must equal `{ type: 'api', key }` exactly.

### 4. pi is ended through stdin, a signal only as a fallback

`PiRpcClient.dispose()` closes the child's stdin. pi finishes starting, its JSONL reader sees EOF
(`onInputEnd`), and its own shutdown releases the locks and aborts the agent; its bash tool kills
its own process tree on that abort. Only if the process is still alive `PI_DISPOSE_GRACE_MS`
(2 s) later does `killProcessTree` run. This is the same on Windows, which has no graceful signal
at all. `dispose()` stays synchronous and idempotent:

- Pending requests reject at once.
- No events are delivered after it, but stdout keeps draining so pi's final flush cannot stall.
- `onExit` still fires on the real exit.
- `start()` after `dispose()` rejects instead of spawning an unowned pi.

Measured against the real binary: no leaked locks in 80 dispose timings across pi's startup, and
the slowest exit took 429 ms.

## Consequences

- **Startup measurements** (own profile directory): Codex models in ~0.9 s, pi ~1.2 s, Claude
  ~2 s, opencode ~2.4–2.9 s (one server instead of three, previously ~3.9 s). A stuck pi probe no
  longer delays any other engine. Verified in the real app with a planted stale lock: the other
  engines landed at 6–10 s while pi was empty; pi recovered at ~30 s with only its counter bumped.
- **Re-saving an identical API key no longer recycles opencode servers.** A server whose provider map
  went stale another way (`opencode auth login` in a terminal) is not repaired by re-saving the
  same key.
- **A pi process may outlive `dispose()`** by ~0.07 s typically (2 s at most). Callers that care
  about the exit (PiSession's H19 guards, the subagent runner) already key on `onExit`.
- **The 2 s fallback timer is unref'd.** If the app quits within it and pi's shutdown hangs, nothing
  force-kills that pi. The quit still closes its stdin.
- **The all-engines reply remains** for callers that want every engine at once (model curation
  blocks) and can afford the slowest probe.
- **Upstream:** the early-SIGTERM lock leak is a pi bug (signal handlers are installed only after
  startup). It is worth reporting to `earendil-works/pi`.

## Alternatives considered

- **Streaming catalog replies** (a subscription per request, or per-engine events): the same latency
  win, but a second delivery path on both transports and request/reply correlation. Per-engine
  requests fit the existing request/response model as they are.
- **A soft deadline on the all-engines reply** (answer `[]` for engines past N seconds, deliver them
  later through §2's event): reuses §2, but it is still one reply gated by a timer, and every
  late engine costs a second round trip.
- **Keep SIGTERM, delete stale lock dirs before spawning**: racy against a live pi legitimately
  holding the lock, and it deletes another program's state.
- **Raise the discovery timeout past 30 s**: hides the leak, and makes a genuinely stuck probe cost
  twice as long.
