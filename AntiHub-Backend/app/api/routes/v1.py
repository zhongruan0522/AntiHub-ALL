"""
OpenAI兼容的API端点
支持API key或JWT token认证
根据API key的config_type自动选择Antigravity / Kiro / Qwen / Codex配置
用户通过我们的key/token调用，我们再用plug-in key调用plug-in-api
"""
import asyncio
import base64
import json
import logging
import os
from typing import List, Dict, Any, Optional, Tuple
import time
import uuid
import httpx
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps_flexible import get_user_flexible
from app.api.deps import get_plugin_api_service, get_db_session, get_redis
from app.models.user import User
from app.services.plugin_api_service import PluginAPIService
from app.services.kiro_service import KiroService, UpstreamAPIError
from app.services.codex_service import CodexService
from app.services.gemini_cli_api_service import GeminiCLIAPIService
from app.services.zai_tts_service import ZaiTTSService
from app.services.zai_image_service import ZaiImageService
from app.services.anthropic_adapter import AnthropicAdapter
from app.services.usage_log_service import (
    UsageLogService,
    SSEUsageTracker,
    extract_openai_usage,
    extract_openai_usage_details,
)
from app.schemas.plugin_api import ChatCompletionRequest
from app.cache import RedisClient
from app.utils.openai_responses_compat import (
    ChatCompletionsToResponsesSSETranslator,
    chat_completions_response_to_responses_response,
    responses_request_to_chat_completions_request,
)


router = APIRouter(prefix="/v1", tags=["OpenAI兼容API"])
logger = logging.getLogger(__name__)


def _truncate_sse_error_message(message: str, *, max_len: int = 2000) -> str:
    msg = str(message or "").strip()
    if not msg:
        return "Unknown error"
    if len(msg) <= max_len:
        return msg
    return msg[:max_len] + "…"


def _responses_sse_error(
    message: str,
    *,
    code: int = 500,
    error_type: str = "upstream_error",
) -> bytes:
    payload = {
        "type": "error",
        "error": {
            "message": _truncate_sse_error_message(message),
            "type": error_type,
            "code": int(code or 500),
        },
    }
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: error\ndata: {data}\n\n".encode("utf-8")


LOCAL_IMAGE_MODEL_ID = "glm-image"
LOCAL_IMAGE_MODEL_ALIASES: List[str] = [
    "gemini-3-pro-image-preview",
    "gemini-3-pro-image",
]
LOCAL_IMAGE_MODEL_IDS: List[str] = [LOCAL_IMAGE_MODEL_ID, *LOCAL_IMAGE_MODEL_ALIASES]


def _is_local_image_model(model: Any) -> bool:
    return str(model or "").strip() in LOCAL_IMAGE_MODEL_IDS


def _inject_local_models(payload: Any) -> Any:
    """
    在 OpenAI /v1/models 的返回里追加本地虚拟模型（例如 glm-image）。
    只在 payload 符合 OpenAI models list 格式时注入。
    """
    if not isinstance(payload, dict):
        return payload
    data = payload.get("data")
    if not isinstance(data, list):
        return payload

    existing_ids = {
        str(item.get("id") or "").strip()
        for item in data
        if isinstance(item, dict)
    }

    now_ts = int(time.time())
    for model_id in LOCAL_IMAGE_MODEL_IDS:
        if model_id in existing_ids:
            continue
        data.append(
            {
                "id": model_id,
                "object": "model",
                "created": now_ts,
                "owned_by": "antihub",
            }
        )

    payload["data"] = data
    payload.setdefault("object", "list")

    return payload


ZAI_IMAGE_RATIO_OPTIONS: Dict[str, float] = {
    "1:1": 1.0,
    "4:3": 4 / 3,
    "3:2": 3 / 2,
    "3:4": 3 / 4,
    "1:4": 1 / 4,
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "1:9": 1 / 9,
    "21:9": 21 / 9,
}


def _openai_size_to_zai_image_config(size: Any) -> Tuple[str, str]:
    """
    OpenAI images: size="1024x1024" -> ZAI: ratio + resolution
    """
    raw = str(size or "").strip().lower()
    if "x" not in raw:
        return "16:9", "2K"

    try:
        w_s, h_s = raw.split("x", 1)
        w = int(w_s)
        h = int(h_s)
    except Exception:
        return "16:9", "2K"

    if w <= 0 or h <= 0:
        return "16:9", "2K"

    ratio_value = float(w) / float(h)
    ratio = min(ZAI_IMAGE_RATIO_OPTIONS.keys(), key=lambda k: abs(ZAI_IMAGE_RATIO_OPTIONS[k] - ratio_value))

    max_side = max(w, h)
    resolution = "2K" if max_side > 1024 else "1K"
    return ratio, resolution


