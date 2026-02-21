"""
Kiro AWS IdC / Builder ID（设备码登录 + 本地凭据导入）API

目标：
- 与现有 Kiro OAuth（Google/Github）完全分离：不复用 /api/kiro/oauth/* 的语义
- 与现有 Kiro Token 导入完全分离：不复用 /api/tokens/*
- 两套方案都只做“后端落地 + 预留前端 API”，前端按本文档对接即可
"""

from __future__ import annotations

import base64
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db_session, get_redis
from app.cache import RedisClient
from app.models.user import User
from app.schemas.kiro_aws_idc import (
    KiroAwsIdcDeviceAuthorizeRequest,
    KiroAwsIdcImportRequest,
)
from app.services.kiro_service import KiroService, UpstreamAPIError

router = APIRouter(prefix="/api/kiro/aws-idc", tags=["Kiro AWS IdC / Builder ID"])

# ======== 常量：来自 docs/kiro-aws-idc-auth.md 的参考实现 ========

DEFAULT_AWS_REGION = "us-east-1"
AWS_BUILDER_ID_START_URL = "https://view.awsapps.com/start"
AWS_GRANT_TYPE_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code"

AWS_OIDC_SCOPES = [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
    "codewhisperer:transformations",
    "codewhisperer:taskassist",
]

KIRO_AWS_IDC_STATE_KEY_PREFIX = "kiro:aws_idc:device:"


_AWS_REGION_RE = re.compile(r"^[a-z]{2}(?:-[a-z]+)+-\d+$")


def _normalize_aws_region(value: Any) -> str:
    """
    规范化 AWS region（例如 us-east-1）。

    注意：region 会被拼到 hostname 里，必须做严格校验，避免出现 @ / . 等字符导致 URL 解析异常或被注入。
    """

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


def _aws_oidc_base_url(region: str) -> str:
    return f"https://oidc.{region}.amazonaws.com"


def _redis_key(state: str) -> str:
    return f"{KIRO_AWS_IDC_STATE_KEY_PREFIX}{state}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_iso8601(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _get_first_value(data: Dict[str, Any], keys: list[str]) -> Optional[str]:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _merge_json_files(json_files: list[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    for item in json_files:
        if not isinstance(item, dict):
            raise ValueError("json_files 必须是 JSON 对象数组")
        merged.update(item)  # 后者覆盖前者，等价于 JS Object.assign
    return merged


def _decode_base64url(value: str) -> Optional[bytes]:
    if not isinstance(value, str):
        return None
    normalized = value.replace("-", "+").replace("_", "/")
    pad_len = (4 - (len(normalized) % 4)) % 4
    try:
        return base64.b64decode(normalized + ("=" * pad_len))
    except Exception:
        return None


def _try_decode_jwt_payload(token: str) -> Optional[Dict[str, Any]]:
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload_bytes = _decode_base64url(parts[1])
    if not payload_bytes:
        return None
    try:
        import json

        return json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        return None


