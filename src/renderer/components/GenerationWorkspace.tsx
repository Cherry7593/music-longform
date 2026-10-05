import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react'
import type { GenerationEntry, GenerationKind, GenerationProject, GenerationRequest, WorkbenchAsset, WorkbenchSnapshot } from '../../shared/workbench-types'
import { GENERATION_ACTIVE, PROVIDER_NAMES } from '../../shared/workbench-types'
import type { Provider } from '../../shared/types'
import { musicOutputNote } from '../../shared/music-capabilities'
import type { WorkspaceStore } from '../useWorkspace'
import { useAceStepModels } from '../hooks/useAceStepModels'
import { appendSelection, deselectSelection, generationSubmissionIssue, pendingEntries, useGenerationSelection } from '../selection'
import { Banner, ConfirmDialog, EmptyState, Pager, StatusBadge, duration, useAction } from './Common'
import type { Confirmation } from './Common'
import { EntryEditor, entryIssue } from './EntryEditor'
import { LibraryThumbnail } from './LibraryMedia'
import { PromptImportDialog } from './PromptImportDialog'
import { orderedProjectEntries } from '../prompt-import-utils'

function SourceSummary({ entries }: { entries: Array<{ draft: GenerationEntry['draft'] }> }) {
  const sources = new Map<string, number>()
  entries.forEach(e => { const provider = e.draft.provider ?? '未选择'; sources.set(provider, (sources.get(provider) ?? 0) + 1) })
  return <ul className="source-summary">{[...sources].map(([provider, total]) => <li key={provider}><strong>{PROVIDER_NAMES[provider as Provider] ?? provider} · {total} 个请求</strong><p className="meta">{provider === 'siliconflow' ? '每条请求生成图片，以实际保存结果为准' : provider in PROVIDER_NAMES ? musicOutputNote(provider as Exclude<Provider, 'siliconflow'>) : ''}</p><p className="meta">{provider === 'acestep' ? '占用本地 GPU / CPU、内存与磁盘，可能等待模型初始化。' : '云端可能扣费，价格与返回数量由平台决定。'}</p></li>)}</ul>
}
function ReturnedResults({ request, data, onPreview }: { request: GenerationRequest; data: WorkbenchSnapshot; onPreview: (asset: WorkbenchAsset) => void }) {
  const results = request.outputs?.length ? request.outputs.map(output => ({ key: output.id, assetId: output.libraryAssetId ?? output.assetId, title: output.title, saved: output.status === 'saved' }))
    : request.assetIds.map(assetId => ({ key: assetId, assetId, title: undefined, saved: true }))
  return <>{results.map((result, index) => {
    const asset = data.assets.find(value => value.id === result.assetId)
    return asset ? <div className="result-asset" data-testid="entry-result" key={result.key}>{asset.kind === 'image' && <LibraryThumbnail id={asset.id} name={asset.name} available={asset.available} />}<div><strong>结果 {index + 1} · {asset.name}</strong>{result.title && result.title !== asset.name && <p className="meta">原曲名：{result.title}</p>}<p className="meta">{asset.kind === 'audio' ? duration(asset.durationSeconds) : `${asset.width ?? '—'} × ${asset.height ?? '—'}`}{!asset.available ? ' · 文件不可用' : ''}</p></div><button className="button" onClick={() => onPreview(asset)}>{asset.kind === 'audio' ? '试听' : '查看'}</button></div>
      : <p className="meta" data-testid="entry-result" key={result.key}>结果 {index + 1} · {result.saved ? '素材已删除或尚未登记' : '尚未保存，原请求记录保留'}</p>
  })}</>
}
export function GenerationWorkspace({ project, data, store, onPreview, onSettings }: {
  project: GenerationProject; data: WorkbenchSnapshot; store: WorkspaceStore; onPreview: (asset: WorkbenchAsset) => void; onSettings: () => void
}) {
  const kind = project.page
  const [selected, setSelected] = useGenerationSelection(store, project.id)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pages, setPages] = useState({ audio: 0, image: 0 })
  const [historyPages, setHistoryPages] = useState({ audio: 0, image: 0 })
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [importKind, setImportKind] = useState<GenerationKind>()
  const action = useAction()
  const ace = useAceStepModels(data.apis.find(a => a.provider === 'acestep'))
  const all = orderedProjectEntries(project, data.entries)
  const entries = all.filter(e => e.kind === kind)
  const requests = data.requests.filter(r => r.projectId === project.id)
  const linkedAssets = new Set(requests.flatMap(request => [...request.assetIds, ...(request.outputs ?? []).map(output => output.libraryAssetId ?? output.assetId)]))
  const historicalAssets = data.assets.filter(asset => asset.kind === kind && !linkedAssets.has(asset.id) && asset.origins.some(origin => origin.projectId === project.id))
  const historyPage = Math.min(historyPages[kind], Math.max(0, Math.ceil(historicalAssets.length / 20) - 1))
  const pending = pendingEntries(all, project.id, kind)
  const selectedPending = pending.filter(entry => selected.has(entry.id))
  const resumable = requests.filter(r => r.kind === kind && r.status === 'paused')
  const page = Math.min(pages[kind], Math.max(0, Math.ceil(entries.length / 20) - 1))
  const visible = entries.slice(page * 20, page * 20 + 20)
  const saves = store.getSnapshot().saves
  async function add(copyId?: string): Promise<void> {
    await action.run(async () => {
      if (copyId) await store.flushEntry(copyId)
      const created = await window.canvas.addEntry(project.id, kind, copyId)
      await store.refresh(); setExpanded(old => new Set(old).add(created.id))
      const snapshot = store.getSnapshot().data, live = snapshot?.generationProjects.find(item => item.id === project.id)
      const list = snapshot && live ? orderedProjectEntries(live, snapshot.entries).filter(entry => entry.kind === kind) : []
      setPages(old => ({ ...old, [kind]: Math.floor(Math.max(0, list.findIndex(e => e.id === created.id)) / 20) }))
    })
  }
  async function prepare(ids: string[]): Promise<void> {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await action.run(async () => {
      const issue = generationSubmissionIssue(new Set(ids).size)
      if (issue) throw new Error(issue)
      await store.flush(project.id)
      const snapshot = store.getSnapshot().data!
      const wanted = new Set(ids)
      const live = snapshot.generationProjects.find(item => item.id === project.id)
      if (!live) throw new Error('项目已不存在，请重新选择')
      const chosen = pendingEntries(orderedProjectEntries(live, snapshot.entries), project.id, kind).filter(entry => wanted.has(entry.id))
      const selectionIssue = generationSubmissionIssue(chosen.length)
      if (selectionIssue) throw new Error(selectionIssue)
      for (const entry of chosen) { const issue = entryIssue(entry, snapshot.apis, ace.status); if (issue) { setExpanded(old => new Set(old).add(entry.id)); throw new Error(`${entry.draft.title || '条目'}：${issue}`) } }
      const frozen = structuredClone(chosen)
      const submissionId = crypto.randomUUID()
      setConfirm({ title: '确认本批生成请求', label: '确认并提交', once: true, returnFocus, acknowledge: '我已核对来源与内容，理解云端费用 / 本地资源风险', body: <><p>本次提交 {frozen.length} 个条目，每条只创建 1 个请求。多个返回结果全部挂在原条目下，不自动补发或付费写词。</p><SourceSummary entries={frozen} /><details><summary>核对条目快照</summary><ol>{frozen.map(e => <li key={e.id}><strong>{e.draft.title || e.draft.model}</strong><p className="preserve-lines">{e.draft.prompt}</p>{e.draft.lyrics && <p className="preserve-lines meta">歌词：{e.draft.lyrics}</p>}</li>)}</ol></details></>, action: async () => {
        const current = store.getSnapshot()
        for (const e of frozen) { const now = current.data?.entries.find(item => item.id === e.id); if (!now || now.deletedAt || now.projectId !== project.id || now.kind !== kind || now.revision !== e.revision || now.requestId || current.saves[e.id]) throw new Error('条目已改变，请关闭确认并重新核对') }
        await window.canvas.submitEntries({ projectId: project.id, submissionId, entries: frozen.map(e => ({ id: e.id, revision: e.revision })) })
        await store.refresh(); setSelected(old => new Set(deselectSelection([...old], frozen.map(entry => entry.id)))); store.notify('请求已登记，切换项目不会中断后台执行')
      } })
    })
  }
  function resume(items: GenerationRequest[]): void {
    const list = structuredClone(items)
    const maySubmit = list.filter(r => !r.taskId && !r.outputs?.length && !r.submittedAt && r.status === 'paused')
    const submissionId = crypto.randomUUID()
    setConfirm({ title: maySubmit.length ? '确认继续未提交请求' : '恢复查询与保存', label: maySubmit.length ? '确认继续' : '恢复查询 / 保存', once: true, acknowledge: maySubmit.length ? '确认继续这些未提交请求，并承担对应费用 / 本地资源消耗' : undefined,
      body: <><p>{maySubmit.length ? `${maySubmit.length} 个尚未提交的请求将继续提交。` : '仅按已保存远端任务 ID 恢复查询，或补存已有返回结果；绝不重新发送生成请求。'}成功结果不重跑。</p><SourceSummary entries={list.map(r => ({ draft: r.snapshot }))} /></>, action: async () => {
        if (maySubmit.length) {
          const entries = maySubmit.map(request => { const entry = store.getSnapshot().data?.entries.find(value => value.id === request.entryId); if (!entry) throw new Error('条目已改变，请刷新'); return { id: entry.id, revision: entry.revision } })
          await window.canvas.submitEntries({ projectId: project.id, submissionId, entries })
        }
        for (const request of list.filter(value => !maySubmit.some(pending => pending.id === value.id))) await window.canvas.resumeRequest(request.id)
        await store.refresh()
      } })
  }
  function abandon(request: GenerationRequest): void {
    setConfirm({ title: '放弃追踪此请求？', danger: true, label: '确认放弃追踪', acknowledge: '我已到原平台核对，理解放弃追踪不退款、不取消远端任务，重新生成可能重复扣费', body: <><p>无法确定平台是否已受理。软件不会自动重发；放弃后不再查询此请求。原平台可能仍在生成或已经扣费。</p><p className="meta">请求：{request.id} · 来源：{PROVIDER_NAMES[request.binding.provider as Provider] ?? request.binding.provider}</p></>, action: async () => { await window.canvas.abandonRequest(request.id); await store.refresh() } })
  }
  async function changeKind(next: GenerationKind): Promise<void> { await action.run(async () => { await store.flush(project.id); await window.canvas.updateGenerationProject(project.id, { page: next }); await store.refresh() }) }
  return <div className="workspace-body stack" data-testid="generation-workspace">
    <div className="tabs" aria-label="生成素材类型">{(['audio', 'image'] as const).map(tab => <button className="tab" data-testid={`generation-tab-${tab}`} aria-pressed={kind === tab} key={tab} disabled={action.busy} onClick={() => void changeKind(tab)}>{tab === 'audio' ? '音乐' : '图片'}<span className="meta">{all.filter(e => e.kind === tab).length}</span></button>)}</div>
    <div className="section-row"><p className="meta" data-testid="generation-totals">{entries.length} 条目 · {requests.filter(r => r.kind === kind && (r.submittedAt || r.taskId || ['submitting', 'running', 'saving', 'succeeded', 'unknown'].includes(r.status))).length} 已发起提交 · {new Set(requests.filter(r => r.kind === kind).flatMap(r => r.assetIds)).size} 库内素材</p><span className="meta">草稿自动保存 · 不完整也可保存</span></div>
    <div className="toolbar"><div className="button-row"><button className="button" data-testid="entry-add" disabled={action.busy} onClick={() => void add()}><Plus size={17} />添加{kind === 'audio' ? '音乐' : '图片'}条目</button><button className="button" data-testid="generation-select-all" disabled={action.busy || !pending.length} onClick={() => setSelected(old => new Set(appendSelection([...old], pending.map(entry => entry.id))))}>全选待生成</button><button className="button" data-testid="generation-deselect-all" disabled={action.busy || !selectedPending.length} onClick={() => setSelected(old => new Set(deselectSelection([...old], pending.map(entry => entry.id))))}>全取消待生成</button></div><div className="button-row"><button className="button" data-testid="generate-all" disabled={action.busy || !pending.length} onClick={() => void prepare(pending.map(e => e.id))}>生成全部待生成</button><button className="button primary" data-testid="generate-selected" disabled={action.busy || !selectedPending.length} onClick={() => void prepare(selectedPending.map(e => e.id))}>生成选中 · {selectedPending.length}</button></div></div>
    <div className="button-row"><button className="button" data-testid="prompt-template-save" disabled={action.busy} onClick={() => void action.run(async () => { const saved = await window.canvas.savePromptTemplate(kind); store.notify(saved ? `模板已保存：${saved}` : '已取消保存模板', saved ? 'success' : 'info') })}>下载{kind === 'audio' ? '音乐' : '图片'}模板</button><button className="button" data-testid="prompt-import-open" disabled={action.busy} onClick={() => setImportKind(kind)}>批量导入提示词</button><span className="meta">粘贴外部 AI 文本，预览后只创建草稿</span></div>
    <p className="meta" data-testid="generation-selected-count">当前类型待生成已选 {selectedPending.length} / {pending.length} · 跨全部分页，保留其他类型 / 项目选择 · 单次最多提交 500 个条目</p>
    {action.error && <Banner tone="error">{action.error}</Banner>}
    {!data.apis.some(a => a.kind === kind) && <Banner>此类型尚未添加 API，可先编写条目草稿。<button className="text-button" onClick={onSettings}>添加 API</button></Banner>}
    {(resumable.length > 0 || requests.some(r => GENERATION_ACTIVE.has(r.status))) && <div className="section-row recovery-bar"><p className="meta">已提交的内容锁定；后台任务始终归属此项目。</p><div className="button-row">{resumable.length > 0 && <button className="button" data-testid="generation-resume" onClick={() => resume(resumable)}>确认继续 · {resumable.length}</button>}{requests.some(r => GENERATION_ACTIVE.has(r.status)) && <button className="button" data-testid="generation-stop" onClick={() => setConfirm({ title: '停止本项目后续提交？', label: '停止未提交请求', body: <p>取消后续未提交请求。已经受理的远端任务可能继续运行或扣费；保留任务 ID，不自动重发。</p>, action: async () => { await window.canvas.stopGeneration(project.id); await store.refresh() } })}>停止后续提交</button>}</div></div>}
    {!entries.length ? <EmptyState title={`还没有${kind === 'audio' ? '音乐' : '图片'}条目`}>添加条目，分别填写描述，再一次确认提交。每条可以选择不同的已添加 API。</EmptyState> : <div className="entry-list">{visible.map((entry, index) => {
      const request = requests.find(r => r.id === entry.requestId), open = expanded.has(entry.id), issue = !entry.requestId ? entryIssue(entry, data.apis, ace.status) : undefined
      const name = entry.draft.title || entry.draft.prompt || `未填写${kind === 'audio' ? '音乐' : '图片'}描述`
      const saved = saves[entry.id]
      return <article className={`entry-row ${open ? 'expanded' : ''}`} data-testid={`entry-${entry.id}`} key={entry.id} style={{ animationDelay: `${Math.min(index, 5) * 20}ms` }}>
        <div className="entry-summary"><input type="checkbox" aria-label={`选择条目 ${index + page * 20 + 1}`} disabled={Boolean(entry.requestId)} checked={!entry.requestId && selected.has(entry.id)} onChange={e => setSelected(old => { const next = new Set(old); if (e.target.checked) next.add(entry.id); else next.delete(entry.id); return next })} />
          <button className="entry-expand" aria-expanded={open} data-testid={`entry-expand-${entry.id}`} onClick={() => setExpanded(old => { const next = new Set(old); if (open) next.delete(entry.id); else next.add(entry.id); return next })}>{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}<span className="entry-title"><strong>{name.length > 100 ? `${name.slice(0, 100)}…` : name}</strong><span className="meta">{entry.draft.provider ? PROVIDER_NAMES[entry.draft.provider] : '未选择 API'} · {entry.draft.model || '未选择模型'}{request ? ` · ${request.assetIds.length} 素材` : saved ? ` · ${saved.phase === 'error' ? '保存失败' : saved.phase === 'saving' ? '保存中' : '待保存'}` : ' · 已保存草稿'}</span></span></button>
          {request ? <StatusBadge status={request.status} /> : <span className="status-badge">{issue ? '待完善' : '待生成'}</span>}
          <button className="icon-button" data-testid={`entry-copy-${entry.id}`} title="复制为新草稿" aria-label="复制为新草稿" disabled={action.busy} onClick={() => void add(entry.id)}><Copy size={17} /></button>{!entry.requestId && <button className="icon-button danger" data-testid={`entry-delete-${entry.id}`} aria-label="删除未提交条目" disabled={action.busy} onClick={() => setConfirm({ title: '删除未提交条目？', body: <p>只删除本条草稿，不影响已有素材。</p>, danger: true, label: '删除条目', action: async () => { await store.flushEntry(entry.id); await window.canvas.deleteEntry(entry.id); await store.refresh() } })}><Trash2 size={17} /></button>}
        </div>
        {open && <div className="entry-detail">{saved?.phase === 'error' && <Banner tone="error">保存失败，草稿仍在：{saved.message}<button className="text-button" onClick={() => void action.run(() => store.flushEntry(entry.id))}>重试保存</button></Banner>}
          {request ? <div className="stack"><p className="preserve-lines">{request.snapshot.prompt}</p>{request.snapshot.lyrics && <details><summary>已提交歌词</summary><p className="preserve-lines">{request.snapshot.lyrics}</p></details>}<p className="meta">{request.actualModel ?? request.snapshot.model} · 请求 {request.id}{request.taskId ? ` · 远端 ${request.taskId}` : ''}</p>{request.detail && <p>{request.detail}</p>}{request.error && <Banner tone="error">{request.error}</Banner>}
            <div className="button-row">
              {['unknown', 'failed', 'paused'].includes(request.status) && <button className="button danger" data-testid={`request-abandon-${request.id}`} onClick={() => abandon(request)}>核对后放弃追踪</button>}
              {(request.status === 'paused' || request.status === 'failed' && (request.taskId || request.recoverable) || request.status === 'unknown' && request.taskId) && <button className="button" data-testid={`request-resume-${request.id}`} onClick={() => resume([request])}>{request.taskId ? '恢复原任务查询' : request.outputs?.length ? '恢复结果保存' : '确认继续请求'}</button>}
            </div>
            <ReturnedResults request={request} data={data} onPreview={onPreview} />
          </div> : <><EntryEditor entry={entry} apis={data.apis} onChange={draft => store.editEntry(entry.id, draft)} onProvider={provider => store.changeProvider(entry.id, provider)} onSettings={onSettings} aceStatus={ace.status} aceError={ace.error} checkingModels={ace.checking} onRefreshModels={() => void ace.refresh()} />{issue && <p className="field-note">提交前需完善：{issue}</p>}</>}
        </div>}
      </article>
    })}</div>}
    <Pager page={page} total={entries.length} onChange={next => setPages(old => ({ ...old, [kind]: next }))} />
    {historicalAssets.length > 0 && <section className="stack" data-testid="generation-historical-assets"><h2>历史素材 · {historicalAssets.length}</h2><p className="meta">以下素材来自本项目，但旧数据未关联完整请求记录。保留原名称和来源，不补发生成请求。</p>{historicalAssets.slice(historyPage * 20, historyPage * 20 + 20).map(asset => <div className="result-asset" key={asset.id}>{asset.kind === 'image' && <LibraryThumbnail id={asset.id} name={asset.name} available={asset.available} />}<div><strong>{asset.name}</strong><p className="meta">{asset.kind === 'audio' ? duration(asset.durationSeconds) : `${asset.width ?? '—'} × ${asset.height ?? '—'}`}{!asset.available ? ' · 文件不可用' : ''}</p></div><button className="button" onClick={() => onPreview(asset)}>{asset.kind === 'audio' ? '试听' : '查看'}</button></div>)}<Pager page={historyPage} total={historicalAssets.length} onChange={next => setHistoryPages(old => ({ ...old, [kind]: next }))} /></section>}
    {confirm && <ConfirmDialog value={confirm} onClose={() => setConfirm(null)} />}
    {importKind && <PromptImportDialog projectId={project.id} projectName={project.name} kind={importKind} data={data} store={store} onClose={() => setImportKind(undefined)} onCreated={async result => {
      await store.refresh()
      const snapshot = store.getSnapshot(), live = snapshot.data?.generationProjects.find(item => item.id === result.projectId)
      if (live && snapshot.data && snapshot.generationId === result.projectId) {
        const list = orderedProjectEntries(live, snapshot.data.entries).filter(entry => entry.kind === result.kind)
        setPages(old => ({ ...old, [result.kind]: Math.floor(Math.max(0, list.findIndex(entry => entry.id === result.entryIds[0])) / 20) }))
      }
      store.notify(`已创建 ${result.entryIds.length} 个草稿，尚未提交生成`)
    }} />}
  </div>
}
