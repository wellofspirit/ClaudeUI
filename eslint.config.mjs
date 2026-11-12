import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintReact from '@eslint-react/eslint-plugin'
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

// The sealed per-session store fields (see the sealed-field block below): the member names of
// `CanonicalSessionState`, read from its declaration, minus the two with no store field, with
// `queue` under its store name, plus the derived `worktreeInfo`. This config cannot import
// TypeScript, so those three exceptions are restated here; `sealed-fields.unit.test.ts` pins them
// against `sealed-fields.ts`. An interface that is missing or empty throws: an empty alternation
// would switch the seal off without a sound.
function sealedSessionFieldNames() {
  // Beside this config, so that ESLint run from a subdirectory finds it too. A test runner
  // that loads this module under another URL scheme runs from the repository root.
  const root = import.meta.url.startsWith('file:')
    ? path.dirname(fileURLToPath(import.meta.url))
    : process.cwd()
  const file = path.join(root, 'src/core/shared/sync/state.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const declaration = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'CanonicalSessionState'
  )
  const members = declaration
    ? declaration.members
        .filter(ts.isPropertySignature)
        .map((member) => member.name.getText(source))
    : []
  if (members.length === 0) {
    throw new Error(
      `eslint.config.mjs: no members found for interface CanonicalSessionState in ${file}; ` +
        'the sealed per-session lint selectors would match nothing'
    )
  }
  const withoutStoreField = new Set(['routingId', 'seeded'])
  return [
    ...members
      .filter((name) => !withoutStoreField.has(name))
      .map((n) => (n === 'queue' ? 'queuedItems' : n)),
    'worktreeInfo'
  ]
}
const SEALED_SESSION_FIELD_NAMES = sealedSessionFieldNames()
const SEALED_SESSION_KEY_SELECTOR = `Property[key.name=/^(${SEALED_SESSION_FIELD_NAMES.join('|')})$/]`
const SEALED_SESSION_MESSAGE =
  'This per-session field is SEALED (SyncCore phase 4c): the replica fold is its ' +
  'only writer. Route the change through stores/replica.ts — the reducer branch for ' +
  'its channel, or a sanctioned local write (patchLocalSession / seedColdSession). ' +
  'See stores/sealed-fields.ts.'

// THE ZOOM TRAP (ADR-093). SessionView renders the whole app under CSS
// `zoom: uiFontScale`, and inside that subtree every vw/vh/dvh/svh/lvh length is
// multiplied by the zoom: a `max-h-[85vh]` dialog is 106% of a 1280x640 window at
// 1.25, and its header and footer land off-screen. Flags a number followed by a
// viewport unit, and Tailwind's (min-|max-)(h|w)-(screen|dvh|svh|lvh), in any
// string or template. Matched by selector regex, so the `Literal`s inside JSX
// className attributes and style objects are covered alike.
const ZOOM_TRAP_RE = String.raw`/\d(vw|vh|dvh|svh|lvh)\b|(^|[\s:])(min-|max-)?(h|w)-(screen|dvh|svh|lvh)\b/`
const ZOOM_TRAP = (selector) => ({
  selector,
  message:
    'THE ZOOM TRAP (ADR-093): inside SessionView `zoom: uiFontScale` multiplies every ' +
    'vw/vh/dvh/svh/lvh length, so this box is scaled past the window. Size against a ' +
    'zoomed box (%), or divide by uiFontScale. See shared/use-anchored-menu.ts. If this ' +
    'site is outside the zoomed root, already divides by uiFontScale, or is not mounted, ' +
    'say so: `// eslint-disable-next-line no-restricted-syntax -- <why>`.'
})

// LAYER ZONES. `no-restricted-imports` matches specifier STRINGS, which cannot say
// "outside this directory" for a nested file (`../../main/x` and `../../../main/x`
// are different strings for the same target). This local plugin resolves every
// import to a repo-relative path and checks the zone table passed as the rule's
// OPTIONS (below), so editing the table changes the config hash and invalidates
// the `--cache` lint cache.
//
// Inspected: `import … from`, `export … from`, `export * from`, `import('lit')` and
// the inline type form `import('lit').T`. Type-only imports count (as in the
// Electron fence below). Resolution touches no file system: a relative specifier is joined onto the importer's directory,
// `@renderer/x` is `src/renderer/src/x`, `@test/x` is `src/test/x`; packages are
// ignored. Test files are exempt as importers.
//
// Zone fields (all paths repo-relative, segment-aware prefixes):
//   from          importer prefixes the zone applies to
//   to / except   imported prefixes forbidden / still allowed
//   toPattern     regex source, an extra forbidden target (test code)
//   why           the instruction shown in the message
//
// The rule's logic is NOT part of the config hash, only `meta.version` is: BUMP IT
// whenever the rule body below changes, or a stale cache keeps the old verdict.
const TEST_IMPORTER_RE =
  /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|^src\/(test|e2e|integration)\//
const ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@test/', 'src/test/']
]
const underPrefix = (p, prefix) => p === prefix || p.startsWith(prefix + '/')

const layerZonesRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          zones: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'why'],
              properties: {
                from: { type: 'array', items: { type: 'string' } },
                to: { type: 'array', items: { type: 'string' } },
                except: { type: 'array', items: { type: 'string' } },
                toPattern: { type: 'string' },
                why: { type: 'string' }
              }
            }
          },
          allow: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }
          }
        }
      }
    ],
    messages: {
      zone: '{{importer}} must not import {{target}}. {{why}}'
    }
  },
  create(context) {
    const { zones = [], allow = [] } = context.options[0] ?? {}
    const importer = path.relative(context.cwd, context.filename).split(path.sep).join('/')
    if (importer.startsWith('..') || TEST_IMPORTER_RE.test(importer)) return {}
    const inZones = zones
      .filter((z) => z.from.some((p) => underPrefix(importer, p)))
      .map((z) => ({ ...z, toRe: z.toPattern === undefined ? null : new RegExp(z.toPattern) }))
    if (inZones.length === 0) return {}
    const check = (node, spec) => {
      let target
      const alias = ALIASES.find(([a]) => spec.startsWith(a))
      if (alias) target = alias[1] + spec.slice(alias[0].length)
      else if (spec.startsWith('.')) target = path.posix.join(path.posix.dirname(importer), spec)
      else return
      target = target.replace(/\/$/, '')
      const bare = target.replace(/\.[cm]?[jt]sx?$/, '')
      if (allow.some(([f, m]) => f === importer && m === bare)) return
      for (const z of inZones) {
        const hit =
          ((z.to ?? []).some((p) => underPrefix(target, p)) || z.toRe?.test(target)) &&
          !(z.except ?? []).some((p) => underPrefix(target, p))
        if (hit) context.report({ node, messageId: 'zone', data: { importer, target, why: z.why } })
      }
    }
    const source = (node) => {
      if (node.source && typeof node.source.value === 'string') check(node, node.source.value)
    }
    return {
      ImportDeclaration: source,
      ExportNamedDeclaration: source,
      ExportAllDeclaration: source,
      ImportExpression: source,
      // `import('x').T` in a type position. The specifier sits in `source` or in
      // `argument.literal`, depending on the parser's major version.
      TSImportType(node) {
        const spec = node.source?.value ?? node.argument?.literal?.value
        if (typeof spec === 'string') check(node, spec)
      }
    }
  }
}
const layerPlugin = {
  meta: { name: 'claudeui-layers', version: '1' },
  rules: { zones: layerZonesRule }
}

// A resolved import usually has no extension: `./x.test` must match as `./x.test.ts` does.
const TEST_CODE_RE = '(^|/)__tests__(/|$)|\\.(test|spec)(\\.[cm]?[jt]sx?)?$'
const PI_OPENCODE_WHY =
  'The pi and opencode adapters must not import each other. Move the shared code into src/core/shared or a neutral module.'
