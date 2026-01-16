[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=for-the-badge&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/zhongruan0522/AntiHub-ALL)

# AntiHub-ALL Docker 部署

原项目地址：
- https://github.com/AntiHub-Project/AntiHub
- https://github.com/AntiHub-Project/Antigv-plugin
- https://github.com/AntiHub-Project/Backend

这个仓库把 `AntiHub`（前端）、`AntiHub-Backend`（后端）、`AntiHub-plugin`（插件服务）统一成一套 `docker compose` 部署。

目标很简单：三者之间的内部地址/端口都已经预置好；默认 `docker-compose.yml` 自带 PostgreSQL + Redis，你主要只需要配置你自己的密钥；如果你想接入外部 PG/Redis，用 `docker-compose.core.yml`。

另外：前端已内置 `/backend/* -> http://backend:8000/*` 转发，所以你不需要单独给 Nginx 配 `/backend/` 的反代规则（当然你想配也行）。

## 当前2API

1. Antigravity：已完全支持
2. Kiro-OAuth(GitHub/Google): 已完全支持
3. Kiro-Token: 已完全支持
4. Kiro-AWS IMA: 已完全支持
5. QwenCli: 已完成开发，待测试

## 你需要准备

- 必配：你自己的密钥（`JWT_SECRET_KEY`、`PLUGIN_ADMIN_API_KEY`、`PLUGIN_API_ENCRYPTION_KEY`）
- 可选：外部 PostgreSQL / Redis（如果你不想用 compose 自带的）

## 快速开始

1) 配置环境变量：

```bash
cp .env.example .env
```

2) 启动：

```bash
docker compose up -d
```

> 只启动基础的三件套`docker compose -f docker-compose.core.yml up -d `

**注意**：插件服务会在首次启动时自动检测并初始化数据库，无需手动导入 `schema.sql`。

3) 访问前端：

## Login

- Username/password: set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`, restart backend once, then visit `/auth` to sign in

- 直连：`http://localhost:3000`（或你在 `.env` 里设置的 `WEB_PORT`）
- 或者用你自己的反代把域名转发到前端端口

## 生成 PLUGIN_API_ENCRYPTION_KEY

```bash
docker compose run --rm backend python generate_encryption_key.py
```

## 镜像构建（GitHub Actions）

工作流：`.github/workflows/docker-images.yml`

会构建并推送到 GHCR：

- `ghcr.io/<owner>/antihub-web`
- `ghcr.io/<owner>/antihub-backend`
- `ghcr.io/<owner>/antihub-plugin`

默认分支推 `latest`，同时推 `sha` 标签；打 `v*` tag 会推对应 tag。

## 鸣谢

- [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) - 提供AN渠道的Token导入代码
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - 提供了AN渠道的429修复
- [KiroGate](https://github.com/aliom-v/KiroGate) - Kiro渠道的Token导入、思考支持
- [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) - Kiro AWS IMA账户导入代码
