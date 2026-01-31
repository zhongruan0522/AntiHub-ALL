"""
API密钥管理路由
用户可以创建、查看、删除自己的API密钥
"""
from typing import List
import logging
from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_user, get_db, get_redis
from app.cache import RedisClient
from app.models.user import User
from app.repositories.api_key_repository import APIKeyRepository
from app.schemas.api_key import (
    APIKeyCreate,
    APIKeyResponse,
    APIKeyListResponse,
    APIKeyUpdateStatus,
    APIKeyUpdateType,
)
from sqlalchemy.ext.asyncio import AsyncSession


router = APIRouter(prefix="/api-keys", tags=["API密钥管理"])
logger = logging.getLogger(__name__)


@router.post(
    "",
    response_model=APIKeyResponse,
    summary="创建API密钥",
    description="为当前用户创建一个新的API密钥"
)
async def create_api_key(
    request: APIKeyCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """创建新的API密钥"""
    try:
        repo = APIKeyRepository(db)
        api_key = await repo.create(
            user_id=current_user.id,
            name=request.name,
            config_type=request.config_type
        )
        await db.commit()
        return APIKeyResponse.model_validate(api_key)
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"创建API密钥失败"
        )


@router.get(
    "",
    response_model=List[APIKeyListResponse],
    summary="获取API密钥列表",
    description="获取当前用户的所有API密钥（密钥只显示前8位）"
)
async def list_api_keys(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """获取用户的所有API密钥"""
    try:
        repo = APIKeyRepository(db)
        keys = await repo.get_by_user_id(current_user.id)
        
        # 转换为列表响应，只显示密钥前8位
        return [
            APIKeyListResponse(
                id=key.id,
                user_id=key.user_id,
                key_preview=key.key[:8] + "..." if len(key.key) > 8 else key.key,
                name=key.name,
                config_type=key.config_type,
                is_active=key.is_active,
                created_at=key.created_at,
                last_used_at=key.last_used_at,
                expires_at=key.expires_at
            )
            for key in keys
        ]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取API密钥列表失败"
        )


@router.get(
    "/{key_id}",
    response_model=APIKeyResponse,
    summary="获取API密钥详情",
    description="获取指定API密钥的完整信息（包含完整密钥）"
)
async def get_api_key(
    key_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """获取API密钥详情"""
    try:
        repo = APIKeyRepository(db)
        api_key = await repo.get_by_id(key_id)
        
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="API密钥不存在"
            )
        
        if api_key.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="无权访问此API密钥"
            )
        
        return APIKeyResponse.model_validate(api_key)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取API密钥失败"
        )


@router.patch(
    "/{key_id}/status",
    response_model=APIKeyResponse,
    summary="更新API密钥状态",
    description="启用或禁用指定的API密钥"
)
async def update_api_key_status(
    key_id: int,
    request: APIKeyUpdateStatus,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """更新API密钥状态"""
    try:
        repo = APIKeyRepository(db)
        api_key = await repo.update_status(
            key_id=key_id,
            user_id=current_user.id,
            is_active=request.is_active
        )
        
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="API密钥不存在或无权访问"
            )
        
        await db.commit()
        return APIKeyResponse.model_validate(api_key)
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新API密钥状态失败"
        )


@router.patch(
    "/{key_id}/type",
    response_model=APIKeyResponse,
    summary="更新API密钥类型",
    description="修改指定API密钥的配置类型（config_type）"
)
async def update_api_key_type(
    key_id: int,
    request: APIKeyUpdateType,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: RedisClient = Depends(get_redis),
):
    """更新API密钥类型"""
    try:
        repo = APIKeyRepository(db)

        # 先读一次旧值用于审计日志（不要打印 key 明文）
        old_key = await repo.get_by_id(key_id)
        if not old_key or old_key.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="API密钥不存在或无权访问"
            )
        old_type = old_key.config_type

        api_key = await repo.update_type(
            key_id=key_id,
            user_id=current_user.id,
            config_type=request.config_type,
        )

        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="API密钥不存在或无权访问"
            )

        await db.commit()

        logger.info(
            "api_key config_type updated: user_id=%s key_id=%s from=%s to=%s",
            current_user.id,
            key_id,
            old_type,
            request.config_type,
        )

        # 清理 API Key 认证缓存，避免 config_type 变更后短时间内继续走旧路由
        try:
            await redis.delete(f"api_key_auth:{api_key.key}")
        except Exception:
            # Redis 不可用不应阻塞更新
            pass

        return APIKeyResponse.model_validate(api_key)
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"更新API密钥类型失败"
        )


@router.delete(
    "/{key_id}",
    summary="删除API密钥",
    description="删除指定的API密钥"
)
async def delete_api_key(
    key_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """删除API密钥"""
    try:
        repo = APIKeyRepository(db)
        success = await repo.delete(key_id, current_user.id)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="API密钥不存在或无权删除"
            )
        
        await db.commit()
        return {"message": "API密钥已删除", "success": True}
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"删除API密钥失败"
        )
