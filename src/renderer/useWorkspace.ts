import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CompositionDraft, CompositionProject, EntryDraft, GenerationEntry, PageId, WorkbenchAPI, WorkbenchSnapshot } from '../shared/workbench-types'
import { initialEntry } from '../shared/workbench-schemas'
import type { Provider } from '../shared/types'

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : '操作失败，请重试'
type EntrySession = { server: GenerationEntry; draft: EntryDraft; alternatives: GenerationEntry['alternatives']; version: number; dirty: boolean; saving?: Promise<void>; error?: string }
type CompositionSession = { server: CompositionProject; draft: CompositionDraft; version: number; dirty: boolean; saving?: Promise<void>; error?: string }
export interface WorkspaceState {
  data: WorkbenchSnapshot | null; ready: boolean; error?: string; refreshError?: string
  page: PageId; generationId?: string; compositionId?: string; busy: string[]
  saves: Record<string, { phase: 'dirty' | 'saving' | 'error'; message?: string }>
  notice?: { tone: 'error' | 'success' | 'info'; text: string }
}

/** A keyed write-back cache. No current-project closure is ever used to apply an async result. */
export class WorkspaceStore {
  private state: WorkspaceState = { data: null, ready: false, page: 'generation', busy: [], saves: {} }
  private raw: WorkbenchSnapshot | null = null
  private entries = new Map<string, EntrySession>()
  private compositions = new Map<string, CompositionSession>()
  private listeners = new Set<() => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private locks = new Set<string>()
  private fetching?: Promise<void>
  private refreshAgain = false
  constructor(private bridge?: WorkbenchAPI) {}
  api = (): WorkbenchAPI => {
    const api = this.bridge ?? window.canvas
    if (!api) throw new Error('未连接桌面服务。请在油管视频生成桌面应用中打开。')
    return api
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): WorkspaceState => this.state
  private publish(patch: Partial<WorkspaceState> = {}): void {
    const saves: WorkspaceState['saves'] = {}
    for (const [id, s] of [...this.entries, ...this.compositions]) if (s.dirty || s.saving || s.error) saves[id] = { phase: s.error ? 'error' : s.saving ? 'saving' : 'dirty', message: s.error }
    const data = this.raw ? { ...this.raw,
      entries: this.raw.entries.map(e => { const s = this.entries.get(e.id); return s ? { ...s.server, draft: s.draft, alternatives: s.alternatives } : e }),
      compositionProjects: this.raw.compositionProjects.map(p => { const s = this.compositions.get(p.id); return s ? { ...s.server, draft: s.draft } : p }),
    } : null
    this.state = { ...this.state, ...patch, data, saves, busy: [...this.locks] }
    this.listeners.forEach(listener => listener())
  }
  refresh = async (): Promise<void> => {
    if (this.fetching) { this.refreshAgain = true; return this.fetching }
    this.fetching = (async () => {
      do {
        this.refreshAgain = false
        const next = await this.api().bootstrap()
        // A notification during an in-flight read invalidates that read, including deletions.
        if (this.refreshAgain) continue
        for (const entry of next.entries) {
          const s = this.entries.get(entry.id)
          if (s && entry.revision >= s.server.revision) {
            s.server = entry
            if (!s.dirty && !s.saving) { s.draft = entry.draft; s.alternatives = entry.alternatives }
          }
        }
        for (const [id, session] of this.entries) if (!session.saving && !next.entries.some(e => e.id === id)) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.entries.delete(id) }
        for (const [id, session] of this.compositions) if (!session.saving && !next.compositionProjects.some(p => p.id === id)) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.compositions.delete(id) }
        for (const project of next.compositionProjects) {
          const s = this.compositions.get(project.id)
          if (s && project.revision >= s.server.revision) { s.server = project; if (!s.dirty && !s.saving) s.draft = project.draft }
        }
        this.raw = next
        const first = !this.state.ready
        const generationId = first ? next.settings.lastGenerationId : this.state.generationId
        const compositionId = first ? next.settings.lastCompositionId : this.state.compositionId
        this.publish({ ready: true, error: undefined, refreshError: undefined,
          ...(first ? { page: next.settings.page } : {}),
          generationId: next.generationProjects.some(p => p.id === generationId) ? generationId : next.generationProjects[0]?.id,
          compositionId: next.compositionProjects.some(p => p.id === compositionId) ? compositionId : next.compositionProjects[0]?.id })
      } while (this.refreshAgain)
    })()
    try { await this.fetching }
    catch (error) { this.publish(this.state.ready ? { refreshError: messageOf(error) } : { error: messageOf(error) }); throw error }
    finally { this.fetching = undefined }
  }
  connect = (): (() => void) => {
    let unsubscribe: (() => void) | undefined
    try { unsubscribe = this.api().onChanged(() => { void this.refresh().catch(() => undefined) }) } catch { /* bootstrap reports missing bridge */ }
    void this.refresh().catch(() => undefined)
    const blur = (): void => { void this.flush().catch(() => undefined) }
    const unload = (event: BeforeUnloadEvent): void => {
      if ([...this.entries.values(), ...this.compositions.values()].some(s => s.dirty || s.saving)) { event.preventDefault(); event.returnValue = ''; blur() }
    }
    window.addEventListener('blur', blur); window.addEventListener('beforeunload', unload)
    return () => { unsubscribe?.(); window.removeEventListener('blur', blur); window.removeEventListener('beforeunload', unload); this.timers.forEach(clearTimeout); this.timers.clear() }
  }
  notify = (text: string, tone: 'error' | 'success' | 'info' = 'success'): void => { this.publish({ notice: { text, tone } }) }
  clearNotice = (): void => { this.publish({ notice: undefined }) }
  run = async <T,>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    if (this.locks.has(key)) return undefined
    this.locks.add(key); this.publish({ notice: undefined })
    try { const result = await action(); await this.refresh(); if (success) this.notify(success); return result }
    catch (error) { this.notify(messageOf(error), 'error'); return undefined }
    finally { this.locks.delete(key); this.publish() }
  }
  private schedule(key: string, action: () => Promise<void>): void {
    clearTimeout(this.timers.get(key))
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void action().catch(() => undefined) }, 600))
  }
  editEntry = (id: string, draft: EntryDraft, alternatives?: GenerationEntry['alternatives']): void => {
    const entry = this.state.data?.entries.find(e => e.id === id)
    if (!entry || entry.requestId) return
    const s: EntrySession = this.entries.get(id) ?? { server: entry, draft: entry.draft, alternatives: entry.alternatives, version: 0, dirty: false }
    s.draft = draft; if (alternatives) s.alternatives = alternatives
    s.version++; s.dirty = true; s.error = undefined; this.entries.set(id, s); this.publish()
    this.schedule(id, () => this.flushEntry(id))
  }
  changeProvider = (id: string, provider: Provider): void => {
    const e = this.state.data?.entries.find(item => item.id === id)
    if (!e || e.draft.provider === provider) return
    const alternatives = { ...e.alternatives, ...(e.draft.provider ? { [e.draft.provider]: structuredClone(e.draft) } : {}) }
    // First visit carries all user text, but receives legal adapter defaults for technical fields.
    const next = alternatives[provider] ?? { ...initialEntry(e.kind, provider), prompt: e.draft.prompt, lyrics: e.draft.lyrics, title: e.draft.title }
    this.editEntry(id, structuredClone(next), alternatives)
  }
  flushEntry = async (id: string): Promise<void> => {
    clearTimeout(this.timers.get(id)); this.timers.delete(id)
    const s = this.entries.get(id)
    if (!s) return
    if (s.saving) { await s.saving; if (s.dirty) return this.flushEntry(id); return }
    if (!s.dirty) return
    s.saving = (async () => {
      while (s.dirty) {
        const version = s.version
        const saved = await this.api().updateEntry(id, s.server.revision, structuredClone(s.draft), structuredClone(s.alternatives))
        if (saved.id !== id || saved.projectId !== s.server.projectId) throw new Error('条目保存标识不匹配，已保留本地草稿')
        if (saved.revision >= s.server.revision) s.server = saved
        if (s.version === version) { s.dirty = false; s.draft = s.server.draft; s.alternatives = s.server.alternatives }
        s.error = undefined; this.publish()
      }
    })()
    this.publish()
    try { await s.saving } catch (error) { s.error = messageOf(error); throw error }
    finally { s.saving = undefined; this.publish() }
  }
  editComposition = (id: string, draft: CompositionDraft): void => {
    const project = this.state.data?.compositionProjects.find(p => p.id === id)
    if (!project) return
    const s: CompositionSession = this.compositions.get(id) ?? { server: project, draft: project.draft, version: 0, dirty: false }
    s.draft = draft; s.version++; s.dirty = true; s.error = undefined; this.compositions.set(id, s); this.publish()
    this.schedule(id, () => this.flushComposition(id))
  }
  flushComposition = async (id: string): Promise<void> => {
    clearTimeout(this.timers.get(id)); this.timers.delete(id)
    const s = this.compositions.get(id)
    if (!s) return
    if (s.saving) { await s.saving; if (s.dirty) return this.flushComposition(id); return }
    if (!s.dirty) return
    s.saving = (async () => {
      while (s.dirty) {
        const version = s.version
        const saved = await this.api().updateCompositionProject(id, s.server.revision, { draft: structuredClone(s.draft) })
        if (saved.id !== id) throw new Error('项目保存标识不匹配，已保留本地草稿')
        if (saved.revision >= s.server.revision) s.server = saved
        if (s.version === version) { s.dirty = false; s.draft = s.server.draft }
        s.error = undefined; this.publish()
      }
    })()
    this.publish()
    try { await s.saving } catch (error) { s.error = messageOf(error); throw error }
    finally { s.saving = undefined; this.publish() }
  }
  flush = async (projectId?: string): Promise<void> => {
    await Promise.all([
      ...[...this.entries].filter(([, s]) => !projectId || s.server.projectId === projectId).map(([id]) => this.flushEntry(id)),
      ...[...this.compositions].filter(([id]) => !projectId || id === projectId).map(([id]) => this.flushComposition(id)),
    ])
  }
  navigate = async (page: PageId): Promise<void> => {
    await this.flush(); this.publish({ page }); await this.api().updateSettings({ page })
  }
  selectProject = async (kind: 'generation' | 'composition', id: string): Promise<void> => {
    const oldId = kind === 'generation' ? this.state.generationId : this.state.compositionId
    if (oldId) await this.flush(oldId)
    this.publish(kind === 'generation' ? { generationId: id } : { compositionId: id })
    await this.api().updateSettings(kind === 'generation' ? { lastGenerationId: id } : { lastCompositionId: id })
  }
}
export function useWorkspace() {
  const [store] = useState(() => new WorkspaceStore())
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => store.connect(), [store])
  return { store, ...state }
}
