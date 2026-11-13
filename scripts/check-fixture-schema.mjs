// task-166（task-62）：判据「测试夹具形状 ⊇ 契约 required」。
//
// 为什么需要它（task-160 / `eab417a2` 实测）：`openapi.yaml:6594` 的 `Workspace` required = 8 项，
// 而三个真编造 workspace 本体的单测夹具各缺 5–6 项 ⇒ 读 `generation`/`ownerId`/`executionMode`
// 的 UI 分支在单测里只拿到 `undefined` 却**静默绿**。这是「假绿」的一个形态：断言没写错，
// 夹具没给足字段，而 `undefined` 分支恰好不抛。
//
// 判据**不是**「有没有 fetch 桩」——那只能测出「这里 mock 了」，测不出「mock 的形状够不够」。
//
// 解析分层（两条都**不手写 parser**，与 `gen-api-docs.mjs` 的既有分工一致）：
//   · YAML → PyYAML（agent venv）。仓库 Node 侧没有 YAML 解析器：`scripts/validate-openapi.mjs`
//     头注释原文「the repo declares no YAML parser for Node」；
//   · TypeScript → `packages/ui/node_modules/typescript` 的真编译器 API（不是正则切字符串）。
//
// 用法：
//   node scripts/check-fixture-schema.mjs            # 只报告（report-only，exit 0）
//   node scripts/check-fixture-schema.mjs --enforce   # 有缺项 ⇒ exit 1
//   node scripts/check-fixture-schema.mjs --json      # 机器可读
//   node scripts/check-fixture-schema.mjs --selftest  # 3 组夹具，证明判据会响
//
// **未接 `mise`**（task-166 禁区）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LF = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CONTRACT = process.env.XH_OPENAPI_CONTRACT
    ? path.resolve(process.env.XH_OPENAPI_CONTRACT)
    : path.join(REPO, "docs", "api", "openapi.yaml");
const TS_ENTRY = path.join(REPO, "packages", "ui", "node_modules", "typescript", "lib", "typescript.js");
const SCAN_ROOTS = [path.join(REPO, "packages", "ui", "src")];
const ENFORCE = process.argv.includes("--enforce");
const JSON_OUT = process.argv.includes("--json");
const SELFTEST = process.argv.includes("--selftest");

const PY_CANDIDATES = [
    process.env.XH_PYTHON,
    path.join(REPO, "packages", "agent", ".venv", "Scripts", "python.exe"),
    path.join(REPO, "packages", "agent", ".venv", "bin", "python"),
].filter(Boolean);

// 只取判据用到的东西：每个 schema 的 required + 每个 operation 成功响应的 schema 名。
const PY_SOURCE = [
    "import json, sys",
    "import yaml",
    "",
    "with open(sys.argv[1], encoding='utf-8') as handle:",
    "    doc = yaml.safe_load(handle)",
    "",
    "schemas = {}",
    "for name, schema in ((doc.get('components') or {}).get('schemas') or {}).items():",
    "    if not isinstance(schema, dict):",
    "        continue",
    "    schemas[str(name)] = {",
    "        'required': [str(key) for key in (schema.get('required') or []) if isinstance(key, str)],",
    "    }",
    "",
    "def ref_name(schema):",
    "    if not isinstance(schema, dict):",
    "        return ''",
    "    ref = schema.get('$ref')",
    "    if isinstance(ref, str) and ref.startswith('#/components/schemas/'):",
    "        return ref.rsplit('/', 1)[-1]",
    "    items = schema.get('items')",
    "    if isinstance(items, dict):",
    "        inner = items.get('$ref')",
    "        if isinstance(inner, str) and inner.startswith('#/components/schemas/'):",
    "            return inner.rsplit('/', 1)[-1]",
    "    return ''",
    "",
    "operations = []",
    "methods = {'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'}",
    "for raw_path, item in (doc.get('paths') or {}).items():",
    "    if not isinstance(item, dict):",
    "        continue",
    "    for raw_method, operation in item.items():",
    "        method = str(raw_method).lower()",
    "        if method not in methods or not isinstance(operation, dict):",
    "            continue",
    "        schema_name = ''",
    "        for status, response in (operation.get('responses') or {}).items():",
    "            if not str(status).startswith('2') or not isinstance(response, dict):",
    "                continue",
    "            media = (response.get('content') or {}).get('application/json')",
    "            if isinstance(media, dict):",
    "                schema_name = ref_name(media.get('schema'))",
    "                if schema_name:",
    "                    break",
    "        operations.append({'method': method, 'path': str(raw_path), 'schema': schema_name})",
    "",
    "print(json.dumps({'schemas': schemas, 'operations': operations}, ensure_ascii=False))",
].join(LF);

