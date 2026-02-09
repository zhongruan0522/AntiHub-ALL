"""
设置相关接口

目前提供：
- 前端面板“默认渠道”设置（账户管理/消耗日志），按用户落库
"""

from __future__ import annotations

from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db_session
from app.models.user import User
from app.repositories.user_setting_repository import UserSettingRepository
from app.schemas.settings import UiDefaultChannelsUpsertRequest


router = APIRouter(prefix="/api/settings", tags=["设置"])


ACCOUNTS_DEFAULT_CHANNELS = (
    "antigravity",
    "kiro",
    "qwen",
    "codex",
    "gemini",
    "zai-tts",
    "zai-image",
)

USAGE_DEFAULT_CHANNELS = (
    "antigravity",
    "kiro",
    "qwen",
    "codex",
    "gemini-cli",
    "zai-tts",
    "zai-image",
)


def _normalize_optional_channel(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _settings_to_dict(setting: Optional[Any]) -> Dict[str, Any]:
    if not setting:
        return {
            "accounts_default_channel": None,
            "usage_default_channel": None,
        }
    return {
        "accounts_default_channel": getattr(setting, "accounts_default_channel", None),
        "usage_default_channel": getattr(setting, "usage_default_channel", None),
    }


@router.get("/ui-default-channels", summary="获取默认渠道设置")
async def get_ui_default_channels(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    try:
        repo = UserSettingRepository(db)
        setting = await repo.get_by_user_id(current_user.id)
        return {"success": True, "data": _settings_to_dict(setting)}
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="获取默认渠道设置失败",
        )


@router.put("/ui-default-channels", summary="保存默认渠道设置")
async def upsert_ui_default_channels(
    request: UiDefaultChannelsUpsertRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    try:
        update_values: Dict[str, Any] = {}
        provided = getattr(request, "model_fields_set", set())

        if "accounts_default_channel" in provided:
            accounts_channel = _normalize_optional_channel(request.accounts_default_channel)
            if accounts_channel is not None and accounts_channel not in ACCOUNTS_DEFAULT_CHANNELS:
                raise ValueError(
                    "accounts_default_channel 必须是 "
                    + " / ".join(ACCOUNTS_DEFAULT_CHANNELS)
                    + " 或 null"
                )
            update_values["accounts_default_channel"] = accounts_channel

        if "usage_default_channel" in provided:
            usage_channel = _normalize_optional_channel(request.usage_default_channel)
            if usage_channel is not None and usage_channel not in USAGE_DEFAULT_CHANNELS:
                raise ValueError(
                    "usage_default_channel 必须是 "
                    + " / ".join(USAGE_DEFAULT_CHANNELS)
                    + " 或 null"
                )
            update_values["usage_default_channel"] = usage_channel

        repo = UserSettingRepository(db)
        existing = await repo.get_by_user_id(current_user.id)

        if not update_values:
            return {"success": True, "data": _settings_to_dict(existing)}

        if existing:
            setting = await repo.update(user_id=current_user.id, **update_values)
        else:
            create_payload = {
                "accounts_default_channel": None,
                "usage_default_channel": None,
                **update_values,
            }
            setting = await repo.create(user_id=current_user.id, **create_payload)

        return {"success": True, "data": _settings_to_dict(setting)}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="保存默认渠道设置失败",
        )

