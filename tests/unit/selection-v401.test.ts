import { describe, expect, it } from 'vitest'
import { matchesUsage } from '../../src/renderer/components/AssetSelector'
import { COMPOSITION_SELECTION_LIMITS, appendSelection, deselectSelection, generationSubmissionIssue, getGenerationSelection, matchesSource, pendingEntries, replaceSelection, selectAvailable, sourceAssets, sourceOptions, updateGenerationSelection } from '../../src/renderer/selection'
import { WorkspaceStore } from '../../src/renderer/useWorkspace'
import { compositionDraftSchema, generationSelectionSchema, initialComposition } from '../../src/shared/workbench-schemas'
import type { AssetOrigin, GenerationEntry, GenerationProject, WorkbenchAsset } from '../../src/shared/workbench-types'

const at = '2026-10-05T00:00:00.000Z'
const uuid = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
const origin = (projectId?: string, name = '同名项目', type: AssetOrigin['type'] = 'generation'): AssetOrigin => ({ type, projectId, name })
const project = (id: string, patch: Partial<GenerationProject> = {}): GenerationProject => ({ version: 1, id, name: '同名项目', page: 'audio', entryIds: [], createdAt: at, updatedAt: at, ...patch })
const asset = (id: string, patch: Partial<WorkbenchAsset> = {}): WorkbenchAsset => ({ id, kind: 'audio', name: `曲目 ${id}`, createdAt: at, updatedAt: at, available: true, origins: [origin('A')], usages: [], usedCount: 0, queuedCount: 0, historyUncertain: false, ...patch })
const entry = (id: string, patch: Partial<GenerationEntry> = {}): GenerationEntry => ({ version: 1, id, projectId: 'A', kind: 'audio', createdAt: at, updatedAt: at, revision: 0, draft: { model: '', prompt: '' }, alternatives: {}, ...patch })
const idsOf = (items: readonly { id: string }[]): string[] => items.map(item => item.id)

function assetsFixture(): WorkbenchAsset[] {
  return [
    ...Array.from({ length: 45 }, (_, index) => asset(`A-${index}`, { available: index !== 30 })),
    asset('B-audio', { origins: [origin('B')] }),
    asset('image', { kind: 'image' }), asset('video', { kind: 'video' }),
    asset('unknown', { origins: [origin('gone', '来源快照')] }),
    asset('legacy', { origins: [origin('A', '旧名', 'legacy')] }),
    asset('import', { origins: [{ type: 'import', name: '本地文件' }] }),
    asset('no-origin', { origins: [] }), asset('no-project', { origins: [origin(undefined)] }),
  ]
}

