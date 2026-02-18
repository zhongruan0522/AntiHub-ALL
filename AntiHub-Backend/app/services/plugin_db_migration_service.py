"""
Plugin DB → Backend DB 迁移服务（升级/迁移期）

目标：
- 当配置了 PLUGIN_API_BASE_URL（指向“迁移助手/Env Exporter”服务）时，自动从旧 plugin DB 导入账号数据到 Backend（antigravity_* / kiro_* 等）
- 使用数据库状态表（plugin_db_migration_states）记录迁移是否完成，避免每次启动重复迁移
- 多实例并发启动时只允许一个实例执行迁移，其余实例等待结果；失败时阻止启动以避免半迁移状态
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

import httpx
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.sql import func

from app.core.config import get_settings
from app.models.antigravity_account import AntigravityAccount
from app.models.antigravity_model_quota import AntigravityModelQuota
from app.models.kiro_account import KiroAccount
from app.models.kiro_subscription_model import KiroSubscriptionModel
from app.models.plugin_api_key import PluginAPIKey
from app.models.plugin_db_migration_state import PluginDbMigrationState
from app.models.plugin_user_mapping import PluginUserMapping
from app.utils.encryption import decrypt_api_key, encrypt_api_key

logger = logging.getLogger(__name__)

_MIGRATION_KEY = "plugin_db_to_backend_v2"
_PLUGIN_ENV_ENDPOINT_PATH = "/api/migration/db-env"

_DEFAULT_WAIT_TIMEOUT_SECONDS = 600
_DEFAULT_POLL_INTERVAL_SECONDS = 2.0
_DEFAULT_PLUGIN_ENV_HTTP_TIMEOUT_SECONDS = 10.0

_MIGRATION_STATUS_PENDING = "pending"
_MIGRATION_STATUS_RUNNING = "running"
_MIGRATION_STATUS_DONE = "done"
_MIGRATION_STATUS_FAILED = "failed"


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
    在配置了 PLUGIN_API_BASE_URL 时确保迁移执行完成。

    - 成功：继续启动
    - 失败：抛异常阻止启动（避免半迁移状态）
    """
    settings = get_settings()
    plugin_api_base_url = (settings.plugin_api_base_url or "").strip().rstrip("/")
    if not plugin_api_base_url:
        # 新部署：不配置该项，直接跳过迁移逻辑
        return

    wait_timeout = int(getattr(settings, "plugin_db_migration_wait_timeout_seconds", 0) or 0)
    if wait_timeout <= 0:
        wait_timeout = _DEFAULT_WAIT_TIMEOUT_SECONDS

    # 确保状态行存在（幂等）
    async with db.begin():
        stmt = (
            pg_insert(PluginDbMigrationState)
            .values(key=_MIGRATION_KEY, status=_MIGRATION_STATUS_PENDING)
            .on_conflict_do_nothing(index_elements=[PluginDbMigrationState.key])
        )
        await db.execute(stmt)

    state = await _get_migration_state(db)
    if state is not None and state.status == _MIGRATION_STATUS_DONE:
        logger.info("[migration] plugin DB migration already done: key=%s", _MIGRATION_KEY)
        return

    now = datetime.now(timezone.utc)
    instance_id = str(uuid4())

    acquired = await _try_claim_migration(db=db, now=now, instance_id=instance_id)

    if acquired:
        engine: Optional[AsyncEngine] = None
        try:
            raw_token = (settings.plugin_env_export_token or "").strip()
            if not raw_token:
                raw_token = (os.getenv("PLUGIN_ADMIN_API_KEY") or "").strip()
            if not raw_token:
                raw_token = (os.getenv("PLUGIN_API_ADMIN_KEY") or "").strip()

            plugin_db_url = await _resolve_plugin_db_url(
                plugin_api_base_url=plugin_api_base_url,
                plugin_env_export_token=raw_token or None,
            )
            logger.info(
                "[migration] starting plugin DB migration: key=%s plugin_api_base_url=%s",
                _MIGRATION_KEY,
                plugin_api_base_url,
            )
            engine = create_async_engine(plugin_db_url, pool_pre_ping=True)
            await _run_migration(db=db, plugin_engine=engine)

            async with db.begin():
                await db.execute(
                    update(PluginDbMigrationState)
                    .where(PluginDbMigrationState.key == _MIGRATION_KEY)
                    .values(
                        status=_MIGRATION_STATUS_DONE,
                        finished_at=datetime.now(timezone.utc),
                        last_error=None,
                        updated_at=func.now(),
                    )
                )

            logger.info("[migration] plugin DB migration done: key=%s", _MIGRATION_KEY)
            return
        except Exception as e:
            async with db.begin():
                await db.execute(
                    update(PluginDbMigrationState)
                    .where(PluginDbMigrationState.key == _MIGRATION_KEY)
                    .values(
                        status=_MIGRATION_STATUS_FAILED,
                        finished_at=datetime.now(timezone.utc),
                        last_error=f"{type(e).__name__}: {str(e)}",
                        updated_at=func.now(),
                    )
                )
            logger.error("[migration] plugin DB migration failed: %s: %s", type(e).__name__, str(e), exc_info=True)
            raise
        finally:
            if engine is not None:
                try:
                    await engine.dispose()
                except Exception:
                    pass

    logger.info("[migration] migration already running in another instance; waiting: key=%s", _MIGRATION_KEY)
    await _wait_for_migration_done(db=db, timeout_seconds=wait_timeout)


