"""
Kiro 企业账户（Enterprise Account）导入 API

企业账户使用与 IdC 相同的 OIDC Token 刷新机制，但通过 credentials 中的
provider="Enterprise" 字段与 Builder ID 区分。

路由：
- POST /api/kiro/enterprise/import — 单个企业账户导入
- POST /api/kiro/enterprise/batch-import — 批量企业账户导入
"""

from __future__ import annotations

import base64
import re
import secrets
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db_session, get_redis
from app.cache import RedisClient
from app.models.user import User
from app.schemas.kiro_enterprise import (
    KiroEnterpriseBatchImportRequest,
    KiroEnterpriseImportRequest,
)
from app.services.kiro_service import KiroService, UpstreamAPIError

router = APIRouter(prefix="/api/kiro/enterprise", tags=["Kiro Enterprise Account"])

# ======== 常量 ========

DEFAULT_AWS_REGION = "us-east-1"

_AWS_REGION_RE = re.compile(r"^[a-z]{2}(?:-[a-z]+)+-\d+$")
_AWS_REGION_SEARCH_RE = re.compile(r"[a-z]{2}(?:-[a-z]+)+-\d+")


# ======== 工具函数 ========


def _normalize_aws_region(value: Any) -> str:
    """规范化 AWS region（例如 us-east-1）。"""
    if value is None:
        return DEFAULT_AWS_REGION
    if not isinstance(value, str):
        raise ValueError("region 必须是字符串（例如 us-east-1）")
    region = value.strip().lower()
    if not region:
        return DEFAULT_AWS_REGION
    if not _AWS_REGION_RE.fullmatch(region):
        raise ValueError("region 格式不正确（例如 us-east-1 / ap-southeast-2）")
    return region


def _get_first_value(data: Dict[str, Any], keys: list[str]) -> Optional[str]:
    """从 dict 中按优先级取第一个非空字符串值（支持 camelCase/snake_case）。"""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _decode_base64url(value: str) -> Optional[bytes]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().replace("-", "+").replace("_", "/")
    if not normalized:
        return None
    pad_len = (4 - (len(normalized) % 4)) % 4
    try:
        return base64.b64decode(normalized + ("=" * pad_len))
    except Exception:
        return None


def _infer_auth_region_from_client_id(client_id: Optional[str]) -> Optional[str]:
    """
    Some exports omit region/authRegion, but AWS SSO OIDC clientId often embeds the auth region
    (e.g. "eu-north-1") in its base64url payload. This helper attempts to infer it.
    """

    if not client_id:
        return None
    decoded = _decode_base64url(client_id)
    if not decoded:
        return None

    text = decoded.decode("ascii", errors="ignore").lower()
    candidates = _AWS_REGION_SEARCH_RE.findall(text)
    for candidate in reversed(candidates):
        candidate = candidate.strip()
        if _AWS_REGION_RE.fullmatch(candidate):
            return candidate
    return None


def get_kiro_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis),
) -> KiroService:
    return KiroService(db, redis)


def _validate_is_shared(is_shared: Any) -> int:
    if isinstance(is_shared, bool):
        is_shared = 1 if is_shared else 0
    try:
        is_shared_int = int(is_shared)
    except Exception:
        raise ValueError("is_shared 必须是 0 或 1")
    if is_shared_int not in (0, 1):
        raise ValueError("is_shared 必须是 0 或 1")
    return is_shared_int