def _openai_quality_to_zai_image_resolution(quality: Any) -> Optional[str]:
    q = str(quality or "").strip().lower()
    if not q:
        return None
    if q in ("hd", "high", "high_quality", "high-quality", "2k"):
        return "2K"
    if q in ("standard", "low", "1k"):
        return "1K"
    return None


def _extract_openai_chat_text_prompt(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""

    texts: list[str] = []
    has_image = False

    for msg in messages:
        if not isinstance(msg, dict):
            continue

        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                texts.append(content.strip())
            continue

        if isinstance(content, dict):
            content = [content]

        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue

                ptype = str(part.get("type") or "").strip().lower()
                if ptype and "image" in ptype:
                    has_image = True

                if any(k in part for k in ("image_url", "imageUrl", "inlineData", "input_image")):
                    has_image = True

                text = part.get("text")
                if not isinstance(text, str):
                    text = part.get("input_text")

                if isinstance(text, str) and text.strip():
                    texts.append(text.strip())

    if has_image:
        raise ValueError("glm-image 暂不支持图生图（image_url / input_image）")

    return "\n".join(texts).strip()

def get_kiro_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis)
) -> KiroService:
    """获取Kiro服务实例（带Redis缓存支持）"""
    return KiroService(db, redis)


def get_codex_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis),
) -> CodexService:
    return CodexService(db, redis)


def get_gemini_cli_api_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis),
) -> GeminiCLIAPIService:
    return GeminiCLIAPIService(db, redis)


def get_zai_tts_service(
    db: AsyncSession = Depends(get_db_session),
) -> ZaiTTSService:
    return ZaiTTSService(db)


def get_zai_image_service(
    db: AsyncSession = Depends(get_db_session),
) -> ZaiImageService:
    return ZaiImageService(db)


@router.get(
    "/models",
    summary="获取模型列表",
    description="获取可用的AI模型列表（OpenAI兼容）。根据API key的config_type自动选择Antigravity / Kiro / Qwen / Codex配置"
)
async def list_models(
    request: Request,
    current_user: User = Depends(get_user_flexible),
    antigravity_service: PluginAPIService = Depends(get_plugin_api_service),
    kiro_service: KiroService = Depends(get_kiro_service),
    codex_service: CodexService = Depends(get_codex_service),
    gemini_cli_service: GeminiCLIAPIService = Depends(get_gemini_cli_api_service),
):
    """
    获取模型列表
    支持API key或JWT token认证
    
    **配置选择:**
    - 使用API key认证时，根据API key创建时选择的config_type自动选择配置（antigravity/kiro/qwen/codex）
    - 使用JWT token认证时，默认使用Antigravity配置，但可以通过X-Api-Type请求头指定配置（antigravity/kiro/qwen/codex）
    - Kiro配置需要beta权限（qwen不需要）
    """
    try:
        # 判断使用哪个服务
        # 如果用户有config_type属性（来自API key），使用该配置
        config_type = getattr(current_user, '_config_type', None)
        
        # 如果是JWT token认证（无_config_type），检查请求头
        if config_type is None:
            api_type = request.headers.get("X-Api-Type")
            if api_type in ["kiro", "antigravity", "qwen", "codex", "gemini-cli"]:
                config_type = api_type
        
        use_kiro = config_type == "kiro"
        use_codex = config_type == "codex"
        use_gemini_cli = config_type == "gemini-cli"
        
        if config_type == "zai-image":
            result = {"object": "list", "data": []}
        elif use_codex:
            result = await codex_service.openai_list_models()
        elif use_gemini_cli:
            result = await gemini_cli_service.openai_list_models(user_id=current_user.id)
        elif use_kiro:
            # 检查 beta 权限（管理员放行）
            if current_user.beta != 1 and getattr(current_user, "trust_level", 0) < 3:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Kiro配置仅对beta计划用户开放"
                )
            result = await kiro_service.get_models(current_user.id)
        else:
            # 默认使用Antigravity，传递config_type
            result = await antigravity_service.get_models(current_user.id, config_type=config_type)
        
        return _inject_local_models(result)
    except HTTPException:
        raise
    except UpstreamAPIError as e:
        # 返回上游API的错误消息
        return JSONResponse(
            status_code=e.status_code,
            content={
                "error": e.extracted_message,
                "type": "api_error"
            }
        )
    except httpx.HTTPStatusError as e:
        # 直接返回上游API的原始响应（Antigravity服务）
        upstream_response = getattr(e, 'response_data', None)
        if upstream_response is None:
            try:
                upstream_response = e.response.json()
            except Exception:
                upstream_response = {"error": e.response.text}
        
        return JSONResponse(
            status_code=e.response.status_code,
            content=upstream_response
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取模型列表失败: {str(e)}"
        )


