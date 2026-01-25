"""
CodexCLI 兜底服务配置（按用户落库）

说明：
- 只存“基础 URL + KEY”，上游请求时程序自动补全 `/responses`
- KEY 使用 Fernet 加密后落库，避免明文存储
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class CodexFallbackConfig(Base):
    """CodexCLI 兜底服务配置（每个 user 一条）"""

    __tablename__ = "codex_fallback_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联的用户ID",
    )

    base_url: Mapped[str] = mapped_column(
        String(1024),
        nullable=False,
        comment="兜底上游基础URL（例如 https://api.openai.com/v1）",
    )

    api_key: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="加密后的上游API KEY",
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        nullable=False,
        comment="是否启用（预留）",
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

