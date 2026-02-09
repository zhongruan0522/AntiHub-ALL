"""
FastAPI 应用主文件
应用入口点和配置
"""
import base64
import logging
import base64
import json
import os
import tempfile
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.core.exceptions import BaseAPIException
from app.db.session import init_db, close_db
from app.cache import init_redis, close_redis
from app.api.routes import (
    auth_router,
    health_router,
    plugin_api_router,
    api_keys_router,
    v1_router,
    usage_router,
    settings_router,
    kiro_router,
    kiro_aws_idc_router,
    qwen_router,
    anthropic_router,
    anthropic_cc_router,
    gemini_router,
    codex_router,
    gemini_cli_router,
    zai_tts_router,
    zai_image_router,
)

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# 创建模块级别的 logger
logger = logging.getLogger(__name__)


class DebugLogRequestBodyMiddleware:
    """
    打印完整用户请求体（原始字节 -> UTF-8 文本；非 UTF-8 则打印 base64）。

    注意：
    - 不能用 BaseHTTPMiddleware（FastAPI 的 @app.middleware("http") 底层使用它），
      否则会破坏 StreamingResponse（SSE）等流式响应，导致请求挂起/超时（常见表现为 504）。
    - 本中间件会读取完整请求体；可能包含敏感信息（密码/Token 等），仅用于本地调试。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        original_receive = receive

        messages = []
        body_chunks = []
        try:
            while True:
                message = await original_receive()
                messages.append(message)

                if message.get("type") == "http.disconnect":
                    break

                if message.get("type") != "http.request":
                    break

                body_chunks.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
        except Exception as e:
            logger.warning(
                "DEBUG_LOG 读取请求体失败 - %s %s: %s",
                scope.get("method", "-"),
                scope.get("path", "-"),
                str(e),
                exc_info=True,
            )
            await self.app(scope, original_receive, send)
            return

        body_bytes = b"".join(body_chunks)
        if body_bytes:
            headers = {
                k.decode("latin-1").lower(): v.decode("latin-1")
                for k, v in (scope.get("headers") or [])
            }
            content_type = headers.get("content-type", "")

            try:
                body_text = body_bytes.decode("utf-8")
            except UnicodeDecodeError:
                body_text = f"[base64] {base64.b64encode(body_bytes).decode('ascii')}"

            logger.info(
                "DEBUG_LOG 请求体 - %s %s (content-type=%s, bytes=%s):\n%s",
                scope.get("method", "-"),
                scope.get("path", "-"),
                content_type or "-",
                len(body_bytes),
                body_text,
            )

        async def receive_with_replay():
            if messages:
                return messages.pop(0)
            return await original_receive()

        await self.app(scope, receive_with_replay, send)


# ==================== 生命周期事件 ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用生命周期管理
    启动和关闭事件处理
    """
    logger = logging.getLogger(__name__)
    settings = get_settings()
    
    # 初始化数据库连接
    try:
        logger.info("正在初始化数据库连接...")
        await init_db()
        
        # 测试数据库连接
        from app.db.session import get_engine
        from sqlalchemy import text
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        logger.info("✓ 数据库连接成功")
    except Exception as e:
        logger.error(f"✗ 数据库连接失败: {str(e)}")
        raise
    
    # 初始化 Redis 连接
    try:
        logger.info("正在初始化 Redis 连接...")
        await init_redis()
        
        # 测试 Redis 连接
        from app.cache import get_redis_client
        redis = get_redis_client()
        await redis.ping()
        logger.info("✓ Redis 连接成功")
    except Exception as e:
        logger.error(f"✗ Redis 连接失败: {str(e)}")
        raise

    # 启动时自动初始化管理员账号（可选）
    try:
        from app.db.session import get_session_maker
        from app.utils.admin_init import ensure_admin_user

        session_maker = get_session_maker()
        async with session_maker() as session:
            await ensure_admin_user(session)
    except Exception as e:
        logger.error(
            f"初始化管理员账号失败: {type(e).__name__}: {str(e)}",
            exc_info=True,
        )
        raise

    # 启动时清理 TTS 临时文件
    try:
        from app.services.zai_tts_service import ZaiTTSService

        session_maker = get_session_maker()
        async with session_maker() as session:
            ZaiTTSService(session).cleanup_storage_on_startup()
    except Exception as e:
        logger.warning("清理 TTS 临时文件失败: %s", str(e))
    
    logger.info("🚀 应用启动完成")
     
    yield
    
    # 关闭事件
    logger.info("正在关闭应用...")
    
    # 关闭数据库连接
    try:
        await close_db()
        logger.info("✓ 数据库连接已关闭")
    except Exception as e:
        logger.error(f"✗ 关闭数据库连接失败: {str(e)}")
    
    # 关闭 Redis 连接
    try:
        await close_redis()
        logger.info("✓ Redis 连接已关闭")
    except Exception as e:
        logger.error(f"✗ 关闭 Redis 连接失败: {str(e)}")
    
    logger.info("👋 应用已关闭")


# ==================== 创建 FastAPI 应用 ====================

