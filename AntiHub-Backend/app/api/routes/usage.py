"""
用量统计路由
显示用户的使用记录和剩余配额
"""
from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_plugin_api_service, get_db_session
from app.models.user import User
from app.services.plugin_api_service import PluginAPIService
from app.repositories.usage_counter_repository import UsageCounterRepository
from app.repositories.usage_log_repository import UsageLogRepository
from app.models.usage_log import UsageLog


router = APIRouter(prefix="/usage", tags=["用量统计"])


@router.get(
    "/quotas",
    summary="获取配额信息",
    description="获取用户的配额信息，包括用户共享配额池和共享池总配额"
)
async def get_quotas(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    获取用户配额信息
    包括：
    - 用户共享配额池（user_quota）
    - 共享池总配额（shared_pool_quota）
    """
    try:
        # 获取用户共享配额池
        user_quota = await service.get_user_quotas(current_user.id)
        
        # 获取共享池配额
        shared_pool_quota = await service.get_shared_pool_quotas(current_user.id)
        
        # 处理新的响应格式：data 可能是对象（包含 quotas 和 user_consumption）或数组
        shared_pool_data = shared_pool_quota.get("data", {})
        if isinstance(shared_pool_data, dict):
            # 新格式：返回完整的对象
            shared_pool_result = shared_pool_data
        else:
            # 旧格式：数组，包装成对象
            shared_pool_result = {"quotas": shared_pool_data}
        
        return {
            "success": True,
            "data": {
                "user_quota": user_quota.get("data", []),
                "shared_pool_quota": shared_pool_result
            }
        }
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取配额信息失败"
        )


@router.get(
    "/consumption",
    summary="获取消耗记录",
    description="获取用户的配额消耗历史记录"
)
async def get_consumption(
    limit: Optional[int] = Query(50, description="限制返回数量"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    获取配额消耗记录
    如果plug-in-api不支持此端点，会返回错误信息
    """
    try:
        result = await service.get_quota_consumption(
            user_id=current_user.id,
            limit=limit,
            start_date=start_date,
            end_date=end_date
        )
        return result
    except Exception as e:
        # 如果端点不存在，返回友好的错误信息
        error_msg = str(e)
        if "404" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="plug-in-api暂不支持消耗记录查询功能"
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取消耗记录失败: {error_msg}"
        )


@router.get(
    "/accounts",
    summary="获取账号配额",
    description="获取用户所有账号的配额信息"
)
async def get_accounts_quotas(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    获取用户所有账号及其配额信息
    """
    try:
        # 获取账号列表
        accounts_result = await service.get_accounts(current_user.id)
        accounts = accounts_result.get("data", [])
        
        # 为每个账号获取配额信息
        accounts_with_quotas = []
        for account in accounts:
            cookie_id = account.get("cookie_id")
            try:
                quotas_result = await service.get_account_quotas(
                    user_id=current_user.id,
                    cookie_id=cookie_id
                )
                account["quotas"] = quotas_result.get("data", [])
            except Exception:
                account["quotas"] = []
            
            accounts_with_quotas.append(account)
        
        return {
            "success": True,
            "data": accounts_with_quotas
        }
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


@router.get(
    "/summary",
    summary="获取用量摘要",
    description="获取用户的用量摘要信息"
)
async def get_usage_summary(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    获取用量摘要
    包括：
    - 账号数量
    - 总配额
    - 已用配额
    - 剩余配额
    """
    try:
        # 获取账号列表
        accounts_result = await service.get_accounts(current_user.id)
        accounts = accounts_result.get("data", [])
        
        # 获取用户共享配额池
        user_quota_result = await service.get_user_quotas(current_user.id)
        user_quotas = user_quota_result.get("data", [])
        
        # 获取共享池配额
        shared_pool_result = await service.get_shared_pool_quotas(current_user.id)
        shared_pool_data = shared_pool_result.get("data", {})
        # 处理新的响应格式：data 可能是对象（包含 quotas）或数组
        if isinstance(shared_pool_data, dict):
            shared_pool_quotas = shared_pool_data.get("quotas", [])
        else:
            shared_pool_quotas = shared_pool_data
        
        # 统计信息
        total_accounts = len(accounts)
        active_accounts = len([a for a in accounts if a.get("status") == 1])
        
        # 按模型统计配额
        quota_by_model = {}
        for quota in user_quotas:
            model_name = quota.get("model_name")
            quota_by_model[model_name] = {
                "current_quota": float(quota.get("quota", 0)),
                "max_quota": float(quota.get("max_quota", 0)),
                "last_recovered_at": quota.get("last_recovered_at")
            }
        
        return {
            "success": True,
            "data": {
                "accounts": {
                    "total": total_accounts,
                    "active": active_accounts,
                    "inactive": total_accounts - active_accounts
                },
                "user_quotas": quota_by_model,
                "shared_pool": shared_pool_quotas
            }
        }
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取用量摘要失败"
        )


