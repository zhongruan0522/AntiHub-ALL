"""
Gemini 兼容 API（v1beta）

- config_type=gemini-cli：仅支持文本类 generateContent / streamGenerateContent
- config_type=zai-image：仅支持本地图片模型（LOCAL_IMAGE_MODELS）生成
- config_type=antigravity：Gemini v1beta <-> OpenAI Chat 翻译闭环（路线A）
"""
from typing import Optional, Dict, Any
import json
import logging
import time
import httpx
from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps_flexible import get_user_flexible_with_goog_api_key
from app.api.deps import get_db_session, get_redis, get_plugin_api_service
from app.cache import RedisClient
from app.core.spec_guard import ensure_spec_allowed
from app.models.user import User
from app.services.plugin_api_service import PluginAPIService
from app.services.gemini_cli_api_service import GeminiCLIAPIService
from app.schemas.plugin_api import GenerateContentRequest
from app.services.usage_log_service import SSEUsageTracker, extract_openai_usage
from app.services.usage_log_service import UsageLogService
from app.services.zai_image_service import ZaiImageService
from app.utils.gemini_openai_chat_compat import (
    ChatCompletionsSSEToGeminiSSETranslator,
    gemini_generate_content_request_to_openai_chat_request,
    openai_chat_response_to_gemini_response,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1beta", tags=["Gemini兼容API"])

LOCAL_IMAGE_MODELS = (
    "glm-image",
    "gemini-3-pro-image-preview",
    "gemini-3-pro-image",
)

class GeminiSSEUsageTracker:
    def __init__(self) -> None:
        self.buffer = ""
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0
        self.success = True
        self.status_code: Optional[int] = None
        self.error_message: Optional[str] = None
        self._seen_usage = False

    def feed(self, chunk: bytes) -> None:
        try:
            self.buffer += chunk.decode("utf-8", errors="replace")
        except Exception:
            return

        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue

            data_str = line[5:].strip()
            if not data_str:
                continue

            try:
                payload = json.loads(data_str)
            except Exception:
                continue

            if not isinstance(payload, dict):
                continue

            # error: {"error": {"message": "...", "code": 429}}
            err = payload.get("error")
            if err is not None:
                self.success = False
                if isinstance(err, dict):
                    self.error_message = str(err.get("message") or err.get("detail") or err)
                    try:
                        self.status_code = int(err.get("code") or err.get("status") or 500)
                    except Exception:
                        self.status_code = self.status_code or 500
                else:
                    self.error_message = str(err)
                    self.status_code = self.status_code or 500

            usage = payload.get("usageMetadata")
            if isinstance(usage, dict):
                prompt = int(usage.get("promptTokenCount") or 0)
                thoughts = int(usage.get("thoughtsTokenCount") or 0)
                completion = int(usage.get("candidatesTokenCount") or 0)
                total = int(usage.get("totalTokenCount") or (prompt + completion))
                self.input_tokens = prompt + thoughts
                self.output_tokens = completion
                self.total_tokens = total
                self._seen_usage = True

    def finalize(self) -> None:
        if not self._seen_usage and self.total_tokens == 0:
            self.total_tokens = int(self.input_tokens) + int(self.output_tokens)


def get_gemini_cli_api_service(
    db: AsyncSession = Depends(get_db_session),
    redis: RedisClient = Depends(get_redis),
) -> GeminiCLIAPIService:
    return GeminiCLIAPIService(db, redis)


def get_zai_image_service(
    db: AsyncSession = Depends(get_db_session),
) -> ZaiImageService:
    return ZaiImageService(db)


def _extract_gemini_text_prompt(req: GenerateContentRequest) -> str:
    texts: list[str] = []
    has_inline = False

    for msg in req.contents or []:
        for part in msg.parts or []:
            if not isinstance(part, dict):
                continue
            if "inlineData" in part:
                has_inline = True
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())

    if has_inline:
        raise ValueError("glm-image 暂不支持图生图（inlineData）")

    return "\n".join(texts).strip()


def _request_has_inline_data(req: GenerateContentRequest) -> bool:
    for msg in req.contents or []:
        for part in msg.parts or []:
            if isinstance(part, dict) and "inlineData" in part:
                return True
    return False


