# 油管视频生成 · V4 界面契约

- 任务：在现有桌面工程实现「素材生成 / 批量合成 / 素材库 / 设置」。生成与合成各有页内项目列表、独立草稿与执行记录；全局资产不随项目删除。一个生成条目只提交一次请求，多返回属于原条目。
- 视觉：保留白主区 `#fff`、灰侧栏 `#f5f6f8`、浅底 `#fafbfc`、蓝操作 `#426b9e`、边框 `#e5e8ed`、正文 `#20242b`、辅助 `#69717d`，错误/警告/成功同时有文字。禁止装饰统计卡、渐变、历史工作台或默认生成参数入口。
- 字体：Segoe UI / Microsoft YaHei UI / 系统字体；正文与控件 16px，辅助不少于 14px，页标题 24px，区块标题 20px。控件至少 44px；间距 4/8/12/16/24/32px；控件/面板/对话框圆角 6/8/12px。
- 布局：灰导航 + 页内紧凑项目列表 + 白编辑主区；条目按需展开，长列表分页。使用 minmax(0,1fr)、可换行名称和独立纵向滚动；不以裁切溢出掩盖布局缺陷。
- 交互：复用 Dialog 焦点陷阱、Escape、返回焦点和媒体互斥播放；全部操作接 WorkbenchAPI，提供加载/空/错误/成功/禁用/选中状态与可见焦点。危险操作先查询影响；付费、恢复未提交、放弃未知追踪、继续未成功合成都明确确认。
- 数据：bootstrap 全量快照 + onChanged 合并刷新。条目/合成草稿按 ID 与 revision 缓存、串行保存；非当前草稿仍保留，切换先 flush。草稿不完整可存；提交时验证。合成计划绑定 revision，修改草稿立即失效。素材库勾选不参与合成选材。
- API：仅已添加配置可选，同厂商唯一；空密钥编辑表示保持，清除需显式选择；密钥只在当前编辑框内存中存在，不记录、不放浏览器持久存储。ACE 查询模型只手动触发；不发推理，不猜测 LM 就绪。
- 动效：悬停/按下即时反馈；120ms 颜色过渡，180ms 单次弹性进入、有限 20ms 列表错峰；reduced-motion 关闭位移动画。无 transition:all 或动效依赖。
- 假设与边界：shared/workbench-types.ts 与 schemas 是唯一契约；主代理实现存储、迁移、工具、IPC 和媒体协议。界面不导入 main。仅 renderer 与授权单测可改；不存在生产 mock 或假按钮。
- 自检：无生成次数字段；独立项目 CRUD；条目 alternatives 与长文本不截断；计划过期阻止提交；删除项目不删媒体、删除资产不删外部原件/历史使用；后台事件不切换当前项目。浏览器验证只用隔离、明确标记的 fixture，不启动真实 profile 或付费 API。最终 Electron / 性能验收由主代理执行。

## 实现与验证交接
- 生产入口只使用 `window.canvas: WorkbenchAPI`；所有演示 API 与检查脚本仅在本轮 scratch 内，工程没有 mock 分支。旧单视频与旧生成/全局勾选 hooks 已删除，媒体统一为全局资产 ID。
- 本轮通过 renderer + shared + 新单测的独立 TypeScript 检查、授权 renderer 文件 ESLint、`vitest run tests/unit/renderer-v4.test.ts`（11 项）。Vite renderer-only 生产构建输出 scratch 成功，只有依赖 Zod 的 PURE 注释警告；未覆盖主进程构建。
- BrowserPreview 打开 `src/renderer/index.html`；另用 Playwright Chromium 打开 scratch 中的真实生产 renderer bundle，注入明确标记 Demo 的纯内存 API，65 项 UI/DOM 检查通过。覆盖 1366×768 / 1920×1080，追加 900 / 400 宽度，无横向溢出；控件字体 ≥16px；对话框 focus trap / inert / Escape / 焦点归还及 reduced-motion 通过。修复了批次暂停时 details 自动折叠，以及主页面与项目列表 sibling key 冲突导致旧项目栏残留的问题；11 个布局状态均断言只有当前页项目栏和一个工作区。
- 不将以上视作真实 Electron 全链路。媒体协议播放、原生导入/另存/目录对话框、真实工具检测、云服务、本地推理、重启持久化和最终截图视觉审查由主代理用隔离 Electron profile 验收；未接触真实 profile、密钥或付费接口。
- 自动化锚点：导航 `nav-generation/composition/library/settings`；项目 `{generation|composition}-create`、`{kind}-project-{id}`、`project-name/rename/delete`；条目 `entry-add`、`entry-{id}`、`entry-expand/copy/delete-{id}`、`entry-provider/prompt/lyrics/mode/input-mode/model/seconds`、`generate-selected/all`；请求 `request-resume/abandon-{id}`、`generation-resume/stop`。
- 合成锚点：`composition-select-audio/image`、`selector-toggle-{assetId}`、`selector-apply`、`composition-minimum-minutes/transition/plan-button/plan/start/cancel-project`；批次 `batch-{id}`、`batch-pause/continue/cancel-{id}`；任务 `render-job/cancel/diagnostics/play-{id}`、`diagnostic-copy-{id}`。
- 素材与设置锚点：`library-tab-audio/image/video`、`library-search/import/refresh/export-selected`、`asset-{id}`、`asset-preview/rename/delete-{id}`；`api-add/provider/key/clear-key/test/save`、`api-edit/delete-{provider}`；`settings-tab-apis/render/storage`、`render-concurrency/threads/encoder/static-video/save`、`tools-check`、`storage-choose-root`。
- 通用确认锚点：`confirm-acknowledge`、`confirm-action`、`delete-confirm`、`rename-input/save`。付费提交与恢复失败后禁用原确认按钮，要求返回核对记录；不会自动重发。删除受阻时没有可提交的删除按钮。

