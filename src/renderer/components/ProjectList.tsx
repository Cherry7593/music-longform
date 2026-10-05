import { useState } from 'react'
import { Plus, Search } from 'lucide-react'
import type { CompositionProject, GenerationProject } from '../../shared/workbench-types'

export function ProjectList({ kind, projects, selected, busy, onSelect, onCreate }: {
  kind: 'generation' | 'composition'; projects: Array<GenerationProject | CompositionProject>; selected?: string; busy: boolean
  onSelect: (id: string) => void; onCreate: () => void
}) {
  const [search, setSearch] = useState('')
  const filtered = projects.filter(p => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return <aside className="project-panel" aria-label={kind === 'generation' ? '生成项目列表' : '合成项目列表'}>
    <div className="project-panel-head"><strong>{kind === 'generation' ? '生成项目' : '合成项目'}</strong><span className="meta">{projects.length}</span></div>
    <button className="button new-project" data-testid={`${kind}-create`} disabled={busy} onClick={onCreate}><Plus size={18} />新建项目</button>
    <label className="search-field"><Search size={17} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="project-list">{filtered.length ? filtered.map(p => <button key={p.id} className="project-item" data-testid={`${kind}-project-${p.id}`} aria-current={p.id === selected ? 'true' : undefined} disabled={busy} onClick={() => onSelect(p.id)}><span>{p.name}</span><small>{new Date(p.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} · {'entryIds' in p ? `${p.entryIds.length} 条目` : `${p.batchIds.length} 批次`}</small></button>) : <p className="meta project-empty">{search ? '没有匹配项目' : '新建一个干净项目开始。'}</p>}</div>
    <p className="meta project-foot">{kind === 'generation' ? '生成与合成项目独立管理' : '选材只属于当前合成项目'}<br />删除项目不删除素材</p>
  </aside>
}
