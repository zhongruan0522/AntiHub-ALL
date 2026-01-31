# 渠道规范测试报告

> 基于 `渠道规范测试.csv` 的现状核对 + 代码定位 + 处置建议。  
> 说明：本报告只做“证据化调查与建议”，不对工作区做还原操作（按你的要求不使用 `git checkout/git restore/git reset --hard`）。

## 0. 术语对齐（先把话说清楚）

- **渠道 / Type**：指 API Key 上的 `config_type`（以及部分接口支持的 `X-Api-Type` 请求头），代表账号体系/路由目标，例如：`antigravity | kiro | qwen | codex | gemini-cli | zai-image | zai-tts`。
  - 证据：API key schema 描述里明确把这些当作 config_type 值（`AntiHub-Backend/app/schemas/api_key.py:10`）。
- **规范 / Spec**：指对外兼容的 API 形态（路由层面的协议），对应你的 CSV 列：
  - **OAIChat**：OpenAI Chat Completions（`POST /v1/chat/completions`，`AntiHub-Backend/app/api/routes/v1.py:1067`）
  - **OAIResponses**：OpenAI Responses（`POST /v1/responses`，`AntiHub-Backend/app/api/routes/v1.py:634`）
  - **Claude**：Anthropic Messages（`POST /v1/messages`，`AntiHub-Backend/app/api/routes/anthropic.py:340`）
  - **Gemini**：Gemini v1beta（`/v1beta/models/{model}:generateContent|:streamGenerateContent`，`AntiHub-Backend/app/api/routes/gemini.py`）
- **你的规则解释（本报告按此口径）**：
  - “**建议拉黑**”= 以 `config_type` 做**白名单放行**；不在白名单的渠道，直接 `403`，消息：`不支持的规范`。
  - “**建议支持**”= 该渠道×该规范目前**报错/缺失**，需要补齐实现/适配。
  - “**需要修复**”= 已有实现但存在明确 BUG，需要修复。

## 1. `渠道规范测试.csv` 原始结果（按原样转写）

| 渠道（config_type） | OAIChat | OAIResponses | Claude | Gemini |
|---|---|---|---|---|
| Antigravity | 已支持 | 无需支持 \| 建议拉黑 | Gemini模型输出完思维后截断 \| Claude模型无问题 | 报错 \| 建议支持 |
| Kiro | 已支持 | 无需支持 \| 建议拉黑 | 已支持 | 无需支持 \| 建议拉黑 |
| Qwen | 已支持 | 无需支持 \| 建议拉黑 | 报错 \| 建议支持 | 无需支持 \| 建议拉黑 |
| Codex | 报错 \| 建议支持 | 已支持 | 无需支持 \| 建议拉黑 | 无需支持 \| 建议拉黑 |
| GeminiCLI | 不反馈思维链&&全部压机到最后一秒输出的BUG \| 需要修复 | 无需支持 \| 建议拉黑 | 无需支持 \| 建议拉黑 | 不反馈思维链&&全部压机到最后一秒输出的BUG \| 需要修复 |
| 需要对KEY支持修改类型 |  |  |  |  |

## 2. 关键现状（代码证据：哪些地方已经/没有做白名单）

### 2.1 Gemini v1beta：已存在“渠道白名单”，但错误消息不符合要求

- 已有白名单：`ALLOWED_GEMINI_CONFIG_TYPES = ("gemini-cli", "zai-image")`（`AntiHub-Backend/app/api/routes/gemini.py:35`）。
- 非白名单会被 `403` 拒绝（`AntiHub-Backend/app/api/routes/gemini.py:174`），但 `detail` 目前是：
  - `Gemini v1beta 仅支持 config_type=gemini-cli（文本）或 config_type=zai-image（图片）`
- **与要求的差异**：你要的是统一 `403` + 消息 `不支持的规范`（而不是“提示允许哪些 config_type”）。

### 2.2 OAIResponses：目前对多个渠道“实际可用”，但 CSV 明确要求“建议拉黑”

- `/v1/responses` 当前会根据 `config_type` 走不同后端：
  - `codex` 走 codex upstream（`AntiHub-Backend/app/api/routes/v1.py:670` 附近 `if use_codex:` 分支）
  - 其它（如 `antigravity/kiro/qwen`）会把 Responses request 转成 ChatCompletions request，再走 `kiro_service` 或 `antigravity_service`（`AntiHub-Backend/app/api/routes/v1.py:634` 起）
- **与 CSV 的差异**：CSV 除 Codex 外，对 OAIResponses 统一标注“无需支持 | 建议拉黑”。

