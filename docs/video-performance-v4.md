# V4 视频引擎：实现、证据与独立基准

最终完整链路对照已在独立新轮次通过 **10/10项、22条3607秒输出**，包括发布/视频入库/使用记账；详见 `docs/composition-performance-v4.md` 与同名JSON。本文末部旧矩阵仍保留其真实未完成状态，不与新轮次混算。

## 调用契约

`src/main/video/pipeline.ts` 的 `renderMedia(request)` 保留原有必填字段及 `filePath / durationSeconds / timeline`；返回类型新增可选 `metrics`（真实实现成功时总会提供，旧测试替身不必补字段）。

```ts
performance?: {
  threads: number // 整数 1–16；调度器负责全局线程/内存/空间预约
  encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv'
  cacheDirectory: string // 已存在、本地绝对、无符号链接/目录重定向的缓存父目录
  staticVideo: boolean
}
onStage?: (stage: RenderStage) => void
```

- 未提供 performance：自动实测编码器，开启整曲视频的静图片段路径，缓存限于本次 taskDirectory；显式配置才跨任务复用。
- `kind:'preview'`、`durationMode:'target'` 仅保留旧测试兼容能力；新生产调用者使用 `video/all`。本模块不登记资产、不发布、不改队列/项目、不清理调用者 taskDirectory。
- `src/shared/video-diagnostics.ts` 导出 `RenderStage / StageTiming / VideoDiagnostic / RenderMetrics / EncoderStatus`。阶段为 tools、probe、audio、mix、encode、validate、publish。引擎实际只执行前六项，**不伪造 publish 时间**；发布、排队、taskId/attemptId 持久化由调用者补充。
- `metrics`：聚合可重入阶段耗时、完整引擎耗时、实际 encoder、是否实际用了静图流拷贝，额外有 `fallbacks / cacheHit / audioPath`。直接音频图中的解码和混音合并，计入 mix；audio 只记录图准备，不假造拆分耗时。
- 失败为 `AppError`（取消仍是 `CancelledError`），附 `.diagnostic`。类别：tool-missing、incompatible、unreadable、encoder-initialization、permission、space、unknown，另有 cancelled。保留实际 stage、可确定的 assetId、toolVersion、encoder、exitCode、osCode、限长脱敏 stderr；未知不冒充素材损坏。
- runTool 可接受可选 `diagnostic` 上下文；无任意 shell/命令 IPC。stderr 按完整行脱敏后截尾，超过 1 MiB 的单行整行丢弃；诊断最多 8192 字符。剔除 URL、认证头、Bearer/Basic、常见密钥字段；不保留原始 cause/命令。UI 进度只给简短回退说明，不混入 stderr。
- `probeMedia` 新增第 5 个可选参数 threads；完整计帧探测允许最长两小时，普通元数据探测仍限 60 秒。

## 实际优化及安全范围

1. **视频轨道**：单图只编码 1 秒 / 30 帧 H.264、无 B 帧、闭合 GOP 片段；探测首关键帧、30 个连续时间戳、尺寸/色彩格式，再完整解码。最终只对视频输入 `-stream_loop -1`，对视频输入限制到 `ceil(audioSamples*30/48000)` 帧长度，`-c:v copy` 封装。音频独立完整读一次，不使用输出 `-t`、`-shortest`、循环、补静音或拉伸来凑长。
2. **规格不降级**：1920×1080 / 30fps / H.264 / yuv420p / TV range；AAC 192k / 48kHz / 双声道；contain/cover 保持原比例策略。静图关键帧比旧 GOP=300 更频繁，不宣称文件一定更小。
3. **缓存**：键含图片 SHA-256、完整滤镜/编码参数、编码器、工具版本和文件身份。使用经过 hash 验证的私有图片快照，避免修改中的图片污染缓存键；完整缓存目录原子发布，竞争者读取已完成结果。每次命中核对视频 hash、流/帧/时间戳并完整解码。拒绝目录/文件重定向；损坏/外来条目不覆盖不删除，改用当前任务私有片段；仅删除本次创建的 pending。
4. **编码器**：auto 按 NVENC → QSV → CPU；显式硬件偏好失败直接 CPU。每一候选首次都真正编码 1080p30、ffprobe、完整解码，不以 `-encoders` 名单证明可用。短测证据缓存键包含工具身份/版本、实时只读设备及驱动指纹、线程和平台；硬件成功有效 5 分钟，失败及 CPU 证据有效 30 秒，最多 64 项。设备身份无法读取时不复用硬件证据；取消检查在缓存查找前执行，实际渲染失败仍回退。冷缓存实验显式清除此证据缓存。完整静图片段缓存是媒体缓存，不依赖现存 GPU 会话。
5. **音频**：最多四首、单音轨、48kHz lossless PCM/FLAC、all、关闭响度均衡时使用有界直接图，仅写 master.wav，去掉 prepared/body/join/fade 重复 WAV。cut、fade、qsin crossfade、首尾淡化、防削波保持原语义；master 长度核对到一采样点。其它格式、更多曲目、响度均衡、旧 preview/target 使用原有有界预处理/分段路径，不能冒充获得直接音频提速。
6. **输出验证不关闭**：元数据/音画时长/最短时长后，整个成片 `-xerror -err_detect explode` 解码，核对解码视频帧数恰为采样长度对应的 ceil 帧数；渲染前后完整输入 hash 一致。静图封装/硬件失败或静图成片验证失败，记录诊断，重新检查空间并 CPU 直接编码，再做同样的完整验证。取消不触发回退。已存在的输出文件不覆盖/删除。
7. 空间预检对直接音频只计 master；静图视频按真实片段字节数估算循环产物并留 faststart/音频/20%/256MiB 余量，直接编码仍保守按 8M VBV。引擎预检不能代替调度器跨任务预约。