def create_app() -> FastAPI:
    """
    创建并配置 FastAPI 应用
    
    Returns:
        配置好的 FastAPI 应用实例
    """
    settings = get_settings()
    
    # 创建 FastAPI 应用
    # 生产环境禁用API文档
    docs_url = "/api/docs" if settings.is_development else None
    redoc_url = "/api/redoc" if settings.is_development else None
    openapi_url = "/api/openapi.json" if settings.is_development else None
    
    app = FastAPI(
        title="共享账号管理系统",
        description="基于 FastAPI 的共享账号管理系统,支持传统用户名密码登录",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url
    )
    
    # ==================== CORS 配置 ====================
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # 生产环境应该配置具体的域名
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ==================== Debug 日志（请求体） ====================
    # 注意：开启后会打印所有请求的原始请求体，可能包含敏感信息（密码/Token等）
    if settings.debug_log:
        app.add_middleware(DebugLogRequestBodyMiddleware)
    
    # ==================== 注册路由 ====================
    
    app.include_router(auth_router, prefix="/api")
    app.include_router(health_router, prefix="/api")
    app.include_router(plugin_api_router, prefix="/api")
    app.include_router(api_keys_router, prefix="/api")
    app.include_router(usage_router, prefix="/api")
    app.include_router(settings_router)  # 用户设置（默认渠道等）
    app.include_router(kiro_router)  # Kiro账号管理API
    app.include_router(kiro_aws_idc_router)  # Kiro AWS IdC / Builder ID（独立入口）
    app.include_router(qwen_router)  # Qwen账号管理API
    app.include_router(codex_router)  # Codex账号管理API（本地落库）
    app.include_router(gemini_cli_router)  # GeminiCLI账号管理API（本地落库）
    app.include_router(zai_tts_router)  # ZAI TTS账号管理API
    app.include_router(zai_image_router)  # ZAI Image账号管理API
    app.include_router(v1_router)  # OpenAI兼容API，支持Antigravity和Kiro配置
    app.include_router(anthropic_router)  # Anthropic兼容API (/v1/messages)
    app.include_router(anthropic_cc_router)  # Claude Code兼容API (/cc/v1/messages)
    app.include_router(gemini_router)  # Gemini兼容API (/v1beta/models/{model}:generateContent)
    
    # ==================== 异常处理器 ====================
    
    @app.exception_handler(BaseAPIException)
    async def api_exception_handler(request: Request, exc: BaseAPIException):
        """处理自定义 API 异常"""
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_dict()
        )
    
    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        """处理数据验证异常"""
        # Dump 用户输入用于调试
        inputdump = {
            "method": request.method,
            "url": str(request.url),
            "path": request.url.path,
            "query_params": dict(request.query_params),
            "headers": {k: v for k, v in request.headers.items() if k.lower() not in ['authorization', 'x-api-key']},
            "body": exc.body if hasattr(exc, 'body') else None,
        }
        logger.warning(f"请求验证失败 - inputdump: {inputdump}")
        logger.warning(f"验证错误详情: {exc.errors()}")
        
        # Dump错误到文件
        try:
            error_dump_file = os.path.join(tempfile.gettempdir(), "error_dumps.json")
            error_record = {
                "timestamp": datetime.now().isoformat(),
                "endpoint": request.url.path,
                "error_type": "validation_error",
                "user_request": inputdump,
                "error_info": {
                    "validation_errors": exc.errors(),
                    "error_class": "RequestValidationError"
                }
            }
            
            # 读取现有的错误记录
            existing_errors = []
            if os.path.exists(error_dump_file):
                try:
                    with open(error_dump_file, "r", encoding="utf-8") as f:
                        existing_errors = json.load(f)
                except (json.JSONDecodeError, IOError):
                    existing_errors = []
            
            # 添加新的错误记录
            existing_errors.append(error_record)
            
            # 只保留最近100条记录
            if len(existing_errors) > 100:
                existing_errors = existing_errors[-100:]
            
            # 写入文件
            with open(error_dump_file, "w", encoding="utf-8") as f:
                json.dump(existing_errors, f, ensure_ascii=False, indent=2)
            
            logger.info(f"验证错误已dump到 {error_dump_file}")
        except Exception as dump_error:
            logger.error(f"dump验证错误失败: {str(dump_error)}")
        
        # 检查是否是 Anthropic API 端点
        if request.url.path.startswith("/v1/messages"):
            # 返回 Anthropic 格式的错误响应
            error_details = exc.errors()
            error_messages = []
            for error in error_details:
                loc = " -> ".join(str(l) for l in error.get("loc", []))
                msg = error.get("msg", "Unknown error")
                error_messages.append(f"{loc}: {msg}")
            
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": f"请求验证失败: {'; '.join(error_messages)}"
                    },
                    "inputdump": inputdump
                }
            )
        
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error_code": "VALIDATION_ERROR",
                "message": "数据验证失败",
                "details": exc.errors(),
                "inputdump": inputdump
            }
        )
    
    @app.exception_handler(SQLAlchemyError)
    async def database_exception_handler(request: Request, exc: SQLAlchemyError):
        """处理数据库异常"""
        logger.error(f"数据库异常: {str(exc)}", exc_info=True)
        
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error_code": "DATABASE_ERROR",
                "message": "数据库操作失败",
                "details": {"error": str(exc)}
            },
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": "true",
            }
        )
    
    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        """处理通用异常"""
        # 记录详细错误信息用于调试
        logger.error(f"未处理的异常: {type(exc).__name__}: {str(exc)}", exc_info=True)
        
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error_code": "INTERNAL_SERVER_ERROR",
                "message": "服务器内部错误",
                "details": {"error": str(exc), "type": type(exc).__name__}
            },
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
            }
        )
    
    # ==================== 根路径 ====================
    
    @app.get("/", tags=["根路径"])
    async def root():
        """根路径欢迎信息"""
        return {
            "message": "200",
        }
    
    return app


# 创建应用实例
app = create_app()


# ==================== 开发服务器 ====================

if __name__ == "__main__":
    import uvicorn
    
    settings = get_settings()
    
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.is_development,
        log_level=settings.log_level.lower()
    )
