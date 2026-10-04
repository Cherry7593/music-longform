import { contextBridge, ipcRenderer } from 'electron'
import type { CanvasAPI, IPCResult, Project } from '../shared/types'
import type { VideoBatch } from '../shared/library-types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IPCResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const api: CanvasAPI = {
  getLibrary: () => invoke('canvas:library:get'),
  refreshLibrary: () => invoke('canvas:library:refresh'),
  importLibrary: kind => invoke('canvas:library:import', kind),
  chooseLibraryRoot: () => invoke('canvas:library:choose-root'),
  exportLibraryAsset: id => invoke('canvas:library:export', id),
  revealLibraryAsset: id => invoke('canvas:library:reveal', id),
  getGenerationProject: () => invoke('canvas:generation:project'),
  planBatch: request => invoke('canvas:batch:plan', request),
  reviseBatchPlan: (id, groups) => invoke('canvas:batch:revise', id, groups),
  startBatch: id => invoke('canvas:batch:start', id),
  listVideoBatches: () => invoke('canvas:batch:list'),
  pauseVideoBatch: id => invoke('canvas:batch:pause', id),
  continueVideoBatch: id => invoke('canvas:batch:continue', id),
  cancelVideoBatch: id => invoke('canvas:batch:cancel', id),
  exportBatchVideo: (id, jobId) => invoke('canvas:batch:export', id, jobId),
  revealBatchVideo: (id, jobId) => invoke('canvas:batch:reveal', id, jobId),
  onLibraryChanged: listener => {
    const handler = (): void => listener()
    ipcRenderer.on('canvas:library-changed', handler)
    return () => ipcRenderer.removeListener('canvas:library-changed', handler)
  },
  onVideoBatchChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, batch: VideoBatch): void => listener(batch)
    ipcRenderer.on('canvas:batch-changed', handler)
    return () => ipcRenderer.removeListener('canvas:batch-changed', handler)
  },
  bootstrap: () => invoke('canvas:bootstrap'),
  listProjects: () => invoke('canvas:projects:list'),
  createProject: () => invoke('canvas:projects:create'),
  getProject: (id) => invoke('canvas:projects:get', id),
  updateProject: (id, patch) => invoke('canvas:projects:update', id, patch),
  getSettings: () => invoke('canvas:settings:get'),
  updateSettings: (patch) => invoke('canvas:settings:update', patch),
  chooseDirectory: () => invoke('canvas:directory:choose'),
  setKey: (provider, key) => invoke('canvas:keys:set', provider, key),
  clearKey: (provider) => invoke('canvas:keys:clear', provider),
  checkKey: (provider) => invoke('canvas:keys:check', provider),
  startMusic: (id) => invoke('canvas:music:start', id),
  stopMusic: (id, batchId) => invoke('canvas:music:stop', id, batchId),
  continueMusic: (id, batchId) => invoke('canvas:music:continue', id, batchId),
  retryMusicJob: (id, jobId) => invoke('canvas:music:retry-query', id, jobId),
  startImage: (id) => invoke('canvas:image:start', id),
  keepAudio: (id, assetId, kept) => invoke('canvas:audio:keep', id, assetId, kept),
  selectImage: (id, assetId) => invoke('canvas:image:select', id, assetId),
  openProjectDirectory: (id) => invoke('canvas:directory:open', id),
  exportAsset: (id, kind, assetId) => invoke('canvas:asset:export', id, kind, assetId),
  revealAsset: (id, kind, assetId) => invoke('canvas:asset:reveal', id, kind, assetId),
  checkVideoTools: () => invoke('canvas:video:tools'),
  chooseFFmpeg: () => invoke('canvas:video:choose-ffmpeg'),
  resetFFmpeg: () => invoke('canvas:video:reset-ffmpeg'),
  analyzeVideo: (id) => invoke('canvas:video:analyze', id),
  startVideo: (id) => invoke('canvas:video:start', id),
  previewTransition: (id, index) => invoke('canvas:video:preview', id, index),
  cancelVideo: (id, jobId) => invoke('canvas:video:cancel', id, jobId),
  onProjectChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, project: Project): void => listener(project)
    ipcRenderer.on('canvas:project-changed', handler)
    return () => ipcRenderer.removeListener('canvas:project-changed', handler)
  }
}
contextBridge.exposeInMainWorld('canvas', api)
