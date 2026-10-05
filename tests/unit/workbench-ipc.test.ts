import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { registerWorkbenchIPC } from '../../src/main/workbench-ipc'
import { initialComposition, initialEntry } from '../../src/shared/workbench-schemas'
import type { WorkbenchService } from '../../src/main/workbench-service'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

const mocked = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; value?: unknown }>>(), open: vi.fn(), save: vi.fn(), copy: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean }>) => mocked.handlers.set(name, callback) }, dialog: { showOpenDialog: mocked.open, showSaveDialog: mocked.save }, shell: { showItemInFolder: vi.fn() }, clipboard: { writeText: mocked.copy } }))
beforeEach(() => { mocked.handlers.clear(); vi.clearAllMocks() })
function fixture() {
  const frame = { url: 'file:///isolated/renderer/index.html' }, contents = { mainFrame: frame }, window = { webContents: contents } as unknown as BrowserWindow
  const release = vi.fn(), asset = randomUUID(), diagnosticId = randomUUID()
  const service = {
    deps: { assets: { all: vi.fn(async () => []), importFiles: vi.fn(), get: vi.fn(async () => ({ name: 'isolated fixture' })), pathForAsset: vi.fn(async () => 'C:\\isolated\\audio.flac'), pin: vi.fn(async () => release) }, db: { list: vi.fn(() => []) } },
    snapshot: vi.fn(async () => ({ apis: [], generationProjects: [], compositionProjects: [], assets: [] })),
    track: vi.fn(async (action: () => Promise<unknown>) => action()), updateSettings: vi.fn(),
    generationProjects: { create: vi.fn(async () => ({ id: asset })), update: vi.fn(), delete: vi.fn(), add: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(), createPromptEntries: vi.fn(), promptImportStatus: vi.fn() },
    compositionProjects: { create: vi.fn(async () => ({ id: asset })), update: vi.fn(), delete: vi.fn() },
    generation: { submit: vi.fn(), resume: vi.fn() }, composition: { start: vi.fn(), cancelJob: vi.fn(), queuedIds: vi.fn(() => []) },
    apis: { save: vi.fn(), test: vi.fn(async () => ({ message: 'read-only isolated fixture' })) },
    diagnostics: { list: vi.fn(async () => []), get: vi.fn(() => ({ id: diagnosticId, stderr: '[address removed]' })) }, deleteAsset: vi.fn()
  }
  registerWorkbenchIPC(window, frame.url, service as unknown as WorkbenchService)
  const event = { sender: contents, senderFrame: frame }
  const call = (method: string, ...args: unknown[]) => mocked.handlers.get(`canvas:workbench:${method}`)!(event, ...args)
  return { frame, contents, event, call, service, release, asset, diagnosticId }
}

