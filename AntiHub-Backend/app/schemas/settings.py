"""
设置相关 Schema
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class UiDefaultChannelsUpsertRequest(BaseModel):
    """保存/更新前端面板的默认渠道设置"""

    accounts_default_channel: Optional[str] = Field(None, description="账户管理默认渠道")
    usage_default_channel: Optional[str] = Field(None, description="消耗日志默认渠道")


class UiDefaultChannelsData(BaseModel):
    """读取用：返回已保存的默认渠道设置"""

    accounts_default_channel: Optional[str] = Field(None, description="账户管理默认渠道")
    usage_default_channel: Optional[str] = Field(None, description="消耗日志默认渠道")

