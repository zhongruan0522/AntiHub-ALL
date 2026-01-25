"""
Codex 账号服务

功能范围（先做最小闭环）：
- 生成 Codex OAuth 登录链接（PKCE + state）
- 解析回调 URL，交换 token（可选：运行时需要外网）
- 导入/导出账号凭证（JSON），并落库
- 提供模型列表（本地常量，不对外拉取）
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Set, Tuple
import base64
import hashlib
import json
import logging
import os
import secrets
from uuid import uuid4
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache import RedisClient
from app.repositories.codex_account_repository import CodexAccountRepository
from app.repositories.codex_fallback_config_repository import CodexFallbackConfigRepository
from app.utils.encryption import encrypt_api_key as encrypt_secret
from app.utils.encryption import decrypt_api_key as decrypt_secret


OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize"
OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"
OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

# 兼容 CLIProxyAPI / Codex CLI 的 redirect_uri（不绑定域名，方便手动复制回调 URL）
OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback"

OAUTH_SCOPE = "openid email profile offline_access"
OAUTH_SESSION_TTL_SECONDS = 10 * 60

# 额度（余额）查询：不同环境/版本可能路径不同，这里做“多候选 + 尽量解析”。
OPENAI_CREDIT_GRANTS_URLS = (
    "https://api.openai.com/dashboard/billing/credit_grants",
    "https://api.openai.com/v1/dashboard/billing/credit_grants",
)


SUPPORTED_MODELS = [
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1",
    "gpt-5-codex",
    "gpt-5-codex-mini",
    "gpt-5",
]

CODEX_MODEL_ALIASES = {
    # Common client aliases (e.g. CLIProxyAPI example config)
    "codex-latest": "gpt-5-codex",
    "codex-mini": "gpt-5-codex-mini",
}

CODEX_API_BASE_URL = (os.getenv("CODEX_API_BASE_URL") or "https://chatgpt.com/backend-api/codex").rstrip("/")
CODEX_RESPONSES_URL = f"{CODEX_API_BASE_URL}/responses"
_CODEX_BASE_FOR_WHAM = CODEX_API_BASE_URL.rstrip("/")
if _CODEX_BASE_FOR_WHAM.endswith("/codex"):
    _CODEX_BASE_FOR_WHAM = _CODEX_BASE_FOR_WHAM[: -len("/codex")]
CODEX_WHAM_USAGE_URL = f"{_CODEX_BASE_FOR_WHAM}/wham/usage"
CODEX_DEFAULT_VERSION = "0.21.0"
CODEX_OPENAI_BETA = "responses=experimental"
CODEX_DEFAULT_USER_AGENT = "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464"
CODEX_FALLBACK_PLATFORM = "CodexCLI"

logger = logging.getLogger(__name__)


def _get_outbound_proxy_url() -> str:
    """
    出站代理（可选）。

    背景：很多部署环境（尤其是容器/国内网络）直连 `chatgpt.com/auth.openai.com/api.openai.com`
    会超时；参考项目 CLIProxyAPI 通过 proxy-url 解决。本项目用环境变量做最小实现。
    """
    for key in ("CODEX_PROXY_URL", "OPENAI_PROXY_URL", "PROXY_URL"):
        v = (os.getenv(key) or "").strip()
        if v:
            return v
    return ""


def _redact_proxy_url(proxy_url: str) -> str:
    if not proxy_url:
        return ""
    try:
        u = urlparse(proxy_url)
    except Exception:
        return ""
    if not u.scheme:
        return ""
    host = u.hostname or ""
    if not host:
        return f"{u.scheme}://"
    if u.port:
        host = f"{host}:{u.port}"
    return f"{u.scheme}://{host}"


def _get_httpx_proxies() -> Optional[Dict[str, str]]:
    proxy_url = _get_outbound_proxy_url()
    if not proxy_url:
        return None

    # httpx==0.25.*：SOCKS 代理需要额外安装 socksio（httpx[socks]）
    scheme = proxy_url.strip().lower()
    if scheme.startswith(("socks5://", "socks5h://", "socks4://", "socks4a://")):
        try:
            import socksio  # type: ignore
        except Exception as e:
            raise ValueError(
                "已配置 SOCKS 代理，但当前环境未安装 socks 支持；请安装 `httpx[socks]`（或改用 HTTP 代理）"
            ) from e

    return {"http://": proxy_url, "https://": proxy_url}


def _build_httpx_async_client(*, timeout: Optional[httpx.Timeout], follow_redirects: bool = False) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, follow_redirects=follow_redirects, proxies=_get_httpx_proxies())


@dataclass(frozen=True)
class PKCECodes:
    code_verifier: str
    code_challenge: str


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    s = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _normalize_percent(value: Optional[int], *, field_name: str) -> Optional[int]:
    if value is None:
        return None
    try:
        iv = int(value)
    except Exception as e:
        raise ValueError(f"{field_name} 必须是整数") from e
    if iv < 0 or iv > 100:
        raise ValueError(f"{field_name} 必须在 0-100 之间")
    return iv


def _base64url_no_padding(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _generate_pkce_codes() -> PKCECodes:
    # 96 bytes -> base64url(no padding) length ≈ 128 chars
    verifier = _base64url_no_padding(secrets.token_bytes(96))
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    challenge = _base64url_no_padding(digest)
    return PKCECodes(code_verifier=verifier, code_challenge=challenge)


def _generate_state() -> str:
    # 32 hex chars，足够且可读
    return secrets.token_hex(16)


def _parse_oauth_callback(input_str: str) -> Dict[str, str]:
    """
    解析 OAuth 回调 URL（兼容用户粘贴的多种形式）：
    - 完整 URL：http://localhost:1455/auth/callback?code=...&state=...
    - 仅 query：?code=...&state=...
    - 直接 k=v：code=...&state=...
    - fragment：#code=...&state=...
    """
    trimmed = (input_str or "").strip()
    if not trimmed:
        raise ValueError("callback_url 不能为空")

    candidate = trimmed
    if "://" not in candidate:
        if candidate.startswith("?"):
            candidate = "http://localhost" + candidate
        elif any(ch in candidate for ch in "/?#") or ":" in candidate:
            candidate = "http://" + candidate
        elif "=" in candidate:
            candidate = "http://localhost/?" + candidate
        else:
            raise ValueError("callback_url 不是合法的 URL 或 query")

    parsed = urlparse(candidate)
    q = parse_qs(parsed.query)

    code = (q.get("code", [""])[0] or "").strip()
    state = (q.get("state", [""])[0] or "").strip()
    err = (q.get("error", [""])[0] or "").strip()
    err_desc = (q.get("error_description", [""])[0] or "").strip()

    if parsed.fragment:
        fq = parse_qs(parsed.fragment)
        if not code:
            code = (fq.get("code", [""])[0] or "").strip()
        if not state:
            state = (fq.get("state", [""])[0] or "").strip()
        if not err:
            err = (fq.get("error", [""])[0] or "").strip()
        if not err_desc:
            err_desc = (fq.get("error_description", [""])[0] or "").strip()

    if code and not state and "#" in code:
        parts = code.split("#", 1)
        code = parts[0].strip()
        state = parts[1].strip()

    if not err and err_desc:
        err = err_desc
        err_desc = ""

    if not code and not err:
        raise ValueError("callback_url 缺少 code")
    if not state:
        raise ValueError("callback_url 缺少 state")

    return {"code": code, "state": state, "error": err, "error_description": err_desc}


def _decode_id_token(id_token: str) -> Dict[str, Any]:
    if not id_token:
        return {}
    try:
        return jwt.decode(id_token, options={"verify_signature": False})
    except Exception:
        return {}


def _extract_openai_profile_from_claims(claims: Dict[str, Any]) -> Dict[str, Optional[str]]:
    email = claims.get("email")
    auth_info = claims.get("https://api.openai.com/auth") or {}
    if not isinstance(auth_info, dict):
        auth_info = {}

    account_id = auth_info.get("chatgpt_account_id") or None
    plan_type = auth_info.get("chatgpt_plan_type") or None

    # 兜底：有些 token 里 user_id 更稳定
    if not account_id:
        account_id = auth_info.get("user_id") or None

    return {
        "email": str(email) if email else None,
        "openai_account_id": str(account_id) if account_id else None,
        "chatgpt_plan_type": str(plan_type) if plan_type else None,
    }


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _mask_secret(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if len(raw) <= 8:
        return "*" * len(raw)
    return raw[:3] + ("*" * (len(raw) - 7)) + raw[-4:]


def _normalize_fallback_base_url(base_url: str) -> str:
    raw = (base_url or "").strip()
    if not raw:
        raise ValueError("base_url 不能为空")

    raw = raw.rstrip("/")
    # 用户可能会直接粘贴完整 `/responses`，这里兜底去掉，避免重复拼接。
    if raw.lower().endswith("/responses"):
        raw = raw[: -len("/responses")].rstrip("/")

    u = urlparse(raw)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("base_url 必须是以 http(s):// 开头的完整地址")

    return raw


def _join_base_url(base_url: str, path: str) -> str:
    b = (base_url or "").rstrip("/")
    p = path if path.startswith("/") else ("/" + path)
    return b + p


def _normalize_fallback_responses_request(request_data: Dict[str, Any]) -> Dict[str, Any]:
    # 非流式请求也需要通过 SSE 抽取 response.completed（与 Codex 主链路一致）。
    body = dict(request_data or {})
    body["stream"] = True
    if "model" in body:
        resolved = _resolve_codex_model_name(body.get("model"))
        if resolved:
            body["model"] = resolved
    return body


def _extract_error_detail_code(err_text: str) -> str:
    """
    从上游错误 JSON 中提取 code（优先 detail.code）。

    典型样例：
    - {"detail":{"code":"deactivated_workspace"}}
    """
    raw = (err_text or "").strip()
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
    except Exception:
        return ""
    if not isinstance(obj, dict):
        return ""

    detail = obj.get("detail")
    if isinstance(detail, dict):
        return _safe_str(detail.get("code"))

    # 兜底：部分实现可能把 code 放在顶层或 error.code
    top = _safe_str(obj.get("code"))
    if top:
        return top
    err = obj.get("error")
    if isinstance(err, dict):
        return _safe_str(err.get("code"))
    return ""


def _default_codex_account_name(email: Optional[str], openai_account_id: Optional[str]) -> str:
    """
    Default account display name:
    - first 3 chars of email local-part + first segment of account_id (before '-')
    """
    email_str = _safe_str(email)
    local = email_str.split("@", 1)[0] if email_str else ""
    email_prefix = local[:3] if local else ""

    account_id_str = _safe_str(openai_account_id)
    account_prefix = account_id_str.split("-", 1)[0] if account_id_str else ""

    if email_prefix and account_prefix:
        return f"{email_prefix}-{account_prefix}"
    if email_prefix:
        return email_prefix
    if account_prefix:
        return account_prefix
    return email_str or "Codex Account"


def _parse_codemodels_env(raw: str) -> list[str]:
    value = (raw or "").strip()
    if not value:
        return []

    if value.startswith("["):
        try:
            parsed = json.loads(value)
        except Exception:
            parsed = None
        if isinstance(parsed, list):
            out: list[str] = []
            for item in parsed:
                s = _safe_str(item)
                if s:
                    out.append(s)
            return out
        return []

    parts = [p.strip() for p in value.replace("\n", ",").split(",")]
    return [p for p in parts if p]


def _get_supported_models() -> list[str]:
    env_raw = os.environ.get("CODEX_SUPPORTED_MODELS", "")
    models = _parse_codemodels_env(env_raw)
    if models:
        deduped: list[str] = []
        seen: set[str] = set()
        for m in models:
            key = m.lower()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(m)
        return deduped

    return list(SUPPORTED_MODELS)


def _pick_codex_ping_model(models: list[str]) -> str:
    if not models:
        return ""
    preferred = ("gpt-5.2-codex", "gpt-5.1-codex", "gpt-5-codex")
    lowered = {m.lower(): m for m in models}
    for key in preferred:
        if key in lowered:
            return lowered[key]
    return models[0]


def _resolve_codex_model_name(model: Any) -> str:
    raw = _safe_str(model)
    if not raw:
        return ""
    alias = CODEX_MODEL_ALIASES.get(raw.lower())
    return alias or raw


def _parse_retry_after(headers: httpx.Headers, *, now: datetime) -> Optional[datetime]:
    """
    解析 Retry-After，返回“预计可重试时间”（UTC）。
    - 支持秒数（int）
    - 支持 HTTP date（RFC1123）
    """
    ra = _safe_str(headers.get("Retry-After"))
    if not ra:
        return None

    try:
        seconds = int(ra)
        if seconds < 0:
            seconds = 0
        return now + timedelta(seconds=seconds)
    except Exception:
        pass

    try:
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(ra)
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _try_parse_int_header(value: Any) -> Optional[int]:
    raw = _safe_str(value)
    if not raw:
        return None
    try:
        return int(raw)
    except Exception:
        pass
    try:
        return int(float(raw))
    except Exception:
        return None


def _parse_reset_at(value: Any, *, now: datetime) -> Optional[datetime]:
    raw = _safe_str(value)
    if not raw:
        return None

    # seconds-from-now (int/float) or unix timestamp
    try:
        num = float(raw)
        if num > 1_000_000_000:
            return datetime.fromtimestamp(num, tz=timezone.utc)
        if num < 0:
            num = 0
        return now + timedelta(seconds=num)
    except Exception:
        pass

    # HTTP date
    try:
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(raw)
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass

    # ISO8601
    dt = _parse_iso_datetime(raw)
    if dt is None:
        return None
    return dt.astimezone(timezone.utc)


def _detect_ratelimit_bucket(header_key: str) -> Optional[str]:
    k = (header_key or "").lower()
    if any(t in k for t in ("5h", "5-hour", "5hours", "5hour", "five_hour", "five-hour")):
        return "5h"
    if any(t in k for t in ("week", "weekly", "7d", "7-day", "7day", "7days", "168h")):
        return "week"
    return None


def _compute_used_percent(limit_value: Optional[int], remaining_value: Optional[int]) -> Optional[int]:
    if limit_value is None or remaining_value is None:
        return None
    if limit_value <= 0:
        return None
    remaining = max(0, min(int(limit_value), int(remaining_value)))
    used_ratio = (limit_value - remaining) / float(limit_value)
    pct = int(round(used_ratio * 100))
    return max(0, min(100, pct))


def _extract_ratelimit_snapshot(headers: httpx.Headers, *, now: datetime) -> Dict[str, Dict[str, Optional[Any]]]:
    buckets: Dict[str, Dict[str, Optional[Any]]] = {
        "5h": {"limit": None, "remaining": None, "reset_at": None},
        "week": {"limit": None, "remaining": None, "reset_at": None},
        "default": {"limit": None, "remaining": None, "reset_at": None},
    }

    for key, value in headers.items():
        lk = (key or "").lower()
        if "ratelimit" not in lk:
            continue

        bucket = _detect_ratelimit_bucket(lk) or "default"
        target = buckets.get(bucket) or buckets["default"]

        if "reset" in lk:
            parsed = _parse_reset_at(value, now=now)
            if parsed is not None:
                target["reset_at"] = parsed
            continue

        # 避免把 token/tpm 之类当成 5h/周限
        if any(t in lk for t in ("token", "tpm")):
            continue

        if "remaining" in lk:
            parsed = _try_parse_int_header(value)
            if parsed is not None:
                target["remaining"] = parsed
        elif "limit" in lk:
            parsed = _try_parse_int_header(value)
            if parsed is not None:
                target["limit"] = parsed

    # 如果上游只给了一组（无 bucket），默认当作 5h
    if buckets["5h"]["limit"] is None and buckets["default"]["limit"] is not None:
        buckets["5h"]["limit"] = buckets["default"]["limit"]
    if buckets["5h"]["remaining"] is None and buckets["default"]["remaining"] is not None:
        buckets["5h"]["remaining"] = buckets["default"]["remaining"]
    if buckets["5h"]["reset_at"] is None and buckets["default"]["reset_at"] is not None:
        buckets["5h"]["reset_at"] = buckets["default"]["reset_at"]

    return buckets


def _infer_limit_bucket(error_text: str) -> str:
    """
    尝试从错误文案推断是 5h 还是 week。
    返回：'week' | '5h'
    """
    text = (error_text or "").lower()
    if any(k in text for k in ("week", "weekly", "per week", "7 day", "7-day", "7day")):
        return "week"
    if any(k in text for k in ("5h", "5 h", "5-hour", "5 hour", "5hours", "5 hours")):
        return "5h"
    return "5h"


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    s = _safe_str(value)
    if not s:
        return None
    try:
        return int(s)
    except Exception:
        try:
            return int(float(s))
        except Exception:
            return None


def _safe_percent(value: Any) -> Optional[int]:
    i = _safe_int(value)
    if i is None:
        return None
    return max(0, min(100, i))


def _parse_wham_window(
    window: Any,
    *,
    now: datetime,
    allowed: Optional[bool],
    limit_reached: Optional[bool],
) -> Dict[str, Any]:
    if not isinstance(window, dict):
        return {"used_percent": None, "limit_window_seconds": None, "reset_after_seconds": None, "reset_at": None}

    used_percent = _safe_percent(window.get("used_percent") if "used_percent" in window else window.get("usedPercent"))
    limit_window_seconds = _safe_int(
        window.get("limit_window_seconds") if "limit_window_seconds" in window else window.get("limitWindowSeconds")
    )
    reset_after_seconds = _safe_int(
        window.get("reset_after_seconds") if "reset_after_seconds" in window else window.get("resetAfterSeconds")
    )
    reset_at_unix = _safe_int(window.get("reset_at") if "reset_at" in window else window.get("resetAt"))

    reset_at: Optional[datetime] = None
    if reset_at_unix is not None:
        try:
            reset_at = datetime.fromtimestamp(int(reset_at_unix), tz=timezone.utc)
        except Exception:
            reset_at = None
    elif reset_after_seconds is not None:
        try:
            reset_at = now + timedelta(seconds=int(reset_after_seconds))
        except Exception:
            reset_at = None

    # wham/usage 有时不返回 used_percent；如果已到顶且能推断 reset，则按 100% 处理，避免 UI 显示空。
    if used_percent is None and reset_at is not None:
        if allowed is False or limit_reached is True:
            used_percent = 100

    return {
        "used_percent": used_percent,
        "limit_window_seconds": limit_window_seconds,
        "reset_after_seconds": reset_after_seconds,
        "reset_at": reset_at,
    }


def _parse_wham_usage(payload: Any, *, now: datetime) -> Dict[str, Any]:
    """
    解析 `GET /backend-api/wham/usage` 响应，输出统一结构（兼容 snake_case + camelCase）。
    注意：这里只做“best effort”，字段缺失时保持为 None，不抛异常。
    """
    if not isinstance(payload, dict):
        return {
            "plan_type": None,
            "rate_limit": {},
            "code_review_rate_limit": {},
        }

    plan_type = _safe_str(payload.get("plan_type") if "plan_type" in payload else payload.get("planType")) or None

    rate_limit = payload.get("rate_limit") if "rate_limit" in payload else payload.get("rateLimit")
    if not isinstance(rate_limit, dict):
        rate_limit = {}
    rl_allowed = rate_limit.get("allowed")
    rl_limit_reached = rate_limit.get("limit_reached") if "limit_reached" in rate_limit else rate_limit.get("limitReached")
    allowed = rl_allowed if isinstance(rl_allowed, bool) else None
    limit_reached = rl_limit_reached if isinstance(rl_limit_reached, bool) else None

    primary = rate_limit.get("primary_window") if "primary_window" in rate_limit else rate_limit.get("primaryWindow")
    secondary = (
        rate_limit.get("secondary_window") if "secondary_window" in rate_limit else rate_limit.get("secondaryWindow")
    )

    code_review = (
        payload.get("code_review_rate_limit")
        if "code_review_rate_limit" in payload
        else payload.get("codeReviewRateLimit")
    )
    if not isinstance(code_review, dict):
        code_review = {}
    cr_allowed = code_review.get("allowed")
    cr_limit_reached = (
        code_review.get("limit_reached") if "limit_reached" in code_review else code_review.get("limitReached")
    )
    cr_allowed_bool = cr_allowed if isinstance(cr_allowed, bool) else None
    cr_limit_reached_bool = cr_limit_reached if isinstance(cr_limit_reached, bool) else None
    cr_primary = code_review.get("primary_window") if "primary_window" in code_review else code_review.get("primaryWindow")

    return {
        "plan_type": plan_type,
        "rate_limit": {
            "allowed": allowed,
            "limit_reached": limit_reached,
            "primary_window": _parse_wham_window(primary, now=now, allowed=allowed, limit_reached=limit_reached),
            "secondary_window": _parse_wham_window(secondary, now=now, allowed=allowed, limit_reached=limit_reached),
        },
        "code_review_rate_limit": {
            "allowed": cr_allowed_bool,
            "limit_reached": cr_limit_reached_bool,
            "primary_window": _parse_wham_window(
                cr_primary,
                now=now,
                allowed=cr_allowed_bool,
                limit_reached=cr_limit_reached_bool,
            ),
        },
    }


def _normalize_codex_responses_request(request_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Codex 上游是 responses SSE（CLIProxyAPI 也会强制 stream=true）。
    这里做最小“清洗/补齐”，避免上游因字段形态不一致而拒绝。
    """
    body = dict(request_data or {})
    body["stream"] = True
    body["store"] = False
    body["parallel_tool_calls"] = True
    body["include"] = ["reasoning.encrypted_content"]

    # CLIProxyAPI 实测：Codex Responses 会拒绝这些“限制/采样”字段（400 Bad Request）
    body.pop("max_output_tokens", None)
    body.pop("max_completion_tokens", None)
    body.pop("temperature", None)
    body.pop("top_p", None)
    body.pop("service_tier", None)

    # 兼容 `input: "text"` 的快捷写法，转换为 Codex 更稳定的 message 结构
    input_value = body.get("input")
    if isinstance(input_value, str):
        body["input"] = [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": input_value}],
            }
        ]
    body.pop("previous_response_id", None)
    body.pop("prompt_cache_retention", None)
    body.pop("safety_identifier", None)
    if "instructions" not in body:
        body["instructions"] = ""
    return body


