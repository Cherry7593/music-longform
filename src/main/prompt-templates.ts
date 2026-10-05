import music from '../../docs/templates/音乐提示词模板.md?raw'
import image from '../../docs/templates/图片提示词模板.md?raw'
import type { GenerationKind } from '../shared/workbench-types'

/** Vite embeds these exact UTF-8 source texts in the main bundle; no runtime docs reads. */
export function promptTemplate(kind: GenerationKind): { name: string; text: string } {
  return kind === 'audio' ? { name: '音乐提示词模板.md', text: music } : { name: '图片提示词模板.md', text: image }
}
