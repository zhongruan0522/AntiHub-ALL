"""
CodexCLI 兜底服务配置 Repository

约定：
- Repository 不负责 commit()；事务由 get_db 的依赖统一处理
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.codex_fallback_config import CodexFallbackConfig


class CodexFallbackConfigRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_user_id(self, user_id: int) -> Optional[CodexFallbackConfig]:
        result = await self.db.execute(
            select(CodexFallbackConfig).where(CodexFallbackConfig.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def create(self, *, user_id: int, base_url: str, api_key: str) -> CodexFallbackConfig:
        cfg = CodexFallbackConfig(user_id=user_id, base_url=base_url, api_key=api_key, is_active=True)
        self.db.add(cfg)
        await self.db.flush()
        await self.db.refresh(cfg)
        return cfg

    async def update(self, *, user_id: int, **kwargs) -> CodexFallbackConfig:
        stmt = (
            update(CodexFallbackConfig)
            .where(CodexFallbackConfig.user_id == user_id)
            .values(**kwargs)
            .returning(CodexFallbackConfig)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

    async def delete(self, *, user_id: int) -> bool:
        result = await self.db.execute(
            delete(CodexFallbackConfig).where(CodexFallbackConfig.user_id == user_id)
        )
        await self.db.flush()
        return (result.rowcount or 0) > 0

