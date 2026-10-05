import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface AceStepFixtureOptions { audio: Buffer; key?: string; durationSeconds: number; failDownloads?: number; lm?: boolean }
/** Synthetic audio + official HTTP shapes. This is NOT a real model-inference test. */
export async function startAceStepFixture(options: AceStepFixtureOptions) {
  const tasks = new Map<string, { body: Record<string, unknown>; polls: number; file: string }>()
  const requests: { method: string; route: string; authorized: boolean }[] = []
  let remainingFailures = options.failDownloads ?? 0
  const json = (response: ServerResponse, status: number, data: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: status, data, error: null }))
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const authorized = options.key === undefined ? request.headers.authorization === undefined : request.headers.authorization === `Bearer ${options.key}`
      requests.push({ method: request.method ?? '', route: url.pathname, authorized })
      if (!authorized) { json(response, 401, null); return }
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', service: 'ACE-Step API', version: '1.0', models_initialized: true, llm_initialized: options.lm === true, loaded_model: 'acestep-v15-turbo' }); return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        json(response, 200, { models: [{ name: 'acestep-v15-turbo', is_default: true, is_loaded: true, supported_task_types: ['text2music'] }], default_model: 'acestep-v15-turbo', llm_initialized: options.lm === true, lm_models: [], loaded_lm_model: null }); return
      }
      if (request.method === 'GET' && url.pathname === '/v1/audio') {
        if (![...tasks.values()].some(task => task.file === url.searchParams.get('path'))) { json(response, 404, null); return }
        if (remainingFailures > 0) { remainingFailures--; json(response, 503, null); return }
        response.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': options.audio.length })
        response.end(options.audio); return
      }
      if (request.method !== 'POST' || !['/release_task', '/query_result'].includes(url.pathname)) { json(response, 404, null); return }
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); length += bytes.length
        if (length > 64000) { json(response, 413, null); return }
        chunks.push(bytes)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (url.pathname === '/release_task') {
        if (body.task_type !== 'text2music' || body.batch_size !== 1 || body.audio_format !== 'flac' || typeof body.prompt !== 'string'
          || typeof body.audio_duration !== 'number' || body.audio_duration < 10 || body.audio_duration > 600 || body.reference_audio_path || body.src_audio_path) {
          json(response, 422, null); return
        }
        const taskId = randomUUID(), file = `/server-only/中文 音乐/${taskId}.flac`
        tasks.set(taskId, { body, polls: 0, file })
        json(response, 200, { task_id: taskId, status: 'queued' }); return
      }
      if (!Array.isArray(body.task_id_list) || body.task_id_list.length !== 1) { json(response, 422, null); return }
      const id = String(body.task_id_list[0]), task = tasks.get(id)
      if (!task) { json(response, 200, [{ task_id: id, result: '[]', status: 0 }]); return }
      task.polls++
      const status = task.polls < 2 ? 0 : 1
      const result = status === 1 ? [{ file: `/v1/audio?path=${encodeURIComponent(task.file)}`, status: 1, dit_model: 'acestep-v15-turbo', metas: { duration: options.durationSeconds }, prompt: task.body.prompt }] : []
      json(response, 200, [{ task_id: id, status, result: JSON.stringify(result) }])
    })().catch(() => { if (!response.headersSent) json(response, 400, null); else response.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind an ephemeral TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, requests, tasks,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    }
  }
}
