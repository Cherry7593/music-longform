import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mediaResponse } from '../../src/main/media-protocol'
import { existingAssetPath, validAssetName } from '../../src/main/storage/paths'
import { assetURL, type AssetKind } from '../../src/shared/types'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true }))) })
async function directory(): Promise<string> {
  if (!process.env.PI_SCRATCH_DIR) throw new Error('PI_SCRATCH_DIR is required for isolated disk tests')
  const dir = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'canvas-media-中文 空格 '))
  dirs.push(dir)
  return dir
}
async function fixture(extension: 'wav' | 'png' | 'jpg' | 'webp' = 'wav') {
  const dir = await directory()
  const projectId = randomUUID(); const id = randomUUID()
  const kind = extension === 'wav' ? 'audio' : 'image'
  const folder = kind === 'audio' ? 'audio' : 'images'
  await mkdir(path.join(dir, folder))
  const fileName = `${folder}/${id}.${extension}`
  const file = path.join(dir, fileName)
  // Protocol tests exercise unchanged byte serving, not the download decoder.
  const bytes = extension === 'wav' ? Buffer.from('0123456789') : Buffer.from([0, 255, 2, 128, 4, 5, 6, 7, 8, 9])
  await writeFile(file, bytes)
  const pathForAsset = vi.fn(async (requestedProject: string, requestedKind: AssetKind, requestedId: string) => {
    if (requestedProject !== projectId || requestedKind !== kind || requestedId !== id) throw new Error('unknown asset')
    return existingAssetPath(dir, kind, id, fileName)
  })
  return { store: { pathForAsset }, url: assetURL(projectId, kind, id), dir, file, fileName, bytes, id, projectId }
}

describe('restricted media protocol', () => {
  it('supports full content and partial ranges for audio seeking', async () => {
    const f = await fixture()
    const full = await mediaResponse(new Request(f.url), f.store)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('audio/wav')
    expect(await full.text()).toBe('0123456789')
    const part = await mediaResponse(new Request(f.url, { headers: { range: 'bytes=2-5' } }), f.store)
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
  })

  it.each([['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const)('serves %s with correct MIME, byte ranges and HEAD headers', async (extension, mime) => {
    const f = await fixture(extension)
    const full = await mediaResponse(new Request(f.url), f.store)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe(mime)
    expect(full.headers.get('content-length')).toBe('10')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('cache-control')).toBe('no-store')
    expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await full.arrayBuffer())).toEqual(f.bytes)
    const part = await mediaResponse(new Request(f.url, { headers: { range: 'bytes=1-4' } }), f.store)
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe(mime)
    expect(part.headers.get('content-range')).toBe('bytes 1-4/10')
    expect(part.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await part.arrayBuffer())).toEqual(f.bytes.subarray(1, 5))
    const suffix = await mediaResponse(new Request(f.url, { headers: { range: 'bytes=-3' } }), f.store)
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(f.bytes.subarray(7))
    const head = await mediaResponse(new Request(f.url, { method: 'HEAD' }), f.store)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(mime)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    const partialHead = await mediaResponse(new Request(f.url, { method: 'HEAD', headers: { range: 'bytes=2-5' } }), f.store)
    expect(partialHead.status).toBe(206)
    expect(partialHead.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(partialHead.headers.get('content-length')).toBe('4')
    expect(await partialHead.text()).toBe('')
  })

  it.each([['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10']])('supports audio suffix/open-ended/clipped range %s', async (range, expected, contentRange) => {
    const f = await fixture()
    const response = await mediaResponse(new Request(f.url, { headers: { range } }), f.store)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(await response.text()).toBe(expected)
  })

  it.each(['bytes=999-', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-3', 'bytes=9007199254740992-', 'invalid'])('rejects invalid range %s without exposing content', async range => {
    const f = await fixture('webp')
    const response = await mediaResponse(new Request(f.url, { headers: { range } }), f.store)
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(await response.text()).toBe('')
  })

  it('rejects wrong origins, methods, queries, malformed identifiers and traversal before resolving files', async () => {
    const f = await fixture('jpg')
    for (const [url, method, status] of [
      [f.url.replace('canvas-media:', 'https:'), 'GET', 403],
      [f.url.replace('://asset/', '://evil/'), 'GET', 403],
      [`${f.url}?path=secrets.json`, 'GET', 403], [f.url, 'POST', 403],
      [`canvas-media://asset/not-a-uuid/image/${f.id}`, 'GET', 404],
      [`canvas-media://asset/${f.projectId}/image/not-a-uuid`, 'GET', 404],
      [`canvas-media://asset/${f.projectId}/file/${f.id}`, 'GET', 404],
      [`${f.url}/extra`, 'GET', 404],
      [`canvas-media://asset/${f.projectId}/image/%2e%2e%2fsecrets.json`, 'GET', 404],
      [`canvas-media://asset/${f.projectId}/image/%2e%2e%5csecrets.json`, 'GET', 404]
    ] as const) {
      const response = await mediaResponse(new Request(url, { method }), f.store)
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
    }
    expect(f.store.pathForAsset).not.toHaveBeenCalled()
  })

  it('returns not found for unregistered, missing and non-regular files without leaking paths', async () => {
    const f = await fixture('png')
    expect((await mediaResponse(new Request(assetURL(f.projectId, 'image', randomUUID())), f.store)).status).toBe(404)
    expect((await mediaResponse(new Request(assetURL(randomUUID(), 'image', f.id)), f.store)).status).toBe(404)
    await rm(f.file)
    const missing = await mediaResponse(new Request(f.url), f.store)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('')
    expect((await mediaResponse(new Request(f.url), { pathForAsset: async () => f.dir })).status).toBe(404)
  })

  it.each(['png', 'jpg', 'webp'] as const)('allows canonical %s names only and blocks forged paths', async extension => {
    const f = await fixture(extension)
    expect(validAssetName(f.fileName, 'image', f.id)).toBe(true)
    for (const unsafe of [
      `../${f.id}.${extension}`, `images/../${f.id}.${extension}`, `images\\${f.id}.${extension}`,
      `images/${randomUUID()}.${extension}`, `images/${f.id}.${extension}/extra`,
      `images/%2e%2e/${f.id}.${extension}`, `images/${f.id}.${extension}\0`,
      `images/${f.id}.svg`, `images/${f.id}.gif`, f.file
    ]) {
      expect(validAssetName(unsafe, 'image', f.id)).toBe(false)
      const response = await mediaResponse(new Request(f.url), { pathForAsset: () => existingAssetPath(f.dir, 'image', f.id, unsafe) })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
    expect(validAssetName(f.fileName, 'image', '../secret')).toBe(false)
  })

  it.each(['png', 'jpg', 'webp'] as const)('rejects %s files behind an escaping image-directory junction', async extension => {
    const f = await fixture(extension)
    const outside = await directory()
    await writeFile(path.join(outside, `${f.id}.${extension}`), 'outside private fixture')
    await rm(path.join(f.dir, 'images'), { recursive: true })
    await symlink(outside, path.join(f.dir, 'images'), process.platform === 'win32' ? 'junction' : 'dir')
    const response = await mediaResponse(new Request(f.url), f.store)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
  })
})

