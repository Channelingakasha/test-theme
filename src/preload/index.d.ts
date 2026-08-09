import type { PalModApi } from './index'

declare global {
  interface Window {
    palmod: PalModApi
  }
}

export {}
