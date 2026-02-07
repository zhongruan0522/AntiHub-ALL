"""
Anthropic API格式的数据模式
用于支持Anthropic Messages API格式的请求和响应
"""
from typing import Optional, Any, Dict, List, Union, Literal
from datetime import datetime
from pydantic import BaseModel, Field
import uuid
import time


# ==================== Anthropic 请求格式 ====================

class AnthropicTextContent(BaseModel):
    """Anthropic文本内容块"""
    type: Literal["text"] = "text"
    text: str


class AnthropicImageSource(BaseModel):
    """Anthropic图片来源"""
    type: Literal["base64", "url"] = "base64"
    media_type: str = Field(..., description="图片MIME类型，如image/jpeg, image/png等")
    data: Optional[str] = Field(None, description="Base64编码的图片数据")
    url: Optional[str] = Field(None, description="图片URL")


class AnthropicImageContent(BaseModel):
    """Anthropic图片内容块"""
    type: Literal["image"] = "image"
    source: AnthropicImageSource


class AnthropicToolUseContent(BaseModel):
    """Anthropic工具使用内容块"""
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: Dict[str, Any]


class AnthropicToolResultContent(BaseModel):
    """Anthropic工具结果内容块"""
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: Union[str, List[Union["AnthropicTextContent", "AnthropicImageContent"]]]
    is_error: Optional[bool] = False


class AnthropicThinkingContent(BaseModel):
    """Anthropic思考内容块（Extended Thinking）- 用于请求消息"""
    type: Literal["thinking"] = "thinking"
    thinking: str
    signature: Optional[str] = None  # 思考内容的签名（可选）


class AnthropicRedactedThinkingContent(BaseModel):
    """Anthropic已编辑思考内容块（Extended Thinking）- 用于请求消息"""
    type: Literal["redacted_thinking"] = "redacted_thinking"
    data: str  # 已编辑的思考内容数据


# 内容块联合类型
AnthropicContentBlock = Union[
    AnthropicTextContent,
    AnthropicImageContent,
    AnthropicToolUseContent,
    AnthropicToolResultContent,
    AnthropicThinkingContent,
    AnthropicRedactedThinkingContent
]


class AnthropicMessage(BaseModel):
    """Anthropic消息格式"""
    role: Literal["user", "assistant"]
    content: Union[str, List[AnthropicContentBlock]]


class AnthropicToolInputSchema(BaseModel):
    """Anthropic工具输入模式"""
    type: str = "object"
    properties: Dict[str, Any] = Field(default_factory=dict)
    required: Optional[List[str]] = None


class AnthropicTool(BaseModel):
    """Anthropic工具定义"""
    name: str
    description: Optional[str] = None
    input_schema: Optional[AnthropicToolInputSchema] = Field(
        default_factory=lambda: AnthropicToolInputSchema(),
        description="工具输入模式，可选。如果未提供，默认为空对象模式"
    )


class AnthropicToolChoice(BaseModel):
    """Anthropic工具选择"""
    type: Literal["auto", "any", "tool", "none"] = "auto"
    name: Optional[str] = None  # 当type为"tool"时必填
    disable_parallel_tool_use: Optional[bool] = False  # 是否禁用并行工具调用


class AnthropicMetadata(BaseModel):
    """Anthropic请求元数据"""
    user_id: Optional[str] = None