def _resolve_config_type(current_user: User, raw_request: Request) -> Optional[str]:
    config_type = getattr(current_user, "_config_type", None)
    if isinstance(config_type, str) and config_type.strip():
        return config_type.strip().lower()

    api_type = raw_request.headers.get("X-Api-Type") or raw_request.headers.get("X-Account-Type")
    if isinstance(api_type, str) and api_type.strip():
        return api_type.strip().lower()

    return None


@router.post(
    "/models/{model}:generateContent",
    summary="Gemini v1beta generateContent",
    description="Gemini 兼容 generateContent：gemini-cli（文本）/ zai-image（图片，仅LOCAL_IMAGE_MODELS）/ antigravity（路线A：Gemini<->OpenAI Chat 翻译）。支持JWT token、Bearer API key或x-goog-api-key标头认证。"
)
async def generate_content(
    model: str,
    request: GenerateContentRequest,
    raw_request: Request,
    current_user: User = Depends(get_user_flexible_with_goog_api_key),
    plugin_api_service: PluginAPIService = Depends(get_plugin_api_service),
    gemini_cli_service: GeminiCLIAPIService = Depends(get_gemini_cli_api_service),
    zai_image_service: ZaiImageService = Depends(get_zai_image_service),
):
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)

    config_type = _resolve_config_type(current_user, raw_request)
    ensure_spec_allowed("Gemini", config_type)
    effective_config_type = config_type

    try:
        if effective_config_type == "zai-image":
            if model not in LOCAL_IMAGE_MODELS:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="zai-image key only supports local image models",
                )

            async def generate():
                success = True
                status_code = 200
                error_message = None
                quota_consumed = 1.0

                try:
                    prompt = _extract_gemini_text_prompt(request)
                    if not prompt:
                        raise ValueError("prompt 不能为空")

                    image_cfg = None
                    if request.generationConfig and request.generationConfig.imageConfig:
                        image_cfg = request.generationConfig.imageConfig

                    ratio = getattr(image_cfg, "aspectRatio", None) if image_cfg else None
                    resolution = getattr(image_cfg, "imageSize", None) if image_cfg else None

                    account = await zai_image_service.select_active_account(current_user.id)
                    info = await zai_image_service.generate_image(
                        account=account,
                        prompt=prompt,
                        ratio=ratio,
                        resolution=resolution,
                        rm_label_watermark=True,
                    )
                    b64, mime = await zai_image_service.fetch_image_base64(info["image_url"])

                    payload = {
                        "candidates": [
                            {
                                "content": {
                                    "role": "model",
                                    "parts": [
                                        {"inlineData": {"mimeType": mime, "data": b64}},
                                        {"text": info["image_url"]},
                                    ],
                                },
                                "finishReason": "STOP",
                            }
                        ]
                    }
                    yield f"event: result\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except ValueError as e:
                    success = False
                    status_code = status.HTTP_400_BAD_REQUEST
                    error_message = str(e)
                    error_payload = {"error": {"message": error_message, "code": status_code}}
                    yield f"event: error\ndata: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
                except Exception as e:
                    success = False
                    status_code = int(getattr(e, "status_code", None) or 500)
                    error_message = str(getattr(e, "detail", None) or e)
                    error_payload = {"error": {"message": error_message, "code": status_code}}
                    yield f"event: error\ndata: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
                finally:
                    duration_ms = int((time.monotonic() - start_time) * 1000)
                    await UsageLogService.record(
                        user_id=current_user.id,
                        api_key_id=api_key_id,
                        endpoint=endpoint,
                        method=method,
                        model_name="glm-image",
                        config_type="zai-image",
                        stream=True,
                        quota_consumed=quota_consumed if success else 0.0,
                        input_tokens=0,
                        output_tokens=0,
                        total_tokens=0,
                        success=success,
                        status_code=status_code,
                        error_message=error_message,
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

        if effective_config_type == "antigravity":
            openai_request = gemini_generate_content_request_to_openai_chat_request(
                model=model,
                request_data=request.model_dump(),
                stream=False,
            )
            extra_headers: Dict[str, str] = {"X-Account-Type": effective_config_type}
            openai_resp = await plugin_api_service.proxy_request(
                user_id=current_user.id,
                method="POST",
                path="/v1/chat/completions",
                json_data=openai_request,
                extra_headers=extra_headers,
            )

            result = openai_chat_response_to_gemini_response(openai_resp)

            in_tok, out_tok, total_tok = extract_openai_usage(openai_resp)
            duration_ms = int((time.monotonic() - start_time) * 1000)
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
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

        # gemini-cli：只允许文本生成，拒绝图片模型/inlineData/imageConfig
        normalized_model = (model or "").strip().lower()
        if normalized_model in LOCAL_IMAGE_MODELS or "image" in normalized_model:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="gemini-cli 不支持图片模型/图片生成",
            )
        if _request_has_inline_data(request):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="gemini-cli 不支持 inlineData（仅支持纯文本请求）",
            )
        if request.generationConfig and request.generationConfig.imageConfig:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="gemini-cli 不支持 generationConfig.imageConfig",
            )

        result = await gemini_cli_service.gemini_generate_content(
            user_id=current_user.id,
            model=model,
            request_data=request.model_dump(),
        )

        usage = result.get("usageMetadata") if isinstance(result, dict) else None
        if isinstance(usage, dict):
            in_tok = int(usage.get("promptTokenCount") or 0) + int(usage.get("thoughtsTokenCount") or 0)
            out_tok = int(usage.get("candidatesTokenCount") or 0)
            total_tok = int(usage.get("totalTokenCount") or (in_tok + out_tok))
        else:
            in_tok, out_tok, total_tok = 0, 0, 0

        duration_ms = int((time.monotonic() - start_time) * 1000)
        await UsageLogService.record(
            user_id=current_user.id,
            api_key_id=api_key_id,
            endpoint=endpoint,
            method=method,
            model_name=model,
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
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        # 透传上游API的错误响应
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        else:
            detail = error_data

        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=False,
                success=False,
                status_code=e.response.status_code if e.response is not None else None,
                error_message=str(detail),
                duration_ms=duration_ms,
            )

        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=False,
                success=False,
                status_code=status.HTTP_400_BAD_REQUEST,
                error_message=str(e),
                duration_ms=duration_ms,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=False,
                success=False,
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                error_message=str(e),
                duration_ms=duration_ms,
            )
        logger.error(f"Gemini generateContent 失败: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Gemini generateContent 失败: {str(e)}"
        )

