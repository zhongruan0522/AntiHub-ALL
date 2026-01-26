"""
API密钥相关的数据模式
"""
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, Field


class APIKeyCreate(BaseModel):
    """创建API密钥请求"""
    name: Optional[str] = Field(None, description="密钥名称，方便识别")
    config_type: str = Field("antigravity", description="配置类型：antigravity / kiro / qwen / codex / gemini-cli / zai-tts")


class APIKeyResponse(BaseModel):
    """API密钥响应"""
    id: int
    user_id: int
    key: str = Field(..., description="API密钥")
    name: Optional[str] = None
    config_type: str = Field(..., description="配置类型：antigravity / kiro / qwen / codex / gemini-cli / zai-tts")
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    
    model_config = {"from_attributes": True}


class APIKeyListResponse(BaseModel):
    """API密钥列表响应（不包含完整密钥）"""
    id: int
    user_id: int
    key_preview: str = Field(..., description="密钥预览（前8位）")
    name: Optional[str] = None
    config_type: str = Field(..., description="配置类型：antigravity / kiro / qwen / codex / gemini-cli / zai-tts")
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    
    model_config = {"from_attributes": True}


class APIKeyUpdateStatus(BaseModel):
    """更新API密钥状态"""
    is_active: bool = Field(..., description="是否激活")
