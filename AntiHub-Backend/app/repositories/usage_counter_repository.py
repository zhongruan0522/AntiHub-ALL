"""
UsageCounter Repository

负责对 usage_counters 做原子自增（upsert）与读取汇总。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.usage_counter import UsageCounter


def _normalize_config_type(value: Optional[str]) -> str:
    text = (value or "").strip()
    return text if text else "unknown"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


class UsageCounterRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def increment(
        self,
        *,
        user_id: int,
        config_type: Optional[str],
        success: bool,
        quota_consumed: float = 0.0,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        total_tokens: int = 0,
        duration_ms: int = 0,
    ) -> None:
        config_key = _normalize_config_type(config_type)

        inc_total = 1
        inc_success = 1 if success else 0
        inc_failed = 0 if success else 1
        inc_input = max(_safe_int(input_tokens, 0), 0)
        inc_output = max(_safe_int(output_tokens, 0), 0)
        inc_cached = max(_safe_int(cached_tokens, 0), 0)
        inc_tokens = max(_safe_int(total_tokens, 0), 0)
        inc_quota = _safe_float(quota_consumed, 0.0)
        inc_duration = max(_safe_int(duration_ms, 0), 0)

        bind = self.db.get_bind()
        dialect_name = getattr(getattr(bind, "dialect", None), "name", "") if bind is not None else ""

        insert_stmt = None
        if dialect_name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            insert_stmt = pg_insert(UsageCounter)
        elif dialect_name == "sqlite":
            from sqlalchemy.dialects.sqlite import insert as sqlite_insert

            insert_stmt = sqlite_insert(UsageCounter)

        if insert_stmt is not None:
            base = insert_stmt.values(
                user_id=user_id,
                config_type=config_key,
                total_requests=inc_total,
                success_requests=inc_success,
                failed_requests=inc_failed,
                input_tokens=inc_input,
                output_tokens=inc_output,
                cached_tokens=inc_cached,
                total_tokens=inc_tokens,
                total_quota_consumed=inc_quota,
                total_duration_ms=inc_duration,
            )
            stmt = base.on_conflict_do_update(
                index_elements=[UsageCounter.user_id, UsageCounter.config_type],
                set_={
                    "total_requests": UsageCounter.total_requests + base.excluded.total_requests,
                    "success_requests": UsageCounter.success_requests + base.excluded.success_requests,
                    "failed_requests": UsageCounter.failed_requests + base.excluded.failed_requests,
                    "input_tokens": UsageCounter.input_tokens + base.excluded.input_tokens,
                    "output_tokens": UsageCounter.output_tokens + base.excluded.output_tokens,
                    "cached_tokens": UsageCounter.cached_tokens + base.excluded.cached_tokens,
                    "total_tokens": UsageCounter.total_tokens + base.excluded.total_tokens,
                    "total_quota_consumed": UsageCounter.total_quota_consumed + base.excluded.total_quota_consumed,
                    "total_duration_ms": UsageCounter.total_duration_ms + base.excluded.total_duration_ms,
                    "updated_at": func.now(),
                },
            )
            await self.db.execute(stmt)
            return

        # fallback（不支持 upsert 的方言）：先查再改/插
        existing = (
            await self.db.execute(
                select(UsageCounter).where(
                    UsageCounter.user_id == user_id,
                    UsageCounter.config_type == config_key,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            self.db.add(
                UsageCounter(
                    user_id=user_id,
                    config_type=config_key,
                    total_requests=inc_total,
                    success_requests=inc_success,
                    failed_requests=inc_failed,
                    input_tokens=inc_input,
                    output_tokens=inc_output,
                    cached_tokens=inc_cached,
                    total_tokens=inc_tokens,
                    total_quota_consumed=inc_quota,
                    total_duration_ms=inc_duration,
                )
            )
            return

        existing.total_requests += inc_total
        existing.success_requests += inc_success
        existing.failed_requests += inc_failed
        existing.input_tokens += inc_input
        existing.output_tokens += inc_output
        existing.cached_tokens += inc_cached
        existing.total_tokens += inc_tokens
        existing.total_quota_consumed += inc_quota
        existing.total_duration_ms += inc_duration

    async def list_counters(
        self,
        *,
        user_id: int,
        config_type: Optional[str] = None,
    ) -> List[UsageCounter]:
        stmt = select(UsageCounter).where(UsageCounter.user_id == user_id)
        if config_type:
            stmt = stmt.where(UsageCounter.config_type == _normalize_config_type(config_type))
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_stats(
        self,
        *,
        user_id: int,
        config_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        rows = await self.list_counters(user_id=user_id, config_type=config_type)

        totals = {
            "total_requests": 0,
            "success_requests": 0,
            "failed_requests": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cached_tokens": 0,
            "total_tokens": 0,
            "total_quota_consumed": 0.0,
            "total_duration_ms": 0,
        }
        by_config_type: Dict[str, Any] = {}

        for r in rows:
            key = r.config_type or "unknown"
            by_config_type[key] = {
                "total_requests": int(r.total_requests or 0),
                "success_requests": int(r.success_requests or 0),
                "failed_requests": int(r.failed_requests or 0),
                "total_tokens": int(r.total_tokens or 0),
                "total_quota_consumed": float(r.total_quota_consumed or 0.0),
            }

            totals["total_requests"] += int(r.total_requests or 0)
            totals["success_requests"] += int(r.success_requests or 0)
            totals["failed_requests"] += int(r.failed_requests or 0)
            totals["input_tokens"] += int(r.input_tokens or 0)
            totals["output_tokens"] += int(r.output_tokens or 0)
            totals["cached_tokens"] += int(r.cached_tokens or 0)
            totals["total_tokens"] += int(r.total_tokens or 0)
            totals["total_quota_consumed"] += float(r.total_quota_consumed or 0.0)
            totals["total_duration_ms"] += int(r.total_duration_ms or 0)

        avg_duration_ms = (
            float(totals["total_duration_ms"]) / float(totals["total_requests"])
            if totals["total_requests"] > 0
            else 0.0
        )

        return {
            "total_requests": int(totals["total_requests"]),
            "success_requests": int(totals["success_requests"]),
            "failed_requests": int(totals["failed_requests"]),
            "input_tokens": int(totals["input_tokens"]),
            "output_tokens": int(totals["output_tokens"]),
            "cached_tokens": int(totals["cached_tokens"]),
            "total_tokens": int(totals["total_tokens"]),
            "total_quota_consumed": float(totals["total_quota_consumed"]),
            "avg_duration_ms": avg_duration_ms,
            "by_config_type": by_config_type,
            "by_model": {},  # counters 仅做累计；按模型的统计仍可通过 logs 侧做“最近”分析
        }

