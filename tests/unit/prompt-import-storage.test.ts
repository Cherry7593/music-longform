import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkbenchDB } from '../../src/main/storage/workbench-db'
import { GenerationProjects } from '../../src/main/storage/workbench-projects'
import * as atomic from '../../src/main/storage/atomic'
import { initialEntry, promptImportInputSchema, submissionIssue } from '../../src/shared/workbench-schemas'
import type { EntryDraft, PromptImportInput } from '../../src/shared/workbench-types'
import { promptTemplate } from '../../src/main/prompt-templates'

let root: string, db: WorkbenchDB, projects: GenerationProjects
beforeEach(async () => { root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v402-import-storage-')); db = new WorkbenchDB(root); await db.init(); projects = new GenerationProjects(db) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const draft = (prompt: string): EntryDraft => ({ ...initialEntry('audio'), prompt })
const batch = (projectId: string, prompts = ['第一条', '第二条']): PromptImportInput => ({ projectId, kind: 'audio', batchId: randomUUID(), drafts: prompts.map(draft) })

describe('atomic prompt draft batches', () => {
  it('appends in preview order, retains old entries and needs no API or generation request', async () => {
    const a = await projects.create(), b = await projects.create(), old = await projects.add(a.id, 'audio')
    await projects.updateEntry(old.id, old.revision, draft('旧内容'), {})
    const before = db.get('entries', old.id), changed = vi.fn(); db.onChanged = changed
    const input = batch(a.id, ['相同正文\n\n  保留空格  ', '相同正文\n\n  保留空格  ']); input.drafts[0].title = ' 可选名称 '; input.drafts[1].lyrics = '[Verse]\n第二行'
    const result = await projects.createPromptEntries(input)
    expect(result.status).toBe('created'); expect(changed).toHaveBeenCalledOnce()
    expect(projects.get(a.id).entryIds).toEqual([old.id, ...result.entryIds]); expect(projects.get(b.id).entryIds).toEqual([])
    expect(db.get('entries', old.id)).toEqual(before)
    expect(result.entryIds.map(id => db.get('entries', id).draft.prompt)).toEqual(input.drafts.map(row => row.prompt))
    expect(db.get('entries', result.entryIds[1]).draft.title).toBeUndefined()
    expect(db.list('requests')).toEqual([]); expect(db.list('submissions')).toEqual([]); expect(db.list('apis')).toEqual([])
    expect(result.entryIds.every(id => db.get('entries', id).requestId === undefined && db.get('entries', id).revision === 0)).toBe(true)
    expect(submissionIssue('audio', db.get('entries', result.entryIds[0]).draft)).toContain('API')
  })
  it('is once-only for concurrent confirmation, after restart, and after imported rows are edited or deleted', async () => {
    const project = await projects.create(), input = batch(project.id)
    const [a, b] = await Promise.all([projects.createPromptEntries(input), projects.createPromptEntries(structuredClone(input))])
    expect(a).toEqual(b); expect(db.list('entries')).toHaveLength(2)
    await projects.updateEntry(a.entryIds[0], 0, draft('创建后编辑'), {})
    await projects.deleteEntry(a.entryIds[1])
    const reopened = new WorkbenchDB(root); await reopened.init(); const store = new GenerationProjects(reopened)
    expect(await store.createPromptEntries(input)).toEqual(a)
    expect(await store.promptImportStatus({ projectId: input.projectId, kind: input.kind, batchId: input.batchId })).toEqual(a)
    expect(reopened.list('entries')).toHaveLength(2); expect(reopened.get('entries', a.entryIds[0]).draft.prompt).toBe('创建后编辑')
    const explicitNew = await store.createPromptEntries({ ...input, batchId: randomUUID() })
    expect(explicitNew.entryIds).not.toEqual(a.entryIds); expect(reopened.list('entries')).toHaveLength(4)
  })
  it('rejects a reused batch identity with changed content, project or type', async () => {
    const a = await projects.create(), b = await projects.create(), input = batch(a.id)
    await projects.createPromptEntries(input)
    await expect(projects.createPromptEntries({ ...input, drafts: [draft('不同')] })).rejects.toThrow('内容已改变')
    await expect(projects.createPromptEntries({ ...input, projectId: b.id })).rejects.toThrow('归属不同')
    await expect(projects.promptImportStatus({ projectId: a.id, kind: 'image', batchId: input.batchId })).rejects.toThrow('归属不同')
    expect(db.list('entries')).toHaveLength(2)
  })
  it('validates kind, project lifetime and capacity before any entries are exposed', async () => {
    const project = await projects.create(), input = batch(project.id)
    await projects.update(project.id, { page: 'image' })
    await expect(projects.createPromptEntries(input)).rejects.toThrow('类型已切换')
    await projects.update(project.id, { page: 'audio' })
    await db.update('generation', project.id, row => { row.entryIds = Array.from({ length: 20000 }, () => randomUUID()) })
    await expect(projects.createPromptEntries(input)).rejects.toThrow('20000')
    expect(db.list('entries')).toHaveLength(0)
    await projects.delete(project.id); await expect(projects.createPromptEntries(input)).rejects.toThrow('已删除')
    await expect(projects.createPromptEntries({ ...input, projectId: randomUUID() })).rejects.toThrow('记录')
  })
  it('saves bounded incomplete parameters but requires any explicitly selected API to be added and appropriate', async () => {
    const project = await projects.create(), input = batch(project.id)
    input.drafts = [{ ...initialEntry('audio', 'mureka-cn'), model: '', prompt: '长'.repeat(5000), title: '名'.repeat(100) }]
    await expect(projects.createPromptEntries(input)).rejects.toThrow('API')
    const stamp = new Date().toISOString()
    await db.put('apis', 'mureka-cn', { version: 1, provider: 'mureka-cn', kind: 'audio', createdAt: stamp, updatedAt: stamp })
    const result = await projects.createPromptEntries(input), saved = db.get('entries', result.entryIds[0])
    expect(saved.draft).toEqual(input.drafts[0]); expect(submissionIssue('audio', saved.draft)).toBeTruthy()
    expect(db.list('requests')).toEqual([])
    await db.update('apis', 'mureka-cn', row => { row.deletedAt = stamp })
    await expect(projects.createPromptEntries({ ...input, batchId: randomUUID() })).rejects.toThrow('API')
    expect(await projects.createPromptEntries(input)).toEqual(result)
  })
  it.each([
    { drafts: [] }, { drafts: Array.from({ length: 501 }, () => draft('too many')) },
    { drafts: [draft('   ')] }, { drafts: [{ ...draft('x'), title: '两\n行' }] },
    { drafts: [{ ...draft('x'), prompt: 'x'.repeat(32001) }] }, { drafts: [{ ...draft('x'), lyrics: 'x'.repeat(32001) }] },
    { drafts: [{ ...draft('x'), title: 'x'.repeat(501) }] }, { drafts: [{ ...draft('x'), count: 2 }] },
    { drafts: [{ ...draft('x'), provider: 'siliconflow' }] }, { drafts: [{ ...draft('x'), size: '1664x928' }] },
    { kind: 'video' }, { outputPath: 'C:\\untrusted\\file' }, { requestId: randomUUID() },
    { drafts: Array.from({ length: 30 }, () => draft('中'.repeat(32000))) }
  ])('rejects malformed batch input without writes (case %#)', async patch => {
    const project = await projects.create(), input = { ...batch(project.id), ...patch }
    expect(promptImportInputSchema.safeParse(input).success).toBe(false)
    await expect(projects.createPromptEntries(input as PromptImportInput)).rejects.toThrow()
    expect(db.list('entries')).toEqual([]); expect(projects.get(project.id).entryIds).toEqual([])
  })
  it('accepts 500 ordered drafts in one transaction', async () => {
    const project = await projects.create(), input = batch(project.id, Array.from({ length: 500 }, (_, index) => `顺序${index}`))
    const changed = vi.fn(); db.onChanged = changed
    const result = await projects.createPromptEntries(input)
    expect(result.entryIds).toHaveLength(500); expect(changed).toHaveBeenCalledOnce()
    expect(projects.get(project.id).entryIds.map(id => db.get('entries', id).draft.prompt)).toEqual(input.drafts.map(d => d.prompt))
  })
  it('does not expose a half batch on transaction failure and recovers the original intent without duplicate rows', async () => {
    const project = await projects.create(), old = await projects.add(project.id, 'audio'), input = batch(project.id, ['一', '二', '三'])
    const real = atomic.atomicJson, changed = vi.fn(); db.onChanged = changed
    let writes = 0
    const failure = vi.spyOn(atomic, 'atomicJson').mockImplementation(async (file, data, maximum) => {
      if (path.dirname(file) === path.join(db.directory, 'entries') && ++writes === 2) throw new Error('synthetic disk interruption')
      return real(file, data, maximum)
    })
    await expect(projects.createPromptEntries(input)).rejects.toThrow('interruption')
    expect(db.list('entries').map(e => e.id)).toEqual([old.id]); expect(projects.get(project.id).entryIds).toEqual([old.id]); expect(changed).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path.join(db.directory, 'transaction.json'), 'utf8')).changes).toHaveLength(4)
    failure.mockRestore()
    const reopened = new WorkbenchDB(root); await reopened.init(); const store = new GenerationProjects(reopened)
    const recovered = await store.promptImportStatus({ projectId: project.id, kind: 'audio', batchId: input.batchId })
    expect(recovered.status).toBe('created'); expect(recovered.entryIds).toHaveLength(3)
    expect(await store.createPromptEntries(input)).toEqual(recovered)
    expect(reopened.list('entries')).toHaveLength(4); expect(store.get(project.id).entryIds).toEqual([old.id, ...recovered.entryIds])
  })
  it('treats images independently, omits empty optional names and rejects lyrics or music settings', async () => {
    const project = await projects.create(); await projects.update(project.id, { page: 'image' })
    const input: PromptImportInput = { projectId: project.id, batchId: randomUUID(), kind: 'image', drafts: [{ ...initialEntry('image'), prompt: '画面\n\n第二段', title: '  ' }] }
    const result = await projects.createPromptEntries(input)
    expect(db.get('entries', result.entryIds[0]).kind).toBe('image'); expect(db.get('entries', result.entryIds[0]).draft.title).toBeUndefined()
    for (const extra of [{ lyrics: '' }, { mode: 'song' }, { provider: 'mureka' }]) await expect(projects.createPromptEntries({ ...input, batchId: randomUUID(), drafts: [{ ...input.drafts[0], ...extra }] } as PromptImportInput)).rejects.toThrow()
  })
})

describe('embedded UTF-8 prompt templates', () => {
  it.each(['audio', 'image'] as const)('%s uses the existing template bytes and Chinese name', async kind => {
    const template = promptTemplate(kind)
    expect(Buffer.from(template.text, 'utf8')).toEqual(await readFile(path.join('docs/templates', template.name)))
    expect(template.name).toBe(kind === 'audio' ? '音乐提示词模板.md' : '图片提示词模板.md')
  })
})
