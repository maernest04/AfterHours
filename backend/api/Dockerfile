FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ADD https://astral.sh/uv/0.9.24/install.sh /tmp/uv-install.sh
RUN UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh /tmp/uv-install.sh \
    && rm /tmp/uv-install.sh
WORKDIR /app
COPY backend/api/requirements.txt /app/requirements.txt
COPY backend/db/pyproject.toml /app/backend/db/pyproject.toml
COPY backend/db/src /app/backend/db/src
RUN uv pip install --system --no-cache -r requirements.txt
COPY backend/api/*.py /app/api/
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
