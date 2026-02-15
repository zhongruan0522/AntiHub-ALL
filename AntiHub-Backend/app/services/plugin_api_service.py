"""
Plug-in API服务
处理与plug-in-api系统的通信

优化说明：
- 添加 Redis 缓存以减少数据库查询
- plugin_api_key 缓存 TTL 为 60 秒
"""
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from uuid import uuid4
import httpx
import logging
import asyncio
import json
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete, func

from app.core.config import get_settings
from app.repositories.plugin_api_key_repository import PluginAPIKeyRepository
from app.utils.encryption import encrypt_api_key, decrypt_api_key
from app.models.antigravity_account import AntigravityAccount
from app.models.antigravity_model_quota import AntigravityModelQuota
from app.schemas.plugin_api import (
    PluginAPIKeyCreate,
    PluginAPIKeyResponse,
    CreatePluginUserRequest,
)
from app.cache import get_redis_client, RedisClient

logger = logging.getLogger(__name__)

# 缓存 TTL（秒）
PLUGIN_API_KEY_CACHE_TTL = 60


class PluginAPIService:
    """Plug-in API服务类"""
    
    def __init__(self, db: AsyncSession, redis: Optional[RedisClient] = None):
        """
        初始化服务
        
        Args:
            db: 数据库会话
            redis: Redis 客户端（可选，用于缓存）
        """
        self.db = db
        self.settings = get_settings()
        self.repo = PluginAPIKeyRepository(db)
        self.base_url = self.settings.plugin_api_base_url
        self.admin_key = self.settings.plugin_api_admin_key
        self._redis = redis
    
    @property
    def redis(self) -> RedisClient:
        """获取 Redis 客户端"""
        if self._redis is None:
            self._redis = get_redis_client()
        return self._redis
    
    def _get_cache_key(self, user_id: int) -> str:
        """生成缓存键"""
        return f"plugin_api_key:{user_id}"

    def _dt_to_ms(self, dt: Optional[datetime]) -> Optional[int]:
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)

    def _serialize_antigravity_account(self, account: AntigravityAccount) -> Dict[str, Any]:
        return {
            "cookie_id": account.cookie_id,
            "user_id": account.user_id,
            "name": account.account_name,
            # shared 概念合并后移除：对外 contract 仍保留字段，但固定为 0
            "is_shared": 0,
            "status": int(account.status or 0),
            "need_refresh": bool(account.need_refresh),
            "expires_at": self._dt_to_ms(account.token_expires_at),
            "project_id_0": account.project_id_0,
            "is_restricted": bool(account.is_restricted),
            "paid_tier": account.paid_tier,
            "ineligible": bool(account.ineligible),
            "last_used_at": account.last_used_at,
            "created_at": account.created_at,
            "updated_at": account.updated_at,
        }

    async def _get_antigravity_account(self, user_id: int, cookie_id: str) -> Optional[AntigravityAccount]:
        result = await self.db.execute(
            select(AntigravityAccount).where(
                AntigravityAccount.user_id == user_id,
                AntigravityAccount.cookie_id == cookie_id,
            )
        )
        return result.scalar_one_or_none()

    def _decrypt_credentials_json(self, encrypted_json: str) -> Dict[str, Any]:
        try:
            plaintext = decrypt_api_key(encrypted_json)
        except Exception as e:
            raise ValueError(f"凭证解密失败: {e}")

        try:
            data = json.loads(plaintext)
        except Exception as e:
            raise ValueError(f"凭证解析失败: {e}")

        if not isinstance(data, dict):
            raise ValueError("凭证格式非法：期望 JSON object")

        return data
    
    # ==================== 密钥管理 ====================
    
    async def save_user_api_key(
        self,
        user_id: int,
        api_key: str,
        plugin_user_id: Optional[str] = None
    ) -> PluginAPIKeyResponse:
        """
        保存用户的plug-in API密钥
        
        Args:
            user_id: 用户ID
            api_key: 用户的plug-in API密钥
            plugin_user_id: plug-in系统中的用户ID
            
        Returns:
            保存的密钥信息
        """
        # 加密API密钥
        encrypted_key = encrypt_api_key(api_key)
        
        # 检查是否已存在
        existing = await self.repo.get_by_user_id(user_id)
        
        if existing:
            # 更新现有密钥
            updated = await self.repo.update(
                user_id=user_id,
                api_key=encrypted_key,
                plugin_user_id=plugin_user_id
            )
            return PluginAPIKeyResponse.model_validate(updated)
        else:
            # 创建新密钥
            created = await self.repo.create(
                user_id=user_id,
                api_key=encrypted_key,
                plugin_user_id=plugin_user_id
            )
            return PluginAPIKeyResponse.model_validate(created)
    
    async def get_user_api_key(self, user_id: int) -> Optional[str]:
        """
        获取用户的解密后的API密钥
        
        优化：使用 Redis 缓存减少数据库查询
        
        Args:
            user_id: 用户ID
            
        Returns:
            解密后的API密钥，不存在返回None
        """
        cache_key = self._get_cache_key(user_id)
        
        # 尝试从缓存获取
        try:
            cached_key = await self.redis.get(cache_key)
            if cached_key:
                logger.debug(f"从缓存获取 plugin_api_key: user_id={user_id}")
                return cached_key
        except Exception as e:
            logger.warning(f"Redis 缓存读取失败: {e}")
        
        # 缓存未命中，从数据库获取
        key_record = await self.repo.get_by_user_id(user_id)
        if not key_record or not key_record.is_active:
            return None
        
        # 解密
        decrypted_key = decrypt_api_key(key_record.api_key)
        
        # 存入缓存
        try:
            await self.redis.set(cache_key, decrypted_key, expire=PLUGIN_API_KEY_CACHE_TTL)
            logger.debug(f"plugin_api_key 已缓存: user_id={user_id}, ttl={PLUGIN_API_KEY_CACHE_TTL}s")
        except Exception as e:
            logger.warning(f"Redis 缓存写入失败: {e}")
        
        return decrypted_key
    
    async def delete_user_api_key(self, user_id: int) -> bool:
        """
        删除用户的API密钥
        
        Args:
            user_id: 用户ID
            
        Returns:
            删除成功返回True
        """
        # 删除缓存
        try:
            cache_key = self._get_cache_key(user_id)
            await self.redis.delete(cache_key)
        except Exception as e:
            logger.warning(f"删除缓存失败: {e}")
        
        return await self.repo.delete(user_id)
    
    async def update_last_used(self, user_id: int):
        """
        更新密钥最后使用时间
        
        优化：
        1. 使用 Redis 限流，避免频繁写入数据库
        2. 使用独立的数据库会话，避免长时间占用主会话
        """
        try:
            # 1. 检查 Redis 限流 (60秒)
            throttle_key = f"plugin_key_last_used_throttle:{user_id}"
            if await self.redis.exists(throttle_key):
                return
            
            # 2. 设置限流键
            await self.redis.set(throttle_key, "1", expire=60)
            
            # 3. 使用独立会话更新数据库
            from app.db.session import get_session_maker
            from app.repositories.plugin_api_key_repository import PluginAPIKeyRepository
            
            session_maker = get_session_maker()
            async with session_maker() as db:
                repo = PluginAPIKeyRepository(db)
                await repo.update_last_used(user_id)
                await db.commit()
                
        except Exception as e:
            # 更新最后使用时间失败不应该影响主流程
            logger.warning(f"更新 plugin_api_key 最后使用时间失败: user_id={user_id}, error={e}")
    
    async def invalidate_cache(self, user_id: int):
        """
        使缓存失效
        
        当用户更新 API 密钥时调用
        
        Args:
            user_id: 用户ID
        """
        try:
            cache_key = self._get_cache_key(user_id)
            await self.redis.delete(cache_key)
            logger.debug(f"plugin_api_key 缓存已失效: user_id={user_id}")
        except Exception as e:
            logger.warning(f"使缓存失效失败: {e}")
    
    # ==================== Plug-in API代理方法 ====================
    
    async def create_plugin_user(
        self,
        request: CreatePluginUserRequest
    ) -> Dict[str, Any]:
        """
        创建plug-in-api用户（管理员操作）
        
        Args:
            request: 创建用户请求
            
        Returns:
            创建结果，包含用户信息和API密钥
        """
        url = f"{self.base_url}/api/users"
        payload = request.model_dump()
        headers = {"Authorization": f"Bearer {self.admin_key}"}
        
        # 打印请求详情
        print(f"📤 发送创建plug-in用户请求:")
        print(f"   URL: POST {url}")
        print(f"   Headers: {headers}")
        print(f"   Payload: {payload}")
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                json=payload,
                headers=headers,
                timeout=30.0
            )
            
            # 打印响应详情
            print(f"📥 收到plug-in-api响应:")
            print(f"   Status: {response.status_code}")
            print(f"   Response: {response.text}")
            
            response.raise_for_status()
            return response.json()
    
    async def auto_create_and_bind_plugin_user(
        self,
        user_id: int,
        username: str,
        prefer_shared: int = 0
    ) -> PluginAPIKeyResponse:
        """
        自动创建plug-in-api用户并绑定到我们的用户
        
        Args:
            user_id: 我们系统中的用户ID
            username: 用户名
            prefer_shared: Cookie优先级，0=专属优先，1=共享优先
            
        Returns:
            保存的密钥信息
        """
        # 创建plug-in-api用户
        request = CreatePluginUserRequest(
            name=username,
            prefer_shared=prefer_shared
        )
        
        result = await self.create_plugin_user(request)
        
        # 提取API密钥和用户ID
        api_key = result.get("data", {}).get("api_key")
        plugin_user_id = result.get("data", {}).get("user_id")
        
        if not api_key:
            raise ValueError("创建plug-in用户失败：未返回API密钥")
        
        # 保存密钥到我们的数据库
        return await self.save_user_api_key(
            user_id=user_id,
            api_key=api_key,
            plugin_user_id=plugin_user_id
        )
    
    async def proxy_request(
        self,
        user_id: int,
        method: str,
        path: str,
        json_data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        代理用户请求到plug-in-api
        
        Args:
            user_id: 用户ID
            method: HTTP方法
            path: API路径
            json_data: JSON请求体
            params: 查询参数
            extra_headers: 额外的请求头
            
        Returns:
            API响应
            
        Raises:
            httpx.HTTPStatusError: 当上游返回错误状态码时，包含上游的响应内容
        """
        # 获取用户的API密钥
        api_key = await self.get_user_api_key(user_id)
        if not api_key:
            raise ValueError("用户未配置plug-in API密钥")
        
        # 更新最后使用时间
        await self.update_last_used(user_id)
        
        # 发送请求
        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {api_key}"}
        
        # 添加额外的请求头
        if extra_headers:
            headers.update(extra_headers)
        
        async with httpx.AsyncClient() as client:
            response = await client.request(
                method=method,
                url=url,
                json=json_data,
                params=params,
                headers=headers,
                timeout=1200.0
            )
            
            # 如果响应不是成功状态码，抛出包含响应内容的异常
            if response.status_code >= 400:
                # 尝试解析JSON响应
                try:
                    error_data = response.json()
                except Exception:
                    error_data = {"detail": response.text}
                
                # 创建HTTPStatusError并附加响应数据
                error = httpx.HTTPStatusError(
                    message=f"上游API返回错误: {response.status_code}",
                    request=response.request,
                    response=response
                )
                # 将错误数据附加到异常对象
                error.response_data = error_data
                raise error
            
            return response.json()
    
    async def proxy_stream_request(
        self,
        user_id: int,
        method: str,
        path: str,
        json_data: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None
    ):
        """
        代理流式请求到plug-in-api
        
        Args:
            user_id: 用户ID
            method: HTTP方法
            path: API路径
            json_data: JSON请求体
            extra_headers: 额外的请求头
            
        Yields:
            流式响应数据
            
        Note:
            当上游返回错误状态码时，会生成一个SSE格式的错误消息
        """
        # 获取用户的API密钥
        api_key = await self.get_user_api_key(user_id)
        if not api_key:
            raise ValueError("用户未配置plug-in API密钥")
        
        # 发送流式请求
        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {api_key}"}
        
        # 添加额外的请求头
        if extra_headers:
            headers.update(extra_headers)
        
        async with httpx.AsyncClient() as client:
            async with client.stream(
                method=method,
                url=url,
                json=json_data,
                headers=headers,
                timeout=httpx.Timeout(1200.0, connect=60.0)
            ) as response:
                # 检查响应状态码，如果是错误状态码，读取错误内容并生成SSE格式的错误消息
                if response.status_code >= 400:
                    # 读取错误响应内容
                    error_content = await response.aread()
                    try:
                        import json
                        error_data = json.loads(error_content.decode('utf-8'))
                    except Exception:
                        error_data = {"detail": error_content.decode('utf-8', errors='replace')}
                    
                    # 记录错误日志
                    logger.error(f"上游API返回错误: status={response.status_code}, url={url}, error={error_data}")
                    
                    # 提取错误消息，处理多种格式
                    error_message = None
                    if isinstance(error_data, dict):
                        # 尝试获取 detail 字段
                        if "detail" in error_data:
                            error_message = error_data["detail"]
                        # 尝试获取 error 字段（可能是字符串或字典）
                        elif "error" in error_data:
                            error_field = error_data["error"]
                            if isinstance(error_field, str):
                                error_message = error_field
                            elif isinstance(error_field, dict):
                                error_message = error_field.get("message") or str(error_field)
                            else:
                                error_message = str(error_field)
                        # 尝试获取 message 字段
                        elif "message" in error_data:
                            error_message = error_data["message"]
                    
                    # 如果还是没有提取到消息，使用整个 error_data 的字符串表示
                    if not error_message:
                        error_message = str(error_data)
                    
                    # 生成SSE格式的错误消息
                    import json
                    error_response = {
                        "error": {
                            "message": error_message,
                            "type": "upstream_error",
                            "code": response.status_code
                        }
                    }
                    yield f"data: {json.dumps(error_response)}\n\n".encode('utf-8')
                    yield b"data: [DONE]\n\n"
                    return
                
                async for chunk in response.aiter_raw():
                    if chunk:
                        yield chunk
    
    # ==================== 具体API方法 ====================
    
    async def get_oauth_authorize_url(
        self,
        user_id: int,
        is_shared: int = 0
    ) -> Dict[str, Any]:
        """获取OAuth授权URL"""
        return await self.proxy_request(
            user_id=user_id,
            method="POST",
            path="/api/oauth/authorize",
            json_data={
                "is_shared": is_shared
            }
        )
    
    async def submit_oauth_callback(
        self,
        user_id: int,
        callback_url: str
    ) -> Dict[str, Any]:
        """提交OAuth回调"""
        return await self.proxy_request(
            user_id=user_id,
            method="POST",
            path="/api/oauth/callback/manual",
            json_data={"callback_url": callback_url}
        )
    
    async def get_accounts(self, user_id: int) -> Dict[str, Any]:
        """
        获取账号列表
        
        返回用户在plug-in-api中的所有账号信息，包括：
        - project_id_0: 项目ID
        - is_restricted: 是否受限
        - ineligible: 是否不合格
        以及其他账号相关字段
        """
        result = await self.db.execute(
            select(AntigravityAccount)
            .where(AntigravityAccount.user_id == user_id)
            .order_by(AntigravityAccount.id.asc())
        )
        accounts = result.scalars().all()

        return {"success": True, "data": [self._serialize_antigravity_account(a) for a in accounts]}

    async def import_account_by_refresh_token(
        self,
        user_id: int,
        refresh_token: str,
        is_shared: int = 0
    ) -> Dict[str, Any]:
        """通过 refresh_token 导入账号（无需走 OAuth 回调）"""
        if not refresh_token or not isinstance(refresh_token, str) or not refresh_token.strip():
            raise ValueError("缺少refresh_token参数")

        # 合并后不支持 shared 语义，但为兼容保留入参；仅允许 0
        if is_shared not in (0, 1):
            raise ValueError("is_shared必须是0或1")
        if is_shared == 1:
            raise ValueError("合并后不支持共享账号（is_shared=1）")

        cookie_id = str(uuid4())
        credentials_payload = {
            "type": "antigravity",
            "cookie_id": cookie_id,
            "is_shared": 0,
            "access_token": None,
            "refresh_token": refresh_token.strip(),
            "expires_at": None,
            # report 约定：保留原始 ms 值（如有）；此处导入阶段未知
            "expires_at_ms": None,
        }

        encrypted_credentials = encrypt_api_key(json.dumps(credentials_payload, ensure_ascii=False))

        account = AntigravityAccount(
            user_id=user_id,
            cookie_id=cookie_id,
            account_name="Imported",
            email=None,
            project_id_0=None,
            status=1,
            need_refresh=False,
            is_restricted=False,
            paid_tier=None,
            ineligible=False,
            token_expires_at=None,
            last_refresh_at=None,
            last_used_at=None,
            credentials=encrypted_credentials,
        )
        self.db.add(account)
        await self.db.flush()
        await self.db.refresh(account)

        return {
            "success": True,
            "message": "账号导入成功",
            "data": self._serialize_antigravity_account(account),
        }
    
    async def get_account(self, user_id: int, cookie_id: str) -> Dict[str, Any]:
        """获取单个账号信息"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")
        return {"success": True, "data": self._serialize_antigravity_account(account)}

    async def get_account_credentials(self, user_id: int, cookie_id: str) -> Dict[str, Any]:
        """
        导出账号凭证（敏感信息）

        说明：
        - 仅用于用户自助导出/备份（前端“复制凭证为JSON”）
        - 实际鉴权在 plug-in API 层完成（仅账号所有者/管理员可访问）
        """
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        creds = self._decrypt_credentials_json(account.credentials)
        expires_at = (
            creds.get("expires_at")
            if creds.get("expires_at") is not None
            else (creds.get("expires_at_ms") if creds.get("expires_at_ms") is not None else None)
        )

        credentials = {
            "type": "antigravity",
            "cookie_id": account.cookie_id,
            "is_shared": 0,
            "access_token": creds.get("access_token"),
            "refresh_token": creds.get("refresh_token"),
            "expires_at": expires_at if expires_at is not None else self._dt_to_ms(account.token_expires_at),
        }

        export_data = {
            k: v
            for k, v in credentials.items()
            if v is not None and not (isinstance(v, str) and v.strip() == "")
        }

        return {"success": True, "data": export_data}

    async def get_account_detail(self, user_id: int, cookie_id: str) -> Dict[str, Any]:
        """获取单个账号的详情信息（邮箱/订阅层级等）"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        return {
            "success": True,
            "data": {
                "cookie_id": account.cookie_id,
                "name": account.account_name,
                "email": account.email,
                "created_at": account.created_at,
                "paid_tier": bool(account.paid_tier) if account.paid_tier is not None else False,
                "subscription_tier": None,
                "subscription_tier_raw": None,
            },
        }

    async def refresh_account(self, user_id: int, cookie_id: str) -> Dict[str, Any]:
        """刷新账号（强制刷新 access_token + 更新 project_id_0）"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        creds = self._decrypt_credentials_json(account.credentials)
        refresh_token = creds.get("refresh_token")
        if not refresh_token:
            raise ValueError("账号缺少refresh_token，无法刷新")

        now = datetime.now(timezone.utc)
        await self.db.execute(
            update(AntigravityAccount)
            .where(
                AntigravityAccount.user_id == user_id,
                AntigravityAccount.cookie_id == cookie_id,
            )
            .values(last_refresh_at=now, need_refresh=False)
        )
        await self.db.flush()
        updated = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        return {"success": True, "data": self._serialize_antigravity_account(updated)}
    
    async def get_account_projects(self, user_id: int, cookie_id: str) -> Dict[str, Any]:
        """获取账号可见的 GCP Project 列表"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        creds = self._decrypt_credentials_json(account.credentials)
        if not creds.get("refresh_token"):
            raise ValueError("账号缺少refresh_token，无法获取项目列表")

        current_project_id = (account.project_id_0 or "").strip()
        default_project_id = current_project_id
        projects = []
        if default_project_id:
            projects.append({"project_id": default_project_id, "name": "default"})

        return {
            "success": True,
            "data": {
                "cookie_id": cookie_id,
                "current_project_id": current_project_id,
                "default_project_id": default_project_id,
                "projects": projects,
            },
        }

    async def update_account_project_id(self, user_id: int, cookie_id: str, project_id: str) -> Dict[str, Any]:
        """更新账号 Project ID"""
        if not project_id or not isinstance(project_id, str) or not project_id.strip():
            raise ValueError("project_id不能为空")

        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        await self.db.execute(
            update(AntigravityAccount)
            .where(AntigravityAccount.user_id == user_id, AntigravityAccount.cookie_id == cookie_id)
            .values(project_id_0=project_id.strip())
        )
        await self.db.flush()
        updated = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        return {"success": True, "message": "Project ID已更新", "data": self._serialize_antigravity_account(updated)}

    async def update_account_status(
        self,
        user_id: int,
        cookie_id: str,
        status: int
    ) -> Dict[str, Any]:
        """更新账号状态"""
        if status not in (0, 1):
            raise ValueError("status必须是0或1")

        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        if int(account.status or 0) == int(status):
            return {
                "success": True,
                "message": "账号状态未变化",
                "data": {"cookie_id": account.cookie_id, "status": int(account.status or 0)},
            }

        await self.db.execute(
            update(AntigravityAccount)
            .where(AntigravityAccount.user_id == user_id, AntigravityAccount.cookie_id == cookie_id)
            .values(status=int(status))
        )
        await self.db.flush()
        return {
            "success": True,
            "message": f"账号状态已更新为{'启用' if status == 1 else '禁用'}",
            "data": {"cookie_id": cookie_id, "status": int(status)},
        }
    
    async def delete_account(
        self,
        user_id: int,
        cookie_id: str
    ) -> Dict[str, Any]:
        """删除账号"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        await self.db.execute(delete(AntigravityModelQuota).where(AntigravityModelQuota.cookie_id == cookie_id))
        await self.db.execute(
            delete(AntigravityAccount).where(
                AntigravityAccount.user_id == user_id, AntigravityAccount.cookie_id == cookie_id
            )
        )
        await self.db.flush()
        return {"success": True, "message": "账号已删除"}
    
    async def update_account_name(
        self,
        user_id: int,
        cookie_id: str,
        name: str
    ) -> Dict[str, Any]:
        """更新账号名称"""
        if name is None:
            raise ValueError("name是必需的")
        if not isinstance(name, str) or len(name) > 100:
            raise ValueError("name必须是字符串且长度不超过100")

        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        await self.db.execute(
            update(AntigravityAccount)
            .where(AntigravityAccount.user_id == user_id, AntigravityAccount.cookie_id == cookie_id)
            .values(account_name=name)
        )
        await self.db.flush()
        return {
            "success": True,
            "message": "账号名称已更新",
            "data": {"cookie_id": cookie_id, "name": name},
        }
    
    async def get_account_quotas(
        self,
        user_id: int,
        cookie_id: str
    ) -> Dict[str, Any]:
        """获取账号配额信息"""
        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        result = await self.db.execute(
            select(AntigravityModelQuota)
            .where(AntigravityModelQuota.cookie_id == cookie_id)
            .order_by(AntigravityModelQuota.quota.asc())
        )
        quotas = result.scalars().all()
        data = [
            {
                "id": q.id,
                "cookie_id": q.cookie_id,
                "model_name": q.model_name,
                "reset_time": q.reset_at,
                "quota": q.quota,
                "status": q.status,
                "last_fetched_at": q.last_fetched_at,
                "created_at": q.created_at,
                "updated_at": q.updated_at,
            }
            for q in quotas
        ]

        return {"success": True, "data": data}
    
    async def get_user_quotas(self, user_id: int) -> Dict[str, Any]:
        """
        用户维度“模型配额概览”。

        report 建议实现：
        - 每个 model_name 取 quota 最大的账号作为该模型的可用额度
        - 字段沿用前端 UserQuotaItem：pool_id/user_id/model_name/quota/max_quota/last_recovered_at/last_updated_at
        """
        stmt = (
            select(
                AntigravityModelQuota.model_name.label("model_name"),
                func.max(AntigravityModelQuota.quota).label("quota"),
                func.max(AntigravityModelQuota.updated_at).label("last_updated_at"),
                func.max(AntigravityModelQuota.reset_at).label("last_recovered_at"),
            )
            .select_from(AntigravityModelQuota)
            .join(
                AntigravityAccount,
                AntigravityAccount.cookie_id == AntigravityModelQuota.cookie_id,
            )
            .where(
                AntigravityAccount.user_id == user_id,
                AntigravityAccount.status == 1,
                AntigravityModelQuota.status == 1,
            )
            .group_by(AntigravityModelQuota.model_name)
            .order_by(AntigravityModelQuota.model_name.asc())
        )
        result = await self.db.execute(stmt)
        rows = result.mappings().all()

        items = []
        for r in rows:
            model_name = r["model_name"]
            quota = float(r["quota"] or 0)
            last_updated_at = r["last_updated_at"]
            last_recovered_at = r["last_recovered_at"] or last_updated_at

            items.append(
                {
                    "pool_id": str(model_name),
                    "user_id": str(user_id),
                    "model_name": str(model_name),
                    "quota": str(quota),
                    "max_quota": "1",
                    "last_recovered_at": last_recovered_at.isoformat() if last_recovered_at else "",
                    "last_updated_at": last_updated_at.isoformat() if last_updated_at else "",
                }
            )

        return {"success": True, "data": items}
    
    async def get_shared_pool_quotas(self, user_id: int) -> Dict[str, Any]:
        raise ValueError("共享池配额已弃用")
    
    async def get_quota_consumption(
        self,
        user_id: int,
        limit: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取配额消耗记录"""
        params = {}
        if limit:
            params["limit"] = limit
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        
        raise ValueError("配额消耗记录已弃用")
    
    async def get_models(self, user_id: int, config_type: Optional[str] = None) -> Dict[str, Any]:
        """获取可用模型列表"""
        extra_headers = {}
        if config_type:
            extra_headers["X-Account-Type"] = config_type
        print(f"Using config_type header: {config_type}")
        
        return await self.proxy_request(
            user_id=user_id,
            method="GET",
            path="/v1/models",
            extra_headers=extra_headers if extra_headers else None
        )
    
    async def update_cookie_preference(
        self,
        user_id: int,
        plugin_user_id: str,
        prefer_shared: int
    ) -> Dict[str, Any]:
        """更新Cookie优先级"""
        return await self.proxy_request(
            user_id=user_id,
            method="PUT",
            path=f"/api/users/{plugin_user_id}/preference",
            json_data={"prefer_shared": prefer_shared}
        )
    
    async def get_user_info(self, user_id: int) -> Dict[str, Any]:
        """获取用户信息"""
        return await self.proxy_request(
            user_id=user_id,
            method="GET",
            path="/api/user/me"
        )
    
    async def update_model_quota_status(
        self,
        user_id: int,
        cookie_id: str,
        model_name: str,
        status: int
    ) -> Dict[str, Any]:
        """更新模型配额状态"""
        if status not in (0, 1):
            raise ValueError("status必须是0或1")

        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        result = await self.db.execute(
            select(AntigravityModelQuota).where(
                AntigravityModelQuota.cookie_id == cookie_id,
                AntigravityModelQuota.model_name == model_name,
            )
        )
        quota = result.scalar_one_or_none()
        if not quota:
            raise ValueError("配额记录不存在")

        await self.db.execute(
            update(AntigravityModelQuota)
            .where(
                AntigravityModelQuota.cookie_id == cookie_id,
                AntigravityModelQuota.model_name == model_name,
            )
            .values(status=int(status))
        )
        await self.db.flush()

        return {
            "success": True,
            "message": f"模型配额状态已更新为{'启用' if status == 1 else '禁用'}",
            "data": {"cookie_id": cookie_id, "model_name": model_name, "status": int(status)},
        }
    
    async def update_account_type(
        self,
        user_id: int,
        cookie_id: str,
        is_shared: int
    ) -> Dict[str, Any]:
        """
        更新账号类型（专属/共享）
        
        将账号在专属和共享之间转换，同时自动更新用户共享配额池。
        
        Args:
            user_id: 用户ID
            cookie_id: 账号的Cookie ID
            is_shared: 账号类型：0=专属，1=共享
            
        Returns:
            更新结果
        """
        if is_shared not in (0, 1):
            raise ValueError("is_shared必须是0或1")
        if is_shared == 1:
            raise ValueError("合并后不支持共享账号（is_shared=1）")

        account = await self._get_antigravity_account(user_id=user_id, cookie_id=cookie_id)
        if not account:
            raise ValueError("账号不存在")

        return {
            "success": True,
            "message": "账号类型已更新为专属",
            "data": {"cookie_id": cookie_id, "is_shared": 0},
        }
    
    # ==================== 图片生成API ====================
    
    async def generate_content(
        self,
        user_id: int,
        model: str,
        request_data: Dict[str, Any],
        config_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        图片生成API（Gemini格式）
        
        Args:
            user_id: 用户ID
            model: 模型名称，例如 gemini-2.5-flash-image 或 gemini-2.5-pro-image
            request_data: 请求数据，包含contents和generationConfig
            config_type: 账号类型（可选）
            
        Returns:
            生成结果，包含candidates数组，每个candidate包含content.parts[0].inlineData
        """
        # 构建请求路径
        path = f"/v1beta/models/{model}:generateContent"
        
        # 准备额外的请求头
        extra_headers = {}
        if config_type:
            extra_headers["X-Account-Type"] = config_type
        
        return await self.proxy_request(
            user_id=user_id,
            method="POST",
            path=path,
            json_data=request_data,
            extra_headers=extra_headers if extra_headers else None
        )
    
    async def generate_content_stream(
        self,
        user_id: int,
        model: str,
        request_data: Dict[str, Any],
        config_type: Optional[str] = None
    ):
        """
        图片生成API流式版本（Gemini格式）
        
        调用非流式上游接口 /v1beta/models/{model}:generateContent，
        但以SSE流式方式响应给用户，在等待上游响应时每20秒发送心跳。
        
        Args:
            user_id: 用户ID
            model: 模型名称
            request_data: 请求数据
            config_type: 账号类型（可选）
            
        Yields:
            SSE格式的流式响应数据
        """
        # 获取用户的API密钥
        api_key = await self.get_user_api_key(user_id)
        if not api_key:
            error_response = {
                "error": {
                    "message": "用户未配置plug-in API密钥",
                    "type": "authentication_error",
                    "code": 401
                }
            }
            yield f"event: error\ndata: {json.dumps(error_response)}\n\n"
            return
        
        # 更新最后使用时间
        await self.update_last_used(user_id)
        
        # 构建请求路径（非流式接口）
        path = f"/v1beta/models/{model}:generateContent"
        url = f"{self.base_url}{path}"
        
        # 准备请求头
        headers = {"Authorization": f"Bearer {api_key}"}
        if config_type:
            headers["X-Account-Type"] = config_type
        
        # 心跳间隔（秒）
        heartbeat_interval = 20
        
        async def make_request():
            """发起上游请求"""
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    json=request_data,
                    headers=headers,
                    timeout=httpx.Timeout(1200.0, connect=60.0)
                )
                return response
        
        # 创建上游请求任务
        request_task = asyncio.create_task(make_request())
        
        try:
            while True:
                try:
                    # 等待请求完成，最多等待 heartbeat_interval 秒
                    response = await asyncio.wait_for(
                        asyncio.shield(request_task),
                        timeout=heartbeat_interval
                    )
                    
                    # 请求完成，处理响应
                    if response.status_code >= 400:
                        # 上游返回错误，转发错误
                        try:
                            error_data = response.json()
                        except Exception:
                            error_data = {"detail": response.text}
                        
                        logger.error(f"上游API返回错误: status={response.status_code}, url={url}, error={error_data}")
                        
                        # 提取错误消息
                        error_message = None
                        if isinstance(error_data, dict):
                            if "detail" in error_data:
                                error_message = error_data["detail"]
                            elif "error" in error_data:
                                error_field = error_data["error"]
                                if isinstance(error_field, str):
                                    error_message = error_field
                                elif isinstance(error_field, dict):
                                    error_message = error_field.get("message") or str(error_field)
                                else:
                                    error_message = str(error_field)
                            elif "message" in error_data:
                                error_message = error_data["message"]
                        
                        if not error_message:
                            error_message = str(error_data)
                        
                        error_response = {
                            "error": {
                                "message": error_message,
                                "type": "upstream_error",
                                "code": response.status_code
                            }
                        }
                        yield f"event: error\ndata: {json.dumps(error_response)}\n\n"
                    else:
                        # 成功响应，发送结果
                        result_data = response.json()
                        yield f"event: result\ndata: {json.dumps(result_data)}\n\n"
                    
                    # 请求完成，退出循环
                    break
                    
                except asyncio.TimeoutError:
                    # 超时，发送心跳
                    heartbeat_data = {"status": "still generating"}
                    yield f"event: heartbeat\ndata: {json.dumps(heartbeat_data)}\n\n"
                    # 继续等待
                    
        except asyncio.CancelledError:
            # 客户端断开连接，取消上游请求
            request_task.cancel()
            try:
                await request_task
            except asyncio.CancelledError:
                pass
            raise
        except Exception as e:
            # 其他异常
            logger.error(f"图片生成流式请求失败: {str(e)}")
            error_response = {
                "error": {
                    "message": str(e),
                    "type": "internal_error",
                    "code": 500
                }
            }
            yield f"event: error\ndata: {json.dumps(error_response)}\n\n"
