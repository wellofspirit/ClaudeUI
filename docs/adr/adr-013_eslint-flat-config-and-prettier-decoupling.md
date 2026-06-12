# ADR-013: ESLint flat-config rework — Prettier decoupling, scoped rules, pragmatic strictness

**Status:** Accepted
**Date:** 2026-06-12

## Context

`bun run lint` was effectively unusable and lint was never wired into CI (only
`.eslintrc.*` appears as a workflow path _trigger_, there is no `eslint` step).
The flat config (`eslint.config.mjs`) had accumulated several problems:

- **It crashed.** `eslint .` OOM'd the V8 heap (~4GB) because the ignore list
  (`node_modules`, `dist`, `out`, `vendor`) omitted `.cache/`, which holds a
  ~13MB minified `cli-check.js`. ESLint flat config does **not** read
  `.gitignore`, so a gitignored-but-not-eslintignored tree is still parsed.
- **~7300 of ~7600 reported problems were `prettier/prettier`.** The config
  pulled `@electron-toolkit/eslint-config-prettier`, which wires
  `eslint-plugin-prettier/recommended` — i.e. it runs Prettier _as an ESLint
  rule_. The repo was never globally Prettier-formatted (436 files), so every
  formatting deviation surfaced as a lint warning. Running Prettier through
  ESLint is slow and noisy; the Prettier project itself recommends against it.
- **React rules were unscoped.** `eslint-plugin-react`,
  `-react-hooks`, and `-react-refresh` applied to **all** `**/*.{ts,tsx}` —
  `src/main`, `src/preload`, `src/shared`, build scripts, and tests included —
  so e.g. `react-refresh/only-export-components` fired in non-React code.
- **`eslint-plugin-react-hooks@7`'s `recommended` config now bundles the
  experimental React Compiler lints** (`purity`, `refs`, `set-state-in-effect`,
  `immutability`, …) as **errors**. This codebase does not target the compiler;
  those rules produced ~40 errors that are advisory at best here.
- **Stylistic rules the codebase never adopted were errors.**
  `@typescript-eslint/explicit-function-return-type` alone flagged 100+ sites.

This is the cleanup pass that [ADR-008](adr-008_typecheck-remote-web-client.md)
deferred ("`bun run lint` already exits non-zero project-wide … Left for a
separate cleanup pass; out of scope here").

## Decision

Rework `eslint.config.mjs` so `eslint .` reports **0 problems** and encodes the
project's actual conventions, fixing genuine violations rather than suppressing
them. Concretely:

1. **Ignore generated/vendored trees explicitly** — add `.cache/**` (the OOM
   culprit), plus `coverage/**`; flat config won't infer these from
   `.gitignore`.
2. **Decouple Prettier from ESLint.** Drop the prettier _plugin_ in favor of
   `eslint-config-prettier` (which only _disables_ ESLint rules that conflict
   with Prettier). Formatting is owned solely by Prettier via `bun run format`
   and a new `bun run format:check`. The repo was reformatted once
   (`prettier --write .`) in its own commit.
3. **Scope React / Hooks / Refresh rules to the renderer and web client** — the
   `src/renderer` and `src/web` trees, via a shared `REACT_FILES` glob. They are
   the only React trees.
4. **Do not adopt `react-hooks@7` `recommended` wholesale.** Enable only the
   stable, high-signal pair — `rules-of-hooks` (error) and `exhaustive-deps`
   (warn) — explicitly, omitting the React Compiler lints.
5. **`react-refresh/only-export-components` → off.** It only affects dev-server
   Fast Refresh (never production), and co-locating small helpers / constants /
   types with the component that uses them is a pattern we keep.
6. **`explicit-function-return-type` → off** (never adopted; TS infers return
   types). **`no-unused-vars`** ignores `_`-prefixed symbols and unused `catch`
   bindings. **`prefer-const`** uses `destructuring: 'all'` (only flag when every
   binding in a pattern can be const, since a mixed tuple can't be split).
7. **Relaxed override for tests / stubs / fixtures / build & patch scripts**
   (`TEST_AND_SCRIPT_FILES` glob): turn off `no-explicit-any`,
   `no-unsafe-function-type`, `no-empty-function`, `no-require-imports`,
   `no-empty`. These are idiomatic in scaffolding code.

Genuine violations in app code were **fixed**, not silenced — most notably a
real `rules-of-hooks` bug in `BashBackgroundEntry`/`TaskEntry` (hooks called
after an early `return null`, so hook order changed between renders), and ten
`exhaustive-deps` issues (memoizing render-derived values that feed hook
dependency lists; adding missing stable store actions).

## Consequences

- `eslint .` is fast and reports **0 problems**. ESLint is now a code-quality
  tool only; formatting is a separate, deterministic Prettier pass.
- Adding `eslint-config-prettier` as a direct dev dependency; removing
  `@electron-toolkit/eslint-config-prettier`.
- The `rules-of-hooks` fix corrects a latent React correctness bug, not just a
  lint nit.

### Trade-offs

- **Lint is still not enforced in CI.** This ADR makes `bun run lint` and
  `bun run format:check` _pass_ cleanly, but neither is yet a CI step. Wiring
  them into `pre-release.yml` / `release.yml` is a deliberate follow-up so that
  turning the gate on is a separate, reviewable change.
- **We forgo the React Compiler lints.** Rules like `set-state-in-effect` and
  `purity` can catch real issues, but enforcing them as errors now would demand
  invasive component refactors and risks false positives in a codebase not built
  for the compiler. They can be opted into later if/when we adopt React Compiler.
- **Relaxing rules for test/script files** means `any`/`Function`/empty bodies
  there are unchecked. Accepted: that scaffolding code trades type-strictness for
  expedience by design, and app code remains strict.

### Relationship to other ADRs

Resolves the lint-debt clean-up explicitly deferred by
[ADR-008](adr-008_typecheck-remote-web-client.md). Does not supersede or
conflict with any prior ADR — it changes lint/format tooling only, no runtime
behavior.
