from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUN_WITH_LOG = PROJECT_ROOT / "scripts" / "run-with-log.sh"
TEST_LOG_DIR = PROJECT_ROOT / "logs" / "test-stack"
LOCAL_HOST = "127.0.0.1"
STARTUP_TIMEOUT_SECONDS = float(os.environ.get("XIHE_TEST_STARTUP_TIMEOUT", "180"))
POLL_INTERVAL_SECONDS = 1.0


def _resolve_env_path(path_value: str) -> Path:
    candidate = Path(path_value)
    if candidate.is_absolute():
        return candidate
    return PROJECT_ROOT / candidate


def _resolve_env_files() -> list[Path]:
    explicit_env = os.environ.get("XIHE_ENV_FILE") or os.environ.get("XIHE_TEST_ENV_FILE")
    if explicit_env:
        return [_resolve_env_path(explicit_env)]

    profile = os.environ.get("XIHE_ENV", "test").strip()
    env_files = [PROJECT_ROOT / ".env"]
    if profile:
        env_files.append(PROJECT_ROOT / f".env.{profile}")
    env_files.append(PROJECT_ROOT / ".env.local")
    if profile:
        env_files.append(PROJECT_ROOT / f".env.{profile}.local")
    return env_files


def _load_env_files(env_files: list[Path]) -> dict[str, str]:
    loaded: dict[str, str] = {}
    for env_file in env_files:
        if not env_file.exists():
            continue

        for raw_line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            name, _, raw_value = line.partition("=")
            name = name.removeprefix("export ").strip()
            value = raw_value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            loaded[name] = value

    return loaded


def _build_stack_env(workspace: Path) -> dict[str, str]:
    env = os.environ.copy()
    profile = os.environ.get("XIHE_ENV", "test")
    env.update(_load_env_files(_resolve_env_files()))

    cp_port = os.environ.get("XIHE_TEST_CP_PORT") or env.get("XIHE_CP_PORT") or "18080"
    agent_port = os.environ.get("XIHE_TEST_AGENT_PORT") or env.get("XIHE_AGENT_PORT") or "18000"
    runtime_port = os.environ.get("XIHE_TEST_RUNTIME_PORT") or env.get("XIHE_RUNTIME_PORT") or "19091"
    ui_port = os.environ.get("XIHE_TEST_UI_PORT") or env.get("XIHE_UI_PORT") or "15173"

    for proxy_name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]:
        env.pop(proxy_name, None)

    env.update(
        {
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "XIHE_LOAD_DOTENV": "0",
            "XIHE_ENV": profile,
            "XIHE_LOG_DIR": str(TEST_LOG_DIR),
            "XIHE_CP_PORT": cp_port,
            "XIHE_AGENT_PORT": agent_port,
            "XIHE_RUNTIME_PORT": runtime_port,
            "XIHE_UI_PORT": ui_port,
            "XIHE_CP_URL": f"http://{LOCAL_HOST}:{cp_port}",
            "XIHE_CP_BASE_URL": f"http://{LOCAL_HOST}:{cp_port}",
            "XIHE_AGENT_URL": f"http://{LOCAL_HOST}:{agent_port}/internal/v1/agent/chat",
            "XIHE_RUNTIME_URL": f"http://{LOCAL_HOST}:{runtime_port}/mcp",
            "XIHE_AGENT_HOST": LOCAL_HOST,
            "XIHE_RUNTIME_HOST": LOCAL_HOST,
            "XIHE_WORKSPACE": str(workspace),
        }
    )
    env.setdefault("XIHE_LOG_LEVEL", "info")
    return env


def _stack_urls(env: dict[str, str]) -> dict[str, str]:
    return {
        "cp_url": env["XIHE_CP_URL"],
        "agent_url": f"http://{LOCAL_HOST}:{env['XIHE_AGENT_PORT']}",
        "runtime_url": f"http://{LOCAL_HOST}:{env['XIHE_RUNTIME_PORT']}",
        "ui_url": f"http://{LOCAL_HOST}:{env['XIHE_UI_PORT']}",
    }


def _read_log_tail(module_name: str) -> str:
    log_file = TEST_LOG_DIR / f"{module_name}.log"
    if not log_file.exists():
        return f"(missing log file: {log_file})"

    lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-40:])


