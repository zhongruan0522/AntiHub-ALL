from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


def gemini_generate_content_request_to_openai_chat_request(
    *,
    model: str,
    request_data: Dict[str, Any],
    stream: bool,
) -> Dict[str, Any]:
    """
    Gemini v1beta generateContent/streamGenerateContent -> OpenAI ChatCompletions request.

    目标：先做「够用」的最小闭环（路线 A），只覆盖：
    - contents[].role(user/model) + parts[].text/inlineData
    - systemInstruction.parts[].text -> system message
    - generationConfig.temperature/topP/maxOutputTokens -> OpenAI temperature/top_p/max_tokens
    """

    if not isinstance(request_data, dict):
        raise ValueError("request_data 必须是 JSON object")

    out: Dict[str, Any] = {
        "model": (model or "").strip(),
        "messages": [],
        "stream": bool(stream),
    }

    sys_inst = request_data.get("systemInstruction") or request_data.get("system_instruction")
    sys_text = _gemini_system_instruction_to_text(sys_inst)
    if sys_text:
        out["messages"].append({"role": "system", "content": sys_text})

    contents = request_data.get("contents")
    if not isinstance(contents, list) or not contents:
        raise ValueError("Gemini contents 必须是非空数组")

    for idx, msg in enumerate(contents):
        if not isinstance(msg, dict):
            raise ValueError(f"Gemini contents[{idx}] 必须是 object")
        role = str(msg.get("role") or "").strip().lower()
        if role == "user":
            oai_role = "user"
        elif role == "model":
            oai_role = "assistant"
        else:
            raise ValueError(f"Gemini contents[{idx}].role 不支持: {role!r}")

        parts = msg.get("parts")
        if not isinstance(parts, list) or not parts:
            raise ValueError(f"Gemini contents[{idx}].parts 必须是非空数组")

        content_value = _gemini_parts_to_openai_content(parts)
        out["messages"].append({"role": oai_role, "content": content_value})

    gen_cfg = request_data.get("generationConfig") or request_data.get("generation_config")
    if isinstance(gen_cfg, dict):
        if gen_cfg.get("temperature") is not None:
            out["temperature"] = gen_cfg.get("temperature")
        if gen_cfg.get("topP") is not None:
            out["top_p"] = gen_cfg.get("topP")
        if gen_cfg.get("maxOutputTokens") is not None:
            out["max_tokens"] = gen_cfg.get("maxOutputTokens")

    return out


def openai_chat_response_to_gemini_response(openai_resp: Dict[str, Any]) -> Dict[str, Any]:
    """
    OpenAI ChatCompletions response -> Gemini v1beta generateContent response.
    """

    if not isinstance(openai_resp, dict):
        raise ValueError("openai_resp 必须是 JSON object")

    text = _extract_openai_chat_text(openai_resp)
    finish_reason = _map_openai_finish_reason_to_gemini(openai_resp)

    parts: List[Dict[str, Any]] = []
    if text:
        parts.append({"text": text})

    out: Dict[str, Any] = {
        "candidates": [
            {
                "content": {"role": "model", "parts": parts},
                "finishReason": finish_reason,
            }
        ]
    }

    usage_meta = _openai_usage_to_gemini_usage_metadata(openai_resp.get("usage"))
    if usage_meta:
        out["usageMetadata"] = usage_meta

    return out


@dataclass
class ChatCompletionsSSEToGeminiSSETranslator:
    """
    OpenAI ChatCompletions SSE -> Gemini v1beta streamGenerateContent SSE.

    输入：data: {...}\\n\\n / data: [DONE]\\n\\n
    输出：data: <GeminiResponse>\\n\\n
    """

    _buffer: bytes = b""
    _finished: bool = False
    _error_emitted: bool = False
    _tool_call_seen: bool = False

    # best-effort: store last usage for final chunk (if any)
    _last_usage: Optional[Dict[str, Any]] = None

    def feed(self, raw: bytes) -> Tuple[List[bytes], bool]:
        if self._finished:
            return ([], True)

        self._buffer += raw or b""
        out: List[bytes] = []

        while b"\n\n" in self._buffer:
            block, self._buffer = self._buffer.split(b"\n\n", 1)
            for event in self._handle_sse_block(block):
                out.append(event)
                if self._finished:
                    break
            if self._finished:
                break

        return (out, self._finished)

    def _handle_sse_block(self, block: bytes) -> List[bytes]:
        out: List[bytes] = []

        # collect data lines (SSE can have multi data lines)
        data_lines: List[bytes] = []
        for raw_line in (block or b"").split(b"\n"):
            line = raw_line.strip()
            if not line.startswith(b"data:"):
                continue
            data_lines.append(line[5:].strip())

        if not data_lines:
            return []

        data = b"\n".join(data_lines).strip()
        if data == b"[DONE]":
            self._finished = True
            return []

        try:
            payload = json.loads(data.decode("utf-8", errors="replace"))
        except Exception:
            return []

        if not isinstance(payload, dict):
            return []

        # upstream error: {"error": {...}}
        if payload.get("error") is not None:
            err_msg, err_code = _extract_openai_error(payload.get("error"))
            out.append(_gemini_error_sse(err_msg, err_code))
            self._finished = True
            self._error_emitted = True
            return out

        self._last_usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else self._last_usage

        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            return []

        choice0 = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice0.get("delta") if isinstance(choice0.get("delta"), dict) else {}

        # 暂不支持 tool_calls：先显式报错，避免 silent drop
        if isinstance(delta.get("tool_calls"), list) and delta.get("tool_calls"):
            out.append(_gemini_error_sse("Gemini v1beta(route A) 暂不支持 tool_calls 输出转换", 400))
            self._finished = True
            self._tool_call_seen = True
            return out

        text_delta = delta.get("content")
        if not isinstance(text_delta, str):
            text_delta = ""

        finish_reason = choice0.get("finish_reason")
        finish_reason_str = str(finish_reason).strip().lower() if finish_reason is not None else ""

        if not text_delta and not finish_reason_str:
            # 常见：首包 delta.role / heartbeat 之类，不需要向 Gemini 下游发空事件
            return []

        gemini_payload: Dict[str, Any] = {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": text_delta}] if text_delta else [],
                    }
                }
            ]
        }

        if finish_reason_str:
            gemini_payload["candidates"][0]["finishReason"] = _map_openai_finish_reason_to_gemini_str(
                finish_reason_str
            )
            usage_meta = _openai_usage_to_gemini_usage_metadata(self._last_usage)
            if usage_meta:
                gemini_payload["usageMetadata"] = usage_meta

        out.append(_gemini_data_sse(gemini_payload))
        return out


