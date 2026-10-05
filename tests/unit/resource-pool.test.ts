import { describe, expect, it, vi } from 'vitest'
import { ResourcePool, type ResourceSample } from '../../src/main/video/resource-pool'
const GiB = 1024 ** 3
const settings = () => ({ concurrency: 2, threads: 4, encoder: 'cpu' as const, staticVideo: true })
const demand = { root: 'C:\\isolated', diskBytes: GiB, memoryBytes: 256 * 1024 ** 2, gpu: false }
const resources = (): ResourceSample => ({ threads: 16, freeMemory: 8 * GiB, freeDisk: 20 * GiB, freeGpu: 4 * GiB })

describe('shared resource-controlled render pool', () => {
  it('allows real simultaneous leases up to the global cap and starts waiting work on release', async () => {
    const pool = new ResourcePool(settings, async () => resources()), signal = new AbortController().signal
    const one = await pool.acquire('project-a-job1', demand, signal), two = await pool.acquire('project-b-job1', demand, signal)
    expect(pool.running).toBe(2)
    const waiting = vi.fn(), third = pool.acquire('project-a-job2', demand, signal, waiting)
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
    expect(pool.queued).toBe(1); expect(pool.running).toBe(2)
    one.release(); const three = await third; expect(pool.running).toBe(2)
    one.release(); expect(pool.running).toBe(2)
    two.release(); three.release(); expect(pool.running).toBe(0); pool.close()
  })
  it('cancels a waiting task without releasing or aborting independent active work', async () => {
    const pool = new ResourcePool(settings, async () => resources()), a = new AbortController(), b = new AbortController(), c = new AbortController()
    const one = await pool.acquire('a', demand, a.signal), two = await pool.acquire('b', demand, b.signal)
    const pending = pool.acquire('c', demand, c.signal); const rejected = expect(pending).rejects.toThrow('取消')
    c.abort(); await rejected
    expect(a.signal.aborted).toBe(false); expect(b.signal.aborted).toBe(false); expect(pool.running).toBe(2)
    one.release(); two.release(); pool.close()
  })
  it.each(['memory', 'disk', 'gpu'] as const)('waits for a real %s budget rather than oversubscribing', async resource => {
    const sample = resources(), notify = vi.fn(), abort = new AbortController()
    if (resource === 'memory') sample.freeMemory = 100 * 1024 ** 2
    if (resource === 'disk') sample.freeDisk = 100 * 1024 ** 2
    if (resource === 'gpu') sample.freeGpu = 100 * 1024 ** 2
    const pool = new ResourcePool(settings, async () => sample)
    const pending = pool.acquire('task', { ...demand, gpu: resource === 'gpu' }, abort.signal, notify)
    await vi.waitFor(() => expect(notify).toHaveBeenCalled())
    expect(pool.running).toBe(0)
    Object.assign(sample, resources()); pool.wake()
    const lease = await pending; expect(pool.running).toBe(1); lease.release(); pool.close()
  })
  it('rejects duplicate task IDs and invalid budgets', async () => {
    const pool = new ResourcePool(settings, async () => resources()), signal = new AbortController().signal
    const lease = await pool.acquire('same', demand, signal)
    await expect(pool.acquire('same', demand, signal)).rejects.toThrow('重复')
    await expect(pool.acquire('bad', { ...demand, diskBytes: NaN }, signal)).rejects.toThrow('预算')
    lease.release(); pool.close()
  })
})