def _extract_userid_from_access_token(access_token: Optional[str]) -> Optional[str]:
    payload = _try_decode_jwt_payload(access_token or "")
    if not payload:
        return None
    for key in ("userId", "userid", "user_id", "sub"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
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


# ==================== 方案 A：导入本地凭据（token.json + client.json） ====================


@router.post(
    "/import",
    summary="导入 Kiro Builder ID（IdC）本地凭据",
    description="前端读取本地 token/client 两份 JSON 后提交，后端解析并落库为 IdC 账号（不混用现有 Kiro OAuth / Kiro Token 导入）。",
)
async def import_kiro_aws_idc_credentials(
    request: KiroAwsIdcImportRequest,
    current_user: User = Depends(get_current_user),
    service: KiroService = Depends(get_kiro_service),
):
    try:
        if not request.json_files:
            raise ValueError("json_files 不能为空")

        is_shared = _validate_is_shared(request.is_shared)

        merged = _merge_json_files(request.json_files)

        refresh_token = _get_first_value(merged, ["refresh_token", "refreshToken"])
        client_id = _get_first_value(merged, ["client_id", "clientId"])
        client_secret = _get_first_value(merged, ["client_secret", "clientSecret"])
        region_from_files = _get_first_value(merged, ["region", "aws_region", "awsRegion"])
        region = _normalize_aws_region(request.region or region_from_files)

        if not refresh_token:
            raise ValueError("缺少 refreshToken / refresh_token")
        if not client_id:
            raise ValueError("缺少 clientId / client_id")
        if not client_secret:
            raise ValueError("缺少 clientSecret / client_secret")

        machineid = _get_first_value(merged, ["machineid", "machineId"]) or secrets.token_hex(32)
        access_token = _get_first_value(merged, ["access_token", "accessToken"])

        userid = (
            _get_first_value(merged, ["userid", "userId", "user_id"])
            or _extract_userid_from_access_token(access_token)
        )

        account_data: Dict[str, Any] = {
            "account_name": request.account_name or "Kiro Builder ID",
            "auth_method": "IdC",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "machineid": machineid,
            "region": region,
            "is_shared": is_shared,
        }
        if userid:
            account_data["userid"] = userid

        return await service.create_account(current_user.id, account_data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except UpstreamAPIError as e:
        # 透传 plug-in 的错误文本，便于前端显示
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.extracted_message, "type": "api_error"},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"导入 Kiro AWS IdC 凭据失败: {str(e)}",
        )


# ==================== 方案 B：Builder ID 设备码登录（Device Authorization Flow） ====================


@router.post(
    "/device/authorize",
    summary="发起 Builder ID 设备码登录",
    description="后端向 AWS SSO OIDC 发起 device_authorization，前端展示 verificationUriComplete/userCode 给用户授权。",
)
async def start_kiro_builder_id_device_flow(
    request: KiroAwsIdcDeviceAuthorizeRequest,
    current_user: User = Depends(get_current_user),
    redis: RedisClient = Depends(get_redis),
):
    try:
        is_shared = _validate_is_shared(request.is_shared)
        region = _normalize_aws_region(request.region)
        aws_oidc_base_url = _aws_oidc_base_url(region)
        state = uuid.uuid4().hex
        machineid = secrets.token_hex(32)

        headers = {"Content-Type": "application/json", "User-Agent": "KiroIDE"}
        timeout = httpx.Timeout(15.0, connect=5.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            # 1) Register OIDC client
            reg_resp = await client.post(
                f"{aws_oidc_base_url}/client/register",
                json={
                    "clientName": "Kiro IDE",
                    "clientType": "public",
                    "scopes": AWS_OIDC_SCOPES,
                    "grantTypes": [AWS_GRANT_TYPE_DEVICE_CODE, "refresh_token"],
                    "issuerUrl": AWS_BUILDER_ID_START_URL,
                },
                headers=headers,
            )
            reg_data = reg_resp.json() if reg_resp.content else {}
            if reg_resp.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail={
                        "message": "AWS OIDC client/register 失败",
                        "upstream_status": reg_resp.status_code,
                        "upstream_response": reg_data or reg_resp.text,
                    },
                )

            client_id = reg_data.get("clientId")
            client_secret = reg_data.get("clientSecret")
            if not client_id or not client_secret:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="AWS OIDC 注册返回缺少 clientId/clientSecret",
                )

            # 2) Start device authorization
            auth_resp = await client.post(
                f"{aws_oidc_base_url}/device_authorization",
                json={
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "startUrl": AWS_BUILDER_ID_START_URL,
                },
                headers=headers,
            )
            auth_data = auth_resp.json() if auth_resp.content else {}
            if auth_resp.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail={
                        "message": "AWS OIDC device_authorization 失败",
                        "upstream_status": auth_resp.status_code,
                        "upstream_response": auth_data or auth_resp.text,
                    },
                )

        device_code = auth_data.get("deviceCode")
        user_code = auth_data.get("userCode")
        verification_uri = auth_data.get("verificationUri")
        verification_uri_complete = auth_data.get("verificationUriComplete")
        expires_in = int(auth_data.get("expiresIn") or 0)
        interval = int(auth_data.get("interval") or 5)

        if not device_code or not user_code or not verification_uri_complete:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="AWS OIDC 返回缺少 deviceCode/userCode/verificationUriComplete",
            )

        now_ms = _now_ms()
        expires_at_ms = now_ms + max(0, expires_in) * 1000
        next_poll_at_ms = now_ms + max(1, interval) * 1000
        ttl_seconds = max(60, min(expires_in + 60, 3600)) if expires_in else 900

        await redis.set_json(
            _redis_key(state),
            {
                "status": "pending",
                "user_id": current_user.id,
                "account_name": request.account_name or "Kiro Builder ID",
                "is_shared": is_shared,
                "machineid": machineid,
                "region": region,
                "created_at_ms": now_ms,
                "expires_at_ms": expires_at_ms,
                "next_poll_at_ms": next_poll_at_ms,
                "interval": max(1, interval),
                # ===== 敏感字段：只存 Redis 的短 TTL，不回传给前端 =====
                "client_id": client_id,
                "client_secret": client_secret,
                "device_code": device_code,
            },
            expire=ttl_seconds,
        )

        return {
            "success": True,
            "status": "pending",
            "data": {
                "state": state,
                "user_code": user_code,
                "verification_uri": verification_uri,
                "verification_uri_complete": verification_uri_complete,
                "expires_in": expires_in,
                "interval": max(1, interval),
                "expires_at": _to_iso8601(expires_at_ms) if expires_in else None,
            },
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"发起 Builder ID 设备码登录失败: {str(e)}",
        )


