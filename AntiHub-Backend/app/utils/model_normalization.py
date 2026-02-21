from __future__ import annotations

"""
Model id normalization helpers.

Why this exists:
- Some upstreams (Kiro / cloudcode-pa / gateways) are strict about model ids.
- The UI / clients may use "friendly" aliases like `claude-sonnet-4-6` or add
  suffixes like `-thinking`.
- Reference implementation: `2-参考项目/kiro.rs` exposes dash-version ids to clients
  but converts them to dot-version ids when calling upstream (e.g. 4-6 -> 4.6).
"""


def normalize_claude_model_id(model: str) -> str:
    """
    Best-effort normalization for Claude 4.x model ids.

    Examples:
    - claude-sonnet-4-6 -> claude-sonnet-4.6
    - claude-opus-4-6-thinking -> claude-opus-4.6
    - anthropic/claude-sonnet-4-5-20250929 -> anthropic/claude-sonnet-4.5

    Non-Claude model ids are returned unchanged.
    """
    raw = str(model or "").strip()
    if not raw:
        return ""

    # Support `provider/model` style ids (OpenRouter-like); only normalize the last segment.
    prefix = ""
    model_id = raw
    if "/" in raw:
        parts = raw.split("/")
        prefix = "/".join(parts[:-1])
        model_id = parts[-1].strip()

    if not model_id:
        return raw

    lowered = model_id.lower()

    # UI-only alias: treat `-thinking` as a suffix, not part of the upstream model id.
    if lowered.endswith("-thinking"):
        model_id = model_id[: -len("-thinking")]
        lowered = model_id.lower()

    normalized = model_id

    # Only normalize the Kiro-style Claude 4.x family; keep other Claude ids intact
    # (e.g. `claude-3-5-sonnet`).
    if lowered.startswith("claude-sonnet-"):
        if "4-6" in lowered or "4.6" in lowered:
            normalized = "claude-sonnet-4.6"
        elif "4-5" in lowered or "4.5" in lowered:
            normalized = "claude-sonnet-4.5"
        elif "claude-sonnet-4" in lowered:
            # date-suffixed ids like `claude-sonnet-4-20250514`
            normalized = "claude-sonnet-4"
    elif lowered.startswith("claude-opus-"):
        if "4-5" in lowered or "4.5" in lowered:
            normalized = "claude-opus-4.5"
        elif "4-6" in lowered or "4.6" in lowered:
            normalized = "claude-opus-4.6"
    elif lowered.startswith("claude-haiku-"):
        if "4-5" in lowered or "4.5" in lowered:
            normalized = "claude-haiku-4.5"

    if not prefix:
        return normalized

    # Preserve the original provider prefix.
    return f"{prefix}/{normalized}"

