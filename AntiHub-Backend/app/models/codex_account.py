"""
Codex 账号数据模型

说明：
- 账号归属到 User（user_id），支持同一用户保存多个 Codex 账号
- 凭证（token 等）使用加密后的 JSON 字符串存储，避免明文落库
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, TYPE_CHECKING

from sqlalchemy import String, Integer, DateTime, ForeignKey, Text, Float
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class CodexAccount(Base):
    """Codex 账号模型（落库保存 OAuth 凭证与基础信息）"""

    __tablename__ = "codex_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联的用户ID",
    )

    account_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="账号显示名称",
    )

    status: Mapped[int] = mapped_column(
        Integer,
        default=1,
        nullable=False,
        comment="账号状态：0=禁用，1=启用",
    )

    is_shared: Mapped[int] = mapped_column(
        Integer,
        default=0,
        nullable=False,
        comment="0=专属账号，1=共享账号（预留）",
    )

    email: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
        index=True,
        comment="OpenAI 账号邮箱（来自 id_token）",
    )

    openai_account_id: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
        index=True,
        comment="OpenAI ChatGPT account_id（来自 id_token）",
    )

    chatgpt_plan_type: Mapped[Optional[str]] = mapped_column(
        String(100),
        nullable=True,
        comment="ChatGPT 订阅类型（来自 id_token）",
    )

    token_expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="access_token 过期时间",
    )

    last_refresh_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后一次刷新 token 的时间",
    )

    credentials: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="加密后的凭证 JSON（包含 id_token/access_token/refresh_token 等）",
    )

    quota_remaining: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment="剩余额度（可选；当前不对外拉取，仅做落库展示）",
    )

    quota_currency: Mapped[Optional[str]] = mapped_column(
        String(16),
        nullable=True,
        comment="额度单位/币种（可选）",
    )

    quota_updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="额度更新时间（可选）",
    )

    limit_5h_used_percent: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment="5小时限额已用百分比（0-100，100表示已打满；手动维护/落库）",
    )

    limit_5h_reset_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="5小时限额重置时间（用于冻结/解冻；手动维护/落库）",
    )

    limit_week_used_percent: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment="周限额已用百分比（0-100，100表示已打满；手动维护/落库）",
    )

    limit_week_reset_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="周限额重置时间（用于冻结/解冻；手动维护/落库）",
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

    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后使用时间（预留）",
    )

    user: Mapped["User"] = relationship("User", back_populates="codex_accounts")

    @property
    def freeze_reason(self) -> Optional[str]:
        """
        冻结原因：
        - week：周限额打满（优先级最高）
        - 5h：5小时限额打满
        """
        now = datetime.now(timezone.utc)

        week_pct = self.limit_week_used_percent
        if week_pct is not None and int(week_pct) >= 100:
            if self.limit_week_reset_at is None:
                return "week"
            reset_at = self.limit_week_reset_at
            if reset_at.tzinfo is None:
                reset_at = reset_at.replace(tzinfo=timezone.utc)
            if reset_at > now:
                return "week"

        five_pct = self.limit_5h_used_percent
        if five_pct is not None and int(five_pct) >= 100:
            if self.limit_5h_reset_at is None:
                return "5h"
            reset_at = self.limit_5h_reset_at
            if reset_at.tzinfo is None:
                reset_at = reset_at.replace(tzinfo=timezone.utc)
            if reset_at > now:
                return "5h"

        return None

    @property
    def frozen_until(self) -> Optional[datetime]:
        reason = self.freeze_reason
        if reason == "week":
            return self.limit_week_reset_at
        if reason == "5h":
            return self.limit_5h_reset_at
        return None

    @property
    def is_frozen(self) -> bool:
        reason = self.freeze_reason
        if not reason:
            return False
        until = self.frozen_until
        if until is None:
            return True
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > datetime.now(timezone.utc)

    @property
    def effective_status(self) -> int:
        if int(self.status or 0) != 1:
            return 0
        return 0 if self.is_frozen else 1

    def __repr__(self) -> str:
        return f"<CodexAccount(id={self.id}, user_id={self.user_id}, email='{self.email}')>"
