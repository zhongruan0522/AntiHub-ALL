"""
Codex 账号管理 API

目标（先做最小闭环）：
- 生成登录链接（PKCE）
- 解析回调 URL 并落库
- 导入/导出账号凭证（JSON）
- 账号列表/详情/启用禁用/改名/删除
- 模型列表（本地常量）
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db_session, get_redis
from app.cache import RedisClient
from app.models.user import User
from app.schemas.codex import (
    CodexOAuthAuthorizeRequest,
    CodexOAuthCallbackRequest,
    CodexAccountImportRequest,
    CodexAccountUpdateStatusRequest,
    CodexAccountUpdateNameRequest,
    CodexAccountUpdateQuotaRequest,
    CodexAccountUpdateLimitsRequest,
    CodexAccountResponse,
)
from app.services.codex_service import CodexService


router = APIRouter(prefix="/api/codex", tags=["Codex账号管理"])


def get_codex_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis),
) -> CodexService:
    return CodexService(db, redis)


def _serialize_account(account) -> dict:
    return CodexAccountResponse.model_validate(account).model_dump(by_alias=True)


@router.get("/models", summary="获取 Codex 模型列表")
async def list_codex_models(service: CodexService = Depends(get_codex_service)):
    try:
        return await service.get_models()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取模型列表失败",
        )


@router.post("/oauth/authorize", summary="生成 Codex OAuth 登录链接")
async def codex_oauth_authorize(
    request: CodexOAuthAuthorizeRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        return await service.create_oauth_authorize_url(
            user_id=current_user.id,
            is_shared=request.is_shared,
            account_name=request.account_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="生成登录链接失败",
        )


@router.post("/oauth/callback", summary="提交 Codex OAuth 回调 URL 并落库")
async def codex_oauth_callback(
    request: CodexOAuthCallbackRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.submit_oauth_callback(
            user_id=current_user.id,
            callback_url=request.callback_url,
        )
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="处理 OAuth 回调失败",
        )


@router.post("/accounts/import", summary="导入 Codex 凭证 JSON 并落库")
async def import_codex_account(
    request: CodexAccountImportRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.import_account(
            user_id=current_user.id,
            credential_json=request.credential_json,
            is_shared=request.is_shared,
            account_name=request.account_name,
        )
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="导入账号失败",
        )


@router.get("/accounts", summary="获取 Codex 账号列表")
async def list_codex_accounts(
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.list_accounts(current_user.id)
        result["data"] = [_serialize_account(a) for a in result["data"]]
        return result
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取账号列表失败",
        )


@router.get("/accounts/active", summary="获取当前可用 Codex 账号（fill-first）")
async def get_active_codex_account(
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.select_active_account(current_user.id)
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取当前账号失败",
        )


@router.get("/accounts/{account_id}", summary="获取单个 Codex 账号详情")
async def get_codex_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.get_account(current_user.id, account_id)
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取账号详情失败",
        )


@router.get("/accounts/{account_id}/credentials", summary="导出 Codex 账号凭证（敏感）")
async def export_codex_account_credentials(
    account_id: int,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        return await service.export_account_credentials(current_user.id, account_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="导出凭证失败",
        )


@router.put("/accounts/{account_id}/status", summary="启用/禁用 Codex 账号")
async def update_codex_account_status(
    account_id: int,
    request: CodexAccountUpdateStatusRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.update_account_status(current_user.id, account_id, request.status)
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="更新账号状态失败",
        )


@router.put("/accounts/{account_id}/name", summary="更新 Codex 账号名称")
async def update_codex_account_name(
    account_id: int,
    request: CodexAccountUpdateNameRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.update_account_name(current_user.id, account_id, request.account_name)
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="更新账号名称失败",
        )


@router.put("/accounts/{account_id}/quota", summary="手动更新 Codex 账号剩余额度（落库）")
async def update_codex_account_quota(
    account_id: int,
    request: CodexAccountUpdateQuotaRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.update_account_quota(
            current_user.id,
            account_id,
            quota_remaining=request.quota_remaining,
            quota_currency=request.quota_currency,
        )
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="更新额度失败",
        )


@router.put("/accounts/{account_id}/limits", summary="手动更新 Codex 账号限额（5小时/周限）")
async def update_codex_account_limits(
    account_id: int,
    request: CodexAccountUpdateLimitsRequest,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        result = await service.update_account_limits(
            current_user.id,
            account_id,
            limit_5h_used_percent=request.limit_5h_used_percent,
            limit_5h_reset_at=request.limit_5h_reset_at,
            limit_week_used_percent=request.limit_week_used_percent,
            limit_week_reset_at=request.limit_week_reset_at,
        )
        result["data"] = _serialize_account(result["data"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="更新限额失败",
        )


@router.delete("/accounts/{account_id}", summary="删除 Codex 账号")
async def delete_codex_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    service: CodexService = Depends(get_codex_service),
):
    try:
        return await service.delete_account(current_user.id, account_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="删除账号失败",
        )