describe('global library and batch media protocol', () => {
  it.each([['flac', 'audio/flac'], ['m4a', 'audio/mp4'], ['mp4', 'video/mp4']] as const)('serves registered %s with ranged reads', async (extension, mime) => {
    const dir = await directory(); const id = randomUUID(); const owner = randomUUID()
    const file = path.join(dir, `${id}.${extension}`); await writeFile(file, '0123456789')
    const library = { pathForAsset: vi.fn(async () => file) }; const batches = { pathForAsset: vi.fn(async () => file) }
    const legacy = { pathForAsset: vi.fn(async () => { throw new Error('not legacy') }) }
    const url = extension === 'mp4' ? `canvas-media://batch/${owner}/${id}` : `canvas-media://library/${id}`
    const response = await mediaResponse(new Request(url, { headers: { Range: 'bytes=1-4' } }), legacy, { library, batches })
    expect(response.status).toBe(206); expect(response.headers.get('content-type')).toBe(mime); expect(await response.text()).toBe('1234')
    expect(legacy.pathForAsset).not.toHaveBeenCalled()
    if (extension === 'mp4') expect(batches.pathForAsset).toHaveBeenCalledExactlyOnceWith(owner, id)
    else expect(library.pathForAsset).toHaveBeenCalledExactlyOnceWith(id)
  })
  it('rejects malformed global addresses before invoking resolvers', async () => {
    const resolver = { pathForAsset: vi.fn(async () => 'C:\\secret') }
    for (const url of ['canvas-media://library/C:/secret', 'canvas-media://batch/../../secret', `canvas-media://library/${randomUUID()}?path=secret`, `canvas-media://library:8080/${randomUUID()}`]) {
      const response = await mediaResponse(new Request(url), resolver, { library: resolver, batches: resolver })
      expect([403, 404]).toContain(response.status)
    }
    expect(resolver.pathForAsset).not.toHaveBeenCalled()
  })
})
