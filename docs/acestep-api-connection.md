# ACE-Step 本地 API 连接与显式联调（V3.1）

## 基线与验收边界

- 协议基线：**2026-10-04**，官方 **ACE-Step 1.5** 源码 SHA：`ca1e85fe9430179831e6bc6be790c332190a3866`。这是固定兼容基线，不表示之后的任意版本都兼容。
- 用户自行部署、准备模型并启动服务。桌面应用和此 CLI 都不是部署器：不安装 Python/CUDA、不扫描端口、不下载模型、不启动/管理推理服务，不调用模型管理接口。
- **真实神经模型推理尚未实测。** 本次验证仅使用本地 HTTP 协议夹具和 FFmpeg 人工合成 FLAC；未访问真实用户服务或收费 API。夹具通过不能写成 ACE-Step 模型已经出曲。
- `health/models` 通过只证明接口可达、鉴权和响应形状符合基线；音频可解码/播放器进度正常也不能独立证明服务内部进行了神经推理。最终需要在用户明确授权的已运行服务生成短曲，并人工试听。

## 在应用中填写连接

1. 选择 **ACE-Step 本地**，填写服务的 **REST API 根 URL**，例如 `http://127.0.0.1:8001`。端口必须以用户的 API 服务配置为准；**API 端口不是 WebUI 网页端口**，能打开网页不代表 API 可用。
2. 不附加 `/v1`、`/health`、网页路径、账号、查询参数或片段。`localhost` 会规范化为 `127.0.0.1`。支持生产地址 schema 允许的环回/私有 IP；不接受任意公网地址或 DNS 域名。
3. 若服务启用了鉴权，填写该服务的可选 API Key；未启用时留空，不要填写占位词。Key 须为 1–4096 个不含空白的可打印 ASCII 字符。
4. 等待时间默认 **60 分钟**，允许整数 **5–180 分钟**。该设置控制等待任务结果，不保证推理一定在期限内完成。超时不等于服务端取消，更不应自动再生成。
5. 先做只读连接检查，再按返回的模型清单选择模型。**连接成功不等于生成成功**。

### 音乐模型和 LM 是两回事

- `modelsInitialized` 是音乐模型初始化状态；模型清单中的 `isLoaded` 是该模型的加载状态。默认模型可能由服务端延迟初始化，因此“服务可达、默认模型待初始化”不是实际出曲成功。
- `llmInitialized` / `loadedLmModel` 是语言模型（LM）的状态。LM 未就绪时仍可使用支持的**基础纯音乐/自填歌词**模式；“描述自动成歌”或“LM 增强”需要 LM 已就绪。
- CLI 固定使用基础纯音乐、约 10 秒、单次一首、`thinking=false`，生产适配器同时关闭 `sample_mode`、`use_format`、`use_cot_caption`、`use_cot_language`，不借测试触发 LM 增强。
- CLI 不负责补齐模型或下载 LM。若模型不可用、不支持 `text2music`、显存不足或服务推理失败，应由服务所有者检查服务端配置；不要以连续提交探测模型。

### 局域网与换地址

- 非环回的私有 IP 必须明确授权：应用中确认局域网连接，CLI 使用 `--allow-lan`。这不是自动发现，也不是信任局域网中的任何主机。
- **HTTP 局域网会明文传输 Key、提示词和音频**，可能被同网段监听或篡改。优先环回连接或使用受信证书的 HTTPS；不要关闭 TLS 校验，不要把服务未经保护暴露到公网。
- 应用更改规范化后的服务地址时会清除旧 ACE-Step Key，须为新服务重新配置；旧任务仍绑定原地址/连接身份，不能把旧 taskID 和 Key 转交给新服务。恢复旧任务须回到原服务并重新提供它的 Key。
- CLI 不读取应用秘密，也不会替用户更新应用设置。**切换 CLI 的 `--url` 前，应移除旧 `ACESTEP_API_KEY`，再显式设置目标服务的 Key**。`--resume` 会核对原地址、原 taskID 和原请求模型；不匹配时在联网前拒绝。

## CLI：先只读，再明确生成

前提：源码目录已有项目依赖，Node.js 可运行项目脚本；生成/恢复需要本地完整 FFmpeg 和同目录 FFprobe，可通过 `PATH` 或 `--ffmpeg` 指定。播放器自动化使用已有 Electron / Playwright；脚本不会自动安装它们。

以下为 PowerShell。示例地址仅作格式示意，**只对自己明确授权的已运行 API 服务执行**：

