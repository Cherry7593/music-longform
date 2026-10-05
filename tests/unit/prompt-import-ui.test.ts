import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { applyPromptSettings, changePromptProvider, orderedProjectEntries, savePromptBatch } from '../../src/renderer/prompt-import-utils'
import { initialEntry } from '../../src/shared/workbench-schemas'
import type { GenerationEntry, PromptImportInput, PromptImportResult } from '../../src/shared/workbench-types'

const entry = (prompt = '  原提示词\n\n第二段  '): GenerationEntry => ({ version: 1, id: randomUUID(), projectId: randomUUID(), kind: 'audio', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0, draft: { ...initialEntry('audio', 'mureka'), title: '原名称', prompt, lyrics: '[Verse]\n原歌词\n' }, alternatives: {} })
const input = (): PromptImportInput => ({ projectId: randomUUID(), kind: 'audio', batchId: randomUUID(), drafts: [{ ...initialEntry('audio'), prompt: '一个草稿' }] })
function bridge(value: PromptImportInput) {
  const { projectId, kind, batchId } = value
  const missing: PromptImportResult = { projectId, kind, batchId, status: 'missing', entryIds: [] }
  const created: PromptImportResult = { projectId, kind, batchId, status: 'created', entryIds: [randomUUID()] }
  return { missing, created, api: { promptImportStatus: vi.fn(async () => missing), createPromptEntries: vi.fn(async () => created) } }
}

describe('local import configuration and confirmation', () => {
  it('applies settings only and preserves literal content and intentionally absent fields', () => {
    const original = entry().draft, settings = { ...initialEntry('audio', 'kie'), title: '不能覆盖', prompt: '不能覆盖', lyrics: '不能覆盖' }
    const result = applyPromptSettings(original, settings)
    expect(result).toMatchObject({ provider: 'kie', title: original.title, prompt: original.prompt, lyrics: original.lyrics })
    expect(applyPromptSettings({ model: '', prompt: '保留' }, settings)).toMatchObject({ provider: 'kie', prompt: '保留' })
    expect(applyPromptSettings({ model: '', prompt: '保留' }, settings).title).toBeUndefined()
  })
  it('keeps latest content when revisiting provider-specific parameters, without fetching models', () => {
    let value = entry()
    value = changePromptProvider(value, 'mureka-cn'); value.draft.model = 'mureka-9.5'
    value = changePromptProvider(value, 'acestep'); value.draft.prompt = '编辑后的正文'; value.draft.lyrics = '编辑后歌词'
    value = changePromptProvider(value, 'mureka-cn')
    expect(value.draft).toMatchObject({ model: 'mureka-9.5', title: '原名称', prompt: '编辑后的正文', lyrics: '编辑后歌词' })
    expect(() => changePromptProvider(value, 'siliconflow')).toThrow('类型')
  })
  it('keeps image names and prompts through bulk size changes', () => {
    expect(applyPromptSettings({ ...initialEntry('image'), title: '画面名', prompt: '中文画面\n下一段' }, { ...initialEntry('image', 'siliconflow'), size: '928x1664', prompt: '不能覆盖' })).toEqual({ provider: 'siliconflow', model: 'Qwen/Qwen-Image', size: '928x1664', title: '画面名', prompt: '中文画面\n下一段' })
  })
  it('uses the project order rather than restarted record-file order, without dropping old unlisted rows', () => {
    const a = entry('一'), b = { ...entry('二'), projectId: a.projectId }, c = { ...entry('旧未列入'), projectId: a.projectId }, other = entry('其他项目')
    expect(orderedProjectEntries({ id: a.projectId, entryIds: [a.id, b.id] }, [b, other, c, a]).map(e => e.draft.prompt)).toEqual(['一', '二', '旧未列入'])
  })
  it('checks first, then makes exactly one batch call', async () => {
    const value = input(), f = bridge(value)
    expect(await savePromptBatch(f.api, value, true)).toEqual(f.created)
    expect(f.api.promptImportStatus).toHaveBeenCalledOnce(); expect(f.api.createPromptEntries).toHaveBeenCalledOnce()
    expect(f.api.promptImportStatus.mock.invocationCallOrder[0]).toBeLessThan(f.api.createPromptEntries.mock.invocationCallOrder[0])
  })
  it('recovers a lost success reply by checking saved results, never another write', async () => {
    const value = input(), f = bridge(value)
    f.api.promptImportStatus.mockResolvedValueOnce(f.missing).mockResolvedValue(f.created)
    f.api.createPromptEntries.mockRejectedValue(new Error('synthetic lost reply'))
    expect(await savePromptBatch(f.api, value, true)).toEqual(f.created)
    expect(f.api.createPromptEntries).toHaveBeenCalledOnce(); expect(f.api.promptImportStatus).toHaveBeenCalledTimes(2)
    expect(await savePromptBatch(f.api, value, true)).toEqual(f.created)
    expect(f.api.createPromptEntries).toHaveBeenCalledOnce()
  })
  it('does not write while the saved outcome is unknown and requires explicit later create after a missing result', async () => {
    const value = input(), f = bridge(value)
    f.api.promptImportStatus.mockRejectedValueOnce(new Error('cannot check'))
    await expect(savePromptBatch(f.api, value, true)).rejects.toMatchObject({ uncertain: true })
    expect(f.api.createPromptEntries).not.toHaveBeenCalled()
    expect(await savePromptBatch(f.api, value, false)).toEqual(f.missing)
    expect(f.api.createPromptEntries).not.toHaveBeenCalled()
  })
  it('reports known failed writes without automatically retrying and unknown results conservatively', async () => {
    const value = input(), f = bridge(value)
    f.api.createPromptEntries.mockRejectedValue(new Error('draft capacity exceeded'))
    await expect(savePromptBatch(f.api, value, true)).rejects.toMatchObject({ uncertain: false, message: 'draft capacity exceeded' })
    expect(f.api.createPromptEntries).toHaveBeenCalledOnce()
    f.api.promptImportStatus.mockResolvedValueOnce(f.missing).mockRejectedValueOnce(new Error('lost check'))
    await expect(savePromptBatch(f.api, value, true)).rejects.toMatchObject({ uncertain: true })
    expect(f.api.createPromptEntries).toHaveBeenCalledTimes(2)
  })
  it('rejects saved results bound to another project or a partial identity set', async () => {
    const value = input(), f = bridge(value)
    for (const invalid of [{ ...f.created, projectId: randomUUID() }, { ...f.created, entryIds: [] }]) {
      f.api.promptImportStatus.mockResolvedValueOnce(invalid)
      await expect(savePromptBatch(f.api, value, true)).rejects.toMatchObject({ uncertain: true })
    }
    expect(f.api.createPromptEntries).not.toHaveBeenCalled()
  })
})