function fail(code, message) {
    console.error("[check-fixture-schema] " + message);
    process.exit(code);
}

function findPython() {
    const found = PY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        fail(
            2,
            "PyYAML interpreter not found; tried:" + LF + PY_CANDIDATES.map((c) => "  " + c).join(LF) +
                LF + "hint: mise run setup:agent, or set XH_PYTHON to a python that has PyYAML",
        );
    }
    return found;
}

function parseContractAt(python, contractFile) {
    if (!fs.existsSync(contractFile)) fail(2, "contract not found: " + contractFile);
    const result = spawnSync(python, ["-", contractFile], {
        input: PY_SOURCE,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) fail(2, "cannot run " + python + ": " + result.error.message);
    if (result.status !== 0) {
        const stderr = (result.stderr || "").trim();
        const yamlMissing = stderr.indexOf("No module named") !== -1 && stderr.indexOf("yaml") !== -1;
        fail(
            2,
            "python parse failed (exit " + result.status + "): " + stderr +
                (yamlMissing ? LF + "hint: PyYAML missing in this interpreter; mise run setup:agent" : ""),
        );
    }
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        fail(2, "python emitted invalid JSON: " + error.message);
    }
}

function loadTs() {
    if (!fs.existsSync(TS_ENTRY)) {
        fail(2, "typescript not found at " + TS_ENTRY + LF + "hint: pnpm install in packages/ui");
    }
    return require(TS_ENTRY);
}

// ── URL → 契约 path 的唯一匹配（按段比较，不做正则拼接） ──────────────────────────────
function segmentsOf(value) {
    return String(value).split("/").filter((segment) => segment.length > 0);
}

function isDynamicContractSegment(segment) {
    return segment.length > 1 && segment.startsWith("{") && segment.endsWith("}");
}
/** 字面量段与契约段能否对应（契约的动态段吃任意字面量段；静态段要求逐字相等）。 */
function segmentFits(contractSegment, literalSegment) {
    if (isDynamicContractSegment(contractSegment)) return literalSegment.length > 0;
    return contractSegment === literalSegment;
}

/**
 * 字面量的**来源只认最近的那个 `if` 条件**：夹具通常在 `if (url.includes("/api/v1/workspaces/")) {`
 * 里返回，而同一个 handler 里还有别的分支（config 域、404 兜底）。若按「函数内最长的 API 字面量」
 * 取，那些分支的响应会被错记到 workspace schema 上（实测过：`WorkspaceSettingsView.spec.ts`
 * 的 `{}` 与 `{domain, entries}` 两个分支都被错配）。
 */
function apiLiteralIn(ts, node) {
    const found = [];
    const visit = (inner) => {
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
            if (inner.text.indexOf("/api/") !== -1 || inner.text.indexOf("/workspaces/") !== -1) {
                found.push(inner.text);
            }
        } else if (ts.isTemplateExpression(inner)) {
            const head = inner.head.text;
            if (head.indexOf("/api/") !== -1 || head.indexOf("/workspaces/") !== -1) {
                const parts = [head];
                inner.templateSpans.forEach((span) => {
                    parts.push("${" + span.expression.getText() + "}");
                    parts.push(span.literal.text);
                });
                found.push(parts.join(""));
            }
        }
        ts.forEachChild(inner, visit);
    };
    visit(node);
    if (found.length === 0) return "";
    found.sort((a, b) => b.length - a.length);
    return found[0];
}

/** 最近的 `if (… url … )` 条件里的 API 字面量；找不到则用「函数内唯一 API 字面量」兜底。 */
function literalFor(ts, node, scope) {
    let current = node.parent;
    while (current) {
        if (ts.isIfStatement(current)) {
            const literal = apiLiteralIn(ts, current.expression);
            if (literal) return literal;
        }
        if (current === scope) break;
        current = current.parent;
    }
    // 不退回函数级字面量：一个 handler 里常有多条路径（workspace / config / 404 兜底），
    // 退回去就会把别的分支的响应错记到本 schema 上 —— 实测 WorkspaceSettingsView.spec.ts
    // 的 {} 与 {domain, entries} 两个分支曾因此变成假报。宁可写 no-api-url-in-scope。
    return "";
}

