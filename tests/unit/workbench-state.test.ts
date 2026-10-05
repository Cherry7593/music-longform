import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { GenerationProjects, CompositionProjects } from '../../src/main/storage/workbench-projects'
import { ApiConfigurations } from '../../src/main/storage/api-configurations'
import { SecretStore } from '../../src/main/storage/secrets'
import { MusicRegistry } from '../../src/main/providers/music-registry'
import { initialEntry, initialComposition, newAssetName, submissionIssue } from '../../src/shared/workbench-schemas'
import { DiagnosticStore, redactDiagnostic } from '../../src/main/storage/diagnostics'
import type { GenerationRequest } from '../../src/shared/workbench-types'

let root: string, db: WorkbenchDB, gen: GenerationProjects, comp: CompositionProjects
beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v4-state-')); db = new WorkbenchDB(root); await db.init()
  gen = new GenerationProjects(db); comp = new CompositionProjects(db)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const encryption = { isEncryptionAvailable: () => true, encryptString: (key: string) => Buffer.from(Buffer.from(key).map(byte => byte ^ 0x73)), decryptString: (bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 0x73)).toString() }
function request(projectId: string, entryId: string): GenerationRequest {
  const time = new Date().toISOString()
  return { version: 1, id: randomUUID(), entryId, projectId, submissionId: randomUUID(), createdAt: time, updatedAt: time, kind: 'audio', status: 'pending',
    snapshot: { ...initialEntry('audio', 'mureka'), prompt: 'fixture' }, binding: { provider: 'mureka', adapterVersion: 1 }, assetIds: [] }
}

