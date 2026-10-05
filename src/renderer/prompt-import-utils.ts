import type { Provider } from '../shared/types'
import { initialEntry } from '../shared/workbench-schemas'
import type { EntryDraft, GenerationEntry, GenerationProject, PromptImportInput, PromptImportResult, WorkbenchAPI } from '../shared/workbench-types'

export function orderedProjectEntries(project: Pick<GenerationProject, 'id' | 'entryIds'>, entries: readonly GenerationEntry[]): GenerationEntry[] {
  const available = entries.filter(entry => entry.projectId === project.id && !entry.deletedAt)
  const byId = new Map(available.map(entry => [entry.id, entry])), ordered = new Set(project.entryIds)
  return [...project.entryIds.map(id => byId.get(id)).filter((entry): entry is GenerationEntry => Boolean(entry)), ...available.filter(entry => !ordered.has(entry.id))]
}

/** Technical settings only; current user content always wins, including intentional empty fields. */
export function applyPromptSettings(content: EntryDraft, settings: EntryDraft): EntryDraft {
  const { prompt: _prompt, title: _title, lyrics: _lyrics, ...parameters } = settings
  void _prompt; void _title; void _lyrics
  return { ...structuredClone(parameters), prompt: content.prompt, ...(content.title !== undefined ? { title: content.title } : {}), ...(content.lyrics !== undefined ? { lyrics: content.lyrics } : {}) }
}
export function changePromptProvider(entry: GenerationEntry, provider: Provider): GenerationEntry {
  if ((provider === 'siliconflow') !== (entry.kind === 'image')) throw new Error('API 与本次素材类型不一致')
  if (provider === entry.draft.provider) return entry
  const alternatives = { ...entry.alternatives, ...(entry.draft.provider ? { [entry.draft.provider]: structuredClone(entry.draft) } : {}) }
  const settings = alternatives[provider] ?? initialEntry(entry.kind, provider)
  return { ...entry, draft: applyPromptSettings(entry.draft, settings), alternatives }
}
export class PromptSaveFailure extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message) }
}
function checked(result: PromptImportResult, input: PromptImportInput): PromptImportResult {
  if (result.batchId !== input.batchId || result.projectId !== input.projectId || result.kind !== input.kind || (result.status !== 'missing' && result.status !== 'created') || (result.status === 'created' && (result.entryIds.length !== input.drafts.length || new Set(result.entryIds).size !== result.entryIds.length))) throw new PromptSaveFailure('返回的导入批次不匹配，请核对原项目；不会重新创建。', true)
  return result
}
/** Query first, and after a failed reply. Never automatically repeat a write. */
export async function savePromptBatch(api: Pick<WorkbenchAPI, 'promptImportStatus' | 'createPromptEntries'>, input: PromptImportInput, createIfMissing: boolean): Promise<PromptImportResult> {
  const { projectId, kind, batchId } = input, identity = { projectId, kind, batchId }
  let existing: PromptImportResult
  try { existing = checked(await api.promptImportStatus(identity), input) }
  catch { throw new PromptSaveFailure('无法核对本批保存状态，请重试核对；不会盲目创建。', true) }
  if (existing.status === 'created' || !createIfMissing) return existing
  try { return checked(await api.createPromptEntries(input), input) }
  catch (error) {
    let after: PromptImportResult
    try { after = checked(await api.promptImportStatus(identity), input) }
    catch { throw new PromptSaveFailure('创建回复中断，暂时无法确认是否保存。请先核对本批结果，不要开启重复导入。', true) }
    if (after.status === 'created') return after
    throw new PromptSaveFailure(error instanceof Error ? error.message : '本批尚未保存，请核对后重试同一批次。', false)
  }
}
