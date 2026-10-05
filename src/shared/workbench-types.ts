import type { AceStepConfiguration, AceStepSettings, AceStepStatus, MusicBinding, MusicOutput, MusicProviderId } from './music-types'
import type { Provider, VideoToolsStatus } from './types'
import type { BatchPlan, BatchGroupInput, BatchOptions } from './library-types'

export type MediaKind = 'audio' | 'image' | 'video'
export type GenerationKind = Exclude<MediaKind, 'video'>
export type PageId = 'generation' | 'composition' | 'library' | 'settings'
/** Editable, bounded, possibly incomplete. Provider-specific validation happens only at submission. */
export interface EntryDraft {
  provider?: Provider
  model: string
  prompt: string
  title?: string
  lyrics?: string
  mode?: 'song' | 'instrumental'
  inputMode?: 'description' | 'lyrics'
  seconds?: number
  outputFormat?: 'original' | 'mp3'
  thinking?: boolean
  language?: string
  styles?: string[]
  size?: string
}
export interface GenerationProject {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  page: GenerationKind; entryIds: string[]; deletedAt?: string
}
export interface GenerationEntry {
  version: 1; id: string; projectId: string; kind: GenerationKind; createdAt: string; updatedAt: string
  revision: number; draft: EntryDraft; alternatives: Partial<Record<Provider, EntryDraft>>
  requestId?: string; deletedAt?: string
  promptImport?: { batchId: string; fingerprint: string; index: number; total: number }
}
export type GenerationStatus = 'pending' | 'paused' | 'submitting' | 'running' | 'saving' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'abandoned'
export interface RequestBinding {
  provider: Provider | 'openai'; adapterVersion: 1
  local?: MusicBinding['local']
}
export interface GenerationRequest {
  version: 1; id: string; entryId: string; projectId: string; submissionId: string
  createdAt: string; updatedAt: string; kind: GenerationKind; status: GenerationStatus
  snapshot: EntryDraft; binding: RequestBinding; taskId?: string; actualModel?: string
  outputs?: Array<MusicOutput & { libraryAssetId?: string }>; assetIds: string[]; error?: string; detail?: string; recoverable?: boolean; submittedAt?: string
  legacyImage?: boolean; storageRootId?: string
}
export interface GenerationSubmission {
  version: 1; id: string; projectId: string; createdAt: string
  entries: Array<{ id: string; revision: number; requestId: string }>
}
export interface ApiConfiguration {
  version: 1; provider: Provider; kind: GenerationKind; createdAt: string; updatedAt: string
  local?: AceStepSettings; hasKey: boolean
  lastCheck?: { at: string; ok: boolean; message: string }
}
export interface ApiConfigurationInput {
  provider: Provider; key?: string; clearKey?: boolean; local?: AceStepConfiguration
}
export interface CompositionDraft extends BatchOptions { audioIds: string[]; imageIds: string[]; groups?: BatchGroupInput[] }
export interface CompositionProject {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  revision: number; draft: CompositionDraft; batchIds: string[]; deletedAt?: string; migrationNote?: string
}
export interface AssetOrigin {
  type: 'import' | 'generation' | 'composition' | 'legacy'
  name: string; projectId?: string; entryId?: string; requestId?: string; batchId?: string
  legacyAssetId?: string; provider?: string; model?: string; prompt?: string
}
export interface AssetUse {
  id: string; videoId?: string; projectId?: string; name: string; finishedAt: string; durationSeconds: number
  uncertain?: boolean
}
export interface WorkbenchAsset {
  id: string; kind: MediaKind; name: string; createdAt: string; updatedAt: string
  sha256?: string; bytes?: number; format?: string; durationSeconds?: number; width?: number; height?: number
  available: boolean; problem?: string; origins: AssetOrigin[]; usages: AssetUse[]
  usedCount: number; queuedCount: number; historyUncertain: boolean; deletedAt?: string
}
/** Durable usage is independent of project/batch deletion and even a deleted video file. */
export interface UsageRecord {
  version: 2; id: string; videoId?: string; projectId?: string; name: string; finishedAt: string; durationSeconds: number
  assetIds: string[]; uncertainAssetIds: string[]
}
export type RenderStatus = 'pending' | 'blocked' | 'analyzing' | 'processing' | 'mixing' | 'encoding' | 'validating' | 'publishing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface RenderAttempt {
  id: string; startedAt: string; finishedAt?: string; diagnosticId?: string
  stages?: Array<{ stage: string; elapsedMs: number }>; elapsedMs?: number; encoder?: string; staticVideo?: boolean
}
export interface RenderJob {
  id: string; index: number; group: BatchGroupInput; status: RenderStatus
  progress?: number; detail?: string; error?: string; videoAssetId?: string; durationSeconds?: number
  attempts: RenderAttempt[]; startedAt?: string; finishedAt?: string; queuedAt: string
}
export interface ExecutionBatch {
  version: 2; id: string; projectId: string; planId: string; name: string; createdAt: string; updatedAt: string
  state: 'running' | 'pausing' | 'paused' | 'completed' | 'partial' | 'cancelled'
  plan: BatchPlan; jobs: RenderJob[]; message?: string
}
export interface RenderSettings { concurrency: number; encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv'; staticVideo: boolean; threads: number }
export interface WorkbenchSettings {
  version: 5; mediaRoot: string; ffmpegPath?: string; render: RenderSettings
  lastGenerationId?: string; lastCompositionId?: string; page: PageId
}
export interface DiagnosticRecord {
  version: 1; id: string; taskId: string; attemptId: string; createdAt: string
  stage: string; category: string; message: string; suggestion: string
  assetId?: string; assetName?: string; toolVersion?: string; encoder?: string; exitCode?: number | null; osCode?: string; stderr?: string
}
export interface DeletionImpact {
  id: string; name: string; blocked: boolean; reasons: string[]
  references: Array<{ id: string; kind: string; name: string }>
  ownedFiles?: number; externalOriginalsKept: boolean
}
export interface WorkbenchSnapshot {
  settings: WorkbenchSettings; encryptionAvailable: boolean; apis: ApiConfiguration[]
  generationProjects: GenerationProject[]; compositionProjects: CompositionProject[]
  entries: GenerationEntry[]; requests: GenerationRequest[]; batches: ExecutionBatch[]; assets: WorkbenchAsset[]
  warnings: string[]; testMode: boolean
}
export interface GenerationSelection { projectId: string; submissionId: string; entries: Array<{ id: string; revision: number }> }
export interface PromptImportIdentity { projectId: string; kind: GenerationKind; batchId: string }
export interface PromptImportInput extends PromptImportIdentity { drafts: EntryDraft[] }
export interface PromptImportResult extends PromptImportIdentity { status: 'missing' | 'created'; entryIds: string[] }
export interface WorkbenchAPI {
  bootstrap(): Promise<WorkbenchSnapshot>
  createGenerationProject(): Promise<GenerationProject>
  updateGenerationProject(id: string, patch: { name?: string; page?: GenerationKind }): Promise<GenerationProject>
  generationProjectImpact(id: string): Promise<DeletionImpact>
  deleteGenerationProject(id: string): Promise<void>
  addEntry(projectId: string, kind: GenerationKind, copyId?: string): Promise<GenerationEntry>
  createPromptEntries(input: PromptImportInput): Promise<PromptImportResult>
  promptImportStatus(identity: PromptImportIdentity): Promise<PromptImportResult>
  savePromptTemplate(kind: GenerationKind): Promise<string | null>
  updateEntry(id: string, revision: number, draft: EntryDraft, alternatives: GenerationEntry['alternatives']): Promise<GenerationEntry>
  deleteEntry(id: string): Promise<void>
  submitEntries(selection: GenerationSelection): Promise<void>
  stopGeneration(projectId: string): Promise<void>
  resumeRequest(id: string): Promise<void>
  abandonRequest(id: string): Promise<void>
  listApis(): Promise<ApiConfiguration[]>
  saveApi(input: ApiConfigurationInput): Promise<ApiConfiguration[]>
  apiImpact(provider: Provider): Promise<DeletionImpact>
  deleteApi(provider: Provider): Promise<void>
  testApi(input: ApiConfigurationInput): Promise<{ message: string }>
  getAceStepModels(): Promise<AceStepStatus>
  createCompositionProject(): Promise<CompositionProject>
  updateCompositionProject(id: string, revision: number, patch: { name?: string; draft?: CompositionDraft }): Promise<CompositionProject>
  compositionProjectImpact(id: string): Promise<DeletionImpact>
  deleteCompositionProject(id: string): Promise<void>
  planComposition(id: string, revision: number): Promise<BatchPlan>
  reviseCompositionPlan(id: string, planId: string, groups: BatchGroupInput[]): Promise<BatchPlan>
  startComposition(id: string, planId: string): Promise<ExecutionBatch>
  pauseBatch(id: string): Promise<void>
  continueBatch(id: string): Promise<void>
  cancelBatch(id: string): Promise<void>
  cancelRenderJob(batchId: string, jobId: string): Promise<void>
  cancelComposition(id: string): Promise<void>
  getAssets(): Promise<WorkbenchAsset[]>
  refreshAssets(): Promise<WorkbenchAsset[]>
  importAssets(kind: GenerationKind): Promise<{ entries: Array<{ name: string; status: 'imported' | 'duplicate' | 'failed'; assetId?: string; error?: string }>; cancelled: boolean }>
  renameAsset(id: string, name: string): Promise<void>
  assetImpact(id: string): Promise<DeletionImpact>
  deleteAsset(id: string): Promise<void>
  exportAsset(id: string): Promise<string | null>
  revealAsset(id: string): Promise<void>
  updateSettings(patch: Partial<Pick<WorkbenchSettings, 'page' | 'lastGenerationId' | 'lastCompositionId' | 'render'>>): Promise<WorkbenchSettings>
  chooseMediaRoot(): Promise<WorkbenchSettings | null>
  checkVideoTools(): Promise<VideoToolsStatus & { encoders?: Array<{ encoder: string; available: boolean; message: string }> }>
  chooseFFmpeg(): Promise<WorkbenchSettings | null>
  resetFFmpeg(): Promise<WorkbenchSettings>
  getDiagnostics(taskId: string): Promise<DiagnosticRecord[]>
  copyDiagnostic(id: string): Promise<void>
  onChanged(listener: () => void): () => void
}
export const mediaURL = (id: string): string => `canvas-media://library/${encodeURIComponent(id)}`
export const PROVIDER_NAMES: Record<Provider, string> = { mureka: 'Mureka 国际站', 'mureka-cn': 'Mureka 国内站', kie: 'Kie.ai', reapi: 'reAPI', sunor: 'Sunor', acestep: 'ACE-Step 本地', siliconflow: '硅基流动' }
export const GENERATION_ACTIVE: ReadonlySet<GenerationStatus> = new Set(['pending', 'submitting', 'running', 'saving'])
export const GENERATION_PROTECTED: ReadonlySet<GenerationStatus> = new Set(['pending', 'paused', 'submitting', 'running', 'saving', 'unknown', 'failed'])
export const RENDER_ACTIVE: ReadonlySet<RenderStatus> = new Set(['analyzing', 'processing', 'mixing', 'encoding', 'validating', 'publishing'])
export const RENDER_RESERVED: ReadonlySet<RenderStatus> = new Set(['pending', 'blocked', 'analyzing', 'processing', 'mixing', 'encoding', 'validating', 'publishing'])
export type { MusicProviderId }
