from __future__ import annotations

from dataclasses import dataclass, field
import json
import time
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4


def responses_request_to_chat_completions_request(request_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    把 OpenAI `/v1/responses` 的 request，转换为 `/v1/chat/completions` 可用的 request。

    目标是「够用」：支持 `instructions` + `input(message/text/image)` + `tools/function_call_output`。
    """
    if not isinstance(request_data, dict):
        raise ValueError("request_data 必须是 JSON object")

    out: Dict[str, Any] = {
        "model": request_data.get("model"),
        "messages": [],
        "stream": bool(request_data.get("stream", False)),
    }

    instructions = request_data.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        out["messages"].append({"role": "system", "content": instructions})

    input_value = request_data.get("input")
    out["messages"].extend(_responses_input_to_chat_messages(input_value))

    if "temperature" in request_data:
        out["temperature"] = request_data.get("temperature")
    if "top_p" in request_data:
        out["top_p"] = request_data.get("top_p")
    if "max_output_tokens" in request_data and request_data.get("max_output_tokens") is not None:
        out["max_tokens"] = request_data.get("max_output_tokens")

    if "tools" in request_data:
        out["tools"] = request_data.get("tools")
    if "tool_choice" in request_data:
        out["tool_choice"] = request_data.get("tool_choice")

    for k in ("user", "metadata", "response_format", "seed", "reasoning_effort", "stream_options"):
        if k in request_data and k not in out:
            out[k] = request_data.get(k)

    return out


def chat_completions_response_to_responses_response(
    chat_resp: Dict[str, Any], *, original_request: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    把 OpenAI `/v1/chat/completions` 的响应，转换为 `/v1/responses` 的响应。
    """
    if not isinstance(chat_resp, dict):
        raise ValueError("chat_resp 必须是 JSON object")

    chat_id = str(chat_resp.get("id") or "").strip()
    created_at = int(chat_resp.get("created") or 0) or int(time.time())
    model = str(chat_resp.get("model") or "").strip() or (original_request or {}).get("model")

    resp_id = chat_id if chat_id.startswith("resp_") else f"resp_{chat_id}" if chat_id else f"resp_{uuid4().hex}"
    msg_id = f"msg_{resp_id}_0"

    assistant_text = _extract_chat_completion_text(chat_resp)

    out: Dict[str, Any] = {
        "id": resp_id,
        "object": "response",
        "created_at": created_at,
        "status": "completed",
        "background": False,
        "error": None,
        "output": [
            {
                "id": msg_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": assistant_text,
                        "annotations": [],
                        "logprobs": [],
                    }
                ],
            }
        ],
    }

    if model:
        out["model"] = model

    if isinstance(chat_resp.get("usage"), dict):
        usage = chat_resp["usage"]
        out["usage"] = {
            "input_tokens": int(usage.get("prompt_tokens") or 0),
            "output_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
        }

    if isinstance(original_request, dict):
        if isinstance(original_request.get("instructions"), str):
            out["instructions"] = original_request.get("instructions")
        if original_request.get("max_output_tokens") is not None:
            out["max_output_tokens"] = original_request.get("max_output_tokens")
        if original_request.get("tools") is not None:
            out["tools"] = original_request.get("tools")
        if original_request.get("tool_choice") is not None:
            out["tool_choice"] = original_request.get("tool_choice")

    return out


@dataclass
class _ToolCallState:
    call_id: str
    name: str = ""
    arguments: str = ""
    item_added: bool = False


