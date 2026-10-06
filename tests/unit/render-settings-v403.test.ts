import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { migrateV4, type V4MigrationOptions } from '../../src/main/storage/migration-v4'
import { DEFAULT_BATCH_OPTIONS } from '../../src/shared/batch-schemas'
import { executionBatchSchema, initialComposition, renderSettingsSchema, settingsUpdateSchema, workbenchSettingsSchema } from '../../src/shared/workbench-schemas'
import type { CompositionProject, ExecutionBatch, RenderSettings, WorkbenchSettings } from '../../src/shared/workbench-types'

const render: RenderSettings = { concurrency: 2, threads: 4, encoder: 'auto' }
const timestamp = '2026-05-01T01:02:03.000Z'
let root: string, dataDir: string, mediaRoot: string
let network: MockInstance<typeof globalThis.fetch>
beforeEach(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required; never load a real profile')
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'render-settings-v403-'))
  dataDir = path.join(root, 'isolated-profile'); mediaRoot = path.join(root, 'isolated-media')
  network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in render settings tests'))
})
afterEach(async () => {
  try { expect(network).not.toHaveBeenCalled() }
  finally { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }) }
})
const settings = (): WorkbenchSettings => ({ version: 5, mediaRoot, render: { ...render }, page: 'generation' })
async function save(file: string, value: unknown): Promise<Buffer> {
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(` \r\n${JSON.stringify(value, null, 3)}\r\n`)
  await writeFile(file, bytes); return bytes
}
function execution(projectId: string, staticVideo?: boolean): ExecutionBatch {
  const id = randomUUID(), audioId = randomUUID(), imageId = randomUUID(), planId = randomUUID()
  const group = { imageId, audioIds: [audioId] }
  return { version: 2, id, projectId, planId, name: 'historical execution', createdAt: timestamp, updatedAt: timestamp, state: 'completed',
    plan: { id: planId, createdAt: timestamp,
      request: { ...DEFAULT_BATCH_OPTIONS, minimumSeconds: 60, name: 'historical plan', audioIds: [audioId], imageIds: [imageId] },
      assets: [{ id: audioId, kind: 'audio', name: 'historical audio', sha256: 'a'.repeat(64), bytes: 128, durationSeconds: 60 },
        { id: imageId, kind: 'image', name: 'historical image', sha256: 'b'.repeat(64), bytes: 64 }],
      groups: [{ ...group, durationSeconds: 60, issues: [] }], issues: [] },
    jobs: [{ id: randomUUID(), index: 0, group, status: 'succeeded', queuedAt: timestamp, videoAssetId: randomUUID(), durationSeconds: 60,
      attempts: [{ id: randomUUID(), startedAt: timestamp, finishedAt: timestamp, encoder: 'cpu', ...(staticVideo === undefined ? {} : { staticVideo }) }] }] }
}
const invalidRender = [
  { concurrency: 0 }, { concurrency: 5 }, { concurrency: 1.5 }, { concurrency: NaN },
  { threads: 0 }, { threads: 17 }, { threads: 2.5 }, { threads: NaN }, { threads: '4' },
  { encoder: 'vaapi' }, { encoder: 1 }, { staticVideo: 'true' }, { staticVideo: null },
  { cacheDirectory: 'https://fake.invalid/cache' }, { unfamiliar: true }
]

