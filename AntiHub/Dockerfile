# syntax=docker/dockerfile:1.6

# ============================================
# Build Stage - 安装依赖并构建应用
# ============================================
FROM node:20-alpine AS builder

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖 (只安装生产依赖)
RUN pnpm install --frozen-lockfile --prod=false

# 复制源代码
COPY . .

RUN pnpm build

# ============================================
# Production Stage - 最终运行时镜像
# ============================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# 创建非 root 用户 (安全)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 复制构建产物
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# 复制 .env 文件 (运行时挂载)
# 注意：敏感信息应该通过环境变量或 Secret 注入
# COPY --from=builder /app/.env.production ./.env

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 启动应用
CMD ["node", "server.js"]