@router.post(
    "/models/{model}:streamGenerateContent",
    summary="Gemini v1beta streamGenerateContent",
    description="Gemini 兼容 streamGenerateContent：gemini-cli（文本）/ zai-image（图片，仅LOCAL_IMAGE_MODELS）/ antigravity（路线A：Gemini<->OpenAI Chat 翻译）。支持JWT token、Bearer API key或x-goog-api-key标头认证。"
)
async def stream_generate_content(
    model: str,
    request: GenerateContentRequest,
    raw_request: Request,
    alt: str = Query(default="sse", description="响应格式，默认为sse"),
    current_user: User = Depends(get_user_flexible_with_goog_api_key),
    plugin_api_service: PluginAPIService = Depends(get_plugin_api_service),
    gemini_cli_service: GeminiCLIAPIService = Depends(get_gemini_cli_api_service),
    zai_image_service: ZaiImageService = Depends(get_zai_image_service),
):
    start_time = time.monotonic()
    endpoint = raw_request.url.path
    method = raw_request.method
    api_key_id = getattr(current_user, "_api_key_id", None)

    config_type = _resolve_config_type(current_user, raw_request)
    ensure_spec_allowed("Gemini", config_type)
    effective_config_type = config_type

    try:
        if effective_config_type == "antigravity":
            if alt != "sse":
                raise ValueError("Antigravity route A 目前仅支持 alt=sse 的流式响应")

            api_key = await plugin_api_service.get_user_api_key(current_user.id)
            if not api_key:
                raise ValueError("用户未配置plug-in API密钥")

            openai_request = gemini_generate_content_request_to_openai_chat_request(
                model=model,
                request_data=request.model_dump(),
                stream=True,
            )
            extra_headers: Dict[str, str] = {"X-Account-Type": effective_config_type}

            tracker = SSEUsageTracker()
            translator = ChatCompletionsSSEToGeminiSSETranslator()

            async def generate():
                try:
                    async for chunk in plugin_api_service.proxy_stream_request(
                        user_id=current_user.id,
                        method="POST",
                        path="/v1/chat/completions",
                        json_data=openai_request,
                        extra_headers=extra_headers,
                    ):
                        if isinstance(chunk, (bytes, bytearray)):
                            tracker.feed(bytes(chunk))
                            out_chunks, _done = translator.feed(bytes(chunk))
                        else:
                            raw = str(chunk).encode("utf-8", errors="replace")
                            tracker.feed(raw)
                            out_chunks, _done = translator.feed(raw)
                        for out in out_chunks:
                            yield out
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
                        model_name=model,
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

        if effective_config_type == "gemini-cli":
            if alt != "sse":
                raise ValueError("GeminiCLI 目前仅支持 alt=sse 的流式响应")

            normalized_model = (model or "").strip().lower()
            if normalized_model in LOCAL_IMAGE_MODELS or "image" in normalized_model:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="gemini-cli 不支持图片模型/图片生成",
                )
            if _request_has_inline_data(request):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="gemini-cli 不支持 inlineData（仅支持纯文本请求）",
                )
            if request.generationConfig and request.generationConfig.imageConfig:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="gemini-cli 不支持 generationConfig.imageConfig",
                )

            tracker = GeminiSSEUsageTracker()

            async def generate():
                try:
                    async for chunk in gemini_cli_service.gemini_stream_generate_content(
                        user_id=current_user.id,
                        model=model,
                        request_data=request.model_dump(),
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
                        model_name=model,
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

        # zai-image：仅支持本地图片模型
        if model not in LOCAL_IMAGE_MODELS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="zai-image key only supports local image models",
            )

        async def generate_local():
            success = True
            status_code = 200
            error_message = None
            quota_consumed = 1.0

            try:
                prompt = _extract_gemini_text_prompt(request)
                if not prompt:
                    raise ValueError("prompt is required")

                image_cfg = None
                if request.generationConfig and request.generationConfig.imageConfig:
                    image_cfg = request.generationConfig.imageConfig

                ratio = getattr(image_cfg, "aspectRatio", None) if image_cfg else None
                resolution = getattr(image_cfg, "imageSize", None) if image_cfg else None

                account = await zai_image_service.select_active_account(current_user.id)
                info = await zai_image_service.generate_image(
                    account=account,
                    prompt=prompt,
                    ratio=ratio,
                    resolution=resolution,
                    rm_label_watermark=True,
                )
                b64, mime = await zai_image_service.fetch_image_base64(info["image_url"])

                payload = {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {"inlineData": {"mimeType": mime, "data": b64}},
                                    {"text": info["image_url"]},
                                ],
                            },
                            "finishReason": "STOP",
                        }
                    ]
                }
                yield f"event: result\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            except ValueError as e:
                success = False
                status_code = status.HTTP_400_BAD_REQUEST
                error_message = str(e)
                error_payload = {"error": {"message": error_message, "code": status_code}}
                yield f"event: error\ndata: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
            except Exception as e:
                success = False
                status_code = int(getattr(e, "status_code", None) or 500)
                error_message = str(getattr(e, "detail", None) or e)
                error_payload = {"error": {"message": error_message, "code": status_code}}
                yield f"event: error\ndata: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
            finally:
                duration_ms = int((time.monotonic() - start_time) * 1000)
                await UsageLogService.record(
                    user_id=current_user.id,
                    api_key_id=api_key_id,
                    endpoint=endpoint,
                    method=method,
                    model_name="glm-image",
                    config_type="zai-image",
                    stream=True,
                    quota_consumed=quota_consumed if success else 0.0,
                    input_tokens=0,
                    output_tokens=0,
                    total_tokens=0,
                    success=success,
                    status_code=status_code,
                    error_message=error_message,
                    duration_ms=duration_ms,
                )

        return StreamingResponse(
            generate_local(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        # 透传上游API的错误响应
        error_data = getattr(e, 'response_data', {"detail": str(e)})
        if isinstance(error_data, dict) and 'detail' in error_data:
            detail = error_data['detail']
        else:
            detail = error_data

        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=True,
                success=False,
                status_code=e.response.status_code if e.response is not None else None,
                error_message=str(detail),
                duration_ms=duration_ms,
            )

        raise HTTPException(
            status_code=e.response.status_code,
            detail=detail
        )
    except ValueError as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=True,
                success=False,
                status_code=status.HTTP_400_BAD_REQUEST,
                error_message=str(e),
                duration_ms=duration_ms,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        if effective_config_type in ("gemini-cli", "antigravity"):
            await UsageLogService.record(
                user_id=current_user.id,
                api_key_id=api_key_id,
                endpoint=endpoint,
                method=method,
                model_name=model,
                config_type=effective_config_type,
                stream=True,
                success=False,
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                error_message=str(e),
                duration_ms=duration_ms,
            )
        logger.error(f"Gemini streamGenerateContent 失败: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Gemini streamGenerateContent 失败: {str(e)}"
        )
