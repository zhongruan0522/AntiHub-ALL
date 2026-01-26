"""
OpenAI兼容的API端点
支持API key或JWT token认证
根据API key的config_type自动选择Antigravity / Kiro / Qwen / Codex配置
用户通过我们的key/token调用，我们再用plug-in key调用plug-in-api
"""
import asyncio
import json
import logging
import os
from typing import List, Dict, Any, Optional
import time
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
        
        if use_codex:
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
        
        return result
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
