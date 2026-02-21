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
- https://github.com/AntiHub-Project/Backend
- https://github.com/AntiHub-Project/Antigv-plugin （本仓库已将 plugin **运行时能力**合并进 Backend；`AntiHub-plugin/` 仅保留为“迁移助手”，不作为运行时服务部署）

默认 `docker-compose.yml` 自带 PostgreSQL + Redis，你主要只需要配置你自己的密钥；如果你想接入外部 PG/Redis，用 `docker-compose.core.yml`（只启动 web + backend）。

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

## 一键部署

Linux 运行 `deploy.sh` 即可（会先启动 `postgres/redis`，同步/初始化 Backend 主数据库，再启动 web/backend；如需迁移旧 plugin DB，请看下方“升级/迁移（可选）”）。

脚本支持交互菜单：

```bash
chmod +x deploy.sh
./deploy.sh
```

也支持直接指定命令（方便写到教程/自动化脚本里）：

```bash
./deploy.sh deploy     # 1) 一键部署（首次部署/重装）
./deploy.sh upgrade    # 2) 升级（仅升级 web/backend，不操作数据库）
./deploy.sh uninstall  # 3) 卸载（停止并删除容器，可选删除数据卷）
```

## 快速开始

1) 配置环境变量：

```bash
cp .env.example .env
```

**重要提示**：`.env.example` 中包含示例密钥，仅用于开发/测试。生产环境部署时，请务必生成新的密钥：

```bash
# 生成 Fernet 加密密钥（用于加密存储上游 API Key 等敏感数据）
docker compose run --rm backend python generate_encryption_key.py

# 或使用 openssl 生成其他密钥
openssl rand -base64 32  # 用于 JWT_SECRET_KEY
```

然后更新 `.env` 文件中的以下配置：
- `JWT_SECRET_KEY` - JWT 令牌签名密钥
- `PLUGIN_API_ENCRYPTION_KEY` - Fernet 加密密钥（用于加密存储用户 API 密钥）

2) 启动：

```bash
docker compose up -d
```

> 如果你自带 PostgreSQL/Redis：使用 `docker-compose.core.yml` 只启动 web + backend（并在 `.env` 中配置 `DATABASE_URL` 与 `REDIS_URL`）。

3) 访问前端：

- 直连：`http://localhost:3000`（或你在 `.env` 里设置的 `WEB_PORT`）
- 或者用你自己的反代把域名转发到前端端口

## 鸣谢

- [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [KiroGate](https://github.com/aliom-v/KiroGate)
- [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API)
- [Kiro.rs](https://github.com/hank9999/kiro.rs)
- [Kiro-account-manager](https://github.com/hj01857655/kiro-account-manager)