# V3.1 音乐 API 合同

核对日期：**2026-10-04**。适配器版本：1。这里只登记本版实际实现的文字生成音乐、只读检查、轮询及 ACE-Step 音频下载；没有写词收费接口、续写、参考音频、训练或模型管理请求。Kie、reAPI、Sunor 是各平台自己的第三方合同，不是 Suno 官方 API。

## 原始出处

### Kie.ai

- `https://docs.kie.ai/suno-api/generate-music.md`
- `https://docs.kie.ai/market/common/get-task-detail.md`
- `https://docs.kie.ai/common-api/get-account-credits.md`

### reAPI

- `https://reapi.ai/docs/suno-v6`
- `https://reapi.ai/docs/api`
- `https://reapi.ai/docs/api/tasks`
- `https://reapi.ai/docs/api/balance`
- `https://reapi.ai/docs/api/errors`

直接 urllib 读取返回 403；通过普通无登录 Chromium 浏览器读取了以上公开页面，没有绕过账户权限或使用真实密钥。

### Sunor

- `https://docs.sunor.cc/api-reference/create-task.md`
- `https://docs.sunor.cc/api-reference/get-task.md`
- `https://docs.sunor.cc/api-reference/get-balance.md`
- `https://docs.sunor.cc/models/suno.md`
- `https://docs.sunor.cc/errors.md`

### ACE-Step

仓库：`https://github.com/ace-step/ACE-Step-1.5`。**固定提交 `ca1e85fe9430179831e6bc6be790c332190a3866`**，不是浮动 main。原始文件根：

```text
https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/ca1e85fe9430179831e6bc6be790c332190a3866/
```

已对照的仓库路径：

- `docs/en/API.md`：release/query/audio 流程、字段及封装。
- `acestep/api/http/model_service_routes.py`：健康身份、加载状态、模型清单及 text2music 能力。
- `acestep/api/http/release_task_models.py`、`release_task_request_builder.py`：请求默认值与构造。
- `acestep/api/job_llm_preparation.py`：本提交为兼容转发模块，实际逻辑在下一项。
- `acestep/api/llm_generation_inputs.py`、`llm_readiness.py`：LM 需求、默认 CoT、延迟加载条件。
- `acestep/api/job_generation_setup.py`、`server_utils.py`：器乐歌词标记、描述中的 instrumental 提示和生成参数。
- `acestep/api/http/query_result_service.py`：数字状态、JSON 字符串结果、可缺省的元数据。
- `acestep/api/http/audio_route.py`：下载也依赖 verify_api_key；path 由服务器限定目录。

## 云端实际映射

| 平台 | 创建 | 查询 | 只读检查 | 鉴权 |
| --- | --- | --- | --- | --- |
| Kie | `POST https://api.kie.ai/api/v1/jobs/createTask` | `GET /api/v1/jobs/recordInfo?taskId=...` | `GET /api/v1/chat/credit` | Bearer |
| reAPI | `POST https://reapi.ai/api/v1/audio/generations` | `GET /api/v1/tasks/{id}` | `GET /api/v1/balance` | Bearer |
| Sunor | `POST https://sunor.cc/api/v1/task` | `GET /api/v1/task/{id}` | `GET /api/v1/account/balance` | x-api-key |

### Kie

外层 `model=ai-music-api/generate`，字段在 `input` 中：`custom_mode=true`、`instrumental`、`model=V6/V6_MINI/V6_WILD`、`style=音乐描述`、`title`、`duration`。标题空白时使用应用标题“音乐生成”。只有人声歌曲发送独立 `lyrics`；不发送描述为歌词的 `prompt`。时长 10–360 秒，本应用默认 180（不是依赖上游默认值）。style/lyrics/title 上限分别为 1000/5000/80。

业务封装只接受 `code=200`，读取 `data.taskId`。查询 `data.state` 精确支持 waiting/queuing/generating/success/fail；完成后再解析 `data.resultJson` 的 `resultUrls[]`，保存全部结果，不捏造 ID、标题、时长。积分是返回 `data` 数值，不转换为“分”。

### reAPI