@router.get(
    "/shared-pool/stats",
    summary="获取共享池统计信息",
    description="获取总共享池的统计信息，包括账号数、配额等"
)
async def get_shared_pool_stats(
    current_user: User = Depends(get_current_user),
    service: PluginAPIService = Depends(get_plugin_api_service)
):
    """
    获取共享池统计信息
    包括：
    - 总共享账号数
    - 可用共享账号数
    - 各模型的总配额
    - 各模型的可用配额
    """
    try:
        # 获取账号列表
        accounts_result = await service.get_accounts(current_user.id)
        accounts = accounts_result.get("data", [])
        
        # 筛选共享账号
        shared_accounts = [a for a in accounts if a.get("is_shared") == 1]
        active_shared_accounts = [a for a in shared_accounts if a.get("status") == 1]
        
        # 获取共享池配额
        shared_pool_result = await service.get_shared_pool_quotas(current_user.id)
        shared_pool_data = shared_pool_result.get("data", {})
        
        # 处理新的响应格式：data 可能是对象（包含 quotas 和 user_consumption）或数组
        if isinstance(shared_pool_data, dict):
            shared_pool_quotas = shared_pool_data.get("quotas", [])
            user_consumption = shared_pool_data.get("user_consumption", {})
        else:
            shared_pool_quotas = shared_pool_data
            user_consumption = {}
        
        # 按模型统计配额
        quota_stats = {}
        for quota in shared_pool_quotas:
            model_name = quota.get("model_name")
            quota_stats[model_name] = {
                "total_quota": float(quota.get("total_quota", 0)),
                "available_cookies": quota.get("available_cookies", 0),
                "earliest_reset_time": quota.get("earliest_reset_time"),
                "status": quota.get("status")
            }
        
        return {
            "success": True,
            "data": {
                "accounts": {
                    "total_shared": len(shared_accounts),
                    "active_shared": len(active_shared_accounts),
                    "inactive_shared": len(shared_accounts) - len(active_shared_accounts)
                },
                "quotas_by_model": quota_stats,
                "user_consumption": user_consumption,
                "note": "24小时消耗统计需要启用使用日志记录功能"
            }
        }
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取共享池统计失败"
        )


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    # 支持 2026-01-14T12:00:00Z
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception as e:
        raise ValueError("start_date/end_date 必须是 ISO8601 格式") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _usage_log_to_dict(log: UsageLog) -> dict:
    return {
        "id": log.id,
        "endpoint": log.endpoint,
        "method": log.method,
        "model_name": log.model_name,
        "config_type": log.config_type,
        "stream": bool(log.stream),
        "success": bool(log.success),
        "status_code": log.status_code,
        "error_message": log.error_message,
        "quota_consumed": float(log.quota_consumed or 0.0),
        "input_tokens": int(log.input_tokens or 0),
        "output_tokens": int(log.output_tokens or 0),
        "total_tokens": int(log.total_tokens or 0),
        "duration_ms": int(log.duration_ms or 0),
        "tts_voice_id": log.tts_voice_id,
        "tts_account_id": log.tts_account_id,
        "created_at": log.created_at.isoformat() if log.created_at else None,
    }


