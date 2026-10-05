# V4 独立迁移

## 启动合同

`src/main/storage/migration-v4.ts` 导出：

```ts
inspectV4Migration(dataDir: string, defaultMediaRoot: string): Promise<{
  mediaRoot: string
  legacySettings?: Settings // 仅内存解码为 V4，供旧 FFmpeg/ACE/根目录兼容；不是新的全局默认参数
  warnings: string[]
}>

migrateV4({ dataDir, db, assets, secrets, defaultMediaRoot }): Promise<{ warnings: string[] }>
```

调用顺序：

1. `inspectV4Migration`：只读所有已登记的旧元数据，完整验证后选择媒体根；不实例化旧 `ProjectStore`，不创建目录、不升级旧项目/设置。错误必须阻止启动，不能当成新安装。
2. 以返回的 `mediaRoot` 构造 `AssetStore({dataDir, root, getFFmpegPath})`；调用 `db.init()`、`assets.init()`、`secrets.init()`。
3. 调用 `migrateV4`；完成之前不要启用生成、合成或旧同步写入。它不会请求厂商、推理、渲染或部署工具。
4. 后续以 `db.get('settings', 'current')` 为权威设置，包含 FFmpeg 路径。完成后 inspect 不再返回旧设置，也不再扫描旧来源。

DB 仅使用 `list/get/has/commit`；资产仅使用 `registerRoot/register/alias/get/recordUsage/allUsage`；凭据只调用 `has(provider, connectionId?)`，不调用 `get`、解密、重新加密或清空。

## 来源与备份

识别 `settings.json` V1–V4、`projects.json` 及其登记目录内 `project.json` V1–V4、`library/config.json` / `index.json` / `items/*.json`、`video-batches/*.json`、`export-receipts/*.json` 和加密 `secrets.json`。旧项目形状由 `src/main/migration/legacy-decode.ts` 独立解码，历史模型不受当前提供方提交规则变化影响。所有文件有字节/数量上限，并拒绝符号链接、junction、越界和非本地路径。

媒体根优先为旧库配置；没有库配置时为旧 `settings.projectRoot/总素材库`。只有确实没有旧业务数据的新安装才使用 `defaultMediaRoot`。丢失旧根设置、索引引用的项目/资产/批次详情、损坏 JSON、循环别名或冲突记录都会明确停止；不会改写为空索引。已落盘但尚未入索引的库/批次详情纳入迁移，旧索引不修写。

迁移文件位于 `dataDir/migration-v4/`：

- `backup/<来源路径稳定UUID>.<内容SHA256>.bak`：独占创建、原字节保存，只备份元数据，不复制媒体。
- `backup/manifest.json`：原始绝对来源路径、备份文件名、字节数、SHA-256；不在日志打印密文。
- `journal.json`：备份清单指纹、开始时间、`backed-up → assets → records → complete` 阶段、稳定 UUID 映射、最终 canonical 资产映射、已对账回执和警告。
- `complete.json`：完成标记和记录数量。它存在后不会重扫旧库，删除的资产/项目不会因旧文件仍在而复活。

`SecretStore.init()` 自己进行必要的 V1/V2 密文格式升级并独占保存原备份；本迁移将其原备份和当前密文一并保留。V3 密文不改变。所有其他旧索引、项目、库配置、回执和批次字节均不修改；只有完整备份及新记录提交核对成功后，根 `settings.json` 才写为 V5，供目录识别使用。

## 数据归宿

- 历史项目（包括固定自动生成会话）成为普通生成项目，保留 ID/名称。新安装的生成项目、合成项目、API 列表均为空，不创建固定会话。
- 每个旧音乐/图片草稿各保留一条可编辑条目，空草稿也保留；`count` 仅存在备份，不展开 N 次新请求。
- 每个旧任务对应一个已提交条目/请求，优先原任务 UUID；跨项目 UUID 冲突采用稳定映射。保留原厂商、连接、远端任务 ID、结果 ID、输出 locator、多个输出以及 canonical 资产关联。未提交任务暂停待明确确认；已受理活跃任务暂停且只允许恢复查询/保存；活跃但没有远端 ID 的请求为 unknown，不自动重发。
- 旧 OpenAI 图片请求保留 `binding.provider='openai'` 和 `legacyImage=true`，条目 provider 留空，不伪装成硅基流动，也不新增可创建的 OpenAI API。
- 库内 ID/别名优先接管；没有库记录的项目资产采用命名空间 SHA-256 派生稳定 UUID，来源保留 `legacyAssetId`。没有任务引用的历史生成结果仍独立入库。名称不批量改写，无旧标题时保留原文件 basename，不编造历史曲名。
- 所有媒体原位登记为独立 `rootId + fileName`；缺文件保留不可用占位。旧托管库、旧项目和批次根登记 owned，但仅登记已验证的 UUID 格式文件；外部导入源不登记为 owned。项目删除无需读取旧目录，也不删除媒体。
- 音频登记传入 `audio-originals/<UUID>.<ext>`（若原元数据存在）及 `.generated-audio/<UUID>/{manifest.json,source.bin,compatible.flac,download.part}` 固定路径；不读取清单内任意路径、不递归猜测目录。资产层须支持这些安全附属路径。
- 每个旧批量执行记录对应独立合成项目和 V2 execution，保留批次/规划/任务 ID、提交顺序和成功输出资产。未完成批次暂停，执行中任务变 interrupted，不自动合成；execution 不保留运行时旧 directory 字段。
- 有意义的旧单视频选材/顺序转为独立整首合成草稿，最短 60 秒，必须重新规划；不同未完成快照可保留额外草稿。canonical 别名重复选材在可编辑草稿中归并。旧目标裁切、试听和完整原执行记录只留备份；不伪造新的合成执行。成功单视频保存在视频资产和独立使用台账，14 秒旧成片也不会被新规划的最短时长拒绝。

