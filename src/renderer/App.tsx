import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertCircle, Check, Circle, Clapperboard, FolderOpen, History, Library, LoaderCircle, Pencil, Plus, Search, Settings2, Wand2 } from 'lucide-react'
import { activeMusicStatuses, imageDraftSchema, musicDraftSchema } from '../shared/schemas'
import { APP_NAME } from '../shared/branding'
import type { AssetKind, ImageAsset, VideoJob } from '../shared/types'
import { useWorkspace } from './useWorkspace'
import { dateLabel, errorMessage, validationMessage } from './utils'
import { Banner, BrandMark } from './components/Common'
import { MusicWorkspace } from './components/MusicWorkspace'
import { ImageWorkspace, ImageZoomDialog } from './components/ImageWorkspace'
import { SettingsDialog } from './components/SettingsDialog'
import type { SettingsTab } from './components/SettingsDialog'
import { VideoWorkspace } from './components/VideoWorkspace'
import { VideoPlayerDialog } from './components/VideoPlayerDialog'
import { pauseOtherMedia } from './media'
import { GenerationDialog } from './components/GenerationDialog'
import type { GenerationRequest } from './components/GenerationDialog'
import type { BatchVideoJob, LibraryAsset, VideoBatch } from '../shared/library-types'
import { useLibrary } from './hooks/useLibrary'
import { useVideoBatches } from './hooks/useVideoBatches'
import { useBatchComposer } from './hooks/useBatchComposer'
import { LibraryWorkspace } from './components/LibraryWorkspace'
import { BatchVideoWorkspace } from './components/BatchVideoWorkspace'
import { LibraryMediaDialog } from './components/LibraryMedia'
import type { ManagedPreview } from './components/LibraryMedia'

type Modal = (({ type: 'settings'; initialTab: SettingsTab } | { type: 'generation'; request: GenerationRequest } | { type: 'zoom'; projectId: string; image: ImageAsset } | { type: 'video'; projectId: string; job: VideoJob } | { type: 'managed'; preview: ManagedPreview }) & { returnFocus: HTMLElement | null }) | null
type WorkspaceTab = 'generation' | 'video'
const workspaceTabs = [{ id: 'generation' as const, label: '素材生成' }, { id: 'video' as const, label: '视频合成' }]
type Page = 'library' | 'generation' | 'batch' | 'history'
const mainPages = [{ id: 'library' as const, label: '素材库', icon: Library }, { id: 'generation' as const, label: '素材生成', icon: Wand2 }, { id: 'batch' as const, label: '批量合成', icon: Clapperboard }, { id: 'history' as const, label: '历史项目', icon: History }]
type Notice = { tone: 'error' | 'success' | 'info'; text: string }
const focusedElement = (): HTMLElement | null => document.activeElement instanceof HTMLElement ? document.activeElement : null