### 2.3 OAIChat + Codex：当前是“明确不支持”，但 CSV 要“建议支持”

- `/v1/chat/completions` 对 `config_type=codex` 直接返回 400：`Codex 账号请使用 /v1/responses（Responses API）`（`AntiHub-Backend/app/api/routes/v1.py:1297`）。
- 这和 CSV 的“报错 | 建议支持”一致：**确实不是“协议不允许”，而是“缺实现”**。

### 2.4 Claude (Anthropic Messages)：JWT header 有约束，但 API key 的 config_type 没有真正白名单

Anthropic 端点在选择 `config_type` 时：
- JWT 模式：只有 `X-Api-Type in ["kiro", "antigravity", "qwen"]` 才会被采用（`AntiHub-Backend/app/api/routes/anthropic.py:131`）。
- **API key 模式：`_config_type` 取到什么就用什么**（`AntiHub-Backend/app/api/routes/anthropic.py:126`），随后无论是不是 `codex/gemini-cli` 都会塞进 `X-Account-Type` 转发到 plug-in（`AntiHub-Backend/app/api/routes/anthropic.py:162`）。

风险点很现实：plug-in 的 `resolveAccountType` 只是原样返回 header 值（`AntiHub-plugin/src/server/routes.js:22`），但 plug-in 的 `/v1/chat/completions` 只对 `qwen/kiro` 有专门分支，其它一律“默认走 antigravity”（`AntiHub-plugin/src/server/routes.js:1598` 一段里 `if (accountType === 'qwen') ... else if (accountType === 'kiro') ... else ...`）。  
也就是说：**如果有人拿 `codex` key 调 Claude 规范，系统可能会悄悄走到 antigravity 通道**，这正是你要求“白名单 + 非白名单 403”的原因。

## 3. 白名单建议（按 CSV 的“建议拉黑/建议支持/需要修复”落地到 Spec）

> 下面是“应该允许哪些渠道调用哪些规范”的建议白名单（非白名单统一 `403` + `不支持的规范`）。

### 3.1 OAIResponses（/v1/responses）

- **建议白名单**：`{ codex }`
- **理由**：CSV 对 Antigravity/Kiro/Qwen/GeminiCLI 均标注“无需支持 | 建议拉黑”，且 Codex 已标注“已支持”。
- **需要改动的点（后续实现时）**：`AntiHub-Backend/app/api/routes/v1.py:634` 的 `responses()` 开头，基于 `effective_config_type` 做拦截。

### 3.2 OAIChat（/v1/chat/completions）

- **建议白名单（现状）**：`{ antigravity, kiro, qwen, gemini-cli }`
- **建议白名单（目标态）**：在修复 Codex 之后加入 `codex`
- **当前阻塞**：`codex` 被硬编码拒绝并提示走 `/v1/responses`（`AntiHub-Backend/app/api/routes/v1.py:1297`）。

### 3.3 Claude（/v1/messages）

- **建议白名单（现状）**：`{ antigravity, kiro }`
- **建议白名单（目标态）**：在修复 Qwen 的 Claude 规范后加入 `qwen`
- **理由**：CSV 对 Codex/GeminiCLI 标注“无需支持 | 建议拉黑”，对 Qwen 标注“报错 | 建议支持”。

### 3.4 Gemini（/v1beta）

- **建议白名单（现状）**：`{ gemini-cli, zai-image }`（代码已经是这样，`AntiHub-Backend/app/api/routes/gemini.py:35`）
- **建议白名单（目标态）**：在补齐 Antigravity 的 Gemini 规范后加入 `antigravity`
- **额外要求**：非白名单返回 403 时，把消息统一为 `不支持的规范`（目前不是）。

## 4. “建议支持 / 需要修复”项：问题定位（尽量给到可执行的落点）

## 4.1 Codex × OAIChat（报错 | 建议支持）

### 现状与证据
- `/v1/chat/completions` 对 codex 强制 400（`AntiHub-Backend/app/api/routes/v1.py:1297`）。
- Codex upstream 本质走的是 Responses API：`CODEX_RESPONSES_URL = .../responses`（`AntiHub-Backend/app/services/codex_service.py:72`）。
- 当前仓库已有 **Responses -> ChatCompletions** 的一半兼容（把 responses request 转 chat 请求；把 chat 响应转 responses 响应），在 `AntiHub-Backend/app/utils/openai_responses_compat.py`：
  - `responses_request_to_chat_completions_request(...)`（`AntiHub-Backend/app/utils/openai_responses_compat.py:9`）
  - `chat_completions_response_to_responses_response(...)`（`AntiHub-Backend/app/utils/openai_responses_compat.py:54`）
  - `ChatCompletionsToResponsesSSETranslator`（Chat SSE -> Responses SSE）（`AntiHub-Backend/app/utils/openai_responses_compat.py:154`）

