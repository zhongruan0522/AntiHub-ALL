"""
Redis 客户端管理
提供 Redis 连接和基础操作
"""
from typing import Optional, Any
import json
from redis import asyncio as aioredis
from redis.asyncio import Redis

from app.core.config import get_settings


class RedisClient:
    """
    Redis 客户端封装类
    提供连接管理和基础操作方法
    """
    
    def __init__(self):
        """初始化 Redis 客户端"""
        self._client: Optional[Redis] = None
        self._settings = get_settings()
    
    async def connect(self) -> None:
        """
        建立 Redis 连接
        配置连接池参数
        """
        if self._client is None:
            self._client = await aioredis.from_url(
                self._settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                max_connections=50,  # 增加最大连接数，避免高并发下连接池耗尽
                socket_timeout=5.0,  # 设置超时时间
                health_check_interval=30, # 定期健康检查
            )
    
    async def disconnect(self) -> None:
        """关闭 Redis 连接"""
        if self._client:
            await self._client.close()
            self._client = None
    
    async def ping(self) -> bool:
        """
        检查 Redis 连接是否正常
        
        Returns:
            bool: 连接正常返回 True,否则返回 False
        """
        try:
            if self._client is None:
                await self.connect()
            return await self._client.ping()
        except Exception:
            return False
    
    async def get(self, key: str) -> Optional[str]:
        """
        获取键的值
        
        Args:
            key: Redis 键
            
        Returns:
            键对应的值,不存在则返回 None
        """
        if self._client is None:
            await self.connect()
        return await self._client.get(key)
    
    async def set(
        self,
        key: str,
        value: str,
        expire: Optional[int] = None
    ) -> bool:
        """
        设置键值
        
        Args:
            key: Redis 键
            value: 要设置的值
            expire: 过期时间(秒),None 表示不过期
            
        Returns:
            设置成功返回 True
        """
        if self._client is None:
            await self.connect()
        return await self._client.set(key, value, ex=expire)

    async def set_if_not_exists(
        self,
        key: str,
        value: str,
        expire: Optional[int] = None,
    ) -> bool:
        """
        仅当 key 不存在时设置键值（SET NX）

        用于实现分布式锁等场景。
        """
        if self._client is None:
            await self.connect()
        return bool(await self._client.set(key, value, ex=expire, nx=True))
    
    async def setex(self, key: str, seconds: int, value: str) -> bool:
        """
        设置键值并指定过期时间
        
        Args:
            key: Redis 键
            seconds: 过期时间(秒)
            value: 要设置的值
            
        Returns:
            设置成功返回 True
        """
        if self._client is None:
            await self.connect()
        return await self._client.setex(key, seconds, value)
    
    async def delete(self, key: str) -> int:
        """
        删除键
        
        Args:
            key: Redis 键
            
        Returns:
            删除的键数量
        """
        if self._client is None:
            await self.connect()
        return await self._client.delete(key)
    
    async def exists(self, key: str) -> bool:
        """
        检查键是否存在
        
        Args:
            key: Redis 键
            
        Returns:
            存在返回 True,否则返回 False
        """
        if self._client is None:
            await self.connect()
        return await self._client.exists(key) > 0
    
    async def get_json(self, key: str) -> Optional[Any]:
        """
        获取 JSON 格式的值
        
        Args:
            key: Redis 键
            
        Returns:
            解析后的 JSON 对象,不存在或解析失败返回 None
        """
        value = await self.get(key)
        if value is None:
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    
    async def set_json(
        self,
        key: str,
        value: Any,
        expire: Optional[int] = None
    ) -> bool:
        """
        设置 JSON 格式的值
        
        Args:
            key: Redis 键
            value: 要设置的对象(将被序列化为 JSON)
            expire: 过期时间(秒),None 表示不过期
            
        Returns:
            设置成功返回 True
        """
        json_value = json.dumps(value, ensure_ascii=False)
        return await self.set(key, json_value, expire)
    
    # ==================== 会话管理功能 ====================
    
    async def create_session(
        self,
        user_id: int,
        session_data: dict,
        ttl: int = 86400  # 默认 24 小时
    ) -> bool:
        """
        创建用户会话
        
        Args:
            user_id: 用户 ID
            session_data: 会话数据
            ttl: 会话有效期(秒),默认 24 小时
            
        Returns:
            创建成功返回 True
        """
        key = f"session:{user_id}"
        return await self.set_json(key, session_data, expire=ttl)
    
    async def get_session(self, user_id: int) -> Optional[dict]:
        """
        获取用户会话
        
        Args:
            user_id: 用户 ID
            
        Returns:
            会话数据,不存在返回 None
        """
        key = f"session:{user_id}"
        return await self.get_json(key)
    
    async def delete_session(self, user_id: int) -> bool:
        """
        删除用户会话
        
        Args:
            user_id: 用户 ID
            
        Returns:
            删除成功返回 True
        """
        key = f"session:{user_id}"
        result = await self.delete(key)
        return result > 0
    
    async def update_session_ttl(self, user_id: int, ttl: int = 86400) -> bool:
        """
        更新会话过期时间
        
        Args:
            user_id: 用户 ID
            ttl: 新的有效期(秒)
            
        Returns:
            更新成功返回 True
        """
        key = f"session:{user_id}"
        if self._client is None:
            await self.connect()
        return await self._client.expire(key, ttl)
    
    # ==================== 令牌黑名单功能 ====================
    
    async def blacklist_token(self, token_jti: str, ttl: int) -> bool:
        """
        将令牌加入黑名单
        
        Args:
            token_jti: JWT 令牌的 JTI (唯一标识符)
            ttl: 黑名单有效期(秒),应设置为令牌剩余有效期
            
        Returns:
            添加成功返回 True
        """
        key = f"blacklist:{token_jti}"
        return await self.setex(key, ttl, "1")
    
    async def is_token_blacklisted(self, token_jti: str) -> bool:
        """
        检查令牌是否在黑名单中
        
        Args:
            token_jti: JWT 令牌的 JTI
            
        Returns:
            在黑名单中返回 True,否则返回 False
        """
        key = f"blacklist:{token_jti}"
        return await self.exists(key)
    
    # ==================== Refresh Token 管理功能 ====================
    
    async def store_refresh_token(
        self,
        user_id: int,
        token_jti: str,
        token_data: dict,
        ttl: int
    ) -> bool:
        """
        存储 Refresh Token 信息
        
        Args:
            user_id: 用户 ID
            token_jti: Refresh Token 的 JTI
            token_data: Token 相关数据
            ttl: 有效期(秒)
            
        Returns:
            存储成功返回 True
        """
        # 存储 token -> user 映射
        token_key = f"refresh_token:{token_jti}"
        await self.set_json(token_key, token_data, expire=ttl)
        
        # 存储 user -> tokens 映射（支持多设备登录）
        user_tokens_key = f"user_refresh_tokens:{user_id}"
        tokens = await self.get_json(user_tokens_key) or []
        
        # 清理过期的 token JTI
        valid_tokens = []
        for t_jti in tokens:
            if await self.exists(f"refresh_token:{t_jti}"):
                valid_tokens.append(t_jti)
        
        # 添加新的 token JTI
        valid_tokens.append(token_jti)
        await self.set_json(user_tokens_key, valid_tokens, expire=ttl)
        
        return True
    
    async def get_refresh_token_data(self, token_jti: str) -> Optional[dict]:
        """
        获取 Refresh Token 数据
        
        Args:
            token_jti: Refresh Token 的 JTI
            
        Returns:
            Token 数据,不存在返回 None
        """
        key = f"refresh_token:{token_jti}"
        return await self.get_json(key)
    
    async def revoke_refresh_token(self, token_jti: str) -> bool:
        """
        撤销单个 Refresh Token
        
        Args:
            token_jti: Refresh Token 的 JTI
            
        Returns:
            撤销成功返回 True
        """
        key = f"refresh_token:{token_jti}"
        result = await self.delete(key)
        return result > 0
    
    async def revoke_all_user_refresh_tokens(self, user_id: int) -> bool:
        """
        撤销用户的所有 Refresh Token（用于登出所有设备）
        
        Args:
            user_id: 用户 ID
            
        Returns:
            撤销成功返回 True
        """
        user_tokens_key = f"user_refresh_tokens:{user_id}"
        tokens = await self.get_json(user_tokens_key) or []
        
        # 删除所有 refresh token
        for token_jti in tokens:
            await self.delete(f"refresh_token:{token_jti}")
        
        # 删除用户的 token 列表
        await self.delete(user_tokens_key)
        
        return True
    
    async def is_refresh_token_valid(self, token_jti: str) -> bool:
        """
        检查 Refresh Token 是否有效（未被撤销）
        
        Args:
            token_jti: Refresh Token 的 JTI
            
        Returns:
            有效返回 True,否则返回 False
        """
        key = f"refresh_token:{token_jti}"
        return await self.exists(key)
    
    async def rotate_refresh_token(
        self,
        old_token_jti: str,
        new_token_jti: str,
        user_id: int,
        token_data: dict,
        ttl: int
    ) -> bool:
        """
        轮换 Refresh Token（撤销旧的，创建新的）
        
        Args:
            old_token_jti: 旧 Refresh Token 的 JTI
            new_token_jti: 新 Refresh Token 的 JTI
            user_id: 用户 ID
            token_data: 新 Token 的数��
            ttl: 新 Token 的有效期(秒)
            
        Returns:
            轮换成功返回 True
        """
        # 撤销旧 token
        await self.revoke_refresh_token(old_token_jti)
        
        # 存储新 token
        return await self.store_refresh_token(user_id, new_token_jti, token_data, ttl)
    
    # ==================== OAuth State 存储功能 ====================
    
    async def store_oauth_state(
        self,
        state: str,
        data: Optional[dict] = None,
        ttl: int = 600  # 默认 10 分钟
    ) -> bool:
        """
        存储 OAuth 授权 state
        
        Args:
            state: OAuth state 字符串
            data: 额外的状态数据(如 redirect_uri 等)
            ttl: 有效期(秒),默认 10 分钟
            
        Returns:
            存储成功返回 True
        """
        key = f"oauth_state:{state}"
        value = data or {}
        return await self.set_json(key, value, expire=ttl)
    
    async def verify_oauth_state(self, state: str) -> Optional[dict]:
        """
        验证并获取 OAuth state 数据
        验证后会自动删除 state
        
        Args:
            state: OAuth state 字符串
            
        Returns:
            state 有效则返回存储的数据,无效返回 None
        """
        key = f"oauth_state:{state}"
        data = await self.get_json(key)
        if data is not None:
            # 验证后删除 state,防止重放攻击
            await self.delete(key)
        return data
    
    async def delete_oauth_state(self, state: str) -> bool:
        """
        删除 OAuth state
        
        Args:
            state: OAuth state 字符串
            
        Returns:
            删除成功返回 True
        """
        key = f"oauth_state:{state}"
        result = await self.delete(key)
        return result > 0


# 全局 Redis 客户端实例
_redis_client: Optional[RedisClient] = None


def get_redis_client() -> RedisClient:
    """
    获取 Redis 客户端实例
    使用单例模式
    
    Returns:
        RedisClient 实例
    """
    global _redis_client
    if _redis_client is None:
        _redis_client = RedisClient()
    return _redis_client


async def init_redis() -> None:
    """初始化 Redis 连接"""
    client = get_redis_client()
    await client.connect()


async def close_redis() -> None:
    """关闭 Redis 连接"""
    global _redis_client
    if _redis_client:
        await _redis_client.disconnect()
        _redis_client = None
