"""
Anthropic格式转换器服务
将Anthropic Messages API格式转换为OpenAI格式，并将OpenAI响应转换回Anthropic格式
"""
from typing import Optional, Dict, Any, List, Union, AsyncGenerator, Tuple
import ast
import asyncio
import json
import uuid
import time
import logging
import re

from app.schemas.anthropic import (
    AnthropicMessagesRequest,
    AnthropicMessagesResponse,
    AnthropicUsage,
    AnthropicResponseTextContent,
    AnthropicResponseThinkingContent,
    AnthropicResponseToolUseContent,
    AnthropicErrorResponse,
    AnthropicErrorDetail,
)
from app.utils.thinking_parser import KiroThinkingTagParser, SegmentType, TextSegment

logger = logging.getLogger(__name__)


class AnthropicAdapter:
    """
    Anthropic格式适配器
    负责Anthropic <-> OpenAI格式的双向转换
    """
    
    # Anthropic到OpenAI的停止原因映射
    STOP_REASON_TO_OPENAI = {
        "end_turn": "stop",
        "max_tokens": "length",
        "stop_sequence": "stop",
        "tool_use": "tool_calls",
    }
    
    # OpenAI到Anthropic的停止原因映射
    STOP_REASON_FROM_OPENAI = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "content_filter": "end_turn",
        "function_call": "tool_use",
    }
    
    @classmethod
    def anthropic_to_openai_request(
        cls,
        request: AnthropicMessagesRequest
    ) -> Dict[str, Any]:
        """
        将Anthropic请求格式转换为OpenAI格式
        
        Args:
            request: Anthropic格式的请求
            
        Returns:
            OpenAI格式的请求字典
        """
        # 兜底：修复 tool_use / tool_result 漏传（或空白）ID 的情况，避免下游严格校验报错。
        # 这类问题在并行工具调用时更容易出现。
        cls._patch_tool_use_and_result_ids(request.messages)

        openai_messages = []
        
        # 处理system消息
        if request.system:
            if isinstance(request.system, str):
                openai_messages.append({
                    "role": "system",
                    "content": request.system
                })
            elif isinstance(request.system, list):
                # 多个文本块组合成一个system消息
                system_text = "\n".join(
                    block.text for block in request.system
                    if hasattr(block, 'text')
                )
                openai_messages.append({
                    "role": "system",
                    "content": system_text
                })
        
        # 转换消息列表
        for msg in request.messages:
            openai_msg = cls._convert_anthropic_message_to_openai(msg)
            if openai_msg:
                # 如果返回的是列表（如tool_result消息），展开添加
                if isinstance(openai_msg, list):
                    openai_messages.extend(openai_msg)
                else:
                    openai_messages.append(openai_msg)
        
        # 构建OpenAI请求
        openai_request = {
            "model": request.model,
            "messages": openai_messages,
            "max_tokens": request.max_tokens,
            "stream": request.stream,
        }
        
        # 可选参数
        if request.temperature is not None:
            openai_request["temperature"] = request.temperature
        
        if request.top_p is not None:
            openai_request["top_p"] = request.top_p
        
        if request.stop_sequences:
            openai_request["stop"] = request.stop_sequences
        
        # 转换工具
        tools = request.tools
        tool_choice = request.tool_choice
        if tools:
            tools, tool_choice = cls._strip_builtin_web_search_when_mixed(tools, tool_choice)
            if tools:
                openai_request["tools"] = cls._convert_anthropic_tools_to_openai(tools)
        
        # 转换工具选择
        if tool_choice:
            openai_request["tool_choice"] = cls._convert_anthropic_tool_choice_to_openai(tool_choice)
        
        return openai_request

    @classmethod
    def _set_block_attr(cls, block: Any, attr: str, value: Any) -> None:
        """
        设置内容块属性，支持 Pydantic 模型和 dict。
        """
        if isinstance(block, dict):
            block[attr] = value
            return
        try:
            setattr(block, attr, value)
        except Exception:
            return

    @staticmethod
    def _normalize_non_empty_str(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        return trimmed

    @staticmethod
    def _generate_tool_use_id() -> str:
        return f"toolu_{uuid.uuid4().hex}"

    @classmethod
    def _patch_tool_use_and_result_ids(cls, messages: List[Any]) -> None:
        """
        Best-effort patch for missing tool_use.id / tool_result.tool_use_id.

        The conversion chain (Anthropic -> OpenAI -> upstream) typically requires:
        - assistant.tool_calls[*].id (from tool_use.id)
        - tool.tool_call_id (from tool_result.tool_use_id)

        If any ID is missing/blank, downstream may throw or return 400. We patch IDs in-place
        using message order pairing so each tool_result matches the corresponding tool_use.
        """
        pending: List[Dict[str, Any]] = []

        for msg in messages or []:
            content = msg.content if hasattr(msg, "content") else msg.get("content")
            if not isinstance(content, list):
                continue

            for block in content:
                block_type = cls._get_block_type(block)

                if block_type == "tool_use":
                    raw_id = cls._get_block_attr(block, "id", None)
                    normalized_id = cls._normalize_non_empty_str(raw_id)
                    if normalized_id is not None and raw_id != normalized_id:
                        cls._set_block_attr(block, "id", normalized_id)
                    pending.append({"id": normalized_id, "block": block})
                    continue

                if block_type != "tool_result":
                    continue

                raw_tool_use_id = cls._get_block_attr(block, "tool_use_id", None)
                normalized_tool_use_id = cls._normalize_non_empty_str(raw_tool_use_id)
                resolved_tool_use_id: Optional[str] = normalized_tool_use_id

                if pending:
                    if resolved_tool_use_id:
                        # Prefer exact-id pairing if possible.
                        matched_index: Optional[int] = None
                        for i, p in enumerate(pending):
                            if p.get("id") == resolved_tool_use_id:
                                matched_index = i
                                break
                        if matched_index is not None:
                            pending.pop(matched_index)
                        else:
                            # Otherwise, if there's a missing-id tool_use, adopt this id.
                            missing_index: Optional[int] = None
                            for i, p in enumerate(pending):
                                if not p.get("id"):
                                    missing_index = i
                                    break
                            if missing_index is not None:
                                p = pending.pop(missing_index)
                                p["id"] = resolved_tool_use_id
                                cls._set_block_attr(p["block"], "id", resolved_tool_use_id)
                    else:
                        # tool_result missing tool_use_id: fill from the next pending tool_use.
                        p = pending.pop(0)
                        if not p.get("id"):
                            p["id"] = cls._generate_tool_use_id()
                            cls._set_block_attr(p["block"], "id", p["id"])
                        resolved_tool_use_id = str(p["id"])

                if not resolved_tool_use_id:
                    resolved_tool_use_id = cls._generate_tool_use_id()

                if raw_tool_use_id != resolved_tool_use_id:
                    cls._set_block_attr(block, "tool_use_id", resolved_tool_use_id)

    @classmethod
    def sanitize_openai_request_for_qwen(
        cls,
        openai_request: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Qwen 通道的最小可用降级：

        Claude 请求在转换成 OpenAI ChatCompletions 后，可能包含多模态 `content: []`
        （例如 `[{type:text,...},{type:image_url,...}]`）。Qwen 上游通常不接受该结构，
        会直接 400。

        这里仅对 Qwen 做“保文本、丢图”的降级：
        - 仅保留 content list 里的 text parts
        - 丢弃 image_url 等非文本 parts
        - 若消息最终无文本（例如纯图片），直接跳过该条消息
        """
        if not isinstance(openai_request, dict):
            raise ValueError("openai_request must be a dict")

        raw_messages = openai_request.get("messages")
        if not isinstance(raw_messages, list):
            return openai_request

        sanitized_messages: List[Dict[str, Any]] = []
        for item in raw_messages:
            if not isinstance(item, dict):
                continue

            content = item.get("content")
            if isinstance(content, list):
                texts: List[str] = []
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") != "text":
                        continue
                    text = part.get("text")
                    if isinstance(text, str) and text.strip():
                        texts.append(text)

                merged = "\n".join(texts).strip()
                if not merged:
                    continue

                item = {**item, "content": merged}

            sanitized_messages.append(item)

        return {**openai_request, "messages": sanitized_messages}

    @classmethod
    def _strip_builtin_web_search_when_mixed(
        cls,
        tools: List[Any],
        tool_choice: Any = None,
    ) -> Tuple[List[Any], Any]:
        """
        Claude/Anthropic 的内置联网工具通常以 name="web_search" 形式出现在 tools 中。

        约定：当 tools 同时包含其它工具时，移除 web_search，避免“误触发联网/上游不支持”的问题。
        """
        if len(tools) < 2:
            return tools, tool_choice

        normalized_names: List[str] = []
        for tool in tools:
            name = getattr(tool, "name", None)
            if name is None and isinstance(tool, dict):
                name = tool.get("name")
            normalized_names.append(str(name or "").strip().lower())

        has_web_search = any(n == "web_search" for n in normalized_names)
        has_other = any(n and n != "web_search" for n in normalized_names)
        if not (has_web_search and has_other):
            return tools, tool_choice

        kept = [t for t, n in zip(tools, normalized_names) if n != "web_search"]

        # 如果 tool_choice 显式指定了 web_search，则降级为 auto，避免引用不存在的 tool。
        choice_type: Optional[str] = None
        choice_name: Optional[str] = None
        if isinstance(tool_choice, dict):
            choice_type = str(tool_choice.get("type") or "").strip()
            choice_name = str(tool_choice.get("name") or "").strip()
        else:
            if tool_choice is not None:
                choice_type = str(getattr(tool_choice, "type", "") or "").strip()
                choice_name = str(getattr(tool_choice, "name", "") or "").strip()

        if choice_type == "tool" and choice_name.lower() == "web_search":
            tool_choice = {"type": "auto"}

        logger.info("检测到 mixed tools，已移除内置 web_search（保留 %d 个工具）", len(kept))
        return kept, tool_choice
    
    @classmethod
    def _get_block_type(cls, block: Any) -> Optional[str]:
        """
        获取内容块的类型，支持Pydantic模型和字典格式
        """
        if isinstance(block, dict):
            return block.get('type')
        return getattr(block, 'type', None)
    
    @classmethod
    def _get_block_attr(cls, block: Any, attr: str, default: Any = None) -> Any:
        """
        获取内容块的属性，支持Pydantic模型和字典格式
        """
        if isinstance(block, dict):
            return block.get(attr, default)
        return getattr(block, attr, default)
    
    @classmethod
    def _convert_anthropic_message_to_openai(
        cls,
        msg: Any
    ) -> Optional[Union[Dict[str, Any], List[Dict[str, Any]]]]:
        """
        转换单条Anthropic消息为OpenAI格式
        """
        role = msg.role if hasattr(msg, 'role') else msg.get('role')
        content = msg.content if hasattr(msg, 'content') else msg.get('content')
        
        # 简单文本内容
        if isinstance(content, str):
            return {
                "role": role,
                "content": content
            }
        
        # 复杂内容块列表
        if isinstance(content, list):
            # 检查是否包含工具使用或工具结果
            has_tool_use = any(
                cls._get_block_type(block) == 'tool_use'
                for block in content
            )
            has_tool_result = any(
                cls._get_block_type(block) == 'tool_result'
                for block in content
            )
            
            if has_tool_use and role == "assistant":
                # assistant消息包含tool_use
                return cls._convert_assistant_tool_use_message(content)
            elif has_tool_result and role == "user":
                # user消息包含tool_result
                return cls._convert_user_tool_result_message(content)
            else:
                # 普通多模态内容
                return cls._convert_multimodal_message(role, content)
        
        return None
    
    @classmethod
    def _convert_multimodal_message(
        cls,
        role: str,
        content: List[Any]
    ) -> Dict[str, Any]:
        """
        转换多模态消息内容
        """
        openai_content = []
        
        for block in content:
            block_type = cls._get_block_type(block)
            
            if block_type == 'text':
                text = cls._get_block_attr(block, 'text', '')
                openai_content.append({
                    "type": "text",
                    "text": text
                })
            elif block_type == 'image':
                source = cls._get_block_attr(block, 'source')
                if source:
                    source_type = cls._get_block_attr(source, 'type', 'base64')
                    if source_type == 'base64':
                        media_type = cls._get_block_attr(source, 'media_type', 'image/png')
                        data = cls._get_block_attr(source, 'data', '')
                        openai_content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{data}"
                            }
                        })
                    elif source_type == 'url':
                        url = cls._get_block_attr(source, 'url', '')
                        openai_content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": url
                            }
                        })
        
        # 如果只有一个文本块，简化为字符串
        if len(openai_content) == 1 and openai_content[0].get("type") == "text":
            return {
                "role": role,
                "content": openai_content[0]["text"]
            }
        
        return {
            "role": role,
            "content": openai_content
        }
    
    @classmethod
    def _convert_assistant_tool_use_message(
        cls,
        content: List[Any]
    ) -> Dict[str, Any]:
        """
        转换包含tool_use的assistant消息
        
        特殊处理：当消息包含thinking块（带signature）后面跟着空文本或无文本，
        然后是tool_use时，将thinking的signature转移到tool_use的extra_content中
        """
        text_parts = []
        tool_calls = []
        thinking_content = None
        thinking_signature = None
        
        # 第一遍遍历：提取thinking内容和signature
        for block in content:
            block_type = cls._get_block_type(block)
            
            if block_type == 'thinking':
                thinking_content = cls._get_block_attr(block, 'thinking', '')
                thinking_signature = cls._get_block_attr(block, 'signature', None)
        
        # 检查是否需要转移signature到tool_use
        # 条件：有thinking signature，且文本内容为空或只有"(no content)"
        should_transfer_signature = False
        if thinking_signature:
            # 检查是否有有效的文本内容
            has_meaningful_text = False
            for block in content:
                block_type = cls._get_block_type(block)
                if block_type == 'text':
                    text = cls._get_block_attr(block, 'text', '')
                    # 空文本或"(no content)"不算有效文本
                    if text and text.strip() and text.strip() != "(no content)":
                        has_meaningful_text = True
                        break
            
            # 检查是否有tool_use
            has_tool_use = any(
                cls._get_block_type(block) == 'tool_use'
                for block in content
            )
            
            should_transfer_signature = not has_meaningful_text and has_tool_use
        
        # 第二遍遍历：构建转换结果
        for block in content:
            block_type = cls._get_block_type(block)
            
            if block_type == 'text':
                text = cls._get_block_attr(block, 'text', '')
                # 跳过空文本和"(no content)"
                if text and text.strip() and text.strip() != "(no content)":
                    text_parts.append(text)
            elif block_type == 'tool_use':
                tool_id = cls._get_block_attr(block, 'id', '')
                tool_name = cls._get_block_attr(block, 'name', '')
                tool_input = cls._get_block_attr(block, 'input', {})
                
                tool_call = {
                    "id": tool_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": json.dumps(tool_input) if isinstance(tool_input, dict) else str(tool_input)
                    }
                }
                
                # 如果需要转移signature，添加到extra_content中
                if should_transfer_signature and thinking_signature:
                    tool_call["extra_content"] = {
                        "google": {
                            "thought_signature": thinking_signature
                        }
                    }
                    logger.debug(f"将thinking signature转移到tool_use: {tool_name}")
                
                tool_calls.append(tool_call)
        
        result = {
            "role": "assistant",
            "content": "\n".join(text_parts) if text_parts else None,
        }
        
        # 如果有thinking内容，添加到reasoning_content
        if thinking_content:
            result["reasoning_content"] = thinking_content
        
        if tool_calls:
            result["tool_calls"] = tool_calls
        
        return result
    
    @classmethod
    def _convert_user_tool_result_message(
        cls,
        content: List[Any]
    ) -> List[Dict[str, Any]]:
        """
        转换包含tool_result的user消息
        返回多条tool消息
        """
        messages = []
        
        for block in content:
            block_type = cls._get_block_type(block)
            
            if block_type == 'tool_result':
                tool_content = cls._get_block_attr(block, 'content', '')
                tool_use_id = cls._get_block_attr(block, 'tool_use_id', '')
                
                if isinstance(tool_content, str):
                    content_str = tool_content
                elif isinstance(tool_content, list):
                    # 组合多个内容块
                    content_parts = []
                    for b in tool_content:
                        text = cls._get_block_attr(b, 'text')
                        if text:
                            content_parts.append(text)
                    content_str = "\n".join(content_parts)
                else:
                    content_str = str(tool_content)
                
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content_str
                })
        
        return messages
    
    @classmethod
    def _convert_anthropic_tools_to_openai(
        cls,
        tools: List[Any]
    ) -> List[Dict[str, Any]]:
        """
        转换Anthropic工具定义为OpenAI格式
        """
        openai_tools = []
        
        for tool in tools:
            openai_tool = {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "parameters": {
                        "type": tool.input_schema.type,
                        "properties": tool.input_schema.properties,
                    }
                }
            }
            
            if tool.description:
                openai_tool["function"]["description"] = tool.description
            
            if tool.input_schema.required:
                openai_tool["function"]["parameters"]["required"] = tool.input_schema.required
            
            openai_tools.append(openai_tool)
        
        return openai_tools
    
    @classmethod
    def _convert_anthropic_tool_choice_to_openai(
        cls,
        tool_choice: Any
    ) -> Union[str, Dict[str, Any]]:
        """
        转换Anthropic工具选择为OpenAI格式
        """
        if isinstance(tool_choice, dict):
            choice_type = tool_choice.get("type", "auto")
            choice_name = tool_choice.get("name")
            disable_parallel = tool_choice.get("disable_parallel_tool_use", False)
        else:
            choice_type = getattr(tool_choice, 'type', 'auto')
            choice_name = getattr(tool_choice, 'name', None)
            disable_parallel = getattr(tool_choice, 'disable_parallel_tool_use', False)
        
        if choice_type == "auto":
            return "auto"
        elif choice_type == "any":
            return "required"
        elif choice_type == "tool" and choice_name:
            return {
                "type": "function",
                "function": {"name": choice_name}
            }
        elif choice_type == "none":
            return "none"
        
        return "auto"

    @classmethod
    def _parse_tool_arguments(cls, arguments: Any) -> Dict[str, Any]:
        """
        尽可能把上游 tool_call.function.arguments 解析成 dict。

        兼容：
        - arguments 已经是 dict（某些上游/中间层会直接给对象）
        - arguments 是 JSON 字符串
        - arguments 是“Python 字面量”字符串（单引号、True/False、末尾逗号等）
        - arguments 被双重编码成 JSON 字符串（先解一层再解一层）
        """
        if arguments is None:
            return {}

        if isinstance(arguments, dict):
            return arguments

        # 兼容 Pydantic/BaseModel 等
        if hasattr(arguments, "model_dump"):
            try:
                dumped = arguments.model_dump(exclude_none=True)  # type: ignore[call-arg]
                if isinstance(dumped, dict):
                    return dumped
            except Exception:
                pass

        if not isinstance(arguments, str):
            return {}

        raw = arguments.strip()
        if not raw:
            return {}

        # 1) 优先按 JSON 解
        try:
            parsed: Any = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            parsed = None

        # 2) 处理“双重编码”（JSON string 里包 JSON object）
        for _ in range(2):
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, str):
                inner = parsed.strip()
                if not inner:
                    break
                try:
                    parsed = json.loads(inner)
                    continue
                except (json.JSONDecodeError, TypeError):
                    parsed = None
                    break
            break

        # 3) 尝试截取 {...} 片段再解析（常见于前后混入说明文字）
        if "{" in raw and "}" in raw:
            start = raw.find("{")
            end = raw.rfind("}")
            if end > start:
                candidate = raw[start : end + 1]
                try:
                    parsed2 = json.loads(candidate)
                    if isinstance(parsed2, dict):
                        return parsed2
                except (json.JSONDecodeError, TypeError):
                    pass

                try:
                    parsed2 = ast.literal_eval(candidate)
                    if isinstance(parsed2, dict):
                        return parsed2
                except Exception:
                    pass

        # 4) 最后尝试按 Python 字面量解（兼容单引号等）
        try:
            parsed3 = ast.literal_eval(raw)
            if isinstance(parsed3, dict):
                return parsed3
        except Exception:
            pass

        return {}

    @classmethod
    def _normalize_claude_code_tool_input(cls, tool_name: str, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Claude Code 内置工具常见的入参命名是 snake_case，但部分上游会生成 camelCase。
        这里做一层“向后兼容”的字段别名映射，避免 Edit/Read/Write 这类工具因字段名不一致直接报错。
        """
        if not isinstance(input_data, dict) or not input_data or not tool_name:
            return input_data

        name = str(tool_name).strip().lower()
        out = dict(input_data)

        if name == "edit":
            aliases = {"filePath": "file_path", "oldString": "old_string", "newString": "new_string"}
        elif name == "read":
            aliases = {"filePath": "file_path"}
        elif name == "write":
            aliases = {"filePath": "file_path", "text": "content"}
        else:
            aliases = {}

        for src, dst in aliases.items():
            if src in out and dst not in out:
                out[dst] = out[src]

        return out

    @classmethod
    def _missing_required_args_for_claude_code_tool(cls, tool_name: str, input_data: Dict[str, Any]) -> List[str]:
        name = str(tool_name or "").strip().lower()
        if name == "edit":
            required = ("file_path", "old_string", "new_string")
        elif name == "read":
            required = ("file_path",)
        elif name == "write":
            required = ("file_path", "content")
        else:
            return []

        return [k for k in required if k not in input_data]
    
    @classmethod
    def openai_to_anthropic_response(
        cls,
        openai_response: Dict[str, Any],
        model: str
    ) -> AnthropicMessagesResponse:
        """
        将OpenAI响应格式转换为Anthropic格式
        
        Args:
            openai_response: OpenAI格式的响应
            model: 模型名称
            
        Returns:
            Anthropic格式的响应
            
        Note:
            支持将OpenAI格式的reasoning_content转换为Anthropic的thinking content block格式，
            并正确处理thought_signature
        """
        choice = openai_response.get("choices", [{}])[0]
        message = choice.get("message", {})
        usage = openai_response.get("usage", {})
        
        # 转换内容
        content = []
        
        # 处理reasoning_content（思考过程）- 必须在text内容之前
        # 支持多种格式：reasoning_content, reasoning, thinking_content
        reasoning_content = (
            message.get("reasoning_content") or
            message.get("reasoning") or
            message.get("thinking_content")
        )
        
        # 提取思考签名
        thinking_signature = None
        
        # 从tool_calls中提取签名（Google/Gemini格式）
        tool_calls = message.get("tool_calls", [])
        for tool_call in tool_calls:
            extra_content = tool_call.get("extra_content", {})
            if extra_content:
                google_extra = extra_content.get("google", {})
                if google_extra and "thought_signature" in google_extra:
                    thinking_signature = google_extra["thought_signature"]
                    break
                elif "thought_signature" in extra_content:
                    thinking_signature = extra_content["thought_signature"]
                    break
        
        # 从message级别提取签名
        if not thinking_signature:
            extra_content = message.get("extra_content", {})
            if extra_content:
                google_extra = extra_content.get("google", {})
                if google_extra and "thought_signature" in google_extra:
                    thinking_signature = google_extra["thought_signature"]
                elif "thought_signature" in extra_content:
                    thinking_signature = extra_content["thought_signature"]
            # 直接在message中的signature
            if not thinking_signature and "signature" in message:
                thinking_signature = message["signature"]
        
        # 添加thinking内容块（如果有）
        if reasoning_content:
            content.append(AnthropicResponseThinkingContent(
                thinking=reasoning_content,
                signature=thinking_signature
            ))
        
        # 处理文本内容
        text_content = message.get("content")
        if text_content:
            content.append(AnthropicResponseTextContent(text=text_content))
        
        # 处理工具调用
        valid_tool_uses = 0
        for tool_call in tool_calls:
            if tool_call.get("type") == "function":
                func = tool_call.get("function", {})
                tool_name = func.get("name", "")

                input_data = cls._parse_tool_arguments(func.get("arguments"))
                input_data = cls._normalize_claude_code_tool_input(tool_name, input_data)
                missing = cls._missing_required_args_for_claude_code_tool(tool_name, input_data)
                if missing:
                    raw_args = func.get("arguments")
                    raw_str = "" if raw_args is None else str(raw_args)
                    raw_preview = raw_str[:500] + ("…" if len(raw_str) > 500 else "")
                    logger.warning(
                        "Claude Code tool_call 参数缺失，已降级为纯文本: tool=%s, missing=%s, tool_call_id=%s, raw=%s",
                        tool_name,
                        ",".join(missing),
                        tool_call.get("id", "unknown"),
                        raw_preview,
                    )
                    content.append(
                        AnthropicResponseTextContent(
                            text=f"[tool_call_error] {tool_name} missing required args: {', '.join(missing)}"
                        )
                    )
                    continue

                content.append(
                    AnthropicResponseToolUseContent(
                        id=tool_call.get("id", f"toolu_{uuid.uuid4().hex[:24]}"),
                        name=tool_name,
                        input=input_data,
                    )
                )
                valid_tool_uses += 1
        
        # 如果没有内容，添加空文本
        if not content:
            content.append(AnthropicResponseTextContent(text=""))
        
        # 转换停止原因
        finish_reason = choice.get("finish_reason", "stop")
        stop_reason = cls.STOP_REASON_FROM_OPENAI.get(finish_reason, "end_turn")
        
        # 只有“确实输出了 tool_use block”才返回 tool_use，避免 Claude Code 因空入参直接报错
        if valid_tool_uses > 0:
            stop_reason = "tool_use"
        elif finish_reason in ("tool_calls", "function_call"):
            stop_reason = "end_turn"

        # thinking-only：Opus 4.6 等模型可能把输出预算耗尽在 thinking 上，导致没有 text/tool_use。
        # 对齐 kiro.rs：此时 stop_reason 应为 max_tokens，并补一个 text 块保证 content 数组结构完整。
        has_non_thinking_blocks = any(getattr(b, "type", None) != "thinking" for b in content)
        if reasoning_content and (not has_non_thinking_blocks):
            stop_reason = "max_tokens"
            content.append(AnthropicResponseTextContent(text=" "))
        
        anthropic_response = AnthropicMessagesResponse(
            id=f"msg_{openai_response.get('id', uuid.uuid4().hex[:24])}",
            model=model,
            content=content,
            stop_reason=stop_reason,
            usage=AnthropicUsage(
                input_tokens=usage.get("prompt_tokens", 0),
                output_tokens=usage.get("completion_tokens", 0)
            )
        )
    
        return anthropic_response
    
    @classmethod
    async def convert_openai_stream_to_anthropic(
        cls,
        openai_stream: AsyncGenerator[bytes, None],
        model: str,
        request_id: str,
        thinking_enabled: bool = False
    ) -> AsyncGenerator[str, None]:
        """
        将OpenAI流式响应转换为Anthropic流式响应格式

        Args:
            openai_stream: OpenAI流式响应生成器
            model: 模型名称
            request_id: 请求ID
            thinking_enabled: 是否启用thinking解析（用于解析原始<thinking>标签）

        Yields:
            Anthropic格式的SSE事件

        Note:
            支持将OpenAI格式的reasoning_content转换为Anthropic的thinking content block格式
            如果上游返回原始的<thinking>标签，也会进行解析
        """
        # 发送message_start事件
        message_start = {
            "type": "message_start",
            "message": {
                "id": f"msg_{request_id}",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0
                }
            }
        }
        yield f"event: message_start\ndata: {json.dumps(message_start, ensure_ascii=False)}\n\n"

        # 跟踪状态
        accumulated_text = ""
        accumulated_thinking = ""
        thinking_signature = ""  # 思考内容的签名
        input_tokens = 0
        output_tokens = 0
        finish_reason = None
        current_tool_calls = {}  # 跟踪工具调用
        emitted_meaningful_text_delta = False  # 是否产生过非空白 text_delta（用于判断 thinking-only）
        context_window_exceeded = False  # 是否检测到上下文窗口用尽（contextUsageEvent >= 100%）

        # content block 索引跟踪
        current_block_index = 0

        # thinking content 状态跟踪（reasoning_content字段）
        has_reasoning_content = False  # 是否有reasoning_content
        thinking_block_started = False  # thinking块是否已开始
        thinking_block_stopped = False  # thinking块是否已结束

        # text content 状态跟踪
        text_block_started = False  # text块是否已开始

        # Thinking parser（用于解析原始<thinking>标签）
        thinking_parser: Optional[KiroThinkingTagParser] = None
        if thinking_enabled:
            thinking_parser = KiroThinkingTagParser()
            logger.debug("Thinking parser enabled for stream")

        buffer = ""
        
        async for chunk in openai_stream:
            # 解码chunk
            if isinstance(chunk, bytes):
                chunk_str = chunk.decode('utf-8')
                buffer += chunk_str
            else:
                chunk_str = chunk
                buffer += chunk
            # 处理SSE格式的数据
            while '\n' in buffer:
                line, buffer = buffer.split('\n', 1)
                line = line.strip()
                
                if not line:
                    continue
                
                if line.startswith('data: '):
                    data_str = line[6:]
                    
                    if data_str == '[DONE]':
                        continue
                    
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError as e:
                        continue

                    # Kiro / 兼容网关可能会发 contextUsageEvent（没有 choices），用于告知上下文窗口使用比例。
                    # 如果达到 100%，对齐 kiro.rs：stop_reason 应为 model_context_window_exceeded。
                    context_usage_percentage = None
                    if isinstance(data, dict):
                        if "context_usage_percentage" in data:
                            context_usage_percentage = data.get("context_usage_percentage")
                        else:
                            ctx = data.get("contextUsage") or data.get("context_usage")
                            if isinstance(ctx, dict) and "context_usage_percentage" in ctx:
                                context_usage_percentage = ctx.get("context_usage_percentage")
                    if context_usage_percentage is not None:
                        try:
                            if float(context_usage_percentage) >= 100.0:
                                context_window_exceeded = True
                        except (TypeError, ValueError):
                            pass
                     
                    # 提取usage信息
                    if 'usage' in data:
                        input_tokens = data['usage'].get('prompt_tokens', input_tokens)
                        output_tokens = data['usage'].get('completion_tokens', output_tokens)
                    
                    choices = data.get('choices', [])
                    if not choices:
                        continue
                    
                    choice = choices[0]
                    delta = choice.get('delta', {})
                    
                    # 检查finish_reason
                    if choice.get('finish_reason'):
                        finish_reason = choice['finish_reason']
                    
                    # 处理reasoning_content（思考过程）
                    # 支持多种格式：reasoning_content, reasoning, thinking_content
                    reasoning_delta = delta.get('reasoning_content') or delta.get('reasoning') or delta.get('thinking_content')
                    if reasoning_delta:
                        has_reasoning_content = True
                        accumulated_thinking += reasoning_delta
                        
                        # 如果thinking块还没开始，先发送content_block_start
                        if not thinking_block_started:
                            thinking_block_started = True
                            thinking_block_start = {
                                "type": "content_block_start",
                                "index": current_block_index,
                                "content_block": {
                                    "type": "thinking",
                                    "thinking": ""
                                }
                            }
                            yield f"event: content_block_start\ndata: {json.dumps(thinking_block_start, ensure_ascii=False)}\n\n"
                        
                        # 发送thinking内容增量
                        thinking_delta_event = {
                            "type": "content_block_delta",
                            "index": current_block_index,
                            "delta": {
                                "type": "thinking_delta",
                                "thinking": reasoning_delta
                            }
                        }
                        yield f"event: content_block_delta\ndata: {json.dumps(thinking_delta_event, ensure_ascii=False)}\n\n"
                    
                    # 提取思考签名（thought_signature）
                    # 支持多种上游格式：
                    # 1. tool_calls[].extra_content.google.thought_signature (Google/Gemini格式)
                    # 2. delta.extra_content.thought_signature
                    # 3. delta.signature
                    if 'tool_calls' in delta:
                        for tc in delta['tool_calls']:
                            extra_content = tc.get('extra_content', {})
                            if extra_content:
                                # Google/Gemini格式
                                google_extra = extra_content.get('google', {})
                                if google_extra and 'thought_signature' in google_extra:
                                    thinking_signature = google_extra['thought_signature']
                                # 通用格式
                                elif 'thought_signature' in extra_content:
                                    thinking_signature = extra_content['thought_signature']
                    
                    # 检查delta级别的签名
                    if not thinking_signature:
                        extra_content = delta.get('extra_content', {})
                        if extra_content:
                            google_extra = extra_content.get('google', {})
                            if google_extra and 'thought_signature' in google_extra:
                                thinking_signature = google_extra['thought_signature']
                            elif 'thought_signature' in extra_content:
                                thinking_signature = extra_content['thought_signature']
                        # 直接在delta中的signature
                        if not thinking_signature and 'signature' in delta:
                            thinking_signature = delta['signature']
                    
                    # 处理文本内容
                    if 'content' in delta and delta['content']:
                        text_delta = delta['content']

                        # 如果启用了thinking parser，先用parser解析
                        if thinking_parser:
                            segments = thinking_parser.push_and_parse(text_delta)

                            for segment in segments:
                                if segment.type == SegmentType.THINKING:
                                    # Thinking内容
                                    accumulated_thinking += segment.content
                                    has_reasoning_content = True

                                    # 如果thinking块还没开始，先发送content_block_start
                                    if not thinking_block_started:
                                        thinking_block_started = True
                                        thinking_block_start = {
                                            "type": "content_block_start",
                                            "index": current_block_index,
                                            "content_block": {
                                                "type": "thinking",
                                                "thinking": ""
                                            }
                                        }
                                        yield f"event: content_block_start\ndata: {json.dumps(thinking_block_start, ensure_ascii=False)}\n\n"

                                    # 发送thinking_delta
                                    thinking_delta_event = {
                                        "type": "content_block_delta",
                                        "index": current_block_index,
                                        "delta": {
                                            "type": "thinking_delta",
                                            "thinking": segment.content
                                        }
                                    }
                                    yield f"event: content_block_delta\ndata: {json.dumps(thinking_delta_event, ensure_ascii=False)}\n\n"

                                elif segment.type == SegmentType.TEXT:
                                    # 普通文本内容

                                    # 如果之前有thinking内容且thinking块还没结束，先结束thinking块
                                    if thinking_block_started and not thinking_block_stopped:
                                        thinking_block_stopped = True

                                        # 如果有签名，先发送签名delta
                                        if thinking_signature:
                                            signature_delta_event = {
                                                "type": "content_block_delta",
                                                "index": current_block_index,
                                                "delta": {
                                                    "type": "signature_delta",
                                                    "signature": thinking_signature
                                                }
                                            }
                                            yield f"event: content_block_delta\ndata: {json.dumps(signature_delta_event, ensure_ascii=False)}\n\n"

                                        # 发送thinking块的content_block_stop
                                        thinking_block_stop = {
                                            "type": "content_block_stop",
                                            "index": current_block_index
                                        }
                                        yield f"event: content_block_stop\ndata: {json.dumps(thinking_block_stop, ensure_ascii=False)}\n\n"
                                        # 增加block索引
                                        current_block_index += 1

                                    # 如果text块还没开始，先发送content_block_start
                                    if not text_block_started:
                                        text_block_started = True
                                        text_block_start = {
                                            "type": "content_block_start",
                                            "index": current_block_index,
                                            "content_block": {
                                                "type": "text",
                                                "text": ""
                                            }
                                        }
                                        yield f"event: content_block_start\ndata: {json.dumps(text_block_start, ensure_ascii=False)}\n\n"

                                    accumulated_text += segment.content
                                    if segment.content and segment.content.strip():
                                        emitted_meaningful_text_delta = True

                                    # 发送content_block_delta事件
                                    content_delta = {
                                        "type": "content_block_delta",
                                        "index": current_block_index,
                                        "delta": {
                                            "type": "text_delta",
                                            "text": segment.content
                                        }
                                    }
                                    yield f"event: content_block_delta\ndata: {json.dumps(content_delta, ensure_ascii=False)}\n\n"
                        else:
                            # 没有启用thinking parser，直接处理为文本
                            # 如果之前有thinking内容且thinking块还没结束，先结束thinking块
                            if thinking_block_started and not thinking_block_stopped:
                                thinking_block_stopped = True

                                # 如果有签名，先发送签名delta
                                if thinking_signature:
                                    signature_delta_event = {
                                        "type": "content_block_delta",
                                        "index": current_block_index,
                                        "delta": {
                                            "type": "signature_delta",
                                            "signature": thinking_signature
                                        }
                                    }
                                    yield f"event: content_block_delta\ndata: {json.dumps(signature_delta_event, ensure_ascii=False)}\n\n"

                                # 发送thinking块的content_block_stop
                                thinking_block_stop = {
                                    "type": "content_block_stop",
                                    "index": current_block_index
                                }
                                yield f"event: content_block_stop\ndata: {json.dumps(thinking_block_stop, ensure_ascii=False)}\n\n"
                                # 增加block索引
                                current_block_index += 1

                            # 如果text块还没开始，先发送content_block_start
                            if not text_block_started:
                                text_block_started = True
                                text_block_start = {
                                    "type": "content_block_start",
                                    "index": current_block_index,
                                    "content_block": {
                                        "type": "text",
                                        "text": ""
                                    }
                                }
                                yield f"event: content_block_start\ndata: {json.dumps(text_block_start, ensure_ascii=False)}\n\n"

                            accumulated_text += text_delta
                            if text_delta and text_delta.strip():
                                emitted_meaningful_text_delta = True

                            # 发送content_block_delta事件
                            content_delta = {
                                "type": "content_block_delta",
                                "index": current_block_index,
                                "delta": {
                                    "type": "text_delta",
                                    "text": text_delta
                                }
                            }
                            yield f"event: content_block_delta\ndata: {json.dumps(content_delta, ensure_ascii=False)}\n\n"
                    
                    # 处理工具调用
                    if 'tool_calls' in delta:
                        # 如果之前有thinking内容且thinking块还没结束，先结束thinking块
                        if thinking_block_started and not thinking_block_stopped:
                            thinking_block_stopped = True
                            
                            # 如果有签名，先发送签名delta
                            if thinking_signature:
                                signature_delta_event = {
                                    "type": "content_block_delta",
                                    "index": current_block_index,
                                    "delta": {
                                        "type": "signature_delta",
                                        "signature": thinking_signature
                                    }
                                }
                                yield f"event: content_block_delta\ndata: {json.dumps(signature_delta_event, ensure_ascii=False)}\n\n"
                            
                            thinking_block_stop = {
                                "type": "content_block_stop",
                                "index": current_block_index
                            }
                            yield f"event: content_block_stop\ndata: {json.dumps(thinking_block_stop, ensure_ascii=False)}\n\n"
                            current_block_index += 1
                        
                        for tc in delta['tool_calls']:
                            tc_id = tc.get('id', '')
                            
                            # 首先尝试通过id查找已存在的工具调用
                            tc_index = None
                            if tc_id:
                                for idx, existing_tc in current_tool_calls.items():
                                    if existing_tc['id'] == tc_id:
                                        tc_index = idx
                                        break
                            
                            # 如果通过id没找到，检查是否是新的工具调用
                            if tc_index is None:
                                if tc_id and tc_id not in [t['id'] for t in current_tool_calls.values() if t['id']]:
                                    # 这是一个新的工具调用，分配新的index
                                    tc_index = len(current_tool_calls)
                                else:
                                    # 没有id，使用上游提供的index
                                    tc_index = tc.get('index', 0)
                            
                            if tc_index not in current_tool_calls:
                                # 新的工具调用
                                current_tool_calls[tc_index] = {
                                    'id': tc_id,
                                    'name': '',
                                    'arguments': ''
                                }
                            
                            if 'id' in tc and tc['id']:
                                current_tool_calls[tc_index]['id'] = tc['id']
                            
                            if 'function' in tc:
                                func = tc['function']
                                if 'name' in func:
                                    current_tool_calls[tc_index]['name'] = func['name']
                                if 'arguments' in func:
                                    args_chunk = func['arguments']
                                    current_tool_calls[tc_index]['arguments'] += args_chunk
        
        # 流结束后的清理工作

        # 如果启用了thinking parser，刷新缓冲区
        if thinking_parser:
            final_segments = thinking_parser.flush()
            for segment in final_segments:
                if segment.type == SegmentType.THINKING:
                    # Thinking内容
                    accumulated_thinking += segment.content
                    has_reasoning_content = True

                    # 如果thinking块还没开始，先发送content_block_start
                    if not thinking_block_started:
                        thinking_block_start = {
                            "type": "content_block_start",
                            "index": current_block_index,
                            "content_block": {
                                "type": "thinking",
                                "thinking": ""
                            }
                        }
                        yield f"event: content_block_start\ndata: {json.dumps(thinking_block_start, ensure_ascii=False)}\n\n"
                        thinking_block_started = True

                    # 发送thinking_delta
                    thinking_delta_event = {
                        "type": "content_block_delta",
                        "index": current_block_index,
                        "delta": {
                            "type": "thinking_delta",
                            "thinking": segment.content
                        }
                    }
                    yield f"event: content_block_delta\ndata: {json.dumps(thinking_delta_event, ensure_ascii=False)}\n\n"

                elif segment.type == SegmentType.TEXT:
                    # 普通文本内容

                    # 如果之前有thinking内容且thinking块还没结束，先结束thinking块
                    if thinking_block_started and not thinking_block_stopped:
                        thinking_block_stopped = True

                        # 如果有签名，先发送签名delta
                        if thinking_signature:
                            signature_delta_event = {
                                "type": "content_block_delta",
                                "index": current_block_index,
                                "delta": {
                                    "type": "signature_delta",
                                    "signature": thinking_signature
                                }
                            }
                            yield f"event: content_block_delta\ndata: {json.dumps(signature_delta_event, ensure_ascii=False)}\n\n"

                        # 发送thinking块的content_block_stop
                        thinking_block_stop = {
                            "type": "content_block_stop",
                            "index": current_block_index
                        }
                        yield f"event: content_block_stop\ndata: {json.dumps(thinking_block_stop, ensure_ascii=False)}\n\n"
                        current_block_index += 1

                    # 如果text块还没开始，先发送content_block_start
                    if not text_block_started:
                        text_block_started = True
                        text_block_start = {
                            "type": "content_block_start",
                            "index": current_block_index,
                            "content_block": {
                                "type": "text",
                                "text": ""
                            }
                        }
                        yield f"event: content_block_start\ndata: {json.dumps(text_block_start, ensure_ascii=False)}\n\n"

                    accumulated_text += segment.content
                    if segment.content and segment.content.strip():
                        emitted_meaningful_text_delta = True

                    # 发送content_block_delta事件
                    content_delta = {
                        "type": "content_block_delta",
                        "index": current_block_index,
                        "delta": {
                            "type": "text_delta",
                            "text": segment.content
                        }
                    }
                    yield f"event: content_block_delta\ndata: {json.dumps(content_delta, ensure_ascii=False)}\n\n"

        # 如果thinking块开始了但还没结束，先结束它
        if thinking_block_started and not thinking_block_stopped:
            thinking_block_stopped = True
            
            # 如果有签名，先发送签名delta
            if thinking_signature:
                signature_delta_event = {
                    "type": "content_block_delta",
                    "index": current_block_index,
                    "delta": {
                        "type": "signature_delta",
                        "signature": thinking_signature
                    }
                }
                yield f"event: content_block_delta\ndata: {json.dumps(signature_delta_event, ensure_ascii=False)}\n\n"
            
            thinking_block_stop = {
                "type": "content_block_stop",
                "index": current_block_index
            }
            yield f"event: content_block_stop\ndata: {json.dumps(thinking_block_stop, ensure_ascii=False)}\n\n"
            current_block_index += 1

        thinking_only = thinking_block_started and (not emitted_meaningful_text_delta) and (not current_tool_calls)
         
        # 如果没有任何text块开始（只有thinking或什么都没有），需要发送一个空的text块
        if not text_block_started:
            text_block_started = True
            text_block_start = {
                "type": "content_block_start",
                "index": current_block_index,
                "content_block": {
                    "type": "text",
                    "text": ""
                }
            }
            yield f"event: content_block_start\ndata: {json.dumps(text_block_start, ensure_ascii=False)}\n\n"

            # thinking-only：补发一个空格 text_delta，避免部分客户端把“空 text 块”当成缺失。
            if thinking_only:
                content_delta = {
                    "type": "content_block_delta",
                    "index": current_block_index,
                    "delta": {
                        "type": "text_delta",
                        "text": " ",
                    },
                }
                yield f"event: content_block_delta\ndata: {json.dumps(content_delta, ensure_ascii=False)}\n\n"
         
        # 发送text块的content_block_stop事件
        content_block_stop = {
            "type": "content_block_stop",
            "index": current_block_index
        }
        yield f"event: content_block_stop\ndata: {json.dumps(content_block_stop, ensure_ascii=False)}\n\n"
        
        
        # text 块结束后，后续 block 从下一个索引开始
        current_block_index += 1
        
        # 如果有工具调用，发送工具调用块
        next_block_index = current_block_index
        emitted_tool_use = False
        for _, tc in sorted(current_tool_calls.items(), key=lambda x: x[0]):
            tool_name = tc.get("name", "")
            raw_args = tc.get("arguments", "")

            input_data = cls._parse_tool_arguments(raw_args)
            input_data = cls._normalize_claude_code_tool_input(tool_name, input_data)
            missing = cls._missing_required_args_for_claude_code_tool(tool_name, input_data)

            # Claude Code 内置工具缺参时，直接输出 tool_use 会导致本地工具校验报错；这里降级为纯文本，确保对话不中断。
            if missing:
                raw_str = "" if raw_args is None else str(raw_args)
                raw_preview = raw_str[:500] + ("…" if len(raw_str) > 500 else "")
                logger.warning(
                    "Claude Code stream tool_call 参数缺失，已降级为纯文本: tool=%s, missing=%s, tool_call_id=%s, raw=%s",
                    tool_name,
                    ",".join(missing),
                    tc.get("id", "unknown"),
                    raw_preview,
                )

                text_block_start = {
                    "type": "content_block_start",
                    "index": next_block_index,
                    "content_block": {"type": "text", "text": ""},
                }
                yield f"event: content_block_start\ndata: {json.dumps(text_block_start, ensure_ascii=False)}\n\n"

                warn_delta = {
                    "type": "content_block_delta",
                    "index": next_block_index,
                    "delta": {
                        "type": "text_delta",
                        "text": f"[tool_call_error] {tool_name} missing required args: {', '.join(missing)}",
                    },
                }
                yield f"event: content_block_delta\ndata: {json.dumps(warn_delta, ensure_ascii=False)}\n\n"

                text_block_stop = {"type": "content_block_stop", "index": next_block_index}
                yield f"event: content_block_stop\ndata: {json.dumps(text_block_stop, ensure_ascii=False)}\n\n"

                next_block_index += 1
                continue

            # content_block_start for tool_use
            tool_block_start = {
                "type": "content_block_start",
                "index": next_block_index,
                "content_block": {
                    "type": "tool_use",
                    "id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:24]}",
                    "name": tool_name,
                    "input": {},
                },
            }
            yield f"event: content_block_start\ndata: {json.dumps(tool_block_start, ensure_ascii=False)}\n\n"

            # content_block_delta for tool_use input
            if input_data:
                tool_delta = {
                    "type": "content_block_delta",
                    "index": next_block_index,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": json.dumps(input_data, ensure_ascii=False),
                    },
                }
                yield f"event: content_block_delta\ndata: {json.dumps(tool_delta, ensure_ascii=False)}\n\n"

            # content_block_stop for tool_use
            tool_block_stop = {"type": "content_block_stop", "index": next_block_index}
            yield f"event: content_block_stop\ndata: {json.dumps(tool_block_stop, ensure_ascii=False)}\n\n"

            emitted_tool_use = True
            next_block_index += 1
        
        # 确定停止原因
        if context_window_exceeded:
            stop_reason = "model_context_window_exceeded"
        elif emitted_tool_use:
            stop_reason = "tool_use"
        elif thinking_only:
            stop_reason = "max_tokens"
        elif finish_reason in ("tool_calls", "function_call"):
            stop_reason = "end_turn"
        elif finish_reason:
            stop_reason = cls.STOP_REASON_FROM_OPENAI.get(finish_reason, "end_turn")
        else:
            stop_reason = "end_turn"
        
        # 发送message_delta事件
        # 注意：Anthropic官方格式中，message_delta的usage只包含output_tokens
        # 但由于上游流式响应中usage信息在最后才出现，我们在这里也包含input_tokens
        # 以便客户端能获取完整的usage信息
        message_delta = {
            "type": "message_delta",
            "delta": {
                "stop_reason": stop_reason,
                "stop_sequence": None
            },
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens
            }
        }
        yield f"event: message_delta\ndata: {json.dumps(message_delta, ensure_ascii=False)}\n\n"
        
        # 发送message_stop事件
        message_stop = {
            "type": "message_stop"
        }
        yield f"event: message_stop\ndata: {json.dumps(message_stop, ensure_ascii=False)}\n\n"

    @classmethod
    async def convert_openai_stream_to_anthropic_cc(
        cls,
        openai_stream: AsyncGenerator[bytes, None],
        model: str,
        request_id: str,
        thinking_enabled: bool = False,
        ping_interval_seconds: float = 25.0,
    ) -> AsyncGenerator[str, None]:
        """
        Claude Code (2.1.9+) 兼容的 Anthropic SSE 转换。

        现象：Claude Code 新版不再从 `message_delta` 读取 `input_tokens`，而是从 `message_start` 中读取；
        但上游（OpenAI 兼容流）通常在流末尾才返回 usage，因此必须“先缓冲、后输出”。

        行为：
        - 缓冲完整事件流，直到拿到 `usage`（来自 `message_delta.usage`）
        - 将真实 tokens 写入 `message_start.message.usage` 后再输出所有事件
        - 等待期间按 SSE 注释发送 `: ping` 保活（不影响事件顺序）

        注意：该模式会牺牲流式实时输出，仅用于 Claude Code 兼容端点（/cc/v1）。
        """

        base_gen = cls.convert_openai_stream_to_anthropic(
            openai_stream=openai_stream,
            model=model,
            request_id=request_id,
            thinking_enabled=thinking_enabled,
        )

        buffered_events: List[str] = []
        input_tokens = 0
        output_tokens = 0

        pending_task: Optional[asyncio.Task] = asyncio.create_task(base_gen.__anext__())
        try:
            while True:
                done, _ = await asyncio.wait({pending_task}, timeout=ping_interval_seconds)

                if not done:
                    yield ": ping\n\n"
                    continue

                try:
                    event = pending_task.result()
                except StopAsyncIteration:
                    break

                pending_task = asyncio.create_task(base_gen.__anext__())

                # 丢弃原始 message_start，最后用正确 usage 重新生成并作为首事件输出
                if event.startswith("event: message_start"):
                    continue

                # 从 message_delta 中抓取 usage（convert_openai_stream_to_anthropic 会把完整 usage 放在这里）
                if event.startswith("event: message_delta"):
                    try:
                        data_line = next(
                            (line for line in event.splitlines() if line.startswith("data: ")),
                            "",
                        )
                        if data_line:
                            payload = json.loads(data_line[6:])
                            usage = payload.get("usage", {})
                            input_tokens = usage.get("input_tokens", input_tokens)
                            output_tokens = usage.get("output_tokens", output_tokens)
                    except Exception:
                        # usage 解析失败就保持为 0，不影响主流程
                        pass

                buffered_events.append(event)
        finally:
            if pending_task and not pending_task.done():
                pending_task.cancel()
                try:
                    await pending_task
                except Exception:
                    pass
            try:
                await base_gen.aclose()
            except Exception:
                pass

        message_start = {
            "type": "message_start",
            "message": {
                "id": f"msg_{request_id}",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                },
            },
        }
        yield f"event: message_start\ndata: {json.dumps(message_start, ensure_ascii=False)}\n\n"

        for buffered_event in buffered_events:
            yield buffered_event
    
    @classmethod
    async def collect_openai_stream_to_response(
        cls,
        openai_stream: AsyncGenerator[bytes, None],
        thinking_enabled: bool = False
    ) -> Dict[str, Any]:
        """
        将OpenAI流式响应收集并转换为完整的非流式响应格式

        当用户请求非流式响应（stream=false），但上游总是返回流式响应时，
        使用此方法将流式响应收集并组装成完整的响应。

        Args:
            openai_stream: OpenAI流式响应生成器
            thinking_enabled: 是否启用thinking解析（用于解析原始<thinking>标签）

        Returns:
            OpenAI格式的完整响应字典
        """
        # 跟踪状态
        accumulated_text = ""
        accumulated_reasoning = ""
        thinking_signature = ""
        input_tokens = 0
        output_tokens = 0
        finish_reason = None
        model = ""
        response_id = ""
        tool_calls = {}  # 跟踪工具调用 {index: {id, name, arguments}}

        # Thinking parser（用于解析原始<thinking>标签）
        thinking_parser: Optional[KiroThinkingTagParser] = None
        if thinking_enabled:
            thinking_parser = KiroThinkingTagParser()
            logger.debug("Thinking parser enabled for non-stream response")

        buffer = ""
        chunk_count = 0
        
        
        async for chunk in openai_stream:
            chunk_count += 1
            # 解码chunk
            if isinstance(chunk, bytes):
                chunk_str = chunk.decode('utf-8')
                buffer += chunk_str
            else:
                chunk_str = chunk
                buffer += chunk
        
        # 流结束后，检查buffer中的内容
        # 可能是SSE格式（data: {...}）或者直接的JSON响应
        full_content = buffer.strip()
        
        # 首先尝试解析为完整的JSON响应（非流式响应）
        if full_content and not full_content.startswith('data:'):
            try:
                # 尝试直接解析为JSON
                data = json.loads(full_content)
                
                # 这是一个完整的chat.completion响应，直接返回
                if data.get('object') == 'chat.completion':
                    return data
                
                # 如果是流式chunk格式但没有data:前缀
                if 'choices' in data:
                    choice = data.get('choices', [{}])[0]
                    message = choice.get('message', {})
                    delta = choice.get('delta', {})
                    
                    # 提取基本信息
                    response_id = data.get('id', response_id)
                    model = data.get('model', model)
                    
                    # 提取usage
                    if 'usage' in data:
                        usage_data = data['usage']
                        input_tokens = usage_data.get('prompt_tokens', input_tokens)
                        output_tokens = usage_data.get('completion_tokens', output_tokens)
                    
                    # 提取内容（从message或delta）
                    content = message.get('content') or delta.get('content')
                    if content:
                        accumulated_text = content
                    
                    # 提取finish_reason
                    finish_reason = choice.get('finish_reason', finish_reason)
                    
            except json.JSONDecodeError:
                pass
        
        # 处理SSE格式的数据
        for line in full_content.split('\n'):
            line = line.strip()
            
            if not line:
                continue
            
            if line.startswith('data: '):
                data_str = line[6:]
                
                if data_str == '[DONE]':
                    continue
                
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                
                # 提取基本信息
                if 'id' in data and not response_id:
                    response_id = data['id']
                if 'model' in data and not model:
                    model = data['model']
                
                # 提取usage信息（可能在任何chunk中，包括最后一个只有usage的chunk）
                if 'usage' in data:
                    usage_data = data['usage']
                    input_tokens = usage_data.get('prompt_tokens', input_tokens)
                    output_tokens = usage_data.get('completion_tokens', output_tokens)
                
                # 也检查x_groq格式的usage（某些上游服务使用）
                if 'x_groq' in data and 'usage' in data['x_groq']:
                    usage_data = data['x_groq']['usage']
                    input_tokens = usage_data.get('prompt_tokens', input_tokens)
                    output_tokens = usage_data.get('completion_tokens', output_tokens)
                
                choices = data.get('choices', [])
                if not choices:
                    continue
                
                choice = choices[0]
                delta = choice.get('delta', {})
                
                # 检查finish_reason
                if choice.get('finish_reason'):
                    finish_reason = choice['finish_reason']
                
                # 处理reasoning_content（思考过程）
                reasoning_delta = (
                    delta.get('reasoning_content') or
                    delta.get('reasoning') or
                    delta.get('thinking_content')
                )
                if reasoning_delta:
                    accumulated_reasoning += reasoning_delta
                
                # 提取思考签名
                if 'tool_calls' in delta:
                    for tc in delta['tool_calls']:
                        extra_content = tc.get('extra_content', {})
                        if extra_content:
                            google_extra = extra_content.get('google', {})
                            if google_extra and 'thought_signature' in google_extra:
                                thinking_signature = google_extra['thought_signature']
                            elif 'thought_signature' in extra_content:
                                thinking_signature = extra_content['thought_signature']
                
                # 检查delta级别的签名
                if not thinking_signature:
                    extra_content = delta.get('extra_content', {})
                    if extra_content:
                        google_extra = extra_content.get('google', {})
                        if google_extra and 'thought_signature' in google_extra:
                            thinking_signature = google_extra['thought_signature']
                        elif 'thought_signature' in extra_content:
                            thinking_signature = extra_content['thought_signature']
                    if not thinking_signature and 'signature' in delta:
                        thinking_signature = delta['signature']
                
                # 处理文本内容
                if 'content' in delta and delta['content']:
                    content_delta = delta['content']

                    # 如果启用了thinking parser，先解析
                    if thinking_parser:
                        segments = thinking_parser.push_and_parse(content_delta)
                        for segment in segments:
                            if segment.type == SegmentType.THINKING:
                                # Thinking内容
                                accumulated_reasoning += segment.content
                            elif segment.type == SegmentType.TEXT:
                                # 普通文本
                                accumulated_text += segment.content
                    else:
                        # 没有启用thinking parser，直接添加
                        accumulated_text += content_delta
                
                # 处理工具调用
                if 'tool_calls' in delta:
                    for tc in delta['tool_calls']:
                        tc_index = tc.get('index', 0)
                        tc_id = tc.get('id', '')
                        
                        # 首先尝试通过id查找已存在的工具调用
                        found_index = None
                        if tc_id:
                            for idx, existing_tc in tool_calls.items():
                                if existing_tc['id'] == tc_id:
                                    found_index = idx
                                    break
                        
                        if found_index is not None:
                            tc_index = found_index
                        elif tc_id and tc_id not in [t['id'] for t in tool_calls.values() if t['id']]:
                            tc_index = len(tool_calls)
                        
                        if tc_index not in tool_calls:
                            tool_calls[tc_index] = {
                                'id': tc_id,
                                'name': '',
                                'arguments': ''
                            }
                        
                        if 'id' in tc and tc['id']:
                            tool_calls[tc_index]['id'] = tc['id']
                        
                        if 'function' in tc:
                            func = tc['function']
                            if 'name' in func:
                                tool_calls[tc_index]['name'] = func['name']
                            if 'arguments' in func:
                                tool_calls[tc_index]['arguments'] += func['arguments']

        # 如果启用了thinking parser，刷新缓冲区
        if thinking_parser:
            final_segments = thinking_parser.flush()
            for segment in final_segments:
                if segment.type == SegmentType.THINKING:
                    # Thinking内容
                    accumulated_reasoning += segment.content
                elif segment.type == SegmentType.TEXT:
                    # 普通文本
                    accumulated_text += segment.content

        # 构建完整的OpenAI响应
        message = {
            "role": "assistant",
            "content": accumulated_text if accumulated_text else None
        }
        
        # 添加reasoning_content
        if accumulated_reasoning:
            message["reasoning_content"] = accumulated_reasoning
        
        # 添加签名
        if thinking_signature:
            message["signature"] = thinking_signature
        
        # 添加工具调用
        if tool_calls:
            message["tool_calls"] = []
            for idx in sorted(tool_calls.keys()):
                tc = tool_calls[idx]
                message["tool_calls"].append({
                    "id": tc['id'] or f"call_{uuid.uuid4().hex[:24]}",
                    "type": "function",
                    "function": {
                        "name": tc['name'],
                        "arguments": tc['arguments']
                    }
                })
        
        # 确定finish_reason
        if not finish_reason:
            if tool_calls:
                finish_reason = "tool_calls"
            else:
                finish_reason = "stop"
        
        response = {
            "id": response_id or f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": finish_reason
                }
            ],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens
            }
        }
        
        return response
    
    @classmethod
    def create_error_response(
        cls,
        error_type: str,
        message: str
    ) -> AnthropicErrorResponse:
        """
        创建Anthropic格式的错误响应
        
        Args:
            error_type: 错误类型
            message: 错误消息
            
        Returns:
            Anthropic格式的错误响应
        """
        return AnthropicErrorResponse(
            error=AnthropicErrorDetail(
                type=error_type,
                message=message
            )
        )
