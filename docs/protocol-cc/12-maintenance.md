# 12 — Maintenance

How to keep this documentation and the harness in sync with upstream cli.js.

---

## 12.1 When upstream cli.js version bumps

Trigger: `package.json#claudeCliVersion` changes. This invalidates our assumptions about:

- Minified variable names (they change every version)
- Control-request subtype names (rarely change, but possible)
- Stream-json message shapes (additive changes common, breaking changes rare)
- CLI flag set (additive — rarely removed)

### Step-by-step

1. **Bump version and re-extract**

   ```bash
   # Edit package.json, change claudeCliVersion
   bun run ensure-cli
   ```

   If any patch in `PATCH_REGISTRY` (`patch/lib/patch-registry.mjs`) fails with "cannot locate anchor", that patch needs updating. The `patches:` line `apply-all.mjs` prints lists the patches the new build carries; one missing from it applied nothing.

2. **Check patches that failed**

   Each patch's README has bundle-analyzer commands at the bottom. Use them to find the new location of the moved pattern. Update the regex — aim for tolerance to both old and new forms so future bumps are easier.

   Skills to invoke:
   - `/bundle-analyzer` — navigate the new cli.js
   - `/patch-readme` — regenerate or update the patch's README
   - `/patch-test-harness` — re-run behavioral tests to validate the patch works

3. **Re-verify the assistant-snapshot ordering contract**

   ```bash
   CLAUDE_INTEGRATION_TESTS=1 bun run test:integration src/integration/sdk-contract
   ```

   No credentials and no network — it plays a canned SSE stream from a localhost
   server against an isolated `HOME`. It pins the invariant
   `src/core/services/claude-item-stream.ts` depends on: one single-block
   `assistant` line per content block, sharing `message.id`, emitted after the
   block's last delta and before its `content_block_stop`
   (`docs/protocol-cc/05-stream-events.md` §5.9). If this fails, the lifecycle's
   block placement is wrong for the new version — fix it and update §5.9 and
   `03-inbound-messages.md` §3.3 together.

4. **Re-verify the inbound message type set**

   Run a real session with DEBUG_SDK=1 and wireLogCapacity=5000:

   ```bash
   DEBUG_SDK=1 bun run dev
   # exercise a complex turn
   ```

   Dump `queryHandle.wireLog()` after the turn. Grep for `type` values that aren't in `docs/protocol-cc/03-inbound-messages.md`. Any new type → document it.

