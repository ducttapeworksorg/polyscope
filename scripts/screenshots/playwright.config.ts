import { defineConfig } from '@playwright/test'

// Renders the screenshots in docs/images from the built app (`npm run build` first): `npm run screenshots`.
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  reporter: 'list'
})
