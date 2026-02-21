"""
Kiro 企业账户（Enterprise Account）相关的请求模型

注意：
- 企业账户使用与 IdC 相同的 OIDC Token 刷新机制，但通过 credentials 中的
  provider="Enterprise" 字段与 Builder ID 区分。
- 支持单个导入和批量导入两种方式。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class KiroEnterpriseImportRequest(BaseModel):
    """
    单个企业账户导入请求

    前端通过手动填写表单或 JSON 导入提交凭据。
    """

    refresh_token: str = Field(
        ..., alias="refreshToken", description="OIDC refresh token"
    )
    client_id: str = Field(
        ..., alias="clientId", description="OIDC client ID"
    )
    client_secret: str = Field(
        ..., alias="clientSecret", description="OIDC client secret"
    )
    region: Optional[str] = Field(
        "us-east-1", description="AWS 区域ID（例如 us-east-1），不传则默认 us-east-1"
    )
    auth_region: Optional[str] = Field(
        None,
        alias="authRegion",
        description="Auth Region（用于 OIDC Token 刷新）；未指定时回退到 region。",
    )
    api_region: Optional[str] = Field(
        None,
        alias="apiRegion",
        description="API Region（用于 q.* / codewhisperer.* API 请求）；未指定时 IdC 默认 us-east-1。",
    )
    account_name: Optional[str] = Field(
        None, alias="accountName", description="账号显示名称（可选，不传则后端使用默认值）"
    )
    is_shared: int = Field(0, alias="isShared", description="0=私有账号，1=共享账号")

    model_config = {"populate_by_name": True}


class KiroEnterpriseBatchImportRequest(BaseModel):
    """
    批量企业账户导入请求

    accounts 列表中的每个对象支持 camelCase 和 snake_case 两种字段命名风格。
    """

    accounts: List[Dict[str, Any]] = Field(
        ...,
        description="企业账户凭据列表，每个对象包含 refresh_token/refreshToken、client_id/clientId、client_secret/clientSecret 等字段",
    )
    region: Optional[str] = Field(
        "us-east-1", description="全局默认 AWS 区域ID，单个账户未指定时使用此值"
    )
    auth_region: Optional[str] = Field(
        None,
        alias="authRegion",
        description="全局默认 Auth Region（用于 Token 刷新）；单个账户未指定时使用此值。",
    )
    api_region: Optional[str] = Field(
        None,
        alias="apiRegion",
        description="全局默认 API Region（用于 API 请求）；单个账户未指定时使用此值。",
    )
    is_shared: int = Field(0, description="0=私有账号，1=共享账号")

    model_config = {"populate_by_name": True}
