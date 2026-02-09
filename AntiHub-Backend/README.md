# 共享账号管理系统

基于 FastAPI 的共享账号管理系统，集成 Plug-in API 功能，支持传统用户名密码登录，提供完整的 AI 聊天服务和配额管理。

## 功能特性

### ✅ 已实现功能

- **用户认证**
  - 传统用户名密码登录
  - JWT 令牌认证
  - **无感刷新机制**（Refresh Token）
  - 会话管理
  - 令牌黑名单机制
  - Token 轮换安全机制

- **用户管理**
  - 用户信息存储(PostgreSQL)
  - 用户状态管理(激活/禁用/禁言)
  - 信任等级系统

- **Plug-in API 集成**
  - 自动账号创建：用户注册时自动创建 Plug-in API 账号
  - API 密钥安全存储：使用 Fernet 加密算法安全存储
  - 代理请求：所有 Plug-in API 请求通过后端代理
  - OpenAI 兼容接口：支持标准的 OpenAI API 格式
  - 完整功能支持：账号管理、配额管理、聊天补全等

- **AI 聊天服务**
  - OpenAI 兼容的聊天补全 API
  - 支持流式和非流式输出
  - 多模型支持（Gemini 等）
  - 智能 Cookie 选择和轮换

- **配额管理系统**
  - 用户共享配额池
  - 自动配额恢复机制
  - 配额消耗追踪和统计
  - 专属/共享 Cookie 优先级设置

- **安全特性**
  - bcrypt 密码哈希(rounds=12)
  - JWT Access Token (HS256, 默认24小时有效期)
  - JWT Refresh Token (默认7天有效期)
  - Token 自动轮换机制
  - API 密钥加密存储

- **缓存系统**
  - Redis 会话存储
  - 令牌黑名单
  - Refresh Token 存储和管理

## 技术栈

- **Web 框架**: FastAPI 0.104+
- **数据库**: PostgreSQL + SQLAlchemy 2.0 (异步)
- **缓存**: Redis
- **认证**: PyJWT + Passlib
- **HTTP 客户端**: httpx
- **数据库迁移**: Alembic
- **数据验证**: Pydantic

## 快速开始

### 1. 环境要求

- Python 3.10+
- PostgreSQL 12+
- Redis 6+
- Plug-in API 服务（可选，用于 AI 聊天功能）

### 2. 安装依赖

```bash
# 使用 uv 
uv sync
```

### 3. 配置环境变量

复制 `.env.example` 到 `.env` 并配置:

```bash
cp .env.example .env
```

编辑 `.env` 文件,配置以下必需项:

 ```bash
 # 应用配置
 APP_ENV=development
 LOG_LEVEL=INFO
 # Debug：打印用户请求体（完整原始请求体）；谨慎开启，可能包含敏感信息
 DEBUG_LOG=false
 
 # 数据库配置
 DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/shared_accounts

# Redis 配置
REDIS_URL=redis://localhost:6379/0
# 或带密码: redis://:password@localhost:6379/0

# JWT 配置
JWT_SECRET_KEY=your-secret-key-change-this-in-production
JWT_ALGORITHM=HS256
JWT_EXPIRE_HOURS=24

# Refresh Token 配置
REFRESH_TOKEN_EXPIRE_DAYS=7
# REFRESH_TOKEN_SECRET_KEY=your-refresh-token-secret-key  # 可选，默认使用 JWT_SECRET_KEY

# Plug-in API 配置（可选）
PLUGIN_API_BASE_URL=http://localhost:8045
PLUGIN_API_ADMIN_KEY=sk-admin-your-admin-key-here
PLUGIN_API_ENCRYPTION_KEY=your-encryption-key-here-min-32-chars
```

**重要**：`PLUGIN_API_ENCRYPTION_KEY` 必须是一个有效的 Fernet 密钥（32字节的URL安全base64编码）。可以使用以下 Python 代码生成：

```python
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
```

### 4. 数据库迁移

```bash
# 运行数据库迁移
uv run alembic upgrade head
```

### 5. 启动服务

```bash
# 使用启动脚本（推荐）
chmod +x run.sh
./run.sh

# 或直接使用 uvicorn
uv run uvicorn app.main:app --host 0.0.0.0 --port 8008 --reload

# 或使用 Python
uv run python app/main.py
```