def _gemini_system_instruction_to_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    parts = value.get("parts")
    if not isinstance(parts, list):
        return ""
    texts: List[str] = []
    for p in parts:
        if isinstance(p, dict) and isinstance(p.get("text"), str) and p.get("text").strip():
            texts.append(p.get("text").strip())
    return "\n".join(texts).strip()


def _gemini_parts_to_openai_content(parts: List[Any]) -> Any:
    blocks: List[Dict[str, Any]] = []
    texts: List[str] = []
    has_inline = False

    for idx, part in enumerate(parts):
        if not isinstance(part, dict):
            raise ValueError(f"Gemini parts[{idx}] 必须是 object")

        if isinstance(part.get("text"), str):
            t = part.get("text") or ""
            if has_inline:
                blocks.append({"type": "text", "text": t})
            else:
                texts.append(t)
            continue

        inline = part.get("inlineData") or part.get("inline_data")
        if isinstance(inline, dict):
            mime = str(inline.get("mimeType") or inline.get("mime_type") or "").strip()
            b64 = str(inline.get("data") or "").strip()
            if not mime or not b64:
                raise ValueError(f"Gemini parts[{idx}].inlineData 缺少 mimeType/data")
            has_inline = True
            blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                }
            )
            continue

        raise ValueError(f"Gemini parts[{idx}] 不支持的结构: keys={sorted([str(k) for k in part.keys()])}")

    if has_inline:
        if texts:
            # ensure text blocks appear before images if user passed pure texts before we saw inlineData
            blocks = [{"type": "text", "text": "".join(texts)}] + blocks
        return blocks
    return "".join(texts)


def _extract_openai_chat_text(openai_resp: Dict[str, Any]) -> str:
    choices = openai_resp.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else {}
    msg = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # best-effort: join text blocks only
        texts: List[str] = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                texts.append(b.get("text"))
        return "".join(texts)
    return ""


def _map_openai_finish_reason_to_gemini(openai_resp: Dict[str, Any]) -> str:
    choices = openai_resp.get("choices")
    if not isinstance(choices, list) or not choices:
        return "STOP"
    first = choices[0] if isinstance(choices[0], dict) else {}
    fr = str(first.get("finish_reason") or "").strip().lower()
    return _map_openai_finish_reason_to_gemini_str(fr)


def _map_openai_finish_reason_to_gemini_str(fr: str) -> str:
    if fr == "length":
        return "MAX_TOKENS"
    if fr:
        return "STOP" if fr == "stop" else fr.upper()
    return "STOP"


def _openai_usage_to_gemini_usage_metadata(usage: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(usage, dict):
        return None
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or 0) or (prompt + completion)

    thoughts = 0
    details = usage.get("completion_tokens_details")
    if isinstance(details, dict):
        thoughts = int(details.get("reasoning_tokens") or 0)

    out: Dict[str, Any] = {
        "promptTokenCount": prompt,
        "candidatesTokenCount": completion,
        "totalTokenCount": total,
    }
    if thoughts:
        out["thoughtsTokenCount"] = thoughts
    return out


def _extract_openai_error(err: Any) -> Tuple[str, int]:
    if isinstance(err, dict):
        msg = str(err.get("message") or err.get("detail") or err).strip() or "upstream_error"
        try:
            code = int(err.get("code") or err.get("status") or err.get("status_code") or 500)
        except Exception:
            code = 500
        return msg, code
    return str(err or "upstream_error"), 500


def _gemini_data_sse(payload: Dict[str, Any]) -> bytes:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {data}\n\n".encode("utf-8")


def _gemini_error_sse(message: str, code: int) -> bytes:
    payload = {"error": {"message": (message or "upstream_error"), "code": int(code or 500)}}
    return _gemini_data_sse(payload)
