# ADR-044: opencode providers — Disable and Remove are different operations, over one merged list

**Status:** Accepted (2026-07-31)
**Relates to:** [ADR-028](adr-028_opencode-native-config-in-place.md), [ADR-031](adr-031_opencode-config-leaf-merge-writes.md), [ADR-036](adr-036_unified-auth-vault.md), [ADR-037](adr-037_shared-provider-routing-and-plaintext-vault.md), [ADR-027](adr-027_test-data-attributes.md)

## Context

**opencode does not store a list of installed providers.** `Provider.state`
(vendored v1.17.14, `provider/provider.ts:1338-1653`) re-derives the set on every
instance start from five independent sources, checking `disabled_providers` at
each one:

| Source | Evidence | Can ClaudeUI delete it? |
|---|---|---|
| `provider` declarations in config | `1420-1515`, re-merged `1583-1590`; openai-compatible loaders autoload on `source === 'config'` (`479`, `958`) | Only in the ONE global file it writes |
| env vars | `1517-1528`, `source: 'env'` | No — not our environment |
| auth.json `type: 'api'` | `1531-1541`, `source: 'api'` | Yes |
| plugin auth loader, gated on a stored credential | `1544-1562`, stamps `source: 'custom'` | Yes |
| `custom()` loaders autoloading from ambient state | zen `198`, bedrock `338/362`, vertex `517/554`, cloudflare `835` | No — nothing exists to delete |

`disabled_providers` is therefore the only user-facing veto that works against
every derivation, and the provider manager wrote it for every "Remove".

That is right for the sources ClaudeUI cannot delete from and **wrong** for the
ones it can. ChatGPT reaches opencode purely through the plugin-auth path
(`plugin/openai/codex.ts:279,320-321` declares provider id `openai`; openai's own
custom loader is `autoload: false`, `provider.ts:204`), so its credential is the
only reason it is listed. Removing it therefore both deleted the credential and
vetoed the id — and `CredentialSync.feedAll` re-fed the credential on the next
refresh while the veto kept hiding the provider. Live repro on the author's
machine: `auth.json` held a valid `openai` OAuth entry, `opencode.jsonc` held
`disabled_providers: [..., "openai"]`, and ChatGPT's opencode route reported
**0 models** indefinitely, because opencode omits disabled providers from
`/config/providers` and `aggregateChatgptModels` consequently marked every model
`harnessOverrides.opencode.available = false`.

Compounding it, two settings surfaces owned overlapping slices of the same set: a
catalog-driven "Providers & models" list and a declaration-driven "Custom
providers" section with its own `✕`. Enabled declared providers appeared in both;
a declared **and** disabled provider (`qwen-sandbox`) appeared in neither as
disabled, so opencode ignored it with nothing in the UI saying so.

## Decisions

### 1. Disable and Remove are distinct, separately-gated operations

- **Disable** writes only `disabled_providers`. Reversible, destroys nothing,
  and is **always available** — it is the one veto that beats every derivation.
- **Remove** destroys what ClaudeUI owns: the auth.json credential and/or the
  declaration in the single global config file it writes. Confirmation required,
  and the dialog names exactly what will be destroyed.

Availability is resolved by a pure function (`main/opencode/provider-actions.ts`)
carried on each catalog entry, so the row never re-derives it:

| Class | Disable | Remove |
|---|---|---|
| has auth.json entry | ✓ | ✓ `credential` |
| declared in the file we write | ✓ | ✓ `declaration` |
| both | ✓ | ✓ `both` |
| declared in the other global file / project / MDM | ✓ | ✗ blocked, reason names the file |
| env-derived | ✓ | ✗ blocked, reason names the variable |
| credential-free autoload (zen, bedrock, vertex) | ✓ | ✗ blocked |

A blocked trash icon is **rendered disabled with the reason as its tooltip**, not
hidden: "you cannot remove this" is information the user needs.

### 2. Remove must clear its own veto

`removeOpencodeProvider` drops the id from `disabled_providers` and from
ClaudeUI's `modelAllowlist` unconditionally. A veto outliving what it vetoed IS
the defect above; a stale empty allowlist would reproduce the same "0 models"
symptom on a later re-add. The declaration delete and the veto cleanup share ONE
config read-modify-write, so no window exists where the declaration is gone but
`disabled_providers` still names it. A failed credential delete aborts before any
config write, so a transient server-spawn error cannot destroy a declaration.

### 3. Availability is computed from ClaudeUI-owned reads, never by probing opencode

The intuitive "delete, re-probe, disable only if still listed" is unsound: a live
opencode server never re-reads either file. Global config is cached at
`Duration.infinity` (`config/config.ts:288`) and the provider `InstanceState` is
invalidated only on instance dispose (`effect/instance-state.ts:38`), so with any
session holding a server ref (`OpencodeServerManager` kills only at refcount 0)
the probe answers from pre-delete state. Inputs are therefore all cheap local
reads: auth.json (`opencode/auth-store.ts`, extracted so `model-discovery` can
read it without cycling through `OpencodeAuthProvider`),
`readOpencodeNativeConfig().providers`, and `readDeclaredProviderIds()`.

opencode's `source` / `env` are plumbed through for **message wording only** —
never for the decision, so an opencode schema change cannot silently alter which
actions we offer. `source` is read from `/config/providers` and never from
`/provider`, whose `all` runs unconnected entries through
`fromModelsDevProvider` and hardcodes `source: 'custom'` (`provider.ts:1279`).

### 4. One provider list; declaration editing is a dialog

The `opencode-providers` ("Custom providers") section is removed. Catalog and
declared providers share one list, which includes **disabled** providers as
first-class rows (dimmed, badged `Disabled`, with an Enable action). Discovery
re-synthesizes those rows because `GET /provider` omits disabled ids entirely,
and it no longer skips declared ids — skipping them is what made `qwen-sandbox`
render nowhere.

Row actions are icon buttons (`sliders` models, `key-round` credential, `pencil`
configure, `power` enable/disable, `trash-2` remove), each with `aria-label` +
`title` and two-tier `data-testid`s per ADR-027. The declaration form moved into
`OpencodeProviderConfigModal` at `z-[100]` (settings root is `z-50`; a confirm
opened from inside it takes `z-[110]`), which splices into the full `providers`
record rather than rebuilding it from a local row list. A shared-provider-managed
declaration renders read-only with a pointer to its owner — the shared-provider
compiler owns it and would overwrite edits (ADR-037).

Icons are hand-rolled inline SVG; no icon dependency was added for five glyphs.

### 5. Shared-provider collisions are surfaced, not silently lost

When an enabled shared-provider route vends a vendor id (`chatgpt` → `openai`),
the row carries a `Shared · <name>` badge and the remove confirmation warns that
the credential will be restored on the next sync, pointing at the route toggle.
The claim is decorated at the IPC boundary, not in discovery — `shared-providers`
→ `OpencodeSharedProviderAdapter` → `model-discovery` means a shared-provider
import inside discovery would be a cycle.

## Consequences

- Removal is honest and narrowly scoped; the veto can no longer outlive its
  target, which was the whole ChatGPT failure.
- "Remove" is legitimately unavailable for four provider classes. That is
  surfaced with a reason rather than hidden, and Disable always covers the intent.
- Enable/disable has exactly one writer (main), so `disabled_providers` cannot
  drift between the renderer and the remove path.
- Both operations reach the remote surface (ADR-039 parity, token-gated).
- Verified live: enabling `openai` through the new toggle removed exactly that
  array entry from `opencode.jsonc` (comments and every other key byte-preserved,
  per ADR-031) and ChatGPT's opencode route went from `0` to `13 models`.