class AnthropicMessagesRequest(BaseModel):
    """
    Anthropic Messages API请求格式
    对应 POST /v1/messages
    """
    model: str = Field(..., description="模型名称")
    messages: List[AnthropicMessage] = Field(..., description="消息列表")
    max_tokens: int = Field(..., description="最大生成token数")

    # 可选参数
    system: Optional[Union[str, List[AnthropicTextContent]]] = Field(None, description="系统提示")
    stop_sequences: Optional[List[str]] = Field(None, description="停止序列")
    stream: bool = Field(False, description="是否流式输出")
    temperature: Optional[float] = Field(None, ge=0, le=1, description="温度参数")
    top_p: Optional[float] = Field(None, ge=0, le=1, description="Top-p采样")
    top_k: Optional[int] = Field(None, ge=0, description="Top-k采样")

    # Extended Thinking 支持
    thinking: Optional[Union[Dict[str, Any], bool, str]] = Field(
        None,
        description=(
            "Extended Thinking 配置。可以是 bool、'enabled'/'adaptive' 或 dict 格式如 "
            "{'type': 'enabled', 'budget_tokens': 10000} / {'type': 'adaptive'}"
        ),
    )
    output_config: Optional[Dict[str, Any]] = Field(
        None,
        description="Thinking adaptive 输出配置（参考 kiro.rs），例如 {'effort': 'high'|'medium'|'low'}",
    )

    # 工具相关
    tools: Optional[List[AnthropicTool]] = Field(None, description="可用工具列表")
    tool_choice: Optional[Union[AnthropicToolChoice, Dict[str, Any]]] = Field(None, description="工具选择策略")

    # 元数据
    metadata: Optional[AnthropicMetadata] = Field(None, description="请求元数据")

    model_config = {"extra": "allow"}


# ==================== Anthropic 响应格式 ====================

class AnthropicUsage(BaseModel):
    """Anthropic使用量统计"""
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: Optional[int] = None
    cache_read_input_tokens: Optional[int] = None


class AnthropicResponseTextContent(BaseModel):
    """Anthropic响应文本内容块"""
    type: Literal["text"] = "text"
    text: str


class AnthropicResponseThinkingContent(BaseModel):
    """Anthropic响应思考内容块（Extended Thinking）"""
    type: Literal["thinking"] = "thinking"
    thinking: str
    signature: Optional[str] = None  # 思考内容的签名（可选）


class AnthropicResponseToolUseContent(BaseModel):
    """Anthropic响应工具使用内容块"""
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: Dict[str, Any]


AnthropicResponseContentBlock = Union[
    AnthropicResponseTextContent,
    AnthropicResponseThinkingContent,
    AnthropicResponseToolUseContent
]


class AnthropicMessagesResponse(BaseModel):
    """
    Anthropic Messages API响应格式
    """
    id: str = Field(default_factory=lambda: f"msg_{uuid.uuid4().hex[:24]}")
    type: Literal["message"] = "message"
    role: Literal["assistant"] = "assistant"
    content: List[AnthropicResponseContentBlock]
    model: str
    stop_reason: Optional[Literal["end_turn", "max_tokens", "stop_sequence", "tool_use"]] = None
    stop_sequence: Optional[str] = None
    usage: AnthropicUsage


# ==================== Anthropic 流式响应格式 ====================

class AnthropicStreamMessageStart(BaseModel):
    """流式响应 - 消息开始事件"""
    type: Literal["message_start"] = "message_start"
    message: Dict[str, Any]


class AnthropicStreamContentBlockStart(BaseModel):
    """流式响应 - 内容块开始事件"""
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: Dict[str, Any]


class AnthropicStreamContentBlockDelta(BaseModel):
    """流式响应 - 内容块增量事件"""
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: Dict[str, Any]


class AnthropicStreamContentBlockStop(BaseModel):
    """流式响应 - 内容块结束事件"""
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int


class AnthropicStreamMessageDelta(BaseModel):
    """流式响应 - 消息增量事件"""
    type: Literal["message_delta"] = "message_delta"
    delta: Dict[str, Any]
    usage: Optional[Dict[str, int]] = None


class AnthropicStreamMessageStop(BaseModel):
    """流式响应 - 消息结束事件"""
    type: Literal["message_stop"] = "message_stop"


class AnthropicStreamPing(BaseModel):
    """流式响应 - ping事件"""
    type: Literal["ping"] = "ping"


class AnthropicStreamError(BaseModel):
    """流式响应 - 错误事件"""
    type: Literal["error"] = "error"
    error: Dict[str, Any]


# ==================== Anthropic 错误响应格式 ====================

class AnthropicErrorDetail(BaseModel):
    """Anthropic错误详情"""
    type: str
    message: str


class AnthropicErrorResponse(BaseModel):
    """Anthropic错误响应"""
    type: Literal["error"] = "error"
    error: AnthropicErrorDetail
