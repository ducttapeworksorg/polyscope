import type { PolyscopeBridge } from './bridge'

declare global {
  interface Window {
    polyscope: PolyscopeBridge
  }
}