/** 最近的方法字面量（`method === "PATCH"` / `method: "PATCH"`），默认 GET。 */
function methodFor(ts, node, scope) {
    const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    let current = node.parent;
    while (current) {
        if (ts.isStringLiteral(current) && METHODS.indexOf(current.text) !== -1) return current.text;
        if (current === scope) break;
        current = current.parent;
    }
    return "GET";
}

/** 字面量是契约 path 的前缀/后缀时也能对上：先全段相等，再后缀，再前缀（取段数最少者）。 */
function matchPathSegments(contractSegments, literalSegments) {
    const fit = (offset) => {
        for (let index = 0; index < literalSegments.length; index += 1) {
            const contractSegment = contractSegments[offset + index];
            if (contractSegment === undefined) return false;
            if (isDynamicContractSegment(contractSegment)) {
                if (literalSegments[index].length === 0) return false;
                continue;
            }
            if (contractSegment !== literalSegments[index]) return false;
        }
        return true;
    };
    const exact = contractSegments.length === literalSegments.length && fit(0);
    if (exact) return "exact";
    if (fit(contractSegments.length - literalSegments.length)) return "suffix";
    if (fit(0)) return "prefix";
    return "";
}

function resolveOperationLoosely(model, literal, method) {
    const probe = String(literal).split("?")[0];
    const truncatedTail = probe.endsWith("/");
    const literalSegments = segmentsOf(probe);
    if (literalSegments.length === 0) return null;
    const lowerMethod = String(method || "GET").toLowerCase();
    const hits = [];
    for (const operation of model.operations) {
        if (operation.method !== lowerMethod) continue;
        const kind = matchPathSegments(segmentsOf(operation.path), literalSegments);
        if (kind) hits.push({ operation, kind });
    }
    if (hits.length === 0) return null;
    let exact = hits.filter((hit) => hit.kind === "exact");
    if (truncatedTail) exact = [];
    if (exact.length === 1) return exact[0].operation;
    if (exact.length > 1) return null;
    const suffix = hits.filter((hit) => hit.kind === "suffix");
    if (suffix.length === 1) return suffix[0].operation;
    if (suffix.length > 1) {
        // 例：以 /workspaces/{id} 结尾的路径不止一条 ⇒ 取最短那条（= 资源本体，而不是它的子资源）。
        suffix.sort((a, b) => segmentsOf(a.operation.path).length - segmentsOf(b.operation.path).length);
        const shortestSuffix = segmentsOf(suffix[0].operation.path).length;
        const suffixTies = suffix.filter((hit) => segmentsOf(hit.operation.path).length === shortestSuffix);
        return suffixTies.length === 1 ? suffixTies[0].operation : null;
    }
    let prefix = hits.filter((hit) => hit.kind === "prefix");
    if (truncatedTail) {
        // 以 "/" 结尾的字面量是「id 段被截掉」的写法：应匹配多一段的条目路径，而不是等长的集合路径。
        prefix = prefix.filter((hit) => segmentsOf(hit.operation.path).length > literalSegments.length);
    }
    if (prefix.length === 0) return null;
    prefix.sort((a, b) => segmentsOf(a.operation.path).length - segmentsOf(b.operation.path).length);
    const shortest = segmentsOf(prefix[0].operation.path).length;
    const ties = prefix.filter((hit) => segmentsOf(hit.operation.path).length === shortest);
    return ties.length === 1 ? ties[0].operation : null;
}

// ── 从 TS AST 里取「响应夹具字面量」────────────────────────────────────────────────
function textOf(ts, node) {
    return node && node.getText ? node.getText() : "";
}

