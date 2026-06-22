import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const sharedAlias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@test': resolve(__dirname, 'src/test'),
  // Redirect better-sqlite3 to a node:sqlite-backed shim so vitest (plain Node)
  // never loads the Electron-ABI native .node binary (ERR_DLOPEN_FAILED).
  'better-sqlite3': resolve(__dirname, 'src/test/stubs/better-sqlite3-stub.ts'),
  // `@opencode-ai/plugin` is provided by the opencode binary at plugin-load time
  // (NOT a ClaudeUI dep). vitest can't resolve it, so alias it to a tiny stub so
  // the hosted-tools plugin module is importable in tests.
  '@opencode-ai/plugin': resolve(__dirname, 'src/test/stubs/opencode-plugin-stub.ts')
}

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    // Global defaults
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup/jsdom.setup.ts'],

    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: [
            'src/**/__tests__/**/*.test.{ts,tsx}',
            'src/**/__tests__/**/*.unit.test.{ts,tsx}'
          ],
          // Git-backed filesystem tests are slow (real simple-git subprocess
          // calls on Windows cost ~150-200ms each). They live in their own
          // `git` project so the default `bun run test` can stay snappy; they
          // still run in CI and on-demand via `bun run test:git` /
          // `bun run test:git:changed`.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.{idea,git,cache,output,temp}/**',
            'src/main/services/__tests__/git-service*.test.ts',
            'src/main/services/__tests__/worktree.test.ts'
          ],
          testTimeout: 5000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'git',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          include: [
            'src/main/services/__tests__/git-service*.test.ts',
            'src/main/services/__tests__/worktree.test.ts'
          ],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'component',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/**/__tests__/**/*.component.test.{ts,tsx}'],
          testTimeout: 10000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'e2e',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/e2e/**/*.e2e.test.{ts,tsx}'],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          include: ['src/integration/**/*.integration.test.ts'],
          testTimeout: 60000
        }
      }
    ]
  }
})