describe('V4.0.1 source project filtering', () => {
  it('always offers all/import and live projects, even when a project has no assets', () => {
    expect(sourceOptions([], [project('A'), project('B')])).toEqual([
      { value: 'all', label: '全部来源' }, { value: 'import', label: '本地导入' },
      { value: 'project:A', label: '同名项目 · A' }, { value: 'project:B', label: '同名项目 · B' },
    ])
  })
  it('separates same-name A/B using exact IDs, not names or ID prefixes', () => {
    const assets = [asset('a'), asset('b', { origins: [origin('B')] }), asset('prefix', { origins: [origin('AA')] })]
    expect(idsOf(sourceAssets(assets, 'audio', 'project:A'))).toEqual(['a'])
    expect(idsOf(sourceAssets(assets, 'audio', 'project:B'))).toEqual(['b'])
  })
  it('shows the current name after rename while matching unchanged origin project IDs', () => {
    const assets = [asset('a', { origins: [origin('A', '改名前快照')] })]
    expect(sourceOptions(assets, [project('A', { name: '改名后' })]).find(option => option.value === 'project:A')?.label).toBe('改名后 · A')
    expect(idsOf(sourceAssets(assets, 'audio', 'project:A'))).toEqual(['a'])
    expect(assets[0].origins[0].name).toBe('改名前快照')
  })
  it('keeps deleted and unknown projects findable with snapshot names plus full IDs', () => {
    const assets = [asset('gone', { origins: [origin('deleted', '快照')] }), asset('unknown', { origins: [origin('unknown', '快照', 'legacy')] })]
    const options = sourceOptions(assets, [project('deleted', { deletedAt: at, name: '不应使用删除后名称' })])
    expect(options.find(option => option.value === 'project:deleted')?.label).toBe('快照 · deleted（已删除 / 未知项目）')
    expect(options.find(option => option.value === 'project:unknown')?.label).toBe('快照 · unknown（已删除 / 未知项目）')
    expect(idsOf(sourceAssets(assets, 'audio', 'project:deleted'))).toEqual(['gone'])
  })
  it('matches generation and legacy origins, but not import/composition IDs', () => {
    const assets = ['generation', 'legacy', 'import', 'composition'].map(type => asset(type, { origins: [origin('A', '同名项目', type as AssetOrigin['type'])] }))
    expect(idsOf(sourceAssets(assets, 'audio', 'project:A'))).toEqual(['generation', 'legacy'])
  })
  it('matches any of multiple origins and lists each asset and source option only once', () => {
    const multi = asset('multi', { origins: [origin('A'), origin('B'), origin('A'), origin('gone'), origin('gone', '另一快照')] })
    expect(idsOf(sourceAssets([multi, multi], 'audio', 'project:A'))).toEqual(['multi'])
    expect(idsOf(sourceAssets([multi], 'audio', 'project:B'))).toEqual(['multi'])
    expect(sourceOptions([multi], [project('A'), project('B')]).filter(option => option.value === 'project:gone')).toHaveLength(1)
  })
  it('uses import type only, without inferring local import from a name or missing provider', () => {
    const assets = [asset('named-import', { name: '本地导入' }), asset('local', { origins: [origin('A'), { type: 'import', name: '曲目' }] })]
    expect(idsOf(sourceAssets(assets, 'audio', 'import'))).toEqual(['local'])
    expect(matchesSource(assets[1], 'project:A')).toBe(true)
  })
  it('keeps missing project IDs and no origins in all/history without guessing a same-name project', () => {
    const assets = [asset('none', { origins: [] }), asset('missing', { origins: [origin(undefined)] }), asset('legacy-missing', { origins: [origin(undefined, '同名项目', 'legacy')] })]
    expect(idsOf(sourceAssets(assets, 'audio', 'all'))).toEqual(idsOf(assets))
    expect(idsOf(sourceAssets(assets, 'audio', 'unassigned'))).toEqual(idsOf(assets))
    expect(sourceAssets(assets, 'audio', 'project:A')).toEqual([])
    expect(sourceOptions(assets, [project('A')]).some(option => option.value === 'unassigned')).toBe(true)
  })
  it('combines source and usage filters, excluding uncertain history from unused', () => {
    const assets = [asset('unused'), asset('used', { usedCount: 1 }), asset('queued', { queuedCount: 2 }), asset('uncertain', { historyUncertain: true }), asset('other', { origins: [origin('B')] })]
    const a = sourceAssets(assets, 'audio', 'project:A')
    expect(idsOf(a.filter(value => matchesUsage(value, 'unused')))).toEqual(['unused', 'queued'])
    expect(idsOf(a.filter(value => matchesUsage(value, 'used')))).toEqual(['used'])
    expect(idsOf(a.filter(value => matchesUsage(value, 'queued')))).toEqual(['queued'])
    expect(idsOf(a.filter(value => matchesUsage(value, 'uncertain')))).toEqual(['uncertain'])
  })
  it('does not reorder or mutate assets while switching source and kind scopes', () => {
    const assets = assetsFixture(), original = structuredClone(assets)
    sourceAssets(assets, 'audio', 'project:B'); sourceAssets(assets, 'image'); sourceAssets(assets, 'audio', 'unassigned')
    expect(assets).toEqual(original)
    expect(idsOf(sourceAssets(assets, 'audio', 'project:A'))).toEqual([...Array.from({ length: 45 }, (_, index) => `A-${index}`), 'legacy'])
  })
})

