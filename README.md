<h1 align="center">Antihub-ALL</h1>

<p align="center">
  <a href="https://github.com/zhongruan0522/AntiHub-ALL/stargazers">
    <img src="https://img.shields.io/github/stars/zhongruan0522/AntiHub-ALL?style=for-the-badge&logo=github&logoColor=white&labelColor=24292e&color=ffc107" alt="GitHub Stars" />
  </a>
  <a href="https://qm.qq.com/q/DT7fJCsCoS">
    <img src="https://img.shields.io/badge/QQ群-937931004-blue?style=for-the-badge&logo=tencentqq&logoColor=white&labelColor=12b7f5&color=12b7f5" alt="QQ群" />
  </a>
  <a href="https://zread.ai/zhongruan0522/AntiHub-ALL">
    <img src="https://img.shields.io/badge/Zread-Ask_AI-00b0aa?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=white" alt="Zread AI" />
  </a>
  <a href="https://deepwiki.com/zhongruan0522/AntiHub-ALL">
    <img src="https://img.shields.io/badge/DeepWiki-Docs-6366f1?style=for-the-badge&logo=gitbook&logoColor=white" alt="DeepWiki" />
  </a>
</p>

# AntiHub-ALL Docker 部署

原项目地址：
- https://github.com/AntiHub-Project/AntiHub
- https://github.com/AntiHub-Project/Antigv-plugin
- https://github.com/AntiHub-Project/Backend

这个仓库把 `AntiHub`（前端）、`AntiHub-Backend`（后端）、`AntiHub-plugin`（插件服务）统一成一套 `docker compose` 部署。目标很简单：三者之间的内部地址/端口都已经预置好；默认 `docker-compose.yml` 自带 PostgreSQL + Redis，你主要只需要配置你自己的密钥；如果你想接入外部 PG/Redis，用 `docker-compose.core.yml`。

## 注意事项

当前参考 [Kiro.rs](https://github.com/hank9999/kiro.rs) 对最新版本CC的修复，Antihub-ALL同步了`/backend/cc`为CC特化端口，再次鸣谢相关参考项目

## 当前2API

1. Antigravity：已完全支持
2. Kiro-OAuth(GitHub/Google): 已完全支持
3. Kiro-Token: 已完全支持
4. Kiro-AWS IMA: 已完全支持
5. QwenCli: 已完成开发，待测试
6. CodexCLI: 已完全支持
7. GeminiCLI： 已完全支持
8. ZAI-TTS: 已完成开发，待测试
9. ZAI-IMAGE：已完成支持

## 你需要准备

- 必配：你自己的密钥（`JWT_SECRET_KEY`、`PLUGIN_ADMIN_API_KEY`、`PLUGIN_API_ENCRYPTION_KEY`）
- 可选：外部 PostgreSQL / Redis（如果你不想用 compose 自带的）
- 可选：`KIRO_IDE_VERSION`（Kiro 请求 User-Agent 版本；默认内置 `0.9.2`）
- 可选：`KIRO_USAGE_LIMITS_SYNC_INTERVAL_SECONDS` / `KIRO_USAGE_LIMITS_429_COOLDOWN_SECONDS`（Kiro 剩余额度同步节流；默认 300s，避免频繁调用 `/getUsageLimits` 触发 429）

## 一键部署

Linux 运行 `deploy.sh` 即可（会先启动 `postgres/redis`，同步/初始化两个数据库，再启动主服务；默认 plugin 复用 PostgreSQL 超管账号）。

脚本支持交互菜单：

```bash
chmod +x deploy.sh
./deploy.sh
```

也支持直接指定命令（方便写到教程/自动化脚本里）：

```bash
./deploy.sh deploy     # 1) 一键部署（首次部署/重装）
./deploy.sh upgrade    # 2) 升级（仅升级 web/backend/plugin，不操作数据库）
./deploy.sh uninstall  # 3) 卸载（停止并删除容器，可选删除数据卷）
```

如需手动同步（复用旧数据卷但重写了 `.env` 密码时很有用）：

```bash
docker compose -f docker-compose.yml -f docker/docker-compose.db-init.yml run --rm db-init
```

## 快速开始

1) 配置环境变量：

```bash
cp .env.example .env
```

**重要提示**：`.env.example` 中包含示例密钥，仅用于开发/测试。生产环境部署时，请务必生成新的密钥：

```bash
# 生成加密密钥
docker compose run --rm backend python generate_encryption_key.py

# 或使用 openssl 生成其他密钥
openssl rand -base64 32  # 用于 JWT_SECRET_KEY
openssl rand -hex 32     # 用于 PLUGIN_ADMIN_API_KEY
```

然后更新 `.env` 文件中的以下配置：
- `JWT_SECRET_KEY` - JWT 令牌签名密钥
- `PLUGIN_ADMIN_API_KEY` - Plugin 管理 API 密钥
- `PLUGIN_API_ENCRYPTION_KEY` - Fernet 加密密钥（用于加密存储用户 API 密钥）

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

## 鸣谢

- [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) - 提供AN渠道的Token导入代码
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - 提供了AN渠道的429修复
- [KiroGate](https://github.com/aliom-v/KiroGate) - Kiro渠道的Token导入、思考支持
- [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) - Kiro AWS IMA账户导入代码
- [ZAI-TTS2API](https://github.com/aahl/zai-tts2api) - ZAI-TTS对接代码
- [Kiro.rs](https://github.com/hank9999/kiro.rs) - CC2.1.19新字段解析方法代码
