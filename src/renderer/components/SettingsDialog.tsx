import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, Film, FolderOpen, HardDrive, KeyRound, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { Provider, PublicSettings, VideoToolsStatus } from '../../shared/types'
import { keySchema, settingsPatchSchema } from '../../shared/schemas'
import { errorMessage, validationMessage } from '../utils'
import { Dialog } from './Dialog'
import { Banner } from './Common'
import { ImageParameters, MusicParameters } from './Parameters'

export type SettingsTab = 'keys' | 'defaults' | 'storage' | 'video'
type Tab = SettingsTab
const tabs = [
  { id: 'keys' as const, name: 'API 配置', icon: KeyRound },
  { id: 'defaults' as const, name: '默认生成参数', icon: SlidersHorizontal },
  { id: 'storage' as const, name: '本地存储', icon: HardDrive },
  { id: 'video' as const, name: '视频工具', icon: Film },
]
type Notice = { tone: 'success' | 'error' | 'info'; text: string }

export function SettingsDialog({ settings, onSaved, onClose, returnFocus, initialTab = 'keys' }: {
  settings: PublicSettings; onSaved: (settings: PublicSettings) => void; onClose: () => void; returnFocus: HTMLElement | null; initialTab?: SettingsTab
}) {
  const id = useId()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [tools, setTools] = useState<VideoToolsStatus | null>(null)
  const [current, setCurrent] = useState(settings)
  const [music, setMusic] = useState(() => structuredClone(settings.musicDefaults))
  const [image, setImage] = useState(() => structuredClone(settings.imageDefaults))
  const [root, setRoot] = useState(settings.projectRoot)
  const [draftKeys, setDraftKeys] = useState<Record<Provider, string>>({ mureka: '', siliconflow: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const lock = useRef(false)
  const [notice, setNotice] = useState<Partial<Record<Tab, Notice>>>({})
  const [clearConfirm, setClearConfirm] = useState<Provider | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const defaultsDirty = JSON.stringify(music) !== JSON.stringify(current.musicDefaults) || JSON.stringify(image) !== JSON.stringify(current.imageDefaults)
  const storageDirty = root !== current.projectRoot
  const dirty = defaultsDirty || storageDirty || Boolean(draftKeys.mureka || draftKeys.siliconflow)
  const defaultsValidation = settingsPatchSchema.safeParse({ musicDefaults: music, imageDefaults: image })

  function accept(next: PublicSettings): void { setCurrent(next); onSaved(next) }
  function close(): void {
    if (lock.current) return
    if (dirty) setDiscardConfirm(true)
    else onClose()
  }
  async function perform(key: string, action: () => Promise<string>): Promise<void> {
    if (lock.current) return
    lock.current = true
    setBusy(key)
    const activeTab = tab
    setNotice(previous => ({ ...previous, [activeTab]: undefined }))
    try {
      const text = await action()
      setNotice(previous => ({ ...previous, [activeTab]: { tone: 'success', text } }))
    } catch (error) {
      setNotice(previous => ({ ...previous, [activeTab]: { tone: 'error', text: errorMessage(error) } }))
    } finally { lock.current = false; setBusy(null) }
  }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = index
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    setTab(target.id)
    document.getElementById(`${id}-tab-${target.id}`)?.focus()
  }

  return <Dialog title="设置" className="settings-dialog" onClose={close} busy={Boolean(busy)} returnFocus={returnFocus}>
    {discardConfirm && <div className="settings-discard"><Banner tone="warning">
      <p>关闭将丢弃未保存的设置和密钥输入。</p>
      <div className="button-row"><button type="button" className="button danger" onClick={onClose}>放弃并关闭</button>
        <button type="button" className="button" onClick={() => setDiscardConfirm(false)}>继续编辑</button></div>
    </Banner></div>}
    <div className="settings-layout">
      <nav className="settings-nav" role="tablist" aria-label="设置类别" aria-orientation="vertical">
        {tabs.map(({ id: key, name, icon: Icon }, index) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`}
          aria-controls={`${id}-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={event => tabKeys(event, index)}><Icon size={17} />{name}</button>)}
      </nav>
      <div className="settings-content">
        <section role="tabpanel" id={`${id}-panel-keys`} aria-labelledby={`${id}-tab-keys`} hidden={tab !== 'keys'} tabIndex={0}>
          <h3>API 配置</h3><p className="section-description">密钥仅在本机加密保存，不回显。</p>
          <div className={`security-note ${!current.encryptionAvailable ? 'unavailable' : ''}`}>
            <ShieldCheck size={17} /><span>{current.encryptionAvailable ? '系统加密可用 · 不以明文保存密钥' : '系统加密不可用：不能保存密钥，不会降级为明文。'}</span>
          </div>
          {(['mureka', 'siliconflow'] as const).map(provider => <form key={provider} className="key-section" onSubmit={event => {
            event.preventDefault()
            void perform(`save-${provider}`, async () => {
              const parsed = keySchema.safeParse(draftKeys[provider])
              if (!parsed.success) throw new Error('密钥须为 8–4096 个 ASCII 字符，不能含空格。请检查后重试。')
              accept(await window.canvas.setKey(provider, parsed.data))
              setDraftKeys(previous => ({ ...previous, [provider]: '' }))
              return '已加密保存'
            })
          }}>
            <div className="section-row"><h4>{provider === 'mureka' ? 'Mureka · 音乐' : '硅基流动 · 图片'}</h4>
              <span className={`credential-state ${current.keys[provider] ? 'configured' : ''}`}>{current.keys[provider] ? <><Check size={13} />已配置</> : '未配置'}</span></div>
            <div className="field"><label htmlFor={`${id}-${provider}`}>{current.keys[provider] ? '替换密钥' : 'API 密钥'}</label>
              <input id={`${id}-${provider}`} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="off" value={draftKeys[provider]}
                disabled={Boolean(busy) || !current.encryptionAvailable} placeholder={current.keys[provider] ? '输入新密钥以替换' : '粘贴 API 密钥'}
                aria-describedby={`${id}-${provider}-note`} onChange={event => setDraftKeys(previous => ({ ...previous, [provider]: event.target.value }))} />
            </div>
            <p className="field-note" id={`${id}-${provider}-note`}>{provider === 'mureka'
              ? '只查询账户信息，不生成音乐。'
              : '只读检查鉴权和模型，不验证额度或生图效果。'}</p>
            <div className="button-row wrap">
              <button type="submit" className="button" disabled={Boolean(busy) || !draftKeys[provider].trim() || !current.encryptionAvailable}>
                {busy === `save-${provider}` ? '保存中…' : current.keys[provider] ? '替换并保存' : '保存密钥'}</button>
              <button type="button" className="button subtle" disabled={Boolean(busy) || !current.keys[provider]} onClick={() => {
                void perform(`check-${provider}`, async () => (await window.canvas.checkKey(provider)).message)
              }}>{busy === `check-${provider}` ? '检查中…' : '检查连接'}</button>
              <button type="button" className="text-button danger" disabled={Boolean(busy) || !current.keys[provider]} onClick={() => setClearConfirm(provider)}>清除</button>
            </div>
            {clearConfirm === provider && <div className="inline-confirm">
              <p>清除密钥？已有素材不受影响，生成前需重新配置。</p>
              <div className="button-row"><button type="button" className="button danger" disabled={Boolean(busy)} onClick={() => {
                void perform(`clear-${provider}`, async () => {
                  accept(await window.canvas.clearKey(provider)); setClearConfirm(null)
                  return '已清除密钥'
                })
              }}>确认清除</button><button type="button" className="button" disabled={Boolean(busy)} onClick={() => setClearConfirm(null)}>取消</button></div>
            </div>}
          </form>)}
          {notice.keys && <Banner tone={notice.keys.tone}>{notice.keys.text}</Banner>}
          <p className="privacy-note">密钥不写入项目、日志或浏览器存储；系统加密无法防御同一 Windows 用户下的恶意程序。</p>
        </section>
        <section role="tabpanel" id={`${id}-panel-defaults`} aria-labelledby={`${id}-tab-defaults`} hidden={tab !== 'defaults'} tabIndex={0}>
          <h3>默认生成参数</h3><p className="section-description">仅用于新项目，不改变当前项目及任务。</p>
          <div className="defaults-section"><h4>音乐</h4><MusicParameters value={music} onChange={setMusic} disabled={Boolean(busy)} /></div>
          <div className="defaults-section"><h4>图片</h4><ImageParameters value={image} onChange={setImage} disabled={Boolean(busy)} /></div>
          {!defaultsValidation.success && <Banner tone="error">{validationMessage(defaultsValidation.error)}</Banner>}
          {notice.defaults && <Banner tone={notice.defaults.tone}>{notice.defaults.text}</Banner>}
          <div className="settings-actions"><button type="button" className="button primary" disabled={Boolean(busy) || !defaultsDirty || !defaultsValidation.success} onClick={() => {
            void perform('defaults', async () => {
              const parsed = settingsPatchSchema.safeParse({ musicDefaults: music, imageDefaults: image })
              if (!parsed.success) throw new Error(validationMessage(parsed.error))
              const next = await window.canvas.updateSettings(parsed.data)
              accept(next); setMusic(next.musicDefaults); setImage(next.imageDefaults)
              return '已保存'
            })
          }}>{busy === 'defaults' ? '保存中…' : '保存默认参数'}</button></div>
        </section>
        <section role="tabpanel" id={`${id}-panel-storage`} aria-labelledby={`${id}-tab-storage`} hidden={tab !== 'storage'} tabIndex={0}>
          <h3>本地存储</h3>
          <div className="field"><label htmlFor={`${id}-root`}>新项目保存位置</label>
            <textarea className="directory-input" id={`${id}-root`} value={root} readOnly rows={3} aria-describedby={`${id}-root-note`} /></div>
          <div className="button-row"><button type="button" className="button" disabled={Boolean(busy)} onClick={() => {
            void perform('choose-directory', async () => {
              const directory = await window.canvas.chooseDirectory()
              if (!directory) return '已取消选择'
              setRoot(directory)
              return '已选择，请保存位置'
            })
          }}><FolderOpen size={16} />{busy === 'choose-directory' ? '选择中…' : '选择文件夹'}</button></div>
          <p className="storage-note" id={`${id}-root-note`}>仅用于新项目，已有项目不搬移或删除。</p>
          <details className="storage-details"><summary>项目目录结构</summary><div className="storage-tree"><span>项目文件夹</span><span>├ project.json <em>项目与任务记录</em></span><span>├ audio/ <em>音乐</em></span><span>├ images/ <em>图片</em></span><span>├ videos/ <em>视频</em></span><span>└ previews/ <em>连接处试听</em></span></div></details>
          {notice.storage && <Banner tone={notice.storage.tone}>{notice.storage.text}</Banner>}
          <div className="settings-actions"><button type="button" className="button primary" disabled={Boolean(busy) || !storageDirty} onClick={() => {
            void perform('storage', async () => {
              const next = await window.canvas.updateSettings({ projectRoot: root })
              accept(next); setRoot(next.projectRoot)
              return '已保存'
            })
          }}>{busy === 'storage' ? '保存中…' : '保存位置'}</button></div>
        </section>
        <section role="tabpanel" id={`${id}-panel-video`} aria-labelledby={`${id}-tab-video`} hidden={tab !== 'video'} tabIndex={0} data-testid="video-tools-panel">
          <h3>视频工具</h3><p className="section-description">需要本机 FFmpeg 与 FFprobe；不会自动下载或安装。</p>
          <div className="field"><label htmlFor={`${id}-ffmpeg`}>FFmpeg 路径</label><textarea id={`${id}-ffmpeg`} className="directory-input" readOnly rows={3}
            value={current.ffmpegPath ?? '自动检测系统 PATH 中的 FFmpeg 与 FFprobe'} /></div>
          <p className="field-note">核对同目录 FFprobe、编码器和滤镜，通过后立即保存。</p>
          <div className="button-row wrap">
            <button type="button" className="button" data-testid="video-tools-check" disabled={Boolean(busy)} onClick={() => {
              void perform('check-video-tools', async () => {
                setTools(null)
                const result = await window.canvas.checkVideoTools()
                setTools(result)
                if (!result.available) throw new Error(result.message)
                return result.message
              })
            }}><Check size={16} />{busy === 'check-video-tools' ? '正在检查…' : '检查工具状态'}</button>
            <button type="button" className="button" data-testid="video-tools-choose" disabled={Boolean(busy)} onClick={() => {
              void perform('choose-ffmpeg', async () => {
                const next = await window.canvas.chooseFFmpeg()
                if (!next) return '已取消选择'
                accept(next); setTools(null)
                const result = await window.canvas.checkVideoTools()
                setTools(result)
                if (!result.available) throw new Error(result.message)
                return '已验证并保存'
              })
            }}><FolderOpen size={16} />{busy === 'choose-ffmpeg' ? '选择并验证…' : '选择 FFmpeg'}</button>
            <button type="button" className="text-button" data-testid="video-tools-reset" disabled={Boolean(busy) || !current.ffmpegPath} onClick={() => {
              void perform('reset-ffmpeg', async () => {
                accept(await window.canvas.resetFFmpeg()); setTools(null)
                const result = await window.canvas.checkVideoTools()
                setTools(result)
                if (!result.available) throw new Error(`已恢复自动检测。${result.message}`)
                return '已恢复自动检测，工具可用'
              })
            }}>恢复自动检测</button>
          </div>
          <div className="video-tools-status" role="status">
            <h4>{busy?.includes('ffmpeg') || busy === 'check-video-tools' ? '正在检查视频工具…' : tools ? tools.available ? '工具可用' : '工具不可用' : '尚未检查工具状态'}</h4>
            {tools && <dl className="tool-details"><div><dt>FFmpeg</dt><dd>{tools.ffmpeg || '未找到'}</dd></div><div><dt>FFprobe</dt><dd>{tools.ffprobe || '未找到'}</dd></div>
              {tools.version && <div><dt>版本</dt><dd>{tools.version}</dd></div>}</dl>}
          </div>
          {notice.video && <Banner tone={notice.video.tone}>{notice.video.text}</Banner>}
          <p className="storage-note">检测失败时，请安装包含 FFmpeg 和 FFprobe 的工具包，选择 FFmpeg 或配置 PATH 后重试。试听与导出共用一个任务名额。</p>
        </section>
      </div>
    </div>
    <footer className="settings-footer"><span>{dirty ? '有未保存的设置' : ''}</span><button type="button" className="button" disabled={Boolean(busy)} onClick={close}>完成</button></footer>
  </Dialog>
}
