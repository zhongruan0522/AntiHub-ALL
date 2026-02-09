"""
用户设置（按用户落库）

当前用途：
- 保存前端面板的“默认渠道”选择（账户管理 / 消耗日志）

说明：
- 仅存 UI 偏好，不涉及敏感信息
- 每个 user 一条记录（user_id 唯一）
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class UserSetting(Base):
    """用户设置（每个 user 一条）"""

    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联的用户ID",
    )

    accounts_default_channel: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        comment="账户管理默认渠道（antigravity/kiro/qwen/codex/gemini/zai-tts/zai-image）",
    )

    usage_default_channel: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        comment="消耗日志默认渠道（antigravity/kiro/qwen/codex/gemini-cli/zai-tts/zai-image）",
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

