import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { registerIPC } from '../../src/main/ipc'
import { LocalLibraryWork } from '../../src/main/library/ipc'
import { DEFAULT_IMAGE, DEFAULT_MUSIC } from '../../src/shared/schemas'
import { DEFAULT_BATCH_OPTIONS } from '../../src/shared/batch-schemas'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: string }>>())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((name, handler) => handlers.set(name, handler)) }, dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), copyFile: vi.fn(async () => undefined) }))
beforeEach(() => { vi.clearAllMocks(); handlers.clear() })
function fixture() {
  const frame = { url: 'file:///renderer/index.html' }; const contents = { mainFrame: frame }
  const window = { webContents: contents } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const config: { version: 1; root: string; generationProjectId?: string } = { version: 1, root: 'C:\\fixture-library' }
  const created = { id: randomUUID(), name: '素材生成' }
  const projects = { list: vi.fn(async () => []), all: vi.fn(async () => []), get: vi.fn(async () => created), create: vi.fn(async () => created), patch: vi.fn(async () => created), warnings: [] }
  const settings = { get: () => ({ version: 3, projectRoot: 'C:\\fixture-projects', musicDefaults: DEFAULT_MUSIC, imageDefaults: DEFAULT_IMAGE }), update: vi.fn() }
  const library = { getConfig: () => config, all: vi.fn(async () => []), refresh: vi.fn(), configureRoot: vi.fn(async () => config), warnings: [],
    importFiles: vi.fn(async () => ({ entries: [], cancelled: false })), setGenerationProject: vi.fn(async (id: string) => { config.generationProjectId = id }),
    get: vi.fn(), pathForAsset: vi.fn() }
  const batches = { all: vi.fn(async () => []), get: vi.fn(), pathForAsset: vi.fn() }
  const batchJobs = { plan: vi.fn(), revise: vi.fn(), start: vi.fn(), pause: vi.fn(), continue: vi.fn(), cancel: vi.fn() }
  const work = new LocalLibraryWork()
  const libraryServices = { library, projects, settings, batches, batchJobs, receipts: { all: () => [], warnings: [] }, work }
  const deps = { projects, settings, secrets: { has: () => false, isAvailable: () => true }, jobs: {}, video: {}, music: {}, images: {}, testMode: true, libraryServices }
  registerIPC(window, frame.url, deps as unknown as Parameters<typeof registerIPC>[2])
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args)
  return { call, event, library, projects, batchJobs, batches, work }
}
describe('global library IPC boundaries', () => {
  it('accepts imports only via native multi-file chooser, never renderer-supplied paths', async () => {
    const f = fixture()
    for (const input of [['audio', ['C:\\secret']], [['C:\\secret']], ['video']]) expect((await f.call('canvas:library:import', ...input)).ok).toBe(false)
    expect(dialog.showOpenDialog).not.toHaveBeenCalled(); expect(f.library.importFiles).not.toHaveBeenCalled()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['C:\\chosen.wav'] })
    expect((await f.call('canvas:library:import', 'audio')).ok).toBe(true)
    expect(f.library.importFiles).toHaveBeenCalledExactlyOnceWith(['C:\\chosen.wav'], 'audio')
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ properties: ['openFile', 'multiSelections'] }))
  })
  it('cancelling chooser performs no media writes', async () => {
    const f = fixture(); vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await f.call('canvas:library:import', 'image')).toMatchObject({ ok: true, value: { cancelled: true, entries: [] } })
    expect(f.library.importFiles).not.toHaveBeenCalled()
  })
  it('holds import reservation until disk processing completes', async () => {
    const f = fixture(); let finish!: () => void
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['C:\\chosen.wav'] })
    f.library.importFiles.mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r }); return { entries: [], cancelled: false } })
    const first = f.call('canvas:library:import', 'audio')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect((await f.call('canvas:library:import', 'image')).ok).toBe(false)
    expect(f.work.busy).toBe(true)
    finish(); await first; await f.work.idle(); expect(f.work.busy).toBe(false)
  })
  it('rejects foreign senders/frames before global reads or batch actions', async () => {
    const f = fixture()
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
      expect((await handlers.get('canvas:library:get')!(event)).ok).toBe(false)
      expect((await handlers.get('canvas:batch:start')!(event, randomUUID())).ok).toBe(false)
    }
    expect(f.library.all).not.toHaveBeenCalled(); expect(f.batchJobs.start).not.toHaveBeenCalled()
  })
  it('rejects arbitrary IDs, paths, duplicate selections and extra batch fields', async () => {
    const f = fixture()
    expect((await f.call('canvas:library:reveal', '../outside')).ok).toBe(false)
    const audio = randomUUID(), image = randomUUID()
    const request = { ...DEFAULT_BATCH_OPTIONS, name: '批次', audioIds: [audio], imageIds: [image] }
    for (const input of [{ ...request, directory: 'C:\\outside' }, { ...request, audioIds: [audio, audio] }, { ...request, minimumSeconds: 5 }]) expect((await f.call('canvas:batch:plan', input)).ok).toBe(false)
    expect(f.batchJobs.plan).not.toHaveBeenCalled()
    expect((await f.call('canvas:batch:plan', request)).ok).toBe(true)
    expect(f.batchJobs.plan).toHaveBeenCalledExactlyOnceWith(request)
  })
  it('serializes automatic generation-session creation and does not create a project for library reads', async () => {
    const f = fixture()
    expect((await f.call('canvas:library:get')).ok).toBe(true); expect(f.projects.create).not.toHaveBeenCalled()
    const results = await Promise.all([f.call('canvas:generation:project'), f.call('canvas:generation:project')])
    expect(results.every(r => r.ok)).toBe(true)
    expect(f.projects.create).toHaveBeenCalledTimes(1); expect(f.library.setGenerationProject).toHaveBeenCalledTimes(1)
    expect(results[0].value).toEqual(results[1].value)
  })
  it('root selection cannot smuggle an arbitrary destination as arguments', async () => {
    const f = fixture()
    expect((await f.call('canvas:library:choose-root', 'C:\\outside')).ok).toBe(false)
    expect(dialog.showOpenDialog).not.toHaveBeenCalled(); expect(f.library.configureRoot).not.toHaveBeenCalled()
  })
})

it.each(['library', 'batch'] as const)('shutdown waits for %s Save As to finish copying', async kind => {
  const f = fixture(); const id = randomUUID(); const jobId = randomUUID()
  f.library.get.mockResolvedValue({ name: '素材', kind: 'audio' })
  f.library.pathForAsset.mockResolvedValue('C:\\owned\\source.wav')
  f.batches.get.mockResolvedValue({ name: '批次', jobs: [{ id: jobId, index: 0 }] })
  f.batches.pathForAsset.mockResolvedValue('C:\\owned\\source.mp4')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: 'C:\\exported\\copy.mp4' })
  let finish!: () => void
  vi.mocked(copyFile).mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r }) })
  const saved = f.call(`canvas:${kind}:export`, id, ...(kind === 'batch' ? [jobId] : []))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(f.work.busy).toBe(true)
  let closed = false
  const closing = f.work.shutdown().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  finish(); expect((await saved).ok).toBe(true); await closing
  expect(closed).toBe(true); expect(f.work.busy).toBe(false)
})
