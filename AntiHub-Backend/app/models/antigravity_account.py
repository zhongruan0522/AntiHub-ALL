"""
Antigravity 账号数据模型（原 AntiHub-plugin public.accounts）

说明：
- 账号归属到 User（user_id），支持同一用户保存多个 Antigravity 账号
- 凭证（cookie/access_token/refresh_token 等）使用加密后的 JSON 字符串存储，避免明文落库
- 合并后不保留 shared pool / prefer_shared 等历史语义
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class AntigravityAccount(Base):
    __tablename__ = "antigravity_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联的用户ID",
    )

    cookie_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        unique=True,
        index=True,
        comment="账号唯一标识（来自 plugin accounts.cookie_id）",
    )

    account_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="账号显示名称（对应 plugin name）",
    )

    email: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
        index=True,
        comment="账号邮箱（可选）",
    )

    project_id_0: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
        comment="Project ID（可选，字段名对齐 report）",
    )

    status: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="1",
        comment="账号状态：0=禁用，1=启用",
    )

    need_refresh: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
        comment="是否需要刷新凭证",
    )

    is_restricted: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
        comment="是否受限账号（字段来源 plugin，合并后仅做展示/兼容）",
    )

    paid_tier: Mapped[Optional[bool]] = mapped_column(
        Boolean,
        nullable=True,
        comment="是否付费层级（字段来源 plugin）",
    )

    ineligible: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
        comment="是否不可用（字段来源 plugin）",
    )

    token_expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="token 过期时间（由 plugin expires_at(ms) 转换）",
    )

    last_refresh_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后一次刷新 token 的时间",
    )

    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后使用时间（预留）",
    )

    credentials: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="加密后的凭证 JSON（至少包含 access_token/refresh_token/expires_at_ms 等）",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        comment="创建时间",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
        comment="更新时间",
    )

    user: Mapped["User"] = relationship("User", back_populates="antigravity_accounts")

    def __repr__(self) -> str:
        return f"<AntigravityAccount(id={self.id}, user_id={self.user_id}, cookie_id='{self.cookie_id}')>"

