# AntiHub-ALL Docker 部署

这个仓库把 `AntiHub`（前端）、`AntiHub-Backend`（后端）、`AntiHub-plugin`（插件服务）统一成一套 `docker compose` 部署。

目标很简单：三者之间的内部地址/端口都已经预置好，你只需要配置外部依赖（现成的 PostgreSQL）和你自己的密钥。

另外：前端已内置 `/backend/* -> http://backend:8000/*` 转发，所以你不需要单独给 Nginx 配 `/backend/` 的反代规则（当然你想配也行）。

## 你需要准备

- PostgreSQL：一套你现成的 PG（建议两个数据库：`antihub` 给后端用，`antigravity` 给插件用）
- Redis：默认 compose 自带一个；如果你有现成 Redis，可在 `.env` 里覆盖相关变量

## 快速开始

1) 配置环境变量：

```bash
cp .env.example .env
```

2) 初始化插件数据库（只需要做一次）：把 `AntiHub-plugin/schema.sql` 导入到你配置的插件库（默认库名 `antigravity`）。

3) 启动：

```bash
docker compose up -d
```

4) 访问前端：

## Login

- Recommended: Linux.do / GitHub SSO (first login auto-creates the user)
- Username/password: set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`, restart backend once, then visit `/auth` to sign in

- 直连：`http://localhost:3000`（或你在 `.env` 里设置的 `WEB_PORT`）
- 或者用你自己的反代把域名转发到前端端口

## 回调地址（PUBLIC_URL）

- Linux.do：`${PUBLIC_URL}/api/auth/callback`
- GitHub：`${PUBLIC_URL}/api/auth/github/callback`

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
