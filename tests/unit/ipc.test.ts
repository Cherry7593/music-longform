import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { registerIPC } from '../fixtures/v31/main/ipc'
import { AppError } from '../../src/main/providers/http'
import { DEFAULT_IMAGE, DEFAULT_MUSIC } from '../../src/shared/schemas'
import type { Provider, Settings } from '../../src/shared/types'
import { defaultAceStepSettings } from '../../src/main/storage/migrations'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: string }>>())
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((name, handler) => handlers.set(name, handler)) },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() }
}))
beforeEach(() => handlers.clear())
const musicKey = 'sk-mureka-ipc-fixture-only'
const imageKey = 'sk-siliconflow-ipc-fixture-only'
function fixture(imageConfigured = false) {
  const frame = { url: 'file:///renderer/index.html' }
  const contents = { mainFrame: frame }
  const window = { webContents: contents } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const settings: Settings = { version: 4, aceStep: defaultAceStepSettings(), projectRoot: 'C:\\projects', musicDefaults: structuredClone(DEFAULT_MUSIC), imageDefaults: structuredClone(DEFAULT_IMAGE) }
  const keys: Partial<Record<Provider, string>> = { mureka: musicKey, ...(imageConfigured ? { siliconflow: imageKey } : {}) }
  const deps = {
    projects: { list: vi.fn(async () => []), get: vi.fn(async () => ({})), patch: vi.fn(), warnings: [] },
    settings: { get: () => settings, update: vi.fn() },
    secrets: {
      has: vi.fn((provider: Provider) => keys[provider] !== undefined), isAvailable: () => true,
      set: vi.fn(async (provider: Provider, key: string) => { keys[provider] = key }),
      clear: vi.fn(async (provider: Provider) => { delete keys[provider] }),
      get: vi.fn((provider: Provider) => { const key = keys[provider]; if (!key) throw new AppError('尚未配置此服务商的 API 密钥'); return key })
    },
    jobs: { startImage: vi.fn(), startMusic: vi.fn() }, video: {},
    music: { create: vi.fn(), query: vi.fn(), check: vi.fn(async () => ({ message: 'Mureka 只读检查', balanceCents: 123 })) },
    images: { generate: vi.fn(), check: vi.fn(async () => ({ message: '硅基流动图片模型可访问，未验证生图额度' })) }, testMode: true
  }
  registerIPC(window, frame.url, deps as unknown as Parameters<typeof registerIPC>[2])
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args)
  return { call, event, deps }
}
function expectNoGeneration(deps: ReturnType<typeof fixture>['deps']): void {
  expect(deps.images.generate).not.toHaveBeenCalled()
  expect(deps.music.create).not.toHaveBeenCalled()
  expect(deps.music.query).not.toHaveBeenCalled()
  expect(deps.jobs.startImage).not.toHaveBeenCalled()
  expect(deps.jobs.startMusic).not.toHaveBeenCalled()
}

