# AntiHub 规范支持矩阵（Spec × config_type）与 E2E Smoke

这份文档用于交付当前“规范白名单（Spec allowlist）”策略、哪些入口会被强制拦截、以及如何在本机用 `docker compose` 做最小回归验证。

## 1. 规范与入口映射

| Spec | 对应入口 | 说明 |
| --- | --- | --- |
| `OAIResponses` | `POST /v1/responses` | OpenAI Responses API（当前仅 codex 放行） |
| `OAIChat` | `POST /v1/chat/completions` | OpenAI ChatCompletions（当前未做统一 spec_guard 强制拦截） |
| `Claude` | `POST /v1/messages` | Anthropic Messages（API Key 路径会做 allowlist 校验） |
| `Gemini` | `POST /v1beta/models/{model}:generateContent` / `streamGenerateContent` | Gemini v1beta（入口处做 allowlist 校验） |

## 2. Spec allowlist（单一事实来源）

来源：`AntiHub-Backend/app/core/spec_allowlist.py`

现状（默认启用）：

| Spec | allow config_type（CURRENT） |
| --- | --- |
| `OAIResponses` | `codex` |
| `OAIChat` | `antigravity`, `kiro`, `qwen`, `gemini-cli` |
| `Claude` | `antigravity`, `kiro`, `qwen` |
| `Gemini` | `gemini-cli`, `zai-image`, `antigravity` |

目标态（默认不启用，仅作规划）：

| Spec | allow config_type（TARGET） |
| --- | --- |
| `OAIResponses` | `codex` |
| `OAIChat` | `antigravity`, `kiro`, `qwen`, `gemini-cli`, `codex` |
| `Claude` | `antigravity`, `kiro`, `qwen` |
| `Gemini` | `gemini-cli`, `zai-image`, `antigravity` |

## 3. 拦截行为（统一文案）

统一入口：`AntiHub-Backend/app/core/spec_guard.py`

当请求被白名单拒绝时：
- HTTP 403
- body：`{"detail":"不支持的规范"}`

## 4. 本地构建 + compose 启动（用于验收当前代码）

要求：验收必须基于本地 build 镜像，避免跑到旧的 ghcr 云镜像。

1) 准备 env（建议以 `.env.example` 为模板）：

```bash
cp .env.example .env
```

2) 启动（仅启动后端联调需要的最小组件）：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build postgres redis plugin backend
```

说明：
- `docker-compose.local.yml` 会把 `backend/plugin` 切换为本地构建。
- `web` 不需要参与本次 OpenAI 兼容接口的 smoke（除非你要验证页面）。

## 5. Smoke（PowerShell，可复制粘贴）

1) 登录拿 JWT（默认管理员账号来自 `.env` 的 `ADMIN_USERNAME/ADMIN_PASSWORD`）：

```powershell
$loginBody = @{ username = 'admin'; password = 'please-change-me-to-strong-password' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:8000/api/auth/login' -ContentType 'application/json' -Body $loginBody
$token = $login.access_token
```

2) 验证 `/v1/responses` 非 codex 统一 403：

```powershell
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, 'http://localhost:8000/v1/responses')
$req.Headers.Add('Authorization', "Bearer $token")
$req.Headers.Add('X-Api-Type', 'antigravity')
$req.Content = New-Object System.Net.Http.StringContent('{"model":"gpt-5-codex","input":"hi"}', [System.Text.Encoding]::UTF8, 'application/json')
$resp = $client.SendAsync($req).Result
$resp.StatusCode.value__
$resp.Content.ReadAsStringAsync().Result
```

期望：
- status = 403
- `{"detail":"不支持的规范"}`

3) `/v1/models` 的 codex 路由应可用（不依赖真实上游）：

```powershell
$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, 'http://localhost:8000/v1/models')
$req.Headers.Add('Authorization', "Bearer $token")
$req.Headers.Add('X-Api-Type', 'codex')
$resp = $client.SendAsync($req).Result
$resp.StatusCode.value__
$resp.Content.ReadAsStringAsync().Result
```

4) Gemini v1beta 的 antigravity 不应再被 403 拦截：

```powershell
$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, 'http://localhost:8000/v1beta/models/gemini-2.5-pro:generateContent')
$req.Headers.Add('Authorization', "Bearer $token")
$req.Headers.Add('X-Api-Type', 'antigravity')
$req.Content = New-Object System.Net.Http.StringContent('{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}', [System.Text.Encoding]::UTF8, 'application/json')
$resp = $client.SendAsync($req).Result
$resp.StatusCode.value__
$resp.Content.ReadAsStringAsync().Result
```

期望：
- status **不是** 403
- 如果未配置 plug-in API key：返回 400，且 body 提示用户未配置
- 如果已配置：返回 `candidates` 结构的 Gemini JSON

## 6. SSE / 反代缓冲注意事项

如果你在 Nginx/Caddy/Traefik 后面跑流式接口：
- 确保反向代理禁用 buffer（否则前端会“卡住一段时间才吐输出”）。
- 后端对 SSE 相关响应已设置 `X-Accel-Buffering: no`（但代理层仍可能覆盖，需要你在 proxy 配置里显式关闭）。

## 7. 常见坑（部署/联调）

1) plugin 数据库用户
- `AntiHub-plugin/schema.sql` 内存在对角色 `antigravity` 的引用。
- 因此 `.env` 里 `PLUGIN_DB_USER` 建议使用 `antigravity`（不要和 `POSTGRES_USER` 复用同一个用户）。

2) 已初始化过的 postgres volume
- 如果你之前用错误的 `PLUGIN_DB_USER` 初始化过数据卷，plugin 可能会卡在 schema 初始化。
- 最简单的清理方式是重置 volume（会清空本地数据，仅用于开发联调环境）：

```bash
docker compose down -v
```
