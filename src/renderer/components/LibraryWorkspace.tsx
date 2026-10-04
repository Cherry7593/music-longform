import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { ArrowRight, Download, FolderOpen, Image, Music2, Play, RefreshCw, Search, Upload } from 'lucide-react'
import type { LibraryAsset, LibraryKind } from '../../shared/library-types'
import type { LibraryController } from '../hooks/useLibrary'
import { dateLabel } from '../utils'
import { Banner } from './Common'
import { LibraryThumbnail } from './LibraryMedia'
import { videoDuration } from './VideoJobs'

const PAGE_SIZE = 30
const sourceName = (asset: LibraryAsset) => asset.origins.length ? asset.origins.map(origin => origin.type === 'import' ? '本地导入' : origin.name).filter((value, index, list) => list.indexOf(value) === index).join('、') : '来源未登记'

export function LibrarySelectionSummary({ library, disabled, onNext, nextLabel = '去批量合成' }: {
  library: LibraryController; disabled: boolean; onNext: () => void; nextLabel?: string
}) {
  const count = library.selection.audioIds.length + library.selection.imageIds.length
  return <div className="library-selection" data-testid="library-selection">
    <div><p aria-live="polite">已选 <strong>{library.selection.audioIds.length}</strong> 首音乐 · <strong>{library.selection.imageIds.length}</strong> 张图片</p>
      <p className="field-note">音乐总时长 {videoDuration(library.selectedSeconds)}（未扣转场重叠）{library.unavailableIds.length > 0 && <span className="error-text"> · {library.unavailableIds.length} 个已选素材不可用，请取消选择</span>}</p></div>
    <div className="button-row"><button type="button" className="text-button" disabled={disabled || !count} onClick={library.clearSelection}>清空选择</button>
      <button type="button" className="button primary" disabled={disabled} onClick={onNext}>{nextLabel}<ArrowRight size={16} /></button></div>
  </div>
}

function AssetUsageDetails({ asset }: { asset: LibraryAsset }) {
  return <div className="library-usage">
    <details><summary>{asset.usages.length ? `已使用 ${asset.usages.length} 次` : asset.historyUncertain ? '历史用量待核对' : '未使用'}</summary>
      <div className="library-usage-details">
        {asset.usages.length > 0 ? <ol>{asset.usages.map(usage => <li key={usage.id}><strong>{usage.name}</strong>
          <span>{usage.kind === 'batch' ? '批量成片' : '项目成片'} · {videoDuration(usage.durationSeconds)}</span><time dateTime={usage.finishedAt}>{dateLabel(usage.finishedAt, true)}</time></li>)}</ol>
          : <p>{asset.historyUncertain ? '旧成片的使用关系尚无法可靠还原，不计入「未使用」。' : '暂无成功成片记录；试听、规划和失败不计为使用。'}</p>}
        {asset.usages.length > 0 && asset.historyUncertain && <p className="warning-text">另有历史用量待核对。</p>}
        <p className="usage-source-title">素材来源</p>
        <ul>{asset.origins.map((origin, index) => <li key={index}>{origin.type === 'import' ? '本地导入' : origin.name}
          {origin.provider && ` · ${origin.provider === 'siliconflow' ? '硅基流动' : origin.provider === 'mureka' ? 'Mureka' : origin.provider}`}{origin.model && ` · ${origin.model}`}</li>)}</ul>
      </div>
    </details>
    {asset.queuedCount > 0 && <span className="field-note queued-label">排队中 {asset.queuedCount} 次</span>}
    {asset.historyUncertain && asset.usages.length > 0 && <span className="field-note warning-text">历史用量待核对</span>}
  </div>
}