def _build_codex_headers(
    *,
    access_token: str,
    chatgpt_account_id: str,
    user_agent: Optional[str],
) -> Dict[str, str]:
    ua = (user_agent or "").strip() or CODEX_DEFAULT_USER_AGENT
    session_id = str(uuid4())
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
        "Accept": "text/event-stream",
        "Connection": "Keep-Alive",
        "Version": CODEX_DEFAULT_VERSION,
        "Openai-Beta": CODEX_OPENAI_BETA,
        "Session_id": session_id,
        "Conversation_id": session_id,
        "User-Agent": ua,
        "Originator": "codex_cli_rs",
    }
    if chatgpt_account_id:
        headers["Chatgpt-Account-Id"] = chatgpt_account_id
    return headers


def _build_wham_usage_headers(
    *,
    access_token: str,
    chatgpt_account_id: str,
    user_agent: Optional[str],
) -> Dict[str, str]:
    ua = (user_agent or "").strip() or CODEX_DEFAULT_USER_AGENT
    headers: Dict[str, str] = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": ua,
    }
    if chatgpt_account_id:
        headers["Chatgpt-Account-Id"] = chatgpt_account_id
    return headers


class CodexService:
    def __init__(self, db: AsyncSession, redis: RedisClient):
        self.db = db
        self.redis = redis
        self.repo = CodexAccountRepository(db)
        self.fallback_repo = CodexFallbackConfigRepository(db)

    async def get_models(self) -> Dict[str, Any]:
        models = _get_supported_models()
        return {
            "success": True,
            "data": {"models": [{"id": m, "object": "model"} for m in models], "object": "list"},
        }

    async def openai_list_models(self) -> Dict[str, Any]:
        """
        `/v1/models` 兼容格式（OpenAI 标准）：{ object: "list", data: [...] }
        """
        models = _get_supported_models()
        return {"object": "list", "data": [{"id": m, "object": "model"} for m in models]}

    async def get_fallback_config(self, *, user_id: int) -> Dict[str, Any]:
        """
        获取 CodexCLI 兜底服务配置（不返回明文 KEY）。
        """
        cfg = await self.fallback_repo.get_by_user_id(user_id)
        if not cfg or not getattr(cfg, "is_active", True):
            return {
                "success": True,
                "data": {
                    "platform": CODEX_FALLBACK_PLATFORM,
                    "base_url": None,
                    "has_key": False,
                    "api_key_masked": None,
                },
            }

        masked = None
        has_key = False
        try:
            raw_key = decrypt_secret(cfg.api_key)
            if (raw_key or "").strip():
                has_key = True
                masked = _mask_secret(raw_key)
        except Exception:
            # 解密失败按“未配置”处理，避免把异常扩散到设置页
            has_key = False
            masked = None

        return {
            "success": True,
            "data": {
                "platform": CODEX_FALLBACK_PLATFORM,
                "base_url": cfg.base_url,
                "has_key": has_key,
                "api_key_masked": masked,
            },
        }

    async def upsert_fallback_config(
        self,
        *,
        user_id: int,
        base_url: str,
        api_key: Optional[str],
    ) -> Dict[str, Any]:
        """
        保存/更新 CodexCLI 兜底服务配置。

        约定：
        - base_url 必填
        - api_key 允许留空：仅更新 base_url，保留旧 KEY（前提是已存在）
        """
        normalized_base = _normalize_fallback_base_url(base_url)
        key_raw = (api_key or "").strip()

        existing = await self.fallback_repo.get_by_user_id(user_id)

        if not key_raw:
            if not existing:
                raise ValueError("api_key 不能为空")
            encrypted_key = existing.api_key
        else:
            encrypted_key = encrypt_secret(key_raw)

        if existing:
            cfg = await self.fallback_repo.update(
                user_id=user_id,
                base_url=normalized_base,
                api_key=encrypted_key,
                is_active=True,
            )
        else:
            cfg = await self.fallback_repo.create(user_id=user_id, base_url=normalized_base, api_key=encrypted_key)

        masked = None
        try:
            masked = _mask_secret(decrypt_secret(cfg.api_key))
        except Exception:
            masked = None

        return {
            "success": True,
            "data": {
                "platform": CODEX_FALLBACK_PLATFORM,
                "base_url": cfg.base_url,
                "has_key": True,
                "api_key_masked": masked,
            },
        }

    async def delete_fallback_config(self, *, user_id: int) -> Dict[str, Any]:
        await self.fallback_repo.delete(user_id=user_id)
        return {
            "success": True,
            "data": {
                "platform": CODEX_FALLBACK_PLATFORM,
                "base_url": None,
                "has_key": False,
                "api_key_masked": None,
            },
        }

    async def create_oauth_authorize_url(
        self,
        user_id: int,
        *,
        is_shared: int = 0,
        account_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        if is_shared not in (0, 1):
            raise ValueError("is_shared 必须是 0 或 1")

        state = _generate_state()
        pkce = _generate_pkce_codes()

        params = {
            "client_id": OPENAI_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": OPENAI_REDIRECT_URI,
            "scope": OAUTH_SCOPE,
            "state": state,
            "code_challenge": pkce.code_challenge,
            "code_challenge_method": "S256",
            "prompt": "login",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
        }
        auth_url = f"{OPENAI_AUTH_URL}?{urlencode(params)}"

        expires_in = OAUTH_SESSION_TTL_SECONDS
        now = _now_utc()
        session_payload = {
            "user_id": user_id,
            "is_shared": is_shared,
            "account_name": (account_name or "").strip() or None,
            "code_verifier": pkce.code_verifier,
            "code_challenge": pkce.code_challenge,
            "created_at": _iso(now),
            "expires_at": _iso(now + timedelta(seconds=expires_in)),
        }
        await self.redis.set_json(f"codex_oauth:{state}", session_payload, expire=expires_in)

        return {"success": True, "data": {"auth_url": auth_url, "state": state, "expires_in": expires_in}}

    async def submit_oauth_callback(self, user_id: int, callback_url: str) -> Dict[str, Any]:
        parsed = _parse_oauth_callback(callback_url)
        state = parsed["state"]
        code = parsed["code"]
        err = parsed["error"]
        if err:
            raise ValueError(f"OAuth 登录失败: {err}")

        key = f"codex_oauth:{state}"
        session = await self.redis.get_json(key)
        if not session:
            raise ValueError("state 不存在或已过期，请重新生成登录链接")
        if int(session.get("user_id") or 0) != int(user_id):
            raise ValueError("state 不属于当前用户")

        code_verifier = (session.get("code_verifier") or "").strip()
        if not code_verifier:
            raise ValueError("state 数据损坏：缺少 code_verifier")

        token_resp = await self._exchange_code_for_tokens(code=code, code_verifier=code_verifier)

        now = _now_utc()
        expires_at = now + timedelta(seconds=int(token_resp.get("expires_in") or 0))

        id_token = (token_resp.get("id_token") or "").strip()
        claims = _decode_id_token(id_token)
        profile = _extract_openai_profile_from_claims(claims)

        storage_payload = {
            "id_token": id_token,
            "access_token": (token_resp.get("access_token") or "").strip(),
            "refresh_token": (token_resp.get("refresh_token") or "").strip(),
            "account_id": profile.get("openai_account_id") or "",
            "last_refresh": _iso(now),
            "email": profile.get("email") or "",
            "type": "codex",
            "expired": _iso(expires_at),
        }
        encrypted_credentials = encrypt_secret(json.dumps(storage_payload, ensure_ascii=False))

        account_name = (session.get("account_name") or "").strip()
        if not account_name:
            account_name = _default_codex_account_name(profile.get("email"), profile.get("openai_account_id"))

        existing = None
        if profile.get("openai_account_id") and profile.get("email"):
            existing = await self.repo.get_by_user_id_and_openai_account_id_and_email(
                user_id, profile["openai_account_id"], profile["email"]
            )
        elif profile.get("openai_account_id"):
            existing = await self.repo.get_by_user_id_and_openai_account_id(user_id, profile["openai_account_id"])
        elif profile.get("email"):
            existing = await self.repo.get_by_user_id_and_email(user_id, profile["email"])

        if existing:
            updated = await self.repo.update_credentials_and_profile(
                existing.id,
                user_id,
                account_name=account_name,
                credentials=encrypted_credentials,
                email=profile.get("email"),
                openai_account_id=profile.get("openai_account_id"),
                chatgpt_plan_type=profile.get("chatgpt_plan_type"),
                token_expires_at=expires_at,
                last_refresh_at=now,
            )
            account = updated or existing
        else:
            account = await self.repo.create(
                user_id=user_id,
                account_name=account_name,
                is_shared=int(session.get("is_shared") or 0),
                status=1,
                credentials=encrypted_credentials,
                email=profile.get("email"),
                openai_account_id=profile.get("openai_account_id"),
                chatgpt_plan_type=profile.get("chatgpt_plan_type"),
                token_expires_at=expires_at,
                last_refresh_at=now,
            )

        # 消耗 state
        await self.redis.delete(key)

        return {"success": True, "data": account}

    async def import_account(
        self,
        user_id: int,
        *,
        credential_json: str,
        is_shared: int = 0,
        account_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        if is_shared not in (0, 1):
            raise ValueError("is_shared 必须是 0 或 1")

        raw = (credential_json or "").strip()
        if not raw:
            raise ValueError("credential_json 不能为空")

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError("credential_json 不是合法 JSON") from e
        if not isinstance(payload, dict):
            raise ValueError("credential_json 必须是 JSON object")

        # 兼容 CLIProxyAPI 的字段名
        access_token = (payload.get("access_token") or "").strip()
        refresh_token = (payload.get("refresh_token") or "").strip()
        id_token = (payload.get("id_token") or "").strip()
        email = (payload.get("email") or "").strip() or None
        openai_account_id = (payload.get("account_id") or "").strip() or None
        last_refresh = _parse_iso_datetime(payload.get("last_refresh") or payload.get("lastRefresh"))
        token_expires_at = _parse_iso_datetime(payload.get("expired") or payload.get("expires_at") or payload.get("expire"))

        plan_type = None
        if id_token:
            claims = _decode_id_token(id_token)
            profile = _extract_openai_profile_from_claims(claims)
            email = email or profile.get("email")
            openai_account_id = openai_account_id or profile.get("openai_account_id")
            plan_type = profile.get("chatgpt_plan_type")

        if not access_token and not refresh_token and not id_token:
            raise ValueError("credential_json 缺少有效凭证字段（access_token/refresh_token/id_token）")

        # 规范化并加密存储（导出保持兼容结构）
        normalized = {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": openai_account_id or "",
            "last_refresh": _iso(last_refresh) if last_refresh else "",
            "email": email or "",
            "type": "codex",
            "expired": _iso(token_expires_at) if token_expires_at else "",
        }
        encrypted_credentials = encrypt_secret(json.dumps(normalized, ensure_ascii=False))

        final_name = (account_name or "").strip()
        if not final_name:
            final_name = _default_codex_account_name(email, openai_account_id)

        existing = None
        if openai_account_id and email:
            existing = await self.repo.get_by_user_id_and_openai_account_id_and_email(user_id, openai_account_id, email)
        elif openai_account_id:
            existing = await self.repo.get_by_user_id_and_openai_account_id(user_id, openai_account_id)
        elif email:
            existing = await self.repo.get_by_user_id_and_email(user_id, email)

        if existing:
            updated = await self.repo.update_credentials_and_profile(
                existing.id,
                user_id,
                account_name=final_name,
                credentials=encrypted_credentials,
                email=email,
                openai_account_id=openai_account_id,
                chatgpt_plan_type=plan_type,
                token_expires_at=token_expires_at,
                last_refresh_at=last_refresh,
            )
            account = updated or existing
        else:
            account = await self.repo.create(
                user_id=user_id,
                account_name=final_name,
                is_shared=is_shared,
                status=1,
                credentials=encrypted_credentials,
                email=email,
                openai_account_id=openai_account_id,
                chatgpt_plan_type=plan_type,
                token_expires_at=token_expires_at,
                last_refresh_at=last_refresh,
            )

        return {"success": True, "data": account}

    async def list_accounts(self, user_id: int) -> Dict[str, Any]:
        accounts = await self.repo.list_by_user_id(user_id)
        return {"success": True, "data": list(accounts)}

    async def get_account(self, user_id: int, account_id: int) -> Dict[str, Any]:
        account = await self.repo.get_by_id_and_user_id(account_id, user_id)
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": account}

    async def select_active_account(self, user_id: int) -> Dict[str, Any]:
        """
        账号选择策略（fill-first）：
        - 按账号添加顺序（id 升序）挑选
        - 只有当第一个账号被禁用或因 5 小时/周限额冻结时，才会尝试下一个
        """
        enabled = await self.repo.list_enabled_by_user_id(user_id)
        if not enabled:
            all_accounts = await self.repo.list_by_user_id(user_id)
            if all_accounts:
                raise ValueError("没有可用账号：账号都处于禁用状态")
            raise ValueError("没有可用账号：请先添加账号")

        for account in enabled:
            if getattr(account, "effective_status", 0) == 1:
                return {"success": True, "data": account}

        earliest: Optional[datetime] = None
        has_unknown_reset = False
        for account in enabled:
            if not getattr(account, "is_frozen", False):
                continue
            until = getattr(account, "frozen_until", None)
            if until is None:
                has_unknown_reset = True
                continue
            if until.tzinfo is None:
                until = until.replace(tzinfo=timezone.utc)
            if earliest is None or until < earliest:
                earliest = until

        if earliest:
            raise ValueError(f"所有账号已冻结，预计最早解冻时间：{_iso(earliest)}")
        if has_unknown_reset:
            raise ValueError("所有账号已冻结：缺少重置时间")
        raise ValueError("没有可用账号")

    async def export_account_credentials(self, user_id: int, account_id: int) -> Dict[str, Any]:
        account = await self.repo.get_by_id_and_user_id(account_id, user_id)
        if not account:
            raise ValueError("账号不存在")
        decrypted = decrypt_secret(account.credentials)
        try:
            credential_obj = json.loads(decrypted)
        except Exception:
            credential_obj = {"raw": decrypted}
        return {"success": True, "data": credential_obj}

    async def _open_fallback_responses_stream(
        self,
        *,
        user_id: int,
        request_data: Dict[str, Any],
        user_agent: Optional[str],
        reason: str,
    ) -> Optional[Tuple[httpx.AsyncClient, httpx.Response]]:
        cfg = await self.fallback_repo.get_by_user_id(user_id)
        if not cfg or not getattr(cfg, "is_active", True):
            return None

        base_url = _normalize_fallback_base_url(cfg.base_url)
        try:
            api_key = decrypt_secret(cfg.api_key)
        except Exception:
            api_key = ""
        if not (api_key or "").strip():
            return None

        url = _join_base_url(base_url, "/responses")
        body = _normalize_fallback_responses_request(request_data)

        ua = (user_agent or "").strip() or CODEX_DEFAULT_USER_AGENT
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream",
            "Connection": "Keep-Alive",
            "Openai-Beta": CODEX_OPENAI_BETA,
            "User-Agent": ua,
        }

        timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
        client = _build_httpx_async_client(timeout=timeout, follow_redirects=True)
        try:
            req = client.build_request("POST", url, json=body, headers=headers)
            resp = await client.send(req, stream=True)
        except Exception:
            await client.aclose()
            raise

        if 200 <= resp.status_code < 300:
            logger.warning(
                "codex fallback enabled: user_id=%s base_url=%s reason=%s",
                user_id,
                base_url,
                (reason or "")[:200],
            )
            return client, resp

        raw_err = await resp.aread()
        headers_copy = resp.headers
        status_code = resp.status_code
        await resp.aclose()
        await client.aclose()

        try:
            err_text = raw_err.decode("utf-8", errors="replace")
        except Exception:
            err_text = str(raw_err)

        raise httpx.HTTPStatusError(
            f"Codex fallback upstream error: HTTP {status_code}",
            request=None,
            response=type(
                "R",
                (),
                {"status_code": status_code, "text": err_text, "headers": headers_copy},
            )(),
        )

    async def open_codex_responses_stream(
        self,
        user_id: int,
        request_data: Dict[str, Any],
        *,
        user_agent: Optional[str] = None,
    ) -> Tuple[httpx.AsyncClient, httpx.Response, Any]:
        """
        打开到 `chatgpt.com/backend-api/codex/responses` 的 SSE 连接。

        - 账号选择：fill-first（先用第一个号，满了/冻结/禁用才换下一个）
        - 429：自动落库限额字段并切换下一个账号
        - 401/402/403：自动冻结并切换下一个账号（401 会先尝试刷新 token）

        返回：
        - client: httpx.AsyncClient（由调用方负责 aclose）
        - resp: httpx.Response(stream=True)（由调用方负责 aclose）
        - account: 选中的 CodexAccount ORM 实例（仅用于标识/展示）
        """
        if not isinstance(request_data, dict):
            raise ValueError("request_data 必须是 JSON object")

        exclude_ids: Set[int] = set()
        last_error: Optional[str] = None

        while True:
            selected = await self._select_active_account_obj(user_id, exclude_ids=exclude_ids)
            if selected is None:
                fallback = await self._open_fallback_responses_stream(
                    user_id=user_id,
                    request_data=request_data,
                    user_agent=user_agent,
                    reason=last_error or "no_available_codex_account",
                )
                if fallback is not None:
                    client, resp = fallback
                    return client, resp, None
                raise ValueError(last_error or "没有可用的 Codex 账号")

            exclude_ids.add(int(getattr(selected, "id", 0) or 0))

            body = _normalize_codex_responses_request(request_data)
            if "model" in body:
                body["model"] = _resolve_codex_model_name(body.get("model"))
            creds = self._load_account_credentials(selected)
            creds = await self._ensure_account_tokens(selected, creds)

            access_token = _safe_str(creds.get("access_token"))
            if not access_token:
                last_error = "账号缺少 access_token"
                await self._disable_account(selected, reason="missing_access_token")
                continue

            chatgpt_account_id = self._resolve_chatgpt_account_id(selected, creds)
            if not chatgpt_account_id:
                last_error = "账号缺少 ChatGPT account_id（无法设置 Chatgpt-Account-Id）"
                await self._disable_account(selected, reason="missing_account_id")
                continue

            headers = _build_codex_headers(
                access_token=access_token,
                chatgpt_account_id=chatgpt_account_id,
                user_agent=user_agent,
            )

            # SSE：read 不设超时，但 connect 必须可控，否则网络问题会“挂死”等到上层超时（前端常见 504）。
            timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
            client = _build_httpx_async_client(timeout=timeout, follow_redirects=True)
            try:
                req = client.build_request("POST", CODEX_RESPONSES_URL, json=body, headers=headers)
                resp = await client.send(req, stream=True)
            except Exception:
                await client.aclose()
                raise

            if 200 <= resp.status_code < 300:
                await self._update_account_after_success(selected, resp.headers)
                return client, resp, selected

            now = _now_utc()
            retry_at = _parse_retry_after(resp.headers, now=now)
            raw_err = await resp.aread()
            await resp.aclose()
            await client.aclose()

            err_text = ""
            try:
                err_text = raw_err.decode("utf-8", errors="replace")
            except Exception:
                err_text = str(raw_err)

            if resp.status_code == 429:
                # 优先用响应头同步 ratelimit（有些上游会在 429 时带 reset 信息）。
                await self._update_account_after_success(selected, resp.headers)

                # 如果 header 没给出 reset_at，再尝试用 wham/usage 拿到准确的窗口重置时间。
                if not getattr(selected, "is_frozen", False) and retry_at is None:
                    await self._sync_limits_from_wham_usage_best_effort(
                        selected,
                        creds,
                        access_token=access_token,
                        chatgpt_account_id=chatgpt_account_id,
                    )

                if not getattr(selected, "is_frozen", False):
                    bucket = _infer_limit_bucket(err_text)
                    await self._mark_rate_limited(selected, bucket=bucket, retry_at=retry_at, raw_error=err_text)
                last_error = "账号触发限额，已自动切换下一个账号"
                continue

            if resp.status_code == 401:
                refreshed = await self._try_refresh_account(selected, creds)
                if refreshed:
                    last_error = "token 已刷新，重试该账号"
                    exclude_ids.discard(int(getattr(selected, "id", 0) or 0))
                    continue
                await self._freeze_account(selected, reason="unauthorized")
                last_error = "账号未授权（已冻结），已自动切换下一个账号"
                continue

            if resp.status_code == 402:
                code = _extract_error_detail_code(err_text)
                await self._freeze_account(selected, reason=f"upstream_402:{code or 'unknown'}")
                last_error = (
                    f"账号触发组织/Workspace 限制（HTTP 402{('/' + code) if code else ''}，已冻结），已自动切换下一个账号"
                )
                continue

            if resp.status_code == 403:
                code = _extract_error_detail_code(err_text)
                await self._freeze_account(selected, reason=f"upstream_403:{code or 'unknown'}")
                last_error = f"账号无权限（HTTP 403{('/' + code) if code else ''}，已冻结），已自动切换下一个账号"
                continue

            # 其他错误：不做轮询，直接抛出
            raise httpx.HTTPStatusError(
                f"Codex 上游错误: HTTP {resp.status_code}",
                request=None,
                response=type(
                    "R",
                    (),
                    {"status_code": resp.status_code, "text": err_text, "headers": resp.headers},
                )(),
            )

    async def execute_codex_responses(
        self,
        user_id: int,
        request_data: Dict[str, Any],
        *,
        user_agent: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], Any]:
        """
        非流式：内部仍以 stream=true 请求上游，然后从 SSE 里提取 response.completed。
        返回：
        - response object（不是 event wrapper）
        - account：本次使用的 CodexAccount ORM 实例（用于计费/统计）
        """
        client, resp, account = await self.open_codex_responses_stream(user_id, request_data, user_agent=user_agent)
        try:
            data = await resp.aread()
        finally:
            await resp.aclose()
            await client.aclose()

        response_obj = self._extract_response_object_from_sse(data)
        if not response_obj:
            raise ValueError("Codex 上游未返回 response.completed")
        return response_obj, account

    async def record_account_consumed_tokens(
        self,
        *,
        user_id: int,
        account_id: int,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int,
        total_tokens: int,
    ) -> None:
        """
        记录 Codex 账号 Token 消耗（best effort，不影响主链路）。

        - input_tokens：不含缓存部分（= input_tokens - cached_tokens）
        - total_tokens：输入+输出（= input + cached + output）
        """
        try:
            await self.repo.increment_consumed_tokens(
                account_id,
                user_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_tokens=cached_tokens,
                total_tokens=total_tokens,
            )
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            logger.warning(
                "record codex token usage failed: user_id=%s account_id=%s",
                user_id,
                account_id,
                exc_info=True,
            )

    async def update_account_status(self, user_id: int, account_id: int, status: int) -> Dict[str, Any]:
        if status not in (0, 1):
            raise ValueError("status 必须是 0 或 1")
        if status == 1:
            existing = await self.repo.get_by_id_and_user_id(account_id, user_id)
            if not existing:
                raise ValueError("账号不存在")
            if getattr(existing, "is_frozen", False):
                until = getattr(existing, "frozen_until", None)
                if until:
                    raise ValueError(f"账号已冻结，预计解冻时间：{_iso(until)}")
                raise ValueError("账号已冻结：缺少重置时间")
        account = await self.repo.update_status(account_id, user_id, status)
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": account}

    async def update_account_name(self, user_id: int, account_id: int, account_name: str) -> Dict[str, Any]:
        name = (account_name or "").strip()
        if not name:
            raise ValueError("account_name 不能为空")
        account = await self.repo.update_name(account_id, user_id, name)
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": account}

    async def update_account_quota(
        self,
        user_id: int,
        account_id: int,
        *,
        quota_remaining: Optional[float],
        quota_currency: Optional[str],
    ) -> Dict[str, Any]:
        now = _now_utc()
        currency = (quota_currency or "").strip() or None
        account = await self.repo.update_quota(
            account_id,
            user_id,
            quota_remaining=quota_remaining,
            quota_currency=currency,
            quota_updated_at=now,
        )
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": account}

    async def update_account_limits(
        self,
        user_id: int,
        account_id: int,
        *,
        limit_5h_used_percent: Optional[int],
        limit_5h_reset_at: Optional[datetime],
        limit_week_used_percent: Optional[int],
        limit_week_reset_at: Optional[datetime],
    ) -> Dict[str, Any]:
        now = _now_utc()

        p5 = _normalize_percent(limit_5h_used_percent, field_name="limit_5h_used_percent")
        pw = _normalize_percent(limit_week_used_percent, field_name="limit_week_used_percent")

        r5 = limit_5h_reset_at
        if r5 and r5.tzinfo is None:
            r5 = r5.replace(tzinfo=timezone.utc)

        rw = limit_week_reset_at
        if rw and rw.tzinfo is None:
            rw = rw.replace(tzinfo=timezone.utc)

        # “打满”才需要强制提供 reset_at（否则无法做到“冻结到重置时间”）
        if p5 is not None and p5 >= 100:
            if not r5:
                raise ValueError("5小时限额已用=100 时必须提供 limit_5h_reset_at")
            if r5 <= now:
                raise ValueError("limit_5h_reset_at 必须是未来时间")

        if pw is not None and pw >= 100:
            if not rw:
                raise ValueError("周限额已用=100 时必须提供 limit_week_reset_at")
            if rw <= now:
                raise ValueError("limit_week_reset_at 必须是未来时间")

        account = await self.repo.update_limits(
            account_id,
            user_id,
            limit_5h_used_percent=p5,
            limit_5h_reset_at=r5,
            limit_week_used_percent=pw,
            limit_week_reset_at=rw,
        )
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": account}

    async def get_account_wham_usage(self, user_id: int, account_id: int) -> Dict[str, Any]:
        """
        查询 `GET /backend-api/wham/usage`（后端代发，避免前端直连导致 IP 不一致）。

        返回：
        - raw：上游原始 JSON
        - parsed：后端解析后的统一结构（含 5h/周限 + 代码审查窗口）
        """
        account = await self.repo.get_by_id_and_user_id(account_id, user_id)
        if not account:
            raise ValueError("账号不存在")

        try:
            creds = self._load_account_credentials(account)
        except Exception as e:
            logger.error(
                "codex wham/usage: failed to load account credentials (decrypt/parse): user_id=%s account_id=%s",
                user_id,
                account_id,
                exc_info=True,
            )
            raise ValueError("账号凭证解析失败：请检查后端加密密钥是否变更，必要时重新导入该账号") from e

        creds = await self._ensure_account_tokens(account, creds)
        access_token = _safe_str(creds.get("access_token"))
        if not access_token:
            raise ValueError("账号缺少 access_token")

        chatgpt_account_id = self._resolve_chatgpt_account_id(account, creds)
        if not chatgpt_account_id:
            raise ValueError("账号缺少 ChatGPT account_id")

        raw = await self._fetch_wham_usage_raw(
            account,
            creds,
            access_token=access_token,
            chatgpt_account_id=chatgpt_account_id,
        )
        now = _now_utc()
        parsed = _parse_wham_usage(raw, now=now)
        return {"success": True, "data": {"fetched_at": now, "raw": raw, "parsed": parsed}}

    async def _fetch_wham_usage_raw(
        self,
        account: Any,
        creds: Dict[str, Any],
        *,
        access_token: str,
        chatgpt_account_id: str,
    ) -> Dict[str, Any]:
        """
        调用 `wham/usage` 并返回 JSON（带一次 401 -> refresh_token 重试）。
        注意：该方法可能会触发 token 刷新/账号冻结/禁用等落库副作用（与 refresh 行为一致）。
        """
        timeout = httpx.Timeout(connect=10.0, read=30.0, write=20.0, pool=10.0)
        client = _build_httpx_async_client(timeout=timeout, follow_redirects=True)
        resp: Optional[httpx.Response] = None
        try:
            for attempt in range(2):
                if resp is not None:
                    try:
                        await resp.aclose()
                    except Exception:
                        pass
                    resp = None

                headers = _build_wham_usage_headers(
                    access_token=access_token,
                    chatgpt_account_id=chatgpt_account_id,
                    user_agent=None,
                )
                try:
                    resp = await client.get(CODEX_WHAM_USAGE_URL, headers=headers)
                except httpx.HTTPError as e:
                    proxy_hint = _redact_proxy_url(_get_outbound_proxy_url()) or "-"
                    logger.warning(
                        "codex wham/usage: upstream request failed: user_id=%s account_id=%s attempt=%s url=%s proxy=%s error=%s",
                        getattr(account, "user_id", "-"),
                        getattr(account, "id", "-"),
                        attempt,
                        CODEX_WHAM_USAGE_URL,
                        proxy_hint,
                        type(e).__name__,
                        exc_info=True,
                    )

                    tip = ""
                    if isinstance(e, (httpx.ConnectTimeout, httpx.ConnectError)):
                        tip = "；请检查网络/代理（可设置 CODEX_PROXY_URL，例如 http://host.docker.internal:7890）"
                    raise ValueError(f"查询失败：上游请求异常（{type(e).__name__}）{tip}") from e

                if 200 <= resp.status_code < 300:
                    try:
                        data = resp.json()
                    except Exception as e:
                        raise ValueError("查询失败：wham/usage 响应不是 JSON") from e
                    if not isinstance(data, dict):
                        raise ValueError("查询失败：wham/usage 响应格式异常")
                    return data

                now = _now_utc()
                retry_at = _parse_retry_after(resp.headers, now=now)
                try:
                    raw_err = await resp.aread()
                except Exception:
                    raw_err = b""
                err_text = raw_err.decode("utf-8", errors="replace") if raw_err else ""

                if resp.status_code == 401 and attempt == 0:
                    refreshed = await self._try_refresh_account(account, creds)
                    if not refreshed:
                        await self._freeze_account(account, reason="auth_401")
                        raise ValueError("账号 token 已失效（401），且无法 refresh_token 刷新（已冻结）")

                    new_creds = self._load_account_credentials(account)
                    creds.clear()
                    creds.update(new_creds)
                    access_token = _safe_str(creds.get("access_token"))
                    if not access_token:
                        await self._disable_account(account, reason="missing_access_token")
                        raise ValueError("账号缺少 access_token（已禁用）")
                    continue

                if resp.status_code == 429:
                    # 优先用响应头同步 ratelimit（有些上游会在 429 时带 reset 信息）。
                    await self._update_account_after_success(account, resp.headers)

                    # 如果 header 没给出 reset_at，再尝试用 wham/usage 拿到准确的窗口重置时间。
                    if not getattr(account, "is_frozen", False) and retry_at is None:
                        await self._sync_limits_from_wham_usage_best_effort(
                            account,
                            creds,
                            access_token=access_token,
                            chatgpt_account_id=chatgpt_account_id,
                        )

                    if not getattr(account, "is_frozen", False):
                        bucket = _infer_limit_bucket(err_text)
                        await self._mark_rate_limited(account, bucket=bucket, retry_at=retry_at, raw_error=err_text)
                    until = getattr(account, "frozen_until", None)
                    if until:
                        raise ValueError(f"账号触发限额，已冻结至：{_iso(until)}")
                    raise ValueError("账号触发限额，已冻结")

                err_compact = " ".join((err_text or "").split())
                if err_compact:
                    if len(err_compact) > 500:
                        err_compact = err_compact[:500] + "..."
                    raise ValueError(f"查询失败：HTTP {resp.status_code}：{err_compact}")
                raise ValueError(f"查询失败：HTTP {resp.status_code}")

        finally:
            if resp is not None:
                try:
                    await resp.aclose()
                except Exception:
                    pass
            try:
                await client.aclose()
            except Exception:
                pass

    async def refresh_account_official(self, user_id: int, account_id: int) -> Dict[str, Any]:
        """
        从“官方上游”刷新并落库（尽量做到）：
        - 5h/周限：优先调用 `/backend-api/wham/usage`；失败则 fallback 到 `/backend-api/codex/responses` 的轻量 ping（从响应头推断）
        - 余额：尝试调用 OpenAI billing credit_grants（可能因账号/权限差异不可用，失败则跳过）
        
        注意：该动作会产生真实上游请求；但优先走 wham/usage，避免“刷新一次就消耗一次 codex 请求”。
        """
        account = await self.repo.get_by_id_and_user_id(account_id, user_id)
        if not account:
            raise ValueError("账号不存在")

        try:
            creds = self._load_account_credentials(account)
        except Exception as e:
            logger.error(
                "codex refresh: failed to load account credentials (decrypt/parse): user_id=%s account_id=%s",
                user_id,
                account_id,
                exc_info=True,
            )
            raise ValueError("账号凭证解析失败：请检查后端加密密钥是否变更，必要时重新导入该账号") from e
        creds = await self._ensure_account_tokens(account, creds)

        access_token = _safe_str(creds.get("access_token"))
        if not access_token:
            raise ValueError("账号缺少 access_token")

        chatgpt_account_id = self._resolve_chatgpt_account_id(account, creds)
        if not chatgpt_account_id:
            raise ValueError("账号缺少 ChatGPT account_id")

        # 1) 优先走 wham/usage：这是 ChatGPT 网页 Quota 页实际用的接口，不需要“发一次 ping 消耗一次请求”。
        try:
            wham_raw = await self._fetch_wham_usage_raw(
                account,
                creds,
                access_token=access_token,
                chatgpt_account_id=chatgpt_account_id,
            )
            now = _now_utc()
            parsed = _parse_wham_usage(wham_raw, now=now)

            rl = parsed.get("rate_limit") if isinstance(parsed, dict) else {}
            if not isinstance(rl, dict):
                rl = {}
            five = rl.get("primary_window") if isinstance(rl.get("primary_window"), dict) else {}
            week = rl.get("secondary_window") if isinstance(rl.get("secondary_window"), dict) else {}

            p5 = five.get("used_percent") if isinstance(five, dict) else None
            r5 = five.get("reset_at") if isinstance(five, dict) else None
            pw = week.get("used_percent") if isinstance(week, dict) else None
            rw = week.get("reset_at") if isinstance(week, dict) else None

            if p5 is None and pw is None and not isinstance(r5, datetime) and not isinstance(rw, datetime):
                raise ValueError("wham/usage 未返回限额窗口信息")

            changed = False
            if isinstance(p5, int):
                account.limit_5h_used_percent = int(p5)
                changed = True
            if isinstance(r5, datetime):
                account.limit_5h_reset_at = r5
                changed = True
            if isinstance(pw, int):
                account.limit_week_used_percent = int(pw)
                changed = True
            if isinstance(rw, datetime):
                account.limit_week_reset_at = rw
                changed = True

            if changed:
                await self.db.flush()
                await self.db.commit()

            # 401 刷新 token 时，_fetch_wham_usage_raw 会把 creds 原地更新；这里同步一下给后续步骤用。
            access_token = _safe_str(creds.get("access_token")) or access_token

            quota = await self._fetch_official_quota(access_token)
            if quota is not None:
                remaining, currency = quota
                account.quota_remaining = remaining
                account.quota_currency = currency
                account.quota_updated_at = now
                await self.db.flush()
                await self.db.commit()

            updated = await self.repo.get_by_id_and_user_id(account_id, user_id)
            return {"success": True, "data": updated or account}
        except ValueError as e:
            # 如果在 wham/usage 阶段已经把账号“冻结/禁用”了，就别再额外打 ping 了，直接把错误抛给前端。
            access_token = _safe_str(creds.get("access_token")) or access_token
            if int(getattr(account, "status", 1) or 1) == 0 or bool(getattr(account, "is_frozen", False)):
                raise
            logger.info(
                "codex refresh: wham/usage failed, fallback to responses ping: user_id=%s account_id=%s error=%s",
                user_id,
                account_id,
                str(e),
            )

        ping_model = _pick_codex_ping_model(_get_supported_models())
        body = _normalize_codex_responses_request({"model": ping_model or "gpt-5.2-codex", "input": "ping"})

        # 刷新只依赖响应头 ratelimit；connect 超时尽量短，避免前端/反代先 504。
        timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
        client = _build_httpx_async_client(timeout=timeout, follow_redirects=True)
        resp: Optional[httpx.Response] = None
        try:
            # 最多重试 1 次：401 时尝试 refresh_token 刷新再打一次
            for attempt in range(2):
                headers = _build_codex_headers(
                    access_token=access_token,
                    chatgpt_account_id=chatgpt_account_id,
                    user_agent=None,
                )
                req = client.build_request("POST", CODEX_RESPONSES_URL, json=body, headers=headers)
                try:
                    resp = await client.send(req, stream=True)
                except httpx.HTTPError as e:
                    proxy_hint = _redact_proxy_url(_get_outbound_proxy_url()) or "-"
                    try:
                        url_hint = str(req.url)
                    except Exception:
                        url_hint = "-"
                    logger.warning(
                        "codex refresh: upstream request failed: user_id=%s account_id=%s attempt=%s url=%s proxy=%s error=%s",
                        user_id,
                        account_id,
                        attempt,
                        url_hint,
                        proxy_hint,
                        type(e).__name__,
                        exc_info=True,
                    )

                    tip = ""
                    if isinstance(e, (httpx.ConnectTimeout, httpx.ConnectError)):
                        tip = "；请检查网络/代理（可设置 CODEX_PROXY_URL，例如 http://host.docker.internal:7890）"
                    raise ValueError(f"刷新失败：上游请求异常（{type(e).__name__}）{tip}") from e

                if 200 <= resp.status_code < 300:
                    await self._update_account_after_success(account, resp.headers)
                    break

                now = _now_utc()
                retry_at = _parse_retry_after(resp.headers, now=now)
                try:
                    raw_err = await resp.aread()
                except Exception as e:
                    logger.warning(
                        "codex refresh: failed to read upstream error body: user_id=%s account_id=%s status=%s error=%s",
                        user_id,
                        account_id,
                        resp.status_code,
                        type(e).__name__,
                        exc_info=True,
                    )
                    raw_err = b""
                err_text = ""
                try:
                    err_text = raw_err.decode("utf-8", errors="replace")
                except Exception:
                    err_text = str(raw_err)

                if resp.status_code == 401 and attempt == 0:
                    try:
                        await resp.aclose()
                    except Exception:
                        pass
                    resp = None

                    refreshed = await self._try_refresh_account(account, creds)
                    if not refreshed:
                        await self._freeze_account(account, reason="unauthorized")
                        raise ValueError("账号未授权（已冻结）")

                    try:
                        creds = self._load_account_credentials(account)
                    except Exception as e:
                        logger.error(
                            "codex refresh: failed to reload credentials after token refresh: user_id=%s account_id=%s",
                            user_id,
                            account_id,
                            exc_info=True,
                        )
                        raise ValueError("token 已刷新但账号凭证解析失败，请尝试重新导入该账号") from e
                    access_token = _safe_str(creds.get("access_token"))
                    if not access_token:
                        await self._disable_account(account, reason="missing_access_token")
                        raise ValueError("账号缺少 access_token（已禁用）")

                    continue

                if resp.status_code == 429:
                    bucket = _infer_limit_bucket(err_text)
                    await self._mark_rate_limited(account, bucket=bucket, retry_at=retry_at, raw_error=err_text)
                    until = getattr(account, "frozen_until", None)
                    if until:
                        raise ValueError(f"账号触发限额，已冻结至：{_iso(until)}")
                    raise ValueError("账号触发限额，已冻结")

                err_compact = " ".join((err_text or "").split())
                if err_compact:
                    if len(err_compact) > 500:
                        err_compact = err_compact[:500] + "..."
                    raise ValueError(f"刷新失败：HTTP {resp.status_code}：{err_compact}")
                raise ValueError(f"刷新失败：HTTP {resp.status_code}")

        finally:
            if resp is not None:
                try:
                    await resp.aclose()
                except Exception:
                    pass
            try:
                await client.aclose()
            except Exception:
                pass

        quota = await self._fetch_official_quota(access_token)
        if quota is not None:
            remaining, currency = quota
            now = _now_utc()
            account.quota_remaining = remaining
            account.quota_currency = currency
            account.quota_updated_at = now
            await self.db.flush()
            await self.db.commit()

        updated = await self.repo.get_by_id_and_user_id(account_id, user_id)
        return {"success": True, "data": updated or account}

    async def delete_account(self, user_id: int, account_id: int) -> Dict[str, Any]:
        ok = await self.repo.delete(account_id, user_id)
        if not ok:
            raise ValueError("账号不存在")
        return {"success": True, "data": {"deleted": True}}

    async def _fetch_official_quota(self, access_token: str) -> Optional[Tuple[float, str]]:
        token = (access_token or "").strip()
        if not token:
            return None

        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        async with _build_httpx_async_client(timeout=httpx.Timeout(20.0)) as client:
            for url in OPENAI_CREDIT_GRANTS_URLS:
                try:
                    resp = await client.get(url, headers=headers)
                except Exception:
                    continue
                if resp.status_code != 200:
                    continue
                try:
                    data = resp.json()
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                total_available = data.get("total_available")
                if total_available is None:
                    continue
                try:
                    remaining = float(total_available)
                except Exception:
                    continue
                # credit_grants 接口通常不返回 currency；这里默认 USD
                return remaining, "USD"
        return None

    async def _exchange_code_for_tokens(self, *, code: str, code_verifier: str) -> Dict[str, Any]:
        form = {
            "grant_type": "authorization_code",
            "client_id": OPENAI_CLIENT_ID,
            "code": code,
            "redirect_uri": OPENAI_REDIRECT_URI,
            "code_verifier": code_verifier,
        }
        async with _build_httpx_async_client(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.post(
                OPENAI_TOKEN_URL,
                data=form,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
            )
        if resp.status_code != 200:
            # 不直接透出 token/敏感信息
            raise ValueError(f"token 交换失败: HTTP {resp.status_code}")
        data = resp.json()
        if not isinstance(data, dict):
            raise ValueError("token 响应格式异常")
        return data

    def _load_account_credentials(self, account: Any) -> Dict[str, Any]:
        decrypted = decrypt_secret(account.credentials)
        try:
            obj = json.loads(decrypted)
        except Exception:
            obj = {}
        return obj if isinstance(obj, dict) else {}

    def _resolve_chatgpt_account_id(self, account: Any, creds: Dict[str, Any]) -> str:
        # 优先用落库字段
        candidate = _safe_str(getattr(account, "openai_account_id", None) or "")
        if candidate:
            return candidate

        candidate = _safe_str(creds.get("account_id"))
        if candidate:
            return candidate

        # 兜底：尝试从 token claims 里捞（不验签，仅用于提取字段）
        for token_key in ("id_token", "access_token"):
            tok = _safe_str(creds.get(token_key))
            if not tok:
                continue
            claims = _decode_id_token(tok)
            profile = _extract_openai_profile_from_claims(claims)
            candidate = _safe_str(profile.get("openai_account_id"))
            if candidate:
                return candidate

        return ""

    async def _refresh_tokens(self, refresh_token: str) -> Dict[str, Any]:
        form = {
            "client_id": OPENAI_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "openid profile email",
        }
        async with _build_httpx_async_client(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.post(
                OPENAI_TOKEN_URL,
                data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            )
        if resp.status_code != 200:
            raise ValueError(f"token 刷新失败: HTTP {resp.status_code}")
        data = resp.json()
        if not isinstance(data, dict):
            raise ValueError("token 刷新响应格式异常")
        return data

    async def _try_refresh_account(self, account: Any, creds: Dict[str, Any]) -> bool:
        refresh_token = _safe_str(creds.get("refresh_token"))
        if not refresh_token:
            return False
        try:
            token_resp = await self._refresh_tokens(refresh_token)
        except Exception:
            return False

        now = _now_utc()
        expires_at = now + timedelta(seconds=int(token_resp.get("expires_in") or 0))
        id_token = _safe_str(token_resp.get("id_token"))
        claims = _decode_id_token(id_token)
        profile = _extract_openai_profile_from_claims(claims)

        storage_payload = {
            "id_token": id_token,
            "access_token": _safe_str(token_resp.get("access_token")),
            "refresh_token": _safe_str(token_resp.get("refresh_token")) or refresh_token,
            "account_id": profile.get("openai_account_id") or _safe_str(creds.get("account_id")) or "",
            "last_refresh": _iso(now),
            "email": profile.get("email") or _safe_str(creds.get("email")) or "",
            "type": "codex",
            "expired": _iso(expires_at),
        }

        encrypted_credentials = encrypt_secret(json.dumps(storage_payload, ensure_ascii=False))
        await self.repo.update_credentials_and_profile(
            account.id,
            account.user_id,
            credentials=encrypted_credentials,
            email=profile.get("email") or None,
            openai_account_id=profile.get("openai_account_id") or None,
            chatgpt_plan_type=profile.get("chatgpt_plan_type") or None,
            token_expires_at=expires_at,
            last_refresh_at=now,
        )
        await self.db.flush()
        await self.db.commit()
        return True

    async def _ensure_account_tokens(self, account: Any, creds: Dict[str, Any]) -> Dict[str, Any]:
        now = _now_utc()
        expires_at = getattr(account, "token_expires_at", None)
        if isinstance(expires_at, datetime):
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at > now + timedelta(seconds=60):
                return creds

        refreshed = await self._try_refresh_account(account, creds)
        if not refreshed:
            return creds
        return self._load_account_credentials(account)

    async def _disable_account(self, account: Any, *, reason: str) -> None:
        _ = reason
        try:
            account.status = 0
            await self.db.flush()
            await self.db.commit()
        except Exception:
            await self.db.rollback()

    async def _freeze_account(self, account: Any, *, reason: str, until: Optional[datetime] = None) -> None:
        """
        冻结账号（用于组织封禁/无权限等“非限额”错误）。

        说明：
        - 当前模型的 freeze_reason / is_frozen 仅由限额字段推导，因此这里复用 week 字段实现“冻结”效果
        - until 为空时默认冻结 10 年（基本等价永久，但避免 reset_at 缺失导致的“缺少重置时间”提示）
        """
        _ = reason
        now = _now_utc()
        freeze_until = until or (now + timedelta(days=3650))
        if freeze_until.tzinfo is None:
            freeze_until = freeze_until.replace(tzinfo=timezone.utc)

        existing = getattr(account, "limit_week_reset_at", None)
        if isinstance(existing, datetime):
            if existing.tzinfo is None:
                existing = existing.replace(tzinfo=timezone.utc)
            if existing > freeze_until:
                freeze_until = existing

        try:
            account.limit_week_used_percent = 100
            account.limit_week_reset_at = freeze_until
            await self.db.flush()
            await self.db.commit()
        except Exception:
            await self.db.rollback()

    async def _mark_rate_limited(
        self,
        account: Any,
        *,
        bucket: str,
        retry_at: Optional[datetime],
        raw_error: str,
    ) -> None:
        """
        把“触发限额”的账号冻结到 retry_at。
        说明：目前只做最小落库，不做复杂解析（官方通常会给 Retry-After）。
        """
        _ = raw_error
        now = _now_utc()
        if retry_at is None:
            retry_at = now + (timedelta(days=7) if bucket == "week" else timedelta(hours=5))

        if bucket == "week":
            account.limit_week_used_percent = 100
            account.limit_week_reset_at = retry_at
        else:
            account.limit_5h_used_percent = 100
            account.limit_5h_reset_at = retry_at

        await self.db.flush()
        await self.db.commit()

    async def _sync_limits_from_wham_usage_best_effort(
        self,
        account: Any,
        creds: Dict[str, Any],
        *,
        access_token: str,
        chatgpt_account_id: str,
    ) -> None:
        """
        尝试用 `wham/usage` 同步 5h/周限字段（主要用于 429 时拿到准确的 reset_at）。

        说明：这是 best-effort；失败直接忽略，不影响主调用链路。
        """
        try:
            wham_raw = await self._fetch_wham_usage_raw(
                account,
                creds,
                access_token=access_token,
                chatgpt_account_id=chatgpt_account_id,
            )
        except Exception:
            return

        now = _now_utc()
        parsed = _parse_wham_usage(wham_raw, now=now)
        rl = parsed.get("rate_limit") if isinstance(parsed, dict) else {}
        if not isinstance(rl, dict):
            rl = {}
        five = rl.get("primary_window") if isinstance(rl.get("primary_window"), dict) else {}
        week = rl.get("secondary_window") if isinstance(rl.get("secondary_window"), dict) else {}

        p5 = five.get("used_percent") if isinstance(five, dict) else None
        r5 = five.get("reset_at") if isinstance(five, dict) else None
        pw = week.get("used_percent") if isinstance(week, dict) else None
        rw = week.get("reset_at") if isinstance(week, dict) else None

        if p5 is None and pw is None and not isinstance(r5, datetime) and not isinstance(rw, datetime):
            return

        changed = False
        if isinstance(p5, int):
            account.limit_5h_used_percent = int(p5)
            changed = True
        if isinstance(r5, datetime):
            account.limit_5h_reset_at = r5
            changed = True
        if isinstance(pw, int):
            account.limit_week_used_percent = int(pw)
            changed = True
        if isinstance(rw, datetime):
            account.limit_week_reset_at = rw
            changed = True

        if not changed:
            return

        try:
            await self.db.flush()
            await self.db.commit()
        except Exception:
            await self.db.rollback()

    async def _update_account_after_success(self, account: Any, headers: httpx.Headers) -> None:
        """
        从上游响应头尽量同步限额信息，并更新 last_used_at。

        说明：这里不做强依赖；拿不到就跳过，不影响主调用链路。
        """
        now = _now_utc()
        try:
            account.last_used_at = now

            snapshot = _extract_ratelimit_snapshot(headers, now=now)
            five = snapshot.get("5h") or {}
            week = snapshot.get("week") or {}

            p5 = _compute_used_percent(five.get("limit"), five.get("remaining"))
            r5 = five.get("reset_at")
            if p5 is not None and not (p5 >= 100 and r5 is None):
                account.limit_5h_used_percent = int(p5)
            if isinstance(r5, datetime):
                account.limit_5h_reset_at = r5

            pw = _compute_used_percent(week.get("limit"), week.get("remaining"))
            rw = week.get("reset_at")
            if pw is not None and not (pw >= 100 and rw is None):
                account.limit_week_used_percent = int(pw)
            if isinstance(rw, datetime):
                account.limit_week_reset_at = rw

            await self.db.flush()
            await self.db.commit()
        except Exception:
            await self.db.rollback()

    async def _select_active_account_obj(self, user_id: int, *, exclude_ids: Set[int]) -> Optional[Any]:
        enabled = await self.repo.list_enabled_by_user_id(user_id)
        for account in enabled:
            if int(getattr(account, "id", 0) or 0) in exclude_ids:
                continue
            if getattr(account, "effective_status", 0) == 1:
                return account
        return None

    def _extract_response_object_from_sse(self, raw: bytes) -> Optional[Dict[str, Any]]:
        if not raw:
            return None
        try:
            text = raw.decode("utf-8", errors="replace")
        except Exception:
            return None

        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("data:"):
                continue
            payload_str = stripped[5:].strip()
            if not payload_str or payload_str == "[DONE]":
                continue
            try:
                payload = json.loads(payload_str)
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("type") == "response.completed":
                resp = payload.get("response")
                if isinstance(resp, dict):
                    return resp
        return None
