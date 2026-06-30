FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml .
COPY src ./src
RUN uv pip install --system . && uv pip install --system langchain-core langchain-mcp-adapters langgraph
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "xihe_agent.main:app", "--host", "0.0.0.0", "--port", "8000"]