@dataclass
class ChatCompletionsToResponsesSSETranslator:
    """
    把 ChatCompletions SSE（data: {...} / data: [DONE]）转换成 Responses SSE（event: response.*）。

    兼容范围（先别过度设计）：
    - 文本增量：response.output_text.delta
    - function tool calls：response.function_call_arguments.delta
    - 收尾：output_text.done / content_part.done / output_item.done / response.completed
    """

    original_request: Dict[str, Any]

    _buffer: bytes = b""
    _started: bool = False
    _upstream_done: bool = False
    _finalized: bool = False
    _error_emitted: bool = False

    _seq: int = 0
    _resp_id: str = ""
    _created_at: int = 0
    _msg_item_id: str = ""
    _text_buf: List[str] = field(default_factory=list)
    _msg_open: bool = False
    _msg_done: bool = False

    _tool_calls: Dict[int, _ToolCallState] = field(default_factory=dict)

    def feed(self, raw: bytes) -> Tuple[List[bytes], bool]:
        if self._finalized:
            return ([], True)

        self._buffer += raw or b""
        out: List[bytes] = []

        while b"\n\n" in self._buffer:
            block, self._buffer = self._buffer.split(b"\n\n", 1)
            for event in self._handle_sse_block(block):
                out.append(event)
                if self._upstream_done or self._error_emitted:
                    return (out, True)

        return (out, self._upstream_done or self._error_emitted)

    def finalize(self, *, usage: Optional[Dict[str, int]] = None) -> List[bytes]:
        if self._finalized:
            return []
        self._finalized = True
        if self._error_emitted:
            return []
        return self._build_done_events(usage=usage)

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def _emit(self, event_name: str, payload: Dict[str, Any]) -> bytes:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return f"event: {event_name}\ndata: {data}\n\n".encode("utf-8")

    def _ensure_started(self, chat_chunk: Dict[str, Any]) -> List[bytes]:
        if self._started:
            return []
        self._started = True

        chat_id = str(chat_chunk.get("id") or "").strip()
        self._created_at = int(chat_chunk.get("created") or 0) or int(time.time())
        self._resp_id = chat_id if chat_id.startswith("resp_") else f"resp_{chat_id}" if chat_id else f"resp_{uuid4().hex}"
        self._msg_item_id = f"msg_{self._resp_id}_0"

        created = {
            "type": "response.created",
            "sequence_number": self._next_seq(),
            "response": {
                "id": self._resp_id,
                "object": "response",
                "created_at": self._created_at,
                "status": "in_progress",
                "background": False,
                "error": None,
                "output": [],
            },
        }
        in_progress = {
            "type": "response.in_progress",
            "sequence_number": self._next_seq(),
            "response": {
                "id": self._resp_id,
                "object": "response",
                "created_at": self._created_at,
                "status": "in_progress",
            },
        }
        return [self._emit("response.created", created), self._emit("response.in_progress", in_progress)]

    def _ensure_message_open(self) -> List[bytes]:
        if self._msg_open:
            return []
        self._msg_open = True

        item_added = {
            "type": "response.output_item.added",
            "sequence_number": self._next_seq(),
            "output_index": 0,
            "item": {
                "id": self._msg_item_id,
                "type": "message",
                "status": "in_progress",
                "content": [],
                "role": "assistant",
            },
        }
        part_added = {
            "type": "response.content_part.added",
            "sequence_number": self._next_seq(),
            "item_id": self._msg_item_id,
            "output_index": 0,
            "content_index": 0,
            "part": {"type": "output_text", "annotations": [], "logprobs": [], "text": ""},
        }
        return [self._emit("response.output_item.added", item_added), self._emit("response.content_part.added", part_added)]

    def _close_message_if_needed(self) -> List[bytes]:
        if not self._msg_open or self._msg_done:
            return []
        self._msg_done = True

        full_text = "".join(self._text_buf)
        done = {
            "type": "response.output_text.done",
            "sequence_number": self._next_seq(),
            "item_id": self._msg_item_id,
            "output_index": 0,
            "content_index": 0,
            "text": full_text,
            "logprobs": [],
        }
        part_done = {
            "type": "response.content_part.done",
            "sequence_number": self._next_seq(),
            "item_id": self._msg_item_id,
            "output_index": 0,
            "content_index": 0,
            "part": {"type": "output_text", "annotations": [], "logprobs": [], "text": full_text},
        }
        item_done = {
            "type": "response.output_item.done",
            "sequence_number": self._next_seq(),
            "output_index": 0,
            "item": {
                "id": self._msg_item_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "annotations": [], "logprobs": [], "text": full_text}],
            },
        }
        return [
            self._emit("response.output_text.done", done),
            self._emit("response.content_part.done", part_done),
            self._emit("response.output_item.done", item_done),
        ]

    def _handle_sse_block(self, block: bytes) -> List[bytes]:
        lines = [ln.strip() for ln in block.split(b"\n") if ln.strip()]
        data_lines = [ln for ln in lines if ln.startswith(b"data:")]
        if not data_lines:
            return []

        data = data_lines[-1][5:].strip()
        if data == b"[DONE]":
            self._upstream_done = True
            return []

        try:
            payload = json.loads(data.decode("utf-8"))
        except Exception:
            return []

        if isinstance(payload, dict) and "error" in payload:
            self._error_emitted = True
            self._upstream_done = True
            return [self._emit("error", {"type": "error", "error": payload.get("error")})]

        if not isinstance(payload, dict):
            return []

        out: List[bytes] = []
        out.extend(self._ensure_started(payload))

        choices = payload.get("choices") or []
        if not isinstance(choices, list) or not choices:
            return out

        choice0 = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice0.get("delta") if isinstance(choice0.get("delta"), dict) else {}

        tool_calls = delta.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            out.extend(self._close_message_if_needed())
            out.extend(self._handle_tool_calls(tool_calls))

        content = delta.get("content")
        if isinstance(content, str) and content:
            out.extend(self._ensure_message_open())
            self._text_buf.append(content)
            out.append(
                self._emit(
                    "response.output_text.delta",
                    {
                        "type": "response.output_text.delta",
                        "sequence_number": self._next_seq(),
                        "item_id": self._msg_item_id,
                        "output_index": 0,
                        "content_index": 0,
                        "delta": content,
                        "logprobs": [],
                    },
                )
            )

        finish_reason = choice0.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason:
            self._upstream_done = True

        return out

    def _handle_tool_calls(self, tool_calls: List[Any]) -> List[bytes]:
        out: List[bytes] = []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            if tc.get("type") != "function":
                continue
            idx = int(tc.get("index") or 0)
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}

            st = self._tool_calls.get(idx)
            if not st:
                call_id = str(tc.get("id") or f"call_{self._resp_id}_{idx}")
                st = _ToolCallState(call_id=call_id)
                self._tool_calls[idx] = st

            if tc.get("id"):
                st.call_id = str(tc.get("id"))
            if fn.get("name"):
                st.name = str(fn.get("name"))

            args_delta = fn.get("arguments")
            if not isinstance(args_delta, str) or not args_delta:
                continue

            st.arguments += args_delta
            item_id = f"fc_{st.call_id}"

            if not st.item_added:
                st.item_added = True
                out.append(
                    self._emit(
                        "response.output_item.added",
                        {
                            "type": "response.output_item.added",
                            "sequence_number": self._next_seq(),
                            "output_index": idx,
                            "item": {
                                "id": item_id,
                                "type": "function_call",
                                "status": "in_progress",
                                "arguments": "",
                                "call_id": st.call_id,
                                "name": st.name,
                            },
                        },
                    )
                )

            out.append(
                self._emit(
                    "response.function_call_arguments.delta",
                    {
                        "type": "response.function_call_arguments.delta",
                        "sequence_number": self._next_seq(),
                        "item_id": item_id,
                        "output_index": idx,
                        "delta": args_delta,
                    },
                )
            )

        return out

    def _build_done_events(self, *, usage: Optional[Dict[str, int]] = None) -> List[bytes]:
        out: List[bytes] = []
        out.extend(self._close_message_if_needed())

        for idx, st in sorted(self._tool_calls.items(), key=lambda kv: kv[0]):
            item_id = f"fc_{st.call_id}"
            out.append(
                self._emit(
                    "response.function_call_arguments.done",
                    {
                        "type": "response.function_call_arguments.done",
                        "sequence_number": self._next_seq(),
                        "item_id": item_id,
                        "output_index": idx,
                        "arguments": st.arguments,
                    },
                )
            )
            out.append(
                self._emit(
                    "response.output_item.done",
                    {
                        "type": "response.output_item.done",
                        "sequence_number": self._next_seq(),
                        "output_index": idx,
                        "item": {
                            "id": item_id,
                            "type": "function_call",
                            "status": "completed",
                            "arguments": st.arguments,
                            "call_id": st.call_id,
                            "name": st.name,
                        },
                    },
                )
            )

        completed: Dict[str, Any] = {
            "type": "response.completed",
            "sequence_number": self._next_seq(),
            "response": {
                "id": self._resp_id or f"resp_{uuid4().hex}",
                "object": "response",
                "created_at": self._created_at or int(time.time()),
                "status": "completed",
                "background": False,
                "error": None,
            },
        }

        outputs: List[Dict[str, Any]] = []
        if self._msg_item_id:
            outputs.append(
                {
                    "id": self._msg_item_id,
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "annotations": [],
                            "logprobs": [],
                            "text": "".join(self._text_buf),
                        }
                    ],
                }
            )
        for _, st in sorted(self._tool_calls.items(), key=lambda kv: kv[0]):
            outputs.append(
                {
                    "id": f"fc_{st.call_id}",
                    "type": "function_call",
                    "status": "completed",
                    "arguments": st.arguments,
                    "call_id": st.call_id,
                    "name": st.name,
                }
            )
        if outputs:
            completed["response"]["output"] = outputs

        if usage:
            completed["response"]["usage"] = {
                "input_tokens": int(usage.get("input_tokens") or 0),
                "output_tokens": int(usage.get("output_tokens") or 0),
                "total_tokens": int(usage.get("total_tokens") or 0),
            }

        if isinstance(self.original_request.get("model"), str):
            completed["response"]["model"] = self.original_request.get("model")
        if isinstance(self.original_request.get("instructions"), str):
            completed["response"]["instructions"] = self.original_request.get("instructions")
        if self.original_request.get("max_output_tokens") is not None:
            completed["response"]["max_output_tokens"] = self.original_request.get("max_output_tokens")

        out.append(self._emit("response.completed", completed))
        return out


