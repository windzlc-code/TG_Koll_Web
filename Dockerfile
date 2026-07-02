FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    PATH="/opt/venv/bin:$PATH" \
    WEBAPP_DATA_DIR=/data/webapp_data \
    APP_RUNTIME_CONFIG_PATH=/data/webapp_data/runtime_config.json \
    TG_WORKBENCH_DB_PATH=/data/webapp_data/workbench.db \
    TOOL_R18_RUNTIME_DIR=/data/tool_r18_runtime \
    AUTO_TWEET_RUNTIME_DIR=/data/tool_r18_runtime \
    TOOL_R18_TELEGRAM_BOT_TOKEN_FILE=/data/tool_r18_runtime/telegram_bot_token.txt \
    TOOL_R18_LOCAL_BOT_ENV_PATH=/data/tool_r18_runtime/local-bot.env \
    TOOL_R18_INTERNAL_WEBAPP_BASE_URL=http://127.0.0.1:8098 \
    TELEGRAM_WEBHOOK_PORT=8788 \
    TELEGRAM_PROXY_URL=direct

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl ffmpeg libgl1 libglib2.0-0 libgomp1 \
       python3 python3-pip python3-venv build-essential sqlite3 \
    && python3 -m venv /opt/venv \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /app/requirements.txt

COPY tool_r18/package*.json /app/tool_r18/
WORKDIR /app/tool_r18
RUN npm ci \
    && npx playwright install --with-deps chromium

WORKDIR /app
COPY . /app
RUN chmod +x /app/docker/entrypoint.sh

VOLUME ["/data"]
EXPOSE 8098
EXPOSE 8788

ENTRYPOINT ["/app/docker/entrypoint.sh"]
