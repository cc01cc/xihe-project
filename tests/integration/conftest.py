"""
跨模块集成测试 conftest。
如果 Docker Compose 已运行，直接使用已有的服务；
否则启动服务。
"""
import os
import httpx
import pytest

CP_URL = os.environ.get("XIHE_CP_URL", "http://localhost:8080")
AGENT_URL = os.environ.get("XIHE_AGENT_URL", "http://localhost:8000")
RUNTIME_URL = os.environ.get("XIHE_RUNTIME_URL", "http://localhost:8001")

def _check_service(url: str, timeout: int = 3) -> bool:
    try:
        r = httpx.get(f"{url}/health", timeout=timeout) if "health" not in url else httpx.get(url, timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False

@pytest.fixture(scope="session")
def backend_stack():
    """返回已运行的服务 URL（Docker Compose 已启动）。"""
    # 验证 CP 可达
    if not _check_service(f"{CP_URL}/actuator/health"):
        pytest.skip("CP not running at " + CP_URL)
    
    return {
        "cp_url": CP_URL,
        "agent_url": AGENT_URL,
        "runtime_url": RUNTIME_URL,
    }