服务将在 http://localhost:8008 启动

## API 文档

启动服务后访问:

- **Swagger UI**: http://localhost:8008/api/docs
- **ReDoc**: http://localhost:8008/api/redoc
- **OpenAPI JSON**: http://localhost:8008/api/openapi.json

**注意**：生产环境中 API 文档将被禁用。

## API 端点

### 认证相关

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/login` | 用户名密码登录 |
| POST | `/api/auth/refresh` | 刷新访问令牌（无感刷新） |
| POST | `/api/auth/logout` | 用户登出 |
| POST | `/api/auth/logout-all` | 登出所有设备 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| GET | `/api/auth/check-username` | 检查用户名是否存在 |

### 健康检查

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/health` | 系统健康状态检查 |

### API 密钥管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/api-keys` | 获取用户的 API 密钥列表 |
| POST | `/api/api-keys` | 创建新的 API 密钥 |
| DELETE | `/api/api-keys/{key_id}` | 删除指定的 API 密钥 |

### Plug-in API 代理（需要配置 Plug-in API 服务）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/plugin-api/accounts` | 获取账号列表 |
| POST | `/api/plugin-api/oauth/authorize` | 获取 OAuth 授权 URL |
| GET | `/api/plugin-api/quotas/user` | 获取用户配额信息 |
| POST | `/api/plugin-api/chat/completions` | 聊天补全（OpenAI 兼容） |
| GET | `/api/plugin-api/models` | 获取可用模型列表 |

### OpenAI 兼容接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/v1/models` | 获取模型列表 |
| POST | `/v1/chat/completions` | 聊天补全（流式/非流式） |

### Anthropic 兼容接口

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/v1/messages` | Anthropic Messages API（流式/非流式） |
| POST | `/v1/messages/count_tokens` | 估算输入 Token 数量 |

### Claude Code 兼容接口（/cc/v1）

Claude Code 2.1.9+ 会从 `message_start` 读取 `input_tokens`。由于上游 usage 往往在流末尾才返回，本项目提供 `/cc/v1` 前缀的兼容端点，会缓冲 SSE 并在输出前更正 `message_start` 的 tokens。

Claude Code 配置时，把 Anthropic Base URL 指向 `http://<host>:<port>/cc`（最终请求 `/cc/v1/messages`）。

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/cc/v1/messages` | Claude Code 兼容 Messages（缓冲 SSE，message_start tokens 为真实值） |
| POST | `/cc/v1/messages/count_tokens` | 同 `/v1/messages/count_tokens` |

### 使用统计

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/usage/stats` | 获取使用统计信息 |
| GET | `/api/usage/logs` | 获取使用日志 |

## 无感刷新机制

系统实现了完整的无感刷新（Silent Refresh）机制，让用户无需频繁重新登录。

### 工作原理

1. **登录时**：用户登录成功后，系统返回两个令牌：
   - `access_token`：短期有效（默认24小时），用于API请求认证
   - `refresh_token`：长期有效（默认7天），用于刷新 access_token

2. **API 请求**：使用 `access_token` 进行认证
   ```
   Authorization: Bearer <access_token>
   ```

3. **Token 刷新**：当 `access_token` 即将过期或已过期时，使用 `refresh_token` 获取新的令牌对
   ```bash
   POST /api/auth/refresh
   {
     "refresh_token": "<your_refresh_token>"
   }
   ```

4. **Token 轮换**：每次刷新后，旧的 `refresh_token` 失效，返回新的令牌对（安全机制）

### 前端实现建议

```javascript
// 示例：Axios 拦截器实现无感刷新
axios.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config;
    
    // 如果是 401 错误且不是刷新请求本身
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        // 使用 refresh_token 获取新令牌
        const { data } = await axios.post('/api/auth/refresh', {
          refresh_token: localStorage.getItem('refresh_token')
        });
        
        // 保存新令牌
        localStorage.setItem('access_token', data.access_token);
        localStorage.setItem('refresh_token', data.refresh_token);
        
        // 重试原请求
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
        return axios(originalRequest);
      } catch (refreshError) {
        // 刷新失败，需要重新登录
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);
```

