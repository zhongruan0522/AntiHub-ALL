"""
使用记录模型
记录用户的API调用，用于统计
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class UsageLog(Base):
    """使用记录表"""
    
    __tablename__ = "usage_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    api_key_id = Column(Integer, ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=True)
    
    # 请求信息
    endpoint = Column(String(255), nullable=False)  # 调用的端点
    method = Column(String(10), nullable=False)  # HTTP方法
    model_name = Column(String(100), nullable=True)  # 使用的模型
    config_type = Column(String(20), nullable=True, index=True)  # antigravity / kiro / qwen / codex / gemini-cli
    stream = Column(Boolean, default=False, nullable=False)  # 是否为流式请求
    
    # 配额消耗
    quota_consumed = Column(Float, default=0.0, nullable=False)  # 消耗的配额

    # Token 用量（OpenAI/兼容格式）
    input_tokens = Column(Integer, default=0, nullable=False)  # prompt_tokens / input_tokens
    output_tokens = Column(Integer, default=0, nullable=False)  # completion_tokens / output_tokens
    total_tokens = Column(Integer, default=0, nullable=False)

    # 请求结果
    success = Column(Boolean, default=True, nullable=False)  # 成功/失败都要记录
    status_code = Column(Integer, nullable=True)  # 上游/处理结果状态码（流式可能为上游code）
    error_message = Column(Text, nullable=True)  # 失败原因（截断保存）

    # 请求体（原始JSON，用于调试）
    request_body = Column(Text, nullable=True)  # 原始请求体JSON字符串

    # 客户端标识（可选）：来自请求头 X-App，用于区分不同调用来源（例如不同 App / 环境）
    client_app = Column(String(128), nullable=True, index=True)

    # TTS 扩展信息
    tts_voice_id = Column(String(128), nullable=True)  # 音色ID
    tts_account_id = Column(String(128), nullable=True)  # ZAI_USERID

    # 性能
    duration_ms = Column(Integer, default=0, nullable=False)

    # 时间戳
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    
    # 关系
    user = relationship("User", backref="usage_logs")
    
    def __repr__(self):
        return f"<UsageLog(id={self.id}, user_id={self.user_id}, endpoint={self.endpoint})>"
