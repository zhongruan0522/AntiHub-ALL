"""
UsageCounter 模型

用于在「usage_logs 仅保留最近 N 条」的前提下，仍然能展示累计消耗数据。

说明：
- usage_logs：用于展示最近请求日志（滑动窗口）
- usage_counters：用于累计统计（不做裁剪）
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base


class UsageCounter(Base):
    __tablename__ = "usage_counters"
    __table_args__ = (
        UniqueConstraint("user_id", "config_type", name="uq_usage_counters_user_config_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    config_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        index=True,
        comment="antigravity/kiro/qwen/codex/gemini-cli/zai-tts/zai-image/unknown",
    )

    total_requests: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计请求数（包含失败）",
    )
    success_requests: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计成功请求数",
    )
    failed_requests: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计失败请求数",
    )

    input_tokens: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计输入 tokens（与 usage_logs.input_tokens 一致，可能包含缓存部分）",
    )
    cached_tokens: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计缓存 tokens（input_tokens 的子集）",
    )
    output_tokens: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计输出 tokens",
    )
    total_tokens: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计 tokens（一般为 input + output）",
    )

    total_quota_consumed: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        server_default="0",
        comment="累计消耗额度（兼容 image 等非 token 计费场景）",
    )

    total_duration_ms: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default="0",
        comment="累计耗时（ms），用于计算平均耗时",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user = relationship("User", backref="usage_counters")

