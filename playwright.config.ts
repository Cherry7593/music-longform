import { defineConfig } from '@playwright/test'
import path from 'node:path'
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: path.join(process.env.PI_SCRATCH_DIR || 'test-results', 'canvas-e2e-results'),
  use: { trace: 'retain-on-failure' }
})
