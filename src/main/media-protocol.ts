import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { idSchema } from '../shared/schemas'
import type { AssetKind } from '../shared/types'

interface AssetResolver { pathForAsset(id: string, kind: AssetKind, assetId: string): Promise<string> }
interface GlobalMediaSources {
  library: { pathForAsset(id: string): Promise<string> }
  batches: { pathForAsset(id: string, jobId: string): Promise<string> }
}
export async function mediaResponse(request: Request, store: AssetResolver, globals?: GlobalMediaSources): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (url.protocol !== 'canvas-media:' || !['asset', 'library', 'batch'].includes(url.hostname) || url.port || url.username || url.password || url.search || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 })
    const parts = url.pathname.split('/').slice(1)
    let file: string
    if (url.hostname === 'asset') {
      if (parts.length !== 3 || !['audio', 'image', 'video', 'preview'].includes(parts[1])) return new Response(null, { status: 404 })
      file = await store.pathForAsset(idSchema.parse(parts[0]), parts[1] as AssetKind, idSchema.parse(parts[2]))
    } else if (url.hostname === 'library' && globals && parts.length === 1) {
      file = await globals.library.pathForAsset(idSchema.parse(parts[0]))
    } else if (url.hostname === 'batch' && globals && parts.length === 2) {
      file = await globals.batches.pathForAsset(idSchema.parse(parts[0]), idSchema.parse(parts[1]))
    } else return new Response(null, { status: 404 })
    const info = await stat(file)
    if (!info.isFile()) return new Response(null, { status: 404 })
    const types: Record<string, string> = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
    const headers = new Headers({ 'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    let start = 0
    let end = info.size - 1
    let status = 200
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]))
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end) }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
      status = 206
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
    return new Response(stream, { status, headers })
  } catch { return new Response(null, { status: 404 }) }
}
