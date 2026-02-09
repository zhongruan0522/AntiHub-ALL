"""
配置管理模块
使用 pydantic-settings 从环境变量加载配置
"""
from typing import Optional
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置类"""
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )
    
    # 应用配置
    app_env: str = Field(default="development", description="应用环境")
    log_level: str = Field(default="INFO", description="日志级别")
    debug_log: bool = Field(
        default=False,
        description="是否打印用户请求体（谨慎开启，可能包含敏感信息）",
    )
    
    # 数据库配置
    database_url: str = Field(..., description="PostgreSQL 数据库连接 URL")
    
    # Redis 配置
    redis_url: str = Field(..., description="Redis 连接 URL")
    
    # JWT 配置
    jwt_secret_key: str = Field(..., description="JWT 密钥")
    jwt_algorithm: str = Field(default="HS256", description="JWT 算法")
    jwt_expire_hours: int = Field(default=24, description="Access Token 过期时间（小时）")
    
    # Refresh Token 配置
    refresh_token_expire_days: int = Field(default=7, description="Refresh Token 过期时间（天）")
    refresh_token_secret_key: Optional[str] = Field(default=None, description="Refresh Token 密钥（默认使用 JWT 密钥）")
    
    # Plug-in API 配置
    plugin_api_base_url: str = Field(
        default="http://localhost:8045",
        description="Plug-in API服务的基础URL"
    )
    plugin_api_admin_key: Optional[str] = Field(
        None,
        description="Plug-in API管理员密钥（用于创建用户等管理操作）"
    )
    plugin_api_encryption_key: str = Field(
        ...,
        description="用于加密存储用户API密钥的密钥"
    )

    # ZAI TTS 配置
    zai_tts_base_url: str = Field(
        default="https://audio.z.ai",
        description="ZAI TTS 上游基础URL",
    )
    zai_tts_user_agent: str = Field(
        default="Mozilla/5.0 AppleWebKit/537.36 Chrome/143 Safari/537",
        description="ZAI TTS 请求 User-Agent",
    )
    zai_tts_file_keep_count: int = Field(
        default=10,
        description="非流式音频文件保留数量（启动自动清理）",
    )

    # 管理员账号配置（可选，用于首次初始化）
    # ZAI Image 配置
    zai_image_base_url: str = Field(
        default="https://image.z.ai",
        description="ZAI Image 上游基础URL",
    )
    zai_image_user_agent: str = Field(
        default="Mozilla/5.0 AppleWebKit/537.36 Chrome/143 Safari/537",
        description="ZAI Image 请求 User-Agent",
    )

    admin_username: Optional[str] = Field(
        default=None,
        description="管理员用户名（首次启动时自动创建）"
    )
    admin_password: Optional[str] = Field(
        default=None,
        description="管理员密码（首次启动时自动创建）"
    )

    @field_validator("app_env")
    @classmethod
    def validate_app_env(cls, v: str) -> str:
        """验证应用���境"""
        allowed_envs = ["development", "staging", "production"]
        if v not in allowed_envs:
            raise ValueError(f"app_env must be one of {allowed_envs}")
        return v
    
    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        """验证日志级别"""
        allowed_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        v_upper = v.upper()
        if v_upper not in allowed_levels:
            raise ValueError(f"log_level must be one of {allowed_levels}")
        return v_upper
    
    @field_validator("jwt_expire_hours")
    @classmethod
    def validate_jwt_expire_hours(cls, v: int) -> int:
        """验证 JWT 过期时间"""
        if v <= 0:
            raise ValueError("jwt_expire_hours must be positive")
        return v
    
    @field_validator("refresh_token_expire_days")
    @classmethod
    def validate_refresh_token_expire_days(cls, v: int) -> int:
        """验证 Refresh Token 过期时间"""
        if v <= 0:
            raise ValueError("refresh_token_expire_days must be positive")
        return v
    
    @property
    def is_development(self) -> bool:
        """是否为开发环境"""
        return self.app_env == "development"
    
    @property
    def is_production(self) -> bool:
        """是否为生产环境"""
        return self.app_env == "production"
    
    @property
    def jwt_expire_seconds(self) -> int:
        """JWT 过期时间（秒）"""
        return self.jwt_expire_hours * 3600
    
    @property
    def refresh_token_expire_seconds(self) -> int:
        """Refresh Token 过期时间（秒）"""
        return self.refresh_token_expire_days * 24 * 3600
    
    @property
    def refresh_secret_key(self) -> str:
        """获取 Refresh Token 密钥"""
        return self.refresh_token_secret_key or self.jwt_secret_key


# 全局配置实例
settings: Optional[Settings] = None


def get_settings() -> Settings:
    """
    获取配置实例
    使用单例模式确保配置只加载一次
    """
    global settings
    if settings is None:
        settings = Settings()
    return settings
