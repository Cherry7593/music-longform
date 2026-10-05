# V3 / V3.1 历史回归基线

这里保存从 `src/main` 移出的旧执行、存储和 IPC 实现，供旧 unit / integration 测试及显式运行的历史测试脚本使用。目录结构与原 `src/main` 相同；迁移仅调整 import 路径，不修改历史实现或测试断言。

**这不是隐藏工作台、兼容运行入口或备用业务引擎，不随应用运行包加载。** `src/main/index.ts` 的生产依赖图不引用此目录；禁止从 `src` 导入这些 fixture，也不提供生产 shim。V4 运行入口继续使用 WorkbenchService、GenerationQueue、CompositionQueue 和 AssetStore。

## 保留范围

- `main/jobs.ts`、`main/ipc.ts`
- `main/video/jobs.ts`、`main/video/batch-jobs.ts`、`main/video/scheduler.ts`
- `main/storage/projects.ts`、`main/storage/settings.ts`、`main/storage/library.ts`
- `main/storage/video-batches.ts`、`main/storage/export-receipts.ts`
- `main/library/project-sync.ts`、`main/library/usage.ts`、`main/library/ipc.ts`

旧模块互相引用本目录下的实现；共享类型、schemas、迁移解码/校验、原子存储、路径安全、媒体导入/下载、FFmpeg、pipeline 和 workfiles 等公共能力仍从原 `src` 引用，没有复制或移动。历史数据里的版本字段不代表 V4 双项目工作台引擎。新 V4 测试应继续验证真实新引擎，不能用这些旧类替代。

## 回归入口

在项目根目录执行，先将 `PI_SCRATCH_DIR` 设置为独立的临时目录。测试只使用人工素材、模拟服务与隔离元数据，不应读取真实用户密钥、提交付费任务或恢复渲染用户旧批次。

```powershell
npx vitest run tests/unit/jobs.test.ts tests/unit/multi-music-jobs.test.ts tests/unit/music-state.test.ts tests/unit/ipc.test.ts tests/unit/library-ipc.test.ts tests/unit/video-jobs.test.ts tests/unit/batch-jobs.test.ts tests/unit/library-usage.test.ts tests/unit/library.test.ts tests/unit/library-imports.test.ts tests/unit/storage.test.ts tests/unit/migrations.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/library-imports.test.ts tests/integration/music-http.test.ts
```

真实媒体 integration 需要本机 FFmpeg / FFprobe。`scripts/batch-test-utils.mjs`、`video-test-utils.mjs`、`music-test-utils.mjs` 显式加载这些历史类；`batch-video-smoke.mjs` 与 `long-video-smoke.mjs` 通过这些 helper 保留旧基线，不是应用入口。历史回归通过不等同于 V4 E2E 或新版打包验收通过。
