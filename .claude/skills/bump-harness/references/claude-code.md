# Claude Code bump checklist

Authoritative procedure: `docs/protocol-cc/12-maintenance.md` §12.1. Patch internals: each
`patch/<name>/README.md` and the `patch-readme` / `patch-test-harness` skills. This list is what past
bumps forgot; it does not replace §12.1.

## Find the target

- `npm view @anthropic-ai/claude-code version dist-tags` — `latest` is the target unless the owner
  says otherwise. Read the CHANGELOG range between the pin and the target before touching anything.
- Server-side rollouts (e.g. the auto-mode default) are not in the changelog. If the owner says
  upstream behaviour changed, take it as a lead to verify, not a claim to rebut from the changelog.

## Files that move with the pin

- `package.json#claudeCliVersion` **and** `src/shared/harness-manifests/claude.json` `tested` (and
  `floor` when the owner's floor rule says so). `src/core/harness/__tests__/manifests.test.ts`
  asserts the two are equal.
- Tests that hard-code the version string: `grep -rn "<old version>" src --include=*.test.ts`.
- Protocol docs: `docs/protocol-cc/README.md` version banner, "verified against" notes, offsets
  quoted in 06 / 08 / 13 / 14. `14-auto-mode-classifier.md` goes with a re-run of
  `scripts/extract-automode-prompts.mjs`.
- The model catalog mirror (context windows, aliases, pricing, default effort):
  `docs/protocol-cc/13-context-window.md` §13.5 and the files it names. Diff the catalog in full;
  a half-mirrored catalog shipped once.

## Build and probe

1. `bun run update-cli` (re-downloads; `ensure-cli` uses the cache). It ends with the boot probe
   (`scripts/boot-probe.mjs`): the patched binary must boot with no login, emit its `init` line and
   finish with a `result` (today an `api_error` against the unreachable endpoint). A crash here is a
   patch that applied but breaks at runtime — fix it before running anything slower. On macOS the
   probe only warns until a Mac run is on record.
2. `apply-all.mjs` prints `patches: …`. A registry patch missing from that line applied nothing.
3. Keep the previous version's pristine `cli.js` (`node scripts/extract-cli.mjs --binary
.cache/claude-cli/claude-<old>-<platform>.exe` into a scratch copy) to diff old against new.

## Cross-platform apply

cli.js differs per platform within one version (keychain vs credman shapes, `B:/~BUN/root/` vs
`/$bunfs/root/` chunk names, different chunk counts). Every bump applies the patches to the
darwin-arm64 and linux-x64 bundles as well as the host's:

- `node scripts/check-patches-cross-platform.mjs` downloads each platform's binary (cached,
  sha-verified against the release manifest), extracts it into a scratch directory, applies every
  patch and syntax-checks the changed chunks. It never touches `vendor/claude-cli`.
- The ubuntu PR job also applies the patches to the linux-x64 bundle; macOS is only built after
  merge, so the script is the only pre-merge darwin check.

## Behavioural suites

- `node patch/test-all.mjs` (10–20 minutes; run it in the background and wait for it once).
- The live suites authenticate as whatever login the binary finds. An expired default login makes
  every live test fail like a patch break. Use the recipe in 12-maintenance §12.1 step 7 (the
  active account's access token in `CLAUDE_CODE_OAUTH_TOKEN`, read by a script, never echoed).
- To tell "our build is broken" from "the test or the login is broken", run the same suite against
  Anthropic's official binary: `CLAUDEUI_TEST_BIN=<official binary>`.
- `DEBUG_HARNESS=1` shows the child's stderr, which the harness swallows by default.
- Treat a flaky failure as real until a repeated run proves otherwise; the 2.1.219 `p`→`m` rebind
  showed up only as flakes.
- `src/main/__tests__/patches.test.ts` duplicates patch shape regexes: run `bun run test` too.
- `CLAUDE_INTEGRATION_TESTS=1 bun run test:integration src/integration/sdk-contract` (no
  credentials, no network).

## Re-anchoring a patch

- Use `/bundle-analyzer`, not grep over the 40 MB concat.
- Anchor on string literals and structure, never on minified identifiers; never bake a minified
  name into an injected string (bind it from the match).
- Escape every captured identifier before it goes into a RegExp: minified names contain `$`.
- Bound every `[\s\S]*?` — an unbounded lazy match captured a variable from the wrong call site.
- The anchor must match exactly once on both the old and the new bundle. Fail-closed when it does
  not.