5. **Re-verify the inbound control_request subtype set**

   Same wire log dump. Filter for `type === 'control_request'` (inbound). Grep for subtypes. Any new subtype → document in `docs/protocol-cc/08-control-inbound.md`. Also add a handler in `src/core/sdk/query.ts::handleControlRequest()` if it needs a real response (don't leave it on the unknown-subtype fallback).

6. **Re-verify CLI flags**

   Spawn cli.js with `--help` to dump the flag catalog:

   ```bash
   node vendor/claude-cli/cli.js --help
   ```

   Diff against `docs/protocol-cc/02-cli-flags.md`. New flags → document.

7. **Re-run the protocol test harnesses**

   ```bash
   bun run test:unit
   bun run test:component
   bun run test:e2e
   bun run test:integration    # exercises real cli.js contracts
   bun run test:patch          # the patches' own suites, against the rebuilt bun-claude
   ```

   The integration project is the one that catches real-world wire drift. `test:patch` runs four suites (`subagent-streaming`, `bash-output-streaming`, `subprocess-proxy-strip` live; `skip-securestorage` structural); `voice-server` has none, so its apply script's checks are its only guard. `CLAUDEUI_TEST_MODEL` picks a cheaper model for the live ones.

8. **Re-verify the context-window mirror**

   New model generations and alias remaps land in cli.js's context-window
   resolver before anywhere else. Follow the drift check in
   `docs/protocol-cc/13-context-window.md` §13.5 and update
   `src/core/services/context-window.ts` if the implicit-1M model list or
   the `fable`/`opus` alias targets changed.

9. **Re-issue the session on the master protocol document**

   Update `docs/protocol-cc/README.md`'s version banner to the new cli.js version. Update any "verified against cli.js X.Y.Z" annotations in sub-docs.

10. **Re-verify the OAuth token endpoint, client id and refresh body**

    `src/core/services/claude-usage-api.ts`'s `CLI_OAUTH` block mirrors cli.js's
    own refresh exchange, and a wrong value there is silent: the refresh just
    returns 400 and the account reads as needing sign-in.

    ```bash
    grep -a -o 'TOKEN_URL:"[^"]*"' .cache/claude-cli/claude-<version>-win32-x64.exe
    grep -a -o 'CLIENT_ID:"[^"]*"' .cache/claude-cli/claude-<version>-win32-x64.exe
    grep -a -b -o 'grant_type:"refresh_token"' .cache/claude-cli/claude-<version>-win32-x64.exe
    ```

    Several client ids appear. Read the bytes around each hit (`dd bs=1 skip=…`)
    and take the one in the PRODUCTION config object — the object whose
    `BASE_API_URL` is `https://api.anthropic.com`; the others belong to a
    localhost object and to a second scope family (`DESIGN_CLIENT_ID`). Read
    around the `grant_type` hit too: the body's fields, its `Content-Type` and
    the default scope list are all part of the request, and cli.js's own refresh
    posts JSON (the form-encoded one nearby is the unrelated gateway refresh).

---

## 12.2 When the SDK layer changes

Triggers: new `QueryHandle` method, new `QueryOptions` field, new inbound subtype we choose to handle explicitly.

1. **Update types** in `src/core/sdk/types.ts`.
2. **Update `query.ts`** (either `makeHandle()` for outbound, or `handleControlRequest()` for inbound).
3. **Update `docs/protocol-cc/07-control-outbound.md`** (outbound) or `08-control-inbound.md` (inbound).
4. **Update `01-transport.md` §1.13 (harness module map)** if the change affects public API or architecture.
5. **Add test coverage** — add or extend the appropriate test in `src/core/sdk/__tests__/` or `src/integration/`.

---

## 12.3 Research workflow (for agents or humans)

The docs in this directory were built by running focused bundle-analyzer passes. When re-validating or extending:

### Finding a message emitter

```bash
# Text-only signature of the outgoing shape:
bundle-analyzer.cmd find vendor/claude-cli/cli.js '"type":"<msg-type>"'
# or with escaping:
bundle-analyzer.cmd find vendor/claude-cli/cli.js 'type.*<msg-type>'

# List all string literals in the neighborhood:
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter <keyword> --near 200

# Drill into a specific function containing a match:
bundle-analyzer.cmd extract-fn vendor/claude-cli/cli.js <char-offset>
```

### Finding a control_request handler

Inbound (cli.js handling our request): search the string literal of the subtype near a `switch` or long `if/else if` chain.

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js '"<subtype>"' --compact
```

Outbound (cli.js emitting to us): similar, but the neighborhood will have `writer.write({...})` or a similar JSON serialization call.

### Locating the stdin reader

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js 'process.stdin'
```

Usually a single call site. `extract-fn` to read the parser.

### Locating the stdout writer

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js 'process.stdout.write'
bundle-analyzer.cmd find vendor/claude-cli/cli.js '"\\n"'   # the trailing newline
```

### Zod schema locations

cli.js validates control_request payloads with Zod discriminated unions. Typical shapes:

```bash
bundle-analyzer.cmd find vendor/claude-cli/cli.js '"behavior"' --compact
bundle-analyzer.cmd find vendor/claude-cli/cli.js '.discriminatedUnion'
```

Extract the schema function at the offset to see the exact field constraints.

---

## 12.4 Verification test

The single-best smoke test for protocol correctness:

```bash
DEBUG_SDK=1 bun run dev
```

1. Start a new session.
2. Issue a prompt that triggers a tool call (e.g., "list the files in this repo").
3. Deny the tool call.
4. Retry with a different action.
5. Check the terminal where `bun run dev` is running:
   - No `unknown inbound control subtype` lines (means we got a new subtype we don't handle)
   - No timeout rejections on outbound requests
   - No unparseable JSON errors

Repeat for: interrupt mid-turn, permission mode change, MCP toggle, resume session.

---

## 12.5 Document drift check

Periodically (every few cli.js version bumps, or before a release):

1. Dump a real session's wire log with `wireLogCapacity: 5000`.
2. Compare against the catalog in this directory.
3. Look for:
   - Unknown `type` at the top level → update `03-inbound-messages.md`
   - Unknown `subtype` on `system` → update `04-system-subtypes.md`
   - Unknown `event.type` inside `stream_event` → update `05-stream-events.md`
   - Unknown `subtype` on inbound `control_request` → update `08-control-inbound.md`
   - Unknown top-level field on a known message → update the field table for that message
4. Commit updates with the verifying cli.js version in the message.

Don't let drift accumulate. Docs go stale faster than code.