/** `new Response(JSON.stringify(<obj>), ...)` 或 `{ body: JSON.stringify(<obj>) }` 里的 `<obj>`。 */
function payloadObjectOf(ts, node) {
    if (ts.isNewExpression(node) && textOf(ts, node.expression) === "Response") {
        const first = node.arguments && node.arguments[0];
        if (first && ts.isCallExpression(first) && textOf(ts, first.expression) === "JSON.stringify") {
            const inner = first.arguments && first.arguments[0];
            if (inner && ts.isObjectLiteralExpression(inner)) return inner;
        }
        return null;
    }
    if (ts.isCallExpression(node)) {
        const callee = textOf(ts, node.expression);
        // `jsonResponse({ workspace })` / `json(...)` 这类 helper 把 JSON.stringify 包了一层；
        // 只认名字里带 json 的（避免把 toast.success({...}) 这类业务调用当夹具）。
        if (/json/i.test(callee) && callee.indexOf("JSON.stringify") === -1) {
            const first = node.arguments && node.arguments[0];
            if (first && ts.isObjectLiteralExpression(first)) return first;
        }
    }
    if (ts.isPropertyAssignment(node) && textOf(ts, node.name).replace(/["\x27]/g, "") === "body") {
        const init = node.initializer;
        if (ts.isCallExpression(init) && textOf(ts, init.expression) === "JSON.stringify") {
            const inner = init.arguments && init.arguments[0];
            if (inner && ts.isObjectLiteralExpression(inner)) return inner;
        }
    }
    return null;
}

function enclosingFunction(ts, node) {
    let current = node.parent;
    while (current) {
        if (
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isArrowFunction(current) ||
            ts.isMethodDeclaration(current) ||
            ts.isGetAccessor(current) ||
            ts.isConstructorDeclaration(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}




function propertyNamesOf(ts, literal) {
    const names = [];
    let hasSpread = false;
    literal.properties.forEach((property) => {
        if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            names.push(textOf(ts, property.name).replace(/["\x27]/g, ""));
        } else if (ts.isSpreadAssignment(property)) {
            hasSpread = true;
        } else if (ts.isMethodDeclaration(property)) {
            names.push(textOf(ts, property.name).replace(/["\x27]/g, ""));
        }
    });
    return { names, hasSpread };
}

/**
 * 夹具常写成 `jsonResponse({ workspace })`：外层只有一个键，真正的形状在 `const workspace = {...}`。
 * 只对「单属性 + 值是标识符」的包装回溯，且要求同文件能找到唯一的 `const <name> = { … }`；
 * 找不到就保持原样（宁可少判一条，也不猜）。
 */
function unwrapFixtureObject(ts, sourceFile, literal, scope) {
    const props = literal.properties;
    if (props.length !== 1) return { literals: [literal], via: "", resolved: true };
    const only = props[0];
    let nameNode = null;
    if (ts.isShorthandPropertyAssignment(only)) nameNode = only.name;
    else if (ts.isPropertyAssignment(only) && ts.isIdentifier(only.initializer)) nameNode = only.initializer;
    if (!nameNode) return { literals: [literal], via: "", resolved: true };
    const name = nameNode.getText();
    let resolved = null;
    const visitVariable = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
            if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) resolved = node.initializer;
        }
        ts.forEachChild(node, visitVariable);
    };
    visitVariable(sourceFile);
    if (resolved) return { literals: [resolved], via: name, resolved: true };
    // 第二跳：`jsonResponse({ workspace })` 里的 `workspace` 常是**函数参数**，真正的形状在调用点
    // 传进来的实参对象上（`hydrateFromHttp({ id, name, hostPath, roots })`）。只做一跳参数 → 实参解析，
    // 且要求「参数名唯一命中 + 调用点实参是对象字面量」，否则放弃（不猜）。
    // 参数可能不在最内层函数上：`mockImplementation((input) => ...)` 里包着 `jsonResponse({ workspace })`，
    // 而 `workspace` 是外层 `hydrateFromHttp(workspace)` 的形参 ⇒ 逐层向外找「形参名命中」的那个函数。
    let host = scope;
    let paramIndex = -1;
    let calleeName = "";
    while (host) {
        const index = (host.parameters || []).findIndex(
            (param) => ts.isIdentifier(param.name) && param.name.text === name,
        );
        if (index !== -1 && host.name && ts.isIdentifier(host.name)) {
            paramIndex = index;
            calleeName = host.name.text;
            break;
        }
        host = enclosingFunction(ts, host);
    }
    if (!calleeName) return { literals: [literal], via: "", resolved: false };
    const callArgs = [];
    const visitCalls = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
            const arg = node.arguments && node.arguments[paramIndex];
            if (arg && ts.isObjectLiteralExpression(arg)) callArgs.push(arg);
        }
        ts.forEachChild(node, visitCalls);
    };
    visitCalls(sourceFile);
    // 多个调用点就是多个夹具（不同用例喂不同形状）⇒ **每个调用点各出一条**，
    // 而不是挑一个代表：挑代表会把"某个用例缺字段"这条信息丢掉。
    if (callArgs.length > 0) {
        return { literals: callArgs, via: name + "@call", resolved: true };
    }
    return { literals: [literal], via: "", resolved: false };
}
function scanFile(ts, filePath, model) {
    const text = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const findings = [];
    const visit = (node) => {
        const payload = payloadObjectOf(ts, node);
        if (payload) {
            const scope = enclosingFunction(ts, node) || sourceFile;
            const literal = literalFor(ts, payload, scope);
            const method = methodFor(ts, payload, scope);
            const unwrapped = unwrapFixtureObject(ts, sourceFile, payload, scope);
            const operation = literal ? resolveOperationLoosely(model, literal, method) : null;
            const schema = operation && operation.schema ? operation.schema : "";
            const required = schema ? model.schemas[schema].required : [];
            for (const shapeLiteral of unwrapped.literals) {
            const line =
                sourceFile.getLineAndCharacterOfPosition(shapeLiteral.getStart(sourceFile)).line + 1;
            const { names, hasSpread } = propertyNamesOf(ts, shapeLiteral);
            const missing = required.filter((key) => names.indexOf(key) === -1);
            findings.push({
                file: path.relative(REPO, filePath).split(path.sep).join("/"),
                line,
                method,
                path: operation ? operation.path : literal,
                schema,
                fields: names,
                via: unwrapped.via,
                missing,
                hasSpread,
                reason: !unwrapped.resolved
                    ? "wrapper-unresolved"
                    : !literal
                      ? "no-api-url-in-scope"
                    : !operation
                      ? "no-unique-contract-path"
                      : !schema
                        ? "operation-has-no-json-schema"
                        : hasSpread
                          ? "spread-in-literal"
                          : "",
            });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return findings;
}

function walkSpecFiles(root, into) {
    if (!fs.existsSync(root)) return into;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            walkSpecFiles(full, into);
        } else if (entry.isFile() && entry.name.endsWith(".spec.ts") && full.indexOf("__tests__") !== -1) {
            into.push(full);
        }
    }
    return into;
}

function scan(ts, roots, model) {
    const findings = [];
    for (const root of roots) {
        for (const file of walkSpecFiles(root, [])) findings.push(...scanFile(ts, file, model));
    }
    return findings;
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
function classify(findings) {
    const buckets = { ok: [], missing: [], undecidable: [] };
    for (const finding of findings) {
        if (finding.reason) buckets.undecidable.push(finding);
        else if (finding.missing.length > 0) buckets.missing.push(finding);
        else buckets.ok.push(finding);
    }
    return buckets;
}

function report(findings, model) {
    const buckets = classify(findings);
    for (const finding of buckets.missing) {
        console.log(
            "E_FIXTURE_MISSING_REQUIRED " +
                finding.file +
                ":" +
                finding.line +
                " schema=" +
                finding.schema +
                " " +
                finding.method +
                " " +
                finding.path +
                " missing=[" +
                finding.missing.join(", ") +
                "]",
        );
    }
    for (const finding of buckets.undecidable) {
        console.log(
            "NOTE fixture-unclassified " +
                finding.file +
                ":" +
                finding.line +
                " reason=" +
                finding.reason +
                " url=" +
                (finding.path || "<none>"),
        );
    }
    console.log(
        "summary total=" +
            findings.length +
            " ok=" +
            buckets.ok.length +
            " missing=" +
            buckets.missing.length +
            " undecidable=" +
            buckets.undecidable.length,
    );
    console.log(
        "contract schemas=" +
            Object.keys(model.schemas).length +
            " operations=" +
            model.operations.length +
            " (required 非空的 schema=" +
            Object.values(model.schemas).filter((schema) => schema.required.length > 0).length +
            ")",
    );
    return buckets;
}

// ── selftest：3 组夹具，每组必须证明自己会响（反过来也要证明不会误响）──────────────
const SELFTEST_CONTRACT = [
    "openapi: 3.0.0",
    "components:",
    "  schemas:",
    "    Workspace:",
    "      type: object",
    "      required: [id, name, ownerId]",
    "      properties:",
    "        id: { type: string }",
    "        name: { type: string }",
    "        ownerId: { type: string }",
    "paths:",
    "  /api/v1/workspaces/{workspaceId}:",
    "    get:",
    "      responses:",
    '        "200":',
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Workspace'",
].join(LF);

function selftestSpec(bodyLines) {
    return [
        "const WORKSPACE_ID = \"ws-1\";",
        "export function handler(input: RequestInfo | URL): Promise<Response> {",
        "    const url = typeof input === \"string\" ? input : input.url;",
        "    if (url.includes(`/api/v1/workspaces/${WORKSPACE_ID}`)) {",
        "        return Promise.resolve(",
        bodyLines.join(LF),
        "        );",
        "    }",
        "    return Promise.resolve(new Response(\"{}\", { status: 404 }));",
        "}",
    ].join(LF);
}

function runSelftest() {
    const ts = loadTs();
    const python = findPython();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-schema-"));
    const contractFile = path.join(root, "openapi.yaml");
    fs.writeFileSync(contractFile, SELFTEST_CONTRACT, "utf8");
    const model = parseContractAt(python, contractFile);
    const cases = [
        {
            name: "① 缺 1 必填 ⇒ 必报",
            file: "missing.spec.ts",
            body: [
                "            new Response(JSON.stringify({ id: WORKSPACE_ID, name: \"W\" }), {",
                "                status: 200,",
                "            }),",
            ],
            expectMissing: 1,
            expectFields: ["ownerId"],
        },
        {
            name: "② 全必填 ⇒ 不报",
            file: "complete.spec.ts",
            body: [
                "            new Response(",
                "                JSON.stringify({ id: WORKSPACE_ID, name: \"W\", ownerId: \"u-1\" }),",
                "                { status: 200 },",
                "            ),",
            ],
            expectMissing: 0,
            expectFields: [],
        },
        {
            name: "③ 多出字段 ⇒ 不报（契约允许增量）",
            file: "extra.spec.ts",
            body: [
                "            new Response(",
                "                JSON.stringify({",
                "                    id: WORKSPACE_ID,",
                "                    name: \"W\",",
                "                    ownerId: \"u-1\",",
                "                    futureField: true,",
                "                }),",
                "                { status: 200 },",
                "            ),",
            ],
            expectMissing: 0,
            expectFields: [],
        },
    ];
    let failures = 0;
    for (const testCase of cases) {
        const dir = path.join(root, "__tests__");
        fs.mkdirSync(dir, { recursive: true });
        const specFile = path.join(dir, testCase.file);
        fs.writeFileSync(specFile, selftestSpec(testCase.body) + LF, "utf8");
        const findings = scan(ts, [dir], model).filter((finding) => finding.file === specFile.replace(/\\/g, "/") || true);
        const mine = findings.filter((finding) => finding.file.endsWith(testCase.file));
        const buckets = classify(mine);
        const reportedMissing = buckets.missing.length;
        const flat = buckets.missing.reduce((acc, finding) => acc.concat(finding.missing), []);
        const okCount =
            reportedMissing === testCase.expectMissing &&
            testCase.expectFields.every((field) => flat.indexOf(field) !== -1) &&
            buckets.undecidable.length === 0;
        if (!okCount) failures += 1;
        console.log(
            (okCount ? "PASS " : "FAIL ") +
                testCase.name +
                "  fixture=" +
                testCase.file +
                " findings=" +
                mine.length +
                " missing=" +
                reportedMissing +
                " undecidable=" +
                buckets.undecidable.length +
                (buckets.undecidable[0] ? " reason=" + buckets.undecidable[0].reason + " url=" + buckets.undecidable[0].path : "") +
                " fields=[" +
                flat.join(", ") +
                "]",
        );
    }
    fs.rmSync(root, { recursive: true, force: true });
    console.log("selftest " + (failures === 0 ? "OK" : "FAILED") + " (" + cases.length + " cases)");
    process.exit(failures === 0 ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
    if (SELFTEST) {
        runSelftest();
        return;
    }
    const ts = loadTs();
    const python = findPython();
    const model = parseContractAt(python, CONTRACT);
    const findings = scan(ts, SCAN_ROOTS, model);
    if (JSON_OUT) {
        const buckets = classify(findings);
        console.log(
            JSON.stringify(
                {
                    contract: path.relative(REPO, CONTRACT).split(path.sep).join("/"),
                    schemas: Object.keys(model.schemas).length,
                    operations: model.operations.length,
                    counts: {
                        total: findings.length,
                        ok: buckets.ok.length,
                        missing: buckets.missing.length,
                        undecidable: buckets.undecidable.length,
                    },
                    findings,
                },
                null,
                2,
            ),
        );
    } else {
        report(findings, model);
    }
    const buckets = classify(findings);
    if (ENFORCE && buckets.missing.length > 0) {
        console.error("[check-fixture-schema] enforce: " + buckets.missing.length + " fixture(s) missing required fields");
        process.exit(1);
    }
}

main();
