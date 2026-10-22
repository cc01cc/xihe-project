// L0 self-check for the PLAN-0540 OAuth fixture.
//
// Starts the fixture on an ephemeral port and exercises the PKCE S256 flow CP
// performs: authorize -> 302 callback -> code exchange -> refresh. Exits
// non-zero on the first failed assertion.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "oauth-fixture-server.mjs");
const accessToken = randomBytes(24).toString("hex");

const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const assigned = probe.address().port;
        probe.close(() => resolve(assigned));
    });
});

const child = spawn(process.execPath, [serverPath], {
    env: {
        ...process.env,
        XIHE_EVAL_OAUTH_PORT: String(port),
        XIHE_EVAL_MCP_ACCESS_TOKEN: accessToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let ready = false;
child.stdout.on("data", (chunk) => {
    if (chunk.includes("listening")) ready = true;
});
child.stderr.on("data", (chunk) => process.stderr.write(`[fixture] ${chunk}`));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 10_000;
while (!ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready) {
    child.kill();
    console.error("FAIL fixture did not report readiness");
    process.exit(1);
}

function assert(condition, message) {
    if (!condition) {
        child.kill();
        console.error(`FAIL ${message}`);
        process.exit(1);
    }
}

function base64Url(buffer) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function challengeFor(verifier) {
    return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

const redirectUri = "http://127.0.0.1:12651/api/v1/oauth/callback";

async function authorize(verifier, stateValue = "state-eval") {
    const url = new URL(`${base}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "xihe-eval-client");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "mcp:tools");
    url.searchParams.set("state", stateValue);
    url.searchParams.set("code_challenge", challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    const resp = await fetch(url, { redirect: "manual" });
    assert(resp.status === 302, `authorize status ${resp.status}`);
    const location = new URL(resp.headers.get("location"));
    assert(location.searchParams.get("state") === stateValue, "state must round-trip");
    return location.searchParams.get("code");
}

async function exchange(params) {
    const resp = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
    });
    return { status: resp.status, body: await resp.json() };
}

try {
    const health = await (await fetch(`${base}/health`)).json();
    assert(health.status === "ok", "health status");

    const verifier = base64Url(randomBytes(32));
    const code = await authorize(verifier);
    assert(Boolean(code), "authorize must return a code");

    const wrong = await exchange({
        grant_type: "authorization_code",
        code,
        client_id: "xihe-eval-client",
        redirect_uri: redirectUri,
        code_verifier: base64Url(randomBytes(32)),
    });
    assert(wrong.status === 400, `wrong verifier must be rejected, got ${wrong.status}`);

    const code2 = await authorize(verifier, "state-eval-2");
    const ok = await exchange({
        grant_type: "authorization_code",
        code: code2,
        client_id: "xihe-eval-client",
        redirect_uri: redirectUri,
        code_verifier: verifier,
    });
    assert(ok.status === 200, `exchange status ${ok.status}`);
    assert(ok.body.access_token === accessToken, "access token must be the shared secret");
    assert(Boolean(ok.body.refresh_token), "CP requires a refresh token");
    assert(ok.body.scope === "mcp:tools", `scope=${ok.body.scope}`);

    const refreshed = await exchange({
        grant_type: "refresh_token",
        refresh_token: ok.body.refresh_token,
        client_id: "xihe-eval-client",
    });
    assert(refreshed.status === 200, `refresh status ${refreshed.status}`);
    assert(refreshed.body.access_token === accessToken, "refresh must return the shared secret");

    const replay = await exchange({
        grant_type: "authorization_code",
        code: code2,
        client_id: "xihe-eval-client",
        redirect_uri: redirectUri,
        code_verifier: verifier,
    });
    assert(replay.status === 400, "codes must be one-time");

    const state = await (await fetch(`${base}/__eval/state`)).json();
    assert(state.codesIssued === 2, `codesIssued=${state.codesIssued}`);
    assert(state.codesExchanged === 1, `codesExchanged=${state.codesExchanged}`);
    assert(state.refreshExchanges === 1, `refreshExchanges=${state.refreshExchanges}`);
    assert(state.tokenRejected === 2, `tokenRejected=${state.tokenRejected}`);

    console.log(
        JSON.stringify(
            {
                ok: true,
                port,
                codesIssued: state.codesIssued,
                codesExchanged: state.codesExchanged,
                refreshExchanges: state.refreshExchanges,
            },
            null,
            2,
        ),
    );
} finally {
    child.kill();
}