顶层字段 `model=suno-music`、`version=V6/V6_MINI/V6_WILD`、`custom_mode`、`instrumental`。描述模式的 `prompt` 是构思（最多 3000）；自填歌词模式 `prompt` 是歌词（最多 5000），另传 `style`（最多 1000）和 `title`（最多 80）。自定义器乐不传 prompt。只有自定义模式发送 `duration`，必须是 10–360 **整数秒**，本应用默认 180；描述模式不发送此字段。

创建与查询使用顶层 **id**，状态严格为 processing/completed/failed。`output.audio_urls[]` 与 `output.tracks[]` 按下标对应；track 的 `url` 是媒体地址，id/title/duration 可以省略。支持只有 URL 数组或只有文档所示 track 数组的结果，元数据缺省不丢音频。秒数明确换算为 `durationMs`。余额是整数积分，不填 `balanceCents`。

### Sunor

外层 `model=suno`、`task_type=music`，默认外层 `audio_format=mp3`；选择原始格式则省略 audio_format。`input.model_version=v6`，不发送 V6_MINI/V6_WILD。描述模式用 `gpt_description_prompt`、`make_instrumental`；歌词模式用 `prompt=歌词`、`tags=音乐描述`、`title`、`make_instrumental`，器乐省略 prompt。不猜测时长字段。

创建接受 HTTP 202，业务 `code=202`，任务 ID 为 `data.task_id`。查询业务 code=200，状态 pending/running/success/failure/timeout，音乐数组是 `data.output.result[]`：`audio_url`、可缺省 id/title/`metadata.duration`（秒）。格式拒绝的机器码 `audio_format_unavailable`/`invalid_audio_format` 提示改选原始格式，**不会自动再 POST**。请求 MP3 不是返回编码保证；兼容转码/本地探测由生成音频保存模块负责。余额分别显示 available/frozen 积分。

## ACE-Step 实际映射与能力检查

默认根地址 `http://127.0.0.1:8001`。所有请求（包括 health/models/query/audio）都使用本次连接的可选 Bearer Key；无 Key 不发送 Authorization。Key 在传输层允许 1–4096 可打印 ASCII 字符，不接受 CR/LF/控制字符。

1. `GET /health`：验证 `data.status=ok`、`data.service=ACE-Step API`，读取 models_initialized。
2. `GET /v1/models`：读取 `data.models[].name/is_default/is_loaded/supported_task_types`、default_model、llm_initialized、loaded_lm_model。显示服务可达不等于推理已验证。
3. preflight：所选模型须在清单中且支持 text2music（若清单报告该能力）；只允许默认模型在 models_initialized=false 时由服务生成流程延迟初始化。拒绝其他未加载/不存在的显式模型。描述自动成歌或 thinking 需要 llm_initialized=true。create 自身也执行这一只读检查，不能绕过能力门禁。
4. `POST /release_task`：`task_type=text2music`、`batch_size=1`、`audio_format=flac`、`audio_duration=10..600`（应用默认 180），prompt=描述；歌词模式的人声必须提供独立 lyrics，器乐使用 `[Instrumental]`。`model=default` 是本应用哨兵，必须省略 model，其他选择发送清单模型名。
5. 基础 DiT-only 明确发送 `thinking=false`、`use_cot_caption=false`、`use_cot_language=false`、`use_format=false`、`sample_mode=false`，并省略 sample_query。源码的 require_llm/want_llm 条件因此不主动调用 lazy LM 初始化；单独 thinking=false **不够**，上游两个 CoT 标记默认 true。
6. 描述模式传 `sample_query` 且 thinking=true；器乐描述添加 “Instrumental, no vocals.” 提示，匹配官方 parse_description_hints 的 instrumental 检测。仍发送 sample_mode=false，绝不请求随机样本。服务的 sample_query 流程会生成歌词和元数据，时长仍是请求目标而不是精确输出承诺。
7. 保存 `data.task_id`；`POST /query_result` 是唯一允许重试的只读 POST，请求 `{task_id_list:[id]}`。只接受对应 ID 的一个结果和数字状态 0/1/2，再解析 result JSON 字符串。成功数组的 `file` 只能是绑定服务的音频路由，`metas.duration` 秒换成毫秒；dit_model 存在时保留实际模型名。
8. `fetchLocalAudio(connection, url)` 返回仍可流式读取的 Response。必须传递覆盖整个下载的调用方 AbortSignal；函数没有“收到响应就 abort”的 finally。不会把服务端 path 当作客户端文件读取。

