/** Safe, serializable evidence; never contains command arguments or credential-bearing URLs. */
export type RenderStage = 'tools' | 'probe' | 'audio' | 'mix' | 'encode' | 'validate' | 'publish'
export interface StageTiming { stage: RenderStage; elapsedMs: number }
export interface VideoDiagnostic {
  stage: RenderStage
  category: string
  message: string
  suggestion: string
  assetId?: string
  toolVersion?: string
  encoder?: string
  exitCode?: number
  osCode?: string
  stderr?: string
}
export interface RenderMetrics {
  stages: StageTiming[]
  encoder: string
  /** Historical diagnostic compatibility; new renders always report false. */
  staticVideo: boolean
  elapsedMs: number
  /** Successful CPU/direct fallbacks remain visible, not silently called hardware success. */
  fallbacks?: VideoDiagnostic[]
  audioPath?: 'bounded-direct' | 'prepared-segments'
}
export interface EncoderStatus { encoder: 'cpu' | 'nvenc' | 'qsv'; available: boolean; message: string }
