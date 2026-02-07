"""
Kiro账号服务
通过插件API管理Kiro账号，不直接操作数据库
所有Kiro账号数据存储在插件API系统中

优化说明：
- 添加 Redis 缓存以减少数据库查询
- plugin_api_key 缓存 TTL 为 60 秒
"""
from typing import Optional, Dict, Any, List
import httpx
import logging
import json
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.repositories.plugin_api_key_repository import PluginAPIKeyRepository
from app.utils.encryption import decrypt_api_key
from app.cache import get_redis_client, RedisClient

logger = logging.getLogger(__name__)

# 缓存 TTL（秒）
PLUGIN_API_KEY_CACHE_TTL = 60


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
        if "detail" in self.upstream_response:
            return self.upstream_response["detail"]
        
        return self.message


class KiroService:
    """Kiro账号服务类- 通过插件API管理"""
    
    # 支持的Kiro模型列表
    SUPPORTED_MODELS = [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
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
        self.plugin_api_key_repo = PluginAPIKeyRepository(db)
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
    
    async def _get_user_plugin_key(self, user_id: int) -> str:
        """
        获取用户的插件API密钥
        
        优化：使用 Redis 缓存减少数据库查询
        
        Args:
            user_id: 用户ID
            
        Returns:
            解密后的插件API密钥
        """
        cache_key = self._get_cache_key(user_id)
        
        # 尝试从缓存获取
        try:
            cached_key = await self.redis.get(cache_key)
            if cached_key:
                logger.debug(f"从缓存获取 plugin_api_key (kiro): user_id={user_id}")
                return cached_key
        except Exception as e:
            logger.warning(f"Redis 缓存读取失败: {e}")
        
        # 缓存未命中，从数据库获取
        key_record = await self.plugin_api_key_repo.get_by_user_id(user_id)
        if not key_record or not key_record.is_active:
            raise ValueError("用户未配置插件API密钥")
        
        # 解密
        decrypted_key = decrypt_api_key(key_record.api_key)
        
        # 存入缓存
        try:
            await self.redis.set(cache_key, decrypted_key, expire=PLUGIN_API_KEY_CACHE_TTL)
            logger.debug(f"plugin_api_key 已缓存 (kiro): user_id={user_id}, ttl={PLUGIN_API_KEY_CACHE_TTL}s")
        except Exception as e:
            logger.warning(f"Redis 缓存写入失败: {e}")
        
        return decrypted_key
    
    async def _proxy_request(
        self,
        user_id: int,
        method: str,
        path: str,
        json_data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        代理请求到插件API的Kiro端点
        
        Args:
            user_id: 用户ID
            method: HTTP方法
            path: API路径
            json_data: JSON数据
            params: 查询参数
            
        Returns:
            API响应
            
        Raises:
            UpstreamAPIError: 当上游API返回错误时
        """
        api_key = await self._get_user_plugin_key(user_id)
        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {api_key}"}
        
        async with httpx.AsyncClient() as client:
            response = await client.request(
                method=method,
                url=url,
                json=json_data,
                params=params,
                headers=headers,
                timeout=1200.0
            )
            
            if response.status_code >= 400:
                # 尝试解析上游错误响应
                upstream_response = None
                try:
                    upstream_response = response.json()
                except Exception:
                    try:
                        upstream_response = {"raw": response.text}
                    except Exception:
                        pass
                
                logger.warning(
                    f"上游API错误: status={response.status_code}, "
                    f"url={url}, response={upstream_response}"
                )
                
                raise UpstreamAPIError(
                    status_code=response.status_code,
                    message=f"上游API返回错误: {response.status_code}",
                    upstream_response=upstream_response
                )
            
            return response.json()
    
    async def _proxy_admin_request(
        self,
        method: str,
        path: str,
        json_data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        使用管理员 Key 代理请求到 plug-in API

        用途：全局配置类接口（不绑定具体用户 plug-in key）
        """
        if not self.admin_key:
            raise ValueError("未配置 PLUGIN_API_ADMIN_KEY，无法调用 plug-in 管理接口")

        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {self.admin_key}"}

        async with httpx.AsyncClient() as client:
            response = await client.request(
                method=method,
                url=url,
                json=json_data,
                params=params,
                headers=headers,
                timeout=1200.0,
            )

            if response.status_code >= 400:
                upstream_response = None
                try:
                    upstream_response = response.json()
                except Exception:
                    try:
                        upstream_response = {"raw": response.text}
                    except Exception:
                        pass

                logger.warning(
                    f"plug-in admin API错误: status={response.status_code}, url={url}, response={upstream_response}"
                )

                raise UpstreamAPIError(
                    status_code=response.status_code,
                    message=f"plug-in admin API返回错误: {response.status_code}",
                    upstream_response=upstream_response,
                )

            return response.json()

    async def _proxy_stream_request(
        self,
        user_id: int,
        method: str,
        path: str,
        json_data: Optional[Dict[str, Any]] = None
    ):
        """
        代理流式请求到插件API的Kiro端点
        
        Args:
            user_id: 用户ID
            method: HTTP方法
            path: API路径
            json_data: JSON数据
            
        Yields:
            流式响应数据
            
        Raises:
            UpstreamAPIError: 当上游API返回错误时
        """
        api_key = await self._get_user_plugin_key(user_id)
        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {api_key}"}
        
        async with httpx.AsyncClient() as client:
            async with client.stream(
                method=method,
                url=url,
                json=json_data,
                headers=headers,
                timeout=httpx.Timeout(1200.0, connect=60.0)
            ) as response:
                if response.status_code >= 400:
                    # 读取错误响应体
                    error_body = await response.aread()
                    upstream_response = None
                    try:
                        upstream_response = json.loads(error_body.decode('utf-8'))
                    except Exception:
                        try:
                            upstream_response = {"raw": error_body.decode('utf-8')}
                        except Exception:
                            upstream_response = {"raw": str(error_body)}
                    
                    logger.warning(
                        f"上游API流式请求错误: status={response.status_code}, "
                        f"url={url}, response={upstream_response}"
                    )
                    
                    raise UpstreamAPIError(
                        status_code=response.status_code,
                        message=f"上游API返回错误: {response.status_code}",
                        upstream_response=upstream_response
                    )
                
                async for chunk in response.aiter_raw():
                    if chunk:
                        yield chunk
    
    #==================== Kiro账号管理 ====================
    
    async def get_oauth_authorize_url(
        self,
        user_id: int,
        provider: str,
        is_shared: int = 0
    ) -> Dict[str, Any]:
        """获取Kiro OAuth授权URL（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="POST",
            path="/api/kiro/oauth/authorize",
            json_data={
                "provider": provider,
                "is_shared": is_shared
            }
        )
    
    async def get_oauth_status(self, user_id: int, state: str) -> Dict[str, Any]:
        """轮询Kiro OAuth授权状态（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path=f"/api/kiro/oauth/status/{state}"
        )
    
    async def submit_oauth_callback(self, callback_url: str) -> Dict[str, Any]:
        """
        提交 Kiro OAuth 回调（给 AntiHook 用）。

        说明：
        - Kiro OAuth 的 state 信息在 plug-in API 的 authorize 阶段写入 Redis；
        - callback 阶段 plug-in API 本身不要求鉴权（没有用户 token 也能完成），因此这里直接代理即可。
        """
        url = f"{self.base_url}/api/kiro/oauth/callback"

        async with httpx.AsyncClient() as client:
            response = await client.post(
                url=url,
                json={"callback_url": callback_url},
                timeout=1200.0,
            )

        if response.status_code >= 400:
            upstream_response = None
            try:
                upstream_response = response.json()
            except Exception:
                try:
                    upstream_response = {"raw": response.text}
                except Exception:
                    pass

            logger.warning(
                f"上游API错误: status={response.status_code}, url={url}, response={upstream_response}"
            )

            raise UpstreamAPIError(
                status_code=response.status_code,
                message=f"上游API返回错误: {response.status_code}",
                upstream_response=upstream_response,
            )

        return response.json()

    async def create_account(self, user_id: int, account_data: Dict[str, Any]) -> Dict[str, Any]:
        """创建Kiro账号（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="POST",
            path="/api/kiro/accounts",
            json_data=account_data
        )
    
    async def get_accounts(self, user_id: int) -> Dict[str, Any]:
        """获取Kiro账号列表（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path="/api/kiro/accounts"
        )
    
    async def get_account(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """获取单个Kiro账号（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path=f"/api/kiro/accounts/{account_id}"
        )

    async def get_account_credentials(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """
        导出Kiro账号凭证（敏感信息）

        说明：
        - 仅用于用户自助导出/备份（前端“复制凭证为JSON”）
        - 实际鉴权在 plug-in API 层完成（仅账号所有者/管理员可访问）
        """
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path=f"/api/kiro/accounts/{account_id}/credentials",
        )
    
    async def update_account_status(
        self,
        user_id: int,
        account_id: str,
        status: int
    ) -> Dict[str, Any]:
        """更新Kiro账号状态（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="PUT",
            path=f"/api/kiro/accounts/{account_id}/status",
            json_data={"status": status}
        )
    
    async def update_account_name(
        self,
        user_id: int,
        account_id: str,
        account_name: str
    ) -> Dict[str, Any]:
        """更新Kiro账号名称（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="PUT",
            path=f"/api/kiro/accounts/{account_id}/name",
            json_data={"account_name": account_name}
        )
    
    async def get_account_balance(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """获取Kiro账号余额（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path=f"/api/kiro/accounts/{account_id}/balance"
        )
    
    async def get_account_consumption(
        self,
        user_id: int,
        account_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取Kiro账号消费记录（通过插件API）"""
        params = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path=f"/api/kiro/accounts/{account_id}/consumption",
            params=params
        )
    
    async def get_user_consumption_stats(
        self,
        user_id: int,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取用户Kiro总消费统计（通过插件API）"""
        params = {}
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path="/api/kiro/consumption/stats",
            params=params
        )
    
    async def delete_account(self, user_id: int, account_id: str) -> Dict[str, Any]:
        """删除Kiro账号（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="DELETE",
            path=f"/api/kiro/accounts/{account_id}"
        )
    
    # ==================== Kiro 订阅层 -> 可用模型（管理员配置） ====================

    async def get_subscription_model_rules(self) -> Dict[str, Any]:
        """获取订阅层可用模型配置（管理员，透传 plug-in）"""
        return await self._proxy_admin_request(
            method="GET",
            path="/api/kiro/admin/subscription-models",
        )

    async def upsert_subscription_model_rule(
        self,
        subscription: str,
        model_ids: Optional[List[str]],
    ) -> Dict[str, Any]:
        """设置订阅层可用模型配置（管理员，透传 plug-in）"""
        return await self._proxy_admin_request(
            method="PUT",
            path="/api/kiro/admin/subscription-models",
            json_data={"subscription": subscription, "model_ids": model_ids},
        )

    # ==================== Kiro OpenAI兼容API ====================
    
    async def get_models(self, user_id: int) -> Dict[str, Any]:
        """获取Kiro模型列表（通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="GET",
            path="/v1/kiro/models"
        )
    
    async def chat_completions(
        self,
        user_id: int,
        request_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Kiro聊天补全（非流式，通过插件API）"""
        return await self._proxy_request(
            user_id=user_id,
            method="POST",
            path="/v1/kiro/chat/completions",
            json_data=request_data
        )
    
    async def chat_completions_stream(
        self,
        user_id: int,
        request_data: Dict[str, Any]
    ):
        """Kiro聊天补全（流式，通过插件API）"""
        async for chunk in self._proxy_stream_request(
            user_id=user_id,
            method="POST",
            path="/v1/kiro/chat/completions",
            json_data=request_data
        ):
            yield chunk