### 核心判断
值得做：**可以用“Chat -> Responses（request） + Responses -> Chat（response/SSE）”补齐 Codex 的 OAIChat 兼容**，避免强制用户改 SDK/路径。

### 需要补的缺口（关键）
- 目前缺少反向转换：
  - `chat_completions_request_to_responses_request(...)`
  - `responses_response_to_chat_completions_response(...)`
  - `ResponsesToChatCompletionsSSETranslator`（Responses SSE -> Chat SSE）
- 建议参考 `2-参考项目/CLIProxyAPI` 里对 Codex 的 OpenAI 适配：`2-参考项目/CLIProxyAPI/internal/translator/codex/openai/chat-completions/codex_openai_request.go:41`（它在注释里明确了 Codex 不支持的一些参数）。

## 4.2 Antigravity × Gemini（报错 | 建议支持）

### 现状与证据
- 后端 Gemini v1beta 目前只允许 `gemini-cli/zai-image`（`AntiHub-Backend/app/api/routes/gemini.py:35` + `:174`），所以 Antigravity 走 Gemini 规范会被 403 拒绝。

### 核心判断
值得做，但先把数据结构讲清楚：**Antigravity 本质是 plug-in 的多账号体系，Gemini v1beta 是另一套协议**。要支持需要做“协议翻译”，不能只放开白名单。

### 两条可行路线（后续实现时择一）
- 路线 A（最小闭环）：Gemini v1beta 请求 **转换为 OpenAI ChatCompletions** 请求，走 plug-in 的 `antigravity` 通道，再把 OpenAI 输出 **翻译回 Gemini v1beta**。
  - 好处：复用现有通道，不引入新账号体系。
  - 代价：需要新增 Gemini<->OpenAI 的双向转换与 SSE 转换器（类似 `openai_responses_compat.py` 的思路）。
- 路线 B（更“正统”）：直接让后端通过 `PluginAPIService` 调用 plug-in 内部的 Gemini 上游（如果 plug-in 已具备对 text generateContent 的实现；目前 plug-in 暴露的 `/v1beta/models/*` 看起来主要是图片生成，`AntiHub-plugin/src/server/routes.js:2396`）。

## 4.3 Qwen × Claude（报错 | 建议支持）

### 现状与证据（可疑点明确）
- Claude 规范入口会把 Anthropic Messages 转 OpenAI messages；对于 content blocks，会生成 OpenAI 的多模态 `content: [{type:'text'...},{type:'image_url'...}]`（`AntiHub-Backend/app/services/anthropic_adapter.py:234`）。
- Qwen 通道的 plug-in `/v1/chat/completions` 会基本原样转发请求体给 Qwen 上游（`AntiHub-plugin/src/server/routes.js:1630` 起），没有对 message content 的“强制纯文本化”。

### 核心判断
值得做：**大概率是 Qwen 上游对 OpenAI 的“多模态 content 数组”支持不完整或与我们生成的结构不兼容**，导致 Claude 规范经由转换后报错；OAIChat 之所以“已支持”，是因为 OpenAI SDK 往往传的是 `content: string`，没触发这个坑。

### 建议修复方向（后续实现时）
- 为 `config_type=qwen` 增加一个“Anthropic -> Qwen”专用降级转换（思路参考 `KiroAnthropicConverter`）：把所有 content blocks **扁平化为纯文本**，并谨慎处理 tools/tool_choice。
- 或者在 Claude 路由层（`AntiHub-Backend/app/api/routes/anthropic.py`）对 qwen 做一次 sanitize：把 OpenAI 多模态 content list 转成 string（丢图但先保文本可用），避免上游 400。

## 4.4 Antigravity × Claude：Gemini 模型“输出完思维后截断”（需要修复）

### 现状与证据
这条不是“协议白名单”问题，而是**流式解析实现有硬伤**：
- plug-in 的 Gemini(antigravity) SSE 解析使用 `chunk.split('\\n')`，没有跨 chunk 缓冲拼接，JSON 只要被拆到两段就会 parse 失败并被静默丢弃（`AntiHub-plugin/src/api/client.js:113` ～ `:117`）。
- 这种写法会导致：某些阶段（常见是后半段正文）刚好被拆包时丢 token，表现为“截断/缺字/后半段没了”。思维链/非思维链只是“哪个部分恰好没被拆包”的偶然性。

