#!/usr/bin/env bash
set -euo pipefail

# 给 plugin 自动建库/建用户（仅首次初始化 PG 数据目录时执行）

plugin_db="${PLUGIN_DB_NAME:-antigravity}"
plugin_user="${PLUGIN_DB_USER:-antigravity}"
plugin_password="${PLUGIN_DB_PASSWORD:-}"

if [[ -z "${plugin_db}" || -z "${plugin_user}" || -z "${plugin_password}" ]]; then
  echo "skip init: PLUGIN_DB_* not fully set"
  exit 0
fi

role_exists="$(
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v plugin_user="$plugin_user" \
    -tAc "SELECT 1 FROM pg_roles WHERE rolname = :'plugin_user';" \
    | tr -d '[:space:]'
)"

if [[ "${role_exists}" != "1" ]]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v plugin_user="$plugin_user" \
    -v plugin_password="$plugin_password" \
    -c "CREATE ROLE :\"plugin_user\" LOGIN PASSWORD :'plugin_password';"
fi

db_exists="$(
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v plugin_db="$plugin_db" \
    -tAc "SELECT 1 FROM pg_database WHERE datname = :'plugin_db';" \
    | tr -d '[:space:]'
)"

if [[ "${db_exists}" != "1" ]]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v plugin_db="$plugin_db" \
    -v plugin_user="$plugin_user" \
    -c "CREATE DATABASE :\"plugin_db\" OWNER :\"plugin_user\";"
fi

