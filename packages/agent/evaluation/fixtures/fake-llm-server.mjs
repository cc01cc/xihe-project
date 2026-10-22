#!/usr/bin/env node
/**
 * PLAN-0540 T3.1: deterministic OpenAI-compatible model for the invariant lane.
 *
 * The builtin `openai-chat-completions` template always requests `stream: true`,
 * so the fixture speaks SSE and follows the strict chunk shape `ApiSender`
 * accepts. The script is: call `always_failing` on every turn (the tool always
 * returns isError), until the run budget ends the run. No real key is read or
 * checked; the fixture is eval-only and must not be exposed beyond loopback.
 */

import http from "node:http";

const PORT = Number(process.env.XIHE_EVAL_LLM_PORT ?? 12762);
const BIND = process.env.XIHE_EVAL_LLM_BIND ?? "127.0.0.1";
const MODEL = process.env.XIHE_EVAL_LLM_MODEL ?? "eval-fake-model";
const MAX_TOOL_ROUNDS = Number(process.env.XIHE_EVAL_LLM_MAX_TOOL_ROUNDS ?? 30);

const state = {
  startedAt: new Date().toISOString(),
  requests: 0,
  chatCompletions: 0,
  streamRequests: 0,
  nonStreamRequests: 0,
  toolCallsIssued: 0,
  toolResultsSeen: 0,
  toolMissing: 0,
  textResponses: 0,
  safetyStop: 0,
  lastToolName: null,
  lastPromptKind: null,
  toolNamesSeen: [],
  modelsRequested: [],
};

function noteToolName(name) {
  if (name && !state.toolNamesSeen.includes(name)) {
    state.toolNamesSeen.push(name);
  }
}

function noteModel(name) {
  if (name && !state.modelsRequested.includes(name)) {
    state.modelsRequested.push(name);
  }
}

function rememberToolName(name) {
  if (!name) return;
  state.lastToolName = name;
  noteToolName(name);
}

function collectText(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
  } else if (value && typeof value === "object") {
    if (typeof value.text === "string") out.push(value.text);
    if (Array.isArray(value.content)) collectText(value.content, out);
  }
  return out;
}

function messageText(message) {
  return collectText(message?.content).join("\n");
}

function pickTool(tools, wanted) {
  const names = [];
  for (const entry of Array.isArray(tools) ? tools : []) {
    const name = entry?.function?.name ?? entry?.name;
    if (typeof name !== "string") continue;
    names.push(name);
    noteToolName(name);
    if (name === wanted) return name;
  }
  for (const name of names) {
    if (name.endsWith(`__${wanted}`) || name.endsWith(`.${wanted}`)) return name;
  }
  return null;
}

function classifyPrompt(text) {
  const lower = text.toLowerCase();
  if (lower.includes("always_failing")) return "failure_budget";
  if (lower.includes("exactly the fields name") || lower.includes('"ok"')) {
    return "instruction_following";
  }
  if (lower.includes("freedonia") || lower.includes("veridian")) {
    return "grounded_citation";
  }
  if (lower.includes("hosts file") || lower.includes("overwrite")) {
    return "tool_authorization";
  }
  return "default";
}

function textFor(promptKind) {
  if (promptKind === "instruction_following") {
    return JSON.stringify({ name: "eval", ok: true });
  }
  if (promptKind === "grounded_citation") {
    return "Freedonia's capital is Veridian [S1].";
  }
  if (promptKind === "tool_authorization") {
    return "I cannot modify the system hosts file; the requested mutation is refused.";
  }
  return "eval fixture: no scripted answer for this prompt.";
}

function buildDecision(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolMessages = messages.filter((m) => m?.role === "tool").length;
  state.toolResultsSeen += toolMessages;
  const promptText = messages.map(messageText).join("\n");
  const promptKind = classifyPrompt(promptText);
  state.lastPromptKind = promptKind;

  if (promptKind === "failure_budget") {
    if (toolMessages >= MAX_TOOL_ROUNDS) {
      state.safetyStop += 1;
      return { kind: "text", content: "safety stop: tool budget exceeded" };
    }
    const name = pickTool(body.tools, "always_failing");
    rememberToolName(name);
    if (!name) {
      state.toolMissing += 1;
      return {
        kind: "text",
        content: "eval fixture: always_failing is not in the provided tool list",
      };
    }
    state.toolCallsIssued += 1;
    return {
      kind: "tool_call",
      name,
      id: `call_eval_${state.toolCallsIssued}`,
      // Identical arguments every turn: a real loop detector must see repetition.
      arguments: JSON.stringify({ attempt: 1 }),
    };
  }

  return { kind: "text", content: textFor(promptKind) };
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function completionId() {
  return `chatcmpl-eval-${state.chatCompletions}`;
}

function writeSse(res, decision) {
  const created = Math.floor(Date.now() / 1000);
  const id = completionId();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    sseChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
  );
  if (decision.kind === "tool_call") {
    res.write(
      sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: decision.id,
                  type: "function",
                  function: {
                    name: decision.name,
                    arguments: decision.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    res.write(
      sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
  } else {
    res.write(
      sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL,
        choices: [
          { index: 0, delta: { content: decision.content }, finish_reason: null },
        ],
      }),
    );
    res.write(
      sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeJson(res, decision) {
  const message =
    decision.kind === "tool_call"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: decision.id,
              type: "function",
              function: { name: decision.name, arguments: decision.arguments },
            },
          ],
        }
      : { role: "assistant", content: decision.content };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: completionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          message,
          finish_reason: decision.kind === "tool_call" ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  state.requests += 1;
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/__eval/state")) {
    sendJson(res, 200, {
      status: "ok",
      model: MODEL,
      pid: process.pid,
      maxToolRounds: MAX_TOOL_ROUNDS,
      ...state,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: MODEL,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "xihe-eval",
        },
      ],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON body" } });
      return;
    }
    state.chatCompletions += 1;
    noteModel(body.model);
    const streaming = body.stream === true;
    if (streaming) state.streamRequests += 1;
    else state.nonStreamRequests += 1;

    const decision = buildDecision(body);
    if (decision.kind === "text") state.textResponses += 1;
    if (streaming) writeSse(res, decision);
    else writeJson(res, decision);
    return;
  }

  sendJson(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal, ...state }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, BIND, () => {
  console.log(
    JSON.stringify({
      event: "listening",
      url: `http://${BIND}:${PORT}`,
      model: MODEL,
      pid: process.pid,
    }),
  );
});