## 最终真实桌面验证

- 主流程已完成 TypeScript/ESLint 与 **724 项单元**、**70 项真实集成**、**13 项 Electron E2E**；最后一轮 E2E 无 skip/exclude 或旧 API shim。上面的 65 项内存 Demo 检查仍只是早期布局证据，不与真实桌面数量相加。
- 实际 4.0.0 打包应用和 portable 两次启动通过：独立 A/B 生成/合成草稿、最近选择、空/已添加 API、只读配置、重启持久化；实际媒体导入、协议播放、单输出合成、另存字节一致及删除保护分别由 E2E/打包测试覆盖。
- 当前包的原生窗口通过 Win32 HWND 测量：外框 **1366×768 / 1920×1080**，客户区 **1350×729 / 1904×1041**，DPI 96。真实 Python Playwright 检查得到白主区、浅灰侧栏、正文/控件 16px、元数据至少 14px、区块 20px、页标题 24px、约 44px 控件，无横向溢出。
- 项目列表、正文和对话框自然滚轮滚动，长错误/长草稿、焦点陷阱、背景 inert、Escape 及返回触发器均通过。异步生成确认在保存禁用按钮前显式捕获原焦点；已添加对应真实 E2E 回归，没有放宽 CSP。
- 原生检查保存 **47 张**截图，唯一后缀 `20261005-062259-4e0cca`。文件名日期为机器本地 **2026-10-05（UTC+08:00）**观察值。图集 `docs/ui-preview.html` 只展示这一通过批次；历史截图保留。
- 原生图集中的账号、音乐、图片、错误均为隔离夹具；未提交新生成/合成、未付费、未做 ACE 神经推理。真实编码/发布验收与纯界面检查分别记录，见 `docs/verification-v4.md`。

原始报告：`$PI_SCRATCH_DIR/v4-visual-reports/run-3aub726f/report.json`；`pageErrors=[]`，47 个状态的 readability failures/overflow 全为空。

## V4.0.1 增量契约

保留上述视觉与状态管理。API菜单新增独立“Mureka 国内站”，旧`mureka`显示“Mureka 国际站”；两站独立草稿、凭据与恢复，审核中不重发。

合成选材以`origins.projectId`匹配来源项目，重名显示ID、删除项目使用来源快照；提供全部/本地导入/历史未归属，保留使用状态交集。`selector-source/select-all/deselect-all/clear-all`跨全部分页，选可用、取消含不可用，旧顺序保留且不重复，容量10000音乐/100图片原子拒绝超限；替换模式禁用批量。应用只影响当前项目/类型，取消不保存。

素材库保留名称搜索，`library-select-all/deselect-all`仅作用当前分类/搜索/使用筛选，范围外保留；`library-clear-all`明确清空所有分类。生成页`generation-select-all/deselect-all`只作用当前项目/类型未提交条目；session选择按项目隔离，500提交上限明确提示。没有批量删除、视频策略改动或全量截图重采。

## V4.0.2 粘贴创建小功能

沿用白色主区`#fff`、浅灰`#f5f6f8`、蓝`#426b9e`、边框`#e5e8ed`，系统字体16px/元数据14px和现有Dialog焦点/inert/Escape规则。仅增加同风格双步骤弹窗：粘贴原文 → 分页预览与参数配置。步骤编号表达真实操作顺序，不添加装饰统计或新视觉系统。

入口`prompt-template-save/prompt-import-open`；弹窗`prompt-import-text/parse/count/bulk/apply-all/row-N/title/remove-N/back/discard/create`。原文及字段仅按文本展示；10条一页自然滚动，复用EntryEditor的离线草稿/仅参数模式，批量参数不覆盖正文。主按钮为“创建N个条目”，没有付费生成或模型检查副作用；返回编辑和关闭有一次放弃确认，创建中锁定，未知结果只核对本批。

本次定向Electron/Python五组检查通过，含取消返回焦点、背景inert、长正文/分页、无API保存与生成拦截、批量/逐条配置、图片类型隔离及回复丢失恢复。仅2张过程截图，未重采历史图集。
