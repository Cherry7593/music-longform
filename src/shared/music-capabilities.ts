import type { MusicDraft, MusicProviderId } from './music-types'

export const MUSIC_PROVIDERS = ['mureka', 'mureka-cn', 'kie', 'reapi', 'sunor', 'acestep'] as const
export const MUREKA_ORIGINS = { mureka: 'https://api.mureka.ai', 'mureka-cn': 'https://api.mureka.cn' } as const
export const isMurekaProvider = (provider: unknown): provider is keyof typeof MUREKA_ORIGINS => provider === 'mureka' || provider === 'mureka-cn'
export const MUSIC_PROVIDER_LABELS: Record<MusicProviderId, string> = {
  mureka: 'Mureka 国际站', 'mureka-cn': 'Mureka 国内站', kie: 'Kie.ai', reapi: 'reAPI', sunor: 'Sunor', acestep: 'ACE-Step 本地'
}
export const INSTRUMENTAL_MODELS = ['auto', 'mureka-7.6', 'mureka-8', 'mureka-9', 'mureka-9.5'] as const
export const SONG_MODELS = ['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5'] as const
export const SUNO_MODELS = ['V6', 'V6_MINI', 'V6_WILD'] as const
export const MUSIC_STYLES = ['pop', 'rock', 'jazz', 'r&b', 'edm', 'ambient', 'folk', 'latin', 'k-pop', 'j-pop', 'house', 'gospel', 'lo-fi'] as const
export function defaultMusicDraft(provider: MusicProviderId = 'mureka'): MusicDraft {
  if (isMurekaProvider(provider)) return { provider, prompt: '', mode: 'instrumental', model: 'auto', count: 1, styles: [] }
  return {
    provider, prompt: '', mode: 'instrumental', model: provider === 'acestep' ? 'default' : provider === 'sunor' ? 'v6' : 'V6', count: 1, styles: [],
    title: '', lyrics: '', inputMode: provider === 'kie' || provider === 'acestep' ? 'lyrics' : 'description',
    ...(provider === 'sunor' ? { outputFormat: 'mp3' as const } : { seconds: 180 }),
    ...(provider === 'acestep' ? { thinking: false, language: 'en' } : {})
  }
}
export function musicPromptLimit(draft: MusicDraft): number {
  if (isMurekaProvider(draft.provider)) return draft.mode === 'instrumental' ? 1024 : 2000
  if (draft.provider === 'kie' || (draft.provider === 'reapi' && draft.inputMode === 'lyrics')) return 1000
  return draft.provider === 'acestep' ? 4000 : 3000
}
export function musicModels(draft: MusicDraft): readonly string[] {
  if (isMurekaProvider(draft.provider)) return draft.mode === 'instrumental' ? INSTRUMENTAL_MODELS : SONG_MODELS
  if (draft.provider === 'sunor') return ['v6']
  if (draft.provider === 'acestep') return ['default']
  return SUNO_MODELS
}
export function musicOutputNote(provider: MusicProviderId): string {
  return isMurekaProvider(provider) || provider === 'acestep' ? '每条只创建 1 次请求，申请 1 首；按实际返回全部保存' : '每次可能返回多首，全部保存；数量由平台决定'
}