export function App() {
  const { store, ready, loadError, project, projects, settings, warnings, testMode, save, switching, busy } = useWorkspace()
  const library = useLibrary(ready)
  const queue = useVideoBatches(ready)
  const composer = useBatchComposer(library, queue.recordStarted)
  const [page, setPage] = useState<Page>('library')
  const [generationId, setGenerationId] = useState<string | null>(null)
  const lastHistoryProject = useRef<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [search, setSearch] = useState('')
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('generation')
  const [preparing, setPreparing] = useState(false)
  const preparationLock = useRef(false)
  const utilityLocks = useRef(new Set<string>())
  const [utilityBusy, setUtilityBusy] = useState<string[]>([])
  const allBusy = [...busy, ...utilityBusy]
  const locked = switching || preparing || Boolean(composer.busy) || Boolean(library.action) || utilityBusy.includes('workspace-tab') || utilityBusy.includes('navigation')
  const generationProjectId = generationId ?? library.snapshot?.config.generationProjectId
  const historyProjects = projects.filter(item => item.id !== generationProjectId)
  const visibleProjects = historyProjects.filter(item => (item.id === project?.id ? project.name : item.name).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const historyProject = page === 'history' && project?.id !== generationProjectId ? project : null
  useEffect(() => {
    pauseOtherMedia()
    setModal(previous => previous?.type === 'video' && (previous.projectId !== project?.id || page !== 'history' || workspaceTab !== 'video') ? null : previous)
  }, [project?.id, workspaceTab, page])

  function changePage(next: Page): void {
    if (next === page || locked || !ready) return
    attempt(() => utility('navigation', async () => {
      await store.flush()
      if (page === 'history' && historyProject) lastHistoryProject.current = historyProject.id
      if (next === 'generation') {
        await store.openGeneration()
        setGenerationId(store.getSnapshot().project?.id ?? null)
      } else if (next === 'history') {
        const target = historyProjects.find(item => item.id === lastHistoryProject.current)?.id
          ?? historyProjects.find(item => item.id === settings?.lastProjectId)?.id
          ?? historyProjects.find(item => item.id === project?.id)?.id
          ?? historyProjects[0]?.id
        if (target) await store.switchProject(target)
      }
      pauseOtherMedia(); setPage(next); setNotice(null)
      requestAnimationFrame(() => document.getElementById(`main-nav-${next}`)?.focus())
    }))
  }
  function previewLibrary(asset: LibraryAsset): void {
    pauseOtherMedia(); setNotice(null); setModal({ type: 'managed', preview: { kind: 'asset', asset }, returnFocus: focusedElement() })
  }
  function playBatch(batch: VideoBatch, job: BatchVideoJob): void {
    pauseOtherMedia(); setNotice(null); setModal({ type: 'managed', preview: { kind: 'batch', batch, job }, returnFocus: focusedElement() })
  }
  function exportLibrary(asset: LibraryAsset): void {
    attempt(() => utility(`library-export:${asset.id}`, async () => {
      const saved = await window.canvas.exportLibraryAsset(asset.id)
      setNotice({ tone: saved ? 'success' : 'info', text: saved ? `已保存：${saved}` : '已取消另存为' })
    }))
  }
  function revealLibrary(asset: LibraryAsset): void {
    attempt(() => utility(`library-reveal:${asset.id}`, async () => { await window.canvas.revealLibraryAsset(asset.id); setNotice({ tone: 'info', text: '已打开文件位置' }) }))
  }
  function exportBatch(batch: VideoBatch, job: BatchVideoJob): void {
    attempt(() => utility(`batch-export:${job.id}`, async () => {
      const saved = await window.canvas.exportBatchVideo(batch.id, job.id)
      setNotice({ tone: saved ? 'success' : 'info', text: saved ? `已保存：${saved}` : '已取消另存为' })
    }))
  }
  function revealBatch(batch: VideoBatch, job?: BatchVideoJob): void {
    attempt(() => utility(`batch-reveal:${job?.id ?? batch.id}`, async () => { await window.canvas.revealBatchVideo(batch.id, job?.id); setNotice({ tone: 'info', text: '已打开文件位置' }) }))
  }

  function changeWorkspace(next: WorkspaceTab): void {
    if (next === workspaceTab || locked) return
    attempt(() => utility('workspace-tab', async () => {
      await store.flush()
      pauseOtherMedia(); setWorkspaceTab(next)
      requestAnimationFrame(() => document.getElementById(`workspace-tab-${next}`)?.focus())
    }))
  }
  function workspaceKeys(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = 1 - index
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = workspaceTabs.length - 1
    else return
    event.preventDefault()
    changeWorkspace(workspaceTabs[next].id)
  }

  function attempt(action: () => Promise<void>): void {
    setNotice(null)
    void action().catch(error => setNotice({ tone: 'error', text: errorMessage(error) }))
  }
  async function utility(key: string, action: () => Promise<void>): Promise<void> {
    if (utilityLocks.current.has(key)) return
    utilityLocks.current.add(key); setUtilityBusy([...utilityLocks.current])
    try { await action() } finally { utilityLocks.current.delete(key); setUtilityBusy([...utilityLocks.current]) }
  }
  function openSettings(initialTab: SettingsTab = 'keys'): void {
    const returnFocus = focusedElement()
    attempt(() => utility('settings', async () => {
      store.setSettings(await window.canvas.getSettings())
      pauseOtherMedia(); setModal({ type: 'settings', initialTab, returnFocus })
    }))
  }
  function createProject(): void {
    attempt(() => utility('navigation', async () => { await store.createProject(); lastHistoryProject.current = store.getSnapshot().project?.id ?? null; setPage('history'); setWorkspaceTab('generation'); setSearch('') }))
  }
  function exportAsset(projectId: string, kind: AssetKind, assetId: string): void {
    attempt(() => utility(`export:${assetId}`, async () => {
      const saved = await window.canvas.exportAsset(projectId, kind, assetId)
      setNotice({ tone: saved ? 'success' : 'info', text: saved ? `已保存：${saved}` : '已取消另存为' })
    }))
  }
  function revealAsset(projectId: string, kind: AssetKind, assetId: string): void {
    attempt(() => utility(`reveal:${assetId}`, async () => {
      await window.canvas.revealAsset(projectId, kind, assetId)
      setNotice({ tone: 'info', text: '已打开文件位置' })
    }))
  }
  async function prepare(kind: 'music' | 'image' | 'continue', batchId?: string): Promise<void> {
    if (preparationLock.current || modal || !project) return
    const returnFocus = focusedElement()
    preparationLock.current = true; setPreparing(true)
    const projectId = project.id
    try {
      await store.flush()
      const current = store.getSnapshot().project
      if (!current || current.id !== projectId) throw new Error('项目已改变，请重新操作')
      if (kind === 'continue') {
        const batch = current.batches.find(item => item.id === batchId)
        const pending = current.musicJobs.filter(job => job.batchId === batchId && job.status === 'pending')
        if (!batch || batch.state !== 'paused' || !pending.length) throw new Error('该批次没有可以继续的未提交任务')
        setModal({ type: 'generation', returnFocus, request: { kind, projectId, batchId: batch.id, pending: structuredClone(pending) } })
      } else if (kind === 'music') {
        const parsed = musicDraftSchema.safeParse(current.music)
        if (!parsed.success) throw new Error(validationMessage(parsed.error))
        if (!parsed.data.prompt.trim()) throw new Error('请先填写音乐描述')
        setModal({ type: 'generation', returnFocus, request: { kind, projectId, draft: structuredClone(current.music) } })
      } else {
        const parsed = imageDraftSchema.safeParse(current.image)
        if (!parsed.success) throw new Error(validationMessage(parsed.error))
        if (!parsed.data.prompt.trim()) throw new Error('请先填写画面描述')
        setModal({ type: 'generation', returnFocus, request: { kind, projectId, draft: structuredClone(current.image) } })
      }
    } finally { preparationLock.current = false; setPreparing(false) }
  }
  async function confirm(request: GenerationRequest): Promise<void> {
    const state = store.getSnapshot()
    if (state.project?.id !== request.projectId) throw new Error('项目已改变，请关闭此窗口后重新确认')
    const key = request.kind === 'image' ? 'image-submit' : 'music-submit'
    await store.run(key, async (api, id) => {
      const current = store.getSnapshot().project
      if (!current || current.id !== request.projectId) throw new Error('项目已改变')
      if (request.kind === 'continue') {
        const pending = current.musicJobs.filter(job => job.batchId === request.batchId && job.status === 'pending')
        if (JSON.stringify(pending.map(job => job.id)) !== JSON.stringify(request.pending.map(job => job.id))) throw new Error('剩余任务已改变，请重新核对数量')
        return api.continueMusic(id, request.batchId)
      }
      const draft = request.kind === 'music' ? current.music : current.image
      if (JSON.stringify(draft) !== JSON.stringify(request.draft)) throw new Error('生成参数已改变，请关闭后重新确认')
      if (request.kind === 'music' && current.musicJobs.some(job => activeMusicStatuses.has(job.status))) throw new Error('已有音乐任务正在处理')
      return request.kind === 'music' ? api.startMusic(id) : api.startImage(id)
    }, true)
    setModal(null)
    setNotice({ tone: 'info', text: '已提交' })
  }

  return <>
    <div className="app-shell" inert={Boolean(modal)}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand"><BrandMark /><div><strong>{APP_NAME}</strong></div></div>
        <nav className="main-nav" aria-label="工作区导航">{mainPages.map(item => <button type="button" key={item.id} id={`main-nav-${item.id}`} data-testid={`nav-${item.id}`} aria-current={page === item.id ? 'page' : undefined} disabled={!ready || locked} onClick={() => changePage(item.id)}><item.icon size={18} />{item.label}</button>)}</nav>
        {page === 'history' ? <>
          <button type="button" className="button new-project" onClick={createProject} disabled={!ready || locked}><Plus size={17} />{switching ? '正在打开项目…' : '新建项目'}</button>
          <div className="history-label"><History size={14} /><h2>历史项目</h2><span>{historyProjects.length}</span></div>
          {historyProjects.length > 0 && <div className="project-search"><Search size={14} /><input type="search" aria-label="搜索历史项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></div>}
          <nav className="project-list" aria-label="历史项目列表">
            {visibleProjects.map(item => <button type="button" className={`project-item ${item.id === historyProject?.id ? 'selected' : ''}`} key={item.id}
              aria-current={item.id === historyProject?.id ? 'page' : undefined} onClick={() => attempt(() => utility('navigation', async () => { await store.switchProject(item.id); lastHistoryProject.current = item.id }))} disabled={locked || !ready}>
              <span className="project-item-title">{item.id === historyProject?.id ? historyProject.name || '未命名项目' : item.name}</span>
              <span className="project-item-meta"><span>{item.audioCount} 首音乐 · {item.imageCount} 张图片</span><time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)}</time></span>
            </button>)}
            {ready && visibleProjects.length === 0 && <p className="sidebar-empty">{historyProjects.length ? '未找到项目' : '暂无历史项目'}</p>}
          </nav>
        </> : <div className="sidebar-spacer" />}
        <footer className="sidebar-footer">{testMode && <span className="test-mode-label">测试模式 · 模拟接口</span>}
          <button type="button" className="sidebar-settings" onClick={() => openSettings()} disabled={!settings || locked || utilityBusy.includes('settings')}><Settings2 size={18} />{utilityBusy.includes('settings') ? '正在读取设置…' : '设置'}</button>
        </footer>
      </aside>
      <main className="main-surface">
        <header className="project-header">
          {historyProject && project ? <><div className="project-title-block"><h1 className="sr-only">历史项目</h1><div className="project-name-row"><label className="sr-only" htmlFor="project-name">项目名称</label>
            <input id="project-name" value={project.name} disabled={locked} title="点击编辑项目名称" aria-invalid={!project.name.trim() || project.name.trim().length > 80}
              onChange={event => store.edit('name', event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.currentTarget.blur(); attempt(store.flush) } }} />
            <Pencil size={14} className="name-pencil" /></div>
            <div className={`save-status save-${save.phase}`} role="status" aria-live="polite">{save.phase === 'saved' ? <Check size={13} /> : save.phase === 'error' ? <AlertCircle size={13} /> : <Circle size={11} />}
              {save.phase === 'saved' ? '已保存' : save.phase === 'saving' ? '正在保存…' : save.phase === 'error' ? '保存未完成，输入仍保留' : '有未保存的更改'}
              {save.phase === 'error' && <button type="button" className="text-button" onClick={() => attempt(store.flush)}>重试保存</button>}
            </div></div>
            <button type="button" className="button open-folder" disabled={locked || utilityBusy.includes('folder')} title={project.directory} onClick={() => attempt(() => utility('folder', () => window.canvas.openProjectDirectory(project.id)))}><FolderOpen size={16} />打开素材目录</button>
          </> : <div className="project-title-block"><h1 id="page-title">{mainPages.find(item => item.id === page)?.label}</h1>
            {page === 'library' && <p className="page-description">勾选音乐和图片，直接规划批量视频。</p>}
            {page === 'batch' && <p className="page-description">整首分组，一张图片对应一个视频。</p>}
            {page === 'history' && <p className="page-description">保留旧项目与原有单视频流程。</p>}
            {page === 'generation' && <div className={`save-status save-${save.phase}`} role="status"><span>自动保存生成会话 · 成功素材自动入库</span><span>· {save.phase === 'saved' ? '已保存' : save.phase === 'saving' ? '正在保存…' : save.phase === 'error' ? '保存未完成' : '有未保存的更改'}</span>{save.phase === 'error' && <button type="button" className="text-button" onClick={() => attempt(store.flush)}>重试保存</button>}</div>}
          </div>}
        </header>
        {ready && historyProject && <nav className="workspace-tabs" role="tablist" aria-label="项目工作区">{workspaceTabs.map((tab, index) =>
          <button type="button" role="tab" id={`workspace-tab-${tab.id}`} data-testid={`workspace-tab-${tab.id}`} key={tab.id}
            aria-controls={`workspace-panel-${tab.id}`} aria-selected={workspaceTab === tab.id} tabIndex={workspaceTab === tab.id ? 0 : -1}
            disabled={locked} onClick={() => changeWorkspace(tab.id)} onKeyDown={event => workspaceKeys(event, index)}>{tab.label}</button>)}</nav>}
        <div className="main-scroll" key={page}>
          <div className="notifications">
            {warnings.length > 0 && <Banner tone="warning" onClose={store.dismissWarnings}>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</Banner>}
            {(page === 'generation' || page === 'history') && (library.error || Boolean(library.snapshot?.warnings.length)) && <Banner tone="warning">
              {library.error && <p>素材库暂未同步：{library.error}</p>}{library.snapshot?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
              <p>刷新仅重试本地登记，不会重新调用付费生成。</p><button type="button" className="text-button" disabled={locked || library.loading} onClick={() => void library.refresh()}>刷新素材库</button>
            </Banner>}
            {save.message && <Banner tone="error">{save.message}</Banner>}
            {notice && <Banner tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Banner>}
          </div>
          {!ready ? <div className="welcome-state">{loadError ? <><AlertCircle size={32} strokeWidth={1.5} /><h2>暂时无法打开工作台</h2><p role="alert">{loadError}</p><button type="button" className="button" onClick={() => void store.load()}>重新连接</button></>
            : <><LoaderCircle size={28} strokeWidth={1.5} /><h2>正在读取工作台…</h2></>}</div>
            : page === 'library' ? <LibraryWorkspace library={library} disabled={locked} busy={allBusy} onPreview={previewLibrary} onExport={exportLibrary} onReveal={revealLibrary} onBatch={() => changePage('batch')} onGenerate={() => changePage('generation')} />
            : page === 'batch' ? <BatchVideoWorkspace library={library} composer={composer} queue={queue} disabled={locked} busy={allBusy} onLibrary={() => changePage('library')} onSettings={() => openSettings('video')} onPreview={previewLibrary} onPlay={playBatch} onExport={exportBatch} onReveal={revealBatch} />
            : !project || (page === 'history' && !historyProject) ? <div className="welcome-state"><History size={40} strokeWidth={1.5} /><h2>暂无历史项目</h2><p>新流程不需要建项目。也可以继续使用原有项目工作区。</p><div className="button-row"><button type="button" className="button primary" disabled={locked} onClick={() => changePage('generation')}>去素材生成</button><button type="button" className="button" onClick={createProject} disabled={locked}><Plus size={17} />新建第一个项目</button></div></div>
            : page === 'generation' || workspaceTab === 'generation' ? <div className="workspace-grid" key={project.id} aria-busy={locked} role={page === 'history' ? 'tabpanel' : 'region'} id="workspace-panel-generation" aria-labelledby={page === 'history' ? 'workspace-tab-generation' : 'page-title'} tabIndex={0}>
              <MusicWorkspace project={project} disabled={locked} hasKey={Boolean(settings?.keys.mureka)} busy={allBusy} onChange={draft => store.edit('music', draft)}
                onGenerate={() => attempt(() => prepare('music'))} onSettings={openSettings}
                onStop={batchId => attempt(async () => { await store.run(`stop:${batchId}`, (api, id) => api.stopMusic(id, batchId)); setNotice({ tone: 'info', text: '已停止后续提交。已经提交的当前任务仍可能完成并计费。' }) })}
                onContinue={batchId => attempt(() => prepare('continue', batchId))}
                onRecover={jobId => attempt(() => store.run(`recover:${jobId}`, (api, id) => api.retryMusicJob(id, jobId)))}
                onKeep={asset => attempt(() => store.run(`keep:${asset.id}`, (api, id) => api.keepAudio(id, asset.id, !asset.kept)))}
                onExport={assetId => exportAsset(project.id, 'audio', assetId)} />
              <ImageWorkspace project={project} disabled={locked} hasKey={Boolean(settings?.keys.siliconflow)} busy={allBusy} onChange={draft => store.edit('image', draft)}
                onGenerate={() => attempt(() => prepare('image'))} onSettings={openSettings}
                onSelect={assetId => attempt(() => store.run('select-image', (api, id) => api.selectImage(id, assetId)))}
                onZoom={image => { setNotice(null); setModal({ type: 'zoom', projectId: project.id, image, returnFocus: focusedElement() }) }} onExport={assetId => exportAsset(project.id, 'image', assetId)} />
            </div> : <div role="tabpanel" id="workspace-panel-video" aria-labelledby="workspace-tab-video" tabIndex={0}>
              <VideoWorkspace key={project.id} project={project} store={store} disabled={locked} busy={allBusy} onSettings={() => openSettings('video')}
                onPlay={job => { pauseOtherMedia(); setNotice(null); setModal({ type: 'video', projectId: project.id, job, returnFocus: focusedElement() }) }}
                onExport={(kind, assetId) => exportAsset(project.id, kind, assetId)} onReveal={(kind, assetId) => revealAsset(project.id, kind, assetId)} />
            </div>}
        </div>
      </main>
    </div>
    {modal?.type === 'settings' && settings && <SettingsDialog settings={settings} initialTab={modal.initialTab} onSaved={store.setSettings} onClose={() => setModal(null)} returnFocus={modal.returnFocus} />}
    {modal?.type === 'generation' && <GenerationDialog request={modal.request} testMode={testMode} onClose={() => setModal(null)} onConfirm={() => confirm(modal.request)} returnFocus={modal.returnFocus} />}
    {modal?.type === 'zoom' && <ImageZoomDialog projectId={modal.projectId} image={modal.image} onClose={() => setModal(null)} exporting={utilityBusy.includes(`export:${modal.image.id}`)}
      onExport={() => exportAsset(modal.projectId, 'image', modal.image.id)} returnFocus={modal.returnFocus} notice={notice} />}
    {modal?.type === 'video' && <VideoPlayerDialog projectId={modal.projectId} job={modal.job} onClose={() => setModal(null)}
      exporting={utilityBusy.includes(`export:${modal.job.id}`)} revealing={utilityBusy.includes(`reveal:${modal.job.id}`)}
      onExport={() => exportAsset(modal.projectId, 'video', modal.job.id)} onReveal={() => revealAsset(modal.projectId, 'video', modal.job.id)} returnFocus={modal.returnFocus} notice={notice} />}
    {modal?.type === 'managed' && <LibraryMediaDialog preview={modal.preview} onClose={() => setModal(null)} returnFocus={modal.returnFocus} notice={notice}
      exporting={utilityBusy.includes(modal.preview.kind === 'asset' ? `library-export:${modal.preview.asset.id}` : `batch-export:${modal.preview.job.id}`)}
      revealing={utilityBusy.includes(modal.preview.kind === 'asset' ? `library-reveal:${modal.preview.asset.id}` : `batch-reveal:${modal.preview.job.id}`)}
      onExport={() => modal.preview.kind === 'asset' ? exportLibrary(modal.preview.asset) : exportBatch(modal.preview.batch, modal.preview.job)}
      onReveal={() => modal.preview.kind === 'asset' ? revealLibrary(modal.preview.asset) : revealBatch(modal.preview.batch, modal.preview.job)} />}
  </>
}
