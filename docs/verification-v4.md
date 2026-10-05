# 油管视频生成 V4.0 验收记录

## 交付范围与状态

按批准的《油管视频生成 V4.0：双项目、条目式生成、统一资产与并行合成重构》在原工程内完成，不是演示页替代。应用版本 **4.0.0**，包名 `music-canvas`、appId `local.musiccanvas.desktop`、`canvas:` / `window.canvas` 兼容命名保持。

- 已实现：独立生成/合成项目，单条单请求及全部返回版本，显式已添加 API，音乐/图片/视频统一资产、迁移、安全删除、独立使用账本，受控并行与持久诊断。
- 已移除：历史工作台导航、旧单视频运行服务/IPC、全局选材驱动合成、当前重复次数输入和全局默认生成参数页。历史算法只在测试 fixture 中保留，不恢复旧生产入口。
- 功能、完整回归、实际打包、portable 启动、原生窗口、**10项小时级全链路矩阵**和交付文件审计均通过。约定实施范围无剩余阻塞；真实服务与其它硬件等未验证边界列于末节。

本次全部测试使用新建 scratch profile、合成凭据和人工媒体。没有读取真实 Key、调用收费生成、访问用户 ACE 服务、部署模型/工具/驱动、重跑用户已经解决的历史故障批次或推送 GitHub。

## 最终测试结果

| 已实际执行 | 结果 | 本次 scratch 证据 |
|---|---|---|
| `npm.cmd run check` | TypeScript、ESLint、**724 测试 / 32 文件**通过 | `v4-final-check.log` |
| `npm.cmd run test:integration` | **70 测试 / 7 文件**通过 | `v4-integration-all.log` |
| `npm.cmd run test:e2e` | **13/13**通过；无跳过、排除或旧接口 shim | `v4-e2e-focus-final.log` |
| `npm.cmd run dist:win` | 当前 4.0.0 portable 与 unpacked 构建成功 | `v4-dist-final.log` |
| `npm.cmd run test:package` | 当前实际包的迁移、HTTP、65 秒成片、删除、重启通过 | `v4-package-final.log` |
| `python scripts/portable-smoke.py` | 实际 NSIS portable **两次**启动、独立草稿及重启通过 | `v4-portable-final.log` |
| `python scripts/visual-check.py` | 两种实测原生窗口、47 张截图、滚动/焦点/字号通过 | `v4-visual-final.log` |
| `node scripts/acestep-live-smoke-test.mjs` | 保留 CLI **10 组**通过；合成 HTTP，不是模型推理 | `v4-cli-final.log` |
| `node scripts/composition-performance.mjs` | **10/10项、22条3607秒输出**，完整验证/发布/记账通过 | `v4-composition-hour-final.log`、`composition-performance-v4-b34UWK/report.json` |

最后生产修改为异步确认焦点恢复；全量 check、13 项 E2E、构建和上述包/portable/原生检查均在该修改后执行。70 项集成已在编码器设备指纹缓存修改后执行，之后主进程未变。分项 82 项视频测试等已经包含在全量结果中，不能重复相加。

非阻塞信息：构建中的 Zod PURE 注释、静态/动态 import 提示，以及 Python Playwright 依赖的 Node `url.parse()` 弃用警告。没有因此关闭 CSP 或删除测试。当前目录没有 `.git`，不声称执行了成功的 `git diff --check`。

## 核心语义与安全回归

- 生成/合成 A、B 的 CRUD、项目选择、音乐/图片草稿、重启及异步后台归属隔离；不完整草稿可保存，确认提交校验实际能力与版本。
- 每条一个创建请求；确认批次冻结快照；不同提示词各提交一次；全部返回版本保留，即便字节去重后共用资产。
- 先落盘再 POST、受理未知不重发、原远端 ID 查询/保存、部分结果恢复、取消/关闭行为与跨项目隔离。
- 新安装 API 空列表、同厂商唯一、适用配置过滤、无 Key ACE；密文保存/接管。已有云配置可明确清除 Key 并保留配置，但无 Key 时不能测试/生成；新建云配置仍要求合法 Key。
- 真实导入、别名去重、外部原件保护、页内选材/试听/分组、计划过期阻止提交、不可变执行快照、单输出批次。
- 跨项目资源池、单任务/批次/项目取消、普通失败隔离、共享环境故障暂停等待项、重启恢复、成功不重跑。
- 发布与登记/记账中断只做本地对账。prepared 成片即使 interrupted 且通过别名引用，也不能在对账完成前删除；取消/失败/保存副本不增加使用次数。
- 新旧项目删除只移除工作区元数据；媒体、来源、成功使用历史独立存在。实际资产删除有影响确认、在途保护、受限托管路径和墓碑，不删除外部导入原件或另存副本。
- 当前 IPC 白名单、严格 schema、sender/main-frame/origin 检查、原生文件选择边界和安全媒体协议；Electron sandbox/contextIsolation/CSP 保持。
- 每次尝试独立诊断，阶段、素材、OS/退出码、脱敏 stderr 随重试保留；未知原因不写成“素材损坏”。

