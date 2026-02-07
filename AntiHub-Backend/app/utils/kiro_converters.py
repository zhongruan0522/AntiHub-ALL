# -*- coding: utf-8 -*-

"""
Kiro 转换器工具函数

包含 Extended Thinking 模式支持函数
"""

from typing import Any, Dict, Optional, Union
import logging
import uuid

logger = logging.getLogger(__name__)


# ==================================================================================================
# Thinking Mode 支持
# ==================================================================================================

# Anthropic Extended Thinking 默认预算（参考 kiro.rs）
DEFAULT_MAX_THINKING_LENGTH = 20000
# Anthropic Extended Thinking 最大预算（参考 kiro.rs）
MAX_THINKING_LENGTH = 24576

# Thinking adaptive effort 默认值（参考 kiro.rs: output_config.effort 默认 high）
DEFAULT_THINKING_EFFORT = "high"


def is_thinking_enabled(thinking_config: Optional[Union[Dict[str, Any], bool, str]]) -> bool:
    """
    检测 thinking 是否启用。

    支持多种格式：
    - None: 未启用
    - bool: True/False
    - str: "enabled" / "adaptive"
    - dict: {"type": "enabled"|"adaptive", "budget_tokens": 10000}

    Args:
        thinking_config: thinking 配置

    Returns:
        是否启用 thinking
    """
    return get_thinking_type(thinking_config) is not None


def get_thinking_type(thinking_config: Optional[Union[Dict[str, Any], bool, str]]) -> Optional[str]:
    """
    获取 thinking 模式类型（enabled / adaptive）。

    说明：
    - 兼容历史用法：bool True 视为 enabled；dict 只要 budget_tokens>0 也视为 enabled。
    - 对齐 kiro.rs：支持 adaptive。
    """
    if thinking_config is None:
        return None

    if isinstance(thinking_config, bool):
        return "enabled" if thinking_config else None

    if isinstance(thinking_config, str):
        t = thinking_config.strip().lower()
        if t in ("enabled", "adaptive"):
            return t
        return None

    if isinstance(thinking_config, dict):
        type_val = str(thinking_config.get("type", "")).strip().lower()
        if type_val in ("enabled", "adaptive"):
            return type_val

        budget = thinking_config.get("budget_tokens")
        if isinstance(budget, (int, float)) and budget > 0:
            return "enabled"

    return None


def get_thinking_budget(thinking_config: Optional[Union[Dict[str, Any], bool, str]]) -> int:
    """
    获取 thinking 的 token 预算。

    Args:
        thinking_config: thinking 配置

    Returns:
        token 预算，默认为 DEFAULT_MAX_THINKING_LENGTH
    """
    if isinstance(thinking_config, dict):
        budget = thinking_config.get("budget_tokens")
        if isinstance(budget, (int, float)) and budget > 0:
            return max(1, min(int(budget), MAX_THINKING_LENGTH))
    return DEFAULT_MAX_THINKING_LENGTH


def get_thinking_effort(output_config: Optional[Any]) -> str:
    """
    从 output_config 中提取 adaptive thinking 的 effort。

    Claude Code/Anthropic 常见格式：
    - output_config: {"effort": "high"|"medium"|"low"}
    """
    if output_config is None:
        return DEFAULT_THINKING_EFFORT

    effort = None
    if isinstance(output_config, dict):
        effort = output_config.get("effort")
    else:
        effort = getattr(output_config, "effort", None)

    if not isinstance(effort, str):
        return DEFAULT_THINKING_EFFORT

    cleaned = effort.strip().lower()
    return cleaned or DEFAULT_THINKING_EFFORT


def generate_thinking_hint(
    thinking_config: Optional[Union[Dict[str, Any], bool, str]],
    output_config: Optional[Any] = None,
) -> str:
    """
    生成 thinking 模式的提示标签。

    Args:
        thinking_config: thinking 配置
        output_config: 输出配置（用于 adaptive effort）

    Returns:
        thinking 提示标签字符串
    """
    thinking_type = get_thinking_type(thinking_config) or "enabled"

    if thinking_type == "adaptive":
        effort = get_thinking_effort(output_config)
        return (
            f"<thinking_mode>adaptive</thinking_mode><thinking_effort>{effort}</thinking_effort>"
        )

    budget = get_thinking_budget(thinking_config)
    return f"<thinking_mode>enabled</thinking_mode><max_thinking_length>{budget}</max_thinking_length>"


def inject_thinking_hint(
    system_prompt: str,
    thinking_config: Optional[Union[Dict[str, Any], bool, str]],
    output_config: Optional[Any] = None,
) -> str:
    """
    将 thinking 提示注入到 system prompt 中。

    如果 system prompt 已经包含 thinking 标签，则不重复注入。

    Args:
        system_prompt: 原始 system prompt
        thinking_config: thinking 配置
        output_config: 输出配置（用于 adaptive effort）

    Returns:
        注入后的 system prompt
    """
    if not is_thinking_enabled(thinking_config):
        return system_prompt

    # 检查是否已经包含 thinking 标签
    if (
        "<thinking_mode>" in system_prompt
        or "<max_thinking_length>" in system_prompt
        or "<thinking_effort>" in system_prompt
    ):
        return system_prompt

    thinking_hint = generate_thinking_hint(thinking_config, output_config=output_config)

    if not system_prompt:
        return thinking_hint

    # 将 thinking hint 添加到 system prompt 开头
    return f"{thinking_hint}\n\n{system_prompt}"


def add_kiro_conversation_state(payload: Dict[str, Any]) -> None:
    """
    为 Kiro payload 添加 conversationState 字段。

    Args:
        payload: Kiro 请求 payload（会被原地修改）
    """
    if "conversationState" not in payload:
        payload["conversationState"] = {}

    payload["conversationState"]["agentContinuationId"] = str(uuid.uuid4())
    payload["conversationState"]["agentTaskType"] = "vibe"


def apply_thinking_to_request(
    openai_request: Dict[str, Any],
    thinking_config: Optional[Union[Dict[str, Any], bool, str]] = None,
    output_config: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    将 thinking 配置应用到 OpenAI 格式的请求中。

    Args:
        openai_request: OpenAI 格式的请求
        thinking_config: thinking 配置
        output_config: 输出配置（用于 adaptive effort）

    Returns:
        修改后的请求（原地修改并返回）
    """
    if not is_thinking_enabled(thinking_config):
        return openai_request

    messages = openai_request.get("messages", [])
    if not isinstance(messages, list):
        messages = []
        openai_request["messages"] = messages

    injected = False
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "system":
            system_prompt = msg.get("content", "")
            if isinstance(system_prompt, str):
                msg["content"] = inject_thinking_hint(
                    system_prompt, thinking_config, output_config=output_config
                )
                injected = True
                logger.debug("Injected thinking hint into existing system prompt")
                break

    # 没有 system prompt 时，创建一个仅包含 thinking hint 的 system 消息
    if not injected:
        messages.insert(
            0,
            {
                "role": "system",
                "content": generate_thinking_hint(thinking_config, output_config=output_config),
            },
        )
        logger.debug("Inserted system prompt with thinking hint")

    return openai_request