@router.post(
    "/audio/speech",
    summary="OpenAI 兼容 TTS",
    description="ZAI TTS 接入的 /v1/audio/speech 兼容端点",
)
async def audio_speech(
    raw_request: Request,
    current_user: User = Depends(get_user_flexible),
    zai_tts_service: ZaiTTSService = Depends(get_zai_tts_service),
):
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)

    try:
        request_json = await raw_request.json()
    except Exception:
        request_json = dict(raw_request.query_params)

    if not isinstance(request_json, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Request body must be a JSON object")

    input_text = str(request_json.get("input") or "").strip()
    voice_id = str(request_json.get("voice") or "").strip()
    speed = request_json.get("speed", 1.0)
    volume = request_json.get("volume", 1)
    stream = bool(request_json.get("stream"))
    model_name = str(request_json.get("model") or "").strip() or "zai-tts"

    async def _record_usage(
        success: bool,
        status_code: Optional[int],
        error_message: Optional[str] = None,
        *,
        tts_voice_id: Optional[str] = None,
        tts_account_id: Optional[str] = None,
    ):
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type="zai-tts",
            stream=stream,
            success=success,
            status_code=status_code,
            error_message=error_message,
            duration_ms=duration_ms,
            tts_voice_id=tts_voice_id,
            tts_account_id=tts_account_id,
        )

    # 选择账号：voice 必须匹配已保存的音色ID，否则拒绝（403）
    try:
        account = await zai_tts_service.select_active_account(current_user.id, voice_id=voice_id or None)
    except PermissionError as e:
        await _record_usage(False, status.HTTP_403_FORBIDDEN, str(e), tts_voice_id=voice_id or None, tts_account_id=None)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, str(e), tts_voice_id=voice_id or None, tts_account_id=None)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    resolved_voice_id = voice_id or (account.voice_id or "system_001")

    if stream:
        try:
            audio_generator, _, _ = await zai_tts_service.stream_audio(
                account=account,
                input_text=input_text,
                voice_id=resolved_voice_id,
                speed=float(speed),
                volume=int(float(volume)),
            )
        except Exception as e:
            await _record_usage(False, 500, str(e), tts_voice_id=resolved_voice_id, tts_account_id=account.zai_user_id)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

        async def generate():
            success = True
            status_code = 200
            error_message = None
            try:
                async for chunk in audio_generator:
                    yield chunk
            except Exception as e:
                success = False
                status_code = 500
                error_message = str(e)
                logger.error("zai-tts stream failed: user_id=%s error=%s", current_user.id, str(e))
                raise
            finally:
                await _record_usage(
                    success,
                    status_code,
                    error_message,
                    tts_voice_id=resolved_voice_id,
                    tts_account_id=account.zai_user_id,
                )

        return StreamingResponse(generate(), media_type="audio/wav")

    try:
        filepath = await zai_tts_service.generate_file(
            account=account,
            input_text=input_text,
            voice_id=resolved_voice_id,
            speed=float(speed),
            volume=int(float(volume)),
        )
        await _record_usage(True, 200, None, tts_voice_id=resolved_voice_id, tts_account_id=account.zai_user_id)
        return FileResponse(
            filepath,
            media_type="audio/wav",
            filename=os.path.basename(filepath),
        )
    except Exception as e:
        await _record_usage(False, 500, str(e), tts_voice_id=resolved_voice_id, tts_account_id=account.zai_user_id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post(
    "/images/generations",
    summary="图片生成（OpenAI 兼容）",
    description="ZAI Image 接入的 /v1/images/generations 兼容端点（model=glm-image）",
)
async def image_generations(
    raw_request: Request,
    current_user: User = Depends(get_user_flexible),
    zai_image_service: ZaiImageService = Depends(get_zai_image_service),
):
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)

    async def _record_usage(
        success: bool,
        status_code: Optional[int],
        error_message: Optional[str] = None,
        *,
        quota_consumed: float = 0.0,
    ):
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=LOCAL_IMAGE_MODEL_ID,
            config_type="zai-image",
            stream=False,
            quota_consumed=quota_consumed,
            input_tokens=0,
            output_tokens=0,
            total_tokens=0,
            success=success,
            status_code=status_code,
            error_message=error_message,
            duration_ms=duration_ms,
        )

    try:
        request_json = await raw_request.json()
    except Exception:
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, "Invalid JSON request body")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON request body")

    if not isinstance(request_json, dict):
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, "Request body must be a JSON object")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Request body must be a JSON object")

    prompt = str(request_json.get("prompt") or "").strip()
    if not prompt:
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, "prompt is required")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="prompt is required")

    model_name = str(request_json.get("model") or "").strip() or LOCAL_IMAGE_MODEL_ID
    if not _is_local_image_model(model_name):
        supported = ", ".join(LOCAL_IMAGE_MODEL_IDS)
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, f"Only model(s) {supported} are supported")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only model(s) {supported} are supported",
        )

    response_format = str(request_json.get("response_format") or "url").strip() or "url"
    if response_format not in ("url", "b64_json"):
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, "response_format must be url or b64_json")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="response_format must be url or b64_json",
        )

    n_raw = request_json.get("n", 1)
    try:
        n = int(n_raw)
    except Exception:
        n = 1
    if n < 1 or n > 4:
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, "n must be between 1 and 4")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="n must be between 1 and 4")

    size_value = str(request_json.get("size") or "").strip()
    quality_value = str(request_json.get("quality") or "").strip()

    if not size_value and not quality_value:
        ratio, resolution = "16:9", "2K"
    else:
        if size_value:
            ratio, resolution = _openai_size_to_zai_image_config(size_value)
        else:
            ratio, resolution = "16:9", "2K"

        quality_resolution = _openai_quality_to_zai_image_resolution(quality_value)
        if quality_resolution:
            resolution = quality_resolution

    try:
        account = await zai_image_service.select_active_account(current_user.id)
        data_items: list[dict] = []

        for _ in range(n):
            info = await zai_image_service.generate_image(
                account=account,
                prompt=prompt,
                ratio=ratio,
                resolution=resolution,
                rm_label_watermark=True,
            )
            b64, _mime = await zai_image_service.fetch_image_base64(info["image_url"])
            # 兼容：部分客户端只接受 base64；同时把 url 追加在最后，方便调试/追溯。
            data_items.append({"b64_json": b64, "url": info["image_url"]})

        await _record_usage(True, 200, None, quota_consumed=float(n))
        return {"created": int(time.time()), "data": data_items}

    except HTTPException as e:
        await _record_usage(False, e.status_code, str(getattr(e, "detail", e)))
        raise
    except ValueError as e:
        await _record_usage(False, status.HTTP_400_BAD_REQUEST, str(e))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        await _record_usage(False, 500, str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post(
    "/responses",
    summary="Responses API（兼容）",
    description="兼容 OpenAI `/v1/responses`，内部转换为 `/v1/chat/completions` 再返回 Responses JSON/SSE。",
)
async def responses(
    raw_request: Request,
    current_user: User = Depends(get_user_flexible),
    antigravity_service: PluginAPIService = Depends(get_plugin_api_service),
    kiro_service: KiroService = Depends(get_kiro_service),
    codex_service: CodexService = Depends(get_codex_service),
):
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)

    try:
        request_json = await raw_request.json()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON request body")

    if not isinstance(request_json, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Request body must be a JSON object")

    model_name = request_json.get("model")

    # 判断使用哪个服务（逻辑保持与 /chat/completions 一致）
    config_type = getattr(current_user, "_config_type", None)
    if config_type is None:
        api_type = raw_request.headers.get("X-Api-Type")
        if api_type in ["kiro", "antigravity", "qwen", "codex"]:
            config_type = api_type

    effective_config_type = config_type or "antigravity"
    use_kiro = effective_config_type == "kiro"
    use_codex = effective_config_type == "codex"

    try:
        if use_codex:
            stream = bool(request_json.get("stream"))

            if stream:
                tracker = SSEUsageTracker()
                client, resp, _account = await codex_service.open_codex_responses_stream(
                    user_id=current_user.id,
                    request_data=request_json,
                    user_agent=raw_request.headers.get("User-Agent"),
                )

                async def generate():
                    had_exception = False
                    try:
                        async for chunk in resp.aiter_bytes():
                            if isinstance(chunk, (bytes, bytearray)):
                                b = bytes(chunk)
                            else:
                                b = str(chunk).encode("utf-8", errors="replace")
                            tracker.feed(b)
                            yield b
                    except asyncio.CancelledError:
                        had_exception = True
                        tracker.success = False
                        tracker.status_code = tracker.status_code or 499
                        tracker.error_message = tracker.error_message or "client disconnected"
                        return
                    except Exception as e:
                        had_exception = True
                        tracker.success = False
                        tracker.status_code = tracker.status_code or 500
                        tracker.error_message = str(e)
                        logger.error(
                            "codex /v1/responses stream failed: user_id=%s error=%s",
                            current_user.id,
                            type(e).__name__,
                            exc_info=True,
                        )
                        yield _responses_sse_error(
                            str(e) or "Codex upstream request failed",
                            code=tracker.status_code or 500,
                            error_type="codex_upstream_error",
                        )
                        return
                    finally:
                        tracker.finalize()
                        duration_ms = int((time.monotonic() - start_time) * 1000)
                        await UsageLogService.record(
                            user_id=current_user.id,
                            api_key_id=api_key_id,
                            endpoint=endpoint,
                            method=method,
                            model_name=model_name,
                            config_type="codex",
                            stream=True,
                            input_tokens=tracker.input_tokens,
                            output_tokens=tracker.output_tokens,
                            total_tokens=tracker.total_tokens,
                            success=(False if had_exception else tracker.success),
                            status_code=tracker.status_code or (500 if had_exception else 200),
                            error_message=tracker.error_message,
                            duration_ms=duration_ms,
                        )
                        if _account is not None and (
                            tracker.input_tokens
                            or tracker.output_tokens
                            or tracker.cached_tokens
                            or tracker.total_tokens
                        ):
                            account_id = int(getattr(_account, "id", 0) or 0)
                            if account_id:
                                uncached_input = max(tracker.input_tokens - tracker.cached_tokens, 0)
                                await codex_service.record_account_consumed_tokens(
                                    user_id=current_user.id,
                                    account_id=account_id,
                                    input_tokens=uncached_input,
                                    output_tokens=tracker.output_tokens,
                                    cached_tokens=tracker.cached_tokens,
                                    total_tokens=tracker.total_tokens,
                                )
                        if resp is not None:
                            try:
                                await resp.aclose()
                            except Exception:
                                pass
                        if client is not None:
                            try:
                                await client.aclose()
                            except Exception:
                                pass

                return StreamingResponse(
                    generate(),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                )

            resp_obj, account = await codex_service.execute_codex_responses(
                user_id=current_user.id,
                request_data=request_json,
                user_agent=raw_request.headers.get("User-Agent"),
            )

            duration_ms = int((time.monotonic() - start_time) * 1000)
            in_tok, out_tok, total_tok, cached_tok = extract_openai_usage_details(resp_obj)
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model_name,
                config_type="codex",
                stream=False,
                input_tokens=in_tok,
                output_tokens=out_tok,
                total_tokens=total_tok,
                success=True,
                status_code=200,
                duration_ms=duration_ms,
            )
            if any([in_tok, out_tok, total_tok, cached_tok]):
                account_id = int(getattr(account, "id", 0) or 0)
                if account_id:
                    uncached_input = max(in_tok - cached_tok, 0)
                    await codex_service.record_account_consumed_tokens(
                        user_id=current_user.id,
                        account_id=account_id,
                        input_tokens=uncached_input,
                        output_tokens=out_tok,
                        cached_tokens=cached_tok,
                        total_tokens=total_tok,
                    )
            return JSONResponse(content=resp_obj)

        if use_kiro and current_user.beta != 1 and getattr(current_user, "trust_level", 0) < 3:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Kiro配置仅对beta计划用户开放",
            )

        extra_headers: Dict[str, str] = {}
        if config_type:
            extra_headers["X-Account-Type"] = config_type

        chat_req = responses_request_to_chat_completions_request(request_json)
        stream = bool(chat_req.get("stream"))

        if stream:
            tracker = SSEUsageTracker()
            translator = ChatCompletionsToResponsesSSETranslator(original_request=request_json)

            async def generate():
                had_exception = False
                try:
                    if use_kiro:
                        async for chunk in kiro_service.chat_completions_stream(
                            user_id=current_user.id,
                            request_data=chat_req,
                        ):
                            b = bytes(chunk) if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8", errors="replace")
                            tracker.feed(b)
                            events, done = translator.feed(b)
                            for ev in events:
                                yield ev
                            if done:
                                break
                    else:
                        async for chunk in antigravity_service.proxy_stream_request(
                            user_id=current_user.id,
                            method="POST",
                            path="/v1/chat/completions",
                            json_data=chat_req,
                            extra_headers=extra_headers if extra_headers else None,
                        ):
                            tracker.feed(chunk)
                            events, done = translator.feed(chunk)
                            for ev in events:
                                yield ev
                            if done:
                                break
                except asyncio.CancelledError:
                    had_exception = True
                    tracker.success = False
                    tracker.status_code = tracker.status_code or 499
                    tracker.error_message = tracker.error_message or "client disconnected"
                    return
                except Exception as e:
                    had_exception = True
                    tracker.success = False
                    tracker.status_code = tracker.status_code or 500
                    tracker.error_message = str(e)
                    logger.error(
                        "/v1/responses stream failed: user_id=%s config_type=%s error=%s",
                        current_user.id,
                        effective_config_type,
                        type(e).__name__,
                        exc_info=True,
                    )
                    yield _responses_sse_error(
                        str(e) or "Upstream request failed",
                        code=tracker.status_code or 500,
                        error_type="upstream_error",
                    )
                    return
                finally:
                    tracker.finalize()

                    # 正常结束才补 response.completed（异常时不要乱发“completed”）
                    if not had_exception:
                        usage = None
                        if tracker.total_tokens:
                            usage = {
                                "input_tokens": tracker.input_tokens,
                                "output_tokens": tracker.output_tokens,
                                "total_tokens": tracker.total_tokens,
                            }
                        for ev in translator.finalize(usage=usage):
                            yield ev

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
                        total_tokens=tracker.total_tokens,
                        success=tracker.success,
                        status_code=tracker.status_code,
                        error_message=tracker.error_message,
                        duration_ms=duration_ms,
                    )

            return StreamingResponse(
                generate(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        # 非流式：直接拿 chat.completions JSON，再转换为 responses JSON
        if use_kiro:
            chat_resp = await kiro_service.chat_completions(current_user.id, chat_req)
        else:
            chat_resp = await antigravity_service.proxy_request(
                user_id=current_user.id,
                method="POST",
                path="/v1/chat/completions",
                json_data=chat_req,
                extra_headers=extra_headers if extra_headers else None,
            )

        duration_ms = int((time.monotonic() - start_time) * 1000)
        in_tok, out_tok, total_tok = extract_openai_usage(chat_resp)
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
        )
        return JSONResponse(content=chat_completions_response_to_responses_response(chat_resp, original_request=request_json))

    except HTTPException as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request_json.get("stream")) if isinstance(request_json, dict) else False,
            success=False,
            status_code=e.status_code,
            error_message=str(e.detail) if hasattr(e, "detail") else str(e),
            duration_ms=duration_ms,
        )
        raise
    except UpstreamAPIError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request_json.get("stream")) if isinstance(request_json, dict) else False,
            success=False,
            status_code=e.status_code,
            error_message=e.extracted_message,
            duration_ms=duration_ms,
        )
        return JSONResponse(
            status_code=e.status_code,
            content={"error": e.extracted_message, "type": "api_error"},
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
            stream=bool(request_json.get("stream")) if isinstance(request_json, dict) else False,
            success=False,
            status_code=e.response.status_code,
            error_message=error_message,
            duration_ms=duration_ms,
        )
        return JSONResponse(status_code=e.response.status_code, content=upstream_response)
    except ValueError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request_json.get("stream")) if isinstance(request_json, dict) else False,
            success=False,
            status_code=status.HTTP_400_BAD_REQUEST,
            error_message=str(e),
            duration_ms=duration_ms,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model_name,
            config_type=effective_config_type,
            stream=bool(request_json.get("stream")) if isinstance(request_json, dict) else False,
            success=False,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            error_message=str(e),
            duration_ms=duration_ms,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Responses失败: {str(e)}",
        )


