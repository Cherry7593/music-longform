import { z } from 'zod'
import { idSchema, imageDraftSchema, providerKeySchema, providerSchema } from './schemas'
import { aceStepConfigurationSchema, aceStepSettingsSchema, localKeySchema, musicDraftSchema } from './music-schemas'
import { batchGroupInputSchema, batchOptionsSchema, batchPlanSchema, DEFAULT_BATCH_OPTIONS } from './batch-schemas'
import { defaultMusicDraft } from './music-capabilities'
import type { CompositionDraft, EntryDraft, GenerationKind } from './workbench-types'
import type { MusicDraft, Provider } from './types'
const localLibraryPath = (value: string): boolean => /^(?:[A-Za-z]:[\\/]|\/[^/])/.test(value) && !/[\x00-\x1f]/.test(value) && !/^[\\/]{2}/.test(value)

export const nameSchema = z.string().trim().min(1).max(500)
const timestamp = z.iso.datetime()
const ids = (maximum = 20000) => z.array(idSchema).max(maximum).refine(value => value.length === new Set(value).size, '标识重复')
export const entryDraftSchema = z.object({
  provider: providerSchema.optional(), model: z.string().max(200), prompt: z.string().max(32000), title: z.string().max(500).optional(), lyrics: z.string().max(32000).optional(),
  mode: z.enum(['song', 'instrumental']).optional(), inputMode: z.enum(['description', 'lyrics']).optional(), seconds: z.number().finite().min(0).max(100000).optional(),
  outputFormat: z.enum(['original', 'mp3']).optional(), thinking: z.boolean().optional(), language: z.string().max(50).optional(), styles: z.array(z.string().max(50)).max(30).optional(), size: z.string().max(50).optional()
}).strict()
export const alternativesSchema = z.partialRecord(providerSchema, entryDraftSchema)
export const generationProjectSchema = z.object({ version: z.literal(1), id: idSchema, name: nameSchema, createdAt: timestamp, updatedAt: timestamp, page: z.enum(['audio', 'image']), entryIds: ids(), deletedAt: timestamp.optional() }).strict()
export const entrySchema = z.object({ version: z.literal(1), id: idSchema, projectId: idSchema, kind: z.enum(['audio', 'image']), createdAt: timestamp, updatedAt: timestamp,
  revision: z.number().int().nonnegative(), draft: entryDraftSchema, alternatives: alternativesSchema, requestId: idSchema.optional(), deletedAt: timestamp.optional() }).strict()
const output = z.object({ id: idSchema, assetId: idSchema, libraryAssetId: idSchema.optional(), index: z.number().int().min(0).max(19), remoteId: z.string().max(200).optional(), title: z.string().max(500).optional(), locator: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['pending', 'saved']) }).strict()
const binding = z.object({ provider: z.enum(['mureka', 'mureka-cn', 'kie', 'reapi', 'sunor', 'acestep', 'siliconflow', 'openai']), adapterVersion: z.literal(1),
  local: z.object({ baseUrl: z.string().max(500), connectionId: idSchema }).strict().optional() }).strict()
export const requestSchema = z.object({ version: z.literal(1), id: idSchema, entryId: idSchema, projectId: idSchema, submissionId: idSchema,
  createdAt: timestamp, updatedAt: timestamp, kind: z.enum(['audio', 'image']), status: z.enum(['pending', 'paused', 'submitting', 'running', 'saving', 'succeeded', 'failed', 'unknown', 'cancelled', 'abandoned']),
  snapshot: entryDraftSchema, binding, taskId: z.string().max(200).optional(), actualModel: z.string().max(200).optional(), outputs: z.array(output).max(20).optional(), assetIds: ids(20),
  error: z.string().max(4000).optional(), detail: z.string().max(2000).optional(), recoverable: z.boolean().optional(), legacyImage: z.boolean().optional(), storageRootId: idSchema.optional(), submittedAt: timestamp.optional()
}).strict()
export const submissionSchema = z.object({ version: z.literal(1), id: idSchema, projectId: idSchema, createdAt: timestamp,
  entries: z.array(z.object({ id: idSchema, revision: z.number().int().nonnegative(), requestId: idSchema }).strict()).min(1).max(500) }).strict()
export const apiRecordSchema = z.object({ version: z.literal(1), provider: providerSchema, kind: z.enum(['audio', 'image']), createdAt: timestamp, updatedAt: timestamp,
  local: aceStepSettingsSchema.optional(), deletedAt: timestamp.optional(), lastCheck: z.object({ at: timestamp, ok: z.boolean(), message: z.string().max(2000) }).strict().optional()
}).strict().refine(value => (value.provider === 'siliconflow') === (value.kind === 'image') && (value.provider === 'acestep') === Boolean(value.local), 'API用途或连接不匹配')
export const apiInputSchema = z.object({ provider: providerSchema, key: localKeySchema.optional(), clearKey: z.boolean().optional(),
  local: aceStepConfigurationSchema.optional() }).strict().superRefine((value, ctx) => {
    if (value.key === undefined) return
    const key = providerKeySchema(value.provider).safeParse(value.key)
    if (!key.success) ctx.addIssue({ code: 'custom', path: ['key'], message: key.error.issues[0].message })
  })
export const compositionDraftSchema = batchOptionsSchema.extend({ audioIds: ids(10000), imageIds: ids(100), groups: z.array(batchGroupInputSchema).max(100).optional() }).strict()
export const compositionProjectSchema = z.object({ version: z.literal(1), id: idSchema, name: nameSchema, createdAt: timestamp, updatedAt: timestamp,
  revision: z.number().int().nonnegative(), draft: compositionDraftSchema, batchIds: ids(), deletedAt: timestamp.optional(), migrationNote: z.string().max(2000).optional() }).strict()
