"""
Kiro账号服务

当前实现：
- 账号管理（/api/kiro/accounts 等）：使用 Backend DB（kiro_accounts）
- 订阅层白名单（/api/kiro/admin/subscription-models）：使用 Backend DB（kiro_subscription_models）
- OpenAI 兼容 /v1/kiro/*：后端直连 Kiro/Amazon Q 上游（不再依赖 plug-in）

优化说明：
- OAuth state 存 Redis（短 TTL）
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple, AsyncIterator
from uuid import uuid4

import base64
import hashlib
import httpx
import logging
import json
import re
import secrets
import time
from urllib.parse import urlencode, urlparse, parse_qs

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache import get_redis_client, RedisClient
from app.core.config import get_settings
from app.models.kiro_account import KiroAccount
from app.models.kiro_subscription_model import KiroSubscriptionModel
from app.services.kiro_anthropic_converter import (
    EDIT_TOOL_DESCRIPTION_SUFFIX,
    SYSTEM_CHUNKED_POLICY,
    WRITE_TOOL_DESCRIPTION_SUFFIX,
    KiroAnthropicConverter,
)
from app.utils.aws_eventstream import AwsEventStreamDecoder, AwsEventStreamParseError
from app.utils.encryption import decrypt_api_key, encrypt_api_key

logger = logging.getLogger(__name__)

# OAuth state TTLs (seconds)
KIRO_OAUTH_STATE_TTL_SECONDS = 10 * 60
KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS = 15 * 60
KIRO_OAUTH_STATE_KEY_PREFIX = "kiro:oauth:"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _trimmed_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _coerce_float(value: Any, default: float = 0.0) -> float:
    if value is None or isinstance(value, bool):
        return float(default)
    try:
        return float(value)
    except Exception:
        return float(default)


def _to_ms(dt: Optional[datetime]) -> Optional[int]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _epoch_to_datetime(value: Any) -> Optional[datetime]:
    """
    Convert upstream epoch timestamp (seconds or milliseconds) to UTC datetime.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        ts = float(value)
    except Exception:
        return None
    if ts <= 0:
        return None

    # Epoch seconds in 2026 ~= 1.7e9. Anything far larger is very likely ms.
    seconds = ts / 1000.0 if ts > 1e11 else ts
    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except Exception:
        return None


def _safe_json_load(text_value: Optional[str]) -> Optional[Any]:
    if not isinstance(text_value, str):
        return None
    normalized = text_value.replace("\ufeff", "").strip()
    if not normalized:
        return None
    try:
        return json.loads(normalized)
    except Exception:
        return None


def _openai_sse_data(payload: Any) -> bytes:
    try:
        text = json.dumps(payload, ensure_ascii=False)
    except Exception:
        text = json.dumps({"error": {"message": "serialize_error", "type": "upstream_error", "code": 500}})
    return f"data: {text}\n\n".encode("utf-8")


def _openai_sse_error(message: str, *, code: int = 500) -> bytes:
    return _openai_sse_data({"error": {"message": str(message), "type": "upstream_error", "code": int(code)}})


def _openai_sse_done() -> bytes:
    return b"data: [DONE]\n\n"


def _account_to_safe_dict(account: KiroAccount) -> Dict[str, Any]:
    return {
        "account_id": account.account_id,
        "user_id": account.user_id,
        "account_name": account.account_name,
        "auth_method": account.auth_method,
        "status": int(account.status or 0),
        "expires_at": _to_ms(account.token_expires_at),
        "email": account.email,
        "subscription": account.subscription,
        "created_at": account.created_at,
        "updated_at": account.updated_at,
    }


class UpstreamAPIError(Exception):
    """上游API错误，用于传递上游服务的错误信息"""
    
    def __init__(
        self,
        status_code: int,
        message: str,
        upstream_response: Optional[Dict[str, Any]] = None
    ):
        self.status_code = status_code
        self.message = message
        self.upstream_response = upstream_response
        # 尝试从上游响应中提取真正的错误消息
        self.extracted_message = self._extract_message()
        super().__init__(self.message)
    
    def _extract_message(self) -> str:
        """从上游响应中提取错误消息"""
        if not self.upstream_response:
            return self.message
        
        # 尝试从 error 字段提取
        error_field = self.upstream_response.get("error")
        if error_field:
            # 如果 error 是字符串，尝试解析其中的 JSON
            if isinstance(error_field, str):
                # 尝试提取 JSON 部分，格式如: "错误: 429 {\"message\":\"...\",\"reason\":null}"
                import re
                json_match = re.search(r'\{.*\}', error_field)
                if json_match:
                    try:
                        inner_json = json.loads(json_match.group())
                        if isinstance(inner_json, dict) and "message" in inner_json:
                            return inner_json["message"]
                    except (json.JSONDecodeError, Exception):
                        pass
                # 如果无法解析 JSON，返回整个 error 字符串
                return error_field
            # 如果 error 是字典
            elif isinstance(error_field, dict):
                if "message" in error_field:
                    return error_field["message"]
                return str(error_field)
        
        # 尝试从 message 字段提取
        if "message" in self.upstream_response:
            return self.upstream_response["message"]
        
        # 尝试从 detail 字段提取
        # Some upstream errors use "reason" (e.g. banned / access denied hints)
        if "reason" in self.upstream_response:
            reason = self.upstream_response.get("reason")
            if isinstance(reason, str) and reason.strip():
                return reason.strip()

        if "detail" in self.upstream_response:
            return self.upstream_response["detail"]
        
        return self.message


