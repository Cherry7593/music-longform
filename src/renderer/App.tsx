import { useEffect, useState } from 'react'
import { Clapperboard, Library, Pencil, Settings2, Trash2, Wand2 } from 'lucide-react'
import { APP_NAME } from '../shared/branding'
import type { DeletionImpact, PageId, WorkbenchAsset } from '../shared/workbench-types'
import { useWorkspace } from './useWorkspace'
import { pauseOtherMedia } from './media'
import { Banner, BrandMark, EmptyState, ImpactDialog, RenameDialog } from './components/Common'
import { ProjectList } from './components/ProjectList'
import { GenerationWorkspace } from './components/GenerationWorkspace'
import { CompositionWorkspace } from './components/CompositionWorkspace'
import { LibraryWorkspace } from './components/LibraryWorkspace'
import { SettingsWorkspace } from './components/SettingsWorkspace'
import { LibraryMediaDialog } from './components/LibraryMedia'

const pages = [{ id: 'generation', label: '素材生成', icon: Wand2 }, { id: 'composition', label: '批量合成', icon: Clapperboard }, { id: 'library', label: '素材库', icon: Library }, { id: 'settings', label: '设置', icon: Settings2 }] as const
export function App() {
  const { store, ready, data, error, refreshError, page, generationId, compositionId, busy, notice } = useWorkspace()
  const [preview, setPreview] = useState<WorkbenchAsset>()
  const [rename, setRename] = useState<{ id: string; name: string; kind: 'generation' | 'composition' }>()
  const [deletion, setDeletion] = useState<{ kind: 'generation' | 'composition'; impact: DeletionImpact }>()
  const navBusy = busy.includes('navigation')
  const generation = data?.generationProjects.find(p => p.id === generationId)
  const composition = data?.compositionProjects.find(p => p.id === compositionId)
  const kind = page === 'generation' || page === 'composition' ? page : undefined
  const project = kind === 'generation' ? generation : kind === 'composition' ? composition : undefined
  useEffect(() => { pauseOtherMedia() }, [page, generationId, compositionId])
  function navigate(next: PageId): void { void store.run('navigation', () => store.navigate(next)) }
  function createProject(target: 'generation' | 'composition'): void {
    void store.run('navigation', async () => { await store.flush(); const created = target === 'generation' ? await window.canvas.createGenerationProject() : await window.canvas.createCompositionProject(); await store.refresh(); await store.selectProject(target, created.id) }, '已新建干净项目')
  }
  function deleteProject(): void {
    if (!kind || !project) return
    const id = project.id, target = kind
    void store.run('project-impact', async () => { await store.flush(id); const impact = target === 'generation' ? await window.canvas.generationProjectImpact(id) : await window.canvas.compositionProjectImpact(id); setDeletion({ kind: target, impact }) })
  }
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><BrandMark /><div><strong>{APP_NAME}</strong><span className="meta">本地创作工作台 · V4</span></div></div>
      <nav className="main-nav" aria-label="主导航">{pages.map(({ id, label, icon: Icon }) => <button key={id} id={`main-nav-${id}`} data-testid={`nav-${id}`} aria-current={page === id ? 'page' : undefined} disabled={!ready || navBusy} onClick={() => navigate(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-foot"><p>独立项目 · 统一素材</p><p className="meta">生成与合成后台执行<br />切换项目不停止任务</p>{data?.testMode && <p className="test-label">隔离测试数据 / Demo</p>}</div>
    </aside>
    <main className={`main-content ${kind ? 'has-projects' : ''}`}>
      {!ready || !data ? <div className="startup"><h1>{error ? '工作台暂时无法读取' : '正在读取工作台…'}</h1>{error ? <><Banner tone="error">{error}</Banner><button className="button" disabled={busy.includes('reload')} onClick={() => void store.run('reload', () => store.refresh())}>重新读取</button></> : <p className="meta" role="status">加载项目、请求与全局素材快照。</p>}</div> : <>
        {kind && <ProjectList key={`projects-${kind}`} kind={kind} projects={kind === 'generation' ? data.generationProjects : data.compositionProjects} selected={kind === 'generation' ? generationId : compositionId} busy={navBusy} onSelect={id => void store.run('navigation', () => store.selectProject(kind, id))} onCreate={() => createProject(kind)} />}
        <div className="page-scroll" key={`page-${page}`}>
          {(notice || refreshError || data.warnings.length > 0) && <div className="workspace-notices">{notice && <Banner tone={notice.tone} onClose={store.clearNotice}>{notice.text}</Banner>}{refreshError && <Banner tone="error">后台快照刷新失败，保留已读取内容：{refreshError}<button className="text-button" onClick={() => void store.run('refresh', () => store.refresh())}>重试刷新</button></Banner>}{data.warnings.length > 0 && <details className="warnings"><summary>需要留意 · {data.warnings.length} 条存储 / 迁移提示</summary><ul>{data.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}</div>}
          {kind ? project ? <><header className="page-header project-header"><div><p className="eyebrow">{kind === 'generation' ? '素材生成' : '批量合成'} / 独立项目</p><h1 data-testid="project-name">{project.name}</h1></div><div className="button-row"><button className="icon-button" data-testid="project-rename" aria-label="重命名当前项目" onClick={() => setRename({ id: project.id, name: project.name, kind })}><Pencil size={18} /></button><button className="icon-button danger" data-testid="project-delete" aria-label="删除当前项目" disabled={busy.includes('project-impact')} onClick={deleteProject}><Trash2 size={18} /></button></div></header>
            {kind === 'generation' && generation && <GenerationWorkspace key={generation.id} project={generation} data={data} store={store} onPreview={setPreview} onSettings={() => navigate('settings')} />}
            {kind === 'composition' && composition && <CompositionWorkspace key={composition.id} project={composition} data={data} store={store} onPreview={setPreview} />}
          </> : <div className="workspace-body"><EmptyState title={kind === 'generation' ? '新建生成项目' : '新建合成项目'}><p>{kind === 'generation' ? '用独立条目管理每个描述、API 与返回素材。' : '在项目内选择音乐与配图，规划整首分组后合成。'}</p><button className="button primary" disabled={navBusy} onClick={() => createProject(kind)}>新建项目</button></EmptyState></div> : page === 'library' ? <LibraryWorkspace data={data} store={store} onPreview={setPreview} /> : <SettingsWorkspace data={data} store={store} />}
        </div>
      </>}
    </main>
    {preview && <LibraryMediaDialog key={preview.id} asset={data?.assets.find(a => a.id === preview.id) ?? preview} onClose={() => setPreview(undefined)} />}
    {rename && <RenameDialog name={rename.name} title="重命名项目" onClose={() => setRename(undefined)} onSave={async name => { await store.flush(rename.id); if (rename.kind === 'generation') await window.canvas.updateGenerationProject(rename.id, { name }); else { const current = store.getSnapshot().data?.compositionProjects.find(p => p.id === rename.id); if (!current) throw new Error('项目已不存在'); await window.canvas.updateCompositionProject(rename.id, current.revision, { name }) } await store.refresh() }} />}
    {deletion && <ImpactDialog impact={deletion.impact} entity="project" onClose={() => setDeletion(undefined)} onDelete={async () => { if (deletion.kind === 'generation') await window.canvas.deleteGenerationProject(deletion.impact.id); else await window.canvas.deleteCompositionProject(deletion.impact.id); await store.refresh(); store.notify('项目已删除，媒体与使用记录保留') }} />}
  </div>
}
