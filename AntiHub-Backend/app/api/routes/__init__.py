"""
API 路由模块
"""
from app.api.routes.auth import router as auth_router
from app.api.routes.health import router as health_router
from app.api.routes.plugin_api import router as plugin_api_router
from app.api.routes.api_keys import router as api_keys_router
from app.api.routes.v1 import router as v1_router
from app.api.routes.usage import router as usage_router
from app.api.routes.kiro import router as kiro_router
from app.api.routes.kiro_aws_idc import router as kiro_aws_idc_router
from app.api.routes.qwen import router as qwen_router
from app.api.routes.anthropic import router as anthropic_router
from app.api.routes.anthropic import cc_router as anthropic_cc_router
from app.api.routes.gemini import router as gemini_router
from app.api.routes.codex import router as codex_router
from app.api.routes.gemini_cli import router as gemini_cli_router
from app.api.routes.zai_tts import router as zai_tts_router
from app.api.routes.zai_image import router as zai_image_router
from app.api.routes.settings import router as settings_router

__all__ = [
    "auth_router",
    "health_router",
    "plugin_api_router",
    "api_keys_router",
    "v1_router",
    "usage_router",
    "kiro_router",
    "kiro_aws_idc_router",
    "qwen_router",
    "anthropic_router",
    "anthropic_cc_router",
    "gemini_router",
    "codex_router",
    "gemini_cli_router",
    "zai_tts_router",
    "zai_image_router",
    "settings_router",
]