没有 `/v1/init`、model_inventory 管理替代调用、安装/下载模型、reference/src 路径、随机 sample 或训练请求。

## 文档冲突与保守处理

- Kie 旧 `/api/v1/generate` 与旧 V4 示例不适用于当前 job 合同；采用文档明确的新字段与 V6 枚举。与“success”文字并列的 `code=505` 仍是业务失败，不能因存在 taskId 就认为成功；创建受理有歧义时标 uncertain。
- reAPI V6 页的一段说明称“返回 task_id”，但同页 JSON 和 Tasks 参考明确是顶层 id；实现只读 id，不轮流尝试两种形状。version 在顶层，不放到 Kie 的 input.model。
- Sunor 使用 `.cc`，不是旧截图 `.co`；创建业务 code=202 而非照搬其他平台的 200。原始输出可能是 Opus/MP4，后缀与 audio_format 不用于决定保存编码。
- ACE-Step 产品为 1.5，但 health 的 API version 字符串为 1.0，不能用这个字符串误判产品版本。
- ACE-Step API.md 的模型清单示例比固定提交的源码简略；本实现对照源码的库存/加载/LM 字段。默认模型 is_loaded=false 可能是延迟初始化，不等于服务失效。
- API.md 的 thinking=false 简单示例仍会受 CoT 默认值影响；以 llm_generation_inputs.py 的 require_llm/want_llm 分支为准。缺失 BPM/调号不会由客户端伪造数值来“填满”请求。
- Mureka 既有 duration 已是**毫秒**；Registry 只把 choices.id 映射 remoteId、duration 映射 durationMs，绝不乘 1000，不改服务端生成合同。

## 传输与恢复边界

云端 origin 与提供方绑定，Sunor 仅用 x-api-key，其他云端 Bearer；不接受自定义云代理地址，不跟随重定向。生成 POST 一次，坏 JSON/无 ID/超限成功响应或断线均 uncertain；有任务 ID 后调用方只能查询原任务。GET 和 ACE 只读 query POST 最多 3 次，整体截止时间包含等待，429/5xx 尊重 Retry-After 秒数或 HTTP 日期；等待超出预算不提前重试。关闭信号取消在途请求、JSON body 和退避。

本地地址由共享 aceStepAddressSchema 限制，localhost 归一到 127.0.0.1；私有 IP 的用户确认及 connectionId/key 绑定由设置/任务层负责。实际本地传输使用 node:http/node:https 直接连接，不经过域名网关/系统代理，HTTPS 强制证书验证。只允许四个 JSON 路由；音频仅允许同源精确 `/v1/audio?path=...`（一个非空 path 参数），拒绝所有跳转。JSON 最大 2 MiB、错误体 64 KiB、嵌套 JSON 1 MiB、媒体结果最多 20、模型清单最多 100；本地音频流上限 1 GiB，连接头等待 30 秒，完整下载时限由调用方信号管理。

错误只使用应用编写的安全提示，绝不持久化远端 message/error/progress_text 或密钥。Cloud URL 的公网/DNS/凭证隔离、音频探测、转码和素材库入库继续由专门下载/生成音频模块负责，不在适配器里读取文件或绕过网络保护。

## 验证范围

`tests/unit/music-providers.test.ts` 使用合成密钥与注入响应；`tests/unit/local-http.test.ts` 包含真实环回 TCP 的 health → models → release → query → 音频流流程、中文服务端路径、下载鉴权、返回 Response 后的流读取与取消、跨源跳转拒绝。测试字节是人工协议数据，不是有效模型出曲，也不是解码验收。另回归原 `tests/unit/providers.test.ts` 的 Mureka/SiliconFlow 合同。

未读取真实用户密钥，未发送云端收费生成，未部署 ACE-Step 或进行神经模型推理。真实用户服务出曲、全链路入库与打包验收由对应集成验证单独记录。
