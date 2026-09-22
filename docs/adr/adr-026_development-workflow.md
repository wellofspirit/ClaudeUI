# ADR-026 — Development workflow: main model orchestrates, sub-agent implements, review every line

**Status:** Accepted (amended 2026-09-17: driver-specific delegation: Fable uses Opus, GPT-6 uses GPT-5.6 Sol for implementation and verification; the main model orchestrates, reviews and commits. The separate-verifier requirement from 2026-09-16 remains. Amended 2026-09-21: gates and guard checks may be delegated, and a diff the main model cannot hold gets a fresh reviewer before the commit.)
**Relates to:** ADR-027 (test data attributes — the structural-verification tier this workflow leans on)
**Operational detail:** the loop + standing constraints below. (Originally mirrored from `docs/v2/ROADMAP.md` § "How we work"; the V2 docs were removed after V2 shipped, so this ADR is now the single home.)

## Context

All of V2 (engine/vendor/account split, the opencode backend, persistence, metering, the
interaction-parity series) was built with one division of labour, and it held up: **the main model
is the orchestrator and reviewer; a cheaper sub-agent writes the code.** (Originally Opus
orchestrating Sonnet; since 2026-07-30 **Fable orchestrates Opus**; on 2026-09-17 Daniel added **GPT-6 orchestrating GPT-5.6 Sol** while retaining the Fable/Opus pairing — the division of
labour is the decision, the specific models track whatever the current tier pairing is.) Every phase that
followed it surfaced at least one real bug _in review_ — a model-picker regression, dead persisted
data, a vacuous migration test, an `acquire()` race, a per-frame token overcount, a wrong auth-source
mapping — bugs that the implementing agent's own summary did not mention. The lesson, repeatedly
confirmed: **the implementing agent must never self-certify; correctness is owned by the reviewer who
reads every line and re-runs the gates independently.**

This was documented only inside `docs/v2/ROADMAP.md`, which a fresh session may not read. It needs to
be a first-class, referenced decision so every session works this way by default — not just V2
follow-ups but any non-trivial change.

## Decision

Adopt the orchestrate/implement/review loop below as the **default workflow for non-trivial changes**.
"Non-trivial" = anything beyond a one-line/obvious edit: new features, refactors touching shared
seams, anything with a native/external dependency (opencode binary, cli.js wire, DB ABI), anything
user-visible. Trivial mechanical edits and pure conversational answers are exempt.

### Roles

- **Main model (Fable or GPT-6) — orchestrator + reviewer + committer.** Owns scope, design, the kickoff spec,
  line-by-line review, the gates, the real-app verification, and the commit. The buck stops here.
- **Implementer — Opus when the driver is Fable; GPT-5.6 Sol when the driver is GPT-6.** Writes code against the spec. **Never** commits, `git add`s,
  creates branches, or runs `bun install`/`add`/`remove`. Leaves the working tree for review and
  reports deltas, exact verify-gate output, and any deviation from the spec. **Never self-certifies.**
- **Verifier — Opus when the driver is Fable; GPT-5.6 Sol when the driver is GPT-6 (separate role since 2026-09-16).** A SEPARATE agent from the implementer, dispatched
  after code review is clean. Drives the real Electron app (`verifier-electron` skill /
  `scripts/app-shot.mjs`) against a written verification brief, asserts the live DOM by `data-testid`
  (ADR-027), and returns the evidence: the DOM assertions it ran with their output, and the absolute
  paths of the screenshots it captured. It never edits source, never commits, and never certifies the
  change; it reports what it saw. The main model reads the PNGs itself before committing.

### The loop

1. **Scope & de-risk.** Read the relevant foundation doc(s) + ADR(s); recon the current code
   (grep/read) to ground the change and gauge blast radius; **probe external/native dependencies
   first** (the opencode binary, the cli.js wire, the DB ABI) — don't design around assumptions.
2. **Decide the forks with the user.** For genuine forks (depth, behavior-preserving vs
   structure-ready, library choice) use `AskUserQuestion` with a clear recommendation. Don't re-ask
   settled things. The user has consistently chosen the fuller, structure-ready option.
3. **Write a kickoff spec**: scope decisions with the chosen forks, a precise file/seam map,
   verified facts so the agent doesn't re-discover, an explicit out-of-scope list, step-by-step,
   verify gates, gotchas, a suggested commit message.
