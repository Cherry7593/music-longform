import { defineConfig } from 'vitest/config'

// Explicit opt-in only; the default config continues to run tests/unit/**/*.test.ts.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false
  }
})
