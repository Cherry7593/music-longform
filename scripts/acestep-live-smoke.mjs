import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const help = `ACE-Step 已运行服务的显式联调（不部署、不扫描、不下载模型）
用法：node scripts/acestep-live-smoke.mjs --url <API根URL> [选项]
  --help                  仅显示帮助；不联网、不读取密钥、不创建文件
  --url URL               必填；API 根地址，不是 WebUI 地址或 /v1 路径
  --generate              仅提交一次约 10 秒纯音乐；绝不自动重试创建
  --model NAME            默认 default；按生产音乐参数 schema 校验
  --wait-minutes N         默认 60；生产配置允许整数 5–180 分钟
  --allow-lan              明确授权所填私有 IP；HTTP 会明文传输 Key/音乐
  --work-dir DIRECTORY    隔离输出的父目录；每次新建独立子目录
  --resume RUN_DIRECTORY  从原工作目录继续查询/保存，绝不创建新任务
  --task-id ID             仅与 --resume 一起用，核对已记录的 taskID
  --ffmpeg FILE           本地 ffmpeg 可执行文件；默认从 PATH 查找
  --skip-playback          不启动隔离播放器；报告标记尚需在应用试听
不带 --generate/--resume 时只读 health/models。生成与恢复互斥。
仅从显式环境变量 ACESTEP_API_KEY 取可选 Key；不读取应用设置或秘密。
输出默认 PI_SCRATCH_DIR（未设置则系统临时目录），不写真实项目/素材库。
退出码：0=只读通过或保存+播放器采样通过；1=失败；2=等待超时/中止；
        3=音频已保存，但播放器未验证，尚需在应用试听。
即使播放器通过，也只是静音解码/播放进度验证，不等于人工听感或神经推理验收。`

class CliError extends Error {}
function parseArgs(args) {
  const flags = new Set(['generate', 'allow-lan', 'skip-playback'])
  const values = new Set(['url', 'model', 'wait-minutes', 'work-dir', 'resume', 'task-id', 'ffmpeg'])
  const parsed = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : ''
    if ((!flags.has(name) && !values.has(name)) || Object.hasOwn(parsed, name)) throw new CliError('参数未知或重复；请使用 --help。不要在命令行传入 Key。')
    if (flags.has(name)) parsed[name] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new CliError('参数缺少值；请使用 --help。')
      parsed[name] = value
    }
  }
  if (!parsed.url) throw new CliError('--url 必填；不会猜测或扫描服务地址。')
  if (parsed.generate && (parsed.resume || parsed['task-id'])) throw new CliError('--generate 与恢复查询互斥，已拒绝重复提交。')
  if (parsed['task-id'] && !parsed.resume) throw new CliError('--task-id 必须与原 --resume 工作目录一起使用，以核对旧任务的地址绑定。')
  if (parsed.resume && parsed['work-dir']) throw new CliError('--resume 复用原工作目录，不能同时指定 --work-dir。')
  return parsed
}

function localPath(value) {
  const file = path.resolve(value)
  if (/[\x00-\x1f]/.test(file) || /^[\\/]{2}/.test(file) || file.slice(process.platform === 'win32' ? 2 : 0).includes(':')
    || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(file))) throw new CliError('工作目录/工具必须使用本地路径，不能是网络共享或 URL。')
  return file
}
async function readCheckpoint(directory) {
  const file = path.join(directory, 'task.json')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new CliError('任务恢复文件无效；未联网、未提交。')
  const value = JSON.parse(await readFile(file, 'utf8'))
  if (value?.kind !== 'acestep-live-smoke-task' || value.version !== 1) throw new CliError('这不是本脚本的任务恢复目录。')
  return value
}

