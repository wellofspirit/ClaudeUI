# Codex backend maintenance

## Bumping Codex versions

The Codex binary version and the protocol schema ref must **always move together**. They live
in `package.json`:

```json
{
  "codexCliVersion": "0.140.0",
  "codexProtocolRef": "3ac9870e21f4ce9a28c3ae3b878b7f8f95eff06d"
}
```

`codexCliVersion` is the `@openai/codex` npm version; `codexProtocolRef` is the git SHA of
the corresponding `rust-v<version>` tag in `openai/codex`. When they diverge the generated
types no longer match the binary's actual wire protocol and JSON decode fails at runtime.

### Step-by-step bump procedure

1. **Find the new version tag SHA:**
   ```sh
   curl -s https://api.github.com/repos/openai/codex/git/refs/tags/rust-v<NEW_VERSION> \
     | jq -r '.object.sha'
   ```

2. **Update `package.json`** — set both fields:
   ```json
   "codexCliVersion": "<NEW_VERSION>",
   "codexProtocolRef": "<SHA_FROM_STEP_1>"
   ```

3. **Re-download the binary:**
   ```sh
   bun run update-codex
   ```
   (`update-codex` = `ensure-codex --force`, bypasses the version-stamp cache.)

4. **Regenerate protocol types:**
   ```sh
   bun run generate-codex-protocol
   ```
   This fetches the JSON Schema from `github.com/openai/codex` at `codexProtocolRef` and
   regenerates `src/main/codex/protocol/` (`schema.ts`, `methods.ts`, `index.ts`).

5. **Verify compilation and tests:**
   ```sh
   bun run typecheck
   bun run test
   ```

6. **Review the protocol diff** — `git diff src/main/codex/protocol/` shows every changed
   type. For any changed method signatures, update `CodexAppServerClient.ts` and
   `mapCodexEvent.ts` accordingly.

7. **Run the gated integration test** (requires a logged-in `codex` binary):
   ```sh
   CODEX_INTEGRATION_TESTS=1 bun run test:integration
   ```

8. Commit the `package.json` change and the regenerated `src/main/codex/protocol/` files
   together. The binary in `vendor/codex-cli/` is gitignored and not committed.

---

## What is checked in vs gitignored

| Artifact | Status | Reason |
| --- | --- | --- |
| `vendor/codex-cli/codex[.exe]` | **gitignored** | Binary; downloaded by `ensure-codex` |
| `vendor/codex-cli/version.json` | gitignored | Stamp written by `ensure-codex` |
| `src/main/codex/protocol/schema.ts` | **committed** | Generated TS; diffs are reviewable |
| `src/main/codex/protocol/methods.ts` | committed | Same |
| `src/main/codex/protocol/index.ts` | committed | Same |

---

## Auth

Codex auth is fully delegated to the binary. ClaudeUI does not manage credentials. If a
session fails with an auth error, the user must run:

```sh
codex login
```

The auth status shown in the Codex provider settings row is probed via a short-lived
`account/read` call in `codexStatus.ts`.

**Do not set `CODEX_HOME`** in any spawn env. Forcing `CODEX_HOME=$HOME` or any other value
breaks credential lookup and causes 401 errors. The binary uses `~/.codex` by default.

---

## Script reference

| Script | Command | When to use |
| --- | --- | --- |
| `ensure-codex` | `bun run ensure-codex` | After `bun install` / first checkout (auto via `postinstall`) |
| `update-codex` | `bun run update-codex` | After bumping `codexCliVersion` |
| `generate-codex-protocol` | `bun run generate-codex-protocol` | After bumping `codexProtocolRef` |

Both `ensure-codex` and `update-codex` are also wired into `dev` and every `build:*` script
(alongside `ensure-cli`), so a fresh build always downloads the correct binary.

---

## See also

- `docs/codex/protocol-reference.md` — method catalog and notification mapping
- `docs/codex/implementation-plan.md` — original design rationale and §4c on patching
- ADR-017 (`docs/adr/adr-017_codex-app-server-backend.md`) — decision record for the Codex backend
