import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // Optional native add-ons of `ws` (used by @kubernetes/client-node) and of `ssh2`. Both require them
        // inside try/catch and fall back when they're absent; bundling turns that into a throw.
        external: ['bufferutil', 'utf-8-validate', 'cpu-features', /sshcrypto\.node$/]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared }
  }
})
