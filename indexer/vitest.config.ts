import { defineConfig } from 'vitest/config'

// Standalone package (own package.json + Docker image), so it carries its own vitest config —
// same reason the worker does. Without it, `cd indexer && pnpm test` walks up to the repo-root
// config whose globs do not resolve from here.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
  },
})