## 使用台账与 API

优先按旧 committed 回执登记 V2 usage，发布/任务 UUID 为幂等键，独立于项目或视频是否还存在。prepared 回执仅当原文件存在且大小、SHA-256 匹配时对账登记，不修改原回执、不重新渲染；不匹配会停止。无文件的 prepared 保留提示。

没有回执的成功旧批次记全部确定选材；成功旧单视频的 `all` 记全部音频和图片，`target` 只将第一首和图片标为确定，其余音频进入 `uncertainAssetIds`。canonical 重复只计一次，确定关系优先；缺少视频文件不能抹掉成功使用记录。独立回执允许保留已消失来源的原资产 ID，不凭空构造资产。

云端 API 仅按 `secrets.has` 接管。ACE-Step 在已有绑定密钥、非默认地址/等待时间或项目草稿/任务/资产有实际使用痕迹时接管，包括无 Key 本地使用；只有自动默认值且没有使用痕迹时不添加配置，并说明无法判断。旧全局默认参数仅备份，不成为新默认来源。

V5 设置固定初始化为 `page='generation'`、`render={concurrency:2, threads:4, encoder:'auto', staticVideo:true}`。旧最近项目映射为 `lastGenerationId`；`lastCompositionId` 只指向独立合成项目，不共用生成项目 ID。

## 中断与验证

有日志时只从已校验备份恢复来源；生成的稳定身份在发布新记录前落盘，重复登记/提交/记账幂等。资产阶段完成后不重复导入；DB 以最多 128 行分批提交，冲突行不会覆盖。提交后核对每条 DB 记录及 usage，再发布设置和完成标记。备份/日志损坏时保留现场并停止，不删除备份“重新开始”。应用需维持单实例；模块额外串行同进程同 dataDir 的调用。

隔离测试：

```powershell
$env:PI_SCRATCH_DIR = '<隔离 scratch 目录>'
npm.cmd test -- tests/unit/migration-v4.test.ts
```

测试使用合成凭据、临时元数据及真实 WorkbenchDB/AssetStore 的缺文件场景；prepared 字节核对及音频附属文件输入使用小型资产 stub，避免调用编解码器或真实用户数据。此单元测试不代替真实短视频解码、全应用启动、打包或用户数据演练。

## 最终应用与打包验证

以下均使用新建隔离 profile、人工媒体和合成凭据，没有读取真实用户数据或密钥。

- 当前整套单元 **724 项 / 32 文件**通过，其中 V4 迁移新增 **22 项**，历史迁移回归继续保留；不将重叠分项重复计数。
- 当前 **13 项 Electron E2E**全部通过，覆盖 V1/V2 迁移、原草稿和资产保留、旧短选择重新规划、无旧单视频执行接口、项目删除后播放以及成功输出不重跑。
- **实际 4.0.0 打包应用**分别接管 V1 与 V4 项目结构：核对原 ID、名称、来源、暂停/未知请求、原位媒体哈希、Opus 原件与 FLAC 兼容副本、旧视频和使用台账。删除生成/合成项目、关闭再启动后仍可访问媒体，记账不增加。
- 合成 V3 safeStorage 密文及原元数据备份字节保持一致。测试复制的是同一合成 profile 自己的 `Local State` 与密文，以模拟原位升级；不宣称 Windows 加密凭据可任意跨用户或跨设备移植。迁移本身不调用真实服务。
- 打包版忽略开发测试开关。实际 portable 启动两次，生成/合成 A、B 的独立草稿、最近选择及空 API 列表均保持。

最终证据：`$PI_SCRATCH_DIR/v4-package-report-IdzaTM/report.json`、`v4-portable-reports/run-xk72dbob/report.json`、`v4-e2e-focus-final.log`。完整验收索引见 `docs/verification-v4.md`。这不等于对任意真实用户历史目录完成过升级演练；备份仍应同时保留应用数据与各媒体根。