唯一一次有界代码复核发现的两个问题均先以失败单测复现再修复：未提交暂停请求重新确认时采用新的 submissionId；prepared 发布的 canonical/alias 成片受删除保护。未启动第二轮广泛复核。

## 实际打包版链路

权威报告：`$PI_SCRATCH_DIR/v4-package-report-IdzaTM/report.json`，`passed=true`、`testMode=false`。

1. 在实际 Electron/safeStorage 中生成合成凭据，再构造隔离 V1/V4 历史结构。保留该合成 profile 自己的 `Local State`，模拟原位升级；不声称密文可跨 Windows 用户/设备迁移。
2. 原 ID/名称/来源、密文字节、原始备份、暂停/未知请求、Opus 原件和 FLAC、历史视频及独立使用核对通过；媒体原位、不因项目删除失去播放。
3. 打包 sharp 实际处理 PNG/JPEG/WebP，完整 raw decode 和生产媒体协议加载通过。
4. 认证短 Key 的真实环回 TCP：创建 **1 次**、查询、下载真实 **65 秒 FLAC**；远端虚报 999 秒不作为时长。校验、播放、字节保留、去重通过。
5. 实际规划/合成一条 **65 秒、1920×1080/30fps H.264/AAC**，完整解码、播放、另存哈希一致、使用恰好一次。输出 SHA-256：`1663d8bfa392be12afb7ca52807ad9210d7ce9312cbb29426f5db7e936864db3`。
6. 真实重启后项目/成功记录保留，无重复 POST 或查询；再删除项目、重启，媒体和成功使用仍保留。打包应用忽略开发测试标志。

人工音频不是 ACE 神经网络推理；静音自动播放验证也不等于人工完整听音或音质评估。

## Portable 与真实窗口

- 直接运行 `dist/油管视频生成-4.0.0-Windows-x64.exe` 两次，文件产品版本 4.0.0.0；独立生成 A/B、合成 A/B、空 API、当前项目和草稿重启保持。证据 `v4-portable-reports/run-xk72dbob/report.json`。
- Win32 实测外框 **1366×768、1920×1080**，客户区 **1350×729、1904×1041**，DPI 96；不是只设网页 viewport 后自称原生分辨率。
- 白主区 `rgb(255,255,255)`，浅灰侧栏 `rgb(245,246,248)`；正文/控件16px、元数据至少14px、区块20px、标题24px、约44px控件。真实列表/正文/模态滚动、无横向溢出、长错误和焦点/Escape/返回焦点通过，`pageErrors=[]`。
- 权威报告 `v4-visual-reports/run-3aub726f/report.json`：**47 张**截图全部 readability failures/overflow 为空；后缀 `20261005-062259-4e0cca`。
- 文件名为机器本地 **2026-10-05（UTC+08:00）**的观察时间；批准计划原名保持，不用日期差异更名。当前图集见 `docs/ui-preview.html`，历史截图保留。

原生图集未提交新生成/合成请求；图片、音乐、账号和长错误均来自隔离人工 fixture。真实媒体执行另由集成/E2E/打包及性能脚本验证。

## 性能证据

引擎实现、安全回退、三种转场逐采样一致性与早期局部长测见 `docs/video-performance-v4.md`。早期 baseline warm 第三条因磁盘空间预检停止，该旧报告始终保持未完成；不改低阈值、拼接旧成绩或借用用户口述的“十分钟”。

最终 `scripts/composition-performance.mjs` 以实际队列执行：规划→确认→排队→渲染/完整验证→安全发布→视频入库/完整验证→使用记账。新建六首1805秒FLAC/三图，每条3607秒，同条件测单条与三条批次、基线/优化串行/并行2、应用冷/热缓存，共10项。导入/setup及额外独立音序/画面检查另列，不混入主耗时；不声称 OS/驱动缓存被清空。

