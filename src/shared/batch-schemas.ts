import { z } from 'zod'
import { idSchema } from './schemas'
import type { BatchOptions } from './library-types'

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  minimumSeconds: 3600, transition: 'crossfade', transitionSeconds: 3,
  fadeInSeconds: 2, fadeOutSeconds: 2, normalize: false, fit: 'contain'
}
const uniqueIds = (max: number) => z.array(idSchema).min(1).max(max).refine(ids => new Set(ids).size === ids.length, '素材不能重复选择')
export const batchOptionsSchema = z.object({
  minimumSeconds: z.number().finite().min(60).max(21600),
  transition: z.enum(['cut', 'fade', 'crossfade']), transitionSeconds: z.number().finite().min(0.5).max(10),
  fadeInSeconds: z.number().finite().min(0).max(10), fadeOutSeconds: z.number().finite().min(0).max(10),
  normalize: z.boolean(), fit: z.enum(['contain', 'cover'])
}).strict()
export const batchRequestSchema = batchOptionsSchema.extend({ name: z.string().trim().min(1).max(80), audioIds: uniqueIds(10000), imageIds: uniqueIds(100) }).strict()
export const batchGroupInputSchema = z.object({ imageId: idSchema, audioIds: z.array(idSchema).max(10000) }).strict()
export const batchGroupSchema = batchGroupInputSchema.extend({ durationSeconds: z.number().finite().nonnegative(), issues: z.array(z.string().max(2000)).max(10010) }).strict()
export const batchAssetSchema = z.object({
  id: idSchema, kind: z.enum(['audio', 'image']), name: z.string().max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  bytes: z.number().int().positive().max(1073741824), durationSeconds: z.number().finite().positive().max(21600).optional()
}).strict()
export const batchPlanSchema = z.object({
  id: idSchema, createdAt: z.iso.datetime(), request: batchRequestSchema, assets: z.array(batchAssetSchema).max(10100),
  groups: z.array(batchGroupSchema).max(100), issues: z.array(z.string().max(2000)).max(20000),
  reason: z.enum(['invalid', 'insufficient', 'search-exhausted']).optional()
}).strict()
export const batchJobSchema = z.object({
  id: idSchema, index: z.number().int().min(0).max(99), group: batchGroupSchema,
  status: z.enum(['pending', 'analyzing', 'processing', 'mixing', 'encoding', 'validating', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  progress: z.number().finite().min(0).max(100).optional(), detail: z.string().max(2000).optional(), error: z.string().max(2000).optional(),
  finishedAt: z.iso.datetime().optional(), fileName: z.string().max(200).optional(), durationSeconds: z.number().finite().positive().max(21600.1).optional()
}).strict().superRefine((job, ctx) => {
  if (job.fileName && job.fileName !== `videos/${job.id}.mp4`) ctx.addIssue({ code: 'custom', message: '成片路径不正确' })
  if (job.status === 'succeeded' && (!job.fileName || !job.durationSeconds)) ctx.addIssue({ code: 'custom', message: '成功记录缺少成片' })
})
export const videoBatchSchema = z.object({
  version: z.literal(1), id: idSchema, planId: idSchema, name: z.string().min(1).max(80), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  directory: z.string().min(1).max(2000), state: z.enum(['running', 'pausing', 'paused', 'completed', 'cancelled']),
  plan: batchPlanSchema, jobs: z.array(batchJobSchema).min(1).max(100), message: z.string().max(2000).optional()
}).strict().superRefine((batch, ctx) => {
  if (batch.planId !== batch.plan.id || batch.jobs.length !== batch.plan.groups.length || new Set(batch.jobs.map(j => j.id)).size !== batch.jobs.length
    || batch.jobs.some((job, i) => job.index !== i || JSON.stringify(job.group) !== JSON.stringify(batch.plan.groups[i]))) {
    ctx.addIssue({ code: 'custom', message: '批次快照或任务顺序不正确' })
  }
})
