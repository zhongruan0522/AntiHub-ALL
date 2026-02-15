# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AntiHub-ALL 是一个 Docker Compose 单体仓库，整合了 AntiHub 全栈服务：
- **AntiHub/** — Next.js 16 前端 (TypeScript, React 19, Tailwind CSS 4)
- **AntiHub-Backend/** — FastAPI 后端 (Python 3.10+, SQLAlchemy 2.0, Alembic)
- **AntiHook/** — Go 工具程序
- **4-docs/** — This folder contains some project documents. Please check after each implementation to see if any documents need to be updated. 

## 常用命令

### Docker 部署（推荐）
```bash
cp .env.example .env
docker compose up -d

# 仅启动核心三件套（使用外部 PG/Redis）
docker compose -f docker-compose.core.yml up -d

# 手动同步数据库
docker compose -f docker-compose.yml -f docker/docker-compose.db-init.yml run --rm db-init

# 生成加密密钥
docker compose run --rm backend python generate_encryption_key.py
```

### 模块本地开发

**前端 (AntiHub/)**
```bash
cd AntiHub && pnpm install
pnpm dev      # 开发服务器
pnpm build    # 构建
pnpm lint     # ESLint 检查
```

**后端 (AntiHub-Backend/)**
```bash
cd AntiHub-Backend && uv sync
uv run uvicorn app.main:app --reload --port 8008

# 数据库迁移
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "描述"
uv run alembic downgrade -1
```

**Go 工具 (AntiHook/)**
```bash
cd AntiHook
go test ./...
go build ./...
```

## 架构说明

### 服务对接层级
| 层级 | 已对接服务 | 备注 |
|------|-----------|------|
| 后端 (AntiHub-Backend) | CodexCLI, Gemini | 新服务统一对接到这里 |
| 备注 | AntiHub-plugin | 已合并并从仓库移除（历史实现不再维护） |

### 后端架构 (FastAPI)
```
app/
├── api/routes/     # 路由端点（auth, codex, kiro, gemini, v1 等）
├── core/           # 配置(config.py)、安全(security.py)、异常
├── db/             # SQLAlchemy 会话管理
├── models/         # ORM 模型
├── repositories/   # 数据仓储层
├── schemas/        # Pydantic 模型
├── services/       # 业务逻辑层
└── utils/          # 工具函数（加密、转换器等）
```

### 前端架构 (Next.js App Router)
```
app/
├── api/            # API 路由
├── auth/           # 认证页面
├── backend/        # 后端代理路由
└── dashboard/      # 仪表盘页面
```

### 说明：AntiHub-plugin

历史上仓库包含 `AntiHub-plugin/`（Node 代理/插件服务），用于承载部分上游对接逻辑；当前已迁移并从仓库移除，运行时默认不再部署 plugin。

## 代码规范

- **TypeScript**: 组件用 PascalCase，变量/函数用 camelCase
- **Python**: 4 空格缩进，异步路由保持非阻塞，类型注解
- **Go**: 运行 `gofmt` 格式化
- **提交信息**: `<type>: <summary>`（feat:, fix:, !表示破坏性变更）

## 环境变量

必须配置的密钥（在 `.env` 中）：
- `JWT_SECRET_KEY` — JWT 签名密钥
- `PLUGIN_API_ENCRYPTION_KEY` — Fernet 加密密钥（32字节 base64）

可选配置：
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — 首次启动自动创建管理员
- `CODEX_SUPPORTED_MODELS` — 覆盖 Codex 模型列表
- `CODEX_PROXY_URL` — Codex 出站代理

## 测试

目前没有统一的测试运行器。验证方式：
1. Docker 冒烟测试：`docker compose up`
2. 手动验证受影响的 UI 路由 / API 端点

## API 文档

后端启动后访问：
- Swagger UI: `http://localhost:8008/api/docs`
- ReDoc: `http://localhost:8008/api/redoc`

## 注意事项

- 前端已内置 `/backend/* -> http://backend:8000/*` 转发
- 生产环境 API 文档会被禁用
