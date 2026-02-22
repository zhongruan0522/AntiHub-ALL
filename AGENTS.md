# Repository Guidelines

## Project Structure

This repository is a Docker Compose monorepo that ships a working AntiHub stack:

- `AntiHub/` — Next.js (TypeScript) web UI
- `AntiHub-Backend/` — FastAPI backend (Python, Alembic migrations)
- `AntiHook/` — Tauri v2 desktop GUI (Rust + React/Vite)
- `docker/` — Compose helpers (e.g. DB init scripts)
- `4-docs/` — This folder contains some project documents. Please check after each implementation to see if any documents need to be updated. 

Top-level deployment files live at the repo root: `docker-compose.yml`, `docker-compose.core.yml`, `deploy.sh`, `.env.example`.

## Build, Test, and Development Commands

Preferred local flow is via Docker:

```bash
cp .env.example .env
docker compose up -d
```

Use `docker-compose.core.yml` when you provide your own Postgres/Redis:

```bash
docker compose -f docker-compose.core.yml up -d
```

Module development (run inside each folder):

- Web: `cd AntiHub && pnpm install && pnpm dev` (lint: `pnpm lint`, build: `pnpm build`)
- Backend: `cd AntiHub-Backend && uv sync && uv run uvicorn app.main:app --reload`
- Desktop (AntiHook): `cd AntiHook && npm install && npm run tauri dev` (frontend-only build: `npm run build`)

**AntiHub 对接备注：**
AntiHub-plugin：✅ 旧 Node plugin 已合并进 Backend；`AntiHub-plugin/` 仅作为迁移助手（Env Exporter），运行时默认不部署

## Coding Style & Naming Conventions

- Keep changes scoped to the module you touch; follow existing patterns in that folder.
- TypeScript: React components in `PascalCase`, variables/functions in `camelCase`; run `pnpm lint`.
- Python: 4-space indentation; keep async routes non-blocking; migrations live in `AntiHub-Backend/alembic/`.
- Rust: run `cargo fmt` on modified files (AntiHook `src-tauri/`).

Generated artifacts should not be committed (see each module’s `.gitignore`): `.next/`, `node_modules/`, `.venv/`, `__pycache__/`, and `AntiHook/src-tauri/target/`.

## Testing Guidelines

There is no single repo-wide test runner today. For changes, run a Docker smoke test (`docker compose up`) and manually verify the affected UI route / API endpoint.

## Commit & Pull Request Guidelines

Commit messages generally follow `<type>: <summary>` (common types: `feat:`, `fix:`; `!` indicates breaking changes). PRs should include: what changed, how to verify (exact commands), and screenshots for UI changes. If you add environment variables, update the relevant `*.example` files and document defaults.