async def _get_migration_state(db: AsyncSession) -> Optional[PluginDbMigrationState]:
    stmt = (
        select(PluginDbMigrationState)
        .where(PluginDbMigrationState.key == _MIGRATION_KEY)
        .execution_options(populate_existing=True)
    )

    if db.in_transaction():
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    async with db.begin():
        result = await db.execute(stmt)
        return result.scalar_one_or_none()


async def _try_claim_migration(*, db: AsyncSession, now: datetime, instance_id: str) -> bool:
    # 原子更新：pending/failed -> running（用于多实例并发启动时只跑一次迁移）
    async with db.begin():
        result = await db.execute(
            update(PluginDbMigrationState)
            .where(
                PluginDbMigrationState.key == _MIGRATION_KEY,
                PluginDbMigrationState.status.in_([_MIGRATION_STATUS_PENDING, _MIGRATION_STATUS_FAILED]),
            )
            .values(
                status=_MIGRATION_STATUS_RUNNING,
                started_at=now,
                finished_at=None,
                last_error=None,
                updated_at=func.now(),
            )
        )

    claimed = bool(result.rowcount and result.rowcount > 0)
    if claimed:
        logger.info("[migration] claimed migration: key=%s instance_id=%s", _MIGRATION_KEY, instance_id)
    return claimed


async def _wait_for_migration_done(*, db: AsyncSession, timeout_seconds: int) -> None:
    interval = _DEFAULT_POLL_INTERVAL_SECONDS
    waited = 0.0
    while waited < timeout_seconds:
        state = await _get_migration_state(db)
        if state is not None and state.status == _MIGRATION_STATUS_DONE:
            logger.info("[migration] done state detected: key=%s", _MIGRATION_KEY)
            return
        if state is not None and state.status == _MIGRATION_STATUS_FAILED:
            raise RuntimeError(
                "plugin DB migration failed in another instance. "
                f"key={_MIGRATION_KEY} last_error={state.last_error or ''}"
            )
        await asyncio.sleep(interval)
        waited += interval

    raise RuntimeError(
        "plugin DB migration did not complete within wait timeout "
        f"({timeout_seconds}s). key={_MIGRATION_KEY}"
    )


async def _resolve_plugin_db_url(*, plugin_api_base_url: str, plugin_env_export_token: Optional[str]) -> str:
    url = f"{plugin_api_base_url}{_PLUGIN_ENV_ENDPOINT_PATH}"
    headers: Dict[str, str] = {}
    if plugin_env_export_token:
        headers["X-Migration-Token"] = plugin_env_export_token

    async with httpx.AsyncClient(timeout=_DEFAULT_PLUGIN_ENV_HTTP_TIMEOUT_SECONDS) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    def _get(name: str) -> Optional[str]:
        v = data.get(name)
        if v is None:
            v = data.get(name.lower())
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    host = _get("DB_HOST")
    port_raw = _get("DB_PORT") or "5432"
    name = _get("DB_NAME")
    user = _get("DB_USER")
    password = _get("DB_PASSWORD")

    missing = [k for k, v in [("DB_HOST", host), ("DB_NAME", name), ("DB_USER", user), ("DB_PASSWORD", password)] if not v]
    if missing:
        raise RuntimeError(
            "plugin env exporter did not return required fields: "
            + ", ".join(missing)
            + f". url={url}"
        )

    try:
        port = int(port_raw)
    except Exception:
        raise RuntimeError(f"invalid DB_PORT from plugin env exporter: {port_raw!r}. url={url}") from None

    db_url = URL.create(
        "postgresql+asyncpg",
        username=user,
        password=password,
        host=host,
        port=port,
        database=name,
    )
    return db_url.render_as_string(hide_password=False)