def _start_service(module_name: str, cwd: Path, command: list[str], env: dict[str, str]) -> subprocess.Popen[str]:
    TEST_LOG_DIR.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    return process


def _stop_service(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def _wait_for(description: str, probe: Any) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except Exception as exc:  # pragma: no cover - exercised in failure paths
            last_error = exc

        time.sleep(POLL_INTERVAL_SECONDS)

    if last_error is None:
        raise RuntimeError(f"Timed out waiting for {description}")
    raise RuntimeError(f"Timed out waiting for {description}: {last_error}")


def _runtime_ready(runtime_url: str) -> bool:
    response = httpx.post(
        runtime_url,
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "stack-test", "version": "0.1.0"},
            },
            "id": 1,
        },
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        timeout=5,
        trust_env=False,
    )
    return response.status_code == 200 and "mcp-session-id" in response.headers


def _cp_ready(cp_url: str) -> bool:
    response = httpx.get(f"{cp_url}/actuator/health", timeout=5, trust_env=False)
    return response.status_code == 200 and response.json().get("status") == "UP"


def _agent_ready(agent_url: str) -> bool:
    response = httpx.get(f"{agent_url}/internal/v1/agent/health", timeout=5, trust_env=False)
    data = response.json()
    return (
        response.status_code == 200
        and data.get("liveness") == "up"
        and data.get("llmReady") == "ready"
        and data.get("mcpInitialized") is False
        and data.get("toolsCount") == 0
    )


def _ui_ready(ui_url: str) -> bool:
    response = httpx.get(ui_url, timeout=5, trust_env=False)
    return response.status_code == 200 and "text/html" in response.headers.get("content-type", "")


@pytest.fixture(scope="session")
def backend_stack() -> dict[str, Any]:
    services: list[tuple[str, subprocess.Popen[str]]] = []

    with TemporaryDirectory(prefix="xihe-workspace-") as workspace_dir:
        workspace = Path(workspace_dir)
        (workspace / "src").mkdir(parents=True, exist_ok=True)
        (workspace / "test.txt").write_text("Hello from xihe workspace\n", encoding="utf-8")

        env = _build_stack_env(workspace)
        urls = _stack_urls(env)

        try:
            runtime_process = _start_service(
                "runtime",
                PROJECT_ROOT / "packages" / "runtime",
                ["bash", str(RUN_WITH_LOG), "runtime", "cargo", "run"],
                env,
            )
            services.append(("runtime", runtime_process))
            _wait_for("runtime", lambda: _runtime_ready(urls["runtime_url"]))

            cp_process = _start_service(
                "cp",
                PROJECT_ROOT / "packages" / "control-plane",
                ["bash", str(RUN_WITH_LOG), "cp", "mvn", "spring-boot:run"],
                env,
            )
            services.append(("cp", cp_process))
            _wait_for("control plane", lambda: _cp_ready(urls["cp_url"]))

            agent_process = _start_service(
                "agent",
                PROJECT_ROOT / "packages" / "agent",
                ["bash", str(RUN_WITH_LOG), "agent", "uv", "run", "python", "-m", "xihe_agent.main"],
                env,
            )
            services.append(("agent", agent_process))
            _wait_for("agent", lambda: _agent_ready(urls["agent_url"]))

            yield {
                **urls,
                "env": env,
                "workspace": workspace,
            }
        except Exception as exc:
            log_dump = "\n\n".join(
                f"[{name}.log]\n{_read_log_tail(name)}" for name, _ in services
            )
            raise RuntimeError(f"Failed to start backend stack: {exc}\n\n{log_dump}") from exc
        finally:
            for _, process in reversed(services):
                _stop_service(process)


@pytest.fixture(scope="session")
def ui_stack(backend_stack: dict[str, Any]) -> dict[str, Any]:
    env = dict(backend_stack["env"])
    ui_process = _start_service(
        "ui",
        PROJECT_ROOT / "packages" / "ui",
        ["bash", str(RUN_WITH_LOG), "ui", "pnpm", "--ignore-workspace", "run", "dev"],
        env,
    )

    try:
        _wait_for("ui", lambda: _ui_ready(backend_stack["ui_url"]))
        yield backend_stack
    except Exception as exc:
        log_dump = _read_log_tail("ui")
        raise RuntimeError(f"Failed to start ui stack: {exc}\n\n[ui.log]\n{log_dump}") from exc
    finally:
        _stop_service(ui_process)
