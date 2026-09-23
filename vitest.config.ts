import { defineConfig } from 'vitest/config'

/**
 * Two projects, one per environment: the host/domain suite keeps the fast node
 * environment, and every `.tsx` browser test runs under jsdom. The split is
 * expressed as projects rather than `environmentMatchGlobs`, which Vitest 3
 * deprecates and which would print a warning on every run.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          environment: 'jsdom',
          include: ['tests/**/*.spec.tsx'],
        },
      },
    ],
  },
})
