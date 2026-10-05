import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'
import sharp from 'sharp'

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function scratchPath(file) {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required; never use a real profile or default Documents directory')
  const root = path.resolve(process.env.PI_SCRATCH_DIR), target = path.resolve(file)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Expected a child of PI_SCRATCH_DIR: ${target}`)
  return target
}
export async function createFixtureRoot(prefix = 'v4-package-') {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required')
  return scratchPath(await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, prefix)))
}
export async function saveJSON(file, value) {
  scratchPath(file)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(file, bytes, { flag: 'wx' })
  return bytes
}

/** Only current production serializers/probers and the opt-in TCP fixture; no V3 runtime or existing loader changes. */
export async function loadV4Fixtures(root) {
  scratchPath(root)
  const output = path.join(root, `v4-fixtures-${randomUUID()}.cjs`)
  const sharpEntry = createRequire(import.meta.url).resolve('sharp')
  await build({ stdin: { contents: `
    export * from './src/main/video/ffmpeg';
    export { WorkbenchDB } from './src/main/storage/workbench-db';
    export { AssetStore } from './src/main/storage/assets-v2';
    export { SecretStore } from './src/main/storage/secrets';
    export { migrateV4 } from './src/main/storage/migration-v4';
    export * from './src/main/migration/legacy-decode';
    export { libraryRecordSchema } from './src/main/storage/library-validation';
    export { videoBatchSchema } from './src/shared/batch-schemas';
    export { initialEntry, initialComposition, entrySchema, requestSchema, generationProjectSchema, compositionProjectSchema } from './src/shared/workbench-schemas';
    export { startAceStepFixture } from './tests/fixtures/acestep-server';
  `, resolveDir: workspaceRoot }, outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
  return createRequire(import.meta.url)(output)
}

/** Empty current V5 profile via the real migration. No fake ciphertext or user-directory access. */
export async function createCurrentProfile(root, engine) {
  scratchPath(root)
  const profile = path.join(root, 'profile'), mediaRoot = path.join(root, 'media')
  await mkdir(profile, { recursive: true })
  const db = new engine.WorkbenchDB(profile); await db.init()
  const assets = new engine.AssetStore({ dataDir: profile, root: mediaRoot, getFFmpegPath: () => undefined }); await assets.init()
  const forbidden = () => { throw new Error('Empty fixture must not encrypt or decrypt any credentials') }
  const secrets = new engine.SecretStore(profile, { isEncryptionAvailable: () => false, encryptString: forbidden, decryptString: forbidden }); await secrets.init()
  await engine.migrateV4({ dataDir: profile, defaultMediaRoot: mediaRoot, db, assets, secrets })
  if (db.list('generation').length || db.list('composition').length || db.list('apis').length) throw new Error('Empty fixture is not empty')
  return { profile, mediaRoot, db, assets }
}

export async function makeSyntheticMedia(root, engine) {
  const tools = await engine.requireTools(), imagePath = path.join(root, '人工画面.png')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#e7edf8"/><rect x="100" y="100" width="470" height="520" fill="#537bc5"/><circle cx="900" cy="350" r="160" fill="#d6a063"/></svg>'
  await sharp(Buffer.from(svg)).png().toFile(imagePath)
  const wav = path.join(root, '人工旧音乐.wav'), opus = path.join(root, '人工原始音频.opus'), flac = path.join(root, '人工兼容音频.flac'), httpAudio = path.join(root, '人工HTTP音频65秒.flac')
  const run = args => engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', ...args], { timeoutMs: 180000 })
  await run(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8', '-c:a', 'pcm_s16le', wav])
  await run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=9', '-c:a', 'libopus', opus])
  await run(['-i', opus, '-c:a', 'flac', flac])
  await run(['-f', 'lavfi', '-i', 'sine=frequency=990:sample_rate=48000:duration=65', '-c:a', 'flac', httpAudio])
  // A real, short historical success, not a current render or a performance benchmark.
  const video = path.join(root, '人工旧成功成片.mp4')
  await run(['-loop', '1', '-i', imagePath, '-i', flac, '-t', '9', '-vf', 'scale=1920:1080', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video])
  return { tools, imagePath, wav, opus, flac, httpAudio, video }
}

/** Two independent frozen legacy shapes. Every byte/key here was created for this test. */
export async function seedLegacyProfile(root, engine, media, version, ciphertext, local) {
  if (![1, 4].includes(version)) throw new Error('Only the approved V1 and V4 legacy profiles are seeded')
  const profile = path.join(root, `legacy-v${version}`, 'profile'), projectId = randomUUID()
  const directory = path.join(root, `legacy-v${version}`, '旧项目素材', projectId), mediaRoot = path.join(root, `legacy-v${version}`, '旧总素材库')
  for (const sub of ['audio', 'images', 'audio-originals', 'videos']) await mkdir(path.join(directory, sub), { recursive: true })
  const createdAt = '2026-05-01T01:02:03.000Z', updatedAt = '2026-05-02T04:05:06.000Z'
  const oldMusic = { prompt: '旧描述不应变成多次新请求', mode: 'instrumental', model: 'auto', count: 20, styles: [] }
  const oldImage = { prompt: '旧图片描述原样保留', model: 'gpt-image-2.5-flare', size: '1536x864', quality: 'medium', format: 'png' }
  const music = version === 1 ? oldMusic : { ...oldMusic, provider: 'acestep', model: 'default', inputMode: 'lyrics', seconds: 600, thinking: false }
  const image = version === 1 ? oldImage : { prompt: oldImage.prompt, model: 'Qwen/Qwen-Image', size: '1664x928' }
  const audioId = randomUUID(), imageId = randomUUID(), jobId = randomUUID(), imageJobId = randomUUID(), batchId = randomUUID(), aliasId = randomUUID()
  const audioFile = `audio/${audioId}.${version === 1 ? 'wav' : 'flac'}`, originalFile = `audio-originals/${audioId}.opus`, imageFile = `images/${imageId}.png`
  await copyFile(version === 1 ? media.wav : media.flac, path.join(directory, audioFile))
  if (version === 4) await copyFile(media.opus, path.join(directory, originalFile))
  await copyFile(media.imagePath, path.join(directory, imageFile))
  const audioBytes = await readFile(path.join(directory, audioFile)), imageBytes = await readFile(media.imagePath)
  const durationSeconds = (await engine.probeMedia(media.tools, path.join(directory, audioFile))).durationSeconds
  const binding = version === 4 ? { provider: 'acestep', adapterVersion: 1, local: { baseUrl: local.baseUrl, connectionId: local.connectionId } } : undefined
  const job = (status, index) => ({ id: index === 0 ? jobId : randomUUID(), batchId, index, createdAt, status, snapshot: music,
    ...(index < 2 ? { taskId: `synthetic-old-task-${index}` } : {}), ...(binding ? { binding } : {}) })
  const jobs = [job('succeeded', 0), job('running', 1), job('pending', 2), job('submitting', 3)]
  const outputId = randomUUID()
  if (version === 4) jobs[0].outputs = [{ id: outputId, assetId: audioId, index: 0, remoteId: 'synthetic-old-result', locator: digest(audioBytes), title: '不能改写的原曲名', status: 'saved' }]
  const audio = { id: audioId, jobId, taskId: 'synthetic-old-task-0', remoteId: 'synthetic-old-result', title: '不能改写的原曲名', fileName: audioFile,
    durationMs: durationSeconds * 1000, createdAt, model: music.model, prompt: '原音乐提示词', mode: 'instrumental', kept: true,
    ...(version === 4 ? { provider: 'acestep', resultId: outputId, originalFileName: originalFile, originalSha256: digest(await readFile(media.opus)) } : {}) }
  const project = { version, id: projectId, name: `历史V${version}项目名·不可改写`, directory, createdAt, updatedAt, music, image,
    batches: [{ id: batchId, total: 4, createdAt, state: 'running' }], musicJobs: jobs,
    imageJobs: [{ id: imageJobId, createdAt, status: 'succeeded', snapshot: image, ...(version === 4 ? { provider: 'siliconflow' } : {}) }],
    audio: [audio], images: [{ id: imageId, jobId: imageJobId, fileName: imageFile, createdAt, model: image.model, prompt: image.prompt, size: '1280x720',
      ...(version === 1 ? { quality: 'medium' } : { provider: 'siliconflow', format: 'png' }) }], selectedImageId: imageId }
  const audioLibraryId = randomUUID(), imageLibraryId = randomUUID()
  const audioRecord = { version: 1, item: { id: audioLibraryId, kind: 'audio', name: '历史已重命名库音乐', createdAt, sha256: digest(audioBytes), bytes: audioBytes.length,
    format: version === 1 ? 'wav' : 'flac', durationSeconds, available: true, origins: [{ type: 'project', name: project.name, projectId, assetId: audioId, provider: version === 1 ? 'mureka' : 'acestep', model: music.model, prompt: audio.prompt }] },
    locations: [{ type: 'project', projectId, assetId: audioId, directory, fileName: audioFile }], importPaths: [] }
  const records = [audioRecord, { ...structuredClone(audioRecord), item: { ...structuredClone(audioRecord.item), id: aliasId }, aliasOf: audioLibraryId },
    { version: 1, item: { id: imageLibraryId, kind: 'image', name: '历史已重命名库图片', createdAt, sha256: digest(imageBytes), bytes: imageBytes.length, format: 'png', width: 1280, height: 720,
      available: true, origins: [{ type: 'project', name: project.name, projectId, assetId: imageId, provider: version === 1 ? 'openai' : 'siliconflow', model: image.model, prompt: image.prompt }] },
    locations: [{ type: 'project', projectId, assetId: imageId, directory, fileName: imageFile }], importPaths: [] }]
  const oldFiles = new Map(), keep = async (file, value) => { const bytes = await saveJSON(file, value); oldFiles.set(file, bytes); return bytes }
  const settings = { version, projectRoot: path.dirname(directory), musicDefaults: music, imageDefaults: image, lastProjectId: projectId,
    ...(version === 4 ? { aceStep: local, ffmpegPath: media.tools.ffmpeg } : {}) }
  engine.decodeLegacySettings(settings)
  const secretData = version === 1 ? { version: 1, keys: { mureka: ciphertext.mureka, openai: ciphertext.openai } } : { version: 3, keys: { mureka: ciphertext.mureka, siliconflow: ciphertext.siliconflow } }
  engine.legacySecretsSchema.parse(secretData)
  await keep(path.join(profile, 'settings.json'), settings)
  const secretsBytes = await keep(path.join(profile, 'secrets.json'), secretData)
  await keep(path.join(profile, 'projects.json'), { version: 1, projects: [{ id: projectId, directory }] })
  await keep(path.join(profile, 'library', 'config.json'), { version: 1, root: mediaRoot, generationProjectId: projectId })
  await keep(path.join(profile, 'library', 'index.json'), { version: 1, ids: records.map(r => r.item.id) })
  for (const record of records) await keep(path.join(profile, 'library', 'items', `${record.item.id}.json`), engine.libraryRecordSchema.parse(record))
  let videoId, legacyBatchId, batchVideoId
  if (version === 4) {
    videoId = randomUUID(); legacyBatchId = randomUUID(); batchVideoId = randomUUID()
    const videoDraft = { initialized: true, audioIds: [audioId], imageId, durationMode: 'all', targetSeconds: 3600, transition: 'cut', transitionSeconds: 3, fadeInSeconds: 0, fadeOutSeconds: 0, normalize: false, fit: 'contain' }
    project.video = videoDraft
    project.videoJobs = [{ id: videoId, kind: 'video', status: 'succeeded', snapshot: videoDraft, createdAt, finishedAt: updatedAt, fileName: `videos/${videoId}.mp4`, durationSeconds: 9 }]
    await copyFile(media.video, path.join(directory, `videos/${videoId}.mp4`))
    const batchDirectory = path.join(root, 'legacy-v4', `历史批次-${legacyBatchId}`), group = { imageId: imageLibraryId, audioIds: [aliasId], durationSeconds: 9, issues: [] }, planId = randomUUID()
    await mkdir(path.join(batchDirectory, 'videos'), { recursive: true }); await copyFile(media.video, path.join(batchDirectory, `videos/${batchVideoId}.mp4`))
    const batch = { version: 1, id: legacyBatchId, planId, name: '不可改写的历史批次名', createdAt, updatedAt, directory: batchDirectory, state: 'completed',
      plan: { id: planId, createdAt, request: { name: '不可改写的历史批次名', audioIds: [aliasId], imageIds: [imageLibraryId], minimumSeconds: 60, transition: 'cut', transitionSeconds: 3, fadeInSeconds: 0, fadeOutSeconds: 0, normalize: false, fit: 'contain' },
        assets: records.filter(r => [aliasId, imageLibraryId].includes(r.item.id)).map(r => ({ id: r.item.id, kind: r.item.kind, name: r.item.name, sha256: r.item.sha256, bytes: r.item.bytes, ...(r.item.durationSeconds ? { durationSeconds: r.item.durationSeconds } : {}) })), groups: [group], issues: [] },
      jobs: [{ id: batchVideoId, index: 0, group, status: 'succeeded', fileName: `videos/${batchVideoId}.mp4`, durationSeconds: 9, finishedAt: updatedAt }] }
    await keep(path.join(profile, 'video-batches', 'index.json'), { version: 1, ids: [legacyBatchId] })
    await keep(path.join(profile, 'video-batches', `${legacyBatchId}.json`), engine.videoBatchSchema.parse(batch))
    const videoBytes = await readFile(media.video)
    await keep(path.join(profile, 'export-receipts', `${videoId}.json`), engine.legacyReceiptSchema.parse({ version: 1, id: videoId, ownerId: projectId, kind: 'project', name: project.name,
      state: 'prepared', finishedAt: updatedAt, durationSeconds: 9, assetIds: [audioLibraryId, imageLibraryId], directory, fileName: `videos/${videoId}.mp4`, sha256: digest(videoBytes), bytes: videoBytes.length }))
  }
  engine.decodeLegacyProject(project, directory, projectId)
  await keep(path.join(directory, 'project.json'), project)
  const mediaFiles = [path.join(directory, audioFile), path.join(directory, imageFile), ...(version === 4 ? [path.join(directory, originalFile), path.join(directory, `videos/${videoId}.mp4`), path.join(root, 'legacy-v4', `历史批次-${legacyBatchId}`, `videos/${batchVideoId}.mp4`)] : [])]
  const stamps = await Promise.all(mediaFiles.map(async file => { const stat = await lstat(file); return { file, sha256: digest(await readFile(file)), bytes: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino } }))
  return { version, profile, mediaRoot, directory, project, records, audioLibraryId, imageLibraryId, aliasId, audioId, imageId, jobs, oldFiles, secretsBytes, secretData, stamps, videoId, legacyBatchId, batchVideoId }
}

export async function makeVisualProfile(root, engine) {
  const current = await createCurrentProfile(root, engine), tools = await engine.requireTools(), now = new Date().toISOString()
  await current.db.update('settings', 'current', value => { value.ffmpegPath = tools.ffmpeg })
  const external = path.join(root, 'synthetic-originals'); await mkdir(external)
  const files = []
  for (let index = 0; index < 24; index++) {
    const file = path.join(external, `人工音乐-${String(index + 1).padStart(2, '0')}.flac`)
    await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', `sine=frequency=${220 + index * 17}:duration=65:sample_rate=48000`, '-c:a', 'flac', file])
    files.push(file)
  }
  await current.assets.importFiles(files, 'audio')
  const images = []
  for (const color of ['#264a7b', '#983917', '#3f6953']) {
    const file = path.join(external, `人工图片-${images.length + 1}.png`)
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: color } }).png().toFile(file); images.push(file)
  }
  await current.assets.importFiles(images, 'image')
  const generationId = randomUUID(), compositionId = randomUUID(), entries = []
  for (let index = 0; index < 26; index++) entries.push(engine.entrySchema.parse({ version: 1, id: randomUUID(), projectId: generationId, kind: 'audio', createdAt: now, updatedAt: now, revision: 0,
    draft: { ...engine.initialEntry('audio', 'mureka'), prompt: `人工界面验收草稿 ${index + 1}，不提交云服务`, title: `独立描述 ${index + 1}` }, alternatives: {} }))
  const visibleEntries = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  const failedEntry = visibleEntries[1], requestId = randomUUID(); failedEntry.requestId = requestId
  const longError = `人工故障记录，不来自客户或推理服务。文件与阶段信息须换行显示。${'模拟路径 C:/synthetic/很长的素材名称 与 stderr 内容 / diagnostic-id-1234567890；'.repeat(35)}`
  const request = engine.requestSchema.parse({ version: 1, id: requestId, entryId: failedEntry.id, projectId: generationId, submissionId: randomUUID(), createdAt: now, updatedAt: now, kind: 'audio', status: 'failed',
    snapshot: failedEntry.draft, binding: { provider: 'mureka', adapterVersion: 1 }, assetIds: [], error: longError, recoverable: false })
  await current.db.commit([...entries.map(value => ({ table: 'entries', id: value.id, value })), { table: 'requests', id: requestId, value: request },
    { table: 'generation', id: generationId, value: engine.generationProjectSchema.parse({ version: 1, id: generationId, name: '真实应用·人工界面验收A', createdAt: now, updatedAt: now, page: 'audio', entryIds: entries.map(e => e.id) }) }])
  for (let index = 0; index < 24; index++) {
    const id = randomUUID()
    await current.db.put('generation', id, { version: 1, id, name: `独立生成项目 ${index + 1} · 长名称保持可读`, createdAt: now, updatedAt: now, page: 'audio', entryIds: [] })
  }
  const assets = await current.assets.all(), audioIds = assets.filter(a => a.kind === 'audio').slice(0, 3).map(a => a.id), imageIds = assets.filter(a => a.kind === 'image').map(a => a.id)
  await current.db.put('composition', compositionId, engine.compositionProjectSchema.parse({ version: 1, id: compositionId, name: '真实应用·独立合成草稿', createdAt: now, updatedAt: now, revision: 0,
    draft: { ...engine.initialComposition(), minimumSeconds: 60, audioIds, imageIds }, batchIds: [] }))
  const settings = await current.db.update('settings', 'current', value => { value.lastGenerationId = generationId; value.lastCompositionId = compositionId })
  // settings.json is a compatibility mirror; WorkbenchDB current remains authoritative.
  await writeFile(path.join(current.profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  const manifest = { synthetic: true, version: '4.0.2', mode: 'visual', profile: current.profile, mediaRoot: current.mediaRoot, generationId, compositionId, entryId: visibleEntries[0].id, failedEntryId: failedEntry.id,
    longError, audioIds, imageIds, assets: assets.length, generationRequests: 1, paidCalls: 0, actualInference: false }
  await saveJSON(path.join(root, 'synthetic.json'), manifest)
  return manifest
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, mode: { type: 'string', default: 'empty' }, root: { type: 'string' } } })
  if (values.help) { console.log('Usage: node scripts/v4-package-fixtures.mjs --mode empty|visual --root <new isolated directory inside PI_SCRATCH_DIR>\nCreates current V4 disk fixtures only. No application build, AI calls, inference or video composition.'); return }
  const root = values.root ? scratchPath(values.root) : await createFixtureRoot('v4-fixtures-')
  await mkdir(root, { recursive: true })
  // Never reuse a profile or silently merge fixtures.
  try { await lstat(path.join(root, 'profile')); throw new Error('Fixture profile already exists; provide a new scratch directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const engine = await loadV4Fixtures(root)
  let manifest
  if (values.mode === 'empty') {
    const { profile, mediaRoot } = await createCurrentProfile(root, engine)
    manifest = { synthetic: true, version: '4.0.2', mode: 'empty', profile, mediaRoot }
    await saveJSON(path.join(root, 'synthetic.json'), manifest)
  } else if (values.mode === 'visual') manifest = await makeVisualProfile(root, engine)
  else throw new Error('Expected --mode empty or visual')
  console.log(JSON.stringify({ root, ...manifest }))
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
