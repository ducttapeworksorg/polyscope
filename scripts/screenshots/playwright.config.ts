import { defineConfig } from '@playwright/test'

// Renders the screenshots in docs/images: the desktop app's from the built app (`npm run build` first), and those of
// Polyscope for VS Code from its packaged .vsix (`npm run extension:vsix` first). `npm run screenshots`.
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  reporter: 'list'
})
