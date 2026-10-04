import type { CanvasAPI } from '../shared/types'

declare global {
  interface Window { canvas: CanvasAPI }
}
export {}
