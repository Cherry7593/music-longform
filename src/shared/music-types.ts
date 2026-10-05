export type MusicProviderId = 'mureka' | 'mureka-cn' | 'kie' | 'reapi' | 'sunor' | 'acestep'
export type MusicMode = 'instrumental' | 'song'
export interface LegacyMusicDraft {
  prompt: string
  mode: MusicMode
  model: string
  count: number
  styles: string[]
}
export interface MusicDraft extends LegacyMusicDraft {
  provider: MusicProviderId
  title?: string
  lyrics?: string
  inputMode?: 'description' | 'lyrics'
  seconds?: number
  outputFormat?: 'original' | 'mp3'
  thinking?: boolean
  language?: string
}
export interface AceStepSettings {
  baseUrl: string
  connectionId: string
  waitMinutes: number
  allowLan: boolean
}
export type AceStepConfiguration = Omit<AceStepSettings, 'connectionId'>
export interface AceStepModel { name: string; isDefault: boolean; isLoaded?: boolean; supportedTaskTypes?: string[] }
export interface AceStepStatus {
  message: string
  baseUrl: string
  modelsInitialized?: boolean
  models: AceStepModel[]
  defaultModel?: string
  llmInitialized: boolean
  loadedLmModel?: string
}
/** No keys are persisted in task snapshots. Local credentials are bound separately to connectionId. */
export interface MusicBinding {
  provider: MusicProviderId
  adapterVersion: 1
  local?: Pick<AceStepSettings, 'baseUrl' | 'connectionId'>
}
export interface MusicConnection { key?: string; baseUrl?: string; signal?: AbortSignal }
export interface ProviderMusicChoice { remoteId?: string; url: string; durationMs?: number; title?: string }
export interface ProviderMusicTask {
  id: string
  model?: string
  status: 'preparing' | 'queued' | 'running' | 'streaming' | 'succeeded' | 'failed' | 'timeouted' | 'cancelled'
  choices?: ProviderMusicChoice[]
  detail?: string
}
export interface MusicAdapter {
  create(draft: MusicDraft, connection: MusicConnection): Promise<ProviderMusicTask>
  query(draft: MusicDraft, taskId: string, connection: MusicConnection): Promise<ProviderMusicTask>
  check(connection: MusicConnection): Promise<{ message: string; balanceCents?: number }>
  preflight?(draft: MusicDraft, connection: MusicConnection): Promise<void>
}
export interface MusicOutput {
  id: string
  assetId: string
  index: number
  remoteId?: string
  /** Hash of a stable media locator, never a signed URL or credential. */
  locator: string
  title?: string
  status: 'pending' | 'saved'
}
export interface GeneratedAudioResult {
  fileName: string
  durationMs: number
  originalFileName?: string
  originalSha256?: string
}
