import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// React-aware globs. The React/Hooks/Refresh rule sets are only meaningful for
// the renderer and the remote web client — the main process, preload, shared
// types, build scripts, and tests are not React trees, so applying these rules
// there only produces false positives (e.g. react-refresh/only-export-components).
const REACT_FILES = ['src/renderer/**/*.{ts,tsx}', 'src/web/**/*.{ts,tsx}']

// Tests, stubs, fixtures, and build/patch scripts. These legitimately use
// patterns that are anti-patterns in app code: `any`/`Function` scaffolding,
// empty stub methods, `require()` for mock wiring, ignored catch bindings.
const TEST_AND_SCRIPT_FILES = [
  '**/__tests__/**',
  '**/*.{test,spec}.{ts,tsx}',
  'src/test/**',
  'src/e2e/**',
  'src/integration/**',
  'scripts/**',
  'patch/**',
  '**/*.config.{ts,mts,cts,js,mjs,cjs}'
]

export default defineConfig(
  {
    // Generated / vendored / non-source trees. ESLint flat config does NOT
    // read .gitignore, so these must be listed explicitly. `.cache` holds a
    // ~13MB minified cli-check.js that OOMs the parser if scanned.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      'vendor/**',
      '.cache/**',
      // Agent worktrees (full repo copies) live under .claude/worktrees — four
      // of them once made a repo-wide lint OOM at the default heap size.
      '.claude/**',
      'coverage/**'
    ]
  },

  tseslint.configs.recommended,

  // Code-quality rule tuning (all TS/JS source).
  {
    files: ['**/*.{ts,tsx,mts,cts,mjs,cjs,js}'],
    rules: {
      // Never adopted as a convention in this codebase (100+ violations) and
      // the TS compiler already infers return types. Leaving it on is pure
      // noise; explicit boundaries are documented where they matter.
      '@typescript-eslint/explicit-function-return-type': 'off',
      // Allow intentionally-unused symbols via a leading underscore, and don't
      // flag unused catch bindings (`catch (err) {}` is a common, harmless
      // pattern). Genuinely-unused values still error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // Only flag a destructuring pattern when EVERY binding could be const —
      // a mixed tuple (some reassigned, some not) can't be split into const/let.
      'prefer-const': ['error', { destructuring: 'all' }]
    }
  },

  // React + Hooks + Fast-Refresh — renderer and web client only.
  { ...eslintPluginReact.configs.flat.recommended, files: REACT_FILES },
  { ...eslintPluginReact.configs.flat['jsx-runtime'], files: REACT_FILES },
  {
    files: REACT_FILES,
    settings: {
      react: {
        version: 'detect'
      }
    },
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      // The stable, high-signal hooks rules. We intentionally do NOT enable the
      // react-hooks@7 "recommended" set wholesale: it bundles the experimental
      // React Compiler lints (purity / refs / set-state-in-effect / immutability
      // …) as errors, and this codebase does not target the compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Off by choice: this only affects dev-server Fast Refresh (a violation
      // makes that module do a full reload), never production. Co-locating small
      // helpers/constants/types with the component that uses them is a pattern
      // we keep, so the rule is pure noise here.
      'react-refresh/only-export-components': 'off'
    }
  },

  // No-Electron fence for `src/core` (ADR-051 decision 5 "Headless-first",
  // realized by ADR-058; physical extraction landed in the S2 series).
  //
  // `src/core` is the window-independent service graph — SyncCore, the engine
  // adapters, the PTY manager, the HTTP/WS server and the services they need. It
  // must stay runnable in a headless bun process with no Electron at all, so a
  // second entrypoint (`claudeui-server`) can boot it. The constraint is
  // enforced, not documented — the Electron dependency is exactly the kind of
  // thing that creeps in via one convenient import (a `BrowserWindow` type,
  // `app.getPath`) and is then structural. Every host-shaped concern is injected
  // through the seven neutral adapters in `src/core/host.ts` (window handle, app
  // paths, the packaged-build flag, the native folder picker, native
  // notifications, data-only account-state reads, mockup serving), whose desktop
  // implementations are wired from `src/main` (`index.ts`, `boot-core.ts`) and
  // whose headless answers are wired — or deliberately left unset — from
  // `src/server/main.ts`.
  //
  // Type-only imports are blocked too: a `BrowserWindow` in a signature makes
  // core's API Electron-shaped even when nothing is emitted at runtime.
  {
    files: ['src/core/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', '@electron/*', '@electron-toolkit/*'],
              message:
                'src/core must not import Electron (ADR-058). Inject host behaviour through src/core/host.ts instead.'
            }
          ]
        }
      ]
    }
  },

  // Sealed-field brand for the renderer replica (SyncCore phase 4c, ADR-051
  // §"Clients never compute state").
  //
  // A SEALED field is one the replica fold owns: its only writer is
  // `renderer/src/stores/replica.ts`, projecting `applyEvent`'s output. The list
  // below is the snapshot-carried state — per-session `PerSessionSnapshot` fields
  // plus the app-level `FullStateSnapshot` ones, plus the two derived mirrors the
  // projection also owns (`worktreeInfo`, `thinkingStartedAt`). Its prose twin,
  // with the reason each `canonical: false` channel is deliberately NOT here, is
  // `renderer/src/stores/sealed-fields.ts`; `sealed-fields.unit.test.ts` pins this
  // pattern against that module so the two cannot drift.
  //
  // Why a syntax rule and not a type: the failure mode is re-introducing a store
  // ACTION that writes the field, and TypeScript cannot see "inside a Zustand
  // set()". Three selectors, matching the three shapes every deleted action had:
  //
  //   1. `updateSession(sessions, id, () => ({ <sealed>: … }))` — the store's only
  //      per-session updater, and what ~30 of the deleted actions used;
  //   2. `sessions: { …, [id]: { <sealed>: … } }` — the hand-rolled form the rest
  //      used (addMessage, appendToolResult, loadHistoricalSession, …);
  //   3. any `set(…)` / `setState(…)` naming an APP-LEVEL sealed field.
  //
  // Per-session names are gated on (1)/(2) rather than on a bare `set(` because
  // several of them (`status`, `settings`, `streamingText`) are ordinary words that
  // also name unrelated fields — `AuthFlowState.status`, the automation store's own
  // run buffers. A rule that fired on those would be turned off within a week.
  //
  // Scope note: `replica.ts` is the sanctioned writer; `sealed-fields.ts` names the
  // fields; tests legitimately construct whole `PerSessionState` fixtures.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/web/**/*.{ts,tsx}'],
    ignores: [
      'src/renderer/src/stores/replica.ts',
      'src/renderer/src/stores/sealed-fields.ts',
      '**/__tests__/**',
      '**/*.{test,spec}.{ts,tsx}'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='updateSession'] Property[key.name=/^(cwd|messages|streamingText|streamingThinking|status|pendingApprovals|todos|sentFiles|queuedItems|taskNotifications|activeTasks|taskProgressMap|subagentMessages|subagentStreamingText|subagentStreamingThinking|permissionMode|effort|thinkingMode|reasoningVariant|statusLine|metering|sdkActive|selectedEngineId|selectedModel|worktreeInfo|thinkingStartedAt)$/]",
          message:
            'This per-session field is SEALED (SyncCore phase 4c): the replica fold is its ' +
            'only writer. Route the change through stores/replica.ts — the reducer branch for ' +
            'its channel, or a sanctioned local write (patchLocalSession / seedColdSession). ' +
            'See stores/sealed-fields.ts.'
        },
        {
          selector:
            "Property[key.name='sessions'] Property[key.name=/^(cwd|messages|streamingText|streamingThinking|status|pendingApprovals|todos|sentFiles|queuedItems|taskNotifications|activeTasks|taskProgressMap|subagentMessages|subagentStreamingText|subagentStreamingThinking|permissionMode|effort|thinkingMode|reasoningVariant|statusLine|metering|sdkActive|selectedEngineId|selectedModel|worktreeInfo|thinkingStartedAt)$/]",
          message:
            'This per-session field is SEALED (SyncCore phase 4c): the replica fold is its ' +
            'only writer. Route the change through stores/replica.ts — the reducer branch for ' +
            'its channel, or a sanctioned local write (patchLocalSession / seedColdSession). ' +
            'See stores/sealed-fields.ts.'
        },
        {
          selector:
            "CallExpression[callee.name=/^(set|setState)$/] Property[key.name=/^(directories|settings|autoModeDisabledBySettings|recentSessionIds|pinnedSessionIds|customTitles|worktreeInfoMap|sessionEngines|hiddenSessionIds|hiddenProjectKeys|slashCommands|sdkSkillNames)$/]",
          message:
            'This app-level field is SEALED (SyncCore phase 4c): the replica fold is its only ' +
            'writer. Route the change through stores/replica.ts (patchLocalApp / seedLocalApp). ' +
            'See stores/sealed-fields.ts.'
        }
      ]
    }
  },

  // Relaxed rules for tests, stubs, fixtures, and build/patch scripts.
  {
    files: TEST_AND_SCRIPT_FILES,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': 'off'
    }
  },

  // Must come last: turns OFF every ESLint rule that conflicts with Prettier.
  // Formatting is owned by Prettier (`bun run format` / `bun run format:check`),
  // not by ESLint — running Prettier as an ESLint rule is slow and noisy.
  eslintConfigPrettier
)
