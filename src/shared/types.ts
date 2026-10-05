import type { LibraryAPI } from './library-types'
import type { MusicDraft, MusicMode, MusicProviderId, MusicBinding, MusicOutput, AceStepSettings, AceStepConfiguration, AceStepStatus } from './music-types'
export type { MusicDraft, MusicMode, MusicProviderId } from './music-types'
export type Provider = MusicProviderId | 'siliconflow'
export interface ImageDraft {
  prompt: string
  model: string
  size: string
}
/** Historical snapshots are retained verbatim; never sent to the current provider. */
export interface LegacyImageDraft extends ImageDraft {
  quality: 'low' | 'medium' | 'high'
  format: 'png'
}
export type ImageFormat = 'png' | 'jpeg' | 'webp'
export interface SavedImage { fileName: string; width: number; height: number; format: ImageFormat }
export type JobStatus = 'pending' | 'submitting' | 'preparing' | 'queued' | 'running' | 'streaming' | 'downloading' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export interface MusicJob {
  id: string
  batchId: string
  index: number
  createdAt: string
  status: JobStatus
  snapshot: MusicDraft
  binding: MusicBinding
  outputs?: MusicOutput[]
  detail?: string
  taskId?: string
  actualModel?: string
  error?: string
  recoverable?: boolean
}
export interface MusicBatch {
  id: string
  total: number
  createdAt: string
  state: 'running' | 'stopping' | 'paused' | 'completed'
  message?: string
}
interface ImageJobBase {
  id: string
  createdAt: string
  status: 'submitting' | 'downloading' | 'succeeded' | 'failed' | 'unknown'
  error?: string
}
export type ImageJob = ImageJobBase & (
  | { provider: 'openai'; snapshot: LegacyImageDraft }
  | { provider: 'siliconflow'; snapshot: ImageDraft }
)
export interface AudioAsset {
  id: string
  jobId: string
  taskId: string
  remoteId?: string
  provider: MusicProviderId
  resultId?: string
  originalFileName?: string
  originalSha256?: string
  title: string
  fileName: string
  durationMs: number
  createdAt: string
  model: string
  prompt: string
  mode: MusicMode
  kept: boolean
}
export interface ImageAsset {
  id: string
  jobId: string
  fileName: string
  createdAt: string
  model: string
  prompt: string
  size: string
  quality?: string
  provider: 'openai' | 'siliconflow'
  format: ImageFormat
}
export interface Project {
  version: 4
  id: string
  name: string
  directory: string
  createdAt: string
  updatedAt: string
  music: MusicDraft
  image: ImageDraft
  musicJobs: MusicJob[]
  batches: MusicBatch[]
  imageJobs: ImageJob[]
  audio: AudioAsset[]
  images: ImageAsset[]
  selectedImageId?: string
  video: VideoDraft
  videoJobs: VideoJob[]
}
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  audioCount: number
  imageCount: number
}
export interface Settings {
  version: 4
  aceStep: AceStepSettings
  projectRoot: string
  musicDefaults: MusicDraft
  imageDefaults: ImageDraft
  lastProjectId?: string
  ffmpegPath?: string
}
export interface PublicSettings extends Settings {
  keys: Record<Provider, boolean>
  encryptionAvailable: boolean
}
export type ProjectPatch = Partial<Pick<Project, 'name' | 'music' | 'image' | 'video'>>
export type SettingsPatch = Partial<Pick<Settings, 'projectRoot' | 'musicDefaults' | 'imageDefaults' | 'lastProjectId'>>
export interface Bootstrap {
  projects: ProjectSummary[]
  project: Project | null
  settings: PublicSettings
  testMode: boolean
  warnings: string[]
}
export interface CredentialCheck {
  message: string
  balanceCents?: number
}
export interface CanvasAPI extends LibraryAPI {
  bootstrap(): Promise<Bootstrap>
  listProjects(): Promise<ProjectSummary[]>
  createProject(): Promise<Project>
  getProject(id: string): Promise<Project>
  updateProject(id: string, patch: ProjectPatch): Promise<Project>
  getSettings(): Promise<PublicSettings>
  updateSettings(patch: SettingsPatch): Promise<PublicSettings>
  chooseDirectory(): Promise<string | null>
  setKey(provider: Provider, key: string): Promise<PublicSettings>
  clearKey(provider: Provider): Promise<PublicSettings>
  checkKey(provider: Provider): Promise<CredentialCheck>
  configureAceStep(value: AceStepConfiguration): Promise<PublicSettings>
  getAceStepModels(): Promise<AceStepStatus>
  startMusic(projectId: string): Promise<Project>
  stopMusic(projectId: string, batchId: string): Promise<Project>
  continueMusic(projectId: string, batchId: string): Promise<Project>
  retryMusicJob(projectId: string, jobId: string): Promise<Project>
  startImage(projectId: string): Promise<Project>
  keepAudio(projectId: string, assetId: string, kept: boolean): Promise<Project>
  selectImage(projectId: string, assetId: string): Promise<Project>
  openProjectDirectory(projectId: string): Promise<void>
  exportAsset(projectId: string, kind: AssetKind, assetId: string): Promise<string | null>
  revealAsset(projectId: string, kind: AssetKind, assetId: string): Promise<void>
  checkVideoTools(): Promise<VideoToolsStatus>
  chooseFFmpeg(): Promise<PublicSettings | null>
  resetFFmpeg(): Promise<PublicSettings>
  analyzeVideo(projectId: string): Promise<VideoAnalysis>
  startVideo(projectId: string): Promise<Project>
  previewTransition(projectId: string, boundaryIndex: number): Promise<Project>
  cancelVideo(projectId: string, jobId: string): Promise<Project>
  onProjectChanged(listener: (project: Project) => void): () => void
}
export type IPCResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface RemoteChoice { id: string; url: string; duration: number }
export interface RemoteMusicTask {
  id: string
  model?: string
  status: 'preparing' | 'queued' | 'running' | 'streaming' | 'succeeded' | 'failed' | 'timeouted' | 'cancelled'
  failed_reason?: string
  /** Application-authored waiting description, never untrusted provider text. */
  detail?: string
  choices?: RemoteChoice[]
}
export interface ImageResult { url: string; model: string }
export interface MusicProvider {
  create(draft: MusicDraft, key: string): Promise<RemoteMusicTask>
  query(mode: MusicMode, taskId: string, key: string): Promise<RemoteMusicTask>
  check(key: string): Promise<CredentialCheck>
}
export interface ImageProvider {
  generate(draft: ImageDraft, key: string, signal?: AbortSignal): Promise<ImageResult>
  check(key: string): Promise<CredentialCheck>
}
export function assetURL(projectId: string, kind: AssetKind, assetId: string): string {
  return `canvas-media://asset/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(assetId)}`
}
export function summarize(project: Project): ProjectSummary {
  return { id: project.id, name: project.name, updatedAt: project.updatedAt, audioCount: project.audio.length, imageCount: project.images.length }
}