def _responses_input_to_chat_messages(input_value: Any) -> List[Dict[str, Any]]:
    if input_value is None:
        return []

    if isinstance(input_value, str):
        text = input_value.strip()
        return [{"role": "user", "content": text}] if text else []

    if isinstance(input_value, list):
        out: List[Dict[str, Any]] = []
        for item in input_value:
            if not isinstance(item, dict):
                continue
            t = str(item.get("type") or "").strip()
            if t == "message":
                role = _normalize_role(str(item.get("role") or "user"))
                content = _responses_message_content_to_chat_content(item.get("content"))
                if content is None:
                    continue
                out.append({"role": role, "content": content})
            elif t == "function_call_output":
                call_id = str(item.get("call_id") or "")
                output = item.get("output")
                out.append({"role": "tool", "tool_call_id": call_id, "content": "" if output is None else str(output)})
        return out

    return []


def _normalize_role(role: str) -> str:
    r = (role or "").strip().lower()
    if r in ("developer", "system"):
        return "system"
    if r in ("user", "assistant", "tool"):
        return r
    return "user"


def _responses_message_content_to_chat_content(content: Any) -> Optional[Any]:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: List[Dict[str, Any]] = []
        text_buf: List[str] = []

        for part in content:
            if not isinstance(part, dict):
                continue
            t = str(part.get("type") or "").strip()
            if t in ("input_text", "output_text", "text"):
                text = part.get("text")
                if isinstance(text, str) and text:
                    text_buf.append(text)
            elif t in ("input_image", "image"):
                url = part.get("image_url") or part.get("url")
                if isinstance(url, str) and url:
                    parts.append({"type": "image_url", "image_url": {"url": url}})

        if parts:
            if text_buf:
                parts.insert(0, {"type": "text", "text": "\n".join(text_buf)})
            return parts

        if text_buf:
            return "\n".join(text_buf)

    return None


def _extract_chat_completion_text(chat_resp: Dict[str, Any]) -> str:
    try:
        choices = chat_resp.get("choices") or []
        if not isinstance(choices, list) or not choices:
            return ""
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if not isinstance(msg, dict):
            return ""
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            buf: List[str] = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    buf.append(part["text"])
            return "".join(buf)
    except Exception:
        return ""
    return ""
