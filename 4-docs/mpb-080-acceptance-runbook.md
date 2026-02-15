# MPB-080 验收/回归 Runbook（无 plugin 形态）

> 目标：在 **不启动 AntiHub-plugin** 的部署形态下，完成启动验收、迁移验收、410 校验、public routes 扫描，并能把流程脚本化/可复制。

最后更新：2026-02-15

## 0) 前置条件

- Docker Desktop 已启动，且当前用户有权限运行 `docker compose`。
- 端口未被占用：`WEB_PORT`（默认 3000）、`BACKEND_PORT`（默认 8000）、`POSTGRES_PORT`（默认 5432，可选）。
- 如需跑迁移验收：需要可访问的旧 plugin DB（见 §3）。

## 1) 无 plugin 冷启动验收（compose）

1) 准备 env：

```bash
cp .env.example .env
```

2) 启动（默认：web + backend + postgres + redis）：

```bash
docker compose up -d
```

3) 验证容器：

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

期望：
- 不应出现 `antihub-plugin` 容器
- backend / web / postgres / redis 均为 running/healthy（postgres 有 healthcheck）

4) 健康检查（无需鉴权）：

```bash
curl -sS -i http://localhost:8000/api/health
```

期望：HTTP 200。

## 2) 410 校验（弃用接口必须返回 410）

以下接口按合同应返回 **410 Gone**（或兼容 `{"detail": ...}` 形式的可读提示）：

- `GET /api/plugin-api/quotas/shared-pool`
- `GET /api/plugin-api/quotas/consumption`
- `PUT /api/plugin-api/preference`

示例（curl，实际可能需要带 JWT；如果没带 token 返回 401/403 也算“路由可达”，但建议带 token 复核 410）：

```bash
curl -sS -i http://localhost:8000/api/plugin-api/quotas/shared-pool
curl -sS -i http://localhost:8000/api/plugin-api/quotas/consumption
```

## 3) 迁移验收（可选）

说明：迁移用于把旧 plugin DB 的 `accounts/model_quotas` 导入到 Backend 的 `antigravity_*` 表。

1) 准备迁移环境变量（写入 `.env`）：

```env
PLUGIN_DB_MIGRATION_ENABLED=true
PLUGIN_MIGRATION_DATABASE_URL=postgresql+asyncpg://<user>:<pass>@<host>:<port>/<plugin_db>
```

2) 重启 backend（触发启动期迁移）：

```bash
docker compose restart backend
docker compose logs -f backend
```

期望：
- 迁移成功（日志无 “migration failed”）
- 数据抽样正确：能在管理后台看到对应账号/配额（或用 SQL 抽样）

> 迁移应为幂等：重复执行不应产生重复数据/破坏性写操作。

## 4) Public routes 扫描（脚本化）

扫描基线：`4-docs/BACKEND_PUBLIC_ROUTES.csv`

脚本：`4-docs/tools/scan_public_routes.py`（默认使用 OPTIONS，避免对 POST/PUT/DELETE 产生副作用）

1) （推荐）先登录拿 JWT：

```powershell
$loginBody = @{ username = 'admin'; password = 'please-change-me-to-strong-password' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:8000/api/auth/login' -ContentType 'application/json' -Body $loginBody
$env:ANTIHUB_TOKEN = $login.access_token
```

2) 扫描并落盘结果：

```bash
python 4-docs/tools/scan_public_routes.py --base-url http://localhost:8000 --out 4-docs/public_routes_scan_results.csv --fail
```

说明：
- `--fail` 会在发现 404/连不通/410 违约时返回非 0 exit code（便于 CI/脚本化）
- 如果不带 token，很多接口会返回 401/403；脚本仍会记录状态码

## 5) 应急回滚预案（只用于应急）

1) 回滚 compose 变更：

- 方案 A：`git revert` 回滚相关 commit（推荐，保留历史）
- 方案 B：直接 `git checkout <old_commit>`（仅用于本地排查，不建议用于部署）

2) 若需要临时恢复旧 plugin 形态：

- 使用历史版本的 compose（包含 plugin 服务）启动
- 或者自行单独运行 plugin（不属于当前“无 plugin”合同）

## 6) 执行结果记录模板（建议粘贴到 PR/notes）

- date:
- env: compose/core（是否本地 build）
- backend commit:
- docker compose up:
- /api/health:
- 410 checks:
- public routes scan output: `4-docs/public_routes_scan_results.csv`
- migration enabled: true/false
- migration sampling:
- risk/notes:
