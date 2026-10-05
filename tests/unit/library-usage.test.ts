import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decorateLibrary } from '../fixtures/v31/main/library/usage'
import type { ExportReceipt, LibraryItem } from '../../src/shared/library-types'
import type { Project, VideoJob } from '../../src/shared/types'
import { DEFAULT_IMAGE, DEFAULT_MUSIC, DEFAULT_VIDEO } from '../../src/shared/schemas'
function fixture() {
  const projectId = randomUUID(); const originalIds = Array.from({ length: 4 }, () => randomUUID()); const time = new Date().toISOString()
  const items: LibraryItem[] = originalIds.map((assetId, i) => ({ id: randomUUID(), kind: i === 3 ? 'image' : 'audio', name: `素材 ${i}`, createdAt: time,
    available: true, origins: [{ type: 'project', name: '历史项目', projectId, assetId }], durationSeconds: i === 3 ? undefined : 100 }))
  const project: Project = { version: 4, id: projectId, name: '历史项目', directory: 'C:\\fixture', createdAt: time, updatedAt: time,
    music: DEFAULT_MUSIC, image: DEFAULT_IMAGE, musicJobs: [], batches: [], imageJobs: [], audio: [], images: [], videoJobs: [], video: DEFAULT_VIDEO }
  const job: VideoJob = { id: randomUUID(), kind: 'video', status: 'succeeded', createdAt: time, finishedAt: time,
    fileName: `videos/${randomUUID()}.mp4`, durationSeconds: 60, snapshot: { ...DEFAULT_VIDEO, audioIds: originalIds.slice(0, 3), imageId: originalIds[3], durationMode: 'target', targetSeconds: 60 } }
  project.videoJobs.push(job)
  return { items, project, job }
}
describe('truthful usage accounting', () => {
  it('does not falsely mark historical unheard tail tracks as used', () => {
    const f = fixture(); const result = decorateLibrary(f.items, [f.project], [], [])
    expect(result.map(a => a.usages.length)).toEqual([1, 0, 0, 1])
    expect(result.map(a => a.historyUncertain)).toEqual([false, true, true, false])
  })
  it('whole-list historical videos use all selected music, previews and failed jobs do not count', () => {
    const f = fixture(); f.job.snapshot.durationMode = 'all'
    expect(decorateLibrary(f.items, [f.project], [], []).map(a => a.usages.length)).toEqual([1, 1, 1, 1])
    f.job.kind = 'preview'
    expect(decorateLibrary(f.items, [f.project], [], []).every(a => !a.usages.length)).toBe(true)
    f.job.kind = 'video'; f.job.status = 'failed'
    expect(decorateLibrary(f.items, [f.project], [], []).every(a => !a.usages.length)).toBe(true)
  })
  it('actual committed receipt overrides estimates and idempotently counts once', () => {
    const f = fixture()
    const receipt: ExportReceipt = { version: 1, id: f.job.id, ownerId: f.project.id, kind: 'project', name: '真实导出', state: 'committed', finishedAt: f.job.finishedAt!, durationSeconds: 60,
      assetIds: [f.items[0].id, f.items[1].id, f.items[3].id], directory: f.project.directory, fileName: `videos/${f.job.id}.mp4`, sha256: 'a'.repeat(64), bytes: 100 }
    const result = decorateLibrary(f.items, [f.project], [], [receipt, receipt])
    expect(result.map(a => a.usages.length)).toEqual([1, 1, 0, 1])
    expect(result.every(a => !a.historyUncertain)).toBe(true)
    expect(result[0].usages[0].name).toBe('真实导出')
    expect(f.items[0]).not.toHaveProperty('usages')
  })
  it('two distinct successful videos increment twice; repeated display or save-as never changes counts', () => {
    const f = fixture(); f.job.snapshot.durationMode = 'all'
    f.project.videoJobs.push({ ...f.job, id: randomUUID() })
    expect(decorateLibrary(f.items, [f.project], [], []).map(a => a.usages.length)).toEqual([2, 2, 2, 2])
    expect(decorateLibrary(f.items, [f.project], [], []).map(a => a.usages.length)).toEqual([2, 2, 2, 2])
  })
})