4. **Dispatch the implementer selected by the driver:** Fable uses Opus (`model: opus`); GPT-6 uses GPT-5.6 Sol (explicit model `gpt-5.6-sol`, or the tool's equivalent identifier)
   pointed at the spec, with the standing constraints (no commit / no branch / no `bun install`).
5. **Review every single line** of the agent's diff (`git diff <base>`). Read the actual code, not the
   agent's summary. Run independent checks (re-run gates, grep, probe the wire). Hunt subtle bugs.
   **Verify the agent's tests actually test what they claim** — make a guard test prove it fails
   against the pre-fix code.
6. **Send fixes back** via `SendMessage` to the agent's id (it resumes with context). Categorize:
   required / minor / accept-with-note. Re-review the fixes. Iterate until clean (1–3 rounds typical).
7. **Verify against the real dev build.** All gates pass:
   `bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`
   (0 lint errors; the handful of pre-existing `exhaustive-deps` warnings are OK). Then, for any
   UI/behavior change, **dispatch a separate verifier using the same pairing (Fable → Opus; GPT-6 → GPT-5.6 Sol)** (since 2026-09-16; before that the main model
   drove the app itself) with a verification brief: which build to run, the exact user-visible claims
   to check, the `data-testid`s to assert, and the screenshots to capture. The verifier drives the
   real Electron app via the `verifier-electron` skill (`scripts/app-shot.mjs`), asserts the live DOM
   **before** reading any PNG, and reports back the assertions with their output plus the screenshot
   paths. **The main model then reads every screenshot itself** and checks each claim in the brief
   against what the PNG shows — the verifier's summary is not the proof, the PNGs are. A screenshot
   that does not show the claim sends the item back to the implementer, not to the verifier.
   Headless/infra changes get a gated or integration smoke instead. Tests passing is necessary but
   not sufficient — confirm it works in the actual app.
8. **Commit + push** — one commit per item, after review and real-build verification are both clean.
   Stage **precisely** (never blind `git add -A` — agents and verifiers leave debris scripts);
   descriptive multi-paragraph message (subject + body); **no AI attribution / no Co-Authored-By.**
9. **Update memory** — record the result, capture any new gotcha, then `AskUserQuestion`
   for the next step.

**Cadence:** scope → forks → spec → dispatch → review↔fix loop → verify (gates + verifier's real-app
drive + the main model's proof review) → commit+push → update. The implementing agent never commits;
the main model commits only after the review loop and the real-build verification are both clean.

**What the main model does, and only that (Daniel, 2026-09-16; reaffirmed 2026-09-17):** research, write the spec, delegate
the build, review the code, delegate the end-to-end verification, review the proof, commit. It does
not implement (beyond docs, specs and trivial edits) and it does not drive the app by hand any more:
the verifier drives, the main model judges the screenshots.

### Delegated testing and the fresh reviewer (Daniel, 2026-09-21)

Both rules come from the metering arc (ADR-071), where one orchestrator session ran more than twenty
slices and its context was the scarce resource.

- **Gates and guard checks may go to the delegate** (Opus for Fable; GPT-5.6 Sol for GPT-6): the
  full gate run of step 7, and step 5's proof that a new test fails against the pre-fix code. The
  delegate reports exact command output, not a verdict. The main model still runs `bun run typecheck`
  itself before it records "gates green" anywhere, and re-runs at least one guard check per slice. A
  tree was once handed over as green with five typecheck errors in it.
- **A diff the main model cannot hold gets a fresh reviewer before the commit.** Step 5 has no
  exemption for context pressure. When the diff is too large to read in full (about 20 files was the
  threshold in practice), a fresh agent of the delegate model, with no part in the implementation,
  reads it line by line against a written checklist and reports findings. The main model reads every
  finding and every hunk it flags, then rules. In that arc the fresh reviewer found defects in three
  slices that the implementer and the main model had both missed: a rekey that skipped a column, a
  bucket rule that understated partly-billed hours, and an unguarded token refresh that two
  overlapping reads could replay.
- **Long arcs keep a handoff document** current after every slice, and every pending instruction to
  an agent goes into the written spec, never only into a `SendMessage`. A session can end while an
  agent is mid-task, and the spec is what the next session resumes from.

### Parallelism

Independent slices may be dispatched as **concurrent** implementer agents (one per area), but each diff is
reviewed on its own and the gates run on the combined tree before any commit. Parallel dispatch never
relaxes the review bar.

### Standing constraints (they have bitten us)

- **NEVER `bun install` / `bun add` / `bun remove` casually.** bun's postinstall leaves
  `better-sqlite3` **Node-ABI**, which crashes the Electron app on boot (`ERR_DLOPEN_FAILED`). After
  any dep change run **`bun run rebuild:native`** (`electron-builder install-app-deps`, rebuilds to
  the Electron ABI).
- **Dual-ABI testing.** vitest runs in plain Node and can't load the Electron-ABI `better-sqlite3`,
  so `vitest.config.ts` aliases it → `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite`
  adapter). DB-touching code is tested through that. Never import `better-sqlite3` from
  renderer/shared — main process only.
- **Don't break Claude.** Claude is the daily driver and the live login path (the user is actively
  logged in — an auth-detection bug = lockout). Every change touching shared seams must be confirmed
  behavior-preserving for Claude via the real-app drive.
