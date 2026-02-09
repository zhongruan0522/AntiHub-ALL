"""
用户设置 Repository

约定：
- Repository 不负责 commit()；事务由 get_db 的依赖统一处理
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user_setting import UserSetting


class UserSettingRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_user_id(self, user_id: int) -> Optional[UserSetting]:
        result = await self.db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
        return result.scalar_one_or_none()

    async def create(
        self,
        *,
        user_id: int,
        accounts_default_channel: Optional[str] = None,
        usage_default_channel: Optional[str] = None,
    ) -> UserSetting:
        setting = UserSetting(
            user_id=user_id,
            accounts_default_channel=accounts_default_channel,
            usage_default_channel=usage_default_channel,
        )
        self.db.add(setting)
        await self.db.flush()
        await self.db.refresh(setting)
        return setting

    async def update(self, *, user_id: int, **kwargs) -> UserSetting:
        stmt = (
            update(UserSetting)
            .where(UserSetting.user_id == user_id)
            .values(**kwargs)
            .returning(UserSetting)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.scalar_one()

