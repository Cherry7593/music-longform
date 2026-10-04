import type { VideoDraft, VideoJobStatus } from './types'

export type LibraryKind = 'audio' | 'image'
export interface LibraryOrigin {
  type: 'import' | 'project'
  name: string
  projectId?: string
  assetId?: string
  provider?: string
  model?: string
  prompt?: string
}
/** Disk-backed metadata only; paths are resolved by the main process using registered IDs. */
export interface LibraryItem {
  id: string
  kind: LibraryKind
  name: string
  createdAt: string
  sha256?: string
  bytes?: number
  format?: string
  durationSeconds?: number
  width?: number
  height?: number
  available: boolean
  problem?: string
  origins: LibraryOrigin[]
}
export interface AssetUsage {
  id: string
  ownerId: string
  kind: 'batch' | 'project'
  name: string
  finishedAt: string
  durationSeconds: number
}
export interface LibraryAsset extends LibraryItem {
  usages: AssetUsage[]
  queuedCount: number
  historyUncertain: boolean
}
export interface LibraryConfig { version: 1; root: string; generationProjectId?: string }
export interface LibrarySnapshot { assets: LibraryAsset[]; config: LibraryConfig; warnings: string[] }
export interface ImportEntry { name: string; status: 'imported' | 'duplicate' | 'failed'; assetId?: string; error?: string }
export interface ImportResult { entries: ImportEntry[]; cancelled: boolean }
export interface BatchOptions {
  minimumSeconds: number
  transition: VideoDraft['transition']
  transitionSeconds: number
  fadeInSeconds: number
  fadeOutSeconds: number
  normalize: boolean
  fit: VideoDraft['fit']
}
export interface BatchRequest extends BatchOptions { name: string; audioIds: string[]; imageIds: string[] }
export interface BatchGroupInput { imageId: string; audioIds: string[] }
export interface BatchGroup extends BatchGroupInput { durationSeconds: number; issues: string[] }
export interface BatchAssetSnapshot {
  id: string
  kind: LibraryKind
  name: string
  sha256: string
  bytes: number
  durationSeconds?: number
}
export interface BatchPlan {
  id: string
  createdAt: string
  request: BatchRequest
  assets: BatchAssetSnapshot[]
  groups: BatchGroup[]
  issues: string[]
  reason?: 'invalid' | 'insufficient' | 'search-exhausted'
}
export type BatchJobStatus = VideoJobStatus | 'pending'
export interface BatchVideoJob {
  id: string
  index: number
  group: BatchGroup
  status: BatchJobStatus
  progress?: number
  detail?: string
  error?: string
  finishedAt?: string
  fileName?: string
  durationSeconds?: number
}
export interface VideoBatch {
  version: 1
  id: string
  planId: string
  name: string
  createdAt: string
  updatedAt: string
  directory: string
  state: 'running' | 'pausing' | 'paused' | 'completed' | 'cancelled'
  plan: BatchPlan
  jobs: BatchVideoJob[]
  message?: string
}
export interface ExportReceipt {
  version: 1
  id: string
  ownerId: string
  kind: 'batch' | 'project'
  name: string
  state: 'prepared' | 'committed'
  finishedAt: string
  durationSeconds: number
  assetIds: string[]
  directory: string
  fileName: string
  sha256: string
  bytes: number
}
export interface LibraryAPI {
  getLibrary(): Promise<LibrarySnapshot>
  refreshLibrary(): Promise<LibrarySnapshot>
  importLibrary(kind: LibraryKind): Promise<ImportResult>
  chooseLibraryRoot(): Promise<LibraryConfig | null>
  exportLibraryAsset(id: string): Promise<string | null>
  revealLibraryAsset(id: string): Promise<void>
  getGenerationProject(): Promise<import('./types').Project>
  planBatch(request: BatchRequest): Promise<BatchPlan>
  reviseBatchPlan(planId: string, groups: BatchGroupInput[]): Promise<BatchPlan>
  startBatch(planId: string): Promise<VideoBatch>
  listVideoBatches(): Promise<VideoBatch[]>
  pauseVideoBatch(id: string): Promise<VideoBatch>
  continueVideoBatch(id: string): Promise<VideoBatch>
  cancelVideoBatch(id: string): Promise<VideoBatch>
  exportBatchVideo(batchId: string, jobId: string): Promise<string | null>
  revealBatchVideo(batchId: string, jobId?: string): Promise<void>
  onLibraryChanged(listener: () => void): () => void
  onVideoBatchChanged(listener: (batch: VideoBatch) => void): () => void
}
export function libraryAssetURL(id: string): string { return `canvas-media://library/${encodeURIComponent(id)}` }
export function batchVideoURL(batchId: string, jobId: string): string { return `canvas-media://batch/${encodeURIComponent(batchId)}/${encodeURIComponent(jobId)}` }
