"""
Antigravity 模型配额数据模型（原 AntiHub-plugin public.model_quotas）

说明：
- 以 cookie_id + model_name 唯一（对齐 plugin uk_cookie_model）
- 合并后不保留 shared pool 语义，仅作为“模型配额概览/展示/节流”的数据源
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class AntigravityModelQuota(Base):
    __tablename__ = "antigravity_model_quotas"
    __table_args__ = (
        UniqueConstraint(
            "cookie_id",
            "model_name",
            name="uq_antigravity_model_quotas_cookie_model",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    cookie_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
        comment="关联的账号 cookie_id（软关联到 antigravity_accounts.cookie_id）",
    )

    model_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="模型名称",
    )

    quota: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        server_default="0",
        comment="配额比例（0~1）",
    )

    reset_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="配额重置时间（可选）",
    )

    status: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="1",
        comment="配额状态：0=禁用，1=启用",
    )

    last_fetched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后一次拉取配额的时间（可选）",
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

    def __repr__(self) -> str:
        return f"<AntigravityModelQuota(id={self.id}, cookie_id='{self.cookie_id}', model_name='{self.model_name}')>"