export type AssetKind = 'audio' | 'image' | 'video' | 'preview'
export interface VideoDraft {
  initialized: boolean
  audioIds: string[]
  imageId?: string
  durationMode: 'all' | 'target'
  targetSeconds: number
  transition: 'cut' | 'fade' | 'crossfade'
  transitionSeconds: number
  fadeInSeconds: number
  fadeOutSeconds: number
  normalize: boolean
  fit: 'contain' | 'cover'
}
export type VideoJobStatus = 'analyzing' | 'processing' | 'mixing' | 'encoding' | 'validating' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface VideoJob {
  id: string
  kind: 'video' | 'preview'
  status: VideoJobStatus
  snapshot: VideoDraft
  createdAt: string
  finishedAt?: string
  progress?: number
  detail?: string
  error?: string
  fileName?: string
  durationSeconds?: number
  boundaryIndex?: number
}
export interface VideoToolsStatus {
  available: boolean
  ffmpeg?: string
  ffprobe?: string
  version?: string
  message: string
}
export interface TimelineTrack {
  id: string
  durationSeconds: number
  startSeconds: number
  endSeconds: number
  usedSeconds: number
}
export interface VideoTimeline {
  rawSeconds: number
  overlapSeconds: number
  availableSeconds: number
  outputSeconds: number
  missingSeconds: number
  tracks: TimelineTrack[]
  issues: string[]
}
export interface VideoAnalysis {
  draft: VideoDraft
  timeline: VideoTimeline
  imageWidth?: number
  imageHeight?: number
  tools: VideoToolsStatus
}
