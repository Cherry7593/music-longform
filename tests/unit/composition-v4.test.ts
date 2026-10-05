import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { CompositionProjects } from '../../src/main/storage/workbench-projects'
import { DiagnosticStore } from '../../src/main/storage/diagnostics'
import { PublicationStore } from '../../src/main/storage/publications-v2'
import type { AssetRegistration, AssetStore } from '../../src/main/storage/assets-v2'
import { CompositionQueue } from '../../src/main/video/composition-queue'
import { ResourcePool } from '../../src/main/video/resource-pool'
import { CancelledError } from '../../src/main/video/ffmpeg'
import type { renderMedia, RenderRequest } from '../../src/main/video/pipeline'
import type { ExecutionBatch, UsageRecord, WorkbenchAsset } from '../../src/shared/workbench-types'
import { initialComposition } from '../../src/shared/workbench-schemas'
import { WorkbenchService } from '../../src/main/workbench-service'

vi.mock('../../src/main/video/ffmpeg', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/video/ffmpeg')>(),
  discoverTools: vi.fn(async () => ({ available: true, version: 'isolated unit tool fixture' }))
}))

let root: string, db: WorkbenchDB, projects: CompositionProjects, diagnostics: DiagnosticStore, queue: CompositionQueue
beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v4-composition-unit-'))
  db = new WorkbenchDB(root); await db.init(); projects = new CompositionProjects(db)
  diagnostics = new DiagnosticStore(root); await diagnostics.init()
  await db.put('settings', 'current', { version: 5, mediaRoot: root, page: 'composition', render: { concurrency: 2, threads: 2, encoder: 'cpu', staticVideo: true } })
})
afterEach(async () => { await queue?.shutdown(); await rm(root, { recursive: true, force: true }) })

type RenderResult = Awaited<ReturnType<typeof renderMedia>>
async function fixture(concurrency = 2) {
  const rootId = randomUUID(), values = new Map<string, WorkbenchAsset>(), usages = new Map<string, UsageRecord>(), pins = new Map<string, Set<string>>()
  const stamp = new Date().toISOString()
  function media(kind: 'audio' | 'image', number: number) {
    const id = randomUUID()
    values.set(id, { id, name: `${kind}-${number}`, kind, createdAt: stamp, updatedAt: stamp, sha256: number.toString(16).padStart(64, '0'), bytes: 128,
      ...(kind === 'audio' ? { durationSeconds: 65 } : {}), available: true, origins: [], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false })
    return id
  }
  const audioIds = [1, 2, 3].map(index => media('audio', index)), imageIds = [4, 5, 6].map(index => media('image', index))
  const register = vi.fn(async (input: AssetRegistration) => {
    await readFile(path.join(root, input.fileName))
    const value: WorkbenchAsset = { id: input.id, name: input.name, kind: input.kind, createdAt: input.createdAt, updatedAt: input.createdAt,
      sha256: input.expectedSha256, available: true, origins: [input.origin], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false }
    values.set(input.id, value); return value
  })
  const store = {
    managedRootId: async () => rootId, rootDirectory: async () => root,
    get: async (id: string) => { const value = values.get(id); if (!value) throw new Error('Unknown fixture asset'); return structuredClone(value) },
    all: async () => [...values.values()], register,
    verify: async (id: string) => ({ asset: structuredClone(values.get(id)!), path: path.join(root, id) }),
    pin: (ids: string[], owner: string) => { pins.set(owner, new Set(ids)); return () => { pins.delete(owner) } },
    recordUsage: async (usage: UsageRecord) => { usages.set(usage.id, structuredClone(usage)) },
    isPinned: (id: string) => [...pins.values()].some(ids => ids.has(id)),
    deletionInfo: async () => ({ ownedFiles: 1, externalOriginalsKept: true }), delete: vi.fn(async () => undefined)
  } as unknown as AssetStore
  const publications = new PublicationStore(root, store); await publications.init()
  const pool = new ResourcePool(() => ({ concurrency, threads: 2, encoder: 'cpu', staticVideo: true }), async () => ({ threads: 16, freeMemory: 16 * 1024 ** 3, freeDisk: 80 * 1024 ** 3 }))
  const gates = new Map<string, { request: RenderRequest; finish: () => void; fail: (error: unknown) => void }>()
  const render = vi.fn((request: RenderRequest) => new Promise<RenderResult>((resolve, reject) => {
    const id = path.basename(request.taskDirectory).replace('.work-', '')
    const abort = () => reject(new CancelledError())
    request.signal.addEventListener('abort', abort, { once: true })
    const finish = () => {
      request.signal.removeEventListener('abort', abort)
      // These bytes deliberately are not video: this is execution/publication unit coverage only.
      const filePath = path.join(request.taskDirectory, 'output.mp4')
      void writeFile(filePath, Buffer.from(`synthetic-unit-output-${id}`)).then(() => resolve({ filePath, durationSeconds: 65,
        timeline: { outputSeconds: 65, targetSeconds: 65, sourceSeconds: 65, missingSeconds: 0, tracks: [], issues: [] },
        metrics: { encoder: 'unit-fixture', staticVideo: false, elapsedMs: 1, stages: [] } } as unknown as RenderResult), reject)
    }
    gates.set(id, { request, finish, fail: error => { request.signal.removeEventListener('abort', abort); reject(error) } })
    request.onStage?.('encode'); request.onProgress?.({ status: 'encoding', progress: 0.2, detail: 'unit controlled render' })
  }))
  const errors: string[] = []
  queue = new CompositionQueue({ db, assets: store, diagnostics, publications, pool, render, tools: async () => ({ ffmpeg: 'fixture.exe', ffprobe: 'fixture-probe.exe' }), onError: error => errors.push(error) })
  async function start(count = 1): Promise<ExecutionBatch> {
    let project = await projects.create()
    project = await projects.update(project.id, project.revision, { draft: { ...initialComposition(), minimumSeconds: 60, audioIds: audioIds.slice(0, count), imageIds: imageIds.slice(0, count) } })
    const plan = await queue.plan(project.id, project.revision)
    expect(plan.issues).toEqual([])
    return queue.start(project.id, plan.id)
  }
  const entered = async (id: string) => { await vi.waitFor(() => expect(gates.has(id)).toBe(true), { timeout: 5000 }); return gates.get(id)! }
  return { start, entered, pool, publications, register, values, usages, pins, gates, render, errors, audioIds, imageIds, store }
}

