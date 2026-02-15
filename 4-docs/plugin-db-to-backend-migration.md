# Plugin DB → Backend DB 迁移（迁移期开关）

用途：把旧 `AntiHub-plugin` 的 DB（主要是 `accounts` / `model_quotas`）导入到 Backend 的 `antigravity_*` 表，供 `/api/plugin-api/accounts/*` 与 `/api/plugin-api/quotas/user` 等接口读取。

## 1) 开关与配置

在根目录 `.env` 中设置（参考 `.env.example`）：

- `PLUGIN_DB_MIGRATION_ENABLED=true`
- `PLUGIN_MIGRATION_DATABASE_URL=postgresql+asyncpg://...`（指向 *plugin DB*，不是 Backend 的 `DATABASE_URL`）

说明：

- 迁移失败会阻止 Backend 启动（避免“半迁移”状态运行）。
- 多实例场景下使用 Redis 分布式锁，确保只跑一次；其余实例会等待迁移完成标记。

## 2) 迁移内容（当前范围）

- `AntiHub-plugin.public.accounts` → `AntiHub-Backend.antigravity_accounts`
- `AntiHub-plugin.public.model_quotas` → `AntiHub-Backend.antigravity_model_quotas`
- `AntiHub-Backend.plugin_user_mappings`：记录 `plugin users.user_id(UUID)` → `Backend users.id` 的映射（仅迁移期使用，不进入运行时请求链路）

## 3) 手动验证（抽样核对点）

建议在“干净环境/新 volumes”下执行：

1. 启动服务（或仅启动 backend 依赖的 postgres/redis）：
   - `docker compose up -d`
2. 查看 backend 日志，确认迁移执行完成（有 done marker）。
3. 核对数据量（示例 SQL）：
   - plugin：`SELECT COUNT(*) FROM public.accounts;`
   - backend：`SELECT COUNT(*) FROM antigravity_accounts;`
4. 抽样核对 1 个 `cookie_id`：
   - plugin：`SELECT cookie_id,user_id,status,need_refresh,expires_at,project_id_0 FROM public.accounts WHERE cookie_id='<cookie_id>';`
   - backend：`SELECT cookie_id,user_id,status,need_refresh,token_expires_at,project_id_0 FROM antigravity_accounts WHERE cookie_id='<cookie_id>';`
5. 幂等性验证：重启 backend（保持开关开启）再执行一次，确认：
   - `antigravity_accounts` / `antigravity_model_quotas` 行数不增长
   - 随机抽样字段无异常漂移（例如状态/配额等）

## 4) 常见问题

- 如果 backend 报 “mapping missing”：说明 plugin DB 里存在 `accounts.user_id` 在 backend 侧找不到对应用户映射，需要先补齐（通常来自 `plugin_api_keys.plugin_user_id` 或 api_key 匹配）。