describe('V4.0.1 atomic ordered selection across all pages', () => {
  it('selects all 45+ matching candidates, preserving the original order and appending in candidate order', () => {
    const candidates = sourceAssets(assetsFixture(), 'audio', 'project:A')
    const original = ['B-audio', 'A-24', 'A-2']
    const selected = selectAvailable(original, candidates)
    expect(selected).toEqual([...original, ...candidates.filter(value => value.available && !original.includes(value.id)).map(value => value.id)])
    expect(selected).toContain('A-44'); expect(selected).not.toContain('A-30')
    expect(original).toEqual(['B-audio', 'A-24', 'A-2'])
  })
  it('is idempotent for repeated select-all and repeated candidate IDs', () => {
    const candidates = sourceAssets(assetsFixture(), 'audio', 'project:A')
    const once = selectAvailable(['A-24'], candidates)
    expect(selectAvailable(once, [...candidates, ...candidates])).toEqual(once)
    expect(new Set(once).size).toBe(once.length)
  })
  it('does not add unavailable candidates or silently drop unavailable existing selections', () => {
    expect(selectAvailable(['A-30'], [asset('A-30', { available: false }), asset('new-missing', { available: false }), asset('ok')])).toEqual(['A-30', 'ok'])
  })
  it('deselects every matching page including unavailable selections and preserves out-of-scope order', () => {
    const candidates = sourceAssets(assetsFixture(), 'audio', 'project:A')
    const selected = ['B-audio', 'A-44', 'image', 'A-30', 'A-0', 'no-origin', 'deleted-selected']
    expect(deselectSelection(selected, idsOf(candidates))).toEqual(['B-audio', 'image', 'no-origin', 'deleted-selected'])
    expect(selected).toHaveLength(7)
  })
  it('can deselect an unavailable-only usage scope when select-all has nothing available', () => {
    const scope = sourceAssets(assetsFixture(), 'audio', 'project:A').filter(value => matchesUsage(value, 'unavailable'))
    expect(selectAvailable(['A-30', 'A-0'], scope)).toEqual(['A-30', 'A-0'])
    expect(deselectSelection(['A-30', 'A-0'], idsOf(scope))).toEqual(['A-0'])
  })
  it('keeps empty scopes and repeated deselect-all harmless', () => {
    expect(appendSelection(['b', 'a'], [])).toEqual(['b', 'a'])
    const once = deselectSelection(['b', 'a'], ['a'])
    expect(deselectSelection(once, ['a'])).toEqual(['b'])
    expect(deselectSelection(once, [])).toEqual(['b'])
  })
  it.each(['audio', 'image'] as const)('accepts the exact %s boundary defined by compositionDraftSchema', kind => {
    const limit = COMPOSITION_SELECTION_LIMITS[kind], ids = Array.from({ length: limit }, (_, index) => uuid(index + 1))
    const selected = appendSelection([], ids, limit)
    expect(compositionDraftSchema.safeParse({ ...initialComposition(), [kind === 'audio' ? 'audioIds' : 'imageIds']: selected }).success).toBe(true)
    expect(compositionDraftSchema.safeParse({ ...initialComposition(), [kind === 'audio' ? 'audioIds' : 'imageIds']: [...selected, uuid(limit + 1)] }).success).toBe(false)
  })
  it.each(['audio', 'image'] as const)('rejects %s bulk overflow atomically instead of truncating', kind => {
    const limit = COMPOSITION_SELECTION_LIMITS[kind], selected = ['keep-second', 'keep-first']
    const candidates = Array.from({ length: limit }, (_, index) => asset(`new-${index}`, { kind }))
    expect(() => selectAvailable(selected, candidates, limit)).toThrow(`最多可选择 ${limit} 项`)
    expect(selected).toEqual(['keep-second', 'keep-first'])
    expect(candidates).toHaveLength(limit)
  })
  it.each(['audio', 'image'] as const)('protects single-item addition at the %s limit too', kind => {
    const limit = COMPOSITION_SELECTION_LIMITS[kind], selected = Array.from({ length: limit }, (_, index) => `id-${index}`)
    const before = [...selected]
    expect(() => selectAvailable(selected, [asset('extra', { kind })], limit)).toThrow('原选择未更改')
    expect(selected).toEqual(before)
    expect(selectAvailable(selected, [asset('id-0', { kind }), asset('unavailable', { kind, available: false })], limit)).toEqual(before)
  })
  it('replaces in place without changing other slots or the input array', () => {
    const original = ['a', 'b', 'c']
    expect(replaceSelection(original, 'b', 'new')).toEqual(['a', 'new', 'c'])
    expect(original).toEqual(['a', 'b', 'c'])
  })
  it('rejects replacing with an already selected ID or a missing replacement slot', () => {
    const selected = ['a', 'b']
    expect(() => replaceSelection(selected, 'a', 'b')).toThrow('不能重复添加')
    expect(() => replaceSelection(selected, 'a', 'a')).toThrow('不能重复添加')
    expect(() => replaceSelection(selected, 'missing', 'new')).toThrow('待替换素材已改变')
    expect(selected).toEqual(['a', 'b'])
  })
})

describe('V4.0.1 library kind/search/usage scope', () => {
  it('selects only available matches across pages and preserves selections in other kinds and filters', () => {
    const assets = [...assetsFixture(), asset('A-used', { usedCount: 2 }), asset('image-match', { kind: 'image', name: '曲目 A-image' })]
    const filtered = sourceAssets(assets, 'audio').filter(value => value.name.toLocaleLowerCase().includes('曲目 a-') && matchesUsage(value, 'unused'))
    expect(filtered.length).toBeGreaterThan(20)
    const prior = ['image-match', 'video', 'B-audio', 'A-used', 'A-30']
    const selected = selectAvailable(prior, filtered)
    expect(selected.slice(0, prior.length)).toEqual(prior)
    expect(selected).toContain('A-44')
    expect(deselectSelection(selected, idsOf(filtered))).toEqual(['image-match', 'video', 'B-audio', 'A-used'])
  })
  it('switching kinds and deselecting one kind never clears the other kind', () => {
    const assets = assetsFixture()
    const audio = selectAvailable([], sourceAssets(assets, 'audio'))
    const mixed = selectAvailable(audio, sourceAssets(assets, 'image'))
    expect(mixed).toEqual([...audio, 'image'])
    expect(deselectSelection(mixed, idsOf(sourceAssets(assets, 'image')))).toEqual(audio)
    expect(deselectSelection(mixed, idsOf(sourceAssets(assets, 'audio')))).toEqual(['image'])
  })
})

