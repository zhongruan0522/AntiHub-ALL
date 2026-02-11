"""
Plug-in API相关的路由
提供用户管理plug-in API密钥和代理请求的端点
"""
from typing import Optional
import time
from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from fastapi.responses import StreamingResponse
import httpx

from app.api.deps import get_current_user, get_user_from_api_key, get_plugin_api_service
from app.api.deps_flexible import get_user_flexible
from app.models.user import User
from app.services.plugin_api_service import PluginAPIService
from app.services.usage_log_service import UsageLogService, SSEUsageTracker, extract_openai_usage
from app.schemas.plugin_api import (
    PluginAPIKeyCreate,
    PluginAPIKeyResponse,
    CreatePluginUserRequest,
    CreatePluginUserResponse,
    OAuthAuthorizeRequest,
    OAuthCallbackRequest,
    ImportAccountRequest,
    UpdateCookiePreferenceRequest,
    UpdateAccountStatusRequest,
    UpdateAccountNameRequest,
    UpdateAccountProjectIdRequest,
    UpdateAccountTypeRequest,
    ChatCompletionRequest,
    PluginAPIResponse,
    GenerateContentRequest,
)


router = APIRouter(prefix="/plugin-api", tags=["Plug-in API"])


# ==================== 密钥管理 ====================
# 注意：用户注册时会自动创建plug-in-api账号，无需手动保存密钥

@router.get(
    "/key",
    response_model=PluginAPIKeyResponse,
    summary="获取plug-in API密钥信息",
    description="获取用户的plug-in API密钥信息（不返回实际密钥）"
)
async def get_api_key_info(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取用户的plug-in API密钥信息"""
    try:
        key_record = await service.repo.get_by_user_id(current_user.id)
        if not key_record:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="未找到API密钥"
            )
        return PluginAPIKeyResponse.model_validate(key_record)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取API密钥信息失败"
        )


# ==================== OAuth相关 ====================

@router.post(
    "/oauth/authorize",
    summary="获取OAuth授权URL",
    description="获取plug-in-api的OAuth授权URL"
)
async def get_oauth_authorize_url(
    request: OAuthAuthorizeRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取OAuth授权URL"""
    try:
        
        result = await service.get_oauth_authorize_url(
            user_id=current_user.id,
            is_shared=request.is_shared
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取OAuth授权URL失败"
        )


@router.post(
    "/oauth/callback",
    summary="提交OAuth回调",
    description="手动提交OAuth回调URL"
)
async def submit_oauth_callback(
    request: OAuthCallbackRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """提交OAuth回调"""
    try:
        result = await service.submit_oauth_callback(
            user_id=current_user.id,
            callback_url=request.callback_url
        )
        return result
    except httpx.HTTPStatusError as e:
        # 透传上游API的错误响应
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        # 如果error_data有detail字段，直接使用它；否则使用整个error_data
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        else:
            detail = error_data
        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"登录失败：{str(e)}"
        )


# ==================== 账号管理 ====================

@router.post(
    "/accounts/import",
    summary="通过 Refresh Token 导入账号",
    description="无需走 OAuth 回调，直接使用 refresh_token 导入账号并初始化配额信息"
)
async def import_account(
    request: ImportAccountRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """通过 refresh_token 导入账号"""
    try:
        result = await service.import_account_by_refresh_token(
            user_id=current_user.id,
            refresh_token=request.refresh_token,
            is_shared=request.is_shared
        )
        return result
    except httpx.HTTPStatusError as e:
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict):
            if 'detail' in error_data:
                detail = error_data['detail']
            elif 'error' in error_data:
                detail = error_data['error']
            else:
                detail = error_data
        else:
            detail = error_data
        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="导入账号失败"
        )

@router.get(
    "/accounts",
    summary="获取账号列表",
    description="获取用户在plug-in-api中的所有账号，包括project_id_0、is_restricted、ineligible等完整信息"
)
async def get_accounts(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取账号列表"""
    try:
        result = await service.get_accounts(current_user.id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取账号列表失败"
        )


@router.get(
    "/accounts/{cookie_id}",
    summary="获取账号信息",
    description="获取指定账号的详细信息"
)
async def get_account(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取账号信息"""
    try:
        result = await service.get_account(current_user.id, cookie_id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取账号信息失败"
        )


@router.get(
    "/accounts/{cookie_id}/credentials",
    summary="导出账号凭证",
    description="导出指定账号保存的凭证信息（敏感），用于前端复制为 JSON"
)
async def get_account_credentials(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service),
):
    """导出账号凭证（敏感信息）"""
    try:
        return await service.get_account_credentials(current_user.id, cookie_id)
    except httpx.HTTPStatusError as e:
        error_data = getattr(e, "response_data", {"detail": str(e)})
        if isinstance(error_data, dict):
            detail = error_data.get("detail") or error_data.get("error") or error_data
        else:
            detail = error_data
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="导出账号凭证失败",
        )