describe('V4.0.3 strict settings compatibility', () => {
  it('removes staticVideo from public settings and schema output types without bumping version 5', () => {
    expectTypeOf<RenderSettings>().toEqualTypeOf<{ concurrency: number; threads: number; encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv' }>()
    expectTypeOf<ReturnType<typeof renderSettingsSchema.parse>>().toEqualTypeOf<RenderSettings>()
    expect(renderSettingsSchema.parse(render)).toEqual(render)
    expect(workbenchSettingsSchema.parse(settings())).toEqual(settings())
    expect(workbenchSettingsSchema.safeParse({ ...settings(), version: 6 }).success).toBe(false)
  })
  it.each([true, false])('accepts legacy staticVideo=%s only as input and strips it from every settings schema', staticVideo => {
    const legacy = { ...render, staticVideo }
    expect(renderSettingsSchema.parse(legacy)).toEqual(render)
    expect(workbenchSettingsSchema.parse({ ...settings(), render: legacy })).toEqual(settings())
    expect(settingsUpdateSchema.parse({ render: legacy })).toEqual({ render })
    expect(legacy.staticVideo).toBe(staticVideo)
  })
  it.each(invalidRender)('still rejects invalid or unknown render fields %j', patch => {
    const invalid = { ...render, ...patch }
    expect(renderSettingsSchema.safeParse(invalid).success).toBe(false)
    expect(workbenchSettingsSchema.safeParse({ ...settings(), render: invalid }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ render: invalid }).success).toBe(false)
  })
  it('rejects unknown top-level fields instead of stripping them as legacy render settings', () => {
    expect(workbenchSettingsSchema.safeParse({ ...settings(), staticVideo: true }).success).toBe(false)
    expect(workbenchSettingsSchema.safeParse({ ...settings(), unfamiliar: true }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ render, unfamiliar: true }).success).toBe(false)
  })
  it.each([true, false, undefined])('retains historical execution attempts.staticVideo=%s in the strict schema', staticVideo => {
    const historic = execution(randomUUID(), staticVideo)
    expect(executionBatchSchema.parse(historic)).toEqual(historic)
    const attempt = historic.jobs[0].attempts[0]
    const invalid = (patch: object) => ({ ...historic, jobs: [{ ...historic.jobs[0], attempts: [{ ...attempt, ...patch }] }] })
    expect(executionBatchSchema.safeParse(invalid({ staticVideo: 'true' })).success).toBe(false)
    expect(executionBatchSchema.safeParse(invalid({ unfamiliar: true })).success).toBe(false)
  })
})