**完整小时矩阵10/10项通过，22条输出全部通过规格、完整生产解码、每首音频顺序及首/中/末帧检查。** 基线单条冷/热275.108/283.381秒，V4串行232.733/221.216秒；三条基线858.957/866.310秒，V4串行697.372/671.984秒，并行2为524.400/511.605秒。并行2相对基线耗时减少38.9%/40.9%，实际引擎媒体进程重叠184.450/185.426秒，峰值均2任务。完整逐条阶段、队列、内存/临时盘采样下界、setup及额外验证耗时见 `docs/composition-performance-v4.md` 和同名JSON。旧基线4编码线程/libx264对照V4每任务2线程/auto QSV，属于整体执行方式对照，不冒充同编码器同线程单因素实验。中途空间预检失败已保留证据，仅清理自建失败/废弃人工媒体后全矩阵重跑；没有降低安全阈值。

本机实际编码器证据：QSV 和 CPU 已短编码/探测/解码通过；NVENC 要求 API 13.1、当前提供12.2，实测失败并回退，不宣称 NVIDIA 加速成功，也未安装驱动。

## 发布校验

| 核对项 | 已验证结果 |
|---|---|
| 便携产物 | `dist/油管视频生成-4.0.0-Windows-x64.exe` |
| 字节数 | **107,985,607 bytes** |
| SHA-256 | `3E130BABD3EBBF56E57CA416E2467B987144AE7FA9DED80BF46373E7959B4690` |
| 相邻校验文件 | `dist/油管视频生成-4.0.0-Windows-x64.exe.sha256` |
| 实际 Authenticode | portable及unpacked均 **NotSigned**，无签名证书；不把builder signing日志当可信签名 |
| 构建一致性 | app.asar内 **6个**构建文件与当前out逐字节一致；版本/包名/appId正确，无打包测试fixture、真实profile或环境文件 |
| 历史保全 | **5份**V1/V2.0/V2.1/V3.0/V3.1便携EXE的大小、SHA及相邻校验均与原保全清单一致 |
| 截图 | 最终 **47张PNG**全量raw解码、客户区尺寸及SHA检查通过，无重复图片哈希 |

审计证据为 `$PI_SCRATCH_DIR/v4-delivery-audit.json`，实际签名查询为 `v4-authenticode.json`。相邻校验文件和完整文档另作交付收口检查。V3.1原图集原样保存在 `docs/ui-preview-v3.1.html`，没有删除历史截图。

## 明确未验证的边界

- 真实云账号的计费、权限、返回质量和用户 ACE 神经推理；未授权访问或收费调用。
- 其它机器/驱动的硬件表现；不承诺本机人工 lossless 素材的速度适用于任意真实音乐。
- 100首/6小时、100输出极限的完整压力长测，真实硬件掉线、实际磁盘耗尽的破坏性测试。
- 任意真实历史 profile 的升级演练；已验证合成 V1–V4/历史结构，不读取用户数据。
- 无模型、服务、CUDA、FFmpeg/驱动部署；使用者需已有 FFmpeg/FFprobe 和足够资源，安全发布需可用的同卷硬链接。中断视频从头重试，不提供断点续编。

V1–V3.1 产物和验收文档保留。GitHub 只保留之前获准的 V3.0 发布，本轮不上传 V3.1/V4。

## 交付收口

- SHA-256相邻文件与实际portable重新核对；可携带摘要见 `docs/release-v4.json`，其中保存当前包、五份旧EXE、构建及截图审计信息。
- `docs/ui-preview.html`本地图集经Python Playwright补检：1366×768视口24张、1920×1080视口23张，全部原PNG成功加载，尺寸及alt文本正确，无横向溢出，目录跳转通过，pageErrors/consoleErrors均为空。证据 `v4-gallery-check.json`；这是文档页检查，不重复计入13项Electron或原生应用窗口成绩。浏览器面板一次长evaluate超时，补检已完成，没有作为通过证据使用该超时调用。
- 当前实现自最后包验证后未改动；后续仅文档、校验与隔离报告工作，不做无意义的重复打包。正式长测代码指纹与当前一致；阶段表来自本轮原始JSON，无旧轮次拼接。
