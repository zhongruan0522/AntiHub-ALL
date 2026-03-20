# -*- coding: utf-8 -*-
"""
Truncation recovery system for handling upstream Kiro API limitations.

Generates synthetic messages to inform the model about truncation.
ONLY activates when truncation is actually detected.

This module addresses the issue where Kiro API truncates large tool call payloads
and content mid-stream. Since this is an upstream limitation that cannot be
prevented, we inform the model about the truncation so it can adapt its approach.
"""

import os
from typing import Dict, Any
import logging

logger = logging.getLogger(__name__)


def should_inject_recovery() -> bool:
    """
    Check if truncation recovery is enabled.
    
    Returns:
        True if recovery should be injected, False otherwise
    """
    return os.getenv("KIRO_TRUNCATION_RECOVERY", "true").lower() == "true"


def generate_truncation_tool_result(
    tool_name: str,
    tool_use_id: str,
    truncation_info: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Generate synthetic tool_result for truncated tool call.
    
    Message is carefully worded to:
    - Acknowledge API limitation (not model's fault)
    - Warn against repeating same operation
    - NOT give specific instructions (avoid micro-steps)
    
    Args:
        tool_name: Name of the truncated tool
        tool_use_id: ID of the truncated tool call
        truncation_info: Diagnostic information about truncation
    
    Returns:
        Synthetic tool_result in unified format
    
    Example:
        >>> generate_truncation_tool_result("Write", "call_123", {"size_bytes": 5000, "reason": "missing 2 closing braces"})
        {'type': 'tool_result', 'tool_use_id': 'call_123', 'content': '[API Limitation] ...', 'is_error': True}
    """
    content = (
        "[API Limitation] Your tool call was truncated by the upstream API due to output size limits.\n\n"
        "If the tool result below shows an error or unexpected behavior, this is likely a CONSEQUENCE of the truncation, "
        "not the root cause. The tool call itself was cut off before it could be fully transmitted.\n\n"
        "Repeating the exact same operation will be truncated again. Consider adapting your approach."
    )
    
    logger.debug(
        f"Generated synthetic tool_result for truncated tool '{tool_name}' "
        f"(id={tool_use_id}, {truncation_info.get('size_bytes', 'unknown')} bytes, {truncation_info.get('reason', 'unknown reason')})"
    )
    
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
        "is_error": True
    }


def generate_truncation_user_message() -> str:
    """
    Generate synthetic user message for content truncation.
    
    Message is carefully worded to:
    - Acknowledge it's not model's fault
    - Suggest adaptation without specific instructions
    - NOT tell model to "break into steps" (causes micro-steps)
    
    Returns:
        Synthetic user message text
    
    Example:
        >>> generate_truncation_user_message()
        '[System Notice] Your previous response was truncated...'
    """
    return (
        "[System Notice] Your previous response was truncated by the API due to "
        "output size limitations. This is not an error on your part. "
        "If you need to continue, please adapt your approach rather than repeating the same output."
    )
