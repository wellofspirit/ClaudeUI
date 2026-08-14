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

  // No-Electron fence for SyncCore (ADR-051 §Topology, phase 4a item 10).
  //
  // `src/main/sync/**` and `src/shared/sync/**` are the future `src/core`: they
  // must stay runnable in a headless bun process with no Electron at all. The
  // constraint is enforced, not documented — the Electron dependency is exactly
  // the kind of thing that creeps in via one convenient import (a `BrowserWindow`
  // type, `app.getPath`) and is then structural. Delivery and every other
  // host-shaped concern is injected from `src/main/services/sync-host.ts`, which
  // is deliberately OUTSIDE the fence.
  //
  // Type-only imports are blocked too: a `BrowserWindow` in a signature makes
  // core's API Electron-shaped even when nothing is emitted at runtime.
  {
    files: ['src/main/sync/**/*.{ts,tsx}', 'src/shared/sync/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', '@electron/*', '@electron-toolkit/*'],
              message:
                'SyncCore must not import Electron (ADR-051 §Topology). Inject host behaviour from src/main/services/sync-host.ts instead.'
            }
          ]
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