describe('real WorkbenchDB version-5 disk round trips', () => {
  it.each([true, false])('loads old staticVideo=%s without media/project rewrites, then saves/restarts without the field', async staticVideo => {
    const db = new WorkbenchDB(dataDir), settingsFile = path.join(db.directory, 'settings', 'current.json')
    const project: CompositionProject = { version: 1, id: randomUUID(), name: 'untouched composition', createdAt: timestamp, updatedAt: timestamp,
      revision: 7, draft: initialComposition(), batchIds: [] }
    const historic = execution(project.id, staticVideo); project.batchIds.push(historic.id)
    const projectFile = path.join(db.directory, 'composition', `${project.id}.json`)
    const executionFile = path.join(db.directory, 'executions', `${historic.id}.json`)
    const projectBytes = await save(projectFile, project), executionBytes = await save(executionFile, historic)
    const legacy = { ...settings(), render: { ...render, staticVideo }, lastCompositionId: project.id }
    const oldSettings = await save(settingsFile, legacy)
    await save(path.join(db.directory, 'settings', 'index.json'), { version: 1, ids: ['current'] })
    // Synthetic sentinels only: loading settings must never invoke media migration/decoding.
    await mkdir(mediaRoot, { recursive: true })
    const audio = path.join(mediaRoot, 'original.flac'), image = path.join(mediaRoot, 'original.png')
    await writeFile(audio, Buffer.from([0, 255, 13, 10, 7, 19])); await writeFile(image, Buffer.from([137, 80, 78, 71, 0, 255]))
    const protectedFiles = [audio, image, projectFile, executionFile]
    const snapshots = await Promise.all(protectedFiles.map(async file => ({ file, bytes: await readFile(file), info: await stat(file) })))
    const assertUntouched = async () => {
      for (const snapshot of snapshots) {
        expect(await readFile(snapshot.file)).toEqual(snapshot.bytes)
        const info = await stat(snapshot.file)
        expect([info.size, info.mtimeMs, info.ctimeMs]).toEqual([snapshot.info.size, snapshot.info.mtimeMs, snapshot.info.ctimeMs])
      }
      expect((await readdir(mediaRoot)).sort()).toEqual(['original.flac', 'original.png'])
      await expect(readdir(path.join(dataDir, 'migration-v4'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await db.init()
    const loaded = db.get('settings', 'current')
    expect(loaded).toEqual({ ...settings(), lastCompositionId: project.id })
    expect(loaded.render).not.toHaveProperty('staticVideo')
    expect(await readFile(settingsFile)).toEqual(oldSettings) // No eager rewrite on init/load.
    expect(db.get('composition', project.id)).toEqual(project)
    expect(db.get('executions', historic.id).jobs[0].attempts[0].staticVideo).toBe(staticVideo)
    await assertUntouched()

    const patch = settingsUpdateSchema.parse({ page: 'library', render: { ...render, threads: 6, staticVideo } })
    await db.put('settings', 'current', { ...loaded, ...patch })
    const savedText = await readFile(settingsFile, 'utf8')
    const expected = { ...loaded, page: 'library', render: { ...render, threads: 6 } }
    expect(JSON.parse(savedText)).toEqual(expected)
    expect(savedText).not.toContain('staticVideo')
    const restarted = new WorkbenchDB(dataDir); await restarted.init()
    expect(restarted.get('settings', 'current')).toEqual(expected)
    expect(restarted.get('settings', 'current').version).toBe(5)
    expect(restarted.get('executions', historic.id)).toEqual(historic)
    expect(await readFile(projectFile)).toEqual(projectBytes)
    expect(await readFile(executionFile)).toEqual(executionBytes)
    expect(await readFile(settingsFile, 'utf8')).not.toContain('staticVideo')
    await assertUntouched()
  })
  it('rejects invalid saves before touching the existing settings record', async () => {
    const db = new WorkbenchDB(dataDir); await db.init(); await db.put('settings', 'current', settings())
    const file = path.join(db.directory, 'settings', 'current.json'), original = await readFile(file)
    for (const patch of [{ unfamiliar: true }, { concurrency: 0 }, { threads: 17 }, { encoder: 'vaapi' }]) {
      await expect(db.commit([{ table: 'settings', id: 'current', value: { ...settings(), render: { ...render, ...patch } } }])).rejects.toThrow()
      expect(await readFile(file)).toEqual(original)
      expect(db.get('settings', 'current')).toEqual(settings())
    }
    await expect(readFile(path.join(db.directory, 'transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([{ unfamiliar: true }, { concurrency: 0 }, { threads: 17 }, { encoder: 'vaapi' }, { staticVideo: 'false' }])('refuses invalid on-disk render settings %j without replacing originals', async patch => {
    const db = new WorkbenchDB(dataDir), file = path.join(db.directory, 'settings', 'current.json')
    const original = await save(file, { ...settings(), render: { ...render, ...patch } })
    await expect(db.init()).rejects.toThrow('不可读取')
    expect(await readFile(file)).toEqual(original)
  })
  it('uses field-free migration defaults in both authoritative and compatibility version-5 records', async () => {
    const db = new WorkbenchDB(dataDir); await db.init()
    const assets = {
      registerRoot: vi.fn().mockResolvedValue(randomUUID()), register: vi.fn().mockRejectedValue(new Error('unexpected media registration')),
      alias: vi.fn().mockRejectedValue(new Error('unexpected media alias')), get: vi.fn().mockRejectedValue(new Error('unexpected media read')),
      recordUsage: vi.fn().mockRejectedValue(new Error('unexpected usage rewrite')), allUsage: vi.fn().mockResolvedValue([])
    } satisfies V4MigrationOptions['assets']
    await migrateV4({ dataDir, defaultMediaRoot: mediaRoot, db, assets, secrets: { has: () => false } })
    expect(db.get('settings', 'current')).toEqual(settings())
    for (const file of [path.join(db.directory, 'settings', 'current.json'), path.join(dataDir, 'settings.json')]) {
      const text = await readFile(file, 'utf8')
      expect(JSON.parse(text)).toEqual(settings()); expect(text).not.toContain('staticVideo')
    }
    expect(assets.registerRoot).toHaveBeenCalledWith(mediaRoot, true)
    for (const operation of [assets.register, assets.alias, assets.get, assets.recordUsage]) expect(operation).not.toHaveBeenCalled()
    expect(db.list('generation')).toEqual([]); expect(db.list('composition')).toEqual([])
  })
})