### 登录响应示例

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 86400,
  "user": {
    "id": 1,
    "username": "johndoe",
    "avatar_url": "https://example.com/avatar.jpg",
    "trust_level": 1,
    "is_active": true,
    "is_silenced": false
  }
}
```

### 刷新响应示例

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 86400
}
```

## 使用示例

### 传统登录

```bash
curl -X POST "http://localhost:8008/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your_username",
    "password": "your_password"
  }'
```

### 刷新令牌

```bash
curl -X POST "http://localhost:8008/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "YOUR_REFRESH_TOKEN"
  }'
```

### 获取当前用户信息

```bash
curl "http://localhost:8008/api/auth/me" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 登出

```bash
# 登出当前设备
curl -X POST "http://localhost:8008/api/auth/logout" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "YOUR_REFRESH_TOKEN"
  }'

# 登出所有设备
curl -X POST "http://localhost:8008/api/auth/logout-all" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 创建 API 密钥

```bash
curl -X POST "http://localhost:8008/api/api-keys" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "我的API密钥",
    "description": "用于测试的密钥"
  }'
```

### AI 聊天（需要配置 Plug-in API）

```bash
# 流式聊天
curl -X POST "http://localhost:8008/api/plugin-api/chat/completions" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ],
    "stream": true
  }'

# OpenAI 兼容格式
curl -X POST "http://localhost:8008/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ],
    "stream": false
  }'
```

### 获取配额信息

```bash
curl "http://localhost:8008/api/plugin-api/quotas/user" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## 项目结构

```
antigv-backend/
├── alembic/                      # 数据库迁移脚本
│   ├── versions/                 # 迁移版本文件
│   ├── env.py                    # Alembic 环境配置
│   └── script.py.mako            # 迁移脚本模板
├── app/
│   ├── api/                      # API 路由
│   │   ├── deps.py               # 依赖注入
│   │   ├── deps_flexible.py      # 灵活依赖注入
│   │   └── routes/               # 路由端点
│   │       ├── auth.py           # 认证路由
│   │       ├── health.py         # 健康检查
│   │       ├── plugin_api.py     # Plug-in API 代理
│   │       ├── api_keys.py       # API 密钥管理
│   │       ├── usage.py          # 使用统计
│   │       └── v1.py             # OpenAI 兼容接口
│   ├── cache/                    # Redis 缓存
│   │   └── redis_client.py       # Redis 客户端
│   ├── core/                     # 核心模块
│   │   ├── config.py             # 配置管理
│   │   ├── security.py           # 安全功能
│   │   └── exceptions.py         # 异常定义
│   ├── db/                       # 数据库
│   │   ├── base.py               # Base 类
│   │   └── session.py            # 会话管理
│   ├── models/                   # 数据模型
│   │   ├── user.py               # 用户模型
│   │   ├── api_key.py            # API 密钥模型
│   │   ├── oauth_token.py        # OAuth 令牌模型
│   │   ├── plugin_api_key.py     # Plug-in API 密钥模型
│   │   └── usage_log.py          # 使用日志模型
│   ├── repositories/             # 数据仓储层
│   │   ├── user_repository.py    # 用户仓储
│   │   ├── api_key_repository.py # API 密钥仓储
│   │   ├── oauth_token_repository.py # OAuth 令牌仓储
│   │   └── plugin_api_key_repository.py # Plug-in API 密钥仓储
│   ├── schemas/                  # Pydantic Schemas
│   │   ├── user.py               # 用户 Schema
│   │   ├── auth.py               # 认证 Schema
│   │   ├── api_key.py            # API 密钥 Schema
│   │   ├── token.py              # 令牌 Schema
│   │   └── plugin_api.py         # Plug-in API Schema
│   ├── services/                 # 业务逻辑层
│   │   ├── auth_service.py       # 认证服务
│   │   ├── user_service.py       # 用户服务
│   │   └── plugin_api_service.py # Plug-in API 服务
│   ├── utils/                    # 工具模块
│   │   └── encryption.py         # 加密工具
│   └── main.py                   # 应用入口
├── .env.example                  # 环境变量示例
├── .gitignore                    # Git 忽略文件
├── .python-version               # Python 版本
├── alembic.ini                   # Alembic 配置
├── pyproject.toml                # 项目配置和依赖
├── uv.lock                       # uv 锁定文件
├── run.sh                        # 启动脚本
├── generate_encryption_key.py    # 加密密钥生成工具
├── PLUGIN_API_INTEGRATION.md     # Plug-in API 集成文档
├── plug-in-API.md               # Plug-in API 使用文档
└── README.md                     # 项目文档
```

## 开发指南

### 数据库迁移

```bash
# 创建新的迁移
uv run alembic revision --autogenerate -m "描述信息"

