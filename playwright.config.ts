import { defineConfig } from '@playwright/test'

// Smoke tests drive the built app (`npm run build` first) through Playwright's Electron support.
export default defineConfig({
  testDir: 'tests/smoke',
  timeout: 60_000,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' }
})
