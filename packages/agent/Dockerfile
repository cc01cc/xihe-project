FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml .
COPY uv.toml .
COPY uv.lock .
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev
EXPOSE 8000
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "xihe_agent.main:app", "--host", "0.0.0.0", "--port", "8000"]
