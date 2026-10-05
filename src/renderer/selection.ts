import { useState } from 'react'
import type { AssetOrigin, GenerationEntry, GenerationKind, GenerationProject, MediaKind, WorkbenchAsset } from '../shared/workbench-types'
import type { WorkspaceStore } from './useWorkspace'

export type SourceFilter = 'all' | 'import' | 'unassigned' | `project:${string}`
export interface SourceOption { value: SourceFilter; label: string }
// Kept in step with compositionDraftSchema; the boundary is also checked before Apply.
export const COMPOSITION_SELECTION_LIMITS = { audio: 10000, image: 100 } as const
const isProjectOrigin = (origin: AssetOrigin): boolean => origin.type === 'generation' || origin.type === 'legacy'

export function matchesSource(asset: WorkbenchAsset, source: SourceFilter): boolean {
  if (source === 'all') return true
  if (source === 'import') return asset.origins.some(origin => origin.type === 'import')
  if (source === 'unassigned') return !asset.origins.length || asset.origins.some(origin => origin.type !== 'import' && !origin.projectId)
  const projectId = source.slice('project:'.length)
  return asset.origins.some(origin => isProjectOrigin(origin) && origin.projectId === projectId)
}

export function sourceOptions(assets: readonly WorkbenchAsset[], projects: readonly GenerationProject[]): SourceOption[] {
  const options: SourceOption[] = [{ value: 'all', label: '全部来源' }, { value: 'import', label: '本地导入' }]
  const active = new Map(projects.filter(project => !project.deletedAt).map(project => [project.id, project]))
  // Full IDs also disambiguate projects whose current names (or snapshots) are identical.
  for (const project of active.values()) options.push({ value: `project:${project.id}`, label: `${project.name} · ${project.id}` })
  const historical = new Map<string, string>()
  for (const asset of assets) for (const origin of asset.origins) {
    if (isProjectOrigin(origin) && origin.projectId && !active.has(origin.projectId) && !historical.has(origin.projectId)) historical.set(origin.projectId, origin.name || '未命名来源')
  }
  for (const [id, name] of historical) options.push({ value: `project:${id}`, label: `${name} · ${id}（已删除 / 未知项目）` })
  if (assets.some(asset => matchesSource(asset, 'unassigned'))) options.push({ value: 'unassigned', label: '历史 / 未归属来源' })
  return options
}

export function sourceAssets(assets: readonly WorkbenchAsset[], kind: MediaKind, source: SourceFilter = 'all'): WorkbenchAsset[] {
  const seen = new Set<string>()
  return assets.filter(asset => {
    if (asset.kind !== kind || !matchesSource(asset, source) || seen.has(asset.id)) return false
    seen.add(asset.id)
    return true
  })
}

/** Atomic append: keep the user's order, append new candidates in source order, never truncate. */
export function appendSelection(selected: readonly string[], candidates: Iterable<string>, maximum = Infinity): string[] {
  const next = [...selected], seen = new Set(selected)
  for (const id of candidates) if (!seen.has(id)) { next.push(id); seen.add(id) }
  if (next.length > maximum) throw new Error(`最多可选择 ${maximum} 项，本次操作将达到 ${next.length} 项；原选择未更改，请减少选择。`)
  return next
}

export function selectAvailable(selected: readonly string[], candidates: readonly WorkbenchAsset[], maximum = Infinity): string[] {
  return appendSelection(selected, candidates.filter(asset => asset.available).map(asset => asset.id), maximum)
}

/** The removal scope deliberately includes unavailable assets. */
export function deselectSelection(selected: readonly string[], scope: Iterable<string>): string[] {
  const removed = new Set(scope)
  return selected.filter(id => !removed.has(id))
}

export function replaceSelection(selected: readonly string[], previous: string, next: string): string[] {
  if (!selected.includes(previous)) throw new Error('待替换素材已改变，请重新选择。')
  if (selected.includes(next)) throw new Error('此素材已经选中，不能重复添加。')
  return selected.map(id => id === previous ? next : id)
}

export function pendingEntries(entries: readonly GenerationEntry[], projectId: string, kind: GenerationKind): GenerationEntry[] {
  return entries.filter(entry => entry.projectId === projectId && entry.kind === kind && !entry.requestId && !entry.deletedAt)
}

export function generationSubmissionIssue(count: number): string | undefined {
  if (!count) return '没有待提交条目'
  if (count > 500) return `单次最多提交 500 个条目，当前选择 ${count} 个；请减少选择后分批提交。本次未提交任何条目。`
  return undefined
}

// Session-only UI state: no bridge writes, draft changes, credentials or persistence.
const generationSelections = new WeakMap<WorkspaceStore, Map<string, Set<string>>>()
export function getGenerationSelection(store: WorkspaceStore, projectId: string): Set<string> {
  return new Set(generationSelections.get(store)?.get(projectId))
}
export function updateGenerationSelection(store: WorkspaceStore, projectId: string, change: (selected: Set<string>) => Set<string>): Set<string> {
  let projects = generationSelections.get(store)
  if (!projects) { projects = new Map(); generationSelections.set(store, projects) }
  const next = change(getGenerationSelection(store, projectId))
  projects.set(projectId, new Set(next))
  return next
}
export function useGenerationSelection(store: WorkspaceStore, projectId: string) {
  // GenerationWorkspace is keyed by project.id; cache synchronously before a possible remount.
  const [selected, setSelected] = useState(() => getGenerationSelection(store, projectId))
  const update = (change: (selected: Set<string>) => Set<string>): void => { setSelected(updateGenerationSelection(store, projectId, change)) }
  return [selected, update] as const
}
