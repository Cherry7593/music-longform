# V4.0.1 增量更新

## 两项改动

- **Mureka 国内站**：新标识 `mureka-cn`，固定 `https://api.mureka.cn`；原 `mureka` 保留并显示“Mureka 国际站”。两站各一个音乐配置，可同时添加，密钥、条目草稿、请求快照、来源及恢复相互独立。不会切站、混用凭据、跨站重发或自动付费重试。
- **跨页选择**：合成选材移除名称搜索，改为来源项目 ID + 使用状态交集；支持全部来源、本地导入、已删除/未知项目及历史未归属。全选全部匹配分页的可用素材、全取消匹配范围（包含后来不可用的已选项），范围外选择和原顺序保留。清空全部已选仅作用弹窗当前类型；替换模式禁用批量操作。超限整次拒绝并明确提示，不截断。
- 素材库仍有名称搜索，按分类/搜索/使用状态跨页全选与全取消；原清空操作明确标注“所有分类”。生成页按当前项目、音乐/图片页面批选未提交条目，项目间选择独立；单次提交仍上限500。
- 应用选择才更新当前合成项目，取消不保存。未新增批量删除、其它厂商、多账号或视觉改版；**视频编码、线程、调度、合成算法未改**。

## 国内站本次核对的官方合同

核对日期：2026-10-05。只读下载官方中文文档及其页面使用的 OpenAPI 数据，未发送真实 API 凭据。

| 用途 | 本版操作 |
|---|---|
| 描述生成人声歌曲 | `POST /v1/song/easy-generate`；model、prompt、可选styles、`n:1`、`stream:false` |
| 纯音乐 | `POST /v1/instrumental/generate`；model、prompt、`n:1`、`stream:false` |
| 原歌曲/纯音乐查询 | `GET /v1/song/query/{task_id}` / `GET /v1/instrumental/query/{task_id}` |
| 只读连接测试 | `GET /v1/account/billing`；Bearer认证，余额按分读取，不创建任务 |

国内站模型：两类均支持auto、mureka-7.6、mureka-8、mureka-9、mureka-9.5；歌曲另外支持mureka-o2。歌曲描述2000字符，纯音乐1024字符；不把歌词、时长或其它不支持字段发送给这两个操作。

`reviewing`映射为正在等待的“服务端审核中”，继续查询原ID。preparing/queued/running/streaming继续等待，succeeded保存实际返回的全部choices，failed/timeouted/cancelled明确结束；返回duration为毫秒，保存时仍按媒体实际解码。官方n默认2且按数量计费，本版始终显式n=1，无自动补发。

官方出处（仅本次五个操作）：

```text
https://platform.mureka.cn/docs/api/operations/post-v1-song-easy-generate.html
https://platform.mureka.cn/docs/api/operations/post-v1-instrumental-generate.html
https://platform.mureka.cn/docs/api/operations/get-v1-song-query-{task_id}.html
https://platform.mureka.cn/docs/api/operations/get-v1-instrumental-query-{task_id}.html
https://platform.mureka.cn/docs/api/operations/get-v1-account-billing.html
```

文档未要求Key固定前缀或8字符最小值；国内Key使用1–4096个无空白ASCII字符的客户端格式边界，空值/控制字符拒绝。格式通过不等于账号权限通过。旧云站格式不变。V3密钥记录只增加可选`mureka-cn`字段，初始化不改写旧密文；新增/清除国内Key不重加密国际Key。设置V5及项目/资产/执行版本不变，不重做资产迁移；勿用旧版编辑新增国内站后的同一份数据。

## 定向验证与边界

本次不运行小时级合成、性能矩阵、长压力或47张全量截图。使用隔离profile、合成凭据、短人工音频和小图片。

- 相关单测：**307项 / 11文件通过**，其中国内站合同/隔离/恢复24项，筛选/选择33项；其余是受影响提供方、凭据、IPC、生成和renderer状态回归，不是全项目重测。
- 类型检查与ESLint通过；Python脚本、Node夹具提供零副作用`--help`。
- 真实Electron定向UI通过 **5组功能检查 + 2次启动/重启**：25音乐/25图片/25待生成条目跨页，同名/改名/删除/多来源/无归属，组合筛选、不可用取消、101图片超限拒绝、顺序与去重、项目/类型隔离、取消不存/应用才存；实际safeStorage保存两站Key，原国际密文不变，站点草稿独立，重启内容保持。共2张必要截图，无新增生成/合成请求。报告见本次scratch的 `v401-ui-1dc46e26d0714266b940f55bf6061521/ui-check/report.json`。
- 测试脚本的页面创建等待、异步保存等待及JS undefined/Python null序列化差异已按实际磁盘证据修正；没有删除断言或关闭CSP。旧测试夹具仅补齐新增提供方类型及明确false预期。
- `npm.cmd run dist:win` **一次最终打包成功**；实际4.0.1 portable两次启动/重启通过，两站配置、两类选材与项目草稿保持，未增加生成/合成。原4.0.0大小及SHA不变；包内6个构建文件与当前out一致，视频核心5文件与4.0基线指纹一致。

真实国内/国际账号的权限、计费、服务可用性和生成质量未验证；没有调用付费接口，也未验证真实ACE推理。原4.0.0 EXE保留，本次不推送GitHub。

## 交付

- EXE：`dist/油管视频生成-4.0.1-Windows-x64.exe`，**107,986,149 bytes**，PE产品版本4.0.1；实际签名状态NotSigned。
- SHA-256：`06D5E7AE1A26BFAA41235DB3589F69ABF9D7629BCE6743BF8A438E4E38805B80`，相邻`.exe.sha256`已生成。
- 保留4.0.0：107,985,607 bytes，SHA `3E130BABD3EBBF56E57CA416E2467B987144AE7FA9DED80BF46373E7959B4690`。
- 日志：本次scratch的`v401-typecheck-final.log`、`v401-lint-final.log`、`v401-unit-final.log`、`v401-ui.log`、`v401-dist.log`、`v401-portable.log`；便携报告在上述隔离fixture的`portable-check/report.json`。
- 历史打包/视觉脚本仅同步4.0.1版本和新全选按钮的跨页预期，做语法/lint校验；没有把其未执行的全量流程写成通过。已有Zod构建注释和Python Playwright依赖弃用提示非阻塞，未为此修改依赖或安全设置。
