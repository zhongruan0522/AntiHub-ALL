"""
Codex 账号相关的 Pydantic Schema

说明：
- 这里的接口由 AntiHub-Backend 直接落库（PostgreSQL），不依赖 plug-in
- 凭证导入/导出使用 JSON 字符串（兼容 CLIProxyAPI 的 codex-*.json 格式）
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class CodexOAuthAuthorizeRequest(BaseModel):
    """生成 Codex OAuth 登录链接"""

    is_shared: int = Field(0, description="0=专属账号，1=共享账号（预留）")
    account_name: Optional[str] = Field(None, description="账号显示名称（可选）")


class CodexOAuthAuthorizeData(BaseModel):
    auth_url: str = Field(..., description="OAuth 授权 URL")
    state: str = Field(..., description="OAuth state，用于回调校验")
    expires_in: int = Field(..., description="state 有效期（秒）")


class CodexOAuthCallbackRequest(BaseModel):
    """提交 Codex OAuth 回调 URL（手动粘贴）"""

    callback_url: str = Field(..., description="完整的回调 URL（包含 code/state）")


class CodexAccountImportRequest(BaseModel):
    """导入 Codex 账号凭证 JSON"""

    credential_json: str = Field(..., description="Codex 凭证 JSON（兼容 CLIProxyAPI 的 codex-*.json）")
    is_shared: int = Field(0, description="0=专属账号，1=共享账号（预留）")
    account_name: Optional[str] = Field(None, description="账号显示名称（可选）")


class CodexAccountUpdateStatusRequest(BaseModel):
    status: int = Field(..., description="0=禁用，1=启用")


class CodexAccountUpdateNameRequest(BaseModel):
    account_name: str = Field(..., description="账号显示名称")


class CodexAccountUpdateQuotaRequest(BaseModel):
    quota_remaining: Optional[float] = Field(None, description="剩余额度（可选）")
    quota_currency: Optional[str] = Field(None, description="额度单位/币种（可选）")


class CodexAccountUpdateLimitsRequest(BaseModel):
    """手动维护账号限额（用于冻结/解冻 + 前端展示）"""

    limit_5h_used_percent: Optional[int] = Field(None, description="5小时限额已用百分比（0-100）")
    limit_5h_reset_at: Optional[datetime] = Field(None, description="5小时限额重置时间（ISO8601，可选）")
    limit_week_used_percent: Optional[int] = Field(None, description="周限额已用百分比（0-100）")
    limit_week_reset_at: Optional[datetime] = Field(None, description="周限额重置时间（ISO8601，可选）")


class CodexAccountResponse(BaseModel):
    account_id: int = Field(..., alias="id")
    user_id: int
    account_name: str
    status: int
    is_shared: int
    email: Optional[str] = None
    openai_account_id: Optional[str] = None
    chatgpt_plan_type: Optional[str] = None
    token_expires_at: Optional[datetime] = None
    last_refresh_at: Optional[datetime] = None
    quota_remaining: Optional[float] = None
    quota_currency: Optional[str] = None
    quota_updated_at: Optional[datetime] = None
    consumed_input_tokens: int = 0
    consumed_output_tokens: int = 0
    consumed_cached_tokens: int = 0
    consumed_total_tokens: int = 0
    limit_5h_used_percent: Optional[int] = None
    limit_5h_reset_at: Optional[datetime] = None
    limit_week_used_percent: Optional[int] = None
    limit_week_reset_at: Optional[datetime] = None
    freeze_reason: Optional[str] = None
    frozen_until: Optional[datetime] = None
    is_frozen: bool = False
    effective_status: int = 1
    created_at: datetime
    updated_at: datetime
    last_used_at: Optional[datetime] = None

    model_config = {"from_attributes": True, "populate_by_name": True}


class CodexAPIResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    data: Optional[Any] = None


class CodexAccountListResponse(BaseModel):
    success: bool = True
    data: List[CodexAccountResponse]


class CodexAccountCredentialsResponse(BaseModel):
    success: bool = True
    data: Dict[str, Any]


class CodexFallbackConfigUpsertRequest(BaseModel):
    """保存/更新 CodexCLI 兜底服务配置"""

    base_url: str = Field(..., description="兜底上游基础URL（例如 https://api.openai.com/v1）")
    api_key: Optional[str] = Field(None, description="兜底上游KEY（可留空：不修改）")


class CodexFallbackConfigData(BaseModel):
    """读取用：不返回明文 KEY"""

    platform: str = Field("CodexCLI", description="平台")
    base_url: Optional[str] = Field(None, description="兜底上游基础URL")
    has_key: bool = Field(False, description="是否已保存KEY")
    api_key_masked: Optional[str] = Field(None, description="脱敏后的KEY（可选）")