async def _run_migration(*, db: AsyncSession, plugin_engine: AsyncEngine) -> None:
    """
    执行一次迁移（幂等，可重试）。
    """
    plugin_accounts = await _fetch_plugin_accounts(plugin_engine)
    plugin_kiro_accounts = await _fetch_plugin_kiro_accounts(plugin_engine)
    plugin_kiro_subscription_models = await _fetch_plugin_kiro_subscription_models(plugin_engine)

    plugin_user_ids = sorted(
        {
            str(r["user_id"])
            for r in (plugin_accounts + plugin_kiro_accounts)
            if r.get("user_id") is not None and str(r.get("user_id")).strip()
        }
    )

    if not plugin_user_ids:
        logger.info("[migration] no plugin data found; nothing to migrate")
        return

    plugin_users = await _fetch_plugin_users(plugin_engine)
    plugin_model_quotas = await _fetch_plugin_model_quotas(plugin_engine)

    # 写入 Backend：单事务，失败回滚，避免半迁移状态
    async with db.begin():
        mapping = await _build_user_mapping(db=db, plugin_user_ids=plugin_user_ids, plugin_users=plugin_users)
        await _upsert_plugin_user_mappings(db=db, mapping=mapping)
        await _upsert_antigravity_accounts(db=db, plugin_accounts=plugin_accounts, mapping=mapping)
        await _upsert_antigravity_model_quotas(db=db, plugin_model_quotas=plugin_model_quotas)
        await _upsert_kiro_accounts(db=db, plugin_kiro_accounts=plugin_kiro_accounts, mapping=mapping)
        await _upsert_kiro_subscription_models(db=db, plugin_rows=plugin_kiro_subscription_models)


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


async def _fetch_plugin_kiro_accounts(plugin_engine: AsyncEngine) -> List[Dict[str, Any]]:
    """
    plugin 的 Kiro 表在历史版本中可能不存在，因此这里 best-effort：
    - 表存在：SELECT * 全量读取（避免列变更导致迁移脚本失效）
    - 表不存在/无权限：返回空列表，不阻塞 antigravity 迁移
    """
    try:
        async with plugin_engine.connect() as conn:
            result = await conn.execute(text("SELECT * FROM public.kiro_accounts"))
            rows = result.mappings().all()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("[migration] fetch plugin kiro_accounts skipped: %s: %s", type(e).__name__, str(e))
        return []


async def _fetch_plugin_kiro_subscription_models(plugin_engine: AsyncEngine) -> List[Dict[str, Any]]:
    """
    同 kiro_accounts：历史版本可能不存在，best-effort。
    """
    try:
        async with plugin_engine.connect() as conn:
            result = await conn.execute(text("SELECT * FROM public.kiro_subscription_models"))
            rows = result.mappings().all()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning(
            "[migration] fetch plugin kiro_subscription_models skipped: %s: %s", type(e).__name__, str(e)
        )
        return []


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


def _coerce_float(value: Any, default: float = 0.0) -> float:
    if value is None or isinstance(value, bool):
        return float(default)
    try:
        return float(value)
    except Exception:
        return float(default)


def _coerce_int(value: Any, default: int = 0) -> int:
    if value is None or isinstance(value, bool):
        return int(default)
    try:
        return int(value)
    except Exception:
        return int(default)


def _coerce_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(int(value))
    if isinstance(value, str):
        s = value.strip().lower()
        if not s:
            return None
        if s in ("1", "true", "yes", "y", "on"):
            return True
        if s in ("0", "false", "no", "n", "off"):
            return False
    return None


