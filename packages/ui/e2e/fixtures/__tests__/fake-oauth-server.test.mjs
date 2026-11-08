// fixture 自测：fake-oauth-server（启停 + 主路径 + 错误/边界，端口 0）。
//
// 门禁：`mise run test:e2e:fixtures`（= node --test "e2e/fixtures/__tests__/*.test.mjs"）。
// 覆盖范围刻意最小：discovery → authorize(302) → token(PKCE) → refresh → revoke 一条链，
// 加 PKCE 不匹配 / 未知 refresh / 未知路径三类错误；不重复 CP 侧 OAuth 策略语义。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../fake-oauth-server.mjs", import.meta.url));
const ACCESS_TOKEN = "fixture-access-token";
const READY_TIMEOUT_MS = 5_000;

function startServer(env = {}) {
    const child = spawn(process.execPath, [SERVER], {
        env: {
            ...process.env,
            XIHE_FAKE_OAUTH_PORT: "0",
            XIHE_FAKE_MCP_ACCESS_TOKEN: ACCESS_TOKEN,
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
            () =>
                reject(
                    new Error(`fake-oauth 未在 ${READY_TIMEOUT_MS}ms 内就绪: ${stdout}${stderr}`),
                ),
            READY_TIMEOUT_MS,
        );
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const match = stdout.match(/listening on (\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`fake-oauth 提前退出 code=${code} signal=${signal}: ${stderr}`));
        });
    });
    return { child, ready };
}

async function stopServer(server) {
    const { child } = server;
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
            once(child, "exit"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    }
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
    }
    assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        `fake-oauth 进程未退出（exitCode=${child.exitCode} signal=${child.signalCode}）`,
    );
}

async function assertPortClosed(port) {
    await assert.rejects(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }),
        /fetch failed|ECONNREFUSED/,
        `fake-oauth 关闭后端口 ${port} 仍在监听`,
    );
}

describe("fake-oauth-server（fixture 自测）", () => {
    /** @type {ReturnType<typeof startServer>} */
    let server;
    let port;
    let base;
    const clientId = "fixture-client";
    const redirectUri = "http://127.0.0.1/fixture-callback";

    const postForm = (path, fields) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields),
        });

    const pkce = () => {
        const verifier = `fixture-verifier-${randomUUID()}`;
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        return { verifier, challenge };
    };

    /** 走一遍 authorize，返回 302 Location 里的 code。 */
    async function authorizeForCode({ challenge }) {
        const url = new URL(`${base}/authorize`);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", "fixture-state");
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("scope", "mcp:tools");
        const response = await fetch(url, { redirect: "manual" });
        assert.equal(response.status, 302, "合法 authorize 必须 302 回跳");
        const location = response.headers.get("location");
        assert.ok(location, "302 必须带 Location");
        const callback = new URL(location);
        assert.equal(callback.searchParams.get("state"), "fixture-state");
        const code = callback.searchParams.get("code");
        assert.ok(code, `Location 必须带 code，实际 ${location}`);
        return code;
    }

    before(async () => {
        server = startServer();
        port = await server.ready;
        base = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        await stopServer(server);
        await assertPortClosed(port);
    });

    it("起在 port 0 的真实端口，discovery 端点用的是真实端口", async () => {
        assert.ok(Number.isInteger(port) && port > 0, `port 0 应绑定真实端口，实际 ${port}`);
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: "ok" });

        const discovery = await fetch(`${base}/.well-known/openid-configuration`);
        assert.equal(discovery.status, 200);
        const body = await discovery.json();
        assert.equal(body.authorization_endpoint, `${base}/authorize`);
        assert.equal(body.token_endpoint, `${base}/token`);
        assert.equal(body.revocation_endpoint, `${base}/revoke`);
        assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    });

    it("主路径：authorize(302) → token(PKCE) → refresh 轮换 → revoke 生效", async () => {
        const { verifier, challenge } = pkce();
        const code = await authorizeForCode({ challenge });
        const token = await postForm("/token", {
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: redirectUri,
        });
        assert.equal(token.status, 200);
        const tokenBody = await token.json();
        assert.equal(tokenBody.token_type, "Bearer");
        assert.equal(tokenBody.access_token, ACCESS_TOKEN);
        assert.equal(tokenBody.expires_in, 300);
        assert.match(tokenBody.refresh_token, /^fake-refresh-/);

        const refreshed = await postForm("/token", {
            grant_type: "refresh_token",
            refresh_token: tokenBody.refresh_token,
        });
        assert.equal(refreshed.status, 200);
        const refreshedBody = await refreshed.json();
        assert.equal(refreshedBody.access_token, ACCESS_TOKEN);
        assert.notEqual(refreshedBody.refresh_token, tokenBody.refresh_token, "refresh 必须轮换");

        const revoked = await postForm("/revoke", { token: refreshedBody.refresh_token });
        assert.equal(revoked.status, 200);
        const afterRevoke = await postForm("/token", {
            grant_type: "refresh_token",
            refresh_token: refreshedBody.refresh_token,
        });
        assert.equal(afterRevoke.status, 400);
        assert.equal((await afterRevoke.json()).error, "invalid_grant");
    });

    it("错误/边界：缺参 400、PKCE 不匹配 400、未知 refresh 400、未知路径 404", async () => {
        const missingParams = await fetch(`${base}/authorize?state=s`);
        assert.equal(missingParams.status, 400);
        assert.equal((await missingParams.json()).error, "invalid_request");

        const { challenge } = pkce();
        const code = await authorizeForCode({ challenge });
        const wrongVerifier = await postForm("/token", {
            grant_type: "authorization_code",
            code,
            code_verifier: "wrong-verifier",
            client_id: clientId,
            redirect_uri: redirectUri,
        });
        assert.equal(wrongVerifier.status, 400);
        assert.equal((await wrongVerifier.json()).error, "invalid_grant");

        const unknownRefresh = await postForm("/token", {
            grant_type: "refresh_token",
            refresh_token: "not-a-real-refresh-token",
        });
        assert.equal(unknownRefresh.status, 400);
        assert.equal((await unknownRefresh.json()).error, "invalid_grant");

        const unknownPath = await fetch(`${base}/nope`);
        assert.equal(unknownPath.status, 404);
        const getToken = await fetch(`${base}/token`);
        assert.equal(getToken.status, 404, "/token 只接受 POST");
    });
});
