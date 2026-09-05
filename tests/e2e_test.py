#!/usr/bin/env python3
"""
xihe 端到端集成测试：启动 CP → Agent → Runtime，发送聊天消息，验证 SSE 响应。

用法：
  source .env.dev
  python3 tests/e2e_test.py
"""
import asyncio
import json
import subprocess
import signal
import time
import httpx
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CP_DIR = ROOT / "packages/control-plane"
AGENT_DIR = ROOT / "packages/agent"
RUNTIME_DIR = ROOT / "packages/runtime"
CP_URL = "http://localhost:8080"

SERVICES = []

def log(msg):
    print(f"[e2e] {msg}", flush=True)

async def start_service(name, cwd, cmd, env=None):
    log(f"Starting {name}...")
    proc = await asyncio.create_subprocess_shell(
        cmd, cwd=cwd, env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    SERVICES.append((name, proc))
    await asyncio.sleep(2)  # 等待启动
    return proc

async def check_health(url, name, retries=10):
    for i in range(retries):
        try:
            async with httpx.AsyncClient() as c:
                r = await c.get(url, timeout=5)
                if r.status_code == 200:
                    log(f"✅ {name} ready at {url}")
                    return True
        except Exception:
            pass
        await asyncio.sleep(2)
    log(f"❌ {name} not ready after {retries*2}s")
    return False

async def test_chat_sse():
    """发送聊天消息，验证 SSE 事件流"""
    log("\n=== 测试 Chat SSE 流 ===")
    
    # 1. 注册用户
    async with httpx.AsyncClient(trust_env=False) as c:
        reg = await c.post(f"{CP_URL}/api/v1/auth/register", json={
            "email": "e2e@test.com", "password": "Pass1234!", "name": "E2E"
        })
        if reg.status_code != 201:
            log(f"⚠️ 注册失败 ({reg.status_code})，尝试登录...")
            login = await c.post(f"{CP_URL}/api/v1/auth/login", json={
                "email": "e2e@test.com", "password": "Pass1234!"
            })
            if login.status_code != 200:
                log("❌ 登录也失败，跳过 chat 测试")
                return False
            auth = login.json()
        else:
            auth = reg.json()

        headers = {
            "Authorization": f"Bearer {auth['accessToken']}",
            "X-Workspace-Id": auth["workspaceId"],
            "Content-Type": "application/json",
        }
        session = await c.post(f"{CP_URL}/api/v1/sessions", json={"title": "E2E"}, headers=headers)
        if session.status_code != 201:
            log(f"❌ 创建 session 失败 ({session.status_code})")
            return False
        session_id = session.json()["id"]
    
        log("✅ 认证成功")

        # 2. Subscribe before sending the chat request.
        log("等待 SSE 事件...")
        try:
            async with c.stream(
                "GET", f"{CP_URL}/api/v1/events?sessionId={session_id}", headers=headers, timeout=30
            ) as resp:
                if resp.status_code != 200:
                    log(f"❌ SSE 连接失败 ({resp.status_code})")
                    return False
                events = []
                chat_sent = False
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = json.loads(line[6:])
                    event_type = data["type"]
                    events.append(event_type)
                    if event_type == "connected" and not chat_sent:
                        chat_resp = await c.post(
                            f"{CP_URL}/api/v1/chat",
                            json={"content": "用中文说你好", "sessionId": session_id, "toolMode": "none"},
                            headers=headers,
                        )
                        if chat_resp.status_code != 202:
                            log(f"⚠️ Chat 响应: {chat_resp.status_code}")
                            return False
                        log("✅ Chat 请求接受 (202)")
                        chat_sent = True
                    if event_type == "done":
                        break

                log(f"SSE 事件序列: {' → '.join(events)}")
                assert "token" in events, "缺少 token 事件"
                assert "done" in events, "缺少 done 事件"
                log("✅ SSE 流验证通过!")
                return True
        except Exception as e:
            log(f"❌ SSE 流错误: {e}")
            return False

async def test_health_endpoints():
    """验证所有模块健康检查"""
    log("\n=== 验证健康检查 ===")
    
    endpoints = [
        ("CP", f"{CP_URL}/actuator/health"),
        ("Agent", "http://localhost:8000/internal/v1/agent/health"),
        ("Runtime", "http://localhost:8001/health"),
    ]
    
    all_ok = True
    for name, url in endpoints:
        ok = await check_health(url, name, retries=3)
        if not ok:
            all_ok = False
    return all_ok

async def main():
    env = {
        **{k: v for k, v in (l.split("=", 1) for l in open(ROOT / ".env.dev").read().splitlines() if l.strip() and not l.startswith("#"))},
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "JAVA_HOME": "/usr/lib/jvm/msjdk-25",
    }
    env["XIHE_CP_AUDIT_LOG_TO_CONSOLE"] = "false"
    
    try:
        # Start services
        await start_service("CP", CP_DIR, 
            "mvn spring-boot:run -q", env)
        await asyncio.sleep(5)
        
        await start_service("Agent", AGENT_DIR,
            "uv run uvicorn xihe_agent.main:app --port 8000", env)
        await asyncio.sleep(3)
        
        await start_service("Runtime", RUNTIME_DIR,
            "cargo run --release", env)
        await asyncio.sleep(3)
        
        # Run tests
        health_ok = await test_health_endpoints()
        if health_ok:
            log("\n✅ 所有模块健康检查通过!")
        else:
            log("\n⚠️ 部分健康检查失败")
        
        await test_chat_sse()
        
    finally:
        log("\n=== 清理服务 ===")
        for name, proc in reversed(SERVICES):
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    proc.kill()
                log(f"  Stopped {name}")

if __name__ == "__main__":
    asyncio.run(main())