describe('V4.0.1 pending generation selection and session isolation', () => {
  const entries = [
    ...Array.from({ length: 45 }, (_, index) => entry(`A-${index}`)),
    entry('submitted', { requestId: 'request' }), entry('deleted', { deletedAt: at }),
    entry('A-image', { kind: 'image' }), entry('B-audio', { projectId: 'B' }),
  ]
  it('scopes every page to current project/current kind pending entries only', () => {
    expect(idsOf(pendingEntries(entries, 'A', 'audio'))).toEqual(Array.from({ length: 45 }, (_, index) => `A-${index}`))
    expect(idsOf(pendingEntries(entries, 'A', 'image'))).toEqual(['A-image'])
    expect(idsOf(pendingEntries(entries, 'B', 'audio'))).toEqual(['B-audio'])
  })
  it('selects and deselects all pending pages without clearing other kinds/projects', () => {
    const scope = idsOf(pendingEntries(entries, 'A', 'audio'))
    const prior = ['A-image', 'B-audio', 'A-44']
    const selected = appendSelection(prior, scope)
    expect(selected).toHaveLength(47)
    expect(selected.slice(0, 3)).toEqual(prior)
    expect(appendSelection(selected, scope)).toEqual(selected)
    expect(deselectSelection(selected, scope)).toEqual(['A-image', 'B-audio'])
    expect(selected).not.toContain('submitted'); expect(selected).not.toContain('deleted')
  })
  it('allows UI selection above 500 but returns an explicit submission error without truncation', () => {
    const selected = appendSelection([], Array.from({ length: 501 }, (_, index) => `entry-${index}`))
    expect(selected).toHaveLength(501)
    expect(generationSubmissionIssue(selected.length)).toContain('单次最多提交 500')
    expect(generationSubmissionIssue(selected.length)).toContain('未提交任何条目')
    expect(selected.at(-1)).toBe('entry-500')
    expect(generationSubmissionIssue(0)).toBe('没有待提交条目')
  })
  it('permits exactly 500 pending submissions, matching the bridge schema boundary', () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({ id: uuid(index + 1), revision: 0 }))
    expect(generationSubmissionIssue(500)).toBeUndefined()
    expect(generationSelectionSchema.safeParse({ projectId: uuid(900), submissionId: uuid(901), entries }).success).toBe(true)
    expect(generationSelectionSchema.safeParse({ projectId: uuid(900), submissionId: uuid(901), entries: [...entries, { id: uuid(501), revision: 0 }] }).success).toBe(false)
  })
  it('restores A after A/B/A remounts and independently retains B', () => {
    const store = new WorkspaceStore()
    updateGenerationSelection(store, 'A', selected => new Set(appendSelection([...selected], ['A-44', 'A-0', 'A-image'])))
    expect(getGenerationSelection(store, 'B').size).toBe(0)
    updateGenerationSelection(store, 'B', selected => new Set(appendSelection([...selected], ['B-audio'])))
    expect([...getGenerationSelection(store, 'A')]).toEqual(['A-44', 'A-0', 'A-image'])
    expect([...getGenerationSelection(store, 'B')]).toEqual(['B-audio'])
    updateGenerationSelection(store, 'A', selected => new Set(deselectSelection([...selected], idsOf(pendingEntries(entries, 'A', 'audio')))))
    expect([...getGenerationSelection(store, 'A')]).toEqual(['A-image'])
    expect([...getGenerationSelection(store, 'B')]).toEqual(['B-audio'])
    expect(store.getSnapshot().saves).toEqual({})
  })
  it('isolates stores and returns copies so caller mutation cannot erase cached selections', () => {
    const one = new WorkspaceStore(), two = new WorkspaceStore()
    const returned = updateGenerationSelection(one, 'A', selected => selected.add('a'))
    returned.clear(); getGenerationSelection(one, 'A').clear()
    expect([...getGenerationSelection(one, 'A')]).toEqual(['a'])
    expect(getGenerationSelection(two, 'A').size).toBe(0)
  })
  it('leaves cached selections intact when an update fails part-way through', () => {
    const store = new WorkspaceStore()
    updateGenerationSelection(store, 'A', selected => selected.add('keep'))
    expect(() => updateGenerationSelection(store, 'A', selected => { selected.add('partial'); throw new Error('failed') })).toThrow('failed')
    expect([...getGenerationSelection(store, 'A')]).toEqual(['keep'])
  })
})