const attemptSchema = z.object({ id: idSchema, startedAt: timestamp, finishedAt: timestamp.optional(), diagnosticId: idSchema.optional(),
  stages: z.array(z.object({ stage: z.string().max(30), elapsedMs: z.number().nonnegative() }).strict()).max(100).optional(), elapsedMs: z.number().nonnegative().optional(), encoder: z.string().max(100).optional(), staticVideo: z.boolean().optional() }).strict()
const renderJobSchema = z.object({ id: idSchema, index: z.number().int().min(0).max(99), group: batchGroupInputSchema,
  status: z.enum(['pending', 'blocked', 'analyzing', 'processing', 'mixing', 'encoding', 'validating', 'publishing', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  progress: z.number().min(0).max(100).optional(), detail: z.string().max(2000).optional(), error: z.string().max(4000).optional(), videoAssetId: idSchema.optional(), durationSeconds: z.number().positive().max(21601).optional(),
  attempts: z.array(attemptSchema).max(1000), startedAt: timestamp.optional(), finishedAt: timestamp.optional(), queuedAt: timestamp }).strict()
export const executionBatchSchema = z.object({ version: z.literal(2), id: idSchema, projectId: idSchema, planId: idSchema, name: nameSchema, createdAt: timestamp, updatedAt: timestamp,
  state: z.enum(['running', 'pausing', 'paused', 'completed', 'partial', 'cancelled']), plan: batchPlanSchema, jobs: z.array(renderJobSchema).min(1).max(100), message: z.string().max(2000).optional() }).strict()
export const renderSettingsSchema = z.object({ concurrency: z.number().int().min(1).max(4), encoder: z.enum(['auto', 'cpu', 'nvenc', 'qsv']), staticVideo: z.boolean(), threads: z.number().int().min(1).max(16) }).strict()
export const workbenchSettingsSchema = z.object({ version: z.literal(5), mediaRoot: z.string().max(4096).refine(localLibraryPath), ffmpegPath: z.string().max(4096).refine(localLibraryPath).optional(), render: renderSettingsSchema,
  lastGenerationId: idSchema.optional(), lastCompositionId: idSchema.optional(), page: z.enum(['generation', 'composition', 'library', 'settings']) }).strict()
export const settingsUpdateSchema = workbenchSettingsSchema.pick({ page: true, lastGenerationId: true, lastCompositionId: true, render: true }).partial().strict()
export const generationSelectionSchema = z.object({ projectId: idSchema, submissionId: idSchema, entries: z.array(z.object({ id: idSchema, revision: z.number().int().nonnegative() }).strict()).min(1).max(500) }).strict()

export function initialEntry(kind: GenerationKind, provider?: Provider): EntryDraft {
  if (kind === 'image') return { provider: provider === 'siliconflow' ? provider : undefined, model: 'Qwen/Qwen-Image', prompt: '', size: '1664x928' }
  if (!provider || provider === 'siliconflow') return { model: '', prompt: '', mode: 'song', inputMode: 'description' }
  const { count: _count, ...draft } = defaultMusicDraft(provider)
  void _count
  return { ...draft, mode: 'song', ...(provider === 'kie' || provider === 'reapi' ? { seconds: 360 } : provider === 'acestep' ? { seconds: 600 } : {}),
    ...(provider === 'acestep' ? { language: 'zh' } : {}) }
}
export function musicInput(draft: EntryDraft): MusicDraft {
  const { size: _size, ...value } = draft; void _size
  return musicDraftSchema.parse({ ...value, count: 1, styles: value.styles ?? [] })
}
export function imageInput(draft: EntryDraft) {
  if (draft.provider !== 'siliconflow') throw new Error('请选择已添加的硅基流动图片 API')
  return imageDraftSchema.parse({ model: draft.model, prompt: draft.prompt, size: draft.size })
}
export function submissionIssue(kind: GenerationKind, draft: EntryDraft): string | undefined {
  if (!draft.provider) return '请先添加并选择适用的 API'
  if (!draft.prompt.trim()) return kind === 'audio' ? '请填写音乐描述' : '请填写画面描述'
  try { if (kind === 'audio') musicInput(draft); else imageInput(draft) }
  catch (error) { return error instanceof z.ZodError ? error.issues.map(issue => issue.message).slice(0, 3).join('；') : error instanceof Error ? error.message : '生成参数不正确' }
  return undefined
}
export const initialComposition = (): CompositionDraft => ({ ...DEFAULT_BATCH_OPTIONS, audioIds: [], imageIds: [] })
export function shortDate(date = new Date()): string { return `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}` }
export function newProjectName(existing: string[], date = new Date()): string {
  const base = `${shortDate(date)}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
  let name = base, index = 2; while (existing.includes(name)) name = `${base}-${index++}`; return name
}
export function newAssetName(kind: 'audio' | 'image' | 'video', existing: string[], explicit?: string, remote?: string, date = new Date()): string {
  const base = explicit?.trim() || remote?.trim()
  if (base) { let name = base, index = 2; while (existing.includes(name)) name = `${base}-${index++}`; return name }
  const prefix = `${{ audio: '音乐', image: '图片', video: '视频' }[kind]}-${shortDate(date)}-`
  let index = 1; while (existing.includes(prefix + String(index).padStart(2, '0'))) index++; return prefix + String(index).padStart(2, '0')
}
