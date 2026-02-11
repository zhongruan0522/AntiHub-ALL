"""
用量统计服务

目标：
1) 记录所有调用（成功/失败都要记录）
2) 流式与非流式都尽量提取 usage（tokens）
3) 记录失败原因但不影响主流程
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

from sqlalchemy import delete, select

from app.db.session import get_session_maker
from app.models.usage_log import UsageLog
from app.repositories.usage_counter_repository import UsageCounterRepository

logger = logging.getLogger(__name__)

MAX_ERROR_MESSAGE_LENGTH = 2000
MAX_LOGS_PER_CHANNEL = 200
MAX_REQUEST_BODY_LENGTH = 65536  # 64KB，防止请求体过大
MAX_CLIENT_APP_LENGTH = 128


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def _truncate_message(message: Optional[str]) -> Optional[str]:
    if message is None:
        return None
    msg = str(message)
    if len(msg) <= MAX_ERROR_MESSAGE_LENGTH:
        return msg
    return msg[:MAX_ERROR_MESSAGE_LENGTH] + "…"


def _truncate_request_body(body: Any) -> Optional[str]:
    """将请求体转换为JSON字符串并截断"""
    if body is None:
        return None
    try:
        json_str = json.dumps(body, ensure_ascii=False, default=str)
        if len(json_str) <= MAX_REQUEST_BODY_LENGTH:
            return json_str
        return json_str[:MAX_REQUEST_BODY_LENGTH] + "…"
    except Exception:
        return None


def _truncate_client_app(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    if not text:
        return None
    if len(text) <= MAX_CLIENT_APP_LENGTH:
        return text
    return text[:MAX_CLIENT_APP_LENGTH]


def _config_type_filter(config_type: Optional[str]):
    if config_type is None:
        return UsageLog.config_type.is_(None)
    return UsageLog.config_type == config_type


async def _trim_usage_logs(
    db,
    *,
    user_id: int,
    config_type: Optional[str],
    keep: int = MAX_LOGS_PER_CHANNEL,
) -> None:
    if keep <= 0:
        stmt = delete(UsageLog).where(UsageLog.user_id == user_id).where(
            _config_type_filter(config_type)
        )
        await db.execute(stmt)
        return

    ids_to_delete = (
        select(UsageLog.id)
        .where(UsageLog.user_id == user_id)
        .where(_config_type_filter(config_type))
        .order_by(UsageLog.created_at.desc(), UsageLog.id.desc())
        .offset(keep)
    )
    await db.execute(delete(UsageLog).where(UsageLog.id.in_(ids_to_delete)))


def extract_openai_usage(payload: Dict[str, Any]) -> Tuple[int, int, int]:
    """
    从 OpenAI/兼容格式中提取 token 用量。

    兼容：
    - payload.usage.prompt_tokens / completion_tokens / total_tokens
    - payload.usage.input_tokens / output_tokens
    - payload.x_groq.usage.prompt_tokens / completion_tokens / total_tokens
    """
    usage: Dict[str, Any] = {}

    raw_usage = payload.get("usage")
    if isinstance(raw_usage, dict):
        usage = raw_usage

    # OpenAI Responses streaming: data 里是 event wrapper（含 response 字段）
    if not usage:
        response_obj = payload.get("response")
        if isinstance(response_obj, dict) and isinstance(response_obj.get("usage"), dict):
            usage = response_obj["usage"]

    if not usage:
        x_groq = payload.get("x_groq")
        if isinstance(x_groq, dict) and isinstance(x_groq.get("usage"), dict):
            usage = x_groq["usage"]

    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
    output_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0))
    total_tokens = usage.get("total_tokens", None)

    input_tokens_i = _safe_int(input_tokens, 0)
    output_tokens_i = _safe_int(output_tokens, 0)
    total_tokens_i = _safe_int(total_tokens, input_tokens_i + output_tokens_i)

    return input_tokens_i, output_tokens_i, total_tokens_i


def extract_openai_usage_details(payload: Dict[str, Any]) -> Tuple[int, int, int, int]:
    """
    在 extract_openai_usage 的基础上，额外提取 cached_tokens（若存在）。

    cached_tokens 兼容：
    - usage.cached_tokens / usage.cache_tokens
    - usage.prompt_tokens_details.cached_tokens
    - usage.input_tokens_details.cached_tokens
    """
    input_tokens_i, output_tokens_i, total_tokens_i = extract_openai_usage(payload)

    usage: Dict[str, Any] = {}

    raw_usage = payload.get("usage")
    if isinstance(raw_usage, dict):
        usage = raw_usage

    # OpenAI Responses streaming: data 里是 event wrapper（含 response 字段）
    if not usage:
        response_obj = payload.get("response")
        if isinstance(response_obj, dict) and isinstance(response_obj.get("usage"), dict):
            usage = response_obj["usage"]

    if not usage:
        x_groq = payload.get("x_groq")
        if isinstance(x_groq, dict) and isinstance(x_groq.get("usage"), dict):
            usage = x_groq["usage"]

    cached_tokens = max(
        _safe_int(usage.get("cached_tokens"), 0),
        _safe_int(usage.get("cache_tokens"), 0),
    )

    prompt_details = usage.get("prompt_tokens_details")
    if isinstance(prompt_details, dict):
        cached_tokens = max(
            cached_tokens,
            _safe_int(prompt_details.get("cached_tokens"), 0),
            _safe_int(prompt_details.get("cache_tokens"), 0),
        )

    input_details = usage.get("input_tokens_details")
    if isinstance(input_details, dict):
        cached_tokens = max(
            cached_tokens,
            _safe_int(input_details.get("cached_tokens"), 0),
            _safe_int(input_details.get("cache_tokens"), 0),
        )

    return input_tokens_i, output_tokens_i, total_tokens_i, max(cached_tokens, 0)


@dataclass
class SSEUsageTracker:
    """
    轻量 SSE 解析器：从流式响应里尽量捕获 usage 和 error。

    只解析以 `data: ` 开头的行，忽略 event: 等字段。
    """

    buffer: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    success: bool = True
    status_code: Optional[int] = None
    error_message: Optional[str] = None
    _seen_usage: bool = False

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
            if data_str == "[DONE]":
                continue

            try:
                payload = json.loads(data_str)
            except Exception:
                continue

            if isinstance(payload, dict):
                # usage
                in_tok, out_tok, total_tok, cached_tok = extract_openai_usage_details(payload)
                if in_tok or out_tok or total_tok or cached_tok:
                    self.input_tokens = in_tok
                    self.output_tokens = out_tok
                    self.total_tokens = total_tok
                    self.cached_tokens = cached_tok
                    self._seen_usage = True

                # error（兼容 Responses: response.error）
                err = None
                if "error" in payload:
                    err = payload.get("error")
                else:
                    response_obj = payload.get("response")
                    if isinstance(response_obj, dict) and response_obj.get("error") is not None:
                        err = response_obj.get("error")

                if err is not None:
                    self.success = False
                    if isinstance(err, dict):
                        self.error_message = _truncate_message(
                            err.get("message") or err.get("detail") or str(err)
                        )
                        code = err.get("code") or err.get("status") or err.get("status_code")
                        self.status_code = _safe_int(code, self.status_code or 500)
                    else:
                        self.error_message = _truncate_message(str(err))
                        self.status_code = self.status_code or 500

    def finalize(self) -> None:
        if not self._seen_usage:
            self.total_tokens = self.input_tokens + self.output_tokens


class UsageLogService:
    @classmethod
    async def record(
        cls,
        *,
        user_id: int,
        api_key_id: Optional[int],
        endpoint: str,
        method: str,
        model_name: Optional[str],
        config_type: Optional[str],
        stream: bool,
        quota_consumed: float = 0.0,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        total_tokens: int = 0,
        success: bool = True,
        status_code: Optional[int] = None,
        error_message: Optional[str] = None,
        duration_ms: int = 0,
        tts_voice_id: Optional[str] = None,
        tts_account_id: Optional[str] = None,
        client_app: Optional[str] = None,
        request_body: Any = None,
    ) -> None:
        """
        写 usage_log（失败也写），写入失败不影响主流程。
        """
        try:
            session_maker = get_session_maker()
            async with session_maker() as db:
                log = UsageLog(
                    user_id=user_id,
                    api_key_id=api_key_id,
                    endpoint=endpoint,
                    method=method,
                    model_name=model_name,
                    config_type=config_type,
                    stream=stream,
                    quota_consumed=quota_consumed,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    success=success,
                    status_code=status_code,
                    error_message=_truncate_message(error_message),
                    duration_ms=duration_ms,
                    tts_voice_id=tts_voice_id,
                    tts_account_id=tts_account_id,
                    client_app=_truncate_client_app(client_app),
                    request_body=_truncate_request_body(request_body),
                )
                db.add(log)

                # usage_logs 只保留最近 N 条：累计统计需要单独维护
                await UsageCounterRepository(db).increment(
                    user_id=user_id,
                    config_type=config_type,
                    success=success,
                    quota_consumed=quota_consumed,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    total_tokens=total_tokens,
                    duration_ms=duration_ms,
                )
                await db.commit()

                try:
                    await _trim_usage_logs(db, user_id=user_id, config_type=config_type)
                    await db.commit()
                except Exception as e:
                    await db.rollback()
                    logger.warning(f"清理 usage_log 失败: {e}")
        except Exception as e:
            logger.warning(f"记录 usage_log 失败: {e}")
