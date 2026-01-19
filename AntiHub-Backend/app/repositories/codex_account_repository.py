"""
Codex 账号数据仓储

约定：
- Repository 层不负责 commit()，事务由调用方（依赖注入的 get_db）统一管理
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, Sequence

from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.codex_account import CodexAccount


class CodexAccountRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_by_user_id(self, user_id: int) -> Sequence[CodexAccount]:
        result = await self.db.execute(
            select(CodexAccount)
            .where(CodexAccount.user_id == user_id)
            .order_by(CodexAccount.id.asc())
        )
        return result.scalars().all()

    async def list_enabled_by_user_id(self, user_id: int) -> Sequence[CodexAccount]:
        """
        返回“启用”的账号列表（用于路由选择）。

        选择策略需要稳定顺序：这里按 id 升序（即添加顺序）。
        """
        result = await self.db.execute(
            select(CodexAccount)
            .where(CodexAccount.user_id == user_id, CodexAccount.status == 1)
            .order_by(CodexAccount.id.asc())
        )
        return result.scalars().all()

    async def get_by_id(self, account_id: int) -> Optional[CodexAccount]:
        result = await self.db.execute(select(CodexAccount).where(CodexAccount.id == account_id))
        return result.scalar_one_or_none()

    async def get_by_id_and_user_id(self, account_id: int, user_id: int) -> Optional[CodexAccount]:
        result = await self.db.execute(
            select(CodexAccount).where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def get_by_user_id_and_email(self, user_id: int, email: str) -> Optional[CodexAccount]:
        result = await self.db.execute(
            select(CodexAccount).where(CodexAccount.user_id == user_id, CodexAccount.email == email)
        )
        return result.scalar_one_or_none()

    async def get_by_user_id_and_openai_account_id(
        self, user_id: int, openai_account_id: str
    ) -> Optional[CodexAccount]:
        result = await self.db.execute(
            select(CodexAccount).where(
                CodexAccount.user_id == user_id,
                CodexAccount.openai_account_id == openai_account_id,
            ).order_by(CodexAccount.id.desc()).limit(1)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        user_id: int,
        account_name: str,
        is_shared: int,
        status: int,
        credentials: str,
        email: Optional[str] = None,
        openai_account_id: Optional[str] = None,
        chatgpt_plan_type: Optional[str] = None,
        token_expires_at: Optional[datetime] = None,
        last_refresh_at: Optional[datetime] = None,
        quota_remaining: Optional[float] = None,
        quota_currency: Optional[str] = None,
        quota_updated_at: Optional[datetime] = None,
    ) -> CodexAccount:
        account = CodexAccount(
            user_id=user_id,
            account_name=account_name,
            is_shared=is_shared,
            status=status,
            credentials=credentials,
            email=email,
            openai_account_id=openai_account_id,
            chatgpt_plan_type=chatgpt_plan_type,
            token_expires_at=token_expires_at,
            last_refresh_at=last_refresh_at,
            quota_remaining=quota_remaining,
            quota_currency=quota_currency,
            quota_updated_at=quota_updated_at,
        )

        self.db.add(account)
        await self.db.flush()
        await self.db.refresh(account)
        return account

    async def update_credentials_and_profile(
        self,
        account_id: int,
        user_id: int,
        *,
        account_name: Optional[str] = None,
        credentials: Optional[str] = None,
        email: Optional[str] = None,
        openai_account_id: Optional[str] = None,
        chatgpt_plan_type: Optional[str] = None,
        token_expires_at: Optional[datetime] = None,
        last_refresh_at: Optional[datetime] = None,
    ) -> Optional[CodexAccount]:
        values = {}
        if account_name is not None:
            values["account_name"] = account_name
        if credentials is not None:
            values["credentials"] = credentials
        if email is not None:
            values["email"] = email
        if openai_account_id is not None:
            values["openai_account_id"] = openai_account_id
        if chatgpt_plan_type is not None:
            values["chatgpt_plan_type"] = chatgpt_plan_type
        if token_expires_at is not None:
            values["token_expires_at"] = token_expires_at
        if last_refresh_at is not None:
            values["last_refresh_at"] = last_refresh_at

        if not values:
            return await self.get_by_id_and_user_id(account_id, user_id)

        await self.db.execute(
            update(CodexAccount)
            .where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
            .values(**values)
        )
        await self.db.flush()
        return await self.get_by_id_and_user_id(account_id, user_id)

    async def update_status(self, account_id: int, user_id: int, status: int) -> Optional[CodexAccount]:
        await self.db.execute(
            update(CodexAccount)
            .where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
            .values(status=status)
        )
        await self.db.flush()
        return await self.get_by_id_and_user_id(account_id, user_id)

    async def update_name(self, account_id: int, user_id: int, account_name: str) -> Optional[CodexAccount]:
        await self.db.execute(
            update(CodexAccount)
            .where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
            .values(account_name=account_name)
        )
        await self.db.flush()
        return await self.get_by_id_and_user_id(account_id, user_id)

    async def update_quota(
        self,
        account_id: int,
        user_id: int,
        *,
        quota_remaining: Optional[float] = None,
        quota_currency: Optional[str] = None,
        quota_updated_at: Optional[datetime] = None,
    ) -> Optional[CodexAccount]:
        values = {}
        if quota_remaining is not None:
            values["quota_remaining"] = quota_remaining
        if quota_currency is not None:
            values["quota_currency"] = quota_currency
        if quota_updated_at is not None:
            values["quota_updated_at"] = quota_updated_at

        if not values:
            return await self.get_by_id_and_user_id(account_id, user_id)

        await self.db.execute(
            update(CodexAccount)
            .where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
            .values(**values)
        )
        await self.db.flush()
        return await self.get_by_id_and_user_id(account_id, user_id)

    async def update_limits(
        self,
        account_id: int,
        user_id: int,
        *,
        limit_5h_used_percent: Optional[int],
        limit_5h_reset_at: Optional[datetime],
        limit_week_used_percent: Optional[int],
        limit_week_reset_at: Optional[datetime],
    ) -> Optional[CodexAccount]:
        """
        手动维护限额字段。

        说明：这里按“全量覆盖”来做，None 表示清空字段（前端提交什么就落什么）。
        """
        values = {
            "limit_5h_used_percent": limit_5h_used_percent,
            "limit_5h_reset_at": limit_5h_reset_at,
            "limit_week_used_percent": limit_week_used_percent,
            "limit_week_reset_at": limit_week_reset_at,
        }

        await self.db.execute(
            update(CodexAccount)
            .where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
            .values(**values)
        )
        await self.db.flush()
        return await self.get_by_id_and_user_id(account_id, user_id)

    async def delete(self, account_id: int, user_id: int) -> bool:
        result = await self.db.execute(
            delete(CodexAccount).where(CodexAccount.id == account_id, CodexAccount.user_id == user_id)
        )
        await self.db.flush()
        return (result.rowcount or 0) > 0
