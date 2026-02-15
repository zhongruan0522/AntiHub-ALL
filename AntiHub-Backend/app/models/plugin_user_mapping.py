"""
Plugin 用户映射表（AntiHub-plugin user_id(UUID) → Backend users.id）

用途：
- 仅用于迁移期（plugin DB → Backend DB）建立可追溯的映射记录
- 不参与运行时请求链路（避免引入对迁移期概念的长期依赖）
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class PluginUserMapping(Base):
    __tablename__ = "plugin_user_mappings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    plugin_user_id: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="AntiHub-plugin users.user_id（UUID 字符串）",
    )

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="Backend users.id",
    )

    source: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
        comment="映射来源（例如 plugin_api_keys.plugin_user_id / plugin_users.api_key）",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        comment="创建时间",
    )

    user: Mapped["User"] = relationship("User")

    def __repr__(self) -> str:
        return f"<PluginUserMapping(id={self.id}, plugin_user_id='{self.plugin_user_id}', user_id={self.user_id})>"