export function LibraryWorkspace({ library, disabled, busy, onPreview, onExport, onReveal, onBatch, onGenerate }: {
  library: LibraryController; disabled: boolean; busy: string[]; onPreview: (asset: LibraryAsset) => void
  onExport: (asset: LibraryAsset) => void; onReveal: (asset: LibraryAsset) => void; onBatch: () => void; onGenerate: () => void
}) {
  const [kind, setKind] = useState<LibraryKind>('audio')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all')
  const [page, setPage] = useState(0)
  const allBox = useRef<HTMLInputElement>(null)
  const id = useId()
  const assets = library.snapshot?.assets
  const filtered = useMemo(() => (assets ?? []).filter(asset => asset.kind === kind
    && asset.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    && (filter === 'all' || (filter === 'used' ? asset.usages.length > 0 : !asset.usages.length && !asset.historyUncertain))), [assets, kind, search, filter])
  const selectable = filtered.filter(asset => asset.available).map(asset => asset.id)
  const selected = new Set(kind === 'audio' ? library.selection.audioIds : library.selection.imageIds)
  const allSelected = selectable.length > 0 && selectable.every(assetId => selected.has(assetId))
  const someSelected = selectable.some(assetId => selected.has(assetId))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const locked = disabled || Boolean(library.action)
  useEffect(() => { if (allBox.current) allBox.current.indeterminate = someSelected && !allSelected }, [someSelected, allSelected])
  function changeKind(next: LibraryKind): void { setKind(next); setPage(0) }
  function categoryKeys(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'audio' : event.key === 'End' ? 'image' : kind === 'audio' ? 'image' : 'audio'
    changeKind(next); document.getElementById(`${id}-tab-${next}`)?.focus()
  }
  const checkbox = (asset: LibraryAsset) => <input type="checkbox" data-testid={`library-select-${asset.id}`} aria-label={`选择${asset.name}`} checked={selected.has(asset.id)}
    disabled={disabled || (!asset.available && !selected.has(asset.id))} onChange={event => library.select(kind, [asset.id], event.target.checked)} />
  const actions = (asset: LibraryAsset) => <div className="library-item-actions">
    <button type="button" className="text-button" disabled={disabled || !asset.available} onClick={() => onPreview(asset)} aria-label={`${kind === 'audio' ? '试听' : '查看'}${asset.name}`}>{kind === 'audio' ? <Play size={15} /> : <Image size={15} />}{kind === 'audio' ? '试听' : '查看'}</button>
    <button type="button" className="icon-button" disabled={disabled || !asset.available || busy.includes(`library-export:${asset.id}`)} onClick={() => onExport(asset)} aria-label={`另存为${asset.name}`} title="另存为"><Download size={16} /></button>
    <button type="button" className="icon-button" disabled={disabled || busy.includes(`library-reveal:${asset.id}`)} onClick={() => onReveal(asset)} aria-label={`打开${asset.name}文件位置`} title="打开文件位置"><FolderOpen size={16} /></button>
  </div>
  return <section className="library-workspace" aria-label="总素材库" data-testid="library-workspace">
    <div className="library-toolbar">
      <div className="library-tabs" role="tablist" aria-label="素材分类">{(['audio', 'image'] as const).map(category => <button type="button" key={category} role="tab" id={`${id}-tab-${category}`}
        data-testid={`library-tab-${category}`} aria-controls={`${id}-panel`} aria-selected={kind === category} tabIndex={kind === category ? 0 : -1} onKeyDown={categoryKeys} onClick={() => changeKind(category)}>
        {category === 'audio' ? <Music2 size={17} /> : <Image size={17} />}{category === 'audio' ? '音乐' : '图片'}<span>{assets?.filter(asset => asset.kind === category).length ?? 0}</span></button>)}</div>
      <div className="button-row"><button type="button" className="button" disabled={locked || library.loading} onClick={() => void library.refresh()} data-testid="library-refresh"><RefreshCw size={16} />{library.loading ? '正在读取…' : '刷新素材库'}</button>
        <button type="button" className="button primary" disabled={locked || !library.snapshot} onClick={() => void library.importFiles(kind)} data-testid="library-import"><Upload size={16} />{library.action === 'import' ? '正在导入…' : kind === 'audio' ? '导入音乐' : '导入图片'}</button></div>
    </div>
    <p className="library-import-note field-note">本地多选导入，复制到素材库，不上传网络。{kind === 'audio' ? '支持 MP3、WAV、FLAC、AAC 编码 M4A。' : '支持单帧 PNG、JPEG、WebP。'}</p>
    {library.error && <Banner tone="error">{library.error}<button type="button" className="text-button" disabled={locked || library.loading} onClick={() => void library.refresh()}>重新读取</button></Banner>}
    {library.snapshot?.warnings.length ? <Banner tone="warning">{library.snapshot.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</Banner> : null}
    {library.imports && <Banner tone={library.imports.entries.some(entry => entry.status === 'failed') ? 'warning' : library.imports.cancelled ? 'info' : 'success'} onClose={library.dismissImports}>
      <p>{library.imports.cancelled ? '已取消导入' : `导入完成：新增 ${library.imports.entries.filter(entry => entry.status === 'imported').length} 个，重复 ${library.imports.entries.filter(entry => entry.status === 'duplicate').length} 个，失败 ${library.imports.entries.filter(entry => entry.status === 'failed').length} 个。成功项已保留。`}</p>
      {library.imports.entries.length > 0 && <details className="import-results" open={library.imports.entries.some(entry => entry.status === 'failed')}><summary>逐项导入结果</summary><ul>{library.imports.entries.map((entry, index) => <li key={index} className={entry.status === 'failed' ? 'error-text' : ''}>
        <strong>{entry.name}</strong><span>{entry.status === 'imported' ? '已导入' : entry.status === 'duplicate' ? '完全相同文件，已跳过（保留使用记录）' : `失败：${entry.error ?? '文件未通过校验'}`}</span></li>)}</ul></details>}
    </Banner>}
    <div className="library-filters">
      <label className="library-search"><Search size={17} /><span className="sr-only">搜索素材名称</span><input type="search" placeholder="搜索素材名称" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} /></label>
      <div className="library-status-filters" role="group" aria-label="使用状态筛选">{([{ value: 'all', label: '全部' }, { value: 'unused', label: '未使用' }, { value: 'used', label: '已使用' }] as const).map(item => <button type="button" key={item.value} className="chip" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(0) }}>{item.label}</button>)}</div>
    </div>
    <div className="library-select-row"><label className="library-check"><input ref={allBox} type="checkbox" checked={allSelected} disabled={disabled || !selectable.length} onChange={event => library.select(kind, selectable, event.target.checked)} data-testid="library-select-all" /><span>全选当前筛选结果 <span className="muted">（跨页 {selectable.length} 个可用素材）</span></span></label>
      <span className="field-note">找到 {filtered.length} 个{filter === 'unused' ? ' · 不含历史用量待核对' : ''}</span></div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${kind}`} tabIndex={0}>
      {!library.snapshot ? <div className="library-empty" role="status"><h2>{library.loading ? '正在读取素材库…' : '素材库暂时不可用'}</h2>{!library.loading && <p className="field-note">尚未取得素材列表，不代表库内没有素材。请通过上方按钮重试。</p>}</div> : !visible.length ? <div className="library-empty">
        <h2>{search || filter !== 'all' ? '没有符合筛选的素材' : kind === 'audio' ? '暂无音乐' : '暂无图片'}</h2>
        <p className="field-note">{search || filter !== 'all' ? '试试其他名称或「全部」状态；已有选择会保留。' : '导入本地素材，或直接生成，无需先新建项目。'}</p>
        {search || filter !== 'all' ? <button type="button" className="text-button" onClick={() => { setSearch(''); setFilter('all'); setPage(0) }}>清除筛选</button> : <button type="button" className="text-button" disabled={disabled} onClick={onGenerate}>去素材生成<ArrowRight size={16} /></button>}
      </div> : kind === 'audio' ? <table className="library-table" data-testid="library-audio-table"><caption className="sr-only">音乐素材，第 {currentPage + 1} 页</caption><colgroup><col className="check-col" /><col className="name-col" /><col className="duration-col" /><col className="source-col" /><col className="usage-col" /><col className="actions-col" /></colgroup>
        <thead><tr><th scope="col"><span className="sr-only">选择</span></th><th scope="col">音乐名称</th><th scope="col">时长</th><th scope="col">来源 / 日期</th><th scope="col">使用情况</th><th scope="col">操作</th></tr></thead>
        <tbody>{visible.map(asset => <tr key={asset.id} className={selected.has(asset.id) ? 'is-selected' : ''} data-asset-id={asset.id}>
          <td className="library-select-cell">{checkbox(asset)}</td><th scope="row"><span className="library-name">{asset.name}</span><span className={`availability ${asset.available ? '' : 'error-text'}`}>{asset.available ? '可用' : '不可用'}{asset.format && ` · ${asset.format.toUpperCase()}`}</span>{asset.problem && <p className="field-note error-text">{asset.problem}</p>}</th>
          <td data-label="时长">{asset.durationSeconds !== undefined ? videoDuration(asset.durationSeconds) : '待核对'}</td>
          <td data-label="来源"><span>{sourceName(asset)}</span><time className="library-date" dateTime={asset.createdAt}>{dateLabel(asset.createdAt, true)}</time></td>
          <td data-label="使用情况"><AssetUsageDetails asset={asset} /></td><td>{actions(asset)}</td>
        </tr>)}</tbody></table> : <div className="library-contact-sheet" data-testid="library-image-grid">{visible.map((asset, index) => <article className={`library-image ${selected.has(asset.id) ? 'is-selected' : ''}`} key={asset.id} data-asset-id={asset.id} style={{ '--item-delay': `${Math.min(index, 4) * 20}ms` } as CSSProperties}>
          <button type="button" className="library-image-open" aria-label={`查看${asset.name}`} disabled={disabled || !asset.available} onClick={() => onPreview(asset)}><LibraryThumbnail id={asset.id} name={asset.name} available={asset.available} /></button>
          <div className="library-image-info"><label className="library-check">{checkbox(asset)}<strong>{asset.name}</strong></label>
            <p className={`availability ${asset.available ? '' : 'error-text'}`}>{asset.available ? '可用' : '不可用'} · {asset.width ?? '—'} × {asset.height ?? '—'}{asset.format && ` · ${asset.format.toUpperCase()}`}</p>
            {asset.problem && <p className="field-note error-text">{asset.problem}</p>}
            <p className="field-note">{sourceName(asset)}</p><time className="library-date" dateTime={asset.createdAt}>{dateLabel(asset.createdAt, true)}</time>
            <AssetUsageDetails asset={asset} />{actions(asset)}</div>
        </article>)}</div>}
    </div>
    {filtered.length > 0 && <nav className="library-pagination" aria-label="素材分页"><span className="field-note">每页 {PAGE_SIZE} 个 · 第 {currentPage + 1} / {pages} 页</span><div className="button-row">
      <button type="button" className="button small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className="button small" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></div></nav>}
    <LibrarySelectionSummary library={library} disabled={disabled} onNext={onBatch} />
    {library.snapshot && <details className="library-root"><summary>素材库保存位置</summary><p className="field-note">{library.snapshot.config.root}</p>
      <p className="field-note">本地导入文件保存在固定库目录；历史项目素材仍引用原文件。</p>{!library.snapshot.assets.length && <button type="button" className="text-button" disabled={locked} onClick={() => void library.chooseRoot()}><FolderOpen size={16} />{library.action === 'root' ? '正在选择…' : '首次选择素材库目录'}</button>}</details>}
  </section>
}