def _dump_json_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        return s or None
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def _parse_token_expires_at(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return _naive_dt_to_aware_utc(value)
    return _ms_to_dt_utc(value)


def _parse_dt_utc(value: Any) -> Optional[datetime]:
    """
    best-effort 解析时间字段：
    - datetime -> aware utc
    - int/float/数字字符串 -> 毫秒时间戳（或秒级，尽量兼容）
    - ISO8601 字符串 -> aware utc
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return _naive_dt_to_aware_utc(value)
    if isinstance(value, (int, float)):
        n = int(value)
        if n <= 0:
            return None
        # > 10^10 认为是毫秒，否则认为是秒
        return datetime.fromtimestamp(n / 1000.0, tz=timezone.utc) if n > 10_000_000_000 else datetime.fromtimestamp(n, tz=timezone.utc)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.isdigit():
            try:
                return _parse_dt_utc(int(s))
            except Exception:
                return None
        s2 = s.replace("Z", "+00:00") if s.endswith("Z") else s
        try:
            dt = datetime.fromisoformat(s2)
        except Exception:
            return None
        return _naive_dt_to_aware_utc(dt)
    return None


async def _upsert_kiro_accounts(
    *,
    db: AsyncSession,
    plugin_kiro_accounts: List[Dict[str, Any]],
    mapping: Dict[str, _PluginUserMappingResult],
) -> None:
    if not plugin_kiro_accounts:
        return

    for acc in plugin_kiro_accounts:
        account_id = str(acc.get("account_id") or "").strip() or str(acc.get("id") or "").strip()
        if not account_id:
            continue

        is_shared = _coerce_int(acc.get("is_shared"), 0)
        if is_shared not in (0, 1):
            is_shared = 0

        plugin_user_id = str(acc.get("user_id") or "").strip()
        backend_user_id: Optional[int] = None
        if plugin_user_id:
            backend_user_id = mapping[plugin_user_id].user_id
        elif is_shared == 0:
            # 非共享账号必须能映射到 user_id，否则跳过（避免变成“丢归属”的脏数据）
            continue

        account_name = (acc.get("account_name") or acc.get("name") or "").strip() or "Imported"
        auth_method = (acc.get("auth_method") or acc.get("authMethod") or "").strip() or None
        region = (acc.get("region") or "").strip() or None
        machineid = (acc.get("machineid") or acc.get("machineId") or "").strip() or None
        email = (acc.get("email") or "").strip() or None
        userid = (acc.get("userid") or acc.get("userId") or acc.get("user_id") or "").strip() or None
        subscription = (acc.get("subscription") or "").strip() or None
        subscription_type = (acc.get("subscription_type") or acc.get("subscriptionType") or "").strip() or None

        status = _coerce_int(acc.get("status"), 1)
        status = 1 if status not in (0, 1) else status

        need_refresh = bool(acc.get("need_refresh") or acc.get("needRefresh") or False)

        expires_at_raw = acc.get("expires_at")
        if expires_at_raw is None:
            expires_at_raw = acc.get("token_expires_at")
        token_expires_at = _parse_token_expires_at(expires_at_raw)

        bonus_details_text = _dump_json_text(acc.get("bonus_details") or acc.get("bonusDetails"))
        free_trial_status = _coerce_bool(acc.get("free_trial_status") or acc.get("freeTrialStatus"))

        stmt = pg_insert(KiroAccount).values(
            account_id=account_id,
            user_id=backend_user_id,
            account_name=account_name,
            auth_method=auth_method,
            region=region,
            machineid=machineid,
            email=email,
            userid=userid,
            subscription=subscription,
            subscription_type=subscription_type,
            is_shared=is_shared,
            status=status,
            need_refresh=need_refresh,
            token_expires_at=token_expires_at,
            current_usage=_coerce_float(acc.get("current_usage") or acc.get("currentUsage"), 0.0),
            usage_limit=_coerce_float(acc.get("usage_limit") or acc.get("usageLimit"), 0.0),
            reset_date=_parse_dt_utc(acc.get("reset_date") or acc.get("resetDate")),
            bonus_usage=_coerce_float(acc.get("bonus_usage") or acc.get("bonusUsage"), 0.0),
            bonus_limit=_coerce_float(acc.get("bonus_limit") or acc.get("bonusLimit"), 0.0),
            bonus_details=bonus_details_text,
            free_trial_status=free_trial_status,
            free_trial_usage=_coerce_float(acc.get("free_trial_usage") or acc.get("freeTrialUsage"), 0.0)
            if acc.get("free_trial_usage") is not None or acc.get("freeTrialUsage") is not None
            else None,
            free_trial_limit=_coerce_float(acc.get("free_trial_limit") or acc.get("freeTrialLimit"), 0.0)
            if acc.get("free_trial_limit") is not None or acc.get("freeTrialLimit") is not None
            else None,
            free_trial_expiry=_parse_dt_utc(acc.get("free_trial_expiry") or acc.get("freeTrialExpiry")),
            credentials=encrypt_api_key(
                json.dumps(
                    {
                        "type": "kiro",
                        "refresh_token": acc.get("refresh_token") or acc.get("refreshToken"),
                        "access_token": acc.get("access_token") or acc.get("accessToken"),
                        "client_id": acc.get("client_id") or acc.get("clientId"),
                        "client_secret": acc.get("client_secret") or acc.get("clientSecret"),
                        "profile_arn": acc.get("profile_arn") or acc.get("profileArn"),
                        "machineid": machineid,
                        "region": region,
                        "auth_method": auth_method,
                        "expires_at_ms": expires_at_raw if isinstance(expires_at_raw, (int, float, str)) else None,
                    },
                    ensure_ascii=False,
                )
            ),
            updated_at=func.now(),
        )

        stmt = stmt.on_conflict_do_update(
            index_elements=[KiroAccount.account_id],
            set_={
                "user_id": backend_user_id,
                "account_name": account_name,
                "auth_method": auth_method,
                "region": region,
                "machineid": machineid,
                "email": email,
                "userid": userid,
                "subscription": subscription,
                "subscription_type": subscription_type,
                "is_shared": is_shared,
                "status": status,
                "need_refresh": need_refresh,
                "token_expires_at": token_expires_at,
                "current_usage": _coerce_float(acc.get("current_usage") or acc.get("currentUsage"), 0.0),
                "usage_limit": _coerce_float(acc.get("usage_limit") or acc.get("usageLimit"), 0.0),
                "reset_date": _parse_dt_utc(acc.get("reset_date") or acc.get("resetDate")),
                "bonus_usage": _coerce_float(acc.get("bonus_usage") or acc.get("bonusUsage"), 0.0),
                "bonus_limit": _coerce_float(acc.get("bonus_limit") or acc.get("bonusLimit"), 0.0),
                "bonus_details": bonus_details_text,
                "free_trial_status": free_trial_status,
                "free_trial_usage": _coerce_float(acc.get("free_trial_usage") or acc.get("freeTrialUsage"), 0.0)
                if acc.get("free_trial_usage") is not None or acc.get("freeTrialUsage") is not None
                else None,
                "free_trial_limit": _coerce_float(acc.get("free_trial_limit") or acc.get("freeTrialLimit"), 0.0)
                if acc.get("free_trial_limit") is not None or acc.get("freeTrialLimit") is not None
                else None,
                "free_trial_expiry": _parse_dt_utc(acc.get("free_trial_expiry") or acc.get("freeTrialExpiry")),
                "credentials": stmt.excluded.credentials,
                "updated_at": func.now(),
            },
        )

        await db.execute(stmt)


async def _upsert_kiro_subscription_models(*, db: AsyncSession, plugin_rows: List[Dict[str, Any]]) -> None:
    if not plugin_rows:
        return

    for r in plugin_rows:
        subscription = str(r.get("subscription") or "").strip()
        if not subscription:
            continue

        raw_models = r.get("allowed_model_ids")
        if raw_models is None:
            raw_models = r.get("model_ids")
        allowed_model_ids = _dump_json_text(raw_models)

        stmt = pg_insert(KiroSubscriptionModel).values(
            subscription=subscription,
            allowed_model_ids=allowed_model_ids,
            updated_at=func.now(),
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[KiroSubscriptionModel.subscription],
            set_={"allowed_model_ids": allowed_model_ids, "updated_at": func.now()},
        )
        await db.execute(stmt)