describe('IPC boundary', () => {
  it('exposes only current credential presence in settings and bootstrap, never secret material', async () => {
    const f = fixture()
    const result = await f.call('canvas:settings:get')
    expect(result).toEqual({ ok: true, value: { ...f.deps.settings.get(), keys: { mureka: true, 'mureka-cn': false, siliconflow: false, kie: false, reapi: false, sunor: false, acestep: false }, encryptionAvailable: true } })
    const bootstrap = await f.call('canvas:bootstrap')
    expect(bootstrap.ok).toBe(true)
    expect(bootstrap.value).toMatchObject({ settings: result.value })
    expect(f.deps.secrets.has.mock.calls.map(([provider]) => provider)).toEqual(['mureka', 'siliconflow', 'kie', 'reapi', 'sunor', 'acestep', 'mureka', 'siliconflow', 'kie', 'reapi', 'sunor', 'acestep'])
    expect(f.deps.secrets.get).not.toHaveBeenCalled()
    expect(JSON.stringify([result, bootstrap])).not.toContain(musicKey)
    expect(JSON.stringify([result, bootstrap])).not.toContain(imageKey)
    expect(JSON.stringify([result, bootstrap])).not.toContain('openai')
    expect(handlers.has('canvas:keys:get')).toBe(false)
  })

  it('accepts SiliconFlow save/clear and returns booleans without exposing the submitted key', async () => {
    const f = fixture()
    const saved = await f.call('canvas:keys:set', 'siliconflow', imageKey)
    expect(saved.ok).toBe(true)
    expect(saved.value).toMatchObject({ keys: { mureka: true, siliconflow: true } })
    expect(f.deps.secrets.set).toHaveBeenCalledExactlyOnceWith('siliconflow', imageKey, undefined)
    expect(JSON.stringify(saved)).not.toContain(imageKey)
    const cleared = await f.call('canvas:keys:clear', 'siliconflow')
    expect(cleared.ok).toBe(true)
    expect(cleared.value).toMatchObject({ keys: { mureka: true, siliconflow: false } })
    expect(f.deps.secrets.clear).toHaveBeenCalledExactlyOnceWith('siliconflow')
    expect(f.deps.secrets.get).not.toHaveBeenCalled()
    expect(f.deps.images.check).not.toHaveBeenCalled()
    expect(f.deps.music.check).not.toHaveBeenCalled()
    expectNoGeneration(f.deps)
  })

  it.each(['canvas:keys:set', 'canvas:keys:clear', 'canvas:keys:check'])('denies the legacy openai provider at %s before accessing any credentials', async channel => {
    const f = fixture(true)
    const result = await f.call(channel, 'openai', ...(channel === 'canvas:keys:set' ? ['sk-rejected-legacy-fixture'] : []))
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('sk-rejected-legacy-fixture')
    expect(f.deps.secrets.set).not.toHaveBeenCalled()
    expect(f.deps.secrets.clear).not.toHaveBeenCalled()
    expect(f.deps.secrets.get).not.toHaveBeenCalled()
    expect(f.deps.secrets.has).not.toHaveBeenCalled()
    expect(f.deps.images.check).not.toHaveBeenCalled()
    expect(f.deps.music.check).not.toHaveBeenCalled()
    expectNoGeneration(f.deps)
  })

  it('routes the SiliconFlow credential check only to images with its own key and never generates', async () => {
    const f = fixture(true)
    const result = await f.call('canvas:keys:check', 'siliconflow')
    expect(result).toEqual({ ok: true, value: { message: '硅基流动图片模型可访问，未验证生图额度' } })
    expect(f.deps.secrets.get).toHaveBeenCalledExactlyOnceWith('siliconflow')
    expect(f.deps.images.check).toHaveBeenCalledExactlyOnceWith(imageKey)
    expect(f.deps.music.check).not.toHaveBeenCalled()
    expectNoGeneration(f.deps)
  })

  it('keeps Mureka credential checks isolated from the image service and never generates', async () => {
    const f = fixture(true)
    expect(await f.call('canvas:keys:check', 'mureka')).toEqual({ ok: true, value: { message: 'Mureka 只读检查', balanceCents: 123 } })
    expect(f.deps.secrets.get).toHaveBeenCalledExactlyOnceWith('mureka')
    expect(f.deps.music.check).toHaveBeenCalledExactlyOnceWith(musicKey)
    expect(f.deps.images.check).not.toHaveBeenCalled()
    expectNoGeneration(f.deps)
  })

  it('does not borrow Mureka credentials when SiliconFlow has not been configured', async () => {
    const f = fixture()
    const result = await f.call('canvas:keys:check', 'siliconflow')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('尚未配置')
    expect(f.deps.secrets.get).toHaveBeenCalledExactlyOnceWith('siliconflow')
    expect(f.deps.images.check).not.toHaveBeenCalled()
    expect(f.deps.music.check).not.toHaveBeenCalled()
    expectNoGeneration(f.deps)
  })

  it('rejects another sender and another frame', async () => {
    const f = fixture()
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: 'file:///renderer/index.html' } }]) {
      const result = await handlers.get('canvas:projects:get')!(event, randomUUID())
      expect(result.ok).toBe(false)
      expect(result.error).toContain('非应用页面')
    }
    expect(f.deps.projects.get).not.toHaveBeenCalled()
  })

  it('rejects malformed IDs, payload fields and keys before performing work', async () => {
    const f = fixture()
    expect((await f.call('canvas:projects:get', '../../secret')).ok).toBe(false)
    expect((await f.call('canvas:projects:update', randomUUID(), { directory: 'C:\\outside' })).ok).toBe(false)
    const bad = 'private secret with spaces'
    const result = await f.call('canvas:keys:set', 'siliconflow', bad)
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(bad)
    expect(f.deps.secrets.set).not.toHaveBeenCalled()
    expect(f.deps.projects.get).not.toHaveBeenCalled()
    expect(f.deps.projects.patch).not.toHaveBeenCalled()
  })

  it('cannot change save root without the native directory chooser', async () => {
    const f = fixture()
    const result = await f.call('canvas:settings:update', { projectRoot: 'C:\\unauthorized' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('选择文件夹')
    expect(f.deps.settings.update).not.toHaveBeenCalled()
  })
})