@router.post(
    "/chat/completions",
    summary="聊天补全",
    description="使用plug-in-api进行聊天补全（OpenAI兼容）。根据API key的config_type自动选择Antigravity / Kiro / Qwen配置"
)
async def chat_completions(
    request: ChatCompletionRequest,
    raw_request: Request,
    current_user: User = Depends(get_user_flexible),
    antigravity_service: PluginAPIService = Depends(get_plugin_api_service),
    kiro_service: KiroService = Depends(get_kiro_service),
    gemini_cli_service: GeminiCLIAPIService = Depends(get_gemini_cli_api_service),
    zai_image_service: ZaiImageService = Depends(get_zai_image_service),
):
    """
    聊天补全
    支持两种认证方式：
    1. API key认证 - 用于程序调用，根据API key的config_type自动选择配置
    2. JWT token认证 - 用于网页聊天，默认使用Antigravity配置，但可以通过X-Api-Type请求头指定配置（antigravity/kiro/qwen）
    
    **配置选择:**
    - 使用API key时，根据创建时选择的config_type（antigravity/kiro/qwen）自动路由
    - 使用JWT token时，默认使用Antigravity配置，但可以通过X-Api-Type请求头指定配置（antigravity/kiro/qwen）
    - Kiro配置需要beta权限（qwen不需要）
    
    我们使用用户对应的plug-in key调用plug-in-api
    """
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)
    model_name = getattr(request, "model", None)

    if _is_local_image_model(model_name):
        request_data = request.model_dump()

        try:
            prompt = _extract_openai_chat_text_prompt(request_data.get("messages"))
            if not prompt:
                raise ValueError("prompt is required")

            n_raw = request_data.get("n", 1)
            try:
                n = int(n_raw)
            except Exception:
                n = 1
            if n < 1 or n > 4:
                raise ValueError("n must be between 1 and 4")

            response_format_raw = request_data.get("response_format")
            image_response_format = "url"
            if isinstance(response_format_raw, str) and response_format_raw.strip():
                image_response_format = response_format_raw.strip()
            if image_response_format not in ("url", "b64_json"):
                raise ValueError("response_format must be url or b64_json")

            size_value = str(request_data.get("size") or "").strip()
            quality_value = str(request_data.get("quality") or "").strip()

            if not size_value and not quality_value:
                ratio, resolution = "16:9", "2K"
            else:
                if size_value:
                    ratio, resolution = _openai_size_to_zai_image_config(size_value)
                else:
                    ratio, resolution = "16:9", "2K"

                quality_resolution = _openai_quality_to_zai_image_resolution(quality_value)
                if quality_resolution:
                    resolution = quality_resolution

            account = await zai_image_service.select_active_account(current_user.id)
            outputs: list[str] = []

            for _ in range(n):
                info = await zai_image_service.generate_image(
                    account=account,
                    prompt=prompt,
                    ratio=ratio,
                    resolution=resolution,
                    rm_label_watermark=True,
                )

                b64, _mime = await zai_image_service.fetch_image_base64(info["image_url"])
                # 兼容：返回 base64，并把 url 放在末尾（同一条 content 内换行分隔）。
                outputs.append(f"{b64}\n{info['image_url']}")

            duration_ms = int((time.monotonic() - start_time) * 1000)
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=LOCAL_IMAGE_MODEL_ID,
                config_type="zai-image",
                stream=bool(request.stream),
                quota_consumed=float(n),
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                success=True,
                status_code=200,
                duration_ms=duration_ms,
            )

            created_ts = int(time.time())
            completion_id = f"chatcmpl-{uuid.uuid4().hex}"
            response_model = str(model_name or LOCAL_IMAGE_MODEL_ID)

            if request.stream:

                async def generate():
                    for idx, out in enumerate(outputs):
                        chunk = {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created_ts,
                            "model": response_model,
                            "choices": [
                                {
                                    "index": idx,
                                    "delta": {"role": "assistant", "content": out},
                                    "finish_reason": None,
                                }
                            ],
                        }
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                        done_chunk = {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created_ts,
                            "model": response_model,
                            "choices": [
                                {
                                    "index": idx,
                                    "delta": {},
                                    "finish_reason": "stop",
                                }
                            ],
                        }
                        yield f"data: {json.dumps(done_chunk, ensure_ascii=False)}\n\n"

                    yield "data: [DONE]\n\n"

                return StreamingResponse(
                    generate(),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                )

            choices = [
                {
                    "index": idx,
                    "message": {"role": "assistant", "content": out},
                    "finish_reason": "stop",
                }
                for idx, out in enumerate(outputs)
            ]

            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created_ts,
                "model": response_model,
                "choices": choices,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        except ValueError as e:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=LOCAL_IMAGE_MODEL_ID,
                config_type="zai-image",
                stream=bool(request.stream),
                quota_consumed=0.0,
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                success=False,
                status_code=status.HTTP_400_BAD_REQUEST,
                error_message=str(e),
                duration_ms=duration_ms,
            )
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        except Exception as e:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=LOCAL_IMAGE_MODEL_ID,
                config_type="zai-image",
                stream=bool(request.stream),
                quota_consumed=0.0,
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                success=False,
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                error_message=str(e),
                duration_ms=duration_ms,
            )
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    # 判断使用哪个服务
    config_type = getattr(current_user, "_config_type", None)
    if config_type is None:
        api_type = raw_request.headers.get("X-Api-Type")
        if api_type in ["kiro", "antigravity", "qwen", "codex", "gemini-cli"]:
            config_type = api_type

    effective_config_type = config_type or "antigravity"
    use_kiro = effective_config_type == "kiro"
    use_codex = effective_config_type == "codex"
    use_gemini_cli = effective_config_type == "gemini-cli"

    try:
        if use_codex:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Codex 账号请使用 /v1/responses（Responses API）",
            )

        if use_kiro and current_user.beta != 1 and getattr(current_user, "trust_level", 0) < 3:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Kiro配置仅对beta计划用户开放",
            )

        extra_headers: Dict[str, str] = {}
        if config_type:
            extra_headers["X-Account-Type"] = config_type

        if request.stream:
            tracker = SSEUsageTracker()

            async def generate():
                try:
                    if use_gemini_cli:
                        async for chunk in gemini_cli_service.openai_chat_completions_stream(
                            user_id=current_user.id,
                            request_data=request.model_dump(),
                        ):
                            tracker.feed(chunk)
                            yield chunk
                    elif use_kiro:
                        async for chunk in kiro_service.chat_completions_stream(
                            user_id=current_user.id,
                            request_data=request.model_dump(),
                        ):
                            if isinstance(chunk, (bytes, bytearray)):
                                tracker.feed(bytes(chunk))
                            else:
                                tracker.feed(str(chunk).encode("utf-8", errors="replace"))
                            yield chunk
                    else:
                        async for chunk in antigravity_service.proxy_stream_request(
                            user_id=current_user.id,
                            method="POST",
                            path="/v1/chat/completions",
                            json_data=request.model_dump(),
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
                        total_tokens=tracker.total_tokens,
                        success=tracker.success,
                        status_code=tracker.status_code,
                        error_message=tracker.error_message,
                        duration_ms=duration_ms,
                    )

            return StreamingResponse(
                generate(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        # 非流式请求
        if use_gemini_cli:
            result = await gemini_cli_service.openai_chat_completions(
                user_id=current_user.id,
                request_data=request.model_dump(),
            )
            duration_ms = int((time.monotonic() - start_time) * 1000)
            in_tok, out_tok, total_tok = extract_openai_usage(result)
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
            )
            return result

        if use_kiro:
            openai_stream = kiro_service.chat_completions_stream(
                user_id=current_user.id,
                request_data=request.model_dump(),
            )
        else:
            openai_stream = antigravity_service.proxy_stream_request(
                user_id=current_user.id,
                method="POST",
                path="/v1/chat/completions",
                json_data=request.model_dump(),
                extra_headers=extra_headers if extra_headers else None,
            )

        tracker = SSEUsageTracker()

        async def tracked_stream():
            async for chunk in openai_stream:
                if isinstance(chunk, (bytes, bytearray)):
                    tracker.feed(bytes(chunk))
                else:
                    tracker.feed(str(chunk).encode("utf-8", errors="replace"))
                yield chunk

        result = await AnthropicAdapter.collect_openai_stream_to_response(tracked_stream())
        tracker.finalize()

        duration_ms = int((time.monotonic() - start_time) * 1000)

        # 上游在 stream 里用 `data: {"error": ...}` 传错；非流式模式下必须识别出来，否则前端/调用方会收到空响应。
        if not tracker.success:
            code = tracker.status_code or status.HTTP_502_BAD_GATEWAY
            error_payload = {
                "error": {
                    "message": tracker.error_message or "upstream_error",
                    "type": "upstream_error",
                    "code": code,
                }
            }
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model_name,
                config_type=effective_config_type,
                stream=False,
                input_tokens=tracker.input_tokens,
                output_tokens=tracker.output_tokens,
                total_tokens=tracker.total_tokens,
                success=False,
                status_code=code,
                error_message=tracker.error_message,
                duration_ms=duration_ms,
            )
            return JSONResponse(status_code=code, content=error_payload)

        in_tok, out_tok, total_tok = extract_openai_usage(result)
        if total_tok == 0 and tracker.total_tokens:
            in_tok, out_tok, total_tok = tracker.input_tokens, tracker.output_tokens, tracker.total_tokens

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
        )
        return result

    except HTTPException as e:
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
            status_code=e.status_code,
            error_message=str(e.detail) if hasattr(e, "detail") else str(e),
            duration_ms=duration_ms,
        )
        raise
    except UpstreamAPIError as e:
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
            status_code=e.status_code,
            error_message=e.extracted_message,
            duration_ms=duration_ms,
        )
        return JSONResponse(
            status_code=e.status_code,
            content={
                "error": e.extracted_message,
                "type": "api_error",
            },
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
        )

        return JSONResponse(
            status_code=e.response.status_code,
            content=upstream_response,
        )
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
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
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
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"聊天补全失败: {str(e)}",
        )