@router.get(
    "/requests/logs",
    summary="获取请求用量日志",
    description="返回本系统记录的请求日志（成功/失败都包含）。用于前端用量统计展示。",
)
async def get_request_usage_logs(
    limit: int = Query(50, description="每页数量（1-200）"),
    offset: int = Query(0, description="偏移量（>=0）"),
    start_date: Optional[str] = Query(None, description="开始时间（ISO8601）"),
    end_date: Optional[str] = Query(None, description="结束时间（ISO8601）"),
    config_type: Optional[str] = Query(None, description="antigravity/kiro/qwen/codex/gemini-cli/zai-tts/zai-image"),
    success: Optional[bool] = Query(None, description="true=只看成功，false=只看失败，不传=全部"),
    model_name: Optional[str] = Query(None, description="模型名过滤"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    try:
        if limit < 1 or limit > 200:
            raise ValueError("limit 必须在 1-200 之间")
        if offset < 0:
            raise ValueError("offset 不能小于 0")
        if config_type and config_type not in ("antigravity", "kiro", "qwen", "codex", "gemini-cli", "zai-tts", "zai-image"):
            raise ValueError("config_type 必须是 antigravity / kiro / qwen / codex / gemini-cli / zai-tts / zai-image")

        start_at = _parse_iso_datetime(start_date)
        end_at = _parse_iso_datetime(end_date)

        repo = UsageLogRepository(db)
        total = await repo.count_logs(
            user_id=current_user.id,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            success=success,
            model_name=model_name,
        )
        logs = await repo.list_logs(
            user_id=current_user.id,
            limit=limit,
            offset=offset,
            start_at=start_at,
            end_at=end_at,
            config_type=config_type,
            success=success,
            model_name=model_name,
        )

        return {
            "success": True,
            "data": {
                "logs": [_usage_log_to_dict(l) for l in logs],
                "pagination": {"limit": limit, "offset": offset, "total": total},
            },
        }
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取请求用量日志失败",
        )


@router.get(
    "/requests/stats",
    summary="获取请求用量统计",
    description="按时间范围聚合统计请求次数、token 用量、成功/失败数。",
)
async def get_request_usage_stats(
    start_date: Optional[str] = Query(None, description="开始时间（ISO8601）"),
    end_date: Optional[str] = Query(None, description="结束时间（ISO8601）"),
    config_type: Optional[str] = Query(None, description="antigravity/kiro/qwen/codex/gemini-cli/zai-tts/zai-image"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    try:
        if config_type and config_type not in ("antigravity", "kiro", "qwen", "codex", "gemini-cli", "zai-tts", "zai-image"):
            raise ValueError("config_type 必须是 antigravity / kiro / qwen / codex / gemini-cli / zai-tts / zai-image")

        start_at = _parse_iso_datetime(start_date)
        end_at = _parse_iso_datetime(end_date)

        # usage_logs 仅保留最近 N 条（滑动窗口），不适合用来展示“累计消耗”。
        # - 未指定时间范围：使用 usage_counters（累计统计，不裁剪）
        # - 指定时间范围：仍使用 usage_logs（注意：仅代表日志表里现存数据）
        if start_at is None and end_at is None:
            stats_data = await UsageCounterRepository(db).get_stats(
                user_id=current_user.id,
                config_type=config_type,
            )
        else:
            repo = UsageLogRepository(db)
            stats_data = await repo.get_stats(
                user_id=current_user.id,
                start_at=start_at,
                end_at=end_at,
                config_type=config_type,
            )
            # usage_logs 表中暂不保存 cached_tokens（历史原因），这里保持字段存在但为 0
            stats_data.setdefault("cached_tokens", 0)

        return {
            "success": True,
            "data": {
                "range": {
                    "start_date": start_at.isoformat() if start_at else None,
                    "end_date": end_at.isoformat() if end_at else None,
                },
                "config_type": config_type,
                **stats_data,
            },
        }
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取请求用量统计失败",
        )
