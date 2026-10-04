import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** A failed operation does not poison later work. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** The caller supplies an already validated, existing parent directory. */
export async function atomicBuffer(path: string, data: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function atomicJson(path: string, data: unknown, maximum = 16 * 1024 * 1024): Promise<void> {
  const json = `${JSON.stringify(data, null, 2)}\n`
  if (Buffer.byteLength(json, 'utf8') > maximum) throw new Error('JSON file exceeds its storage limit')
  await atomicBuffer(path, Buffer.from(json, 'utf8'))
}

/** Bound disk reads too; a corrupt or concurrently enlarged JSON cannot exhaust memory. */
export async function readJson(path: string, maximum = 16 * 1024 * 1024): Promise<unknown> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('invalid JSON file size')
    const parts: Buffer[] = []
    let total = 0
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum - total + 1))
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      total += bytesRead
      if (total > maximum) throw new Error('invalid JSON file size')
      parts.push(buffer.subarray(0, bytesRead))
    }
    return JSON.parse(Buffer.concat(parts, total).toString('utf8')) as unknown
  } finally {
    await handle.close()
  }
}