def parse_enterprise_credentials(data: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """
    从 dict 中解析企业账户凭据，支持 camelCase 和 snake_case 字段名。

    返回包含 refresh_token, client_id, client_secret, region 的 dict。
    """
    return {
        "refresh_token": _get_first_value(data, ["refresh_token", "refreshToken"]),
        "client_id": _get_first_value(data, ["client_id", "clientId"]),
        "client_secret": _get_first_value(data, ["client_secret", "clientSecret"]),
        "region": _get_first_value(data, ["region", "aws_region", "awsRegion"]),
    }


def validate_required_credentials(creds: Dict[str, Optional[str]]) -> None:
    """校验必填字段，缺失时抛出 ValueError。"""
    if not creds.get("refresh_token"):
        raise ValueError("missing refresh_token")
    if not creds.get("client_id"):
        raise ValueError("missing client_id")
    if not creds.get("client_secret"):
        raise ValueError("missing client_secret")


# ==================== 单个企业账户导入 ====================


@router.post(
    "/import",
    summary="导入单个 Kiro 企业账户凭据",
    description="提交企业账户的 OIDC 凭据（refreshToken、clientId、clientSecret、region），"
    "后端解析并落库为 Enterprise 账号（auth_method=IdC, provider=Enterprise）。",
)
async def import_kiro_enterprise_credentials(
    request: KiroEnterpriseImportRequest,
    current_user: User = Depends(get_current_user),
    service: KiroService = Depends(get_kiro_service),
):
    try:
        is_shared = _validate_is_shared(request.is_shared)

        # 支持 camelCase/snake_case：将 request 转为 dict 后统一解析
        request_data = request.model_dump()
        creds = parse_enterprise_credentials(request_data)

        # 校验必填字段
        validate_required_credentials(creds)

        region = _normalize_aws_region(creds["region"] or request.region)

        auth_region: Optional[str] = None
        if request.auth_region:
            auth_region = _normalize_aws_region(request.auth_region)

        api_region: Optional[str] = None
        if request.api_region:
            api_region = _normalize_aws_region(request.api_region)

        # Heuristic: if region/auth_region is missing and we are still at the default,
        # try to infer the true auth region from client_id (common for AWS IdC exports).
        if not auth_region and region == DEFAULT_AWS_REGION:
            inferred = _infer_auth_region_from_client_id(creds.get("client_id"))
            if inferred and inferred != DEFAULT_AWS_REGION:
                auth_region = inferred

        # auth_region is used for OIDC token refresh endpoints.
        effective_region = auth_region or region

        machineid = secrets.token_hex(32)

        account_data: Dict[str, Any] = {
            "account_name": request.account_name or "Kiro Enterprise",
            "auth_method": "IdC",
            "provider": "Enterprise",
            "refresh_token": creds["refresh_token"],
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "machineid": machineid,
            "region": effective_region,
            "is_shared": is_shared,
        }
        if auth_region:
            account_data["auth_region"] = auth_region
        if api_region:
            account_data["api_region"] = api_region

        return await service.create_account(current_user.id, account_data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except UpstreamAPIError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.extracted_message, "type": "api_error"},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"导入 Kiro 企业账户凭据失败: {str(e)}",
        )


# ==================== 批量企业账户导入 ====================


@router.post(
    "/batch-import",
    summary="批量导入 Kiro 企业账户凭据",
    description="提交包含多个企业账户凭据的 JSON 数组，逐个处理并返回每个账户的导入结果。"
    "每个账户对象支持 camelCase 和 snake_case 两种字段命名风格。",
)
async def batch_import_kiro_enterprise_credentials(
    request: KiroEnterpriseBatchImportRequest,
    current_user: User = Depends(get_current_user),
    service: KiroService = Depends(get_kiro_service),
):
    try:
        is_shared = _validate_is_shared(request.is_shared)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    results = []

    for index, account_raw in enumerate(request.accounts):
        try:
            creds = parse_enterprise_credentials(account_raw)
            validate_required_credentials(creds)

            region = _normalize_aws_region(creds["region"] or request.region)

            auth_region_raw = _get_first_value(
                account_raw, ["auth_region", "authRegion", "sso_region", "ssoRegion", "oidc_region", "oidcRegion"]
            )
            if not auth_region_raw and request.auth_region:
                auth_region_raw = request.auth_region

            api_region_raw = _get_first_value(account_raw, ["api_region", "apiRegion"])
            if not api_region_raw and request.api_region:
                api_region_raw = request.api_region

            auth_region: Optional[str] = None
            if auth_region_raw:
                auth_region = _normalize_aws_region(auth_region_raw)

            api_region: Optional[str] = None
            if api_region_raw:
                api_region = _normalize_aws_region(api_region_raw)

            if not auth_region and region == DEFAULT_AWS_REGION:
                inferred = _infer_auth_region_from_client_id(creds.get("client_id"))
                if inferred and inferred != DEFAULT_AWS_REGION:
                    auth_region = inferred

            effective_region = auth_region or region
            machineid = secrets.token_hex(32)

            account_name = (
                _get_first_value(account_raw, ["account_name", "accountName"])
                or "Kiro Enterprise"
            )

            account_data: Dict[str, Any] = {
                "account_name": account_name,
                "auth_method": "IdC",
                "provider": "Enterprise",
                "refresh_token": creds["refresh_token"],
                "client_id": creds["client_id"],
                "client_secret": creds["client_secret"],
                "machineid": machineid,
                "region": effective_region,
                "is_shared": is_shared,
            }
            if auth_region:
                account_data["auth_region"] = auth_region
            if api_region:
                account_data["api_region"] = api_region

            data = await service.create_account(current_user.id, account_data)
            results.append({"index": index, "success": True, "data": data})

        except ValueError as e:
            results.append({"index": index, "success": False, "error": str(e)})
        except UpstreamAPIError as e:
            results.append({"index": index, "success": False, "error": e.extracted_message})
        except Exception as e:
            results.append({"index": index, "success": False, "error": str(e)})

    return {"results": results}
