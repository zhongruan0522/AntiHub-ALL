"""
服务层模块
提供业务逻辑处理
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

# NOTE:
# - Keep this package import lightweight so unit tests / utilities that only need a single
#   submodule (e.g. `kiro_anthropic_converter`) don't require DB/Redis deps at import time.
# - We still expose the common service classes via lazy imports for backwards compatibility.

if TYPE_CHECKING:
    from app.services.auth_service import AuthService as AuthService
    from app.services.plugin_api_service import PluginAPIService as PluginAPIService
    from app.services.user_service import UserService as UserService

__all__ = [
    "AuthService",
    "UserService",
    "PluginAPIService",
]


def __getattr__(name: str) -> Any:  # pragma: no cover
    if name == "AuthService":
        from app.services.auth_service import AuthService as value
    elif name == "UserService":
        from app.services.user_service import UserService as value
    elif name == "PluginAPIService":
        from app.services.plugin_api_service import PluginAPIService as value
    else:
        raise AttributeError(name)

    globals()[name] = value
    return value
