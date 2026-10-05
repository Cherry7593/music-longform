// Bounded synthetic selection fixture: short audio and tiny images, never renders video or calls AI.
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/v401-ui-fixture.mjs --root <new child of PI_SCRATCH_DIR>\nCreates isolated V4.0.1 multi-page selection data; no cloud calls, video encoding or real credentials.')
  process.exit(0)
}
const { parseArgs } = await import('node:util')
const { values } = parseArgs({ options: { root: { type: 'string' } } })
const { mkdir, writeFile, lstat } = await import('node:fs/promises')
const { randomUUID } = await import('node:crypto')
const { default: path } = await import('node:path')
const { default: sharp } = await import('sharp')
const { loadV4Fixtures, createCurrentProfile, scratchPath, saveJSON } = await import('./v4-package-fixtures.mjs')
const root = scratchPath(values.root)
await mkdir(root, { recursive: true })
try { await lstat(path.join(root, 'profile')); throw new Error('Refuse to reuse an existing profile') } catch (error) { if (error.code !== 'ENOENT') throw error }
const engine = await loadV4Fixtures(root), current = await createCurrentProfile(root, engine)
const { db, assets, profile, mediaRoot } = current
const rootId = await assets.managedRootId(), now = new Date().toISOString()
await mkdir(path.join(mediaRoot, 'audio'), { recursive: true }); await mkdir(path.join(mediaRoot, 'images'), { recursive: true })
const projects = { a: randomUUID(), b: randomUUID(), deleted: randomUUID(), overflow: randomUUID() }
const composition = { a: randomUUID(), b: randomUUID() }
for (const [key, id] of Object.entries(projects)) await db.put('generation', id, { version: 1, id, name: key === 'a' || key === 'b' ? '同名生成项目' : key === 'deleted' ? '已删项目原名' : '图片容量边界', page: 'audio', entryIds: [], createdAt: now, updatedAt: now, ...(key === 'deleted' ? { deletedAt: now } : {}) })
const entries = {}
for (const projectKey of ['a', 'b']) {
  entries[projectKey] = { audio: [], image: [], submitted: [] }
  for (const kind of ['audio', 'image']) {
    for (let index = 0; index < (projectKey === 'a' ? 26 : 3); index++) {
      const id = randomUUID(), projectId = projects[projectKey]
      const value = { version: 1, id, projectId, kind, createdAt: now, updatedAt: now, revision: 0, draft: { ...engine.initialEntry(kind), prompt: `${projectKey}-${kind}-${index + 1} 不生成的人工条目` }, alternatives: {} }
      if (index === 0) {
        const requestId = randomUUID(); value.requestId = requestId; value.draft = { ...engine.initialEntry(kind, kind === 'audio' ? 'mureka' : 'siliconflow'), prompt: value.draft.prompt }
        await db.put('requests', requestId, { version: 1, id: requestId, entryId: id, projectId, submissionId: randomUUID(), createdAt: now, updatedAt: now, kind, status: 'succeeded', snapshot: value.draft, binding: { provider: value.draft.provider, adapterVersion: 1 }, assetIds: [] })
        entries[projectKey].submitted.push(id)
      } else entries[projectKey][kind].push(id)
      await db.put('entries', id, value)
      await db.update('generation', projectId, row => { row.entryIds.push(id) })
    }
  }
}
const groups = { a: { audio: [], image: [] }, b: { audio: [], image: [] }, deleted: { audio: [], image: [] }, local: { audio: [], image: [] }, history: { audio: [], image: [] }, overflow: { audio: [], image: [] } }
const originals = [], missing = {}, multi = {}
function wave(frequency) {
  const rate = 8000, samples = 2000, bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * frequency) * 1500), 44 + i * 2)
  return bytes
}
let serial = 0
for (const key of Object.keys(groups)) for (const kind of ['audio', 'image']) {
  const count = key === 'a' ? 25 : key === 'b' ? 3 : key === 'overflow' ? kind === 'image' ? 101 : 0 : 1
  for (let index = 0; index < count; index++) {
    const id = randomUUID(), n = serial++, fileName = `${kind === 'audio' ? 'audio' : 'images'}/${id}.${kind === 'audio' ? 'wav' : 'png'}`
    const file = path.join(mediaRoot, fileName)
    const bytes = kind === 'audio' ? wave(220 + n * 7) : await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: n % 256, g: (n * 17) % 256, b: (n * 31) % 256 } } }).png().toBuffer()
    await writeFile(file, bytes)
    const origin = { type: key === 'local' ? 'import' : key === 'history' || key === 'deleted' ? 'legacy' : 'generation', name: key === 'a' || key === 'b' ? '旧同名' : key === 'deleted' ? '已删项目原名' : key,
      ...(projects[key] ? { projectId: projects[key] } : {}), ...(key === 'a' ? { provider: 'mureka-cn' } : key === 'b' ? { provider: 'mureka' } : {}) }
    const asset = await assets.register({ id, kind, name: `${key}-${kind}-${String(index + 1).padStart(2, '0')}`, createdAt: now, origin, rootId, fileName })
    groups[key][kind].push(asset.id); originals.push(file)
    if (key === 'a' && index === 1) { multi[kind] = id; await assets.register({ id, kind, name: asset.name, createdAt: now, origin: { type: 'generation', name: '旧同名', projectId: projects.b, provider: 'mureka' }, rootId, fileName }) }
    if (key === 'a' && index === 0) await assets.recordUsage({ version: 2, id: randomUUID(), name: '人工成功使用快照', finishedAt: now, durationSeconds: 1, assetIds: [id], uncertainAssetIds: [] })
    if (key === 'a' && index === 24) missing[kind] = { id, file }
  }
}
for (const key of ['a', 'b']) await db.put('composition', composition[key], { version: 1, id: composition[key], name: `合成${key.toUpperCase()}`, createdAt: now, updatedAt: now, revision: 0,
  draft: { ...engine.initialComposition(), audioIds: key === 'a' ? [groups.b.audio[1], groups.a.audio[2]] : [groups.b.audio[0]], imageIds: key === 'a' ? [groups.b.image[1]] : [groups.b.image[0]] }, batchIds: [] })
const settings = await db.update('settings', 'current', value => { value.page = 'composition'; value.lastGenerationId = projects.a; value.lastCompositionId = composition.a })
await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings))
const manifest = { synthetic: true, version: '4.0.1', root, profile, mediaRoot, projects, composition, entries, groups, multi, missing, originals, requests: db.list('requests').length, paidCalls: 0, actualInference: false }
await saveJSON(path.join(root, 'synthetic.json'), manifest)
console.log(JSON.stringify(manifest))
