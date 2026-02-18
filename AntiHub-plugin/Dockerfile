FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Create non-root user to match existing deployment conventions (e.g. `--user appuser`)
ARG UID=10001
ARG GID=10001
RUN groupadd --gid $GID appgroup && \
    useradd --uid $UID --gid $GID --shell /bin/bash --create-home appuser

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh && \
    ln -sf /usr/local/bin/entrypoint.sh /entrypoint.sh

USER appuser

EXPOSE 8045

CMD ["/usr/local/bin/entrypoint.sh"]
