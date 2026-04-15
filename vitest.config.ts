import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const sharedAlias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@test': resolve(__dirname, 'src/test'),
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
            'src/**/__tests__/**/*.unit.test.{ts,tsx}',
          ],
          testTimeout: 5000,
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'component',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/**/__tests__/**/*.component.test.{ts,tsx}'],
          testTimeout: 10000,
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'e2e',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/e2e/**/*.e2e.test.{ts,tsx}'],
          testTimeout: 30000,
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          include: ['src/integration/**/*.integration.test.ts'],
          testTimeout: 60000,
        },
      },
    ],
  },
})
