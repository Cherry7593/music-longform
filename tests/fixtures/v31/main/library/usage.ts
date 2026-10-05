import type { AssetUsage, ExportReceipt, LibraryAsset, LibraryItem, VideoBatch } from '../../../../../src/shared/library-types'
import type { Project } from '../../../../../src/shared/types'
import type { LibraryStore } from '../storage/library'
import type { ExportReceiptStore } from '../storage/export-receipts'
import type { VideoPublication } from '../video/jobs'
import { hashMedia } from '../../../../../src/main/storage/managed'
import { AppError } from '../../../../../src/main/providers/http'
import { activeVideoStatuses } from '../../../../../src/shared/schemas'

/** Derived from immutable successful job/receipt IDs, never from a mutable used boolean. */
export function decorateLibrary(items: LibraryItem[], projects: Project[], batches: VideoBatch[], receipts: ExportReceipt[]): LibraryAsset[] {
  const assets = new Map(items.map(item => [item.id, { ...structuredClone(item), usages: [] as AssetUsage[], queuedCount: 0, historyUncertain: false }]))
  const origins = new Map<string, string>()
  for (const item of items) for (const origin of item.origins) if (origin.type === 'project') origins.set(`${origin.projectId}:${origin.assetId}`, item.id)
  const add = (id: string | undefined, usage: AssetUsage): void => {
    const asset = id ? assets.get(id) : undefined
    if (asset && !asset.usages.some(u => u.id === usage.id)) asset.usages.push(usage)
  }
  const committed = new Set<string>()
  for (const receipt of receipts.filter(r => r.state === 'committed')) {
    committed.add(receipt.id)
    const usage: AssetUsage = { id: receipt.id, ownerId: receipt.ownerId, kind: receipt.kind, name: receipt.name, finishedAt: receipt.finishedAt, durationSeconds: receipt.durationSeconds }
    for (const id of receipt.assetIds) add(id, usage)
  }
  for (const project of projects) for (const job of project.videoJobs.filter(j => j.kind === 'video' && j.status === 'succeeded' && !committed.has(j.id))) {
    const usage: AssetUsage = { id: job.id, ownerId: project.id, kind: 'project', name: `${project.name} / 历史成片`, finishedAt: job.finishedAt ?? job.createdAt, durationSeconds: job.durationSeconds! }
    add(origins.get(`${project.id}:${job.snapshot.imageId}`), usage)
    // Old 'all' snapshots deterministically use every track. Target snapshots did not persist decoded
    // durations: only the first track is certain; do not mislabel unheard tails using provider metadata.
    for (const [i, id] of job.snapshot.audioIds.entries()) {
      const libraryId = origins.get(`${project.id}:${id}`)
      if (job.snapshot.durationMode === 'all' || i === 0) add(libraryId, usage)
      else if (libraryId && assets.has(libraryId)) assets.get(libraryId)!.historyUncertain = true
    }
  }
  for (const batch of batches) for (const job of batch.jobs.filter(j => j.status === 'pending' || activeVideoStatuses.has(j.status))) {
    for (const id of [...job.group.audioIds, job.group.imageId]) { const asset = assets.get(id); if (asset) asset.queuedCount++ }
  }
  for (const asset of assets.values()) asset.usages.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  return [...assets.values()]
}
export function projectPublication(library: LibraryStore, receipts: ExportReceiptStore): VideoPublication {
  return {
    async prepare(project, job, output, fileName) {
      await library.syncProject(project)
      const originalIds = [...output.timeline.tracks.filter(track => track.usedSeconds > 0).map(track => track.id), job.snapshot.imageId!]
      const assetIds: string[] = []
      for (const id of originalIds) {
        const asset = await library.findProjectAsset(project.id, id)
        if (!asset) throw new AppError('素材尚未进入总库，已保留原素材，请刷新素材库后重试导出')
        if (!assetIds.includes(asset.id)) assetIds.push(asset.id)
      }
      await receipts.prepare({ version: 1, id: job.id, ownerId: project.id, kind: 'project', name: `${project.name} / 成片`,
        state: 'prepared', finishedAt: new Date().toISOString(), durationSeconds: output.durationSeconds,
        assetIds, directory: project.directory, fileName, ...await hashMedia(output.filePath) })
    },
    commit: id => receipts.reconcile(id),
    recover: id => receipts.reconcile(id)
  }
}