describe('V4 independent workspaces and durable transactions', () => {
  it('creates clean independent project types and retains incomplete A/B drafts after restart', async () => {
    const a = await gen.create(), b = await gen.create(), c = await comp.create()
    expect(a.id).not.toBe(b.id); expect(c.id).not.toBe(a.id)
    expect(a.entryIds).toEqual([]); expect(c.draft.audioIds).toEqual([])
    let ea = await gen.add(a.id, 'audio'), eb = await gen.add(b.id, 'image')
    ea = await gen.updateEntry(ea.id, ea.revision, { ...ea.draft, prompt: 'A 描述', lyrics: '草稿歌词', model: '' }, {})
    eb = await gen.updateEntry(eb.id, eb.revision, { ...eb.draft, prompt: 'B 画面', size: '' }, {})
    await gen.update(a.id, { name: 'A 命名' }); expect(comp.get(c.id).name).toBe(c.name)
    const reopened = new WorkbenchDB(root); await reopened.init()
    expect(reopened.get('entries', ea.id).draft.prompt).toBe('A 描述')
    expect(reopened.get('entries', eb.id).draft.prompt).toBe('B 画面')
    expect(reopened.get('generation', b.id).entryIds).toEqual([eb.id])
    expect(reopened.get('composition', c.id).draft).toEqual(initialComposition())
  })
  it('rejects stale revisions, edits of submitted entries, foreign copies and protected deletion', async () => {
    const a = await gen.create(), b = await gen.create(), entry = await gen.add(a.id, 'audio')
    await gen.updateEntry(entry.id, 0, { ...entry.draft, prompt: 'new' }, {})
    await expect(gen.updateEntry(entry.id, 0, entry.draft, {})).rejects.toThrow('更新')
    await expect(gen.add(b.id, 'audio', entry.id)).rejects.toThrow('其他项目')
    const job = request(a.id, entry.id)
    await db.commit([{ table: 'requests', id: job.id, value: job }, { table: 'entries', id: entry.id, value: { ...db.get('entries', entry.id), requestId: job.id } }])
    expect(gen.impact(a.id).blocked).toBe(true)
    await expect(gen.delete(a.id)).rejects.toThrow('请求')
    await expect(gen.updateEntry(entry.id, 1, entry.draft, {})).rejects.toThrow('提交')
    const copy = await gen.add(a.id, 'audio', entry.id); expect(copy.requestId).toBeUndefined(); expect(copy.draft.prompt).toBe('new')
    await db.update('requests', job.id, row => { row.status = 'succeeded' })
    await gen.delete(a.id)
    expect(db.get('requests', job.id).status).toBe('succeeded')
    expect(db.get('generation', a.id).deletedAt).toBeTruthy()
    expect(gen.get(b.id).deletedAt).toBeUndefined()
  })
  it('recovers a durable multi-record intent before publishing its indexes', async () => {
    const project = await gen.create(), next = { ...project, name: '恢复后名称' }
    await writeFile(path.join(db.directory, 'transaction.json'), JSON.stringify({ version: 1, id: randomUUID(), changes: [{ table: 'generation', id: project.id, value: next }] }))
    const reopened = new WorkbenchDB(root); await reopened.init()
    expect(reopened.get('generation', project.id).name).toBe('恢复后名称')
    await expect(readFile(path.join(db.directory, 'transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not replace corrupt metadata with an empty project list', async () => {
    await gen.create(); const file = path.join(db.directory, 'generation', 'index.json')
    await writeFile(file, '{broken')
    await expect(new WorkbenchDB(root).init()).rejects.toThrow('索引损坏')
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
  it('removes request counts from current drafts and uses concise names without truncating old names', () => {
    expect(initialEntry('audio', 'reapi')).not.toHaveProperty('count')
    expect(initialEntry('audio', 'reapi')).toMatchObject({ mode: 'song', inputMode: 'description', seconds: 360 })
    expect(submissionIssue('audio', { ...initialEntry('audio', 'kie'), prompt: 'style' })).toContain('歌词')
    expect(newAssetName('audio', [], '用户命名', '远端名称')).toBe('用户命名')
    expect(newAssetName('audio', ['用户命名'], '用户命名')).toBe('用户命名-2')
    expect(newAssetName('video', [], undefined, undefined, new Date(2026, 9, 5))).toBe('视频-1005-01')
  })
})

describe('explicit API configuration independent from key presence', () => {
  async function setup() {
    const secrets = new SecretStore(root, encryption); await secrets.init()
    const check = vi.fn(async () => ({ message: '只读 fixture' }))
    const registry = new MusicRegistry({ create: vi.fn(), query: vi.fn(), check })
    const apis = new ApiConfigurations(db, secrets, registry, { generate: vi.fn(), check }); await apis.init()
    return { secrets, apis, check }
  }
  it('starts empty, treats a no-key ACE config as added, and allows a one-character key', async () => {
    const { apis, secrets } = await setup(); expect(apis.list()).toEqual([])
    await apis.save({ provider: 'acestep' })
    expect(apis.list()).toHaveLength(1); expect(apis.list()[0].hasKey).toBe(false)
    await apis.save({ provider: 'acestep', key: 'a' })
    expect(apis.list()).toHaveLength(1); expect(apis.list()[0].hasKey).toBe(true)
    const binding = apis.binding('acestep'); expect(apis.connection(binding).key).toBe('a')
    const cipherBefore = secrets.encryptedSnapshot().keys.acestep
    await apis.save({ provider: 'acestep' }); expect(secrets.encryptedSnapshot().keys.acestep).toBe(cipherBefore)
    expect(JSON.stringify(apis.list())).not.toContain('keys')
  })
  it('keeps one row per vendor, independent encrypted keys and readonly checks', async () => {
    const { apis, check } = await setup()
    await apis.save({ provider: 'mureka', key: 'fixture-mureka-v4' })
    await apis.save({ provider: 'siliconflow', key: 'fixture-image-v4' })
    await apis.save({ provider: 'mureka', key: 'fixture-new-mureka-v4' })
    expect(apis.list()).toHaveLength(2)
    expect(await readFile(path.join(root, 'secrets.json'), 'utf8')).not.toContain('fixture-')
    await apis.test({ provider: 'mureka' }); expect(check).toHaveBeenCalledTimes(1)
    expect(apis.list().find(value => value.provider === 'mureka')?.lastCheck?.ok).toBe(true)
    await apis.delete('siliconflow'); expect(apis.list().map(value => value.provider)).toEqual(['mureka'])
  })
  it('explicitly clears a saved cloud key without deleting the configuration or permitting a credential-free request', async () => {
    const { apis, secrets, check } = await setup()
    await expect(apis.save({ provider: 'mureka' })).rejects.toThrow('密钥')
    await apis.save({ provider: 'mureka', key: 'synthetic-clear-key-v4' })
    const binding = apis.binding('mureka')
    await apis.save({ provider: 'mureka', clearKey: true })
    expect(apis.list()).toHaveLength(1); expect(apis.list()[0].hasKey).toBe(false)
    expect(secrets.has('mureka')).toBe(false); expect(() => apis.connection(binding)).toThrow('密钥')
    await apis.save({ provider: 'mureka' }); expect(apis.list()[0].hasKey).toBe(false)
    await expect(apis.test({ provider: 'mureka' })).rejects.toThrow(); expect(check).not.toHaveBeenCalled()
    await apis.save({ provider: 'mureka', key: 'synthetic-replacement-v4' }); expect(apis.connection(binding).key).toBe('synthetic-replacement-v4')
  })
  it('protects original connections while allowing credential correction on the same address', async () => {
    const { apis } = await setup(); await apis.save({ provider: 'acestep', key: 'x' })
    const project = await gen.create(), entry = await gen.add(project.id, 'audio'), job = request(project.id, entry.id)
    job.binding = apis.binding('acestep'); job.snapshot = { ...initialEntry('audio', 'acestep'), prompt: 'local' }; job.status = 'failed'; job.recoverable = true; job.taskId = 'remote1'
    await db.put('requests', job.id, job)
    await expect(apis.delete('acestep')).rejects.toThrow('请求')
    await expect(apis.save({ provider: 'acestep', local: { baseUrl: 'http://127.0.0.1:8002', waitMinutes: 60, allowLan: false } })).rejects.toThrow('未完成')
    await apis.save({ provider: 'acestep', key: 'y' }); expect(apis.connection(job.binding).key).toBe('y')
    await db.update('requests', job.id, value => { value.status = 'abandoned' })
    await apis.save({ provider: 'acestep', local: { baseUrl: 'http://127.0.0.1:8002', waitMinutes: 60, allowLan: false } })
    expect(apis.list()[0].hasKey).toBe(false); expect(() => apis.connection(job.binding)).toThrow('改变')
  })
})

describe('durable diagnostics, classification and redaction', () => {
  it('retains attempts separately after reopening and strips authentication and signed URLs', async () => {
    const store = new DiagnosticStore(root); await store.init(); const taskId = randomUUID()
    const secret = 'fixture-secret-never-log'
    const first = await store.save(Object.assign(new Error('raw'), { code: 'EACCES', cause: { code: 5, stderr: `Authorization: Bearer ${secret}\nhttps://user:pw@example.com/a?token=${secret}\nPermission denied` } }), { taskId, attemptId: randomUUID(), stage: 'publish' })
    const second = await store.save(new Error('unknown raw'), { taskId, attemptId: randomUUID(), stage: 'mix' })
    expect(first.category).toBe('permission'); expect(first.exitCode).toBe(5)
    expect(JSON.stringify(first)).not.toContain(secret); expect(first.stderr).not.toContain('user:pw')
    expect(second.category).toBe('unknown'); expect(second.message).toContain('未确定')
    const reopened = new DiagnosticStore(root); await reopened.init(); expect(reopened.list(taskId)).toHaveLength(2)
    expect(redactDiagnostic('x-api-key: fixture-secret')).not.toContain('fixture-secret')
  })
})
