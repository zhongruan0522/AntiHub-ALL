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
from typing import Any, Dict, Optional
import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache import RedisClient
from app.repositories.codex_account_repository import CodexAccountRepository
from app.utils.encryption import encrypt_api_key as encrypt_secret
from app.utils.encryption import decrypt_api_key as decrypt_secret


OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize"
OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"
OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

# 兼容 CLIProxyAPI / Codex CLI 的 redirect_uri（不绑定域名，方便手动复制回调 URL）
OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback"

OAUTH_SCOPE = "openid email profile offline_access"
OAUTH_SESSION_TTL_SECONDS = 10 * 60


SUPPORTED_MODELS = [
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5-codex",
]


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


class CodexService:
    def __init__(self, db: AsyncSession, redis: RedisClient):
        self.db = db
        self.redis = redis
        self.repo = CodexAccountRepository(db)

    async def get_models(self) -> Dict[str, Any]:
        return {
            "success": True,
            "data": {"models": [{"id": m, "object": "model"} for m in SUPPORTED_MODELS], "object": "list"},
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
            account_name = profile.get("email") or "Codex Account"

        existing = None
        if profile.get("email"):
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
            final_name = email or "Codex Account"

        existing = None
        if email:
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

    async def delete_account(self, user_id: int, account_id: int) -> Dict[str, Any]:
        ok = await self.repo.delete(account_id, user_id)
        if not ok:
            raise ValueError("账号不存在")
        return {"success": True, "data": {"deleted": True}}

    async def _exchange_code_for_tokens(self, *, code: str, code_verifier: str) -> Dict[str, Any]:
        form = {
            "grant_type": "authorization_code",
            "client_id": OPENAI_CLIENT_ID,
            "code": code,
            "redirect_uri": OPENAI_REDIRECT_URI,
            "code_verifier": code_verifier,
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
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
