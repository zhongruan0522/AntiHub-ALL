# ============================================
# AntiHub-Backend Dockerfile
# ============================================

# ============ 构建阶段 ============
FROM python:3.10-slim-bookworm AS builder

WORKDIR /build

# 安装 uv（超快的 Python 包管理器）
RUN pip install uv --no-cache

# 复制依赖文件
COPY pyproject.toml uv.lock* ./

# 安装依赖到虚拟环境（使用 lock，且不尝试安装本项目本身）
RUN uv venv /opt/venv && \
    . /opt/venv/bin/activate && \
    uv sync --frozen --no-dev --active --no-install-project

# ============ 运行阶段 ============
FROM python:3.10-slim-bookworm AS runner

WORKDIR /app

# 创建非 root 用户（安全最佳实践）
ARG UID=10001
ARG GID=10001
RUN groupadd --gid $GID appgroup && \
    useradd --uid $UID --gid $GID --shell /bin/bash --create-home appuser

# 复制虚拟环境
COPY --from=builder /opt/venv /opt/venv

# 复制应用代码
COPY . .

# 设置虚拟环境
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/api/health', timeout=5)" || exit 1

# 启动命令
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