@router.get(
    "/device/status/{state}",
    summary="轮询 Builder ID 设备码登录状态",
    description="前端轮询此接口；后端按 interval 控制与 AWS OIDC 的交互频率，成功后自动落库为 IdC 账号。",
)
async def get_kiro_builder_id_device_status(
    state: str,
    current_user: User = Depends(get_current_user),
    redis: RedisClient = Depends(get_redis),
    service: KiroService = Depends(get_kiro_service),
):
    try:
        if not state or not state.strip():
            raise ValueError("state 不能为空")
        state = state.strip()

        key = _redis_key(state)
        info = await redis.get_json(key)
        if not info:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"status": "expired", "error": "无效或已过期的 state"},
            )

        if info.get("user_id") != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="无权访问该 state",
            )

        current_status = info.get("status") or "pending"
        if current_status == "completed":
            return {"success": True, "status": "completed", "data": info.get("account")}
        if current_status == "error":
            return {
                "success": False,
                "status": "error",
                "error": info.get("error") or "登录失败",
            }

        now_ms = _now_ms()
        expires_at_ms = int(info.get("expires_at_ms") or 0)
        if expires_at_ms and now_ms >= expires_at_ms:
            await redis.delete(key)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"status": "expired", "error": "授权已超时"},
            )

        next_poll_at_ms = int(info.get("next_poll_at_ms") or 0)
        if next_poll_at_ms and now_ms < next_poll_at_ms:
            return {
                "success": True,
                "status": "pending",
                "retry_after_ms": next_poll_at_ms - now_ms,
                "message": "等待用户完成授权",
            }

        client_id = info.get("client_id")
        client_secret = info.get("client_secret")
        device_code = info.get("device_code")
        region = _normalize_aws_region(info.get("region"))
        aws_oidc_base_url = _aws_oidc_base_url(region)
        if not client_id or not client_secret or not device_code:
            await redis.set_json(
                key,
                {**info, "status": "error", "error": "state 数据不完整（缺少 client 或 deviceCode）"},
                expire=600,
            )
            return {
                "success": False,
                "status": "error",
                "error": "state 数据不完整（缺少 client 或 deviceCode）",
            }

        headers = {"Content-Type": "application/json", "User-Agent": "KiroIDE"}
        timeout = httpx.Timeout(15.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            token_resp = await client.post(
                f"{aws_oidc_base_url}/token",
                json={
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "deviceCode": device_code,
                    "grantType": AWS_GRANT_TYPE_DEVICE_CODE,
                },
                headers=headers,
            )
            token_data = token_resp.json() if token_resp.content else {}

        # 成功：拿到 token，立即落库（不把 token 回传给前端）
        if token_resp.status_code == 200 and token_data.get("accessToken"):
            refresh_token = token_data.get("refreshToken")
            expires_in = int(token_data.get("expiresIn") or 0)

            if not refresh_token:
                await redis.set_json(
                    key,
                    {**info, "status": "error", "error": "AWS token 返回缺少 refreshToken"},
                    expire=600,
                )
                return {
                    "success": False,
                    "status": "error",
                    "error": "AWS token 返回缺少 refreshToken",
                }

            userid = _extract_userid_from_access_token(token_data.get("accessToken"))

            account_payload: Dict[str, Any] = {
                "account_name": info.get("account_name") or "Kiro Builder ID",
                "auth_method": "IdC",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
                "machineid": info.get("machineid") or secrets.token_hex(32),
                "region": region,
                "is_shared": int(info.get("is_shared") or 0),
            }
            if userid:
                account_payload["userid"] = userid

            try:
                result = await service.create_account(current_user.id, account_payload)
            except UpstreamAPIError as e:
                await redis.set_json(
                    key,
                    {**info, "status": "error", "error": e.extracted_message},
                    expire=600,
                )
                return JSONResponse(
                    status_code=e.status_code,
                    content={"success": False, "status": "error", "error": e.extracted_message},
                )

            # 用更长一点的 TTL 留给前端“最后一次拉取结果”
            safe_state = {
                "status": "completed",
                "user_id": info.get("user_id"),
                "account_name": info.get("account_name"),
                "is_shared": info.get("is_shared"),
                "created_at_ms": info.get("created_at_ms"),
                "completed_at_ms": now_ms,
                "expires_at_ms": now_ms + max(60, expires_in) * 1000 if expires_in else None,
                "account": (result or {}).get("data") if isinstance(result, dict) else None,
            }
            await redis.set_json(key, safe_state, expire=900)
            return {"success": True, "status": "completed", "data": safe_state.get("account")}

        # 失败：按 RFC 8628 / AWS 约定处理错误
        error_code = token_data.get("error")
        interval = int(info.get("interval") or 5)
        if error_code == "authorization_pending":
            next_poll_at_ms = now_ms + max(1, interval) * 1000
            await redis.set_json(key, {**info, "next_poll_at_ms": next_poll_at_ms}, expire=900)
            return {
                "success": True,
                "status": "pending",
                "retry_after_ms": next_poll_at_ms - now_ms,
                "message": "等待用户完成授权",
            }
        if error_code == "slow_down":
            interval = interval + 5
            next_poll_at_ms = now_ms + max(1, interval) * 1000
            await redis.set_json(
                key,
                {**info, "interval": interval, "next_poll_at_ms": next_poll_at_ms},
                expire=900,
            )
            return {
                "success": True,
                "status": "pending",
                "retry_after_ms": next_poll_at_ms - now_ms,
                "message": "AWS 要求降低轮询频率",
            }

        upstream_detail = token_data.get("error_description") or error_code or "未知错误"
        await redis.set_json(
            key,
            {**info, "status": "error", "error": f"AWS token 失败: {upstream_detail}"},
            expire=600,
        )
        return {
            "success": False,
            "status": "error",
            "error": f"AWS token 失败: {upstream_detail}",
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"查询 Builder ID 登录状态失败: {str(e)}",
        )

