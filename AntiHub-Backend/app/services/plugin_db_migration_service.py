"""
Plugin DB → Backend DB 迁移服务（迁移期）

目标：
- 在开关开启时，将 AntiHub-plugin DB 的 accounts/model_quotas 导入到 Backend 的 antigravity_* 表
- 使用 Redis 分布式锁避免多实例重复执行；并在迁移失败时阻止启动
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.sql import func

from app.cache import RedisClient, get_redis_client
from app.core.config import get_settings
from app.models.antigravity_account import AntigravityAccount
from app.models.antigravity_model_quota import AntigravityModelQuota
from app.models.plugin_api_key import PluginAPIKey
from app.models.plugin_user_mapping import PluginUserMapping
from app.utils.encryption import decrypt_api_key, encrypt_api_key

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PluginUserMappingResult:
    user_id: int
    source: str


def _ms_to_dt_utc(value: Optional[int]) -> Optional[datetime]:
    if value is None:
        return None
    try:
        ms = int(value)
    except Exception:
        return None
    if ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


def _naive_dt_to_aware_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


async def ensure_plugin_db_migrated(db: AsyncSession) -> None:
    """
    在开关开启时确保迁移执行完成。

    - 成功：继续启动
    - 失败：抛异常阻止启动
    """
    settings = get_settings()
    if not settings.plugin_db_migration_enabled:
        return

    plugin_db_url = (settings.plugin_migration_database_url or "").strip()
    if not plugin_db_url:
        raise RuntimeError("PLUGIN_MIGRATION_DATABASE_URL is required when PLUGIN_DB_MIGRATION_ENABLED=true")

    redis = get_redis_client()

    version = "v1"
    done_key = f"migration:plugin_db_to_backend:done:{version}"
    lock_key = f"migration:plugin_db_to_backend:lock:{version}"
    lock_ttl = int(settings.plugin_db_migration_lock_ttl_seconds or 3600)
    wait_timeout = int(settings.plugin_db_migration_wait_timeout_seconds or 600)

    if await redis.exists(done_key):
        logger.info("[migration] plugin DB migration already done: %s", done_key)
        return

    lock_value = str(uuid4())
    acquired = await _redis_set_if_not_exists(redis, lock_key, lock_value, expire=lock_ttl)

    if acquired:
        logger.info("[migration] acquired lock: %s", lock_key)
        engine: Optional[AsyncEngine] = None
        try:
            engine = create_async_engine(plugin_db_url, pool_pre_ping=True)
            await _run_migration(db=db, plugin_engine=engine)
            await redis.set(done_key, "1")
            logger.info("[migration] done marker set: %s", done_key)
        except Exception as e:
            logger.error("[migration] plugin DB migration failed: %s: %s", type(e).__name__, str(e), exc_info=True)
            raise
        finally:
            try:
                await redis.delete(lock_key)
            except Exception:
                pass
            if engine is not None:
                try:
                    await engine.dispose()
                except Exception:
                    pass
        return

    logger.info("[migration] lock not acquired, waiting for done marker: %s", done_key)
    interval = 2.0
    waited = 0.0
    while waited < wait_timeout:
        if await redis.exists(done_key):
            logger.info("[migration] done marker detected: %s", done_key)
            return
        await asyncio.sleep(interval)
        waited += interval

    raise RuntimeError(
        "PLUGIN_DB_MIGRATION_ENABLED=true but migration did not complete within wait timeout "
        f"({wait_timeout}s). lock_key={lock_key} done_key={done_key}"
    )


async def _redis_set_if_not_exists(redis: RedisClient, key: str, value: str, *, expire: int) -> bool:
    # 优先使用 wrapper 提供的方法（若未来扩展），否则退化为直接调用底层 redis 客户端
    method = getattr(redis, "set_if_not_exists", None)
    if callable(method):
        return bool(await method(key, value, expire=expire))

    # fallback: 使用 set + nx（redis-py 支持）
    raw = getattr(redis, "_client", None)
    if raw is None:
        await redis.connect()
        raw = getattr(redis, "_client", None)
    if raw is None:
        raise RuntimeError("redis client not initialized")
    return bool(await raw.set(key, value, ex=expire, nx=True))


async def _run_migration(*, db: AsyncSession, plugin_engine: AsyncEngine) -> None:
    """
    执行一次迁移（幂等，可重试）。
    """
    plugin_accounts = await _fetch_plugin_accounts(plugin_engine)
    plugin_user_ids = sorted({str(r["user_id"]) for r in plugin_accounts if r.get("user_id") is not None})

    if not plugin_user_ids:
        logger.info("[migration] no plugin accounts found; nothing to migrate")
        return

    plugin_users = await _fetch_plugin_users(plugin_engine)
    mapping = await _build_user_mapping(db=db, plugin_user_ids=plugin_user_ids, plugin_users=plugin_users)

    plugin_model_quotas = await _fetch_plugin_model_quotas(plugin_engine)

    # 写入 Backend：单事务，失败回滚，避免半迁移状态
    async with db.begin():
        await _upsert_plugin_user_mappings(db=db, mapping=mapping)
        await _upsert_antigravity_accounts(db=db, plugin_accounts=plugin_accounts, mapping=mapping)
        await _upsert_antigravity_model_quotas(db=db, plugin_model_quotas=plugin_model_quotas)


async def _fetch_plugin_users(plugin_engine: AsyncEngine) -> Dict[str, Dict[str, Any]]:
    async with plugin_engine.connect() as conn:
        result = await conn.execute(text("SELECT user_id, api_key, name FROM public.users"))
        rows = result.mappings().all()
    users: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        uid = str(r.get("user_id"))
        if not uid:
            continue
        users[uid] = {"api_key": r.get("api_key"), "name": r.get("name")}
    return users


async def _fetch_plugin_accounts(plugin_engine: AsyncEngine) -> List[Dict[str, Any]]:
    sql = """
        SELECT
            cookie_id,
            user_id,
            is_shared,
            access_token,
            refresh_token,
            expires_at,
            status,
            need_refresh,
            name,
            email,
            project_id_0,
            is_restricted,
            paid_tier,
            ineligible,
            created_at,
            updated_at
        FROM public.accounts
    """
    async with plugin_engine.connect() as conn:
        result = await conn.execute(text(sql))
        rows = result.mappings().all()
    return [dict(r) for r in rows]


async def _fetch_plugin_model_quotas(plugin_engine: AsyncEngine) -> List[Dict[str, Any]]:
    sql = """
        SELECT
            cookie_id,
            model_name,
            reset_time,
            quota,
            status,
            last_fetched_at,
            created_at
        FROM public.model_quotas
    """
    async with plugin_engine.connect() as conn:
        result = await conn.execute(text(sql))
        rows = result.mappings().all()
    return [dict(r) for r in rows]


async def _build_user_mapping(
    *,
    db: AsyncSession,
    plugin_user_ids: List[str],
    plugin_users: Dict[str, Dict[str, Any]],
) -> Dict[str, _PluginUserMappingResult]:
    result = await db.execute(select(PluginAPIKey))
    api_keys = result.scalars().all()

    by_plugin_user_id: Dict[str, int] = {}
    by_api_key_plaintext: Dict[str, int] = {}

    for rec in api_keys:
        if rec.plugin_user_id:
            by_plugin_user_id[str(rec.plugin_user_id)] = int(rec.user_id)
        try:
            plaintext = decrypt_api_key(rec.api_key)
        except Exception:
            plaintext = None
        if plaintext:
            by_api_key_plaintext[plaintext] = int(rec.user_id)

    mapping: Dict[str, _PluginUserMappingResult] = {}
    missing: List[str] = []

    for plugin_user_id in plugin_user_ids:
        if plugin_user_id in by_plugin_user_id:
            mapping[plugin_user_id] = _PluginUserMappingResult(
                user_id=by_plugin_user_id[plugin_user_id],
                source="plugin_api_keys.plugin_user_id",
            )
            continue

        plugin_user = plugin_users.get(plugin_user_id) or {}
        plugin_api_key = plugin_user.get("api_key")
        if isinstance(plugin_api_key, str) and plugin_api_key in by_api_key_plaintext:
            mapping[plugin_user_id] = _PluginUserMappingResult(
                user_id=by_api_key_plaintext[plugin_api_key],
                source="plugin_users.api_key",
            )
            continue

        missing.append(plugin_user_id)

    if missing:
        raise RuntimeError(
            "plugin user_id → backend user_id mapping missing for: "
            + ", ".join(missing[:10])
            + (" ..." if len(missing) > 10 else "")
        )

    return mapping


async def _upsert_plugin_user_mappings(*, db: AsyncSession, mapping: Dict[str, _PluginUserMappingResult]) -> None:
    for plugin_user_id, info in mapping.items():
        stmt = pg_insert(PluginUserMapping).values(
            plugin_user_id=plugin_user_id,
            user_id=info.user_id,
            source=info.source,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[PluginUserMapping.plugin_user_id],
            set_={"user_id": info.user_id, "source": info.source},
        )
        await db.execute(stmt)


async def _upsert_antigravity_accounts(
    *,
    db: AsyncSession,
    plugin_accounts: List[Dict[str, Any]],
    mapping: Dict[str, _PluginUserMappingResult],
) -> None:
    for acc in plugin_accounts:
        plugin_user_id = str(acc.get("user_id") or "")
        if not plugin_user_id:
            continue

        backend_user_id = mapping[plugin_user_id].user_id

        cookie_id = str(acc.get("cookie_id") or "").strip()
        if not cookie_id:
            continue

        account_name = (acc.get("name") or "").strip() or "Imported"
        email = (acc.get("email") or "").strip() or None
        project_id_0 = (acc.get("project_id_0") or "").strip() or None

        expires_at_ms = acc.get("expires_at")
        token_expires_at = _ms_to_dt_utc(expires_at_ms)

        credentials_payload = {
            "type": "antigravity",
            "cookie_id": cookie_id,
            "is_shared": 0,
            "access_token": acc.get("access_token"),
            "refresh_token": acc.get("refresh_token"),
            "expires_at": expires_at_ms,
            "expires_at_ms": expires_at_ms,
        }
        encrypted_credentials = encrypt_api_key(json.dumps(credentials_payload, ensure_ascii=False))

        stmt = pg_insert(AntigravityAccount).values(
            user_id=backend_user_id,
            cookie_id=cookie_id,
            account_name=account_name,
            email=email,
            project_id_0=project_id_0,
            status=int(acc.get("status") or 0),
            need_refresh=bool(acc.get("need_refresh") or False),
            is_restricted=bool(acc.get("is_restricted") or False),
            paid_tier=acc.get("paid_tier"),
            ineligible=bool(acc.get("ineligible") or False),
            token_expires_at=token_expires_at,
            credentials=encrypted_credentials,
            updated_at=func.now(),
        )

        stmt = stmt.on_conflict_do_update(
            index_elements=[AntigravityAccount.cookie_id],
            set_={
                "user_id": backend_user_id,
                "account_name": account_name,
                "email": email,
                "project_id_0": project_id_0,
                "status": int(acc.get("status") or 0),
                "need_refresh": bool(acc.get("need_refresh") or False),
                "is_restricted": bool(acc.get("is_restricted") or False),
                "paid_tier": acc.get("paid_tier"),
                "ineligible": bool(acc.get("ineligible") or False),
                "token_expires_at": token_expires_at,
                "credentials": encrypted_credentials,
                "updated_at": func.now(),
            },
        )

        await db.execute(stmt)


async def _upsert_antigravity_model_quotas(*, db: AsyncSession, plugin_model_quotas: List[Dict[str, Any]]) -> None:
    for q in plugin_model_quotas:
        cookie_id = str(q.get("cookie_id") or "").strip()
        model_name = str(q.get("model_name") or "").strip()
        if not cookie_id or not model_name:
            continue

        reset_at = _naive_dt_to_aware_utc(q.get("reset_time"))
        last_fetched_at = _naive_dt_to_aware_utc(q.get("last_fetched_at"))
        created_at = _naive_dt_to_aware_utc(q.get("created_at"))

        try:
            quota_value = float(q.get("quota") or 0.0)
        except Exception:
            quota_value = 0.0

        stmt = pg_insert(AntigravityModelQuota).values(
            cookie_id=cookie_id,
            model_name=model_name,
            quota=quota_value,
            reset_at=reset_at,
            status=int(q.get("status") or 0),
            last_fetched_at=last_fetched_at,
            created_at=created_at or func.now(),
            updated_at=func.now(),
        )

        stmt = stmt.on_conflict_do_update(
            index_elements=[AntigravityModelQuota.cookie_id, AntigravityModelQuota.model_name],
            set_={
                "quota": quota_value,
                "reset_at": reset_at,
                "status": int(q.get("status") or 0),
                "last_fetched_at": last_fetched_at,
                "updated_at": func.now(),
            },
        )

        await db.execute(stmt)