class KiroService:
    """Kiro账号服务类（后端本地实现）"""
    
    # 支持的Kiro模型列表
    SUPPORTED_MODELS = [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-4-20250514",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-haiku-4-5-20251001",
    ]
    
    def __init__(self, db: AsyncSession, redis: Optional[RedisClient] = None):
        """
        初始化服务
        
        Args:
            db: 数据库会话
            redis: Redis 客户端（可选，用于缓存）
        """
        self.db = db
        self.settings = get_settings()
        self._redis = redis
    
    @property
    def redis(self) -> RedisClient:
        """获取 Redis 客户端"""
        if self._redis is None:
            self._redis = get_redis_client()
        return self._redis
    
    # ==================== Kiro OAuth（Social: Google/Github）====================

    def _kiro_oauth_state_key(self, state: str) -> str:
        return f"{KIRO_OAUTH_STATE_KEY_PREFIX}{state}"

    @staticmethod
    def _normalize_kiro_oauth_provider(provider: str) -> str:
        p = str(provider or "").strip()
        if not p:
            raise ValueError("provider is required")
        lower = p.lower()
        if lower in ("google", "goog"):
            return "Google"
        if lower in ("github", "gh"):
            return "Github"
        raise ValueError("provider must be Google or Github")

    @staticmethod
    def _generate_pkce_verifier() -> str:
        # PKCE code_verifier should be 43-128 chars, URL-safe.
        verifier = secrets.token_urlsafe(48)
        return verifier[:128]

    @classmethod
    def _pkce_challenge(cls, verifier: str) -> str:
        digest = hashlib.sha256(verifier.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    @staticmethod
    def _parse_kiro_oauth_callback(callback_url: str) -> Dict[str, str]:
        trimmed = (callback_url or "").strip()
        if not trimmed:
            raise ValueError("callback_url is empty")

        candidate = trimmed
        if "://" not in candidate:
            if candidate.startswith("?"):
                candidate = "kiro://oauth/callback" + candidate
            elif "=" in candidate:
                candidate = "kiro://oauth/callback?" + candidate
            else:
                raise ValueError("callback_url is not a valid URL or query")

        parsed = urlparse(candidate)
        q = parse_qs(parsed.query or "")
        # Some providers may put params in fragment (#code=...&state=...)
        if (not q) and parsed.fragment:
            q = parse_qs(parsed.fragment)

        code = (q.get("code", [""])[0] or "").strip()
        state = (q.get("state", [""])[0] or "").strip()
        err = (q.get("error", [""])[0] or "").strip()
        err_desc = (q.get("error_description", [""])[0] or "").strip()
        if not err and err_desc:
            err = err_desc

        if err:
            raise ValueError(f"OAuth failed: {err}")
        if not code or not state:
            raise ValueError("callback_url missing code/state")

        return {"code": code, "state": state}

    @staticmethod
    def _kiro_auth_base_url(region: str) -> str:
        r = str(region or "").strip() or "us-east-1"
        return f"https://prod.{r}.auth.desktop.kiro.dev"

    @classmethod
    def _build_kiro_social_authorize_url(
        cls,
        *,
        provider: str,
        redirect_uri: str,
        code_challenge: str,
        state: str,
        region: str,
    ) -> str:
        base = cls._kiro_auth_base_url(region)
        query = urlencode(
            {
                "idp": provider,
                "redirect_uri": redirect_uri,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
                "prompt": "select_account",
            }
        )
        return f"{base}/login?{query}"
    
    #==================== Kiro账号管理 ====================
    
    async def get_oauth_authorize_url(
        self,
        user_id: int,
        provider: str,
        is_shared: int = 0
    ) -> Dict[str, Any]:
        """获取 Kiro Social OAuth 授权 URL（后端本地实现）。"""
        provider_norm = self._normalize_kiro_oauth_provider(provider)

        try:
            is_shared_int = int(is_shared)
        except Exception:
            raise ValueError("is_shared must be 0 or 1")
        if is_shared_int not in (0, 1):
            raise ValueError("is_shared must be 0 or 1")

        region = "us-east-1"
        redirect_uri = "kiro://oauth/callback"
        code_verifier = self._generate_pkce_verifier()
        code_challenge = self._pkce_challenge(code_verifier)
        state = f"kiro-{secrets.token_hex(16)}"
        machineid = secrets.token_hex(32)

        auth_url = self._build_kiro_social_authorize_url(
            provider=provider_norm,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            state=state,
            region=region,
        )

        now_ms = int(time.time() * 1000)
        state_payload = {
            "status": "pending",
            "user_id": int(user_id),
            "is_shared": int(is_shared_int),
            "provider": provider_norm,
            "region": region,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "machineid": machineid,
            "created_at_ms": now_ms,
            "expires_at_ms": now_ms + KIRO_OAUTH_STATE_TTL_SECONDS * 1000,
        }
        await self.redis.set_json(self._kiro_oauth_state_key(state), state_payload, expire=KIRO_OAUTH_STATE_TTL_SECONDS)

        return {
            "success": True,
            "data": {"auth_url": auth_url, "state": state, "expires_in": KIRO_OAUTH_STATE_TTL_SECONDS},
        }

    async def get_oauth_status(self, user_id: int, state: str) -> Dict[str, Any]:
        """轮询 Kiro OAuth 授权状态（后端本地实现）。"""
        key = self._kiro_oauth_state_key(state)
        info = await self.redis.get_json(key)
        if not isinstance(info, dict):
            return {"success": False, "status": "expired", "message": "state expired"}

        if int(info.get("user_id") or 0) != int(user_id):
            # 不泄漏其他用户的 state 是否存在
            return {"success": False, "status": "expired", "message": "state expired"}

        status_val = str(info.get("status") or "pending").strip().lower()
        if status_val == "completed":
            return {"success": True, "status": "completed", "data": info.get("account")}
        if status_val in ("failed", "error"):
            return {"success": False, "status": "failed", "message": info.get("error") or "OAuth failed"}

        expires_at_ms = int(info.get("expires_at_ms") or 0)
        now_ms = int(time.time() * 1000)
        if expires_at_ms and now_ms >= expires_at_ms:
            await self.redis.delete(key)
            return {"success": False, "status": "expired", "message": "state expired"}

        return {"success": True, "status": "pending", "message": "waiting for authorization"}

    async def submit_oauth_callback(self, callback_url: str) -> Dict[str, Any]:
        """
        提交 Kiro OAuth 回调（给 AntiHook 用）。

        说明：
        - authorize 阶段写入 Redis：state -> user_id / is_shared / code_verifier / redirect_uri / machineid
        - callback 阶段由 AntiHook 转发 kiro:// 回调 URL 到此接口；后端用 code+verifier 换 token 并落库
        """
        try:
            parsed = self._parse_kiro_oauth_callback(callback_url)
        except Exception as e:
            raise UpstreamAPIError(status_code=400, message=str(e))

        state = parsed["state"]
        code = parsed["code"]
        key = self._kiro_oauth_state_key(state)
        info = await self.redis.get_json(key)
        if not isinstance(info, dict):
            raise UpstreamAPIError(status_code=404, message="state expired")

        status_val = str(info.get("status") or "pending").strip().lower()
        if status_val == "completed":
            return {"success": True, "message": "already completed", "data": info.get("account")}

        user_id = int(info.get("user_id") or 0)
        if user_id <= 0:
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": "invalid user_id"},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise UpstreamAPIError(status_code=400, message="invalid user_id")

        region = str(info.get("region") or "us-east-1").strip() or "us-east-1"
        redirect_uri = str(info.get("redirect_uri") or "kiro://oauth/callback").strip()
        code_verifier = str(info.get("code_verifier") or "").strip()
        if not code_verifier:
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": "missing code_verifier"},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise UpstreamAPIError(status_code=400, message="missing code_verifier")

        token_url = f"{self._kiro_auth_base_url(region)}/oauth/token"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "AntiHub-Backend/kiro-oauth",
            "Accept": "application/json",
        }
        payload = {"code": code, "code_verifier": code_verifier, "redirect_uri": redirect_uri}

        proxy_url = self._get_kiro_proxy_url()
        client_kwargs: Dict[str, Any] = {"timeout": httpx.Timeout(30.0, connect=10.0)}
        if proxy_url:
            client_kwargs["proxies"] = proxy_url

        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.post(token_url, json=payload, headers=headers)

        try:
            token_data: Any = resp.json() if resp.content else {}
        except Exception:
            token_data = {"raw": resp.text}

        if resp.status_code >= 400:
            err_msg = None
            if isinstance(token_data, dict):
                err_msg = token_data.get("error") or token_data.get("message") or token_data.get("detail")
            err_text = str(err_msg or resp.text or "").strip()[:2000] or f"HTTP {resp.status_code}"
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": err_text},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise UpstreamAPIError(status_code=resp.status_code, message=f"token exchange failed: {err_text}")

        if not isinstance(token_data, dict):
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": "invalid token response"},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise UpstreamAPIError(status_code=500, message="invalid token response")

        access_token = _trimmed_str(token_data.get("accessToken") or token_data.get("access_token"))
        refresh_token = _trimmed_str(token_data.get("refreshToken") or token_data.get("refresh_token"))
        profile_arn = _trimmed_str(token_data.get("profileArn") or token_data.get("profile_arn")) or None
        expires_in = token_data.get("expiresIn") if isinstance(token_data.get("expiresIn"), int) else None

        if not refresh_token:
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": "missing refreshToken"},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise UpstreamAPIError(status_code=500, message="token response missing refreshToken")

        account_payload: Dict[str, Any] = {
            "account_name": f"Kiro OAuth ({info.get('provider') or 'Social'})",
            "auth_method": "Social",
            "refresh_token": refresh_token,
            "access_token": access_token,
            "profile_arn": profile_arn,
            "machineid": info.get("machineid") or secrets.token_hex(32),
            "region": region,
            "is_shared": int(info.get("is_shared") or 0),
        }
        if expires_in:
            account_payload["expires_in"] = expires_in

        try:
            result = await self.create_account(user_id, account_payload)
        except UpstreamAPIError as e:
            await self.redis.set_json(
                key,
                {**info, "status": "failed", "error": e.extracted_message},
                expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS,
            )
            raise

        safe_account = result.get("data") if isinstance(result, dict) else None
        now_ms = int(time.time() * 1000)
        safe_state = {
            "status": "completed",
            "user_id": info.get("user_id"),
            "is_shared": info.get("is_shared"),
            "provider": info.get("provider"),
            "created_at_ms": info.get("created_at_ms"),
            "completed_at_ms": now_ms,
            "account": safe_account,
        }
        await self.redis.set_json(key, safe_state, expire=KIRO_OAUTH_STATE_COMPLETED_TTL_SECONDS)
        return {"success": True, "message": "OAuth completed", "data": safe_account}

    async def _get_account_by_id(self, account_id: str) -> Optional[KiroAccount]:
        result = await self.db.execute(select(KiroAccount).where(KiroAccount.account_id == account_id))
        return result.scalar_one_or_none()

    def _assert_account_access(self, account: Optional[KiroAccount], user_id: int) -> KiroAccount:
        if account is None:
            raise UpstreamAPIError(status_code=404, message="账号不存在")
        if account.user_id != user_id:
            raise UpstreamAPIError(status_code=403, message="无权访问该账号")
        return account

    def _load_account_credentials(self, account: KiroAccount) -> Dict[str, Any]:
        try:
            plaintext = decrypt_api_key(account.credentials)
            parsed = json.loads(plaintext) if plaintext else {}
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    async def create_account(self, user_id: int, account_data: Dict[str, Any]) -> Dict[str, Any]:
        """创建/导入 Kiro 账号（Refresh Token）。

        注意：该接口会在创建时尝试请求上游 getUsageLimits（包含 email/subscription），用于校验凭据有效性；
        如果上游返回 401/403，会直接失败并不会落库。
        """
        refresh_token = _trimmed_str(account_data.get("refresh_token") or account_data.get("refreshToken"))
        if not refresh_token:
            raise UpstreamAPIError(status_code=400, message="missing refresh_token")

        auth_method = _trimmed_str(account_data.get("auth_method") or account_data.get("authMethod") or "Social")
        auth_method_lower = auth_method.lower()
        if auth_method_lower == "social":
            auth_method = "Social"
        elif auth_method_lower in ("idc", "iam", "ima", "builder-id", "builderid", "aws-ima"):
            auth_method = "IdC"
        if auth_method not in ("Social", "IdC"):
            raise UpstreamAPIError(status_code=400, message="auth_method must be Social or IdC")

        client_id = _trimmed_str(account_data.get("client_id") or account_data.get("clientId"))
        client_secret = _trimmed_str(account_data.get("client_secret") or account_data.get("clientSecret"))
        if auth_method == "IdC" and (not client_id or not client_secret):
            raise UpstreamAPIError(status_code=400, message="IdC requires client_id and client_secret")

        account_name = _trimmed_str(account_data.get("account_name") or account_data.get("accountName")) or "Kiro Account"
        machineid = _trimmed_str(account_data.get("machineid") or account_data.get("machineId")) or None
        region = _trimmed_str(account_data.get("region")) or "us-east-1"
        auth_region = _trimmed_str(account_data.get("auth_region") or account_data.get("authRegion")) or None
        api_region = _trimmed_str(account_data.get("api_region") or account_data.get("apiRegion")) or None
        if auth_method == "IdC" and not api_region:
            # Kiro/Amazon Q Developer API region is typically us-east-1 even when SSO/OIDC auth region differs.
            api_region = "us-east-1"
        if auth_method == "IdC" and not auth_region:
            auth_region = region
        userid = (
            _trimmed_str(account_data.get("userid") or account_data.get("userId") or account_data.get("user_id"))
            or None
        )
        email = _trimmed_str(account_data.get("email")) or None
        subscription = _trimmed_str(account_data.get("subscription")) or None
        subscription_type = _trimmed_str(account_data.get("subscription_type") or account_data.get("subscriptionType")) or None

        is_shared_raw = account_data.get("is_shared") if "is_shared" in account_data else account_data.get("isShared")
        is_shared = 0
        if isinstance(is_shared_raw, bool):
            is_shared = 1 if is_shared_raw else 0
        elif is_shared_raw is not None:
            try:
                is_shared = int(is_shared_raw)
            except Exception:
                raise UpstreamAPIError(status_code=400, message="is_shared must be 0 or 1")
        if is_shared not in (0, 1):
            raise UpstreamAPIError(status_code=400, message="is_shared must be 0 or 1")

        expires_in_raw = account_data.get("expires_in") if "expires_in" in account_data else account_data.get("expiresIn")
        expires_in: Optional[int] = None
        if isinstance(expires_in_raw, (int, float)) and int(expires_in_raw) > 0:
            expires_in = int(expires_in_raw)

        provider = _trimmed_str(account_data.get("provider")) or None

        credentials_payload = {
            "type": "kiro",
            "refresh_token": refresh_token,
            "access_token": account_data.get("access_token") or account_data.get("accessToken"),
            "client_id": client_id or None,
            "client_secret": client_secret or None,
            "profile_arn": account_data.get("profile_arn") or account_data.get("profileArn"),
            "machineid": machineid,
            "region": region,
            "auth_region": auth_region,
            "api_region": api_region,
            "auth_method": auth_method,
            "userid": userid,
            "email": email,
            "subscription": subscription,
            "subscription_type": subscription_type,
        }
        if provider:
            credentials_payload["provider"] = provider
        if expires_in is not None:
            credentials_payload["expires_in"] = expires_in
        encrypted_credentials = encrypt_api_key(json.dumps(credentials_payload, ensure_ascii=False))

        account = KiroAccount(
            account_id=str(uuid4()),
            user_id=None if is_shared == 1 else int(user_id),
            is_shared=is_shared,
            account_name=account_name,
            auth_method=auth_method,
            region=region,
            machineid=machineid,
            userid=userid,
            email=email,
            subscription=subscription,
            subscription_type=subscription_type,
            status=1,
            need_refresh=False,
            credentials=encrypted_credentials,
        )
        if expires_in is not None and (account_data.get("access_token") or account_data.get("accessToken")):
            account.token_expires_at = _now_utc() + timedelta(seconds=expires_in)

        # Validate credentials before persisting.
        # If upstream rejects the token (401/403), do NOT insert into DB.
        try:
            await self._refresh_account_usage_limits_from_upstream(account)
        except UpstreamAPIError:
            raise
        except ValueError as e:
            # Token refresh helpers currently raise ValueError; normalize to UpstreamAPIError
            # so the API layer can surface a consistent {error, type} payload.
            msg = str(e or "").strip() or "token validation failed"
            status_code = 400
            m = re.search(r"HTTP\s+(\d{3})", msg)
            if m:
                try:
                    candidate = int(m.group(1))
                    if 400 <= candidate <= 599:
                        status_code = candidate
                except Exception:
                    status_code = 400
            raise UpstreamAPIError(status_code=status_code, message=msg)

        self.db.add(account)
        await self.db.flush()

        created = await self._get_account_by_id(account.account_id)
        assert created is not None
        return {"success": True, "message": "Kiro账号已导入", "data": _account_to_safe_dict(created)}
    
    async def get_accounts(self, user_id: int) -> Dict[str, Any]:
        """获取 Kiro 账号列表（从 Backend DB）。"""
        result = await self.db.execute(
            select(KiroAccount).where(KiroAccount.user_id == user_id).order_by(KiroAccount.created_at.desc())
        )
        accounts = result.scalars().all()
        return {"success": True, "data": [_account_to_safe_dict(a) for a in accounts]}
    
    async def get_account(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """获取单个 Kiro 账号（从 Backend DB）。"""
        account = await self._get_account_by_id(account_id)
        account = self._assert_account_access(account, user_id)
        return {"success": True, "data": _account_to_safe_dict(account)}

    async def get_account_credentials(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """
        导出Kiro账号凭证（敏感信息）

        说明：
        - 仅用于用户自助导出/备份（前端“复制凭证为JSON”）
        - Backend DB 中凭证为加密 JSON；此接口会解密后返回（谨慎使用）
        """
        account = await self._get_account_by_id(account_id)
        account = self._assert_account_access(account, user_id)

        creds = self._load_account_credentials(account)
        export = {
            "type": "kiro",
            "refresh_token": creds.get("refresh_token"),
            "access_token": creds.get("access_token"),
            "client_id": creds.get("client_id"),
            "client_secret": creds.get("client_secret"),
            "profile_arn": creds.get("profile_arn"),
            "machineid": account.machineid or creds.get("machineid"),
            "region": account.region or creds.get("region"),
            "auth_region": creds.get("auth_region") or creds.get("authRegion"),
            "api_region": creds.get("api_region") or creds.get("apiRegion"),
            "auth_method": account.auth_method or creds.get("auth_method"),
            "expires_at": _to_ms(account.token_expires_at),
            "userid": account.userid,
            "email": account.email,
            "subscription": account.subscription,
            "subscription_type": account.subscription_type,
        }
        data = {k: v for k, v in export.items() if v is not None and not (isinstance(v, str) and not v.strip())}
        return {"success": True, "data": data}
    
    async def update_account_status(
        self,
        user_id: int,
        account_id: str,
        status: int
    ) -> Dict[str, Any]:
        """更新 Kiro 账号状态（从 Backend DB）。"""
        if status not in (0, 1):
            raise UpstreamAPIError(status_code=400, message="status必须是0或1")

        account = await self._get_account_by_id(account_id)
        self._assert_account_access(account, user_id)

        await self.db.execute(update(KiroAccount).where(KiroAccount.account_id == account_id).values(status=int(status)))
        await self.db.flush()

        updated = await self._get_account_by_id(account_id)
        assert updated is not None
        return {"success": True, "message": "账号状态已更新", "data": _account_to_safe_dict(updated)}
    
    async def update_account_name(
        self,
        user_id: int,
        account_id: str,
        account_name: str
    ) -> Dict[str, Any]:
        """更新 Kiro 账号名称（从 Backend DB）。"""
        name = _trimmed_str(account_name)
        if not name:
            raise UpstreamAPIError(status_code=400, message="account_name不能为空")

        account = await self._get_account_by_id(account_id)
        self._assert_account_access(account, user_id)

        await self.db.execute(update(KiroAccount).where(KiroAccount.account_id == account_id).values(account_name=name))
        await self.db.flush()

        updated = await self._get_account_by_id(account_id)
        assert updated is not None
        return {"success": True, "message": "账号名称已更新", "data": _account_to_safe_dict(updated)}
    
    def _build_kiro_usage_limits_headers(self, *, token: str, machineid: str) -> Dict[str, str]:
        """
        Headers for getUsageLimits (CodeWhisperer runtime) requests.

        Note: This is intentionally different from streaming chat headers.
        """
        ide_version = self._get_kiro_ide_version()
        mid = (machineid or "")[:32] or secrets.token_hex(16)
        user_agent = (
            "aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 "
            f"api/codewhispererruntime#1.0.0 m/E KiroIDE-{ide_version}-{mid}"
        )
        amz_user_agent = f"aws-sdk-js/1.0.0 KiroIDE-{ide_version}-{mid}"
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": user_agent,
            "x-amz-user-agent": amz_user_agent,
            "amz-sdk-invocation-id": str(uuid4()),
            "amz-sdk-request": "attempt=1; max=1",
            "Connection": "close",
        }

    @staticmethod
    def _pick_usage_breakdown(value: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(value, list):
            return None

        # Prefer the requested resourceType if present.
        for item in value:
            if not isinstance(item, dict):
                continue
            rt = str(item.get("resourceType") or item.get("resource_type") or "").strip().upper()
            if rt == "AGENTIC_REQUEST":
                return item

        for item in value:
            if isinstance(item, dict):
                return item
        return None

    @staticmethod
    def _format_upstream_feedback(error: UpstreamAPIError) -> Dict[str, Any]:
        raw: Optional[str] = None
        if isinstance(error.upstream_response, dict):
            raw_value = error.upstream_response.get("__raw") or error.upstream_response.get("raw")
            if isinstance(raw_value, str) and raw_value.strip():
                raw = raw_value.strip()
            elif error.upstream_response:
                try:
                    raw = json.dumps(error.upstream_response, ensure_ascii=False)
                except Exception:
                    raw = None

        text = raw or (error.extracted_message or error.message or "")
        if isinstance(text, str) and len(text) > 2000:
            text = text[:2000]

        return {
            "status_code": int(getattr(error, "status_code", 500) or 500),
            "message": str(error.extracted_message or error.message or ""),
            "raw": str(text or ""),
        }

    def _apply_usage_limits_payload_to_account(self, *, account: KiroAccount, payload: Dict[str, Any]) -> None:
        user_info = payload.get("userInfo") or payload.get("user_info")
        if isinstance(user_info, dict):
            email = _trimmed_str(user_info.get("email"))
            if email:
                account.email = email
            upstream_user_id = _trimmed_str(user_info.get("userId") or user_info.get("user_id"))
            if upstream_user_id:
                account.userid = upstream_user_id

        subscription_info = payload.get("subscriptionInfo") or payload.get("subscription_info")
        if isinstance(subscription_info, dict):
            subscription_title = _trimmed_str(
                subscription_info.get("subscriptionTitle") or subscription_info.get("subscription_title")
            )
            if subscription_title:
                account.subscription = subscription_title
            subscription_type = _trimmed_str(
                subscription_info.get("type")
                or subscription_info.get("subscriptionType")
                or subscription_info.get("subscription_type")
            )
            if subscription_type:
                account.subscription_type = subscription_type

            # Enterprise subscription auto-detection: if subscription title or
            # type contains "POWER" or "ENTERPRISE", mark as Enterprise.
            _sub_upper = (account.subscription or "").upper()
            _type_upper = (account.subscription_type or "").upper()
            if "POWER" in _sub_upper or "ENTERPRISE" in _sub_upper or "POWER" in _type_upper or "ENTERPRISE" in _type_upper:
                account.subscription_type = "Enterprise"

        breakdown_list = payload.get("usageBreakdownList") or payload.get("usage_breakdown_list") or []
        breakdown = self._pick_usage_breakdown(breakdown_list) or {}

        usage_limit = _coerce_float(
            breakdown.get("usageLimitWithPrecision")
            or breakdown.get("usage_limit_with_precision")
            or breakdown.get("usageLimit")
            or breakdown.get("usage_limit"),
            0.0,
        )
        current_usage = _coerce_float(
            breakdown.get("currentUsageWithPrecision")
            or breakdown.get("current_usage_with_precision")
            or breakdown.get("currentUsage")
            or breakdown.get("current_usage"),
            0.0,
        )
        account.usage_limit = float(usage_limit)
        account.current_usage = float(current_usage)

        reset_dt = _epoch_to_datetime(
            breakdown.get("nextDateReset")
            or breakdown.get("next_date_reset")
            or payload.get("nextDateReset")
            or payload.get("next_date_reset")
        )
        if reset_dt is not None:
            account.reset_date = reset_dt

        free_trial_info = breakdown.get("freeTrialInfo") or breakdown.get("free_trial_info")
        if isinstance(free_trial_info, dict):
            status_raw = free_trial_info.get("freeTrialStatus") or free_trial_info.get("free_trial_status")
            status_text = str(status_raw or "").strip().upper()
            ft_limit = _coerce_float(
                free_trial_info.get("usageLimitWithPrecision")
                or free_trial_info.get("usage_limit_with_precision")
                or free_trial_info.get("usageLimit")
                or free_trial_info.get("usage_limit"),
                0.0,
            )
            ft_usage = _coerce_float(
                free_trial_info.get("currentUsageWithPrecision")
                or free_trial_info.get("current_usage_with_precision")
                or free_trial_info.get("currentUsage")
                or free_trial_info.get("current_usage"),
                0.0,
            )
            ft_expiry = _epoch_to_datetime(
                free_trial_info.get("freeTrialExpiry") or free_trial_info.get("free_trial_expiry")
            )

            if status_text or ft_limit or ft_usage or ft_expiry is not None:
                account.free_trial_status = status_text == "ACTIVE"
                account.free_trial_limit = float(ft_limit)
                account.free_trial_usage = float(ft_usage)
                account.free_trial_expiry = ft_expiry
            else:
                account.free_trial_status = None
                account.free_trial_limit = None
                account.free_trial_usage = None
                account.free_trial_expiry = None
        else:
            account.free_trial_status = None
            account.free_trial_limit = None
            account.free_trial_usage = None
            account.free_trial_expiry = None

        bonuses = breakdown.get("bonuses")
        bonus_details: List[Dict[str, Any]] = []
        bonus_limit_total = 0.0
        bonus_usage_total = 0.0

        if isinstance(bonuses, list):
            for bonus in bonuses:
                if not isinstance(bonus, dict):
                    continue

                status = str(bonus.get("status") or "").strip().upper()
                # Backward compat: missing status treated as active.
                is_active = (not status) or status == "ACTIVE"

                usage = _coerce_float(
                    bonus.get("currentUsageWithPrecision")
                    or bonus.get("current_usage_with_precision")
                    or bonus.get("currentUsage")
                    or bonus.get("current_usage"),
                    0.0,
                )
                limit = _coerce_float(
                    bonus.get("usageLimitWithPrecision")
                    or bonus.get("usage_limit_with_precision")
                    or bonus.get("usageLimit")
                    or bonus.get("usage_limit"),
                    0.0,
                )

                code = _trimmed_str(bonus.get("bonusCode") or bonus.get("bonus_code"))
                name = _trimmed_str(bonus.get("displayName") or bonus.get("display_name") or bonus.get("name"))
                description = bonus.get("description") if isinstance(bonus.get("description"), str) else None

                expires_at = _epoch_to_datetime(bonus.get("expiresAt") or bonus.get("expires_at"))
                redeemed_at = _epoch_to_datetime(bonus.get("redeemedAt") or bonus.get("redeemed_at"))

                available = max(limit - usage, 0.0) if is_active else 0.0

                bonus_details.append(
                    {
                        "type": "bonus",
                        "name": name or code or "Bonus",
                        "code": code,
                        "description": description,
                        "usage": float(usage),
                        "limit": float(limit),
                        "available": float(available),
                        "status": status or ("ACTIVE" if is_active else ""),
                        "expires_at": expires_at.isoformat() if expires_at else None,
                        "redeemed_at": redeemed_at.isoformat() if redeemed_at else None,
                    }
                )

                if is_active:
                    bonus_limit_total += float(limit)
                    bonus_usage_total += float(usage)

        account.bonus_details = json.dumps(bonus_details, ensure_ascii=False) if bonus_details else None
        account.bonus_limit = float(bonus_limit_total)
        account.bonus_usage = float(bonus_usage_total)

    async def _refresh_account_usage_limits_from_upstream(self, account: KiroAccount) -> Dict[str, Any]:
        creds = self._load_account_credentials(account)
        api_region = self._effective_api_region(account=account, creds=creds)
        machineid = _trimmed_str(account.machineid or creds.get("machineid")) or secrets.token_hex(32)
        account.machineid = machineid

        proxy_url = self._get_kiro_proxy_url()
        timeout = httpx.Timeout(30.0, connect=10.0)
        client_kwargs: Dict[str, Any] = {"timeout": timeout}
        if proxy_url:
            client_kwargs["proxies"] = proxy_url

        async with httpx.AsyncClient(**client_kwargs) as client:
            access_token, profile_arn = await self._ensure_valid_access_token(client=client, account=account)

            params: Dict[str, str] = {
                "isEmailRequired": "true",
                "origin": "AI_EDITOR",
                "resourceType": "AGENTIC_REQUEST",
            }
            if profile_arn:
                params["profileArn"] = profile_arn

            headers_template = self._build_kiro_usage_limits_headers(token=access_token, machineid=machineid)

            best_error: Optional[UpstreamAPIError] = None

            for base_url in self._kiro_api_base_urls(api_region):
                url = f"{base_url.rstrip('/')}/getUsageLimits"
                host = httpx.URL(url).host
                headers = dict(headers_template)
                if host:
                    headers["Host"] = host

                try:
                    resp = await client.get(url, headers=headers, params=params, timeout=timeout)
                except (httpx.ConnectError, httpx.HTTPError) as e:
                    best_error = best_error or UpstreamAPIError(status_code=502, message=str(e))
                    continue

                raw = (resp.text or "")[:4000]
                try:
                    payload: Any = resp.json() if resp.content else {}
                except Exception:
                    payload = {"__raw": raw}

                if resp.status_code >= 400:
                    upstream = payload if isinstance(payload, dict) else {"__raw": raw}
                    if isinstance(upstream, dict):
                        upstream.setdefault("__raw", raw)
                    err = UpstreamAPIError(
                        status_code=resp.status_code,
                        message=raw or f"HTTP {resp.status_code}",
                        upstream_response=upstream if isinstance(upstream, dict) else None,
                    )

                    if best_error is None:
                        best_error = err
                    else:
                        # Prefer 403 (account banned/removed) over other errors for fallback handling.
                        if err.status_code == 403 and best_error.status_code != 403:
                            best_error = err
                        elif err.status_code == 401 and best_error.status_code not in (403, 401):
                            best_error = err
                        elif best_error.status_code not in (403, 401):
                            best_error = err
                    continue

                if not isinstance(payload, dict):
                    raise UpstreamAPIError(
                        status_code=502,
                        message="getUsageLimits response is not a JSON object",
                        upstream_response={"__raw": raw},
                    )

                self._apply_usage_limits_payload_to_account(account=account, payload=payload)
                await self.db.flush()
                return payload

        raise best_error or UpstreamAPIError(status_code=502, message="getUsageLimits failed")

    async def get_account_balance(self, user_id: int, account_id: str, refresh: bool = False) -> Dict[str, Any]:
        """获取 Kiro 账号余额（从 Backend DB 的缓存字段计算）。"""
        account = await self._get_account_by_id(account_id)
        account = self._assert_account_access(account, user_id)

        upstream_feedback: Optional[Dict[str, Any]] = None
        if refresh:
            try:
                await self._refresh_account_usage_limits_from_upstream(account)
            except UpstreamAPIError as e:
                # Only fallback to DB when upstream explicitly says access is gone (e.g. banned/removed).
                if e.status_code == 403:
                    upstream_feedback = self._format_upstream_feedback(e)
                else:
                    raise

        current_usage = _coerce_float(account.current_usage, 0.0)
        usage_limit = _coerce_float(account.usage_limit, 0.0)
        base_available = max(usage_limit - current_usage, 0.0)

        bonus_available = 0.0
        bonus_limit_total = 0.0

        bonus_details: List[Dict[str, Any]] = []
        parsed_bonus = _safe_json_load(account.bonus_details)
        if isinstance(parsed_bonus, list):
            for item in parsed_bonus:
                if not isinstance(item, dict):
                    continue

                status = str(item.get("status") or "").strip().upper()
                # Backward compat: old rows had no status; treat as active.
                is_active = (not status) or status == "ACTIVE"

                usage = _coerce_float(item.get("usage"), 0.0)
                limit = _coerce_float(item.get("limit"), 0.0)
                available = _coerce_float(item.get("available"), max(limit - usage, 0.0))
                if not is_active:
                    available = 0.0

                bonus_details.append(item)
                if is_active:
                    bonus_limit_total += float(limit)
                    bonus_available += max(float(available), 0.0)
        else:
            bonus_limit_total = _coerce_float(account.bonus_limit, 0.0)
            bonus_usage = _coerce_float(account.bonus_usage, 0.0)
            bonus_available = max(bonus_limit_total - bonus_usage, 0.0)

        total_limit = usage_limit + bonus_limit_total
        available = base_available + bonus_available

        reset_date = account.reset_date or _now_utc()

        free_trial: Optional[Dict[str, Any]] = None
        if (
            account.free_trial_status is not None
            or account.free_trial_limit is not None
            or account.free_trial_usage is not None
            or account.free_trial_expiry is not None
        ):
            ft_limit = _coerce_float(account.free_trial_limit, 0.0)
            ft_usage = _coerce_float(account.free_trial_usage, 0.0)
            ft_available = max(ft_limit - ft_usage, 0.0)
            ft_expiry = account.free_trial_expiry or _now_utc()
            free_trial = {
                "status": bool(account.free_trial_status) if account.free_trial_status is not None else False,
                "usage": ft_usage,
                "limit": ft_limit,
                "available": ft_available,
                "expiry": ft_expiry.isoformat(),
            }

        data = {
            "account_id": account.account_id,
            "account_name": account.account_name or "Kiro Account",
            "email": account.email or "",
            "subscription": account.subscription or "",
            "subscription_type": account.subscription_type or None,
            "balance": {
                "available": float(available),
                "total_limit": float(total_limit),
                "current_usage": float(current_usage),
                "base_available": float(base_available),
                "bonus_available": float(bonus_available),
                "reset_date": reset_date.isoformat(),
            },
            "free_trial": free_trial,
            "bonus_details": bonus_details,
        }

        if upstream_feedback:
            data["upstream_feedback"] = upstream_feedback

        return {"success": True, "data": data}
    
    async def get_account_consumption(
        self,
        user_id: int,
        account_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取 Kiro 账号消费记录（当前未迁移历史 kiro_consumption_log，返回空列表）。"""
        account = await self._get_account_by_id(account_id)
        account = self._assert_account_access(account, user_id)

        limit_value = int(limit or 100)
        offset_value = int(offset or 0)
        data = {
            "account_id": account.account_id,
            "account_name": account.account_name or "Kiro Account",
            "logs": [],
            "stats": [],
            "pagination": {"limit": limit_value, "offset": offset_value, "total": 0},
        }
        return {"success": True, "data": data}
    
    async def get_user_consumption_stats(
        self,
        user_id: int,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取用户总消费统计（当前未迁移历史数据，返回 0）。"""
        data = {
            "total_requests": "0",
            "total_credit": "0",
            "avg_credit": "0",
        }
        return {"success": True, "data": data}
    
    async def delete_account(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """删除 Kiro 账号（从 Backend DB）。"""
        account = await self._get_account_by_id(account_id)
        self._assert_account_access(account, user_id)

        await self.db.execute(delete(KiroAccount).where(KiroAccount.account_id == account_id))
        await self.db.flush()
        return {"success": True, "message": "账号已删除"}
    
    # ==================== Kiro 订阅层 -> 可用模型（管理员配置） ====================

    async def get_subscription_model_rules(self) -> Dict[str, Any]:
        """获取订阅层可用模型配置（管理员，本地 DB）。"""
        result = await self.db.execute(select(KiroSubscriptionModel))
        rows = result.scalars().all()

        configured: Dict[str, Optional[List[str]]] = {}
        for r in rows:
            models = _safe_json_load(r.allowed_model_ids)
            if isinstance(models, list):
                model_ids = [str(x).strip() for x in models if isinstance(x, (str, int, float)) and str(x).strip()]
                configured[r.subscription] = model_ids
            else:
                configured[r.subscription] = None

        # 收集已出现的 subscription（便于管理员看到实际在用的订阅层）
        subs_result = await self.db.execute(
            select(KiroAccount.subscription).where(KiroAccount.subscription.is_not(None)).distinct()
        )
        subs_from_accounts = [s for s in (subs_result.scalars().all() or []) if isinstance(s, str) and s.strip()]

        all_subs = sorted({*(configured.keys()), *subs_from_accounts})
        data = []
        for sub in all_subs:
            model_ids = configured.get(sub)
            data.append({"subscription": sub, "configured": model_ids is not None, "model_ids": model_ids})

        return {"success": True, "data": data}

    async def upsert_subscription_model_rule(
        self,
        subscription: str,
        model_ids: Optional[List[str]],
    ) -> Dict[str, Any]:
        """设置订阅层可用模型配置（管理员，本地 DB）。

        - model_ids=None：删除配置（回到默认放行）
        """
        sub = _trimmed_str(subscription).upper()
        if not sub:
            raise UpstreamAPIError(status_code=400, message="subscription不能为空")

        if model_ids is None:
            await self.db.execute(delete(KiroSubscriptionModel).where(KiroSubscriptionModel.subscription == sub))
            await self.db.flush()
            return {"success": True, "message": "配置已删除", "data": {"subscription": sub, "configured": False, "model_ids": None}}

        normalized = [str(x).strip() for x in model_ids if isinstance(x, (str, int, float)) and str(x).strip()]
        payload = json.dumps(normalized, ensure_ascii=False)

        existing = await self.db.get(KiroSubscriptionModel, sub)
        if existing is None:
            self.db.add(KiroSubscriptionModel(subscription=sub, allowed_model_ids=payload))
        else:
            await self.db.execute(
                update(KiroSubscriptionModel)
                .where(KiroSubscriptionModel.subscription == sub)
                .values(allowed_model_ids=payload)
            )
        await self.db.flush()

        return {"success": True, "message": "配置已更新", "data": {"subscription": sub, "configured": True, "model_ids": normalized}}

    # ==================== Kiro OpenAI兼容API（后端直连上游） ====================

    def _get_kiro_proxy_url(self) -> Optional[str]:
        value = getattr(self.settings, "kiro_proxy_url", None)
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    def _get_kiro_ide_version(self) -> str:
        value = getattr(self.settings, "kiro_ide_version", None)
        if isinstance(value, str) and value.strip():
            return value.strip()
        return "0.9.2"

    @staticmethod
    def _coerce_region(value: Any) -> str:
        if isinstance(value, str) and value.strip():
            return value.strip()
        return "us-east-1"

    @classmethod
    def _effective_auth_region(cls, *, account: KiroAccount, creds: Dict[str, Any]) -> str:
        """
        Region used for auth/token refresh endpoints (OIDC / desktop auth).

        Backward compatible with old rows that only store `region`.
        """

        value = _trimmed_str(creds.get("auth_region") or creds.get("authRegion"))
        if value:
            return cls._coerce_region(value)
        return cls._coerce_region(account.region or creds.get("region"))

    @classmethod
    def _effective_api_region(cls, *, account: KiroAccount, creds: Dict[str, Any]) -> str:
        """
        Region used for API endpoints (q.* / codewhisperer.*).

        Note: For IdC (AWS IAM Identity Center / Builder ID) accounts, the SSO/OIDC auth region can differ
        from the API region. When `api_region` is not provided, default to `us-east-1` for IdC accounts
        (aligns with kiro-account-manager / kiro.rs behavior).
        """

        value = _trimmed_str(creds.get("api_region") or creds.get("apiRegion"))
        if value:
            return cls._coerce_region(value)

        auth_method = _trimmed_str(account.auth_method or creds.get("auth_method") or creds.get("authMethod"))
        if auth_method and auth_method.lower() in ("idc", "iam", "ima", "builder-id", "builderid", "aws-ima"):
            return "us-east-1"

        return cls._coerce_region(account.region or creds.get("region"))

    @staticmethod
    def _extract_openai_text_content(content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("type") or "").strip().lower()
                if item_type in ("text", "input_text"):
                    text = item.get("text")
                    if isinstance(text, str) and text:
                        parts.append(text)
            return "".join(parts)
        return str(content)

    @staticmethod
    def _extract_openai_tool_uses(message: Dict[str, Any]) -> List[Dict[str, Any]]:
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            return []

        out: List[Dict[str, Any]] = []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            tc_id = str(tc.get("id") or "").strip()
            if not tc_id:
                tc_id = f"call_{uuid4().hex[:24]}"

            func = tc.get("function")
            if not isinstance(func, dict):
                continue
            name = str(func.get("name") or "").strip()
            if not name:
                continue

            args_raw = func.get("arguments")
            args_obj: Any = {}
            if isinstance(args_raw, str) and args_raw.strip():
                try:
                    args_obj = json.loads(args_raw)
                except Exception:
                    args_obj = {}
            elif isinstance(args_raw, dict):
                args_obj = args_raw

            out.append(
                {
                    "toolUseId": tc_id,
                    "name": name,
                    "input": args_obj if isinstance(args_obj, dict) else {},
                }
            )
        return out

    @classmethod
    def _convert_openai_tools_to_kiro_tools(cls, tools: Any) -> List[Dict[str, Any]]:
        if not isinstance(tools, list):
            return []

        out: List[Dict[str, Any]] = []
        for item in tools:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "").strip().lower() != "function":
                continue
            fn = item.get("function")
            if not isinstance(fn, dict):
                continue

            name = str(fn.get("name") or "").strip()
            if not name:
                continue
            desc = fn.get("description")
            desc_str = desc.strip() if isinstance(desc, str) else ""
            if not desc_str:
                desc_str = f"Tool: {name}"

            # Align kiro.rs: enforce chunked-write hints for Claude Code tools.
            if name == "Write" and WRITE_TOOL_DESCRIPTION_SUFFIX not in desc_str:
                desc_str = f"{desc_str}\n{WRITE_TOOL_DESCRIPTION_SUFFIX}"
            elif name == "Edit" and EDIT_TOOL_DESCRIPTION_SUFFIX not in desc_str:
                desc_str = f"{desc_str}\n{EDIT_TOOL_DESCRIPTION_SUFFIX}"

            parameters = fn.get("parameters")
            schema_obj = parameters if isinstance(parameters, dict) else {}
            if schema_obj.get("type") is None:
                schema_obj = dict(schema_obj)
                schema_obj["type"] = "object"
            if not isinstance(schema_obj.get("properties"), dict):
                schema_obj = dict(schema_obj)
                schema_obj["properties"] = {}

            out.append(
                {
                    "toolSpecification": {
                        "name": name,
                        "description": desc_str[:10000],
                        "inputSchema": {"json": schema_obj},
                    }
                }
            )
        return out

    def _build_conversation_state_from_openai(
        self, *, request_data: Dict[str, Any], tools: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        model_raw = str(request_data.get("model") or "").strip()
        model_id = KiroAnthropicConverter._map_model(model_raw)

        messages = request_data.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list")

        system_parts: List[str] = []
        non_system: List[Dict[str, Any]] = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or "").strip().lower()
            if role in ("system", "developer"):
                system_parts.append(self._extract_openai_text_content(msg.get("content")))
                continue
            non_system.append(msg)

        if not non_system:
            raise ValueError("no non-system messages to send")

        # conversationId：允许客户端通过 user 字段传入 session_... 来固定会话（对齐 KiroAnthropicConverter）
        user_hint = request_data.get("user")
        conversation_id = None
        if isinstance(user_hint, str) and user_hint.strip():
            conversation_id = KiroAnthropicConverter._extract_session_id(user_hint.strip())
            if conversation_id is None:
                # 如果 user 直接是 UUID，也允许
                try:
                    import uuid

                    uuid.UUID(user_hint.strip())
                    conversation_id = user_hint.strip()
                except Exception:
                    conversation_id = None
        if conversation_id is None:
            conversation_id = str(uuid4())

        history: List[Dict[str, Any]] = []

        system_text = "\n".join([p for p in system_parts if p]).strip()
        if system_text:
            if SYSTEM_CHUNKED_POLICY not in system_text:
                system_text = f"{system_text}\n{SYSTEM_CHUNKED_POLICY}"
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

        # history: all but last (align kiro.rs: merge consecutive user/tool messages, ensure pairs)
        user_buffer: List[Dict[str, Any]] = []

        def _flush_user_buffer() -> None:
            nonlocal user_buffer
            if not user_buffer:
                return

            text_parts: List[str] = []
            tool_results: List[Dict[str, Any]] = []

            for m in user_buffer:
                role = str(m.get("role") or "").strip().lower()
                if role in ("tool", "function"):
                    tool_call_id = str(m.get("tool_call_id") or m.get("toolCallId") or "").strip()
                    tool_text = self._extract_openai_text_content(m.get("content"))
                    if tool_call_id:
                        tool_results.append(
                            {
                                "toolUseId": tool_call_id,
                                "content": [{"text": tool_text}],
                                "status": "success",
                            }
                        )
                    continue

                # default: treat as user
                text = self._extract_openai_text_content(m.get("content"))
                if text:
                    text_parts.append(text)

            ctx: Dict[str, Any] = {}
            if tool_results:
                ctx["toolResults"] = tool_results

            history.append(
                {
                    "userInputMessage": {
                        "userInputMessageContext": ctx,
                        "content": "\n".join(text_parts).strip(),
                        "modelId": model_id,
                        "images": [],
                        "origin": "AI_EDITOR",
                    }
                }
            )
            user_buffer = []

        for msg in non_system[:-1]:
            role = str(msg.get("role") or "").strip().lower()
            if role == "assistant":
                if not user_buffer:
                    # Align kiro.rs: ignore orphan assistant to keep history in user->assistant pairs.
                    continue
                _flush_user_buffer()

                tool_uses = self._extract_openai_tool_uses(msg)
                text = self._extract_openai_text_content(msg.get("content"))
                if not text and tool_uses:
                    text = " "
                assistant: Dict[str, Any] = {"content": text}
                if tool_uses:
                    assistant["toolUses"] = tool_uses
                history.append({"assistantResponseMessage": assistant})
                continue

            # user/tool/function are buffered and merged
            user_buffer.append(msg)

        if user_buffer:
            _flush_user_buffer()
            history.append({"assistantResponseMessage": {"content": "OK"}})

        # current message
        last = non_system[-1]
        last_role = str(last.get("role") or "").strip().lower()
        current_tool_results: List[Dict[str, Any]] = []
        current_text = ""

        if last_role == "assistant":
            tool_uses = self._extract_openai_tool_uses(last)
            text = self._extract_openai_text_content(last.get("content"))
            if not text and tool_uses:
                text = " "
            assistant: Dict[str, Any] = {"content": text}
            if tool_uses:
                assistant["toolUses"] = tool_uses
            history.append({"assistantResponseMessage": assistant})
            current_text = "Continue"
        elif last_role in ("tool", "function"):
            tool_call_id = str(last.get("tool_call_id") or last.get("toolCallId") or "").strip()
            tool_text = self._extract_openai_text_content(last.get("content"))
            if tool_call_id:
                current_tool_results.append(
                    {
                        "toolUseId": tool_call_id,
                        "content": [{"text": tool_text}],
                        "status": "success",
                    }
                )
            current_text = ""
        else:
            current_text = self._extract_openai_text_content(last.get("content"))

        # sanitize tool pairing in history to avoid upstream 400
        try:
            KiroAnthropicConverter._sanitize_history_tool_pairing(history)
        except Exception:
            pass

        # ensure history tool names exist in current tools
        try:
            history_tool_names = KiroAnthropicConverter._collect_history_tool_names(history)
            KiroAnthropicConverter._ensure_tool_definitions(tools, history_tool_names)
        except Exception:
            pass

        user_ctx: Dict[str, Any] = {}
        if tools:
            user_ctx["tools"] = tools
        if current_tool_results:
            user_ctx["toolResults"] = current_tool_results

        if not current_text and not current_tool_results:
            current_text = "OK"

        conversation_state = {
            "agentContinuationId": str(uuid4()),
            "agentTaskType": "vibe",
            "chatTriggerType": "MANUAL",
            "conversationId": conversation_id,
            "currentMessage": {
                "userInputMessage": {
                    "userInputMessageContext": user_ctx,
                    "content": current_text,
                    "modelId": model_id,
                    "images": [],
                    "origin": "AI_EDITOR",
                }
            },
            "history": history,
        }

        return conversation_state

    async def _list_available_chat_accounts(self, *, user_id: int, exclude: set[str]) -> List[KiroAccount]:
        stmt = select(KiroAccount).where(KiroAccount.status == 1)
        stmt = stmt.where(
            (KiroAccount.user_id == user_id)
            | ((KiroAccount.user_id.is_(None)) & (KiroAccount.is_shared == 1))
        )
        if exclude:
            stmt = stmt.where(KiroAccount.account_id.not_in(exclude))
        result = await self.db.execute(stmt.order_by(KiroAccount.created_at.desc()))
        return list(result.scalars().all())

    async def _ensure_valid_access_token(
        self, *, client: httpx.AsyncClient, account: KiroAccount
    ) -> Tuple[str, Optional[str]]:
        creds = self._load_account_credentials(account)

        access_token = _trimmed_str(creds.get("access_token") or creds.get("accessToken"))
        profile_arn = _trimmed_str(creds.get("profile_arn") or creds.get("profileArn")) or None

        now = _now_utc()
        expired = account.token_expires_at is None or account.token_expires_at <= (now + timedelta(seconds=30))
        if account.need_refresh or not access_token or expired:
            auth_method = _trimmed_str(account.auth_method or creds.get("auth_method") or creds.get("authMethod") or "Social")
            auth_region = self._effective_auth_region(account=account, creds=creds)
            refresh_token = _trimmed_str(creds.get("refresh_token") or creds.get("refreshToken"))
            if not refresh_token:
                raise ValueError("Kiro account missing refresh_token")

            machineid = _trimmed_str(account.machineid or creds.get("machineid"))
            if not machineid:
                machineid = secrets.token_hex(32)
                account.machineid = machineid

            new_token: Optional[str] = None
            new_refresh: Optional[str] = None
            expires_in: Optional[int] = None
            new_profile_arn: Optional[str] = None

            if auth_method.lower() == "idc":
                client_id = _trimmed_str(creds.get("client_id") or creds.get("clientId"))
                client_secret = _trimmed_str(creds.get("client_secret") or creds.get("clientSecret"))
                if not client_id or not client_secret:
                    raise ValueError("IdC account requires client_id and client_secret")

                url = f"https://oidc.{auth_region}.amazonaws.com/token"
                headers = {
                    "Content-Type": "application/json",
                    "Host": f"oidc.{auth_region}.amazonaws.com",
                    "Connection": "keep-alive",
                    "x-amz-user-agent": (
                        "aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown "
                        "api/sso-oidc#3.738.0 m/E KiroIDE"
                    ),
                    "Accept": "*/*",
                    "Accept-Language": "*",
                    "sec-fetch-mode": "cors",
                    "User-Agent": "node",
                    "Accept-Encoding": "br, gzip, deflate",
                }
                payload = {
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "refreshToken": refresh_token,
                    "grantType": "refresh_token",
                }
                resp = await client.post(url, json=payload, headers=headers, timeout=120.0)
                if resp.status_code >= 400:
                    body = resp.text[:2000]
                    context = f"auth_region={auth_region}, refresh_token_len={len(refresh_token)}"
                    account.need_refresh = True
                    raise ValueError(f"IdC token refresh failed: HTTP {resp.status_code} {body} ({context})")
                data = resp.json()
                if isinstance(data, dict):
                    new_token = _trimmed_str(data.get("accessToken") or data.get("access_token"))
                    new_refresh = _trimmed_str(data.get("refreshToken") or data.get("refresh_token")) or None
                    expires_in = data.get("expiresIn") if isinstance(data.get("expiresIn"), int) else None
            else:
                url = f"https://prod.{auth_region}.auth.desktop.kiro.dev/refreshToken"
                host = f"prod.{auth_region}.auth.desktop.kiro.dev"
                ide_version = self._get_kiro_ide_version()
                headers = {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    "User-Agent": f"KiroIDE-{ide_version}-{machineid}",
                    "Accept-Encoding": "gzip, compress, deflate, br",
                    "host": host,
                    "Connection": "close",
                }
                payload = {"refreshToken": refresh_token}
                resp = await client.post(url, json=payload, headers=headers, timeout=120.0)
                if resp.status_code >= 400:
                    body = resp.text[:2000]
                    context = f"auth_region={auth_region}, refresh_token_len={len(refresh_token)}"
                    account.need_refresh = True
                    raise ValueError(f"Social token refresh failed: HTTP {resp.status_code} {body} ({context})")
                data = resp.json()
                if isinstance(data, dict):
                    new_token = _trimmed_str(data.get("accessToken") or data.get("access_token"))
                    new_refresh = _trimmed_str(data.get("refreshToken") or data.get("refresh_token")) or None
                    new_profile_arn = _trimmed_str(data.get("profileArn") or data.get("profile_arn")) or None
                    expires_in = data.get("expiresIn") if isinstance(data.get("expiresIn"), int) else None

            if not new_token:
                account.need_refresh = True
                raise ValueError("token refresh returned empty accessToken")

            access_token = new_token
            if new_refresh:
                creds["refresh_token"] = new_refresh
            creds["access_token"] = access_token
            if new_profile_arn:
                creds["profile_arn"] = new_profile_arn
                profile_arn = new_profile_arn

            if expires_in and expires_in > 0:
                account.token_expires_at = now + timedelta(seconds=int(expires_in))
            else:
                account.token_expires_at = now + timedelta(hours=1)

            account.need_refresh = False
            account.region = auth_region
            account.credentials = encrypt_api_key(json.dumps(creds, ensure_ascii=False))
            await self.db.flush()

        return access_token, profile_arn

    def _kiro_api_base_urls(self, region: str) -> List[str]:
        # Prefer q.* (kiro.rs), fallback to codewhisperer.* (KiroGate)
        return [
            f"https://q.{region}.amazonaws.com",
            f"https://codewhisperer.{region}.amazonaws.com",
        ]

    def _build_kiro_headers(self, *, token: str, machineid: str) -> Dict[str, str]:
        ide_version = self._get_kiro_ide_version()
        mid = (machineid or "")[:32] or secrets.token_hex(16)
        user_agent = (
            "aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 "
            f"api/codewhispererstreaming#1.0.27 m/E KiroIDE-{ide_version}-{mid}"
        )
        amz_user_agent = f"aws-sdk-js/1.0.27 KiroIDE-{ide_version}-{mid}"

        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": user_agent,
            "x-amz-user-agent": amz_user_agent,
            "x-amzn-codewhisperer-optout": "true",
            "x-amzn-kiro-agent-mode": "vibe",
            "amz-sdk-invocation-id": str(uuid4()),
            "amz-sdk-request": "attempt=1; max=3",
            "Connection": "close",
        }

    async def _stream_generate_assistant_response_as_openai(
        self,
        *,
        client: httpx.AsyncClient,
        base_url: str,
        headers: Dict[str, str],
        payload: Dict[str, Any],
        model: str,
        raise_on_auth_error: bool = False,
    ) -> AsyncIterator[bytes]:
        from app.utils.token_counter import count_tokens as _count_tokens

        def _safe_json_dumps(obj: Any) -> str:
            try:
                return json.dumps(obj, ensure_ascii=False)
            except Exception:
                try:
                    return str(obj)
                except Exception:
                    return ""

        def _estimate_tool_context_tokens(ctx: Any) -> int:
            if not isinstance(ctx, dict):
                return 0

            total = 0

            tool_results = ctx.get("toolResults")
            if isinstance(tool_results, list):
                for tr in tool_results:
                    if not isinstance(tr, dict):
                        continue
                    content = tr.get("content")
                    if isinstance(content, str) and content:
                        total += _count_tokens(content)
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict):
                                text = block.get("text")
                                if isinstance(text, str) and text:
                                    total += _count_tokens(text)
                            elif isinstance(block, str) and block:
                                total += _count_tokens(block)

            tools = ctx.get("tools")
            if isinstance(tools, list):
                for tool in tools:
                    if not isinstance(tool, dict):
                        continue
                    spec = tool.get("toolSpecification")
                    if not isinstance(spec, dict):
                        continue
                    name = spec.get("name")
                    desc = spec.get("description")
                    if isinstance(name, str) and name:
                        total += _count_tokens(name)
                    if isinstance(desc, str) and desc:
                        total += _count_tokens(desc)
                    schema = None
                    input_schema = spec.get("inputSchema")
                    if isinstance(input_schema, dict):
                        schema = input_schema.get("json")
                    schema_str = _safe_json_dumps(schema) if schema is not None else ""
                    if schema_str:
                        total += _count_tokens(schema_str)

            return total

        def _estimate_prompt_tokens_from_conversation_state(state: Any) -> int:
            if not isinstance(state, dict):
                return 0

            total = 0

            history = state.get("history")
            if isinstance(history, list):
                for msg in history:
                    if not isinstance(msg, dict):
                        continue

                    uim = msg.get("userInputMessage")
                    if isinstance(uim, dict):
                        content = uim.get("content")
                        if isinstance(content, str) and content:
                            total += _count_tokens(content)
                        total += _estimate_tool_context_tokens(uim.get("userInputMessageContext"))
                        continue

                    arm = msg.get("assistantResponseMessage")
                    if isinstance(arm, dict):
                        content = arm.get("content")
                        if isinstance(content, str) and content:
                            total += _count_tokens(content)
                        tool_uses = arm.get("toolUses")
                        if isinstance(tool_uses, list):
                            for tu in tool_uses:
                                if not isinstance(tu, dict):
                                    continue
                                name = tu.get("name")
                                if isinstance(name, str) and name:
                                    total += _count_tokens(name)
                                input_obj = tu.get("input")
                                input_str = _safe_json_dumps(input_obj) if input_obj is not None else ""
                                if input_str:
                                    total += _count_tokens(input_str)

            current = state.get("currentMessage")
            if isinstance(current, dict):
                uim = current.get("userInputMessage")
                if isinstance(uim, dict):
                    content = uim.get("content")
                    if isinstance(content, str) and content:
                        total += _count_tokens(content)
                    total += _estimate_tool_context_tokens(uim.get("userInputMessageContext"))

            return max(0, int(total))

        def _estimate_openai_tool_calls_tokens(tool_calls: Any) -> int:
            if not isinstance(tool_calls, list):
                return 0
            total = 0
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                func = tc.get("function")
                if not isinstance(func, dict):
                    continue
                name = func.get("name")
                args = func.get("arguments")
                if isinstance(name, str) and name:
                    total += _count_tokens(name)
                if isinstance(args, str) and args:
                    total += _count_tokens(args)
            return max(0, int(total))

        completion_id = f"chatcmpl-{uuid4().hex[:24]}"
        created_time = int(time.time())
        first_chunk = True

        conversation_state = payload.get("conversationState") if isinstance(payload.get("conversationState"), dict) else {}
        prompt_tokens_estimate = _estimate_prompt_tokens_from_conversation_state(conversation_state)

        url = f"{base_url.rstrip('/')}/generateAssistantResponse"
        host = httpx.URL(url).host
        if host:
            headers = dict(headers)
            headers["Host"] = host

        async with client.stream("POST", url, headers=headers, json=payload, timeout=httpx.Timeout(1200.0, connect=60.0)) as resp:
            if resp.status_code >= 400:
                raw = await resp.aread()
                msg = raw.decode("utf-8", errors="replace")[:2000]
                # Enterprise CBOR→REST fallback: raise on 401/403 so caller can retry
                if raise_on_auth_error and resp.status_code in (401, 403):
                    raise UpstreamAPIError(
                        status_code=resp.status_code,
                        message=msg or "Kiro upstream auth error",
                    )
                yield _openai_sse_error(msg or "Kiro upstream error", code=resp.status_code)
                yield _openai_sse_done()
                return

            decoder = AwsEventStreamDecoder()
            content_parts: List[str] = []
            context_usage_percentage: Optional[float] = None
            finish_reason_override: Optional[str] = None

            tool_json_buffers: Dict[str, str] = {}
            tool_calls: List[Dict[str, Any]] = []

            async for chunk in resp.aiter_raw():
                if not chunk:
                    continue
                try:
                    decoder.feed(chunk)
                except AwsEventStreamParseError as e:
                    logger.warning("Kiro eventstream feed failed: %s", e)
                    continue

                for frame in decoder.decode_iter():
                    msg_type = (frame.message_type or "event").strip()

                    if msg_type == "event":
                        ev_type = (frame.event_type or "").strip()

                        if ev_type == "assistantResponseEvent":
                            try:
                                data = json.loads(frame.payload)
                            except Exception:
                                continue
                            if not isinstance(data, dict):
                                continue
                            text = data.get("content")
                            if not isinstance(text, str) or not text:
                                continue

                            content_parts.append(text)
                            delta: Dict[str, Any] = {"content": text}
                            if first_chunk:
                                delta["role"] = "assistant"
                                first_chunk = False
                            openai_chunk = {
                                "id": completion_id,
                                "object": "chat.completion.chunk",
                                "created": created_time,
                                "model": model,
                                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                            }
                            yield _openai_sse_data(openai_chunk)
                            continue

                        if ev_type == "contextUsageEvent":
                            try:
                                data = json.loads(frame.payload)
                            except Exception:
                                continue
                            if isinstance(data, dict):
                                value = data.get("contextUsagePercentage")
                                try:
                                    context_usage_percentage = float(value)  # type: ignore[arg-type]
                                except Exception:
                                    context_usage_percentage = context_usage_percentage
                            continue

                        if ev_type == "toolUseEvent":
                            try:
                                data = json.loads(frame.payload)
                            except Exception:
                                continue
                            if not isinstance(data, dict):
                                continue

                            name = data.get("name")
                            if not isinstance(name, str) or not name.strip():
                                continue

                            tool_use_id = data.get("toolUseId")
                            tool_id = (
                                tool_use_id.strip()
                                if isinstance(tool_use_id, str) and tool_use_id.strip()
                                else f"call_{uuid4().hex[:24]}"
                            )

                            input_data = data.get("input", "")
                            if isinstance(input_data, dict):
                                input_piece = json.dumps(input_data, ensure_ascii=False)
                            else:
                                input_piece = str(input_data) if input_data else ""
                            if input_piece:
                                tool_json_buffers[tool_id] = tool_json_buffers.get(tool_id, "") + input_piece

                            if data.get("stop"):
                                args_text = tool_json_buffers.get(tool_id, "")
                                normalized = "{}"
                                if isinstance(args_text, str) and args_text.strip():
                                    try:
                                        parsed = json.loads(args_text)
                                        if isinstance(parsed, (dict, list)):
                                            normalized = json.dumps(parsed, ensure_ascii=False)
                                    except Exception:
                                        normalized = "{}"

                                tc = {
                                    "id": tool_id,
                                    "type": "function",
                                    "function": {"name": name.strip(), "arguments": normalized},
                                }
                                idx = len(tool_calls)
                                tool_calls.append(tc)

                                delta: Dict[str, Any] = {"tool_calls": [dict(tc, index=idx)]}
                                if first_chunk:
                                    delta["role"] = "assistant"
                                    first_chunk = False

                                tool_calls_chunk = {
                                    "id": completion_id,
                                    "object": "chat.completion.chunk",
                                    "created": created_time,
                                    "model": model,
                                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                                }
                                yield _openai_sse_data(tool_calls_chunk)

                                tool_json_buffers.pop(tool_id, None)
                            continue

                        continue

                    if msg_type == "exception":
                        ex_type = (frame.exception_type or "").strip()
                        if ex_type == "ContentLengthExceededException":
                            finish_reason_override = "length"
                        continue

                    if msg_type == "error":
                        error_code = (frame.error_code or "UnknownError").strip() or "UnknownError"
                        error_message = frame.payload.decode("utf-8", errors="replace")
                        yield _openai_sse_error(f"{error_code}: {error_message[:2000]}", code=500)
                        yield _openai_sse_done()
                        return

            finish_reason = finish_reason_override or ("tool_calls" if tool_calls else "stop")
            full_content = "".join(content_parts)
            completion_tokens = int(_count_tokens(full_content)) + _estimate_openai_tool_calls_tokens(tool_calls)

            prompt_tokens = int(prompt_tokens_estimate)
            if context_usage_percentage is not None:
                try:
                    pct = float(context_usage_percentage)
                    # Align kiro.rs: contextUsagePercentage indicates prompt context usage percentage.
                    if pct > 0:
                        prompt_tokens = int(pct * 200000 / 100.0)
                except Exception:
                    prompt_tokens = prompt_tokens

            total_tokens = max(0, int(prompt_tokens + completion_tokens))

            final_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_time,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                "usage": {"prompt_tokens": int(prompt_tokens), "completion_tokens": int(completion_tokens), "total_tokens": int(total_tokens)},
            }
            if context_usage_percentage is not None:
                final_chunk["contextUsage"] = {"context_usage_percentage": context_usage_percentage}
            yield _openai_sse_data(final_chunk)
            yield _openai_sse_done()

    async def _get_allowed_model_ids_for_user(self, user_id: int) -> List[str]:
        # 默认放行：如果管理员没有配置订阅白名单，则返回全量支持列表
        allowed: set[str] = set()

        result = await self.db.execute(
            select(KiroAccount.subscription)
            .where(
                (KiroAccount.user_id == user_id)
                | ((KiroAccount.user_id.is_(None)) & (KiroAccount.is_shared == 1))
            )
            .where(KiroAccount.status == 1)
        )
        subs = {str(s).strip() for s in result.scalars().all() if isinstance(s, str) and s.strip()}

        for sub in subs:
            record = await self.db.get(KiroSubscriptionModel, sub)
            if record is None:
                continue
            parsed = _safe_json_load(record.allowed_model_ids)
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, str) and item.strip():
                        allowed.add(item.strip())

        if allowed:
            return [m for m in self.SUPPORTED_MODELS if m in allowed]

        return list(self.SUPPORTED_MODELS)

    async def get_models(self, user_id: int) -> Dict[str, Any]:
        """获取 Kiro 模型列表（后端本地生成；不依赖 plug-in）。"""
        model_ids = await self._get_allowed_model_ids_for_user(user_id)
        now_ts = int(time.time())
        return {
            "object": "list",
            "data": [{"id": mid, "object": "model", "created": now_ts, "owned_by": "kiro"} for mid in model_ids],
        }

    async def chat_completions(self, user_id: int, request_data: Dict[str, Any]) -> Dict[str, Any]:
        """Kiro 聊天补全（非流式）。内部走 stream 收集，保证行为一致。"""
        from app.services.anthropic_adapter import AnthropicAdapter

        openai_stream = self.chat_completions_stream(user_id=user_id, request_data=request_data)
        return await AnthropicAdapter.collect_openai_stream_to_response(openai_stream)

    async def chat_completions_stream(self, user_id: int, request_data: Dict[str, Any]) -> AsyncIterator[bytes]:
        """
        Kiro 聊天补全（OpenAI SSE）。

        - 不再代理 plug-in `/v1/kiro/chat/completions`
        - 直接使用 Backend DB 中的 Kiro accounts（refresh_token / client_id / client_secret）
        - 上游返回 AWS event stream（二进制），这里解析后转成 OpenAI `data: {...}\\n\\n`
        """
        if not isinstance(request_data, dict):
            yield _openai_sse_error("request_data must be a JSON object", code=400)
            yield _openai_sse_done()
            return

        requested_model = str(request_data.get("model") or "").strip() or "claude-sonnet-4-5"

        exclude: set[str] = set()
        attempts = 0

        proxy_url = self._get_kiro_proxy_url()
        client_kwargs: Dict[str, Any] = {
            "timeout": httpx.Timeout(1200.0, connect=60.0),
        }
        if proxy_url:
            client_kwargs["proxies"] = proxy_url

        async with httpx.AsyncClient(**client_kwargs) as client:
            while attempts < 3:
                attempts += 1
                accounts = await self._list_available_chat_accounts(user_id=user_id, exclude=exclude)
                if not accounts:
                    yield _openai_sse_error("没有可用的 Kiro 账号，请先导入账号", code=400)
                    yield _openai_sse_done()
                    return

                account = secrets.choice(list(accounts))
                exclude.add(account.account_id)

                try:
                    access_token, profile_arn = await self._ensure_valid_access_token(client=client, account=account)
                except Exception as e:
                    yield _openai_sse_error(str(e), code=400)
                    yield _openai_sse_done()
                    return

                creds = self._load_account_credentials(account)
                api_region = self._effective_api_region(account=account, creds=creds)
                machineid = _trimmed_str(account.machineid or creds.get("machineid")) or secrets.token_hex(32)
                account.machineid = machineid
                account.last_used_at = _now_utc()

                # Build Kiro payload
                try:
                    if "conversationState" in request_data and isinstance(request_data.get("conversationState"), dict):
                        conversation_state = request_data["conversationState"]
                        payload: Dict[str, Any] = {"conversationState": conversation_state}
                    else:
                        kiro_tools = self._convert_openai_tools_to_kiro_tools(request_data.get("tools"))
                        conversation_state = self._build_conversation_state_from_openai(
                            request_data=request_data,
                            tools=kiro_tools,
                        )
                        payload = {"conversationState": conversation_state}

                    if profile_arn:
                        payload["profileArn"] = profile_arn
                except Exception as e:
                    yield _openai_sse_error(f"构建 Kiro 请求失败: {e}", code=400)
                    yield _openai_sse_done()
                    return

                headers = self._build_kiro_headers(token=access_token, machineid=machineid)

                base_urls = self._kiro_api_base_urls(api_region)
                is_enterprise = _trimmed_str(creds.get("provider")).lower() == "enterprise"
                last_connect_error: Optional[str] = None
                for idx, base_url in enumerate(base_urls):
                    try:
                        # For Enterprise accounts, enable raise_on_auth_error on non-last
                        # URLs so that 401/403 from the CBOR endpoint (q.*) triggers a
                        # fallback to the REST endpoint (codewhisperer.*).
                        raise_flag = is_enterprise and idx < len(base_urls) - 1
                        async for chunk in self._stream_generate_assistant_response_as_openai(
                            client=client,
                            base_url=base_url,
                            headers=headers,
                            payload=payload,
                            model=requested_model,
                            raise_on_auth_error=raise_flag,
                        ):
                            yield chunk
                        await self.db.flush()
                        return
                    except UpstreamAPIError as e:
                        # Enterprise CBOR→REST fallback: 401/403 from CBOR, try next URL
                        logger.info(
                            "Enterprise CBOR→REST fallback: %s returned %s, trying next URL",
                            base_url, e.status_code,
                        )
                        last_connect_error = e.message
                        continue
                    except httpx.ConnectError as e:
                        last_connect_error = str(e)
                        continue
                    except httpx.HTTPError as e:
                        last_connect_error = str(e)
                        continue

                yield _openai_sse_error(last_connect_error or "Kiro upstream connect error", code=500)
                yield _openai_sse_done()
                return


