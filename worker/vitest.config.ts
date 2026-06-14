import { defineConfig } from 'vitest/config'

// The worker is a standalone package (own package.json + Docker image), so it
// carries its own vitest config. Without this, `cd worker && pnpm test` walks up
// and picks the repo-root config, whose `worker/test/**` glob does not resolve
// from inside this directory — vitest then finds zero tests and exits 1.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
  },
})