describe('V4 composition execution, publication and recovery', () => {
  it('shares the global pool across projects, freezes snapshots, and cancels just one task', async () => {
    const f = await fixture(), a = await f.start(), b = await f.start()
    const left = await f.entered(a.jobs[0].id), right = await f.entered(b.jobs[0].id)
    expect(f.pool.running).toBe(2)
    const project = projects.get(a.projectId)
    await projects.update(project.id, project.revision, { draft: { ...project.draft, fit: 'cover' } })
    expect(db.get('executions', a.id).plan.request.fit).toBe('contain')
    await expect(projects.delete(a.projectId)).rejects.toThrow('任务')
    await queue.cancelJob(a.id, a.jobs[0].id)
    expect(left.request.signal.aborted).toBe(true); expect(right.request.signal.aborted).toBe(false)
    right.finish(); await queue.idle()
    expect(db.get('executions', a.id).jobs[0].status).toBe('cancelled')
    expect(db.get('executions', b.id).state).toBe('completed')
    expect(f.usages.size).toBe(1); expect(f.pins.size).toBe(0); expect(f.errors).toEqual([])
  })

  it('isolates ordinary failures, retains redacted diagnostic history, and retries only unfinished jobs', async () => {
    const f = await fixture(), batch = await f.start(2), [first, second] = batch.jobs
    const left = await f.entered(first.id), right = await f.entered(second.id)
    left.fail(Object.assign(new Error('fixture fault'), { diagnostic: { stage: 'encode', encoder: 'unit-fixture', exitCode: 27, stderr: 'Authorization: Bearer never-persist-this\nhttps://fixture.invalid/?key=secret\ninvalid isolated frame' } }))
    right.finish(); await queue.idle()
    let saved = db.get('executions', batch.id)
    expect(saved.jobs.map(job => job.status)).toEqual(['failed', 'succeeded'])
    const record = diagnostics.list(first.id)[0]
    expect(record).toMatchObject({ stage: 'encode', category: 'unknown', encoder: 'unit-fixture', exitCode: 27 })
    expect(JSON.stringify(record)).not.toMatch(/never-persist-this|fixture.invalid|key=secret/)
    expect(f.usages.size).toBe(1)
    f.gates.delete(first.id); await queue.continue(batch.id)
    const retry = await f.entered(first.id); retry.fail(Object.assign(new Error('second isolated failure'), { code: 'EACCES' })); await queue.idle()
    expect(diagnostics.list(first.id)).toHaveLength(2)
    expect(diagnostics.list(first.id).some(item => item.osCode === 'EACCES')).toBe(true)
    f.gates.delete(first.id); await queue.continue(batch.id); (await f.entered(first.id)).finish(); await queue.idle()
    saved = db.get('executions', batch.id)
    expect(saved.state).toBe('completed'); expect(saved.jobs[0].attempts).toHaveLength(3); expect(saved.jobs[1].attempts).toHaveLength(1)
    expect(f.render).toHaveBeenCalledTimes(4); expect(f.usages.size).toBe(2)
    const reopened = new DiagnosticStore(root); await reopened.init(); expect(reopened.list(first.id)).toHaveLength(2)
    await queue.continue(batch.id); await queue.idle(); expect(f.render).toHaveBeenCalledTimes(4)
    expect(f.errors).toEqual([])
  })

  it('pauses waiting work on a shared disk failure without automatically retrying', async () => {
    const f = await fixture(1), batch = await f.start(3)
    const active = await f.entered(batch.jobs[0].id)
    await vi.waitFor(() => expect(f.pool.queued).toBe(2))
    active.fail(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }))
    await queue.idle()
    const saved = db.get('executions', batch.id)
    expect(saved.state).toBe('paused'); expect(saved.message).toContain('暂停')
    expect(saved.jobs.map(job => job.status)).toEqual(['failed', 'pending', 'pending'])
    expect(f.render).toHaveBeenCalledTimes(1); expect(f.usages.size).toBe(0)
    expect(diagnostics.list(batch.jobs[0].id)[0]).toMatchObject({ category: 'disk-space', osCode: 'ENOSPC' })
  })

  it('batch cancellation signals all active tasks before waiting and never affects another project', async () => {
    const f = await fixture(3), batch = await f.start(2), other = await f.start()
    const a = await f.entered(batch.jobs[0].id), b = await f.entered(batch.jobs[1].id), c = await f.entered(other.jobs[0].id)
    await queue.cancel(batch.id)
    expect(a.request.signal.aborted).toBe(true); expect(b.request.signal.aborted).toBe(true); expect(c.request.signal.aborted).toBe(false)
    c.finish(); await queue.idle()
    expect(db.get('executions', batch.id).state).toBe('cancelled')
    expect(db.get('executions', batch.id).jobs.every(job => job.status === 'cancelled')).toBe(true)
    expect(db.get('executions', other.id).state).toBe('completed'); expect(f.usages.size).toBe(1)
  })

  it('shutdown and restart pause unfinished work without replaying successful publications', async () => {
    const f = await fixture(1), batch = await f.start(2)
    await f.entered(batch.jobs[0].id); await queue.shutdown()
    expect(db.get('executions', batch.id).jobs.map(job => job.status)).toEqual(['interrupted', 'pending'])
    await queue.recover()
    expect(db.get('executions', batch.id).state).toBe('paused')
    expect(f.render).toHaveBeenCalledTimes(1); expect(f.pins.size).toBe(0)
  })

  it('reconciles a published file after registration failure without rendering or counting usage twice', async () => {
    const f = await fixture(), batch = await f.start(), job = batch.jobs[0]
    f.register.mockRejectedValueOnce(Object.assign(new Error('registration fixture denial'), { code: 'EACCES' }))
    ;(await f.entered(job.id)).finish(); await queue.idle()
    expect(db.get('executions', batch.id).jobs[0].status).toBe('interrupted')
    expect(f.publications.get(job.id)?.state).toBe('prepared'); expect(f.usages.size).toBe(0)
    await queue.recover(); await queue.recover()
    expect(db.get('executions', batch.id).jobs[0].status).toBe('succeeded')
    expect(f.publications.get(job.id)?.state).toBe('committed'); expect(f.render).toHaveBeenCalledTimes(1); expect(f.usages.size).toBe(1)
    expect(diagnostics.list(job.id)).toHaveLength(1); expect(f.errors).toEqual([])
  })
  it('protects a deduplicated published video while usage reconciliation is incomplete', async () => {
    const f = await fixture(), batch = await f.start(), job = batch.jobs[0], canonicalId = randomUUID()
    const register = f.register.getMockImplementation()!
    f.register.mockImplementation(async input => { const asset = await register({ ...input, id: canonicalId }); f.values.set(input.id, asset); return asset })
    vi.spyOn(f.store, 'recordUsage').mockRejectedValueOnce(Object.assign(new Error('usage fixture denial'), { code: 'EACCES' }))
    ;(await f.entered(job.id)).finish(); await queue.idle()
    expect(db.get('executions', batch.id).jobs[0].status).toBe('interrupted')
    expect(f.publications.get(job.id)?.state).toBe('prepared'); expect(f.values.get(job.id)?.id).toBe(canonicalId)
    const service = new WorkbenchService({ dataDir: root, db, assets: f.store, secrets: {}, registry: {}, images: {}, testMode: true } as unknown as ConstructorParameters<typeof WorkbenchService>[0])
    await service.publications.init()
    try {
      expect((await service.assetImpact(canonicalId)).blocked).toBe(true)
      await expect(service.deleteAsset(job.id)).rejects.toThrow('对账')
      expect(f.store.delete).not.toHaveBeenCalled()
      await queue.recover(); await service.publications.init()
      expect((await service.assetImpact(canonicalId)).blocked).toBe(false)
      expect(f.publications.get(job.id)?.state).toBe('committed'); expect(f.render).toHaveBeenCalledTimes(1); expect(f.usages.size).toBe(1)
    } finally { await service.shutdown() }
  })
})
