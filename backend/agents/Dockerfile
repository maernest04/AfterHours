FROM python:3.12-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://astral.sh/uv/0.9.24/install.sh -o /tmp/uv-install.sh \
    && UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh /tmp/uv-install.sh \
    && rm /tmp/uv-install.sh
# Official standalone release, pinned and checksum-verified; no Node app runtime.
ARG DROID_VERSION=0.249.0
RUN case "$TARGETARCH" in arm64) droid_arch=arm64 ;; amd64) droid_arch=x64 ;; *) exit 1 ;; esac \
    && base="https://downloads.factory.ai/factory-cli/releases/${DROID_VERSION}/linux/${droid_arch}" \
    && curl -fsSL "$base/droid" -o /tmp/droid \
    && curl -fsSL "$base/droid.sha256" -o /tmp/droid.sha256 \
    && cd /tmp && checksum="$(awk '{print $1}' droid.sha256)" \
    && echo "$checksum  droid" | sha256sum --check \
    && install -m 755 droid /usr/local/bin/droid \
    && rm droid droid.sha256
WORKDIR /app
COPY backend/db/pyproject.toml /app/backend/db/pyproject.toml
COPY backend/db/src /app/backend/db/src
COPY backend/agents/pyproject.toml backend/agents/uv.lock /app/backend/agents/
COPY backend/agents/src /app/backend/agents/src
RUN uv sync --project backend/agents --frozen --no-dev
COPY backend/orchestrator/pyproject.toml /app/backend/orchestrator/pyproject.toml
COPY backend/orchestrator/src /app/backend/orchestrator/src
RUN uv pip install --python /app/backend/agents/.venv/bin/python --no-deps /app/backend/orchestrator
ENV PATH="/app/backend/agents/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["afterhours-matching"]
