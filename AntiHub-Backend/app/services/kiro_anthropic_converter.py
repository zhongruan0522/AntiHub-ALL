"""
Kiro（CodeWhisperer）通道的 Anthropic Messages 请求转换器。

目标：参考 `2-参考项目/kiro.rs` 的做法，把 Anthropic 的 messages/tools/tool_use/tool_result
直接转换为 Kiro/CodeWhisperer 所需的 `conversationState` 请求结构，避免多层格式来回转换导致的边角不一致，
并对 Kiro 上游严格的请求校验做兜底（tool 定义闭包、tool_use/tool_result 配对过滤、chatTriggerType 固定 MANUAL）。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from app.schemas.anthropic import AnthropicMessagesRequest
from app.utils.kiro_converters import generate_thinking_hint, inject_thinking_hint, is_thinking_enabled

logger = logging.getLogger(__name__)


class KiroAnthropicConverter:
    """
    Anthropic Messages API -> Kiro(CodeWhisperer) generateAssistantResponse 请求体转换。
    """

    # 与 `AntiHub-plugin/src/services/kiro.service.js` 的 KIRO_MODEL_MAP 保持一致（优先精确映射）
    MODEL_MAP: Dict[str, str] = {
        "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
        "claude-sonnet-4-20250514": "claude-sonnet-4",
        "claude-opus-4-5-20251101": "claude-opus-4.5",
        "claude-opus-4-6": "claude-opus-4-6",
        "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    }

    IMAGE_FORMAT_MAP: Dict[str, str] = {
        "image/jpeg": "jpeg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
    }

    @classmethod
    def to_kiro_chat_completions_request(cls, request: AnthropicMessagesRequest) -> Dict[str, Any]:
        """
        返回给 plug-in API 的请求体（仍走 /v1/kiro/chat/completions），但 payload 是 conversationState。
        plug-in 会识别 `conversationState` 并直接转发到 /generateAssistantResponse。
        """
        if not request.messages:
            raise ValueError("messages 不能为空")

        model_id = cls._map_model(request.model)
        thinking_cfg = getattr(request, "thinking", None)
        # output_config 用于 adaptive thinking（参考 kiro.rs）
        output_config = getattr(request, "output_config", None) or getattr(
            request, "outputConfig", None
        )
        if output_config is None:
            extra = getattr(request, "model_extra", None)
            if isinstance(extra, dict):
                output_config = extra.get("output_config") or extra.get("outputConfig")

        conversation_id = cls._extract_session_id(getattr(getattr(request, "metadata", None), "user_id", None)) or str(
            uuid.uuid4()
        )
        agent_continuation_id = str(uuid.uuid4())

        # 1) tools 定义（来自当前请求）
        tools = cls._convert_tools(getattr(request, "tools", None))

        # 2) history（系统消息 + 除最后一条消息外的历史）
        history: List[Dict[str, Any]] = []
        cls._append_system_history(history, request, model_id, thinking_cfg, output_config)

        # messages 的最后一条作为 currentMessage，前面的都进入 history
        for msg in request.messages[:-1]:
            if getattr(msg, "role", None) == "user":
                history.append(cls._convert_user_history_message(msg, model_id))
            else:
                history.append(cls._convert_assistant_history_message(msg))

        # Kiro 对 tool_use/tool_result 的配对非常严格：history 里如果出现孤立/重复的 tool_result，会直接 400。
        # 参考 kiro.rs：对 tool_result 做配对过滤；但我们额外把“被过滤掉的 tool_result 内容”降级为纯文本，避免信息丢失。
        cls._sanitize_history_tool_pairing(history)

        # 3) Kiro 约束兜底：history 里出现过的工具名，必须在 currentMessage.tools 有定义
        history_tool_names = cls._collect_history_tool_names(history)
        cls._ensure_tool_definitions(tools, history_tool_names)

        # 4) currentMessage（最后一条消息）
        last = request.messages[-1]
        current_text, current_images, current_tool_results = cls._process_user_content(getattr(last, "content", None))

        # 5) 过滤 tool_use/tool_result 的配对，避免孤立/重复导致 Kiro 400
        validated_tool_results = cls._validate_tool_pairing(history, current_tool_results)

        # 如果 tool_result 被过滤（孤立/重复），把它的内容降级拼到用户文本里，避免 currentMessage 变成空内容。
        current_text = cls._append_orphan_tool_result_text(current_text, current_tool_results, validated_tool_results)

        user_context: Dict[str, Any] = {}
        if tools:
            user_context["tools"] = tools
        if validated_tool_results:
            user_context["toolResults"] = validated_tool_results

        # 保守兜底：仅提供 tools 但内容为空时，给一个极短占位符，避免上游判定请求不规范
        if not current_text and not current_images and tools and not validated_tool_results:
            current_text = "执行工具任务"

        # 再兜底一次：避免发出完全空的 currentMessage（某些上游会直接判定 Improperly formed request）
        if not current_text and not current_images and not validated_tool_results:
            current_text = "OK"

        conversation_state = {
            "agentContinuationId": agent_continuation_id,
            "agentTaskType": "vibe",
            # 经验结论：AUTO 更容易触发 400（与 kiro.rs / plugin 结论一致）
            "chatTriggerType": "MANUAL",
            "currentMessage": {
                "userInputMessage": {
                    "userInputMessageContext": user_context,
                    "content": current_text,
                    "modelId": model_id,
                    "images": current_images,
                    "origin": "AI_EDITOR",
                }
            },
            "conversationId": conversation_id,
            "history": history,
        }

        return {
            "model": request.model,
            "stream": bool(getattr(request, "stream", False)),
            "conversationState": conversation_state,
        }

    @classmethod
    def _map_model(cls, model: str) -> str:
        m = str(model or "").strip()
        if not m:
            raise ValueError("model 不能为空")
        if m in cls.MODEL_MAP:
            return cls.MODEL_MAP[m]

        lower = m.lower()
        if "sonnet" in lower:
            return "claude-sonnet-4.5"
        if "opus" in lower:
            # 对齐 kiro.rs：非显式 4.5 的 opus 统一视为 4.6
            if "4-5" in lower or "4.5" in lower:
                return "claude-opus-4.5"
            return "claude-opus-4-6"
        if "haiku" in lower:
            return "claude-haiku-4.5"

        raise ValueError(f"未知的 Kiro 模型: {m}")

    @staticmethod
    def _extract_session_id(user_id: Optional[str]) -> Optional[str]:
        """
        user_id 格式示例: user_xxx_account__session_0b4445e1-f5be-49e1-87ce-62bbc28ad705
        提取 session_ 后面的 UUID 作为 conversationId。
        """
        if not user_id or "session_" not in user_id:
            return None
        try:
            pos = user_id.find("session_")
            session_part = user_id[pos + 8 :]
            if len(session_part) < 36:
                return None
            uuid_str = session_part[:36]
            # 严格校验一下格式，避免脏数据污染会话
            uuid.UUID(uuid_str)
            return uuid_str
        except Exception:
            return None

    @classmethod
    def _append_system_history(
        cls,
        history: List[Dict[str, Any]],
        request: AnthropicMessagesRequest,
        model_id: str,
        thinking_cfg: Any,
        output_config: Any,
    ) -> None:
        system = getattr(request, "system", None)
        system_text = ""
        if isinstance(system, str):
            system_text = system
        elif isinstance(system, list):
            parts = []
            for block in system:
                text = getattr(block, "text", None)
                if isinstance(text, str) and text:
                    parts.append(text)
            system_text = "\n".join(parts)

        if is_thinking_enabled(thinking_cfg):
            if system_text:
                system_text = inject_thinking_hint(system_text, thinking_cfg, output_config=output_config)
            else:
                system_text = generate_thinking_hint(thinking_cfg, output_config=output_config)

        if not system_text:
            return

        history.append(
            {
                "userInputMessage": {
                    "userInputMessageContext": {},
                    "content": system_text,
                    "modelId": model_id,
                    "images": [],
                    "origin": "AI_EDITOR",
                }
            }
        )
        history.append({"assistantResponseMessage": {"content": "I will follow these instructions."}})

    @classmethod
    def _convert_tools(cls, tools: Optional[List[Any]]) -> List[Dict[str, Any]]:
        if not tools:
            return []

        if len(tools) > 1:
            normalized_names = [str(getattr(t, "name", "") or "").strip().lower() for t in tools]
            has_web_search = any(n == "web_search" for n in normalized_names)
            has_other = any(n and n != "web_search" for n in normalized_names)
            if has_web_search and has_other:
                tools = [t for t, n in zip(tools, normalized_names) if n != "web_search"]
                logger.info("检测到 mixed tools，已移除内置 web_search（保留 %d 个工具）", len(tools))

        out: List[Dict[str, Any]] = []
        for t in tools:
            name = str(getattr(t, "name", "") or "").strip()
            if not name:
                continue

            desc = str(getattr(t, "description", "") or "").strip()
            if not desc:
                # Kiro upstream 会校验 tool.description 不能为空；为空会直接 400
                desc = "当前工具无说明"
            if len(desc) > 10000:
                desc = desc[:10000]

            schema_obj: Dict[str, Any] = {}
            input_schema = getattr(t, "input_schema", None)
            if input_schema is not None and hasattr(input_schema, "model_dump"):
                schema_obj = input_schema.model_dump(exclude_none=True)  # type: ignore[assignment]
            if not isinstance(schema_obj, dict):
                schema_obj = {}

            if schema_obj.get("type") is None:
                schema_obj["type"] = "object"
            if not isinstance(schema_obj.get("properties"), dict):
                schema_obj["properties"] = {}

            out.append(
                {
                    "toolSpecification": {
                        "name": name,
                        "description": desc,
                        "inputSchema": {"json": schema_obj},
                    }
                }
            )
        return out

    @classmethod
    def _create_placeholder_tool(cls, name: str) -> Dict[str, Any]:
        return {
            "toolSpecification": {
                "name": name,
                "description": "Tool used in conversation history",
                "inputSchema": {
                    "json": {
                        "$schema": "http://json-schema.org/draft-07/schema#",
                        "type": "object",
                        "properties": {},
                        "required": [],
                        "additionalProperties": True,
                    }
                },
            }
        }

    @classmethod
    def _collect_history_tool_names(cls, history: List[Dict[str, Any]]) -> List[str]:
        names: List[str] = []
        for entry in history:
            assistant = entry.get("assistantResponseMessage")
            if not isinstance(assistant, dict):
                continue
            tool_uses = assistant.get("toolUses")
            if not isinstance(tool_uses, list):
                continue
            for tu in tool_uses:
                if not isinstance(tu, dict):
                    continue
                name = tu.get("name")
                if not isinstance(name, str) or not name.strip():
                    continue
                if name not in names:
                    names.append(name)
        return names

    @classmethod
    def _ensure_tool_definitions(cls, tools: List[Dict[str, Any]], history_tool_names: List[str]) -> None:
        existing = {str(t.get("toolSpecification", {}).get("name", "")).lower() for t in tools if isinstance(t, dict)}
        for name in history_tool_names:
            if name.lower() not in existing:
                tools.append(cls._create_placeholder_tool(name))
                existing.add(name.lower())

    @classmethod
    def _process_user_content(cls, content: Any) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
        if isinstance(content, str):
            return content, [], []

        text_parts: List[str] = []
        images: List[Dict[str, Any]] = []
        tool_results: List[Dict[str, Any]] = []

        if isinstance(content, list):
            for block in content:
                block_type = getattr(block, "type", None) if not isinstance(block, dict) else block.get("type")

                if block_type == "text":
                    text = getattr(block, "text", None) if not isinstance(block, dict) else block.get("text")
                    if isinstance(text, str) and text:
                        text_parts.append(text)

                elif block_type == "image":
                    source = getattr(block, "source", None) if not isinstance(block, dict) else block.get("source")
                    source_type = (
                        getattr(source, "type", None) if not isinstance(source, dict) else source.get("type")
                    )
                    media_type = (
                        getattr(source, "media_type", None) if not isinstance(source, dict) else source.get("media_type")
                    )
                    data = getattr(source, "data", None) if not isinstance(source, dict) else source.get("data")

                    if source_type == "base64" and isinstance(media_type, str) and isinstance(data, str) and data:
                        fmt = cls.IMAGE_FORMAT_MAP.get(media_type)
                        if fmt:
                            images.append({"format": fmt, "source": {"bytes": data}})
                        else:
                            logger.debug("Unsupported image media_type: %s", media_type)

                elif block_type == "tool_result":
                    tool_use_id = (
                        getattr(block, "tool_use_id", None) if not isinstance(block, dict) else block.get("tool_use_id")
                    )
                    is_error = getattr(block, "is_error", False) if not isinstance(block, dict) else block.get("is_error")
                    raw_content = getattr(block, "content", None) if not isinstance(block, dict) else block.get("content")
                    if isinstance(tool_use_id, str) and tool_use_id:
                        result_text = cls._extract_tool_result_text(raw_content)
                        tool_results.append(
                            {
                                "toolUseId": tool_use_id,
                                "content": [{"text": result_text}],
                                "status": "error" if is_error else "success",
                                "isError": bool(is_error),
                            }
                        )

        return "\n".join(text_parts), images, tool_results

    @staticmethod
    def _extract_tool_result_text(raw_content: Any) -> str:
        if isinstance(raw_content, str):
            return raw_content
        if isinstance(raw_content, list):
            parts: List[str] = []
            for item in raw_content:
                item_type = getattr(item, "type", None) if not isinstance(item, dict) else item.get("type")
                if item_type == "text":
                    text = getattr(item, "text", None) if not isinstance(item, dict) else item.get("text")
                    if isinstance(text, str) and text:
                        parts.append(text)
            return "\n".join(parts)
        if raw_content is None:
            return ""
        return str(raw_content)

    @classmethod
    def _convert_user_history_message(cls, msg: Any, model_id: str) -> Dict[str, Any]:
        text, images, tool_results = cls._process_user_content(getattr(msg, "content", None))
        ctx: Dict[str, Any] = {}
        if tool_results:
            ctx["toolResults"] = tool_results
        return {
            "userInputMessage": {
                "userInputMessageContext": ctx,
                "content": text,
                "modelId": model_id,
                "images": images,
                "origin": "AI_EDITOR",
            }
        }

    @classmethod
    def _convert_assistant_history_message(cls, msg: Any) -> Dict[str, Any]:
        content = getattr(msg, "content", None)
        tool_uses: List[Dict[str, Any]] = []
        thinking = ""
        text = ""

        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            for block in content:
                block_type = getattr(block, "type", None) if not isinstance(block, dict) else block.get("type")
                if block_type == "thinking":
                    v = getattr(block, "thinking", None) if not isinstance(block, dict) else block.get("thinking")
                    if isinstance(v, str) and v:
                        thinking += v
                elif block_type == "text":
                    v = getattr(block, "text", None) if not isinstance(block, dict) else block.get("text")
                    if isinstance(v, str) and v:
                        text += v
                elif block_type == "tool_use":
                    tool_id = getattr(block, "id", None) if not isinstance(block, dict) else block.get("id")
                    name = getattr(block, "name", None) if not isinstance(block, dict) else block.get("name")
                    tool_input = getattr(block, "input", None) if not isinstance(block, dict) else block.get("input")
                    if isinstance(tool_id, str) and tool_id and isinstance(name, str) and name:
                        tool_uses.append(
                            {
                                "toolUseId": tool_id,
                                "name": name,
                                "input": tool_input if isinstance(tool_input, dict) else {},
                            }
                        )

        if thinking:
            final_content = f"<thinking>{thinking}</thinking>" + (f"\n\n{text}" if text else "")
        elif not text and tool_uses:
            final_content = "There is a tool use."
        else:
            final_content = text

        assistant: Dict[str, Any] = {"content": final_content}
        if tool_uses:
            assistant["toolUses"] = tool_uses
        return {"assistantResponseMessage": assistant}

    @staticmethod
    def _tool_result_to_text(tool_result: Dict[str, Any]) -> str:
        content = tool_result.get("content")
        if isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                text = item.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
            return "".join(parts).strip()
        if content is None:
            return ""
        return str(content).strip()

    @classmethod
    def _sanitize_history_tool_pairing(cls, history: List[Dict[str, Any]]) -> None:
        """
        对 history 中的 userInputMessageContext.toolResults 做严格配对过滤：
        - 仅保留能匹配到「此前出现过且尚未配对」的 assistant.toolUses 的 tool_result
        - 被过滤掉的 tool_result 内容降级拼到 userInputMessage.content，避免丢信息 & 避免空消息触发上游 400
        """
        unpaired_tool_use_ids: set[str] = set()
        all_tool_use_ids: set[str] = set()

        for entry in history:
            assistant = entry.get("assistantResponseMessage")
            if isinstance(assistant, dict):
                tool_uses = assistant.get("toolUses")
                if isinstance(tool_uses, list):
                    for tu in tool_uses:
                        if not isinstance(tu, dict):
                            continue
                        tid = tu.get("toolUseId")
                        if isinstance(tid, str) and tid:
                            all_tool_use_ids.add(tid)
                            unpaired_tool_use_ids.add(tid)

            user = entry.get("userInputMessage")
            if not isinstance(user, dict):
                continue

            ctx = user.get("userInputMessageContext")
            if not isinstance(ctx, dict):
                continue

            results = ctx.get("toolResults")
            if not isinstance(results, list) or not results:
                continue

            kept: List[Dict[str, Any]] = []
            degraded_texts: List[str] = []

            for r in results:
                if not isinstance(r, dict):
                    continue
                tid = r.get("toolUseId")
                if not isinstance(tid, str) or not tid:
                    continue

                if tid in unpaired_tool_use_ids:
                    kept.append(r)
                    unpaired_tool_use_ids.remove(tid)
                    continue

                if tid in all_tool_use_ids:
                    logger.warning("跳过重复的 tool_result：toolUseId=%s", tid)
                else:
                    logger.warning("跳过孤立的 tool_result（找不到对应 tool_use）：toolUseId=%s", tid)

                text = cls._tool_result_to_text(r)
                if text:
                    degraded_texts.append(text)

            if kept:
                ctx["toolResults"] = kept
            else:
                ctx.pop("toolResults", None)

            if degraded_texts:
                extra = "\n".join(degraded_texts).strip()
                if extra:
                    original = user.get("content")
                    if isinstance(original, str) and original.strip():
                        user["content"] = f"{original}\n{extra}"
                    else:
                        user["content"] = extra

    @classmethod
    def _append_orphan_tool_result_text(
        cls,
        current_text: str,
        tool_results: List[Dict[str, Any]],
        validated_tool_results: List[Dict[str, Any]],
    ) -> str:
        if not tool_results:
            return current_text

        validated_ids = set()
        for r in validated_tool_results:
            if isinstance(r, dict):
                tid = r.get("toolUseId")
                if isinstance(tid, str) and tid:
                    validated_ids.add(tid)

        degraded_texts: List[str] = []
        for r in tool_results:
            if not isinstance(r, dict):
                continue
            tid = r.get("toolUseId")
            if not isinstance(tid, str) or not tid or tid in validated_ids:
                continue
            text = cls._tool_result_to_text(r)
            if text:
                degraded_texts.append(text)

        if not degraded_texts:
            return current_text

        extra = "\n".join(degraded_texts).strip()
        if not extra:
            return current_text

        if isinstance(current_text, str) and current_text.strip():
            return f"{current_text}\n{extra}"
        return extra

    @classmethod
    def _validate_tool_pairing(
        cls, history: List[Dict[str, Any]], tool_results: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        # 1) 收集 history 中的所有 toolUseId（来自 assistant.toolUses）
        all_tool_use_ids = set()
        history_tool_result_ids = set()

        for entry in history:
            assistant = entry.get("assistantResponseMessage")
            if isinstance(assistant, dict):
                tool_uses = assistant.get("toolUses")
                if isinstance(tool_uses, list):
                    for tu in tool_uses:
                        if isinstance(tu, dict):
                            tid = tu.get("toolUseId")
                            if isinstance(tid, str) and tid:
                                all_tool_use_ids.add(tid)

            user = entry.get("userInputMessage")
            if isinstance(user, dict):
                ctx = user.get("userInputMessageContext")
                if isinstance(ctx, dict):
                    results = ctx.get("toolResults")
                    if isinstance(results, list):
                        for r in results:
                            if isinstance(r, dict):
                                tid = r.get("toolUseId")
                                if isinstance(tid, str) and tid:
                                    history_tool_result_ids.add(tid)

        unpaired = set(all_tool_use_ids) - set(history_tool_result_ids)

        # 2) 过滤当前 toolResults：只保留未配对的
        filtered: List[Dict[str, Any]] = []
        for r in tool_results:
            if not isinstance(r, dict):
                continue
            tid = r.get("toolUseId")
            if not isinstance(tid, str) or not tid:
                continue
            if tid in unpaired:
                filtered.append(r)
                unpaired.remove(tid)
            elif tid in all_tool_use_ids:
                logger.warning("跳过重复的 tool_result：toolUseId=%s", tid)
            else:
                logger.warning("跳过孤立的 tool_result（找不到对应 tool_use）：toolUseId=%s", tid)

        # 3) 记录仍未配对的 tool_use（不抛错，避免影响主流程）
        for orphan_id in sorted(unpaired):
            logger.warning("检测到孤立的 tool_use（找不到对应 tool_result）：toolUseId=%s", orphan_id)

        return filtered