@router.get(
    "/accounts/{cookie_id}/detail",
    summary="获取账号详情",
    description="获取指定账号的邮箱、订阅层级、导入时间等信息"
)
async def get_account_detail(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取账号详情"""
    try:
        result = await service.get_account_detail(current_user.id, cookie_id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取账号详情失败"
        )


@router.post(
    "/accounts/{cookie_id}/refresh",
    summary="刷新账号",
    description="强制刷新 access_token 并更新 project_id_0（必要时自动 onboardUser）"
)
async def refresh_account(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """刷新账号（Token + Project ID）"""
    try:
        result = await service.refresh_account(current_user.id, cookie_id)
        return result
    except httpx.HTTPStatusError as e:
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        elif isinstance(error_data, dict) and 'error' in error_data:
            detail = error_data['error']
        else:
            detail = error_data
        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="刷新账号失败"
        )


@router.get(
    "/accounts/{cookie_id}/projects",
    summary="获取可选 Project 列表",
    description="通过 Cloud Resource Manager 获取该账号可见的 GCP Projects 列表",
)
async def get_account_projects(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service),
):
    """获取账号可用项目列表"""
    try:
        return await service.get_account_projects(current_user.id, cookie_id)
    except httpx.HTTPStatusError as e:
        error_data = getattr(e, "response_data", {"detail": str(e)})
        if isinstance(error_data, dict) and "detail" in error_data:
            detail = error_data["detail"]
        elif isinstance(error_data, dict) and "error" in error_data:
            detail = error_data["error"]
        else:
            detail = error_data
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="获取项目列表失败")


@router.put(
    "/accounts/{cookie_id}/project-id",
    summary="更新账号 Project ID",
    description="设置该账号使用的 project_id_0（可自定义 / 可从列表选择）",
)
async def update_account_project_id(
    cookie_id: str,
    request: UpdateAccountProjectIdRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service),
):
    """更新账号 Project ID"""
    try:
        return await service.update_account_project_id(current_user.id, cookie_id, request.project_id)
    except httpx.HTTPStatusError as e:
        error_data = getattr(e, "response_data", {"detail": str(e)})
        if isinstance(error_data, dict) and "detail" in error_data:
            detail = error_data["detail"]
        elif isinstance(error_data, dict) and "error" in error_data:
            detail = error_data["error"]
        else:
            detail = error_data
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="更新Project ID失败")


@router.put(
    "/accounts/{cookie_id}/status",
    summary="更新账号状态",
    description="启用或禁用指定账号"
)
async def update_account_status(
    cookie_id: str,
    request: UpdateAccountStatusRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """更新账号状态"""
    try:
        result = await service.update_account_status(
            user_id=current_user.id,
            cookie_id=cookie_id,
            status=request.status
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新账号状态失败"
        )


@router.delete(
    "/accounts/{cookie_id}",
    summary="删除账号",
    description="删除指定账号"
)
async def delete_account(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """删除账号"""
    try:
        result = await service.delete_account(
            user_id=current_user.id,
            cookie_id=cookie_id
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"删除账号失败"
        )


@router.put(
    "/accounts/{cookie_id}/name",
    summary="更新账号名称",
    description="修改指定账号的名称"
)
async def update_account_name(
    cookie_id: str,
    request: UpdateAccountNameRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """更新账号名称"""
    try:
        result = await service.update_account_name(
            user_id=current_user.id,
            cookie_id=cookie_id,
            name=request.name
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新账号名称失败"
        )


@router.put(
    "/accounts/{cookie_id}/type",
    summary="转换账号类型",
    description="将账号在专属和共享之间转换，同时自动更新用户共享配额池"
)
async def update_account_type(
    cookie_id: str,
    request: UpdateAccountTypeRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    转换账号类型
    
    - **专属账号 → 共享账号** (is_shared: 0 → 1)：自动增加用户共享配额池
      - 每个模型的配额增加 = 账号配额 × 2
      - max_quota 增加 2
      
    - **共享账号 → 专属账号** (is_shared: 1 → 0)：自动减少用户共享配额池
      - 每个模型的配额减少 = 账号配额 × 2
      - max_quota 减少 2
    """
    try:
        result = await service.update_account_type(
            user_id=current_user.id,
            cookie_id=cookie_id,
            is_shared=request.is_shared
        )
        return result
    except httpx.HTTPStatusError as e:
        # 透传上游API的错误响应
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        else:
            detail = error_data
        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新账号类型失败"
        )


