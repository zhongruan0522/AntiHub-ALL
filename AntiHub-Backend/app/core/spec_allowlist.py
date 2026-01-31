"""
Spec × config_type 白名单矩阵（单一事实来源）。

整理自 `Report.md` 的 3.1-3.4 小节：
- 现状白名单：线上默认启用（只做“建议拉黑”的收敛）
- 目标态白名单：仅在补齐对应兼容/修复后再启用（默认不启用）
"""

from __future__ import annotations

from typing import Final, FrozenSet, Literal, Mapping

SpecName = Literal["OAIResponses", "OAIChat", "Claude", "Gemini"]


# 现状白名单（默认启用）
SPEC_CONFIG_TYPE_ALLOWLIST_CURRENT: Final[Mapping[SpecName, FrozenSet[str]]] = {
    # Report.md 3.1
    "OAIResponses": frozenset({"codex"}),
    # Report.md 3.2
    "OAIChat": frozenset({"antigravity", "kiro", "qwen", "gemini-cli"}),
    # Report.md 3.3
    "Claude": frozenset({"antigravity", "kiro", "qwen"}),
    # Report.md 3.4
    "Gemini": frozenset({"gemini-cli", "zai-image", "antigravity"}),
}


# 目标态白名单（默认不启用）
SPEC_CONFIG_TYPE_ALLOWLIST_TARGET: Final[Mapping[SpecName, FrozenSet[str]]] = {
    "OAIResponses": frozenset({"codex"}),
    "OAIChat": frozenset({"antigravity", "kiro", "qwen", "gemini-cli", "codex"}),
    "Claude": frozenset({"antigravity", "kiro", "qwen"}),
    "Gemini": frozenset({"gemini-cli", "zai-image", "antigravity"}),
}


# 所有校验默认只使用现状 allowlist，避免隐式放开“目标态”。
DEFAULT_SPEC_CONFIG_TYPE_ALLOWLIST: Final[Mapping[SpecName, FrozenSet[str]]] = (
    SPEC_CONFIG_TYPE_ALLOWLIST_CURRENT
)