## 冻结基线

`tests/fixtures/video-pipeline-v31.ts` 从批准前 scratch/v4-baseline-source 复制，**仅修改 import 路径和加 test-only 注释**；没有生产入口加载它。原文件 SHA-256：

```
708a31d572f658e05fe6fe68f5252157a09868456d7122f97466ee30bee0a48a
```

旧实现本来就是 libx264 / ultrafast / stillimage / 4 编码线程、2 滤镜线程、GOP 300。这些不是 V4 新优化。基线保留旧空间预检、prepared/segment/master 写入、直接逐帧编码和完整解码；本次共用 FFmpeg 安全启动/诊断包装和纯时间线，未改基线算法。脚本还记录冻结文件及当前生产文件 hash。

基线原有 `-t/-shortest` 对非整帧终点可能下取整一帧（开发 fixture 的 11.25 秒实测 337 帧）；基准明确记录此差别并对基线允许一帧量化误差，V4 仍要求恰好 ceil=338 帧。小时 fixture 3607 秒为整帧长度。未通过删测试或改冻结基线掩盖这个差别。

## 独立性能脚本

```powershell
node scripts/video-performance.mjs --help
node scripts/video-performance.mjs --quick
node scripts/video-performance.mjs
# 可分项定位，但单项结果不冒充完整对照：
node scripts/video-performance.mjs --mode=concurrency2 --suite=batch --cache=both
```

`--help` 在 imports/文件/工具检查前退出。脚本不读 profile/厂商/Key/API，不使用 batch 队列。每次新建 `PI_SCRATCH_DIR/video-performance-v4-*`，生成同一组 6 首 1805 秒 48kHz FLAC 和 3 张人工 PNG；每视频两首完整歌曲，3 秒交叉淡化，输出 **3607 秒**。同一 corpus/参数分别测 single 与三条 batch，baseline 串行、optimized one 串行、optimized concurrency2；cold/warm 分开。当前 cold 清空本次应用片段缓存及编码器证据缓存，不清空 OS/驱动缓存；warm 的预热耗时单列。完整规划/队列/发布/入库/记账对照另用 `scripts/composition-performance.mjs`，不能混用两个脚本的墙钟定义。

可用 `--mode=optimized` 只测 one + concurrency2；`--reference=绝对路径/report.json` 引用 scratch 内前次已逐条验证的基线。必须核对所有输入字节 hash、参数、工具及生产/基线代码完全相同，三组完整 PCM hash 都已取得；不是把未完成实验标为完成。报告保留 reference.overallPassed 和引用报告自身 SHA-256。

报告内容：