### 核心判断
值得立刻修：这是典型“流式协议没按行缓冲”导致的数据丢失，属于确定性代码问题，不是玄学。

### 参考实现
参考后端 GeminiCLI 的写法：用 `buffer += chunk; while '\\n' in buffer: ...` 做行级缓冲（`AntiHub-Backend/app/services/gemini_cli_api_service.py:918` 一段）。
参考项目也有成熟的 stream forwarder（`2-参考项目/CLIProxyAPI/sdk/api/handlers/gemini/gemini-cli_handlers.go`）。

## 4.5 GeminiCLI ×（OAIChat / Gemini）：不反馈思维链 && “全部压机到最后一秒输出”（需要修复）

### 现状
仅凭仓库静态代码无法 100% 还原你的现象，但我能把“最可能的两个根因”钉死到可验证点：

1) **思维链缺失**：后端的 GeminiCLI 只在 `part.get(\"thought\")` 为真时才把文本映射到 `reasoning_content`（`AntiHub-Backend/app/services/gemini_cli_api_service.py:588`）；如果 cloudcode-pa 的 SSE 结构实际不是这个字段（或 thought 片段被包在别的结构里），就会表现为“不反馈思维链”。
2) **流式被压到最后输出**：如果部署链路上有反向代理/压缩层对 `text/event-stream` 做了缓冲（或开启 gzip），会出现你描述的“最后一秒一起吐”。后端路由已经加了 `X-Accel-Buffering: no`（例如 `AntiHub-Backend/app/api/routes/v1.py:1373`），但这只能影响 Nginx 的 buffering，不能保证所有代理层都不缓冲。

### 建议的最小验证手段（后续执行时）
- 在 `gemini-cli` 实际请求链路上抓 **raw SSE**（服务端日志/调试开关），确认上游事件里 thought 的字段名与分包方式。
- 同时检查部署侧（Nginx/Caddy/Traefik）是否对 `text/event-stream` 开启 gzip 或 buffer。

## 5. “需要对 KEY 支持修改类型”项（CSV 最后一行）

### 现状与证据
- 数据层其实已经支持更新：`APIKeyRepository.update_type(...)` 已存在（`AntiHub-Backend/app/repositories/api_key_repository.py:139`）。
- 但对外 API 只暴露了 `/{key_id}/status`，没有暴露 `config_type` 更新接口（`AntiHub-Backend/app/api/routes/api_keys.py` 全文件无对应路由）。

### 建议
值得做：补一个 `PATCH /api-keys/{key_id}/type`（或合并到一个 `PATCH /api-keys/{key_id}`），让用户可以把 key 从一个渠道切换到另一个渠道；否则你做了“规范白名单”后，用户要换渠道只能删 key 重建，体验很差。

## 6. 【核心判断 / 关键洞察 / Linus式方案】

### 【核心判断】
值得做：**你这份 CSV 不是“测试结果”，而是在告诉系统应该具备“规范白名单”的产品策略**。目前代码在多个路径上会“非白名单静默回退到 antigravity”，这会造成错路由/错计费/难排障，必须用白名单挡住。

### 【关键洞察】
- 数据结构：`config_type` 同时承担“渠道路由”与“功能开关”的角色；如果不做 Spec 白名单，必然出现“协议不匹配但仍被转发”的灰色行为。
- 复杂度：真正的复杂点不在“加 if”，而在“协议翻译”（Codex Chat<->Responses、Antigravity Gemini<->OpenAI、Qwen Claude 专用降级）。
- 风险点：最危险的是 **plug-in 默认走 antigravity** 的隐式回退（`AntiHub-plugin/src/server/routes.js:22` + `:1598`），会把本该 403 的请求悄悄跑通但走错账。

### 【Linus式方案】
1) 第一步永远是简化数据结构：把“规范白名单”做成一个集中映射（Spec -> allowed config_type 集合），在路由层第一行就拒绝非白名单。  
2) 消除特殊情况：不要依赖 plug-in 的“默认 antigravity”去兜底不支持的渠道。  
3) 用最笨但最清晰的方式实现：每个 spec 路由只做 3 件事：鉴权 -> 白名单 -> 转发/翻译。  
4) 确保零破坏性：先按 CSV 对“建议拉黑”加 403；对“建议支持/需要修复”分支独立迭代，避免一口气改太大。
