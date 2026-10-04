import { build } from 'esbuild'
import { mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { scratchRoot } from './video-test-utils.mjs'

export async function loadBatchEngine(directory) {
  const output = path.join(directory, 'batch-engine.cjs')
  const sharpEntry = createRequire(import.meta.url).resolve('sharp')
  await build({ stdin: { contents: `
    export * from './src/main/video/ffmpeg';
    export {LibraryStore} from './src/main/storage/library';
    export {VideoBatchStore} from './src/main/storage/video-batches';
    export {ExportReceiptStore} from './src/main/storage/export-receipts';
    export {BatchJobManager} from './src/main/video/batch-jobs';
    export {RenderScheduler} from './src/main/video/scheduler';
    export {decorateLibrary} from './src/main/library/usage';
    export {DEFAULT_BATCH_OPTIONS} from './src/shared/batch-schemas';
    export {calculateTimeline} from './src/shared/video-timeline';
    export {batchDraft} from './src/shared/batch-planner';
    export {hashMedia} from './src/main/storage/managed';
  `, resolveDir: path.resolve('.') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
  return createRequire(import.meta.url)(output)
}
export async function makeBatchFixture({ count = 60, seconds = 185, images = 3 } = {}) {
  const root = await mkdtemp(path.join(scratchRoot, 'yt-v3-batch '))
  const engine = await loadBatchEngine(root)
  const tools = await engine.requireTools(process.env.FFMPEG_PATH)
  const sources = path.join(root, '原始素材'); await mkdir(sources)
  const audioPaths = []; const frequencies = []
  for (let i = 0; i < count; i++) {
    const frequency = 220 + i * 11; frequencies.push(frequency)
    const file = path.join(sources, `音乐 ${String(i + 1).padStart(2, '0')}.flac`)
    await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=24000:duration=${seconds}`, '-ac', '1', '-c:a', 'flac', file], { timeoutMs: 180000 })
    audioPaths.push(file)
  }
  const imagePaths = []
  for (let i = 0; i < images; i++) {
    const format = ['png', 'jpeg', 'webp'][i % 3]
    const file = path.join(sources, `背景 ${i + 1}.${format === 'jpeg' ? 'jpg' : format}`)
    const colors = ['#2b547a', '#4a715e', '#805645']
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="${colors[i % 3]}"/><circle cx="${250 + i * 200}" cy="350" r="150" fill="#e7c695"/><rect x="900" y="80" width="100" height="550" fill="#eee5d7"/></svg>`
    await sharp(Buffer.from(svg)).toFormat(format).toFile(file); imagePaths.push(file)
  }
  const dataDir = path.join(root, 'data'); const media = path.join(root, '总素材库')
  const projects = { async all() { return [] }, async get() { throw new Error('No projects in batch fixture') }, async pathForAsset() { throw new Error('No project asset') } }
  const library = new engine.LibraryStore({ dataDir, defaultRoot: media, projects, getFFmpegPath: () => tools.ffmpeg }); await library.init()
  const audioResult = await library.importFiles(audioPaths, 'audio'); const imageResult = await library.importFiles(imagePaths, 'image')
  if ([...audioResult.entries, ...imageResult.entries].some(e => e.status !== 'imported')) throw new Error(`Import failed: ${JSON.stringify([audioResult, imageResult])}`)
  const batches = new engine.VideoBatchStore(dataDir, () => library.getConfig().root); await batches.init()
  const receipts = new engine.ExportReceiptStore(dataDir); await receipts.init()
  const manager = new engine.BatchJobManager({ library, batches, receipts, scheduler: new engine.RenderScheduler(), getFFmpegPath: () => tools.ffmpeg, onError: message => console.error('BATCH_ERROR', message) })
  return { root, dataDir, media, tools, engine, library, batches, receipts, manager, audioPaths, imagePaths, frequencies,
    audioIds: audioResult.entries.map(e => e.assetId), imageIds: imageResult.entries.map(e => e.assetId) }
}