async function loadRuntime(directory) {
  const { build } = await import('esbuild')
  // Like music-test-utils, bundle the production implementation, not a second REST client.
  // Include its schemas in the same bundle so AppError identity is preserved too.
  const sharpEntry = require.resolve('sharp')
  const output = path.join(directory, 'smoke-support.cjs')
  await build({ stdin: { contents: `
    export {MusicRegistry} from './src/main/providers/music-registry';
    export {saveGeneratedAudio} from './src/main/generated-audio';
    export {requireTools} from './src/main/video/ffmpeg';
    export {defaultMusicDraft} from './src/shared/music-capabilities';
    export {aceStepConfigurationSchema, localKeySchema, musicDraftSchema} from './src/shared/music-schemas';
    export {validateTaskId} from './src/main/providers/music-contract';
    export {AppError} from './src/main/providers/http';
    export {mediaResponse} from './src/main/media-protocol';
    export {idSchema} from './src/shared/schemas';
  `, resolveDir: repository }, outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
  return { ...require(output), supportFile: output }
}

/** No API credentials, remote URLs, app settings, or app profile enter this player. */
async function checkPlayback(runtime, directory, files, skip, signal) {
  const manual = reason => ({ status: 'needs-manual-audition', reason, audibleQualityVerified: false })
  if (skip) return manual('显式跳过播放器自动化；尚需在应用试听。')
  if (signal.aborted) return manual('联调已中止；尚需在应用试听。')
  let application
  const stop = () => { void application?.close().catch(() => undefined) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const { _electron } = await import('@playwright/test')
    const profile = path.join(directory, 'player-profile')
    await mkdir(profile)
    const pageFile = path.join(directory, 'player.html')
    const mainFile = path.join(directory, 'player.cjs')
    const projectId = randomUUID()
    await writeFile(pageFile, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src canvas-media:; script-src \'none\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>隔离音频联调</title><audio controls></audio>')
    await writeFile(mainFile, `
const {app, BrowserWindow, protocol, session} = require('electron');
const {pathToFileURL} = require('node:url');
const {mediaResponse} = require(${JSON.stringify(runtime.supportFile)});
const profile = ${JSON.stringify(profile)}, page = ${JSON.stringify(pageFile)};
const files = ${JSON.stringify(files.map(file => ({ id: file.assetId, file: file.path })))};
app.setPath('userData', profile); app.setPath('sessionData', profile); app.setPath('crashDumps', profile); app.setAppLogsPath(profile);
protocol.registerSchemesAsPrivileged([{scheme:'canvas-media', privileges:{standard:true, secure:true, stream:true, supportFetchAPI:true}}]);
app.whenReady().then(async () => {
  const partition = 'acestep-smoke-${randomUUID()}', isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) => callback({cancel: details.url !== pathToFileURL(page).href && !details.url.startsWith('canvas-media://asset/')}));
  isolated.protocol.handle('canvas-media', request => mediaResponse(request, {async pathForAsset(project, kind, id) {
    const entry = files.find(file => file.id === id);
    if (project !== ${JSON.stringify(projectId)} || kind !== 'audio' || !entry) throw new Error('denied');
    return entry.file;
  }}));
  const window = new BrowserWindow({show:false, webPreferences:{partition, sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true, backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(page);
}).catch(() => app.exit(1));
app.on('window-all-closed', () => app.quit());
`)
    // Allowlist OS plumbing, not the caller's application/API secrets or Electron/Node injection flags.
    const environment = {}
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name]
    }
    environment.TEMP = directory; environment.TMP = directory; environment.TMPDIR = directory
    application = await _electron.launch({ executablePath: require('electron'), args: [mainFile], cwd: directory, env: environment, timeout: 20000 })
    if (signal.aborted) throw new CliError('interrupted')
    const page = await application.firstWindow({ timeout: 10000 })
    const samples = []
    for (const file of files) {
      const sample = await page.evaluate(async ({ url }) => {
        const audio = document.querySelector('audio')
        audio.muted = true
        audio.src = url
        return new Promise(resolve => {
          let finished = false
          const finish = passed => {
            if (finished) return
            finished = true
            clearTimeout(timer); clearInterval(progress)
            audio.pause()
            resolve({ passed, durationSeconds: audio.duration, playedSeconds: audio.currentTime })
          }
          const timer = setTimeout(() => finish(false), 15000)
          const progress = setInterval(() => {
            if (audio.error) finish(false)
            else if (audio.currentTime >= Math.min(1, audio.duration / 2) && audio.currentTime > 0 && audio.readyState >= 2) finish(true)
          }, 100)
          void audio.play().catch(() => finish(false))
        })
      }, { url: `canvas-media://asset/${projectId}/audio/${file.assetId}` })
      if (!sample.passed || !Number.isFinite(sample.durationSeconds) || Math.abs(sample.durationSeconds - file.durationMs / 1000) > 1) return manual('播放器未能验证解码、时长及播放进度；尚需在应用试听。')
      samples.push({ assetId: file.assetId, durationSeconds: sample.durationSeconds, playedSeconds: sample.playedSeconds })
    }
    return { status: 'passed', method: 'isolated-electron-production-media-protocol', muted: true, samples, audibleQualityVerified: false }
  } catch {
    // Never print Playwright launch diagnostics: they can contain inherited environment or URLs.
    return manual('隔离 Electron 播放器不可用或验证失败；FFmpeg 检查不等于播放，尚需在应用试听。')
  } finally {
    signal.removeEventListener('abort', stop)
    await application?.close().catch(() => undefined)
  }
}