# 应用迁移
uv run alembic upgrade head

# 回滚迁移
uv run alembic downgrade -1

# 查看迁移历史
uv run alembic history

# 查看当前版本
uv run alembic current
```

### 代码风格

项目使用类型注解和文档字符串，请保持一致的代码风格：

- 使用 Python 3.10+ 类型注解
- 所有公共函数和类都需要文档字符串
- 遵循 PEP 8 代码规范
- 使用异步编程模式（async/await）

### 环境配置

 #### 开发环境
 ```bash
 APP_ENV=development
 LOG_LEVEL=DEBUG
 DEBUG_LOG=true
 ```
 
 #### 生产环境
 ```bash
 APP_ENV=production
 LOG_LEVEL=INFO
 DEBUG_LOG=false
 # 确保使用强密码和安全的 JWT 密钥
 # 建议为 Refresh Token 使用独立的密钥
 # 配置适当的 CORS 源
 # 禁用 API 文档
```

### Plug-in API 集成开发

如果要添加新的 Plug-in API 代理端点：

1. 在 `app/services/plugin_api_service.py` 中添加服务方法
2. 在 `app/api/routes/plugin_api.py` 中添加路由
3. 在 `app/schemas/plugin_api.py` 中添加相应的 Schema
4. 更新 API 文档

详细集成说明请参考 [`PLUGIN_API_INTEGRATION.md`](PLUGIN_API_INTEGRATION.md)。

### 测试

```bash
# 运行测试（如果有的话）
uv run pytest

# 运行特定测试
uv run pytest tests/test_auth.py
```

### 部署

#### Docker 部署（推荐）

```dockerfile
FROM python:3.10-slim

WORKDIR /app

COPY . .

RUN pip install uv && uv sync

EXPOSE 8008

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8008"]
```

#### 传统部署

```bash
# 安装依赖
uv sync

# 设置环境变量
export APP_ENV=production

# 运行数据库迁移
uv run alembic upgrade head

# 启动服务
uv run uvicorn app.main:app --host 0.0.0.0 --port 8008 --workers 4
```

## 故障排除

### 常见问题

1. **数据库连接失败**
   - 检查 `DATABASE_URL` 配置
   - 确保 PostgreSQL 服务正在运行
   - 验证数据库用户权限

2. **Redis 连接失败**
   - 检查 `REDIS_URL` 配置
   - 确保 Redis 服务正在运行
   - 验证 Redis 密码（如果有的话）

3. **OAuth 登录失败**
   - 检查 OAuth 客户端 ID 和密钥
   - 验证回调 URL 配置
   - 确保 OAuth 服务器可访问

4. **Plug-in API 功能异常**
   - 检查 `PLUGIN_API_BASE_URL` 配置
   - 验证管理员密钥和加密密钥
   - 确保 Plug-in API 服务正在运行

5. **Token 刷新失败**
   - 检查 `refresh_token` 是否过期（默认7天）
   - 确认 `refresh_token` 未被撤销
   - 验证 Redis 服务正常运行

### 日志查看

```bash
# 查看应用日志
tail -f logs/app.log

# 查看特定级别日志
grep "ERROR" logs/app.log
```

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

### 问题报告

报告问题时请包含：

- 详细的问题描述
- 复现步骤
- 环境信息（操作系统、Python 版本等）
- 相关的错误日志

## 相关文档

- [Plug-in API 集成文档](PLUGIN_API_INTEGRATION.md)
- [Plug-in API 使用文档](plug-in-API.md)
- [FastAPI 官方文档](https://fastapi.tiangolo.com/)
- [SQLAlchemy 文档](https://docs.sqlalchemy.org/)
- [Alembic 文档](https://alembic.sqlalchemy.org/)