const LAYER_ZONES = [
  {
    from: ['src/core'],
    to: ['src/main', 'src/renderer', 'src/web', 'src/preload', 'src/server'],
    why: 'src/core is the window-independent service graph (ADR-051/058): it sits below every host and UI layer. Inject host behaviour through src/core/host.ts, or move the shared type into src/core/shared or src/shared.'
  },
  {
    from: ['src/renderer', 'src/web'],
    to: ['src/core'],
    except: ['src/core/shared'],
    why: 'The renderer and the web client may import only src/core/shared from core. Move what you need into src/core/shared or src/shared, or reach it over IPC / the wire.'
  },
  {
    from: ['src/renderer', 'src/web'],
    to: ['src/main', 'src/preload', 'src/server'],
    why: 'The renderer and the web client must not import a host process. Share types through src/shared and talk over IPC / the wire.'
  },
  {
    from: ['src/shared'],
    to: ['src/core'],
    except: ['src/core/shared'],
    why: 'src/shared is imported by every layer and may depend only on src/core/shared from core. Move the code into src/core/shared or src/shared.'
  },
  {
    from: ['src/server'],
    to: ['src/main', 'src/renderer', 'src/web', 'src/preload'],
    why: 'The headless server (claudeui-server) runs without Electron or a UI. Use src/core, or move shared code into src/shared or src/core/shared.'
  },
  {
    from: ['src/preload'],
    to: ['src/core', 'src/main', 'src/renderer'],
    except: ['src/core/shared'],
    why: 'The preload bridge may import only src/core/shared from core, and nothing from main or the renderer. Share types through src/shared or src/core/shared.'
  },
  {
    from: ['src'],
    to: ['src/test', 'src/e2e', 'src/integration'],
    toPattern: TEST_CODE_RE,
    why: 'Production code must not import test code. Move the helper into production code, or inject it from the test.'
  },
  {
    from: ['src/core/shared'],
    to: ['src/core'],
    except: ['src/core/shared'],
    why: 'src/core/shared sits below the rest of core. Move the dependency into src/core/shared (or inject it) instead of importing upward.'
  },
  { from: ['src/core/pi'], to: ['src/core/opencode'], why: PI_OPENCODE_WHY },
  { from: ['src/core/opencode'], to: ['src/core/pi'], why: PI_OPENCODE_WHY }
]
// Existing violations of the last three zones, as [importing file, imported module
// without extension]. A later arc moves the shared modules to a neutral home; this
// list must only shrink, never grow.
const LAYER_ALLOW = [
  ['src/core/shared/tool-review.ts', 'src/core/pi/permission-engine'],
  ['src/core/pi/PiSession.ts', 'src/core/opencode/permission-compiler'],
  ['src/core/pi/PiSession.ts', 'src/core/opencode/bash-stream-gate'],
  ['src/core/pi/permission-engine.ts', 'src/core/opencode/permission-compiler'],
  ['src/core/pi/pi-json-raw.ts', 'src/core/opencode/opencode-jsonc-io'],
  ['src/core/pi/pi-native-raw.ts', 'src/core/opencode/opencode-jsonc-io'],
  ['src/core/opencode/OpencodeSession.ts', 'src/core/pi/permission-engine'],
  ['src/core/opencode/host-precheck.ts', 'src/core/pi/permission-engine']
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
      // Local working files, not repo sources (see .gitignore).
      '.work/**',
      '.notes/**',
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
  //
  // `@eslint-react/eslint-plugin` replaced `eslint-plugin-react`, which has no
  // ESLint 10 support. Its `recommended-typescript` preset is deliberately NOT
  // spread: it bundles the React Compiler lints that ADR-013 §4 keeps off and
  // would break the 0-problems baseline. Only the rules that replace the old
  // plugin's recommended set are enabled, at its severity (error), with the
  // preset's `settings` (react-x version detect).
  {
    files: REACT_FILES,
    plugins: {
      '@eslint-react': eslintReact,
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    settings: eslintReact.configs['recommended-typescript'].settings,
    rules: {
      // The stable, high-signal hooks rules. We intentionally do NOT enable the
      // react-hooks@7 "recommended" set wholesale: it bundles the experimental
      // React Compiler lints (purity / refs / set-state-in-effect / immutability
      // …) as errors, and this codebase does not target the compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Parity with `eslint-plugin-react`'s recommended preset. `jsx-key` →
      // `no-missing-key`, `display-name` → `no-missing-component-display-name`,
      // `jsx-no-comment-textnodes` → `jsx-no-comment-textnodes`,
      // `no-children-prop` → the `jsx-no-children-prop` pair,
      // `no-danger-with-children` → `dom-no-dangerously-set-innerhtml-with-children`,
      // `no-direct-mutation-state` → `no-direct-mutation-state`,
      // `no-find-dom-node` → `dom-no-find-dom-node`,
      // `no-render-return-value` → `dom-no-render-return-value`,
      // `no-unknown-property` → `dom-no-unknown-property`,
      // `jsx-no-target-blank` → `dom-no-unsafe-target-blank`, and
      // `no-deprecated` is superseded by the specific rules below. No
      // replacement needed: `prop-types`, `jsx-no-duplicate-props`,
      // `jsx-no-undef`, `jsx-uses-vars`, `no-string-refs`, `no-is-mounted` and
      // `require-render-return` (TypeScript rejects or covers each);
      // `no-unescaped-entities` is dropped (typography only).
      '@eslint-react/no-missing-key': 'error',
      '@eslint-react/no-missing-component-display-name': 'error',
      '@eslint-react/jsx-no-comment-textnodes': 'error',
      '@eslint-react/jsx-no-children-prop': 'error',
      '@eslint-react/jsx-no-children-prop-with-children': 'error',
      '@eslint-react/dom-no-dangerously-set-innerhtml-with-children': 'error',
      '@eslint-react/no-direct-mutation-state': 'error',
      '@eslint-react/dom-no-find-dom-node': 'error',
      '@eslint-react/dom-no-render-return-value': 'error',
      '@eslint-react/dom-no-unknown-property': 'error',
      '@eslint-react/dom-no-unsafe-target-blank': 'error',
      // `react/no-deprecated` replacements: the individual APIs React removed.
      '@eslint-react/dom-no-render': 'error',
      '@eslint-react/dom-no-hydrate': 'error',
      '@eslint-react/no-component-will-mount': 'error',
      '@eslint-react/no-component-will-receive-props': 'error',
      '@eslint-react/no-component-will-update': 'error',
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Off by choice: this only affects dev-server Fast Refresh (a violation
      // makes that module do a full reload), never production. Co-locating small
      // helpers/constants/types with the component that uses them is a pattern
      // we keep, so the rule is pure noise here.
      'react-refresh/only-export-components': 'off'
    }
  },

  // AudioWorklet global scope. `voice-worklet.js` is not a window script: it runs
  // in its own global scope, where these three names are provided by the host.
  // `globals` v17 (via @electron-toolkit/eslint-config-ts 4) no longer folds the
  // AudioWorklet globals into `globals.browser`, so declare the ones the file
  // uses (`globals.audioWorklet` in full) instead of reporting them as undefined.
  {
    files: ['src/renderer/src/lib/voice/voice-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly'
      }
    }
  },

  // No-Electron fence for `src/core` and `src/server` (ADR-051 decision 5 "Headless-first",
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
    files: ['src/core/**/*.{ts,tsx}', 'src/server/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', '@electron/*', '@electron-toolkit/*'],
              message:
                'src/core and src/server must not import Electron (ADR-058). Inject host behaviour through src/core/host.ts instead.'
            }
          ]
        }
      ]
    }
  },

  // Layer zones (LAYER_ZONES above). Its own block: the rule options are the zone
  // table, and tests are exempted inside the rule itself.
  {
    files: ['src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    plugins: { layer: layerPlugin },
    rules: { 'layer/zones': ['error', { zones: LAYER_ZONES, allow: LAYER_ALLOW }] }
  },

  // Sealed-field brand for the renderer replica (SyncCore phase 4c, ADR-051
  // §"Clients never compute state").
  //
  // A SEALED field is one the replica fold owns: its only writer is
  // `renderer/src/stores/replica.ts`, projecting `applyEvent`'s output. The lists
  // below are the snapshot-carried state — per-session `CanonicalSessionState` fields (read from
  // its declaration by `sealedSessionFieldNames`)
  // plus the app-level `FullStateSnapshot` ones, plus the derived mirror the
  // projection also owns (`worktreeInfo`). Its prose twin,
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
  // several of them (`status`, `messages`, `selectedModel`) are ordinary words that
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
          selector: `CallExpression[callee.name='updateSession'] ${SEALED_SESSION_KEY_SELECTOR}`,
          message: SEALED_SESSION_MESSAGE
        },
        {
          selector: `Property[key.name='sessions'] ${SEALED_SESSION_KEY_SELECTOR}`,
          message: SEALED_SESSION_MESSAGE
        },
        {
          selector:
            'CallExpression[callee.name=/^(set|setState)$/] Property[key.name=/^(directories|settings|autoModeDisabledBySettings|recentSessionIds|pinnedSessionIds|customTitles|worktreeInfoMap|sessionEngines|sessionLinks|sessionRefs|hiddenSessionIds|hiddenProjectKeys)$/]',
          message:
            'This app-level field is SEALED (SyncCore phase 4c): the replica fold is its only ' +
            'writer. Route the change through stores/replica.ts (patchLocalApp / seedLocalApp). ' +
            'See stores/sealed-fields.ts.'
        },
        // THE ZOOM TRAP (ADR-093). Appended to THIS array on purpose: a second
        // `no-restricted-syntax` config object for the same files would REPLACE the
        // sealed-field selectors above, not add to them.
        ZOOM_TRAP('Literal[value=' + ZOOM_TRAP_RE + ']'),
        ZOOM_TRAP('TemplateElement[value.raw=' + ZOOM_TRAP_RE + ']')
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
