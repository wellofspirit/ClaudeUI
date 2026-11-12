# src/core/automode

This is a Critical area under ADR-026 (the permission ladders and the auto-mode judge): a change here needs a design review and live verification. ADR-023 (classifier core), ADR-081 (judge transport), ADR-083 and ADR-106 (policy and measured facts), ADR-084 (read-only skip), ADR-085 (rules hold or skip the judge), ADR-088 (dispatch targets), ADR-091 (held blocks), ADR-107 and ADR-109 (outages and unusable replies).

## What lives here

- Judge pipeline and transport: `src/core/automode/judge-pipeline.ts` (the shared stage order), `judge-setup.ts` (per-owner setup), `judge-route.ts` (model to route), `judge-http/` (the HTTP call), `session-judge.ts` (transport factory), `classifier.ts` (prompt and verdict parsing).
- Ground truth and shell analysis: `src/core/automode/ground-truth.ts` (redirect, cwd and git facts), `action-meta.ts` (per-action capture for the three shells), `shell-lexical.ts`, `shell-strict-lexer.ts` (leaf lexer), `redirect-measure.ts` (fs half).
- Read-only skip: `src/core/automode/read-only.ts` (pure verdict from command text) and `read-only-gate.ts` (engine glue: realpath, armed git config, opt-out, auto-mode check).
- Allow-rule skip: `src/core/automode/allow-rule-skip.ts` (pure) and `allow-rule-gate.ts` (glue).
- Holds and blocks: `src/core/automode/block-hold.ts` (timer), `blocked-calls.ts` (per-root ledger), `denial-tracker.ts` (caps, deny text, review blocks).
- Outages: `src/core/automode/judge-cooldown.ts` (rate-limit rest per route), `judge-accounts.ts` (account snapshot for the fallback judge).
- Rules and policy: `src/core/automode/rules/corpus.ts` (rule list, categories derive from it), `rules/policy.ts` (prompt assembly), `environment.ts`.
- Not this directory: `src/core/permissions/shell-rules.ts` (matcher for the user's Bash rules), `src/core/pi/permission-engine.ts` (the rule ladder every engine shares, plan-mode oracle), `src/core/shell-security.ts` (URL and scheme guards, no shell parsing).

## Recipes

**A new read-only shell command**

1. `src/core/automode/read-only.ts`: `COMMANDS` plus a typed spec of its flags; pipeline tables (`SAFE_UPSTREAM`, `PIPELINE_START_ONLY`) if it reads paths from a pipe. Exemplar: `wc` or `measure`. [test: read-only.test.ts]. Skipped, the call just goes to the judge.
2. One entry changes three gates: the judge skip (`judge-pipeline.ts` calls `readOnlyGate` in `read-only-gate.ts`), plan mode on pi and plan mode on opencode.
3. Plan mode: `src/core/pi/permission-engine.ts` `isPlanReadOnlyCommand` is the union of pi's `PLAN_SAFE_PATTERNS` list and `readOnlyVerdict`; pi's plan rung, plan base and `src/core/opencode/host-precheck.ts` `planModeRefusesAsk` all call it. The union covers a new program only when a cwd scope is passed. [test: permission-engine.test.ts, host-precheck.test.ts]
4. `src/core/permissions/shell-rules.ts`: `PROGRAM_FAMILIES` when the program has aliases or a cmdlet name (a user deny rule on one member must hit all); `DATA_ARG_PROGRAMS` when its quoted arguments are data. [nothing]. Skipped, a deny rule misses the alias.
5. `src/core/automode/ground-truth.ts`: `INERT_QUOTE_COMMANDS` when a quoted `>` is data, not a redirect. [nothing]. Skipped, the judge sees a phantom redirect target.
6. `src/core/automode/allow-rule-skip.ts`: `READER_PROGRAMS` when its operands are read paths, so `Read(...)` deny rules bind them (write programs go in `WRITE_PROGRAMS`). [nothing]. Skipped, an allow rule skips the judge over a denied path.
7. No test checks that these tables agree; their memberships already differ on purpose. Add a case to each spec that owns a table you touched: `src/core/automode/__tests__/ground-truth.test.ts`, `src/core/permissions/__tests__/shell-rules.test.ts`, `src/core/automode/__tests__/allow-rule-skip.test.ts`.

**Judge eval.** `scripts/judge-eval/` replays `cases.ts` against a live judge: `bun scripts/judge-eval/run.ts` (flags in its header). Its pure specs (`match`, `extract-real`, `replay-scope`, `fs-facts`, `run-route`, `request-guard`) run in the default suite; the live run does not. Run it after any change to `classifier.ts`, `rules/`, `ground-truth.ts` facts or the judge prompt. Real-model runs use entry-level or free models only (ADR-026).

## Invariants

- The judge is unreachable, unusable or its model is gone: the human decides, never an allow. `judge-pipeline.ts` (`unavailableHuman`, `judgeAvailable`); an unparseable verdict blocks (`classifier.ts` `parseVerdict`).
- Stage order: fast path, read-only gate, allow-rule gate, grant, judge availability, ground truth, classify. A grant (the user approved an earlier block of this call) is spent before the availability check: the user's word needs no judge. The `'judge'` input is never awaited before the allow-rule skip. `judge-pipeline.ts`.
- A static allow (read-only or allow-rule) never calls `recordAllow()` and writes no usage row. `read-only-gate.ts`, `allow-rule-gate.ts`.
- `read-only.ts` stays pure (no fs, no env) and refuses on any doubt, including an internal throw; a command must be safe under both the POSIX and the Windows reading. The user's deny and ask rules are checked first (`denyAskHit`).
- `readOnlyBypass` in `~/.claude/ui/automode.json` is read fresh per call; anything but `true` opts out. `read-only-gate.ts`.
- A ground-truth capture that fails contributes nothing, never "clean". `action-meta.ts`, `redirect-measure.ts`.
- Edits to agent-control paths never auto-allow in an edit-accepting base. `agent-control-paths.ts` (`isAgentControlTarget`).
- A rate-limited route rests in memory only; nothing in `judge-cooldown.ts` or `judge-accounts.ts` holds a credential.
- `classifier.ts` and `judge-http/` import no engine, vault or shared-provider code.

## Fast test

- `bunx vitest run src/core/automode --project '!browser'` (the whole directory) or one spec such as `src/core/automode/__tests__/read-only.test.ts`.
- `bunx vitest run src/core/pi/__tests__/permission-engine.test.ts src/core/opencode/__tests__/host-precheck.test.ts -t "plan-mode read-only oracle|reads the union oracle"` for the plan-mode oracle.
- `bunx vitest related --run <source file>` when you do not know a file's specs.