@router.get(
    "/accounts/{cookie_id}/quotas",
    summary="获取账号配额",
    description="获取指定账号的配额信息"
)
async def get_account_quotas(
    cookie_id: str,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取账号配额信息"""
    try:
        result = await service.get_account_quotas(
            user_id=current_user.id,
            cookie_id=cookie_id
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取账号配额失败"
        )


@router.put(
    "/accounts/{cookie_id}/quotas/{model_name}/status",
    summary="更新模型配额状态",
    description="禁用或启用指定cookie的指定模型"
)
async def update_model_quota_status(
    cookie_id: str,
    model_name: str,
    request: UpdateAccountStatusRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """更新模型配额状态"""
    try:
        result = await service.update_model_quota_status(
            user_id=current_user.id,
            cookie_id=cookie_id,
            model_name=model_name,
            status=request.status
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新模型配额状态失败"
        )


# ==================== 配额管理 ====================

@router.get(
    "/quotas/user",
    summary="获取用户配额池",
    description="获取用户的共享配额池信息"
)
async def get_user_quotas(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取用户共享配额池"""
    try:
        result = await service.get_user_quotas(current_user.id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取用户配额池失败"
        )


@router.get(
    "/quotas/shared-pool",
    summary="获取共享池配额",
    description="获取共享池的总配额信息"
)
async def get_shared_pool_quotas(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取共享池配额"""
    try:
        result = await service.get_shared_pool_quotas(current_user.id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取共享池配额失败"
        )


@router.get(
    "/quotas/consumption",
    summary="获取配额消耗记录",
    description="获取用户的配额消耗历史记录"
)
async def get_quota_consumption(
    limit: Optional[int] = Query(None, description="限制返回数量"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取配额消耗记录"""
    try:
        result = await service.get_quota_consumption(
            user_id=current_user.id,
            limit=limit,
            start_date=start_date,
            end_date=end_date
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取配额消耗记录失败"
        )


# ==================== OpenAI兼容接口 ====================

@router.get(
    "/models",
    summary="获取模型列表",
    description="获取可用的AI模型列表"
)
async def get_models(
    current_user: User = Depends(get_user_from_api_key),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取模型列表"""
    try:
        # 获取 config_type（通过 API key 认证时会设置）
        config_type = getattr(current_user, '_config_type', None)
        result = await service.get_models(current_user.id, config_type=config_type)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取模型列表失败"
        )


@router.post(
    "/chat/completions",
    summary="聊天补全",
    description="使用plug-in-api进行聊天补全"
)
async def chat_completions(
    request: ChatCompletionRequest,
    raw_request: Request,
    current_user: User = Depends(get_user_from_api_key),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """聊天补全"""
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)
    model_name = getattr(request, "model", None)
    request_json = request.model_dump()

    config_type = getattr(current_user, "_config_type", None)
    effective_config_type = config_type or "antigravity"

    try:
        extra_headers: dict[str, str] = {}
        if config_type:
            extra_headers["X-Account-Type"] = config_type

        if request.stream:
            tracker = SSEUsageTracker()

            async def generate():
                try:
                    async for chunk in service.proxy_stream_request(
                        user_id=current_user.id,
                        method="POST",
                        path="/v1/chat/completions",
                        json_data=request_json,
                        extra_headers=extra_headers if extra_headers else None,
                    ):
                        tracker.feed(chunk)
                        yield chunk
                except Exception as e:
                    tracker.success = False
                    tracker.status_code = tracker.status_code or 500
                    tracker.error_message = str(e)
                    raise
                finally:
                    tracker.finalize()
                    duration_ms = int((time.monotonic() - start_time) * 1000)
                    await UsageLogService.record(
                        user_id=current_user.id,
                        api_key_id=api_key_id,
                        endpoint=endpoint,
                        method=method,
                        model_name=model_name,
                        config_type=effective_config_type,
                        stream=True,
                        input_tokens=tracker.input_tokens,
                        output_tokens=tracker.output_tokens,
                        cached_tokens=tracker.cached_tokens,
                        total_tokens=tracker.total_tokens,
                        success=tracker.success,
                        status_code=tracker.status_code,
                        error_message=tracker.error_message,
                        duration_ms=duration_ms,
                        client_app=raw_request.headers.get("X-App"),
                        request_body=request_json,
                    )

            return StreamingResponse(generate(), media_type="text/event-stream")

        result = await service.proxy_request(
            user_id=current_user.id,
            method="POST",
            path="/v1/chat/completions",
            json_data=request_json,
            extra_headers=extra_headers if extra_headers else None,
        )

        in_tok, out_tok, total_tok = extract_openai_usage(result)
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=False,
            input_tokens=in_tok,
            output_tokens=out_tok,
            total_tokens=total_tok,
            success=True,
            status_code=200,
            duration_ms=duration_ms,
            client_app=raw_request.headers.get("X-App"),
            request_body=request_json,
        )
        return result
    except ValueError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request.stream),
            success=False,
            status_code=status.HTTP_400_BAD_REQUEST,
            error_message=str(e),
            duration_ms=duration_ms,
            client_app=raw_request.headers.get("X-App"),
            request_body=request_json,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except httpx.HTTPStatusError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        upstream_response = getattr(e, "response_data", None)
        if upstream_response is None:
            try:
                upstream_response = e.response.json()
            except Exception:
                upstream_response = {"error": e.response.text}

        error_message = None
        if isinstance(upstream_response, dict):
            error_message = (
                upstream_response.get("detail")
                or upstream_response.get("error")
                or upstream_response.get("message")
                or str(upstream_response)
            )
        else:
            error_message = str(upstream_response)

        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request.stream),
            success=False,
            status_code=e.response.status_code,
            error_message=error_message,
            duration_ms=duration_ms,
            client_app=raw_request.headers.get("X-App"),
            request_body=request_json,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="聊天补全失败",
        )
    except Exception as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request.stream),
            success=False,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            error_message=str(e),
            duration_ms=duration_ms,
            client_app=raw_request.headers.get("X-App"),
            request_body=request_json,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"聊天补全失败"
        )


# ==================== 用户设置 ====================

@router.get(
    "/preference",
    summary="获取用户信息和Cookie优先级",
    description="获取用户在plug-in-api中的完整信息，包括Cookie优先级设置"
)
async def get_cookie_preference(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """获取用户信息和Cookie优先级设置"""
    try:
        # 从plug-in-api获取用户信息
        result = await service.get_user_info(current_user.id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取用户信息失败"
        )


@router.put(
    "/preference",
    summary="更新Cookie优先级",
    description="更新用户的Cookie使用优先级设置"
)
async def update_cookie_preference(
    request: UpdateCookiePreferenceRequest,
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """更新Cookie优先级"""
    try:
        # 获取plugin_user_id
        key_record = await service.repo.get_by_user_id(current_user.id)
        if not key_record or not key_record.plugin_user_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="未找到plug-in用户ID"
            )
        
        result = await service.update_cookie_preference(
            user_id=current_user.id,
            plugin_user_id=key_record.plugin_user_id,
            prefer_shared=request.prefer_shared
        )
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新Cookie优先级失败"
        )


# ==================== Gemini图片生成API ====================

@router.post(
    "/v1beta/models/{model}:generateContent",
    summary="图片生成",
    description="使用Gemini模型生成图片，支持gemini-2.5-flash-image、gemini-2.5-pro-image等模型。支持JWT token或API key认证"
)
async def generate_content(
    model: str,
    request: GenerateContentRequest,
    current_user: User = Depends(get_user_flexible),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    图片生成API（Gemini格式）
    
    参数说明:
    - model (必需): 模型名称，例如 gemini-2.5-flash-image 或 gemini-2.5-pro-image
    - contents (必需): 包含提示词的消息数组
    - generationConfig.imageConfig (可选): 图片生成配置
      - aspectRatio: 宽高比。支持的值：1:1、2:3、3:2、3:4、4:3、9:16、16:9、21:9。
                     如果未指定，模型将根据提供的任何参考图片选择默认宽高比。
      - imageSize: 图片尺寸。支持的值为 1K、2K、4K。如果未指定，模型将使用默认值 1K。
    
    请求示例:
    ```json
    {
      "contents": [
        {
          "role": "user",
          "parts": [
            {
              "text": "生成一只可爱的猫"
            }
          ]
        }
      ],
      "generationConfig": {
        "imageConfig": {
          "aspectRatio": "1:1",
          "imageSize": "1K"
        }
      }
    }
    ```
    
    响应示例:
    ```json
    {
      "candidates": [
        {
          "content": {
            "parts": [
              {
                "inlineData": {
                  "mimeType": "image/jpeg",
                  "data": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDA..."
                }
              }
            ],
            "role": "model"
          },
          "finishReason": "STOP"
        }
      ]
    }
    ```
    
    响应字段说明:
    - candidates[0].content.parts[0].inlineData.data: Base64 编码的图片数据
    - candidates[0].content.parts[0].inlineData.mimeType: 图片 MIME 类型，例如 image/jpeg
    """
    try:
        # 获取 config_type（通过 API key 认证时会设置）
        config_type = getattr(current_user, '_config_type', None)
        
        result = await service.generate_content(
            user_id=current_user.id,
            model=model,
            request_data=request.model_dump(),
            config_type=config_type
        )
        return result
    except httpx.HTTPStatusError as e:
        # 透传上游API的错误响应
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        else:
            detail = error_data
        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"图片生成失败: {str(e)}"
        )
