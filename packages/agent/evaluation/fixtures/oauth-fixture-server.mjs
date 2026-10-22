#!/usr/bin/env node
/**
 * PLAN-0540 T3.0: loopback OAuth authorization server for the invariant lane.
 *
 * CP starts the flow with PKCE S256 and exchanges the code with
 * `code_verifier`; CP requires a refresh token from the exchange. The access
 * token is a shared secret supplied by the lane setup so the MCP fixture and
 * this server agree without real credentials. Eval-only, loopback-only.
 */

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.XIHE_EVAL_OAUTH_PORT ?? 12763);
const BIND = process.env.XIHE_EVAL_OAUTH_BIND ?? "127.0.0.1";
const ACCESS_TOKEN = process.env.XIHE_EVAL_MCP_ACCESS_TOKEN ?? randomBytes(24).toString("hex");

const pendingCodes = new Map();
const refreshTokens = new Set();
const state = {
  startedAt: new Date().toISOString(),
  authorizeRequests: 0,
  authorizeRejected: 0,
  tokenRequests: 0,
  tokenRejected: 0,
  codesIssued: 0,
  codesExchanged: 0,
  refreshExchanges: 0,
  revokeRequests: 0,
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function oauthError(res, status, code, description) {
  sendJson(res, status, { error: code, error_description: description });
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkceChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function handleAuthorize(res, url) {
  state.authorizeRequests += 1;
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri");
  const challenge = params.get("code_challenge");
  const code = `code_${randomBytes(16).toString("hex")}`;
  const required = ["client_id", "redirect_uri", "state", "code_challenge", "scope"];
  const missing = required.filter((key) => !params.get(key));
  if (
    missing.length > 0 ||
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256"
  ) {
    state.authorizeRejected += 1;
    oauthError(res, 400, "invalid_request", `missing or unsupported: ${missing.join(",") || "response_type"}`);
    return;
  }
  pendingCodes.set(code, {
    challenge,
    redirectUri,
    scope: params.get("scope"),
    createdAt: Date.now(),
  });
  state.codesIssued += 1;
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", params.get("state"));
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

async function handleToken(req, res) {
  state.tokenRequests += 1;
  const form = await readForm(req);
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const entry = pendingCodes.get(code);
    const verifier = form.get("code_verifier") ?? "";
    if (!entry || entry.redirectUri !== form.get("redirect_uri") || !verifier) {
      state.tokenRejected += 1;
      oauthError(res, 400, "invalid_grant", "code, redirect_uri or verifier is invalid");
      return;
    }
    pendingCodes.delete(code);
    if (pkceChallenge(verifier) !== entry.challenge) {
      state.tokenRejected += 1;
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }
    const refreshToken = `rt_${randomBytes(24).toString("hex")}`;
    refreshTokens.add(refreshToken);
    state.codesExchanged += 1;
    sendJson(res, 200, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: entry.scope,
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshTokens.has(refreshToken)) {
      state.tokenRejected += 1;
      oauthError(res, 400, "invalid_grant", "refresh token is unknown");
      return;
    }
    state.refreshExchanges += 1;
    sendJson(res, 200, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    });
    return;
  }

  state.tokenRejected += 1;
  oauthError(res, 400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/__eval/state")) {
    sendJson(res, 200, { status: "ok", pid: process.pid, ...state });
    return;
  }
  if (req.method === "GET" && url.pathname === "/authorize") {
    handleAuthorize(res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/token") {
    await handleToken(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/revoke") {
    state.revokeRequests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal, ...state }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, BIND, () => {
  console.log(JSON.stringify({ event: "listening", url: `http://${BIND}:${PORT}`, pid: process.pid }));
});
