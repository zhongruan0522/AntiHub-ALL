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

    # Usage logs（消耗日志/请求日志）
    usage_log_redact_headers: bool = Field(
        default=True,
        description="是否在保存消耗日志时对敏感请求头做脱敏处理（Authorization/Cookie/Token 等）",
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
    
    # 凭证/密钥加密（Fernet key）
    plugin_api_encryption_key: str = Field(
        ...,
        description="Fernet 加密密钥：用于加密存储各类上游凭证/API Key（不要随意更换，否则历史密文无法解密）"
    )

    # Kiro 配置（可选）
    kiro_ide_version: str = Field(
        default="0.10.0",
        description="Kiro 请求 User-Agent 使用的 IDE 版本（默认 0.10.0）",
    )
    kiro_proxy_url: Optional[str] = Field(
        default=None,
        description=(
            "Kiro 上游请求代理（HTTP/SOCKS）。示例：http://127.0.0.1:7890；"
            "如果后端运行在 Docker 内且代理在宿主机，请使用 http://host.docker.internal:7890"
        ),
    )

    # 旧 plugin DB → Backend DB 自动迁移（可选）
    #
    # 新部署：不要配置 PLUGIN_API_BASE_URL（留空），后端会直接启动，不会触发迁移逻辑。
    # 升级/迁移：配置 PLUGIN_API_BASE_URL 指向 “迁移助手(Plugin env exporter)” 服务，
    #          后端启动时会自动拉取 DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD 并迁移。
    plugin_api_base_url: Optional[str] = Field(
        default=None,
        description="Plugin env exporter API Base URL（配置后启用启动期迁移）",
    )
    plugin_env_export_token: Optional[str] = Field(
        default=None,
        description="Plugin env exporter 鉴权 Token（可选，对应请求头 X-Migration-Token）",
    )
    plugin_db_migration_wait_timeout_seconds: int = Field(
        default=600,
        description="检测到迁移进行中时等待迁移完成的超时时间（秒）",
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
