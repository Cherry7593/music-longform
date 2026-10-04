import { createHash } from 'node:crypto'
import type { LibraryKind, LibraryOrigin } from '../../shared/library-types'
import type { Project } from '../../shared/types'
import { AppError } from '../providers/http'
import { libraryFileName, localLibraryPath, type LibraryLocation } from '../storage/library-validation'
import { idSchema } from '../../shared/schemas'

export interface ProjectLibrarySource {
  kind: LibraryKind
  name: string
  createdAt: string
  origin: LibraryOrigin
  location: Extract<LibraryLocation, { type: 'project' }>
}
/** Only asset/provenance fields participate: job progress, selection and kept flags never trigger a decode. */
export function projectLibrarySources(project: Project): ProjectLibrarySource[] {
  if (!idSchema.safeParse(project.id).success || !localLibraryPath(project.directory)
    || !Array.isArray(project.audio) || !Array.isArray(project.images) || project.audio.length > 20000 || project.images.length > 20000) throw new AppError('项目素材结构或目录不正确，不能同步总素材库。')
  const sources: ProjectLibrarySource[] = []
  for (const kind of ['audio', 'image'] as const) {
    for (const asset of kind === 'audio' ? project.audio : project.images) {
      if (!libraryFileName(asset.fileName, kind, asset.id)) throw new AppError('项目素材标识或路径不正确，未修改原项目。')
      sources.push({
        kind, name: 'title' in asset ? asset.title || asset.fileName.split('/').pop()! : asset.fileName.split('/').pop()!, createdAt: asset.createdAt,
        origin: { type: 'project', name: project.name, projectId: project.id, assetId: asset.id, provider: 'provider' in asset ? asset.provider : 'mureka', model: asset.model, prompt: asset.prompt },
        location: { type: 'project', projectId: project.id, assetId: asset.id, directory: project.directory, fileName: asset.fileName }
      })
    }
  }
  return sources
}
export function projectLibrarySignature(sources: ProjectLibrarySource[]): string {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex')
}
