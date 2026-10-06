# V4.0.4 — 音乐与图片生成请求分队列执行

## 问题

4.0.3 及之前，生成队列全局只有一个后台执行位，音乐与图片共用。音乐请求提交后要轮询到服务端完成（云端最长等待 30 分钟，ACE-Step 按设置默认 60 分钟），期间已确认的图片请求一直停在“等待串行提交”，表现为执行音乐时图片暂停。

## 改动范围

- `src/main/generation-jobs.ts`：`GenerationQueue` 从单一队列改为**音乐、图片两条独立通道**，各自有待执行集合、当前任务和取消信号。两条通道同时运行；**每条通道内部仍一次只处理一个请求**，不对同类服务并发发出付费请求。
- 忙碌状态、等待空闲和关闭流程覆盖两条通道；关闭软件时两条通道的本机等待都会停止，原任务保留、不重发。
- 停止未提交请求、恢复查询、放弃追踪，以及“同一确认批次出错后暂停其余待提交请求”，都按请求类型定位所在通道，原有语义不变。
- 新确认的待提交请求提示改为“等待串行提交（音乐队列 / 图片队列，不会重复创建）”。
- 不同音乐平台（如 Kie 与 ACE-Step）仍共用音乐通道、依次执行；本版不拆分。

**保留**：一个条目只创建一次请求；受理未知不自动重发；提交前先保存不可变记录；恢复只查询原任务 ID；多返回全部归属原条目；重启后未完成请求转为暂停或受理未知，不自动重新提交。数据库与素材库写入本来就各自串行排队，两条通道并发写入不需要新增锁；素材名称本就允许重名。

没有修改界面、API 接入与凭据、提示词导入、素材库、视频合成、设置或数据格式；没有升级依赖。

## 数据与升级

- 设置仍为 V5；生成/合成项目、请求、资产与发布记录格式不变，无迁移。
- 已保存旧请求的提示文本不改写；只有新确认的请求使用新提示。
- 升级前仍建议备份应用数据和媒体目录；不要用旧版编辑升级后的同一份数据。

## 验证（2026-10-07，macOS arm64，Node.js 24.21.0，npm 11.19.0）

- 新增单测 `runs image requests while a music request is still polling, keeping each kind serial`：音乐请求卡在轮询时提交两张图片，断言两张图片完成保存入库、音乐仍在运行、两张图片未同时请求（并发峰值 1）；放行后音乐完成，共 2 个音乐与 2 个图片资产，音乐只创建一次请求。
- 用 4.0.3 原队列代码运行同一测试：两张图片保持 `pending`，断言失败，复现原问题；恢复改动后通过。
- TypeScript、ESLint 全量通过；**1040 项单测 / 38 文件**全部通过；真实 FFmpeg 集成测试 `workbench-flow`（1 项）通过。
- 生产构建通过；Zod 注释警告为既有非阻塞警告。图标重新生成后与仓库文件字节一致。
- macOS 的 `/tmp` 是符号链接，存储层按设计拒绝；测试临时目录使用真实路径 `/private/tmp/...`。

未运行：Electron E2E、其余真实 FFmpeg 集成测试、视频性能、截图、厂商 API 或 ACE 神经推理。

## 打包

本版在 macOS（Apple Silicon）交叉打包，未使用 Wine：

1. 工程内 `npm run build` 生成 `out/`。
2. 在独立目录复制 `package.json`、`package-lock.json`、`electron-builder.yml`、`build/`、`out/`，以 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --os=win32 --cpu=x64` 安装依赖；原生模块只装入 `@img/sharp-win32-x64`。
3. `npm_config_platform=win32 npm_config_arch=x64 node node_modules/electron/install.js` 下载 Windows x64 Electron 44.5.1，按 electron 包内 `checksums.json` 校验。
4. `npx electron-builder --win portable --x64 --config.directories.output=dist/release-4.0.4 --config.toolsets.nsis=1.2.1`。

- electron-builder 默认 NSIS 3.0.4.1 的 macOS `makensis` 只有 x86_64，本机未装 Rosetta 无法运行。按用户选择，改用 electron-builder 统一工具包 **NSIS 3.12（`toolsets.nsis` 1.2.1，官方标为 beta）** 生成便携外壳。只在命令行指定，`electron-builder.yml` 未改；在 Windows 上照旧执行 `npm.cmd run dist:win` 仍使用默认工具包。
- EXE 图标与版本资源由 electron-builder 内置 resedit 写入。
- 包检查：外壳与内部 EXE 的 FileVersion / ProductVersion 均为 `4.0.4.0`，ProductName 为“油管视频生成”；无 Authenticode 签名；ASAR 内 6 个构建文件与 `out/` 逐字节一致，ASAR 内 `package.json` 版本为 4.0.4；原生模块仅 `sharp-win32-x64-0.35.5.node`（PE32+ x86-64）。

### 新文件

`dist/油管视频生成-4.0.4-Windows-x64.exe` — **106,850,664 bytes**，Windows x64 便携版，**未签名**。

相邻校验文件：`dist/油管视频生成-4.0.4-Windows-x64.exe.sha256`

```text
49F87F20B6DA9D730FD632717F0FF7D3594F5200E9F282FECDCB68DF5BFE84FE
```

经用户授权发布到 [v4.0.4 Release](https://github.com/Cherry7593/music-longform/releases/tag/v4.0.4)。附件名为 `music-longform-4.0.4-Windows-x64.exe`，与上述本地中文文件名成品字节一致；另附对应英文文件名的 SHA-256 校验文件。旧标签与旧版附件保留。

## 未验证边界

- **未在 Windows 实机启动**：没有运行 `scripts/portable-smoke.py`、`scripts/smoke-package.mjs` 或 `scripts/visual-check.py`。按用户决定不做实机验证直接发布；如启动异常，可继续使用 [v4.0.3](https://github.com/Cherry7593/music-longform/releases/tag/v4.0.3)。
- 便携外壳 NSIS 版本与 4.0.3（3.0.4.1）不同。EXE 比 4.0.3 小 1,146,253 bytes，未逐项归因。
- 音乐与图片同时请求时的真实厂商额度、限流行为未用真实 API 验证。