class _KiroAwsEventStreamParser:
    """
    Best-effort parser for AWS event stream response body used by Kiro/Amazon Q Developer.

    Notes:
    - Upstream payload is a binary event stream; we decode as UTF-8 (ignore errors) and
      extract embedded JSON fragments by pattern matching.
    - This follows the same pragmatic approach used by community gateways (kiro.rs / KiroGate).
    """

    _PATTERN_TYPE_MAP = {
        '{"content":': "content",
        '{"name":': "tool_start",
        '{"input":': "tool_input",
        '{"stop":': "tool_stop",
        '{"followupPrompt":': "followup",
        '{"usage":': "usage",
        '{"contextUsagePercentage":': "context_usage",
    }

    _PATTERN_REGEX = re.compile(
        r'\{"(?:content|name|input|stop|followupPrompt|usage|contextUsagePercentage)":'
    )

    def __init__(self) -> None:
        self.buffer = ""
        self.last_content: Optional[str] = None
        self.current_tool_call: Optional[Dict[str, Any]] = None
        self.tool_calls: List[Dict[str, Any]] = []

    @staticmethod
    def _find_matching_brace(text: str, start_pos: int) -> int:
        if start_pos >= len(text) or text[start_pos] != "{":
            return -1

        brace_count = 0
        in_string = False
        escape_next = False

        for i in range(start_pos, len(text)):
            ch = text[i]

            if escape_next:
                escape_next = False
                continue

            if ch == "\\" and in_string:
                escape_next = True
                continue

            if ch == '"' and not escape_next:
                in_string = not in_string
                continue

            if not in_string:
                if ch == "{":
                    brace_count += 1
                elif ch == "}":
                    brace_count -= 1
                    if brace_count == 0:
                        return i

        return -1

    def feed(self, chunk: bytes) -> List[Dict[str, Any]]:
        try:
            self.buffer += chunk.decode("utf-8", errors="ignore")
        except Exception:
            return []

        events: List[Dict[str, Any]] = []

        while True:
            match = self._PATTERN_REGEX.search(self.buffer)
            if not match:
                break

            start = match.start()
            colon_pos = self.buffer.find(":", start)
            if colon_pos == -1:
                break

            prefix = self.buffer[start : colon_pos + 1]
            event_type = self._PATTERN_TYPE_MAP.get(prefix)
            if event_type is None:
                self.buffer = self.buffer[start + 1 :]
                continue

            json_end = self._find_matching_brace(self.buffer, start)
            if json_end == -1:
                break

            json_str = self.buffer[start : json_end + 1]
            self.buffer = self.buffer[json_end + 1 :]

            try:
                data = json.loads(json_str)
            except Exception:
                continue

            event = self._process_event(data, event_type)
            if event:
                events.append(event)

        # Prevent unbounded growth if upstream sends long binary chunks without a pattern hit.
        if len(self.buffer) > 200_000:
            self.buffer = self.buffer[-200_000:]

        return events

    def _process_event(self, data: Any, event_type: str) -> Optional[Dict[str, Any]]:
        if not isinstance(data, dict):
            return None

        if event_type == "content":
            content = data.get("content")
            if not isinstance(content, str) or not content:
                return None
            if data.get("followupPrompt"):
                return None
            if content == self.last_content:
                return None
            self.last_content = content
            return {"type": "content", "data": content}

        if event_type == "usage":
            return {"type": "usage", "data": data.get("usage")}

        if event_type == "context_usage":
            return {"type": "context_usage", "data": data.get("contextUsagePercentage")}

        if event_type == "tool_start":
            return self._process_tool_start(data)

        if event_type == "tool_input":
            return self._process_tool_input(data)

        if event_type == "tool_stop":
            return self._process_tool_stop(data)

        return None

    def _process_tool_start(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self.current_tool_call:
            self._finalize_tool_call()

        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            return None

        tool_use_id = data.get("toolUseId")
        tool_id = tool_use_id.strip() if isinstance(tool_use_id, str) and tool_use_id.strip() else f"call_{uuid4().hex[:24]}"

        input_data = data.get("input", "")
        if isinstance(input_data, dict):
            input_str = json.dumps(input_data, ensure_ascii=False)
        else:
            input_str = str(input_data) if input_data else ""

        self.current_tool_call = {
            "id": tool_id,
            "type": "function",
            "function": {"name": name.strip(), "arguments": input_str},
        }

        if data.get("stop"):
            self._finalize_tool_call()

        return None

    def _process_tool_input(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not self.current_tool_call:
            return None

        input_data = data.get("input", "")
        if isinstance(input_data, dict):
            input_str = json.dumps(input_data, ensure_ascii=False)
        else:
            input_str = str(input_data) if input_data else ""

        try:
            self.current_tool_call["function"]["arguments"] += input_str
        except Exception:
            pass
        return None

    def _process_tool_stop(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self.current_tool_call and data.get("stop"):
            self._finalize_tool_call()
        return None

    def _finalize_tool_call(self) -> None:
        if not self.current_tool_call:
            return

        func = self.current_tool_call.get("function") or {}
        raw_args = func.get("arguments")
        args_text = raw_args if isinstance(raw_args, str) else ""

        normalized = "{}"
        if isinstance(args_text, str) and args_text.strip():
            try:
                parsed = json.loads(args_text)
                if isinstance(parsed, (dict, list)):
                    normalized = json.dumps(parsed, ensure_ascii=False)
            except Exception:
                normalized = "{}"

        self.current_tool_call["function"]["arguments"] = normalized
        self.tool_calls.append(self.current_tool_call)
        self.current_tool_call = None

    def get_tool_calls(self) -> List[Dict[str, Any]]:
        if self.current_tool_call:
            self._finalize_tool_call()

        # Deduplicate by id (keep the one with longer args), then by (name,args)
        by_id: Dict[str, Dict[str, Any]] = {}
        without_id: List[Dict[str, Any]] = []
        for tc in self.tool_calls:
            tc_id = str(tc.get("id") or "").strip()
            if not tc_id:
                without_id.append(tc)
                continue
            existing = by_id.get(tc_id)
            if existing is None:
                by_id[tc_id] = tc
                continue
            existing_args = str((existing.get("function") or {}).get("arguments") or "")
            current_args = str((tc.get("function") or {}).get("arguments") or "")
            if len(current_args) > len(existing_args):
                by_id[tc_id] = tc

        candidates = list(by_id.values()) + without_id

        seen: set[str] = set()
        unique: List[Dict[str, Any]] = []
        for tc in candidates:
            func = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            name = str(func.get("name") or "")
            args = str(func.get("arguments") or "")
            key = f"{name}|{args}"
            if key in seen:
                continue
            seen.add(key)
            unique.append(tc)

        return unique