- 每阶段、单条引擎端到端 `elapsedMs`（含生产完整解码）；额外基准验证 `verificationMs`；batchWallMs 包含额外验证/清理，renderBatchWallMs 是首任务开始至最后引擎结束的窗口（串行之间仍有额外验证间隙），不混作纯编码时间。
- 用 AsyncLocalStorage 关联实际 FFmpeg 子进程的 start/end/PID，分别列 pipeline 与 benchmark-validation，计算真实同时运行的任务数和重叠毫秒，不只用排队/Promise 的时间重叠冒充并行。
- 专用 `video-performance-monitor.ps1` 用 `-NoProfile` 对本脚本持有的 Node/FFmpeg/FFprobe PID 做 Get-Process 采样（不按进程名计入无关任务），CIM 只读系统剩余内存；磁盘每 750ms 扫描本次 work/cache。内存/临时盘/CPU peak 都是**采样下界**，CPU 百分比按逻辑核归一化；短命子进程可能漏采、共享工作集可能重复计数。不可测就 null/errors，不造数；outputsPassed 与 measurementComplete 分开，二者都成立才 passed。还核对持续 ≥2 秒的 FFmpeg PID 是否被采样。
- 工具版本、CPU/内存、每个源文件 SHA-256、参数/生产代码/冻结基线指纹、实际编码器及回退诊断。
- 成片额外完整计帧、音频两首顺序频谱检查、源图与首/中/实际末帧差异、整个 float master PCM SHA-256 与基线逐字节对照（未运行基线时 equalBaseline=null，不冒充对照通过）。
- 每个完成任务先验证再删除**本脚本创建**的大型工作目录/成片。最后默认仅保留小 report.json；`--keep` 仅保留本脚本源/缓存，不保留完成任务大产物。不清理任何已有 scratch/用户文件。基线始终串行预检，适应约 17GB 剩余盘。

## 本机真实验证

工具：FFmpeg / FFprobe 9.0-full_build-www.gyan.dev；i5-12500H、16 逻辑线程，约 16GiB RAM。运行时资源以报告为准。

- NVENC **不可用**：真实编码报 `Required: 13.1 Found: 12.2`，并给出最低驱动版本要求；没有安装/升级驱动或工具。不能称 RTX 3050 Ti 已加速成功。
- QSV、CPU：均通过实际 1080p30 / 30 帧编码、首关键帧/时间戳探测及解码。auto 当前选择 QSV；显式 NVENC 已实测安全回退 CPU，并保留退出码。
- 旧单元 41/41 + 新单元 18/18；旧真实视频集成 12/12 + 新真实集成 11/11。新集成中三种转场各对比全部 PCM：cut/fade 288003 采样、crossfade 240003 采样，**最大误差均为 0**；也核对每个视频包 PTS/DTS 连续、GOP 起点关键帧。
- 已实测并发缓存发布/热命中/内容改变失效、坏缓存不覆盖、非本地缓存回退、source 变化阻止发布、取消隔离、预存在媒体保护、静图成片损坏后 CPU 重渲染并完整验证。
- 早期并行开发时只有视频范围的 strict TypeScript、ESLint 结果；收敛后主流程完整 `npm.cmd run check` 已通过 **724 项 / 32 文件**，真实集成 **70 项 / 7 文件**、Electron **13 项**也已通过。分项视频测试包含在总数中，不重复相加；证据见 `docs/verification-v4.md`。
- 开发 quick 完整矩阵（24 个短输出）通过：scratch `video-performance-v4-lSDIPE/report.json`。该开发记录在硬件每请求重新初始化策略收紧前生成，只作脚本/PCM/并行验证，不代替当前版小时性能结果。冷缓存短任务有初始化开销，**没有据此声称提速**。
- 修复 PowerShell 5 `ConvertFrom-Json` 数组被二次包装造成的并发采样失败后，当前脚本 cold/warm 小批量重测通过：`video-performance-v4-mCpE8b/report.json`，并已重跑下述六个小时输出；早期有 errors 的 CPU/内存值不可作为有效峰值。

### 早期小时固定素材实测（保留的局部、非完整对照）

全部报告位于本次 `PI_SCRATCH_DIR`。这些报告早于最终设备指纹缓存及完整发布基准；部分时段与其它开发验证重叠，不能作为安静环境的统一最终提速结论。下表仅保留真实历史证据，不外推到用户音乐或其它机器。最终完整链路结果见 `docs/composition-performance-v4.md`。

