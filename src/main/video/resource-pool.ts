import os from 'node:os'
import path from 'node:path'
import { statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import type { RenderSettings } from '../../shared/workbench-types'
import { CancelledError } from './ffmpeg'
import { AppError } from '../providers/http'

const MiB = 1024 ** 2
export interface ResourceDemand { root: string; diskBytes: number; memoryBytes: number; gpu: boolean }
export interface ResourceSample { threads: number; freeMemory: number; freeDisk: number; freeGpu?: number }
export interface ResourceLease { threads: number; release(): void }
interface Waiting { id: string; demand: ResourceDemand; signal: AbortSignal; notify?: (reason: string) => void; resolve: (lease: ResourceLease) => void; reject: (error: Error) => void; abort: () => void }
interface Reservation { id: string; demand: ResourceDemand; threads: number }
let gpuCached: { at: number; bytes?: number } | undefined
async function freeGpu(): Promise<number | undefined> {
  if (gpuCached && Date.now() - gpuCached.at < 10000) return gpuCached.bytes
  const bytes = await new Promise<number | undefined>(resolve => {
    if (process.platform !== 'win32') { resolve(undefined); return }
    const file = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe')
    execFile(file, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 2000, maxBuffer: 4096 }, (error, output) => {
      if (error) { resolve(undefined); return }
      const value = Number(output.trim().split(/\r?\n/)[0]); resolve(Number.isFinite(value) ? value * MiB : undefined)
    })
  })
  gpuCached = { at: Date.now(), bytes }; return bytes
}
export async function sampleResources(root: string): Promise<ResourceSample> {
  const disk = await statfs(root, { bigint: true })
  return { threads: os.availableParallelism(), freeMemory: os.freemem(), freeDisk: Number(disk.bavail * disk.bsize), freeGpu: await freeGpu() }
}
/** One process-wide pool, shared by every composition project. No process-name kills. */
export class ResourcePool {
  private waiting: Waiting[] = []
  private active = new Map<string, Reservation>()
  private draining = false
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(private readonly settings: () => RenderSettings, private readonly sample: (root: string) => Promise<ResourceSample> = sampleResources) { }
  get running(): number { return this.active.size }
  get queued(): number { return this.waiting.length }
  acquire(id: string, demand: ResourceDemand, signal: AbortSignal, notify?: (reason: string) => void): Promise<ResourceLease> {
    if (this.closed || signal.aborted) return Promise.reject(new CancelledError())
    if (this.active.has(id) || this.waiting.some(item => item.id === id)) return Promise.reject(new AppError('同一视频任务不能重复进入资源池'))
    if (![demand.diskBytes, demand.memoryBytes].every(value => Number.isFinite(value) && value >= 0)) return Promise.reject(new AppError('视频资源预算无效'))
    return new Promise((resolve, reject) => {
      const entry: Waiting = { id, demand, signal, notify, resolve, reject, abort: () => {
        this.waiting = this.waiting.filter(value => value !== entry); signal.removeEventListener('abort', entry.abort); reject(new CancelledError()); this.wake()
      } }
      signal.addEventListener('abort', entry.abort, { once: true }); this.waiting.push(entry); this.wake()
    })
  }
  wake(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.draining && !this.closed) void this.drain()
  }
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (const item of [...this.waiting]) {
        if (item.signal.aborted || this.closed || !this.waiting.includes(item)) continue
        const options = this.settings(), maximum = Math.max(1, Math.min(4, options.concurrency))
        let sample: ResourceSample
        try { sample = await this.sample(item.demand.root) }
        catch { item.notify?.('暂时无法检查输出磁盘空间，等待恢复或取消任务。'); continue }
        if (item.signal.aborted || !this.waiting.includes(item)) continue
        const totalThreads = Math.max(1, sample.threads - (sample.threads > 4 ? 2 : 0))
        const threads = Math.max(1, Math.min(options.threads, Math.floor(totalThreads / maximum)))
        const reservations = [...this.active.values()]
        const memory = reservations.reduce((sum, value) => sum + value.demand.memoryBytes, 0)
        const rootVolume = path.parse(path.resolve(item.demand.root)).root.toLowerCase()
        const disk = reservations.filter(value => path.parse(path.resolve(value.demand.root)).root.toLowerCase() === rootVolume).reduce((sum, value) => sum + value.demand.diskBytes, 0)
        const hardware = reservations.filter(value => value.demand.gpu).length
        let reason = ''
        if (this.active.size >= maximum) reason = `等待全局任务名额（${this.active.size} / ${maximum}）`
        else if (reservations.reduce((sum, value) => sum + value.threads, 0) + threads > totalThreads) reason = '等待可用 CPU 线程预算'
        else if (sample.freeMemory - memory < item.demand.memoryBytes + 512 * MiB) reason = '可用内存不足，等待其他任务释放内存'
        else if (sample.freeDisk - disk < item.demand.diskBytes + 512 * MiB) reason = `等待临时磁盘空间，预计本任务需 ${(item.demand.diskBytes / 1024 ** 3).toFixed(1)} GB（尚未运行）`
        else if (item.demand.gpu && (hardware >= 2 || (sample.freeGpu !== undefined && sample.freeGpu < (hardware + 1) * 384 * MiB))) reason = '等待可用硬件编码会话或显存；可在设置选择 CPU'
        if (reason) { item.notify?.(reason); continue }
        this.waiting = this.waiting.filter(value => value !== item); item.signal.removeEventListener('abort', item.abort)
        this.active.set(item.id, { id: item.id, demand: item.demand, threads })
        let released = false
        item.resolve({ threads, release: () => { if (released) return; released = true; this.active.delete(item.id); this.wake() } })
      }
    } finally {
      this.draining = false
      if (this.waiting.length && !this.closed) { this.timer = setTimeout(() => { this.timer = undefined; this.wake() }, 1000); this.timer.unref() }
    }
  }
  close(): void {
    this.closed = true; if (this.timer) clearTimeout(this.timer)
    for (const item of [...this.waiting]) item.abort()
  }
}
