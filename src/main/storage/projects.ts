import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_VIDEO, idSchema, projectPatchSchema } from '../../shared/schemas'
import { summarize, type AssetKind, type Project, type ProjectPatch, type ProjectSummary, type Settings } from '../../shared/types'
import { AppError } from '../providers/http'
import { atomicJson, isMissing, readJson, SerialQueue } from './atomic'
import { existingAssetPath } from './paths'
import { projectIndexSchema, projectSchema, settingsSchema } from './validation'
import { migrateProject } from './migrations'

interface Registration { id: string; directory: string }

export class ProjectStore {
  onChanged?: (project: Project) => void
  public warnings: string[] = []
  private initialized = false
  private readonly projects = new Map<string, Project>()
  private registrations: Registration[] = []
  private readonly queue = new SerialQueue()
  private readonly indexPath: string

  constructor(private readonly dataDir: string) {
    this.indexPath = join(dataDir, 'projects.json')
  }

  async init(): Promise<void> {
    await this.queue.run(async () => {
      if (this.initialized) return
      try { await mkdir(this.dataDir, { recursive: true }) } catch { throw new AppError('无法创建项目索引目录，请检查存储权限。') }
      let data: unknown
      try { data = await readJson(this.indexPath, 4 * 1024 * 1024) } catch (error) {
        if (!isMissing(error)) throw new AppError('项目索引损坏或不可读取；原文件未被覆盖，请先备份并修复。')
        data = { version: 1, projects: [] }
        try { await atomicJson(this.indexPath, data, 4 * 1024 * 1024) } catch { throw new AppError('无法保存项目索引，请检查存储权限。') }
      }
      const index = projectIndexSchema.safeParse(data)
      if (!index.success) throw new AppError('项目索引格式不兼容；原文件未被覆盖，请先备份并修复。')
      const loaded = new Map<string, Project>()
      const warnings: string[] = []
      for (const registration of index.data.projects) {
        try {
          const file = join(registration.directory, 'project.json')
          const raw = await readJson(file)
          const project = await migrateProject(file, raw, registration.directory, registration.id)
          loaded.set(registration.id, project)
        } catch {
          warnings.push(`项目 ${registration.id} 缺失、损坏或不可读取，原文件和索引记录均已保留。`)
        }
      }
      this.registrations = index.data.projects
      this.projects.clear()
      for (const [id, project] of loaded) this.projects.set(id, project)
      this.warnings = warnings
      this.initialized = true
    })
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new AppError('项目存储尚未初始化。')
  }

  private current(id: string): Project {
    this.requireInitialized()
    if (!idSchema.safeParse(id).success) throw new AppError('项目标识不正确。')
    const project = this.projects.get(id)
    if (!project) throw new AppError('项目不存在或无法读取，请检查存储目录。')
    return project
  }

  async list(): Promise<ProjectSummary[]> {
    return (await this.all()).map(summarize)
  }

  async all(): Promise<Project[]> {
    this.requireInitialized()
    return structuredClone([...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  }

  async get(id: string): Promise<Project> {
    return structuredClone(this.current(id))
  }

  private notify(project: Project): void {
    // A failed UI listener must not turn a committed save into an apparent failure.
    try { this.onChanged?.(structuredClone(project)) } catch { /* Disk commit already succeeded. */ }
  }

  async create(settings: Settings): Promise<Project> {
    const parsed = settingsSchema.safeParse(settings)
    if (!parsed.success) throw new AppError('新项目的默认设置不正确，存储目录必须是绝对路径。')
    return this.queue.run(async () => {
      this.requireInitialized()
      if (this.registrations.length >= 10000) throw new AppError('项目数量已达上限，请先备份并整理项目索引。')
      const id = randomUUID()
      const directory = join(resolve(parsed.data.projectRoot), id)
      const now = new Date().toISOString()
      const project: Project = {
        version: 3, id, name: '未命名项目', directory, createdAt: now, updatedAt: now,
        music: structuredClone(parsed.data.musicDefaults), image: structuredClone(parsed.data.imageDefaults),
        musicJobs: [], batches: [], imageJobs: [], audio: [], images: [], video: structuredClone(DEFAULT_VIDEO), videoJobs: []
      }
      const registrations = [...this.registrations, { id, directory }]
      try {
        await mkdir(parsed.data.projectRoot, { recursive: true })
        await mkdir(directory)
        await mkdir(join(directory, 'audio'))
        await mkdir(join(directory, 'images'))
        await atomicJson(join(directory, 'project.json'), project)
        await atomicJson(this.indexPath, { version: 1, projects: registrations }, 4 * 1024 * 1024)
      } catch { throw new AppError('项目创建或索引保存失败，请检查存储位置、空间和权限；已写入的文件不会被删除。') }
      this.registrations = registrations
      this.projects.set(id, project)
      this.notify(project)
      return structuredClone(project)
    })
  }

  async patch(id: string, patch: ProjectPatch): Promise<Project> {
    const parsed = projectPatchSchema.safeParse(patch)
    if (!parsed.success) throw new AppError('项目参数不正确。')
    return this.mutate(id, (project) => { Object.assign(project, parsed.data) })
  }

  async mutate(id: string, fn: (project: Project) => void): Promise<Project> {
    return this.queue.run(async () => {
      const previous = this.current(id)
      const next = structuredClone(previous)
      fn(next)
      if (next.id !== previous.id || next.directory !== previous.directory || next.createdAt !== previous.createdAt || next.version !== 3) {
        throw new AppError('不能更改项目标识、目录或创建时间。')
      }
      next.updatedAt = new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString()
      const parsed = projectSchema.safeParse(next)
      if (!parsed.success) throw new AppError('项目数据格式不正确，未保存更改。')
      try { await atomicJson(join(previous.directory, 'project.json'), parsed.data) } catch { throw new AppError('项目保存失败，请检查存储位置、空间和权限。') }
      this.projects.set(id, parsed.data)
      this.notify(parsed.data)
      return structuredClone(parsed.data)
    })
  }

  async pathForAsset(projectId: string, kind: AssetKind, assetId: string): Promise<string> {
    const project = this.current(projectId)
    if (!idSchema.safeParse(assetId).success || !['audio', 'image', 'video', 'preview'].includes(kind)) throw new AppError('素材标识或类型不正确。')
    if (kind === 'video' || kind === 'preview') {
      const job = project.videoJobs.find(item => item.id === assetId && item.kind === kind && item.status === 'succeeded')
      if (!job?.fileName) throw new AppError('此项目中不存在已完成的视频或试听素材')
      return existingAssetPath(project.directory, kind, job.id, job.fileName)
    }
    const asset = (kind === 'audio' ? project.audio : project.images).find(item => item.id === assetId)
    if (!asset) throw new AppError('此项目中不存在所选素材。')
    return existingAssetPath(project.directory, kind, asset.id, asset.fileName)
  }
}