async function main(args) {
  // Help is intentionally before imports/build, environment key access, filesystem, and networking.
  if (args.includes('--help')) { console.log(help); return 0 }
  let key
  // These outputs contain only explicitly selected, non-credential fields. Never serialize key,
  // connection, raw responses or media URLs; substring redaction would corrupt valid IDs/paths
  // for short keys (even 'a' is valid), making the checkpoint and resume instructions unusable.
  const print = text => console.log(text)
  const json = value => JSON.stringify(value, null, 2) + '\n'
  let work, reportFile, report, runtime, lock, timer
  const controller = new AbortController()
  let interrupted = false, timedOut = false
  const interrupt = () => { interrupted = true; controller.abort() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const persistReport = async () => { if (reportFile) await writeFile(reportFile, json(report), { mode: 0o600 }) }
  try {
    const options = parseArgs(args)
    key = process.env.ACESTEP_API_KEY // No other credential source, not even application SettingsStore.
    let checkpoint
    if (options.resume) {
      work = localPath(options.resume)
      if ((await lstat(work)).isSymbolicLink()) throw new CliError('恢复目录不能是符号链接。')
      work = localPath(await realpath(work))
      checkpoint = await readCheckpoint(work)
    } else {
      const parent = localPath(options['work-dir'] ?? process.env.PI_SCRATCH_DIR ?? os.tmpdir())
      await mkdir(parent, { recursive: true })
      work = await mkdtemp(path.join(localPath(await realpath(parent)), 'acestep-smoke-'))
    }
    try { lock = await open(path.join(work, '.smoke.lock'), 'wx', 0o600) } catch { throw new CliError('工作目录正在使用或存在中断后的锁；确认没有联调进程后再恢复，未联网。') }
    print(`WORK_DIR=${JSON.stringify(work)}`)
    const runtimeDirectory = await mkdtemp(path.join(work, 'runtime-'))
    runtime = await loadRuntime(runtimeDirectory)
    const parsed = runtime.aceStepConfigurationSchema.safeParse({ baseUrl: options.url, waitMinutes: options['wait-minutes'] === undefined ? 60 : Number(options['wait-minutes']), allowLan: options['allow-lan'] === true })
    if (!parsed.success) throw new CliError('连接配置未通过生产 schema：根 URL 必须是环回/私有 IP，等待须为 5–180 整数分钟，局域网必须显式 --allow-lan。')
    if (key !== undefined && !runtime.localKeySchema.safeParse(key).success) throw new CliError('ACESTEP_API_KEY 未通过生产 schema：须为 1–4096 个不含空白的可打印 ASCII 字符；无鉴权时请移除此环境变量。')
    const config = parsed.data
    let draft = { ...runtime.defaultMusicDraft('acestep'), prompt: 'A gentle ambient piano instrumental, calm sustained chords, no vocals.', title: 'ACE-Step explicit smoke test', model: options.model ?? 'default', seconds: 10, count: 1, thinking: false }
    if (checkpoint) {
      runtime.validateTaskId(checkpoint.taskId)
      if (options['task-id']) runtime.validateTaskId(options['task-id'])
      if (checkpoint.baseUrl !== config.baseUrl || (options['task-id'] && options['task-id'] !== checkpoint.taskId)
        || (options.model && options.model !== checkpoint.draft?.model)) throw new CliError('原任务的地址、taskID 或模型绑定不匹配；未联网，也不会向新服务发送旧任务/Key。')
      if (!Array.isArray(checkpoint.assetIds) || checkpoint.assetIds.length !== 20 || checkpoint.assetIds.some(id => !runtime.idSchema.safeParse(id).success)
        || new Set(checkpoint.assetIds).size !== 20) throw new CliError('任务恢复记录中的素材 ID 无效。')
      draft = checkpoint.draft
    }
    const validatedDraft = runtime.musicDraftSchema.safeParse(draft)
    if (!validatedDraft.success || draft.provider !== 'acestep' || draft.mode !== 'instrumental' || draft.seconds !== 10 || draft.count !== 1 || draft.thinking !== false || draft.inputMode !== 'lyrics') throw new CliError('模型/音乐参数未通过生产 schema 或不是本工具的 10 秒基础纯音乐任务。')
    draft = validatedDraft.data
    const mode = checkpoint ? 'resume' : options.generate ? 'generate' : 'readonly'
    reportFile = path.join(work, `report-${randomUUID()}.json`)
    report = { version: 1, baseline: { date: '2026-10-04', aceStep15Sha: 'ca1e85fe9430179831e6bc6be790c332190a3866' }, mode, startedAt: new Date().toISOString(), baseUrl: config.baseUrl,
      waitMinutes: config.waitMinutes, allowLan: config.allowLan, requestedModel: draft.model, requestedSeconds: mode === 'readonly' ? null : 10,
      createAttempted: false, taskId: checkpoint?.taskId ?? null, stage: 'connection', status: 'running', files: [],
      playback: { status: 'not-run' }, manualAuditionRequired: mode !== 'readonly', inferenceProvenance: 'unverified-service-output-not-proof-of-neural-inference' }
    await persistReport()
    if (config.allowLan && new URL(config.baseUrl).protocol === 'http:') print('警告：已授权局域网 HTTP，Key 与音频可能被同网段监听；优先环回或受信 HTTPS。')
    const connection = { baseUrl: config.baseUrl, ...(key === undefined ? {} : { key }), signal: controller.signal }
    const registry = new runtime.MusicRegistry()
    const adapter = registry.get('acestep')
    const status = await registry.getAceStepModels(connection)
    // Allowlist descriptive fields; never serialize connection, choices, raw responses, or error causes.
    report.connection = { modelsInitialized: status.modelsInitialized ?? null, llmInitialized: status.llmInitialized, defaultModel: status.defaultModel ?? null, loadedLmModel: status.loadedLmModel ?? null,
      models: status.models.map(model => ({ name: model.name, isDefault: model.isDefault, isLoaded: model.isLoaded ?? null })) }
    print(`模型：${JSON.stringify(report.connection)}；只读检查不证明实际生成。`)
    if (mode === 'readonly') { report.status = 'readonly-passed'; return 0 }
    report.stage = 'tools'
    const tools = await runtime.requireTools(options.ffmpeg ? localPath(options.ffmpeg) : undefined)
    if (!checkpoint) {
      report.stage = 'create'; report.createAttempted = true
      // Persist intent BEFORE the only create call; an interrupted response is never retried.
      await persistReport()
      const task = await adapter.create(draft, connection)
      report.taskId = task.id
      print(`TASK_ID=${JSON.stringify(task.id)}`)
      checkpoint = { kind: 'acestep-live-smoke-task', version: 1, baseUrl: config.baseUrl, taskId: task.id, draft, assetIds: Array.from({ length: 20 }, () => randomUUID()) }
      const handle = await open(path.join(work, 'task.json'), 'wx', 0o600)
      try { await handle.writeFile(json(checkpoint)); await handle.sync() } finally { await handle.close() }
    } else print(`TASK_ID=${JSON.stringify(checkpoint.taskId)}（仅恢复原任务）`)
    report.stage = 'query'
    await persistReport()
    timer = setTimeout(() => { timedOut = true; controller.abort() }, config.waitMinutes * 60000)
    let task
    for (;;) {
      task = await adapter.query(draft, checkpoint.taskId, connection)
      if (task.status === 'succeeded') break
      if (task.status === 'failed') throw new CliError('原任务推理失败；请查看服务端状态，未自动重新生成。')
      await sleep(2000, undefined, { signal: controller.signal })
    }
    clearTimeout(timer); timer = undefined
    report.actualModel = task.model ?? draft.model
    report.stage = 'save'
    await persistReport()
    for (const [index, choice] of task.choices.entries()) {
      const assetId = checkpoint.assetIds[index]
      const saved = await runtime.saveGeneratedAudio({ directory: work, assetId, url: choice.url, connection, getFFmpegPath: () => tools.ffmpeg, signal: controller.signal })
      report.files.push({ assetId, path: path.join(work, saved.fileName), durationMs: saved.durationMs, serverDurationMs: choice.durationMs ?? null, validation: 'production-saveGeneratedAudio-ffprobe-full-ffmpeg-decode' })
      await persistReport()
    }
    report.stage = 'playback'
    report.playback = await checkPlayback(runtime, runtimeDirectory, report.files, options['skip-playback'], controller.signal)
    if (controller.signal.aborted) throw new CliError('联调已中止。')
    report.status = report.playback.status === 'passed' ? 'saved-and-player-sampled' : 'saved-needs-audition'
    print(`实际模型：${report.actualModel}；实际音频时长：${report.files.map(file => `${file.durationMs / 1000} 秒`).join('、')}。`)
    print(report.playback.status === 'passed' ? '隔离播放器静音播放进度已验证；尚需在应用试听确认听感，不代表已证明神经模型推理。' : report.playback.reason)
    return report.playback.status === 'passed' ? 0 : 3
  } catch (error) {
    // Only authored CliError/AppError messages may escape; never render raw errors or causes.
    const message = timedOut ? '等待超时；保留原 taskID，使用 --resume 继续查询，勿再次 --generate。'
      : interrupted ? '联调已中止；服务端任务不一定停止。保留原任务，勿重复生成。'
        : error instanceof CliError || (runtime && error instanceof runtime.AppError) ? error.message
          : '本地联调失败；请检查参数、恢复文件、依赖和目录权限。未自动重新提交，未输出原始错误/服务响应。'
    if (report) {
      report.status = timedOut ? 'timed-out' : interrupted ? 'interrupted' : error?.uncertain ? 'submission-unknown' : 'failed'
      report.error = message
      if (report.createAttempted && !report.taskId) report.submissionWarning = '没有可恢复的 taskID；不能排除服务已受理，必须人工核对服务，禁止盲目重发。'
    }
    console.error(message)
    return timedOut || interrupted ? 2 : 1
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    if (report) {
      report.finishedAt = new Date().toISOString()
      if (report.taskId) report.resume = { directory: work, taskId: report.taskId, baseUrl: report.baseUrl, create: false }
      try { await persistReport(); print(`REPORT_JSON=${JSON.stringify(reportFile)}`) } catch { console.error('报告写入失败；请保留已显示的 TASK_ID 和工作目录，勿重复提交。') }
      if (report.taskId) print('恢复：相同 --url，加 --resume <WORK_DIR>（可加 --task-id <TASK_ID>），不要加 --generate；按需重新设置环境变量 Key。')
    }
    if (lock) { await lock.close(); await unlink(path.join(work, '.smoke.lock')).catch(() => undefined) }
  }
}

process.exitCode = await main(process.argv.slice(2)).catch(() => {
  console.error('联调收尾失败；请保留工作目录及 TASK_ID，勿重新提交。原始诊断未输出。')
  return 1
})
