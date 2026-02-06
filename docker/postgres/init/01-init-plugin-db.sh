#!/bin/sh
# 为 AntiHub Plugin 服务创建独立数据库与用户（仅首次初始化数据卷时执行）
#
# 注意：PostgreSQL 官方镜像会在初始化阶段执行 /docker-entrypoint-initdb.d 下的 *.sh 脚本；
# 在 bash/sh 的 here-doc 中，`$$` 会被 shell 展开为 PID，导致 SQL（例如 `DO $$`）语法错误。
# 这里统一使用“单引号 heredoc + psql 变量”的方式，彻底避免 shell 展开。
set -e

strip_cr() {
    printf '%s' "$1" | tr -d '\r'
}

POSTGRES_USER=$(strip_cr "${POSTGRES_USER:-antihub}")
POSTGRES_PASSWORD=$(strip_cr "${POSTGRES_PASSWORD:-please-change-me}")
PLUGIN_DB_NAME=$(strip_cr "${PLUGIN_DB_NAME:-antigravity}")
PLUGIN_DB_USER=$(strip_cr "${PLUGIN_DB_USER:-antigravity}")
PLUGIN_DB_PASSWORD=$(strip_cr "${PLUGIN_DB_PASSWORD:-please-change-me}")

if [ -z "$PLUGIN_DB_NAME" ] || [ -z "$PLUGIN_DB_USER" ]; then
    echo "[initdb] 缺少必要环境变量：PLUGIN_DB_NAME / PLUGIN_DB_USER" >&2
    exit 1
fi

if [ "$PLUGIN_DB_USER" = "$POSTGRES_USER" ] && [ "$PLUGIN_DB_PASSWORD" != "$POSTGRES_PASSWORD" ]; then
    echo "[initdb] 配置冲突：PLUGIN_DB_USER 与 POSTGRES_USER 相同，但 PLUGIN_DB_PASSWORD 与 POSTGRES_PASSWORD 不一致（同一用户不可能有两套密码）" >&2
    exit 1
fi

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v su_user="$POSTGRES_USER" -v su_pass="$POSTGRES_PASSWORD" \
    -v plugin_db="$PLUGIN_DB_NAME" -v plugin_user="$PLUGIN_DB_USER" -v plugin_pass="$PLUGIN_DB_PASSWORD" <<'EOSQL'
SELECT format('ALTER USER %I WITH PASSWORD %L', :'su_user', :'su_pass') \gexec

SELECT format('CREATE USER %I WITH PASSWORD %L', :'plugin_user', :'plugin_pass')
WHERE :'plugin_user' <> :'su_user'
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'plugin_user') \gexec

SELECT format('ALTER USER %I WITH PASSWORD %L', :'plugin_user', :'plugin_pass')
WHERE :'plugin_user' <> :'su_user'
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'plugin_user') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'plugin_db', :'plugin_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'plugin_db') \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'plugin_db', :'plugin_user')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'plugin_db') \gexec

SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'plugin_db', :'plugin_user') \gexec
EOSQL

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$PLUGIN_DB_NAME" \
    -v plugin_user="$PLUGIN_DB_USER" <<'EOSQL'
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'plugin_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', :'plugin_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', :'plugin_user') \gexec
EOSQL