| 场景 | 冷缓存：单条引擎秒 | 热缓存：单条引擎秒 | 冷/热批墙钟秒，含额外基准验证/清理 |
|---|---|---|---|
| 单条 baseline | 241.46 | 282.80 | 351.90 / 353.24 |
| 单条 optimized one | 161.84 | 190.97 | 291.36 / 320.76 |
| 三条 baseline 串行 | 231.17 / 288.15 / 295.49 | 291.78 / 309.33 / **第三条未运行** | 1100.78 / **未完成** |
| 三条 optimized one 串行 | 210.86 / 190.43 / 179.71 | 165.92 / 177.01 / 166.06 | 1039.53 / 967.48 |
| 三条 optimized concurrency2（采样修复后复测） | 178.03 / 182.72 / 146.89 | 180.29 / 183.98 / 146.30 | 570.81 / 572.73 |

证据与缺口：

- `video-performance-v4-qMXTvM/report.json`：单条全部 cold/warm 完成，baseline 三条 cold 完成；baseline warm 第三条因原版预检需 **13.15GiB**、实有 **12.52GiB** 而停止，overall passed=false。没有改低冻结基线预检、删其它 scratch 或拿前两条冒充三条。
- `video-performance-v4-c1PCob/report.json`：相同字节 corpus、参数、工具、生产代码验证一致；optimized one cold/warm 三条均完成且 PCM hash 等于已验证基线。其早期 concurrency2 输出验证成功但并发监控有 errors，因此该报告中并发 CPU/RSS 数值作废，已另行复测。
- **`video-performance-v4-Fnf41W/report.json`**：修复监控后的 concurrency2 cold/warm 六条小时输出通过，outputsPassed=true、measurementComplete=true、passed=true。每条 **3607 秒 / 108210 帧**，完整解码、每首顺序、源图与首/中/末帧、完整 master PCM hash 对照全部通过。实际 FFmpeg 双任务重叠 **176.141 / 178.442 秒**，峰值同时运行任务数 **2**。renderBatchWallMs 对应 **456.54 / 459.52 秒**，另有基准验证间隙，不能叫纯编码时间。
- 此次六条复测的采样临时盘峰值 **3,041,123,889 / 3,041,199,071 bytes**；进程工作集峰值 **250,925,056 / 194,531,328 bytes**；按 16 逻辑核归一化的采样 CPU 百分比峰值 **3.263% / 2.987%**。CPU 累积值仅为捕获到的进程采样下界，不据此推断系统/GPU 总成本或 CPU 节省率；677/679 个进程样本，长 FFmpeg PID 无漏采，errors=[]。详细原始字段保留在报告中。
- 旧基线 cold 三条的实测临时盘峰值为 **4,261,504,229 bytes**；optimized one cold 为 **1,523,155,326 bytes**。这不是预检预约值，不拿小峰值绕过安全空间预算。
- 三份报告使用同样的六首源 hash；`--reference` 允许只引用完整成功的 baseline 条目，即使原报告整体因另一条空间不足未通过。该早期矩阵的 **baseline warm 第三条始终未完成**，不补填旧报告。当前脚本加入设备指纹缓存后代码 hash 已变化，不能再把这些旧报告作为当前代码的 reference。完整同条件复测由新的 composition 基准单独记录。

示例阶段秒（包含完整验证）：

| 单条 cold | tools | probe | audio | mix | encode | validate | 端到端 |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 0.006 | 0.132 | 4.447 | 5.431 | 186.692 | 44.749 | 241.457 |
| optimized one | 3.441 | 0.564 | <0.001（图准备） | 5.800 | 72.065 | 79.966 | 161.838 |

优化路径的完整解码时间并没有被省略，QSV 输出在此 fixture 上校验比基线更慢。工具初始化和缓存首次生成会重入 tools/encode；因此 onStage 不保证按枚举顺序只访问一次。以上耗时是观测结果，不承诺固定提速倍数。

## 覆盖与边界

- 此引擎脚本不做成功记账。发布/登记/使用台账、跨项目资源池、持久诊断已经在当前单元、真实服务集成、13 项 Electron 与实际打包回归中验证；小时级全流程使用独立 composition 基准，详见对应报告。
- 未授权真实用户数据/云 API，未做驱动安装、其它机器 GPU、突发真实硬件掉线或真实磁盘耗尽破坏性测试；空间/权限/工具错误已做结构化故障证据单测。
- 四输入之外、非 48kHz lossless 和响度均衡走安全旧音频路径，未宣称具有直接音频路径的性能收益。100 首/6 小时极限、跨进程缓存竞争及恶意进程实时替换目录的竞争未做长测。
- 当前直接视频 CPU 参数沿用原 ultrafast/stillimage 品质，并为闭合片段使用短 GOP；优化收益必须以完整渲染+完整验证的实测为准。