```powershell
Set-Location 'C:\Users\11478\Desktop\软件项目\music-longform'
node .\scripts\acestep-live-smoke.mjs --help

# 无鉴权时必须移除变量；--url 必填，默认只读 GET /health、GET /v1/models。
Remove-Item Env:ACESTEP_API_KEY -ErrorAction SilentlyContinue
node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001'
```

`--help` 不联网、不读取 Key、不创建文件；即使与 `--generate` 同时出现也仅显示帮助。没有 `--url` 会失败，不会猜测或扫描端口。只读模式不启动 FFmpeg 或播放器、不创建推理任务。

### 可选 Key：仅当前进程环境变量

不支持 `--key`、URL 内嵌 Key、秘密文件或应用 Key 回读。不要在聊天、命令历史或报告中粘贴真实 Key。可用安全输入临时注入（子进程内的环境变量仍是明文，测试后清理）：

```powershell
$secret = Read-Host '当前 ACE-Step 服务的 API Key' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $env:ACESTEP_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001'
    # 需要生成时，在这个 try 内改用下节明确带 --generate 的命令。
} finally {
    Remove-Item Env:ACESTEP_API_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secret.Dispose()
}
```

### 明确授权一次短曲

```powershell
# 鉴权服务请在上面的临时 Key 环境内执行；下面不含任何真实 Key。
node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001' --generate --wait-minutes 60

# 可选：明确选择清单中的模型、本地工具、隔离输出父目录。
# 这是另一次新任务的示例，不能在上一条超时后直接再执行。
node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001' --generate `
    --model 'acestep-v15-turbo' --ffmpeg 'C:\Tools\ffmpeg\bin\ffmpeg.exe' `
    --work-dir (Join-Path $env:TEMP 'acestep-explicit-checks')

# 已知私有 IP 只读示例；仅授权此目标，HTTP 存在上述明文风险。
node .\scripts\acestep-live-smoke.mjs --url 'http://192.168.1.20:8001' --allow-lan
```

- 只有 `--generate` 才调用一次生产 `MusicRegistry.get('acestep').create()`。生产预检会再读 health/models，但**不会重试创建任务**，不轮流尝试不同 POST 协议。
- 复用生产 `aceStepConfigurationSchema`、`musicDraftSchema`、`localKeySchema` 验证 URL、模型、等待、局域网授权及 Key；无效输入在 HTTP 前拒绝。`--model` 默认 `default`，代表服务默认模型，而不是一个额外的下载动作。
- 接收音频走相同生产认证传输及 `saveGeneratedAudio`，执行文件头/容器校验、FFprobe 探测、完整 FFmpeg 解码。报告区分请求 10 秒、服务声明时长和**实际解码时长**，不把远端时长当成真实探测。
- 请求使用固定的安静钢琴纯音乐提示词，无用户参考音频、翻唱或声音克隆。输出时长以实际返回为准。

## 输出、恢复与播放验证

输出默认在 `$env:PI_SCRATCH_DIR` 下新建 `acestep-smoke-*` 子目录；变量未设置时使用系统临时目录。`--work-dir` 指定**父目录**，仍会创建独立子目录。可从其他工作目录用脚本的绝对路径执行，生产源码定位不依赖调用时的 cwd。不要使用网络共享，也不要把真实应用数据目录当作临时目录。

控制台输出 `WORK_DIR`、取得后的 `TASK_ID`、最终 `REPORT_JSON`。独立工作目录保留：

- `report-*.json`：每次运行一份，记录基线、模式、模型就绪状态、原 taskID、实际模型/时长、保存文件、播放器结果和失败阶段。
- `task.json`：取得 taskID 后立即保存并刷盘；绑定原 URL、原草稿与稳定素材 ID，**不包含 Key 或远端媒体 URL**。
- `audio/`、`.generated-audio/`：生产保存结果和恢复凭据；不要只留下报告而删掉这些文件。
- `runtime-*/`：临时生产代码 bundle、隔离播放器页面/进程配置及其独立 profile；不会使用真实应用 profile，也不会把 Key 传给播放器。

