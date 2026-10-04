import { build } from 'esbuild'
import { mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

export const scratchRoot = process.env.PI_SCRATCH_DIR || os.tmpdir()
export async function loadVideoEngine(directory) {
  const output = path.join(directory, 'engine.cjs')
  await build({ stdin: { contents: "export * from './src/main/video/ffmpeg'; export {renderMedia} from './src/main/video/pipeline'; export {VideoJobManager} from './src/main/video/jobs';", resolveDir: path.resolve('.') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' })
  return createRequire(import.meta.url)(output)
}
export async function makeVideoFixture(options = {}) {
  const { seconds = [8, 8], parent = scratchRoot } = options
  const root = await mkdtemp(path.join(parent, 'yt-video-fixture '))
  const engine = await loadVideoEngine(root)
  const tools = await engine.requireTools()
  const imageId = randomUUID()
  const imagePath = path.join(root, `${imageId}.png`)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#e7edf8"/><rect x="100" y="100" width="470" height="520" rx="30" fill="#537bc5"/><circle cx="900" cy="350" r="160" fill="#d6a063"/><path d="M760 570h350" stroke="#273f58" stroke-width="18"/></svg>'
  await sharp(Buffer.from(svg)).png().toFile(imagePath)
  const tracks = []
  for (let i = 0; i < seconds.length; i++) {
    const id = randomUUID(), file = path.join(root, `曲目 ${i + 1} ${id}.wav`)
    const rate = i % 2 ? 48000 : 44100
    await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + 110 * i}:sample_rate=${rate}:duration=${seconds[i]}`, '-ac', i % 2 ? '2' : '1', '-c:a', 'pcm_s16le', file], { timeoutMs: 180000 })
    const probe = await engine.probeMedia(tools, file)
    tracks.push({ id, path: file, durationSeconds: probe.durationSeconds })
  }
  const work = path.join(root, 'render'); await mkdir(work)
  return { root, tools, engine, imagePath, imageId, tracks, work }
}
export const baseVideoDraft = {
  initialized: true, durationMode: 'target', targetSeconds: 3600,
  transition: 'crossfade', transitionSeconds: 3, fadeInSeconds: 2, fadeOutSeconds: 2,
  normalize: false, fit: 'contain'
}
export async function checkStaticFrames(engine, tools, video, root, times) {
  const frames = []
  for (let i = 0; i < times.length; i++) {
    const image = path.join(root, `frame-${i}.png`)
    await engine.runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(times[i]), '-i', video, '-map', '0:v:0', '-frames:v', '1', image], { timeoutMs: 60000 })
    frames.push(await sharp(image).resize(480, 270).removeAlpha().raw().toBuffer())
  }
  const differences = frames.slice(1).map(frame => frame.reduce((total, value, i) => total + Math.abs(value - frames[0][i]), 0) / frame.length)
  if (differences.some(value => value > 2)) throw new Error(`Static frame comparison failed: ${differences}`)
  return differences
}