describe('current V4 strict IPC boundary', () => {
  it('registers only the new explicit channels and never a legacy workbench or raw secret/path interface', async () => {
    const f = fixture()
    expect([...mocked.handlers.keys()].every(name => name.startsWith('canvas:workbench:'))).toBe(true)
    for (const old of ['canvas:bootstrap', 'canvas:video:export', 'canvas:projects:get', 'canvas:keys:get', 'canvas:workbench:startVideo', 'canvas:workbench:getKey', 'canvas:workbench:updateDefaults']) expect(mocked.handlers.has(old)).toBe(false)
    expect((await f.call('bootstrap')).ok).toBe(true); expect(f.service.snapshot).toHaveBeenCalledOnce()
  })
  it('rejects foreign webContents, subframes and a navigated renderer before performing work', async () => {
    const f = fixture(), handler = mocked.handlers.get('canvas:workbench:deleteAsset')!
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.frame.url } }]) expect((await handler(event, f.asset)).ok).toBe(false)
    f.frame.url = 'https://untrusted.invalid/'
    const result = await handler(f.event, f.asset); expect(result.ok).toBe(false); expect(result.error).toContain('非应用页面')
    expect(f.service.deleteAsset).not.toHaveBeenCalled(); expect(f.service.track).not.toHaveBeenCalled()
  })
  it.each(['../secrets.json', 'C:\\outside\\video.mp4', 'https://example.invalid/file', 'not-a-uuid'])('does not accept a path or arbitrary locator as an asset ID: %s', async id => {
    const f = fixture(); expect((await f.call('deleteAsset', id)).ok).toBe(false); expect((await f.call('exportAsset', id)).ok).toBe(false)
    expect(f.service.deleteAsset).not.toHaveBeenCalled(); expect(f.service.deps.assets.pin).not.toHaveBeenCalled()
  })
  it('rejects repeat counts, caller paths, negative revisions and out-of-range resource settings', async () => {
    const f = fixture(), draft = initialEntry('audio', 'reapi')
    expect((await f.call('updateEntry', f.asset, 0, { ...draft, count: 20 }, {})).ok).toBe(false)
    expect((await f.call('updateEntry', f.asset, -1, draft, {})).ok).toBe(false)
    expect((await f.call('updateCompositionProject', f.asset, 0, { draft: { ...initialComposition(), outputPath: 'C:\\outside' } })).ok).toBe(false)
    expect((await f.call('updateSettings', { mediaRoot: 'C:\\outside' })).ok).toBe(false)
    expect((await f.call('updateSettings', { render: { concurrency: 9, threads: 4, encoder: 'cpu', staticVideo: true } })).ok).toBe(false)
    expect(f.service.track).not.toHaveBeenCalled()
  })
  it('allows incomplete editable drafts but routes submission separately with exact identities', async () => {
    const f = fixture(), entryId = randomUUID(), submissionId = randomUUID(), draft = initialEntry('audio')
    expect((await f.call('updateEntry', entryId, 0, draft, {})).ok).toBe(true)
    expect(f.service.generationProjects.updateEntry).toHaveBeenCalledWith(entryId, 0, draft, {})
    const selection = { projectId: f.asset, submissionId, entries: [{ id: entryId, revision: 0 }] }
    expect((await f.call('submitEntries', selection)).ok).toBe(true); expect(f.service.generation.submit).toHaveBeenCalledWith(selection)
    expect((await f.call('submitEntries', { ...selection, count: 2 })).ok).toBe(false)
    expect(f.service.generation.submit).toHaveBeenCalledOnce()
  })
  it('uses the native import choice, refuses caller file lists and manual video imports', async () => {
    const f = fixture(); mocked.open.mockResolvedValue({ canceled: true, filePaths: [] })
    expect((await f.call('importAssets', 'audio', ['C:\\outside\\secret'])).ok).toBe(false)
    expect((await f.call('importAssets', 'video')).ok).toBe(false)
    expect(await f.call('importAssets', 'audio')).toEqual({ ok: true, value: { entries: [], cancelled: true } })
    expect(mocked.open).toHaveBeenCalledOnce(); expect(f.service.deps.assets.importFiles).not.toHaveBeenCalled()
  })
  it('releases its export lease even if the native save dialog fails', async () => {
    const f = fixture(); mocked.save.mockRejectedValueOnce(new Error('isolated native dialog failure'))
    expect((await f.call('exportAsset', f.asset)).ok).toBe(false)
    expect(f.service.deps.assets.pin).toHaveBeenCalledWith([f.asset], `save-as:${f.asset}`); expect(f.release).toHaveBeenCalledOnce()
  })
  it('copies only a saved diagnostic by ID, not caller-provided log content', async () => {
    const f = fixture(); expect((await f.call('copyDiagnostic', f.diagnosticId, 'Authorization: Bearer synthetic')).ok).toBe(false)
    expect(mocked.copy).not.toHaveBeenCalled()
    expect((await f.call('copyDiagnostic', f.diagnosticId)).ok).toBe(true)
    expect(mocked.copy).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ id: f.diagnosticId, stderr: '[address removed]' }, null, 2))
  })
  it('only permits a bounded draft batch and identity lookup, never a caller path or remote request', async () => {
    const f = fixture(), input = { projectId: f.asset, kind: 'audio', batchId: randomUUID(), drafts: [{ ...initialEntry('audio'), prompt: '本地文本' }] }
    expect((await f.call('createPromptEntries', input)).ok).toBe(true)
    expect(f.service.generationProjects.createPromptEntries).toHaveBeenCalledExactlyOnceWith(input)
    expect((await f.call('createPromptEntries', { ...input, filePath: 'C:\\outside.md' })).ok).toBe(false)
    expect((await f.call('createPromptEntries', { ...input, drafts: [{ ...input.drafts[0], requestId: randomUUID() }] })).ok).toBe(false)
    const identity = { projectId: input.projectId, kind: input.kind, batchId: input.batchId }
    expect((await f.call('promptImportStatus', identity)).ok).toBe(true)
    expect(f.service.generation.submit).not.toHaveBeenCalled(); expect(f.service.apis.test).not.toHaveBeenCalled()
  })
  it('exports only built-in UTF-8 templates through the native save choice, and cancellation is not an error', async () => {
    const f = fixture(), root = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR!, 'v402-template-save-'))
    try {
      mocked.save.mockResolvedValueOnce({ canceled: true })
      expect(await f.call('savePromptTemplate', 'audio')).toEqual({ ok: true, value: null })
      expect((await f.call('savePromptTemplate', 'audio', 'C:\\caller.md')).ok).toBe(false)
      expect((await f.call('savePromptTemplate', '../secrets.json')).ok).toBe(false)
      for (const [kind, name] of [['audio', '音乐提示词模板.md'], ['image', '图片提示词模板.md']]) {
        const file = path.join(root, name); mocked.save.mockResolvedValueOnce({ canceled: false, filePath: file })
        expect(await f.call('savePromptTemplate', kind)).toEqual({ ok: true, value: file })
        expect(mocked.save.mock.calls.at(-1)?.[1]).toMatchObject({ defaultPath: name, filters: [{ extensions: ['md'] }] })
        expect(await readFile(file)).toEqual(await readFile(path.join('docs/templates', name)))
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('guards the new imports and template export against foreign frames before any dialog or write', async () => {
    const f = fixture()
    for (const method of ['createPromptEntries', 'promptImportStatus', 'savePromptTemplate']) {
      expect((await mocked.handlers.get(`canvas:workbench:${method}`)!({ ...f.event, sender: {} }, 'audio')).ok).toBe(false)
    }
    expect(f.service.track).not.toHaveBeenCalled(); expect(mocked.save).not.toHaveBeenCalled()
  })
})
