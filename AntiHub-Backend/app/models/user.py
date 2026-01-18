"""
用户数据模型
"""
from datetime import datetime
from typing import Optional, TYPE_CHECKING
from sqlalchemy import String, Integer, Boolean, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.oauth_token import OAuthToken
    from app.models.plugin_api_key import PluginAPIKey
    from app.models.api_key import APIKey
    from app.models.codex_account import CodexAccount


class User(Base):
    """
    用户模型
    支持传统用户名密码登录（保留历史 OAuth 字段以兼容旧数据）
    """
    __tablename__ = "users"
    
    # 主键
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    
    # 用户名（唯一）
    username: Mapped[str] = mapped_column(
        String(255),
        unique=True,
        nullable=False,
        index=True,
        comment="用户名"
    )
    
    # 密码哈希（历史 SSO 用户可为空）
    password_hash: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True,
        comment="密码哈希值"
    )
    
    # OAuth ID（OAuth 提供商的用户 ID，唯一）
    oauth_id: Mapped[Optional[str]] = mapped_column(
        String(255),
        unique=True,
        nullable=True,
        index=True,
        comment="OAuth 提供商的用户 ID"
    )
    
    # 头像 URL
    avatar_url: Mapped[Optional[str]] = mapped_column(
        String(512),
        nullable=True,
        comment="用户头像 URL"
    )
    
    # 信任等级
    trust_level: Mapped[int] = mapped_column(
        Integer,
        default=0,
        nullable=False,
        comment="用户信任等级"
    )
    
    # 账号状态
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        nullable=False,
        comment="账号是否激活"
    )
    
    # 是否被禁言
    is_silenced: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        comment="是否被禁言"
    )
    
    # 是否加入beta计划
    beta: Mapped[int] = mapped_column(
        Integer,
        default=0,
        nullable=False,
        comment="是否加入beta计划"
    )
    
    # 时间戳
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        comment="创建时间"
    )
    
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
        comment="更新时间"
    )
    
    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="最后登录时间"
    )
    
    # 关系定义
    oauth_token: Mapped[Optional["OAuthToken"]] = relationship(
        "OAuthToken",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan"
    )
    
    plugin_api_key: Mapped[Optional["PluginAPIKey"]] = relationship(
        "PluginAPIKey",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan"
    )
    
    api_keys: Mapped[list["APIKey"]] = relationship(
        "APIKey",
        back_populates="user",
        cascade="all, delete-orphan"
    )

    codex_accounts: Mapped[list["CodexAccount"]] = relationship(
        "CodexAccount",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    
    # 索引定义
    __table_args__ = (
        Index("ix_users_username", "username"),
        Index("ix_users_oauth_id", "oauth_id"),
    )
    
    def __repr__(self) -> str:
        return f"<User(id={self.id}, username='{self.username}', oauth_id='{self.oauth_id}')>"