- **opencode specifics.** Binary (~165 MB) is gitignored (`vendor/opencode-cli/`), vendored by
  `ensure-opencode`, shipped via electron-builder `extraResources`. HTTP **Basic auth**
  (`opencode:<generated-password>`). Target the **v1** API (`/session`, `/event`, `/auth/{id}`) —
  NOT the `/api/*` v2 family. The shared `/event` stream multiplexes all sessions → filter by
  `properties.sessionID`. Binary/plugin locators use `app.getAppPath()`, not `__dirname`.
- **cli.js wire.** For any cli.js-integration question, consult `docs/protocol-cc/` first, then probe
  the real `bun-claude` binary — cheaper and more reliable than reading minified cli.js. Use
  `/bundle-analyzer` to navigate the bundle.
- **pi wire (ADR-035).** For any pi-integration question, consult `docs/protocol-pi/` first (the
  verified notes) + the version-exact docs shipped in the vendored payload
  (`vendor/pi-cli/docs/*.md`), then probe the real `vendor/pi-cli/pi` binary. For source-level
  questions, **shallow-clone the pinned tag** (`git clone --depth 1 --branch v<piCliVersion>
https://github.com/earendil-works/pi`) — there is deliberately **no** vendored pi source clone
  (unlike `vendor/opencode-src/`). The bridge extension (`pi-bridge-source.ts`) must stay
  **import-free** and **fail-closed**; product code writes only `os.tmpdir()` (the bridge file) +
  `PiAuthProvider`'s documented `~/.pi/agent/auth.json` api_key merge — never else under `~/.pi/**`.
- **Commits.** One per item, no AI attribution, multi-paragraph body, stage precisely.
- **Pre-existing lint.** 3 `exhaustive-deps` warnings (Sidebar / ExitPlanModeCard / ReviewBar) —
  leave them.

## Consequences

- **Correctness is structurally owned by review**, not by the implementer's confidence. This is the
  single most load-bearing rule — it has caught a real bug nearly every phase.
- A fixed, referenced loop means a fresh session (or a teammate) works the same way without re-deriving
  it. `CLAUDE.md` points here; the standing constraints above (the dual-ABI `better-sqlite3` trap,
  "don't break Claude", opencode/cli.js specifics) travel with the loop.
- Slight overhead on small changes — hence the trivial-edit exemption. The bar scales with risk.

## Alternatives considered

- **Let the implementing agent self-certify** (run its own gates and call it done). Rejected: every
  phase proved the implementer misses its own bugs and its summary overstates correctness.
- **Main model drives the real app itself** (the workflow until 2026-09-16). Rejected by Daniel: driving
  the app burns the orchestrator's context on harness mechanics, and the evidence it produced was
  read by the same model that produced it. A separate verifier agent produces the screenshots; the
  main model only has to judge them.
- **Main model implements directly, no sub-agent.** Viable for small changes (and used for the spec/ADRs/
  tooling themselves), but burns the orchestrator's context on mechanical edits and loses the
  fresh-eyes review separation on larger work.
