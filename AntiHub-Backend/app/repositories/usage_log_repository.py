"""
UsageLog Repository
提供用量日志的查询/统计能力
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.usage_log import UsageLog


class UsageLogRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    def _apply_filters(
        self,
        stmt,
        *,
        user_id: int,
        start_at: Optional[datetime] = None,
        end_at: Optional[datetime] = None,
        config_type: Optional[str] = None,
        client_app: Optional[str] = None,
        success: Optional[bool] = None,
        model_name: Optional[str] = None,
    ):
        stmt = stmt.where(UsageLog.user_id == user_id)
        if start_at is not None:
            stmt = stmt.where(UsageLog.created_at >= start_at)
        if end_at is not None:
            stmt = stmt.where(UsageLog.created_at <= end_at)
        if config_type:
            stmt = stmt.where(UsageLog.config_type == config_type)
        if client_app:
            stmt = stmt.where(UsageLog.client_app == client_app)
        if success is not None:
            stmt = stmt.where(UsageLog.success == success)
        if model_name:
            stmt = stmt.where(UsageLog.model_name == model_name)
        return stmt

    async def get_log_by_id(
        self,
        *,
        log_id: int,
        user_id: int,
    ) -> Optional[UsageLog]:
        """根据ID获取单条日志（验证用户归属）"""
        stmt = select(UsageLog).where(UsageLog.id == log_id, UsageLog.user_id == user_id)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_logs(
        self,
        *,
        user_id: int,
        limit: int = 50,
        offset: int = 0,
        start_at: Optional[datetime] = None,
        end_at: Optional[datetime] = None,
        config_type: Optional[str] = None,
        client_app: Optional[str] = None,
        success: Optional[bool] = None,
        model_name: Optional[str] = None,
    ) -> List[UsageLog]:
        stmt = select(UsageLog)
        stmt = self._apply_filters(
            stmt,
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            client_app=client_app,
            success=success,
            model_name=model_name,
        )
        stmt = stmt.order_by(UsageLog.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def count_logs(
        self,
        *,
        user_id: int,
        start_at: Optional[datetime] = None,
        end_at: Optional[datetime] = None,
        config_type: Optional[str] = None,
        client_app: Optional[str] = None,
        success: Optional[bool] = None,
        model_name: Optional[str] = None,
    ) -> int:
        stmt = select(func.count(UsageLog.id))
        stmt = self._apply_filters(
            stmt,
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            client_app=client_app,
            success=success,
            model_name=model_name,
        )
        result = await self.db.execute(stmt)
        return int(result.scalar() or 0)

    async def get_stats(
        self,
        *,
        user_id: int,
        start_at: Optional[datetime] = None,
        end_at: Optional[datetime] = None,
        config_type: Optional[str] = None,
        client_app: Optional[str] = None,
    ) -> Dict[str, Any]:
        base_stmt = select(
            func.count(UsageLog.id).label("total_requests"),
            func.coalesce(
                func.sum(case((UsageLog.success.is_(True), 1), else_=0)), 0
            ).label("success_requests"),
            func.coalesce(
                func.sum(case((UsageLog.success.is_(False), 1), else_=0)), 0
            ).label("failed_requests"),
            func.coalesce(func.sum(UsageLog.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(UsageLog.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(UsageLog.total_tokens), 0).label("total_tokens"),
            func.coalesce(func.sum(UsageLog.quota_consumed), 0).label("total_quota_consumed"),
            func.coalesce(func.avg(UsageLog.duration_ms), 0).label("avg_duration_ms"),
        )
        base_stmt = self._apply_filters(
            base_stmt,
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            client_app=client_app,
        )
        base_result = await self.db.execute(base_stmt)
        row = base_result.one()

        # 按 config_type 聚合
        by_config_stmt = select(
            UsageLog.config_type,
            func.count(UsageLog.id).label("total_requests"),
            func.coalesce(
                func.sum(case((UsageLog.success.is_(True), 1), else_=0)), 0
            ).label("success_requests"),
            func.coalesce(
                func.sum(case((UsageLog.success.is_(False), 1), else_=0)), 0
            ).label("failed_requests"),
            func.coalesce(func.sum(UsageLog.total_tokens), 0).label("total_tokens"),
            func.coalesce(func.sum(UsageLog.quota_consumed), 0).label("total_quota_consumed"),
        )
        by_config_stmt = self._apply_filters(
            by_config_stmt,
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            client_app=client_app,
        ).group_by(UsageLog.config_type)
        by_config_rows = (await self.db.execute(by_config_stmt)).all()

        by_config: Dict[str, Any] = {}
        for r in by_config_rows:
            key = r.config_type or "unknown"
            by_config[key] = {
                "total_requests": int(r.total_requests or 0),
                "success_requests": int(r.success_requests or 0),
                "failed_requests": int(r.failed_requests or 0),
                "total_tokens": int(r.total_tokens or 0),
                "total_quota_consumed": float(r.total_quota_consumed or 0.0),
            }

        # 按 model 聚合（只返回 top 50，避免返回过大）
        by_model_stmt = select(
            UsageLog.model_name,
            func.count(UsageLog.id).label("total_requests"),
            func.coalesce(func.sum(UsageLog.total_tokens), 0).label("total_tokens"),
            func.coalesce(func.sum(UsageLog.quota_consumed), 0).label("total_quota_consumed"),
        )
        by_model_stmt = self._apply_filters(
            by_model_stmt,
            user_id=user_id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            client_app=client_app,
        ).group_by(UsageLog.model_name)
        by_model_stmt = by_model_stmt.order_by(
            func.sum(UsageLog.total_tokens).desc(),
            func.sum(UsageLog.quota_consumed).desc(),
        ).limit(50)
        by_model_rows = (await self.db.execute(by_model_stmt)).all()

        by_model: Dict[str, Any] = {}
        for r in by_model_rows:
            key = r.model_name or "unknown"
            by_model[key] = {
                "total_requests": int(r.total_requests or 0),
                "total_tokens": int(r.total_tokens or 0),
                "total_quota_consumed": float(r.total_quota_consumed or 0.0),
            }

        return {
            "total_requests": int(row.total_requests or 0),
            "success_requests": int(row.success_requests or 0),
            "failed_requests": int(row.failed_requests or 0),
            "input_tokens": int(row.input_tokens or 0),
            "output_tokens": int(row.output_tokens or 0),
            "total_tokens": int(row.total_tokens or 0),
            "total_quota_consumed": float(row.total_quota_consumed or 0.0),
            "avg_duration_ms": float(row.avg_duration_ms or 0),
            "by_config_type": by_config,
            "by_model": by_model,
        }
