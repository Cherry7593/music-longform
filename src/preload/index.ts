import { contextBridge, ipcRenderer } from 'electron'
import type { IPCResult } from '../shared/types'
import type { WorkbenchAPI } from '../shared/workbench-types'

async function invoke<T>(method: keyof WorkbenchAPI, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(`canvas:workbench:${method}`, ...args) as IPCResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const api: WorkbenchAPI = {
  bootstrap: () => invoke('bootstrap'),
  createGenerationProject: () => invoke('createGenerationProject'),
  updateGenerationProject: (id, patch) => invoke('updateGenerationProject', id, patch),
  generationProjectImpact: id => invoke('generationProjectImpact', id),
  deleteGenerationProject: id => invoke('deleteGenerationProject', id),
  addEntry: (id, kind, copyId) => invoke('addEntry', id, kind, copyId),
  updateEntry: (id, revision, draft, alternatives) => invoke('updateEntry', id, revision, draft, alternatives),
  deleteEntry: id => invoke('deleteEntry', id),
  submitEntries: selection => invoke('submitEntries', selection),
  stopGeneration: id => invoke('stopGeneration', id),
  resumeRequest: id => invoke('resumeRequest', id),
  abandonRequest: id => invoke('abandonRequest', id),
  listApis: () => invoke('listApis'),
  saveApi: input => invoke('saveApi', input),
  apiImpact: provider => invoke('apiImpact', provider),
  deleteApi: provider => invoke('deleteApi', provider),
  testApi: input => invoke('testApi', input),
  getAceStepModels: () => invoke('getAceStepModels'),
  createCompositionProject: () => invoke('createCompositionProject'),
  updateCompositionProject: (id, revision, patch) => invoke('updateCompositionProject', id, revision, patch),
  compositionProjectImpact: id => invoke('compositionProjectImpact', id),
  deleteCompositionProject: id => invoke('deleteCompositionProject', id),
  planComposition: (id, revision) => invoke('planComposition', id, revision),
  reviseCompositionPlan: (id, planId, groups) => invoke('reviseCompositionPlan', id, planId, groups),
  startComposition: (id, planId) => invoke('startComposition', id, planId),
  pauseBatch: id => invoke('pauseBatch', id),
  continueBatch: id => invoke('continueBatch', id),
  cancelBatch: id => invoke('cancelBatch', id),
  cancelRenderJob: (batchId, jobId) => invoke('cancelRenderJob', batchId, jobId),
  cancelComposition: id => invoke('cancelComposition', id),
  getAssets: () => invoke('getAssets'),
  refreshAssets: () => invoke('refreshAssets'),
  importAssets: kind => invoke('importAssets', kind),
  renameAsset: (id, name) => invoke('renameAsset', id, name),
  assetImpact: id => invoke('assetImpact', id),
  deleteAsset: id => invoke('deleteAsset', id),
  exportAsset: id => invoke('exportAsset', id),
  revealAsset: id => invoke('revealAsset', id),
  updateSettings: patch => invoke('updateSettings', patch),
  chooseMediaRoot: () => invoke('chooseMediaRoot'),
  checkVideoTools: () => invoke('checkVideoTools'),
  chooseFFmpeg: () => invoke('chooseFFmpeg'),
  resetFFmpeg: () => invoke('resetFFmpeg'),
  getDiagnostics: id => invoke('getDiagnostics', id),
  copyDiagnostic: id => invoke('copyDiagnostic', id),
  onChanged: listener => { const handler = () => listener(); ipcRenderer.on('canvas:workbench:changed', handler); return () => { ipcRenderer.removeListener('canvas:workbench:changed', handler) } }
}
contextBridge.exposeInMainWorld('canvas', api)
