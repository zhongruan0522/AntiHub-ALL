# Plugin DB → Backend DB 迁移（启动期自动迁移）

用途：把旧 `AntiHub-plugin` 的 DB 导入到 Backend 的本地表（`antigravity_*` / `kiro_*`），用于在**不运行旧 Node AntiHub-plugin 运行时服务**的部署形态下继续读取账号数据（仅迁移期需要临时启动 Env Exporter）。

## 1) 触发条件与配置

在根目录 `.env` 中配置（参考 `.env.example`）：

- `PLUGIN_API_BASE_URL=http://plugin-env:8045`（指向“迁移助手/Env Exporter”；留空=不触发迁移）
- （可选）`PLUGIN_ENV_EXPORT_TOKEN=...`（对应请求头 `X-Migration-Token`，需要与迁移助手一致）
- （兼容）也可以直接使用旧部署的 `PLUGIN_ADMIN_API_KEY=...` 作为鉴权 Token（迁移助手优先使用 `PLUGIN_ENV_EXPORT_TOKEN`）

迁移助手（本仓库 `AntiHub-plugin/`）需要在它自己的环境变量中提供旧 DB 连接信息：

- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`

（推荐）用 Compose 叠加文件启动迁移助手：

```bash
docker compose -f docker-compose.yml -f docker/docker-compose.plugin-env.yml up -d plugin-env
```

说明：
- 迁移助手会返回旧 DB 的连接信息（敏感）；建议设置 `PLUGIN_ENV_EXPORT_TOKEN` 做最小鉴权，并避免暴露端口到公网。

说明：

- Backend 启动时发现配置了 `PLUGIN_API_BASE_URL`，会先检查表 `plugin_db_migration_states` 的状态：
  - `status=done`：跳过迁移
  - 其他：尝试迁移（多实例场景下只允许一个实例执行，其余实例等待结果）
- 迁移失败会阻止 Backend 启动（避免“半迁移”状态运行）。

## 2) 迁移内容（当前范围）

- `AntiHub-plugin.public.accounts` → `AntiHub-Backend.antigravity_accounts`
- `AntiHub-plugin.public.model_quotas` → `AntiHub-Backend.antigravity_model_quotas`
- `AntiHub-plugin.public.kiro_accounts` → `AntiHub-Backend.kiro_accounts`（如源库存在该表）
- `AntiHub-plugin.public.kiro_subscription_models` → `AntiHub-Backend.kiro_subscription_models`（如源库存在该表）
- `AntiHub-Backend.plugin_user_mappings`：记录 `plugin users.user_id(UUID)` → `Backend users.id` 的映射（仅迁移期使用，不进入运行时请求链路）

## 3) 手动验证（抽样核对点）

建议在“干净环境/新 volumes”下执行：

1. 启动服务（或仅启动 backend 依赖的 postgres/redis）：
   - `docker compose up -d`
2. 查看 backend 日志，确认迁移执行完成（状态表 `plugin_db_migration_states` 中 `key=plugin_db_to_backend_v2` 的 `status=done`）。
3. 核对数据量（示例 SQL）：
   - plugin：`SELECT COUNT(*) FROM public.accounts;`
   - backend：`SELECT COUNT(*) FROM antigravity_accounts;`
4. 抽样核对 1 个 `cookie_id`：
   - plugin：`SELECT cookie_id,user_id,status,need_refresh,expires_at,project_id_0 FROM public.accounts WHERE cookie_id='<cookie_id>';`
   - backend：`SELECT cookie_id,user_id,status,need_refresh,token_expires_at,project_id_0 FROM antigravity_accounts WHERE cookie_id='<cookie_id>';`
5. 幂等性验证：重启 backend（保持 `PLUGIN_API_BASE_URL` 配置不变）再执行一次，确认：
    - `antigravity_accounts` / `antigravity_model_quotas` 行数不增长
    - 随机抽样字段无异常漂移（例如状态/配额等）

## 4) 常见问题

- 如果 backend 报 “mapping missing”：说明 plugin DB 里存在 `accounts.user_id` 在 backend 侧找不到对应用户映射，需要先补齐（通常来自 `plugin_api_keys.plugin_user_id` 或 api_key 匹配）。
- 如果 backend 在启动期迁移时报 `sqlalchemy.exc.InvalidRequestError: A transaction is already begun on this Session.`：通常是 SQLAlchemy 2.x 的 autobegin 导致同一个 Session 上出现“隐式事务未结束 + 之后又进入 `async with db.begin()`”的冲突；解决：更新到包含该修复的 backend 版本/镜像；临时绕过：先清空 `.env` 里的 `PLUGIN_API_BASE_URL` 跳过迁移逻辑以先启动。
