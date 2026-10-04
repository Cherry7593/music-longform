import { useEffect, useState, useSyncExternalStore } from 'react'
import { projectPatchSchema } from '../shared/schemas'
import { APP_NAME } from '../shared/branding'
import { summarize } from '../shared/types'
import type { CanvasAPI, Project, ProjectPatch, ProjectSummary, PublicSettings } from '../shared/types'
import { errorMessage, validationMessage } from './utils'

type Field = keyof ProjectPatch
type Draft = Pick<Project, 'name' | 'music' | 'image' | 'video'>
type SaveState = { phase: 'saved' | 'dirty' | 'saving' | 'error'; message?: string }
interface Session {
  epoch: number
  server: Project
  draft: Draft
  dirty: Set<Field>
  revisions: Record<Field, number>
  eventSequence: number
  saving: Promise<void> | null
}
interface WorkspaceState {
  ready: boolean
  loadError: string | null
  project: Project | null
  projects: ProjectSummary[]
  settings: PublicSettings | null
  warnings: string[]
  testMode: boolean
  save: SaveState
  switching: boolean
  busy: string[]
}

/** Only draft fields are overlaid on authoritative full-project events. No polling or paid retry lives here. */
export class WorkspaceStore {
  private state: WorkspaceState = {
    ready: false, loadError: null, project: null, projects: [], settings: null,
    warnings: [], testMode: false, save: { phase: 'saved' }, switching: false, busy: [],
  }
  private listeners = new Set<() => void>()
  private session: Session | null = null
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private loading: Promise<void> | null = null
  private latest = new Map<string, Project>()
  private locks = new Set<string>()
  private api(): CanvasAPI {
    if (!window.canvas) throw new Error(`未连接到桌面服务。请在${APP_NAME}桌面应用中打开此界面。`)
    return window.canvas
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): WorkspaceState => this.state
  getVideoRevision = (): number => this.session?.revisions.video ?? 0
  private publish(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private publishSession(save?: SaveState): void {
    const session = this.session
    this.publish({ project: session ? { ...session.server, ...session.draft } : null, ...(save ? { save } : {}) })
  }
  private updateSummary(project: Project): void {
    const old = this.state.projects.find(item => item.id === project.id)
    if (old && old.updatedAt > project.updatedAt) return
    this.publish({ projects: [...this.state.projects.filter(item => item.id !== project.id), summarize(project)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })
  }
  private accept(project: Project, responseSequence?: number): void {
    const cached = this.latest.get(project.id)
    if (cached && cached.updatedAt > project.updatedAt) return
    const session = this.session
    if (session?.server.id === project.id) {
      if (project.updatedAt < session.server.updatedAt) return
      // A request response must not roll back an event received after that request began.
      if (responseSequence !== undefined && responseSequence !== session.eventSequence && project.updatedAt <= session.server.updatedAt) return
      if (responseSequence === undefined) session.eventSequence += 1
      session.server = project
      if (!session.dirty.has('name')) session.draft.name = project.name
      if (!session.dirty.has('music')) session.draft.music = project.music
      if (!session.dirty.has('image')) session.draft.image = project.image
      if (!session.dirty.has('video')) {
        if (JSON.stringify(session.draft.video) !== JSON.stringify(project.video)) session.revisions.video += 1
        session.draft.video = project.video
      }
      this.publishSession()
    }
    this.latest.set(project.id, project)
    this.updateSummary(project)
  }
  private install(project: Project | null): void {
    this.clearTimer()
    const cached = project ? this.latest.get(project.id) : undefined
    const current = project && cached && cached.updatedAt >= project.updatedAt ? cached : project
    this.epoch += 1
    this.session = current ? {
      epoch: this.epoch, server: current,
      draft: { name: current.name, music: current.music, image: current.image, video: current.video },
      dirty: new Set(), revisions: { name: 0, music: 0, image: 0, video: 0 }, eventSequence: 0, saving: null,
    } : null
    this.publishSession({ phase: 'saved' })
    if (current) this.updateSummary(current)
  }
  load = async (): Promise<void> => {
    if (this.loading) return this.loading
    this.publish({ loadError: null, ready: false })
    this.loading = (async () => {
      try {
        const bootstrap = await this.api().bootstrap()
        this.publish({ settings: bootstrap.settings, projects: bootstrap.projects,
          warnings: bootstrap.warnings, testMode: bootstrap.testMode })
        this.install(bootstrap.project)
        this.publish({ ready: true })
      } catch (error) {
        this.publish({ loadError: errorMessage(error) })
      }
    })()
    try { await this.loading } finally { this.loading = null }
  }
  connect = (): (() => void) => {
    let unsubscribe: (() => void) | undefined
    try { unsubscribe = this.api().onProjectChanged(project => this.accept(project)) } catch { /* load surfaces a missing bridge. */ }
    if (!this.state.ready) void this.load()
    const flushOnBlur = (): void => { void this.flush().catch(() => undefined) }
    const protectDraft = (event: BeforeUnloadEvent): void => {
      if (this.session?.dirty.size) {
        event.preventDefault()
        event.returnValue = ''
        flushOnBlur()
      }
    }
    window.addEventListener('blur', flushOnBlur)
    window.addEventListener('beforeunload', protectDraft)
    return () => {
      unsubscribe?.()
      window.removeEventListener('blur', flushOnBlur)
      window.removeEventListener('beforeunload', protectDraft)
      this.clearTimer()
    }
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  edit = <K extends Field>(field: K, value: Draft[K]): void => {
    const session = this.session
    if (!session || this.state.switching) return
    session.draft = { ...session.draft, [field]: value }
    session.revisions[field] += 1
    session.dirty.add(field)
    this.publishSession({ phase: session.saving ? 'saving' : 'dirty' })
    this.clearTimer()
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined) }, 650)
  }
  flush = async (): Promise<void> => {
    this.clearTimer()
    const session = this.session
    if (!session) return
    while (this.session === session && session.dirty.size) {
      if (session.saving) { await session.saving; continue }
      const fields = [...session.dirty]
      const revisions = { ...session.revisions }
      const patch: ProjectPatch = {}
      for (const field of fields) Object.assign(patch, { [field]: session.draft[field] })
      const result = projectPatchSchema.safeParse(patch)
      if (!result.success) {
        const message = validationMessage(result.error)
        this.publishSession({ phase: 'error', message: `尚未保存：${message}。输入仍保留在当前项目中。` })
        throw new Error(message)
      }
      const sequence = session.eventSequence
      this.publishSession({ phase: 'saving' })
      session.saving = (async () => {
        try {
          const response = await this.api().updateProject(session.server.id, result.data)
          if (this.session !== session) return
          this.accept(response, sequence)
          // A slow save only acknowledges the exact revision it sent, never newer typing.
          for (const field of fields) {
            if (session.revisions[field] !== revisions[field]) continue
            session.dirty.delete(field)
            Object.assign(session.draft, { [field]: response[field] })
          }
          this.publishSession({ phase: session.dirty.size ? 'dirty' : 'saved' })
        } catch (error) {
          if (this.session === session) this.publishSession({ phase: 'error',
            message: `保存失败：${errorMessage(error)}。输入仍在，请重试保存后再切换项目或退出。` })
          throw error
        }
      })()
      try { await session.saving } finally { session.saving = null }
    }
  }
  private navigate = async (load: () => Promise<Project>): Promise<void> => {
    if (this.state.switching) return
    this.publish({ switching: true })
    try {
      await this.flush()
      const project = await load()
      this.install(project)
    } finally { this.publish({ switching: false }) }
  }
  switchProject = async (id: string): Promise<void> => {
    if (id === this.session?.server.id) return
    await this.navigate(() => this.api().getProject(id))
  }
  createProject = async (): Promise<void> => { await this.navigate(() => this.api().createProject()) }
  /** Flush the current draft, then install the persistent backend-managed generation session. */
  openGeneration = async (): Promise<void> => { await this.navigate(() => this.api().getGenerationProject()) }
  setSettings = (settings: PublicSettings): void => { this.publish({ settings }) }
  dismissWarnings = (): void => { this.publish({ warnings: [] }) }
  run = async (key: string, action: (api: CanvasAPI, id: string) => Promise<Project>, flushFirst = false): Promise<void> => {
    const session = this.session
    if (!session) throw new Error('请先创建或打开项目')
    const lock = `${session.epoch}:${key}`
    if (this.locks.has(lock)) return
    this.locks.add(lock)
    this.publish({ busy: [...this.state.busy, key] })
    try {
      if (flushFirst) await this.flush()
      if (this.session !== session) throw new Error('项目已切换，请在当前项目重新操作')
      const sequence = session.eventSequence
      const response = await action(this.api(), session.server.id)
      if (this.session === session) this.accept(response, sequence)
      else this.updateSummary(response)
    } finally {
      this.locks.delete(lock)
      this.publish({ busy: this.state.busy.filter(item => item !== key) })
    }
  }
}

export function useWorkspace(): WorkspaceState & { store: WorkspaceStore } {
  const [store] = useState(() => new WorkspaceStore())
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => store.connect(), [store])
  return { ...state, store }
}