报告和恢复文件只序列化明确选择的无凭据字段；不打印/记录鉴权连接对象、Key 字段、原始服务响应、响应媒体签名 URL 或 FFmpeg/Playwright 原始诊断，错误仅输出应用编写的安全提示。**不按 Key 子串替换 taskID、UUID、模型、草稿或路径**：合法单字符 Key（如测试用的 `a`）与普通字符相同，不代表记录了凭据，破坏这些字段反而会导致无法恢复。报告中的 taskID、局域网地址及本地路径仍可能涉及隐私，分享前自行审查。测试结束后由用户清理自己的工作目录；不要在仍需恢复时删除。

### 超时或保存失败：恢复原任务，不能再次提交

```powershell
# 用上次打印的 WORK_DIR 和原服务根地址替换占位值；按需重新临时设置原服务 Key。
node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001' `
    --resume 'C:\临时目录\acestep-smoke-上次目录' --wait-minutes 60

# 可额外核对原 taskID；不能单独使用 --task-id，更不能添加 --generate。
node .\scripts\acestep-live-smoke.mjs --url 'http://127.0.0.1:8001' `
    --resume 'C:\临时目录\acestep-smoke-上次目录' --task-id '原报告中的taskID'
```

等待时间从取得 taskID 后的轮询阶段计时；下载/完整解码使用生产保存器自己的限时。超时或 Ctrl+C 不发送服务端取消请求，服务端可能仍在运行。恢复只检查连接、查询原任务并继续保存/播放；已保存且指纹有效的文件复用生产凭据，不重新创建任务。每个工作目录有互斥锁；强制杀进程后若留下 `.smoke.lock`，先确认该目录没有运行中的联调，再人工删除这个锁。

若创建响应中断/畸形导致**没有 taskID**，报告会标明提交结果未知或提示不能排除已受理。此时没有可自动恢复的标识，必须由服务所有者核对队列/日志；**禁止盲目再次 `--generate`**。不要编造 taskID 或把其他服务的 taskID 填入恢复文件。

### 播放不是 FFmpeg 探测的同义词

生成/恢复成功后默认尝试独立 Electron 窗口，通过同一生产 `mediaResponse` / `canvas-media` 协议读取**本次已保存的本地音频**。它使用独立 profile、关闭页面网络和权限，保留 sandbox/contextIsolation/webSecurity，不修改应用安全配置。

自动化检查媒体时长、解码就绪和约 1 秒的真实播放进度，**静音、不评估听感，也不声称整首已人工听完**。仅有 FFmpeg 通过而播放器不可用/失败时，报告为 `needs-manual-audition`，明确输出“尚需在应用试听”。无桌面环境可显式 `--skip-playback`，结果同样是未验证播放，而不是通过。

请用现有应用素材导入/试听入口检查报告 `files[].path` 指向的音频，确认可听见、无异常且符合预期。脚本不会自动把测试音频写入真实项目或素材库；短曲也不改变批量视频最短时长等既有规则。

| 退出码 | 含义 |
| --- | --- |
| 0 | 只读检查通过，或保存且隔离播放器采样通过；均不是神经推理/听感验收结论 |
| 1 | 参数、连接、推理、保存等失败；查看安全报告，不自动重提 |
| 2 | 等待超时或中止；保留 taskID，用原目录恢复 |
| 3 | 音频已保存，但播放器未验证；尚需在应用试听 |

## 仅本地夹具的回归命令

```powershell
node --check .\scripts\acestep-live-smoke.mjs
node --check .\scripts\acestep-live-smoke-test.mjs
node .\node_modules\eslint\bin\eslint.js .\scripts\acestep-live-smoke.mjs .\scripts\acestep-live-smoke-test.mjs
node .\scripts\acestep-live-smoke-test.mjs
```

专用测试只启动临时环回 HTTP 夹具，以人工正弦波 FLAC 覆盖 readonly、显式 generate、鉴权、真实时长（10.25 秒而非服务声明的 10 秒）、播放器采样、恢复复用、地址绑定、防泄密及不确定提交不重试。新增单字符 `a` Key 的生成→恢复回归，逐字段核对原 taskID/草稿/UUID、控制台路径和恢复文件字节不变，确认只创建一次；凭据检查区分秘密字段与普通字符，不用子串扫描破坏合法标识。等待超时使用**仅测试子进程的时钟加速**，没有给正式 CLI 增加绕过 5–180 分钟 schema 的开关。

本次本地夹具回归已通过，包括隔离 Electron 的生产媒体协议静音播放进度检查；**真实 ACE-Step 神经推理、真实服务部署、显存适配、收费平台、人工听感均未实测**。如果另一环境没有播放器条件，测试报告会如实记录手动试听待办，而不会把该项写成已通过。
