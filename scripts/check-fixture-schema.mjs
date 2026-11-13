// task-166 / task-172：判据「测试夹具形状 ⊇ 契约 required」。
//
// 判据**不是**「有没有 fetch 桩」—— 那只能测出「这里 mock 了」，测不出「mock 的形状够不够」。
// 需要它的原因（task-160 `eab417a2`）：`openapi.yaml:6594` 的 `Workspace.required` = 8 项，
// 而手工夹具常只填用例当下用到的那几项，其余字段被 UI 读成 `undefined` 却不抛 —— 断言照绿。
//
// 三条规则（task-172 裁定）：
//   ① 夹具自己声明非 2xx（`new Response(body, { status })` / `route.fulfill({ status })`）
//      ⇒ 它是错误体，不是成功 schema 的实例 ⇒ 报 `NOTE fixture-error-body`（不判 E，也不静默）；
//   ② 工厂：**不做名字白名单**。在工厂**定义处**用 TS 编译器 API 取返回对象字面量的属性集合，
//      判 `⊇ required`。核过 ⇒ 调用点 `OK via factory <file:line>`（进 ok 计数）；
//      核不过 ⇒ 调用点报 `E_FIXTURE_MISSING_REQUIRED` 且**指到工厂定义行**；
//   ③ 认不出的形状（辅助函数包一层、多命中路径、无法解析的 spread）⇒ `undecidable`（缺省不猜）。
//
// 解析分层（两处都不手写 parser，与 `gen-api-docs.mjs` 的既有分工一致）：
//   · YAML → PyYAML（agent venv）。仓库 Node 侧没有 YAML 解析器：`scripts/validate-openapi.mjs`
//     头注释原文「the repo declares no YAML parser for Node」；
//   · TypeScript → `packages/ui/node_modules/typescript` 的真编译器 API。
//
// 用法：
//   node scripts/check-fixture-schema.mjs            # 只报告（report-only，exit 0）
//   node scripts/check-fixture-schema.mjs --enforce   # 有缺项 ⇒ exit 1
//   node scripts/check-fixture-schema.mjs --json      # 机器可读
//   node scripts/check-fixture-schema.mjs --selftest  # 6 组夹具，逐组证明会响
//
// **未接 `mise`**（task-166 禁区；task-172 也未要求接线）。
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
const TS_ENTRY = path.join(
    REPO,
    "packages",
    "ui",
    "node_modules",
    "typescript",
    "lib",
    "typescript.js",
);
const SCAN_ROOTS = [path.join(REPO, "packages", "ui", "src")];
const ENFORCE = process.argv.includes("--enforce");
const JSON_OUT = process.argv.includes("--json");
const SELFTEST = process.argv.includes("--selftest");
const VERBOSE = process.argv.includes("--verbose");

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
            "PyYAML interpreter not found; tried:" +
                LF +
                PY_CANDIDATES.map((c) => "  " + c).join(LF) +
                LF +
                "hint: mise run setup:agent, or set XH_PYTHON to a python that has PyYAML",
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
        const yamlMissing =
            stderr.indexOf("No module named") !== -1 && stderr.indexOf("yaml") !== -1;
        fail(
            2,
            "python parse failed (exit " +
                result.status +
                "): " +
                stderr +
                (yamlMissing
                    ? LF + "hint: PyYAML missing in this interpreter; mise run setup:agent"
                    : ""),
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
// ---------------------------------------------------------------- 契约侧：路径 → operation

function segmentsOf(routePath) {
    return String(routePath)
        .split("/")
        .filter((segment) => segment.length > 0);
}

function isDynamicContractSegment(segment) {
    return segment.startsWith("{") && segment.endsWith("}");
}

function segmentFits(contractSegment, fixtureSegment, contractSegments) {
    if (isDynamicContractSegment(contractSegment)) {
        // 动态段不能吞掉契约里自己的字面段名：`/workspaces`（列表）不许被 `{workspaceId}`（详情）吃掉。
        const literalNames = new Set(
            contractSegments
                .filter((segment) => !isDynamicContractSegment(segment))
                .map((segment) => segment.toLowerCase()),
        );
        return fixtureSegment.length > 0 && !literalNames.has(fixtureSegment.toLowerCase());
    }
    return contractSegment === fixtureSegment;
}

// 夹具里的 URL 常带真实 id / 省略前缀，所以按「精确 → 尾部对齐」逐级放松；
// 每一级都要求**唯一**命中：多命中就是判不了，不许猜（缺省不猜）。
//
// 为什么只允许尾部对齐：夹具要么写全 `/api/v1/workspaces/ws-1`，要么省略前缀写 `/workspaces/ws-1`；
// 两种都是契约路径的**尾部**。头部对齐会把 `/workspaces`（列表）配到 `/workspaces/{id}`（详情）上。
function matchPathSegments(contractSegments, fixtureSegments) {
    const fitsAll = (left, right) =>
        left.every((segment, index) => segmentFits(segment, right[index], contractSegments));
    if (contractSegments.length === fixtureSegments.length) {
        return fitsAll(contractSegments, fixtureSegments) ? "exact" : null;
    }
    if (contractSegments.length > fixtureSegments.length) {
        const tail = contractSegments.slice(contractSegments.length - fixtureSegments.length);
        return fitsAll(tail, fixtureSegments) ? "suffix" : null;
    }
    const tail = fixtureSegments.slice(fixtureSegments.length - contractSegments.length);
    return fitsAll(contractSegments, tail) ? "suffix" : null;
}

function resolveOperationLoosely(operations, method, contractPath) {
    const wantSegments = segmentsOf(contractPath);
    const sameMethod = operations.filter((op) => op.method === String(method).toLowerCase());
    const hits = [];
    for (const op of sameMethod) {
        const fit = matchPathSegments(segmentsOf(op.path), wantSegments);
        if (fit) hits.push({ op, fit });
    }
    if (hits.length === 0) return { op: null, reason: "no-unique-contract-path" };
    const exact = hits.filter((hit) => hit.fit === "exact");
    if (exact.length === 1) return { op: exact[0].op, reason: "" };
    if (hits.length > 1) {
        const suffix = hits.filter((hit) => hit.fit === "suffix");
        const candidates = suffix.length > 0 ? suffix : hits.filter((hit) => hit.fit === "prefix");
        if (candidates.length === 1) return { op: candidates[0].op, reason: "" };
        if (candidates.length > 1) {
            const shortest = candidates
                .slice()
                .sort(
                    (left, right) =>
                        segmentsOf(left.op.path).length - segmentsOf(right.op.path).length,
                );
            const shortestLength = segmentsOf(shortest[0].op.path).length;
            const tied = shortest.filter(
                (hit) => segmentsOf(hit.op.path).length === shortestLength,
            );
            if (tied.length === 1) return { op: tied[0].op, reason: "" };
        }
        return { op: null, reason: "no-unique-contract-path" };
    }
    return { op: null, reason: "no-unique-contract-path" };
}
// ---------------------------------------------------------------- 夹具侧：响应体 → 形状来源

function relPathOf(file) {
    return path.relative(REPO, file).split(path.sep).join("/");
}

function lineOf(ts, sourceFile, node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function unwrapExpr(ts, node) {
    let current = node;
    while (current) {
        if (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
            current = current.expression;
            continue;
        }
        if (ts.isTypeAssertionExpression(current)) {
            current = current.expression;
            continue;
        }
        if (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current)) {
            current = current.expression;
            continue;
        }
        return current;
    }
    return current;
}

// `new Response(body, { status })` / `route.fulfill({ status, body })`：夹具自己声明的状态码。
// 缺声明按 HTTP 默认 200 处理（`new Response` 的默认值就是 200）。
function declaredStatus(ts, payloadHost) {
    const objectLiterals = [];
    if (ts.isNewExpression(payloadHost)) {
        for (const arg of payloadHost.arguments || []) {
            if (ts.isObjectLiteralExpression(arg)) objectLiterals.push(arg);
        }
    }
    if (ts.isPropertyAssignment(payloadHost)) {
        let parent = payloadHost.parent;
        while (parent && !ts.isObjectLiteralExpression(parent)) parent = parent.parent;
        if (parent) objectLiterals.push(parent);
    }
    for (const literal of objectLiterals) {
        for (const property of literal.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = property.name;
            if (!name || !ts.isIdentifier(name) || name.text !== "status") continue;
            const value = unwrapExpr(ts, property.initializer);
            if (ts.isNumericLiteral(value)) return Number(value.text);
            return null; // 状态码不是字面量 ⇒ 判不了，按「未声明」处理
        }
    }
    return 200;
}

// 收集本文件里所有「响应体表达式」。三种载体：`new Response(...)`、`route.fulfill({ body })`、
// 测试自写的 `jsonResponse(...)`（后者经形参 → 调用点解析，见 resolveBody）。
// 「载体」判定：`function jsonResponse(body) { return new Response(JSON.stringify(body), …) }` ——
// 响应体是**形参**，它本身不是夹具，夹具在调用点（`jsonResponse({ … })`），调用点已单独判过。
// 这类行既不该算「判不了」（会把 note 列表淹没），也不该静默 —— 单独计数 `carrier=`（`--verbose` 展开）。
function isParamCarrier(ts, expr, atNode) {
    let node = unwrapExpr(ts, expr);
    if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : "";
        if (name === "stringify" && node.arguments && node.arguments[0]) {
            node = unwrapExpr(ts, node.arguments[0]);
        }
    }
    if (!ts.isIdentifier(node)) return false;
    for (const scopeNode of scopeChainOf(ts, atNode)) {
        if (!ts.isFunctionLike(scopeNode)) continue;
        for (const parameter of scopeNode.parameters || []) {
            if (ts.isIdentifier(parameter.name) && parameter.name.text === node.text) return true;
        }
    }
    return false;
}

function responsePayloads(ts, sourceFile) {
    const found = [];
    const collectFulfillBody = (call) => {
        const arg = call.arguments && call.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return;
        for (const property of arg.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = property.name;
            if (!name || !ts.isIdentifier(name) || name.text !== "body") continue;
            found.push({ expr: property.initializer, host: property });
        }
    };
    const visit = (node) => {
        if (ts.isNewExpression(node)) {
            const callee = node.expression;
            const isResponse =
                (ts.isIdentifier(callee) && callee.text === "Response") ||
                (ts.isPropertyAccessExpression(callee) && callee.name.text === "Response");
            const arg = node.arguments && node.arguments[0];
            if (
                isResponse &&
                arg &&
                !(ts.isNumericLiteral(arg) || arg.kind === ts.SyntaxKind.NullKeyword)
            ) {
                if (arg.kind === ts.SyntaxKind.NullKeyword) return ts.forEachChild(node, visit);
                found.push({ expr: arg, host: node });
            }
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const calleeName = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
            if (calleeName === "fulfill") collectFulfillBody(node);
            else if (calleeName === "jsonResponse" && node.arguments && node.arguments[0]) {
                found.push({ expr: node.arguments[0], host: node });
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return found;
}

function scopeChainOf(ts, node) {
    const chain = [];
    let current = node;
    while (current) {
        if (ts.isFunctionLike(current)) chain.push(current);
        current = current.parent;
    }
    return chain;
}

function localAssignmentExpr(ts, scopeNode, name, atNode) {
    let found = null;
    const visit = (child) => {
        if (
            ts.isVariableDeclaration(child) &&
            ts.isIdentifier(child.name) &&
            child.name.text === name &&
            child.initializer
        ) {
            if (child.getStart() < atNode.getStart()) found = child.initializer;
        }
        ts.forEachChild(child, visit);
    };
    ts.forEachChild(scopeNode, visit);
    return found;
}

function paramCallArgs(ts, sourceFile, scopeNode, name) {
    if (!ts.isFunctionLike(scopeNode)) return [];
    const parameters = scopeNode.parameters || [];
    let index = -1;
    for (let cursor = 0; cursor < parameters.length; cursor += 1) {
        const parameter = parameters[cursor];
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) {
            index = cursor;
            break;
        }
    }
    if (index < 0) return [];
    const functionName =
        scopeNode.name && ts.isIdentifier(scopeNode.name) ? scopeNode.name.text : "";
    if (!functionName) return [];
    const args = [];
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (
                ts.isIdentifier(callee) &&
                callee.text === functionName &&
                node.arguments &&
                node.arguments[index]
            ) {
                args.push(node.arguments[index]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return args;
}
// ---------------------------------------------------------------- 工厂定义：判据下沉到定义处

// 不做名字白名单（task-172 裁定：`makeWorkspace`/`buildWorkspace`/以后第三个名字，白名单越用越像名单）。
// 做法：跟着 spec 的相对 import 找到模块，取「导出函数 return 的对象字面量」的**属性集合**，
// 再拿它去比 required。新工厂只要形状对就自动被认。
function parseTsFile(ts, file) {
    const source = fs.readFileSync(file, "utf8");
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function resolveModuleFile(fromFile, spec) {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base + ".ts", base + ".tsx", base + ".mts", path.join(base, "index.ts")];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function topLevelConstInitializer(ts, sourceFile, name) {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === name &&
                declaration.initializer
            ) {
                return unwrapExpr(ts, declaration.initializer);
            }
        }
    }
    return null;
}

// 对象字面量的属性集合。可解析的 spread（指向同文件的 const 对象）**合并进来**；
// 解析不了的 spread（形参、外部值）**跳过**：它只能加字段、不能保证 required，所以不能算满足。
function literalShape(ts, sourceFile, literal) {
    const names = new Set();
    for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) {
            const inner = unwrapExpr(ts, property.expression);
            if (!ts.isIdentifier(inner)) continue;
            const initializer = topLevelConstInitializer(ts, sourceFile, inner.text);
            if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
            for (const name of literalShape(ts, sourceFile, initializer)) names.add(name);
            continue;
        }
        const name = property.name;
        if (!name) continue;
        if (ts.isIdentifier(name)) names.add(name.text);
        else if (ts.isStringLiteral(name)) names.add(name.text);
    }
    return names;
}

function returnedLiteralOf(ts, fnNode) {
    const body = fnNode.body;
    if (!body) return null;
    if (!ts.isBlock(body)) {
        const literal = unwrapExpr(ts, body);
        return ts.isObjectLiteralExpression(literal) ? literal : null;
    }
    let found = null;
    for (const statement of body.statements) {
        if (!ts.isReturnStatement(statement) || !statement.expression) continue;
        const literal = unwrapExpr(ts, statement.expression);
        if (ts.isObjectLiteralExpression(literal)) found = literal;
    }
    return found;
}

const FACTORY_CACHE = new Map();

function factoriesOfModule(ts, moduleFile) {
    if (FACTORY_CACHE.has(moduleFile)) return FACTORY_CACHE.get(moduleFile);
    const factories = new Map();
    const sourceFile = parseTsFile(ts, moduleFile);
    const add = (name, fnNode) => {
        const literal = returnedLiteralOf(ts, fnNode);
        if (!literal) return;
        factories.set(name, {
            name,
            file: relPathOf(moduleFile),
            line: lineOf(ts, sourceFile, fnNode),
            props: literalShape(ts, sourceFile, literal),
        });
    };
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
            add(statement.name.text, statement);
            continue;
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const init = unwrapExpr(ts, declaration.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
                add(declaration.name.text, init);
        }
    }
    FACTORY_CACHE.set(moduleFile, factories);
    return factories;
}

// spec 文件可见的工厂：跟着它的相对 import 走一层（够用：工厂都直接 import 进来）。
function factoryIndexFor(ts, sourceFile, moduleFile) {
    const index = new Map();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
        const bindings = statement.importClause.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const spec =
            statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : "";
        const target = spec ? resolveModuleFile(moduleFile, spec) : null;
        if (!target) continue;
        for (const element of bindings.elements) {
            const localName = element.name.text;
            const importedName =
                element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : localName;
            const factory = factoriesOfModule(ts, target).get(importedName);
            if (factory) index.set(localName, factory);
        }
    }
    return index;
}
// ---------------------------------------------------------------- 形状来源解析（不猜）

function resolveIdentifier(ts, context, name, atNode, depth) {
    if (depth > 4) return { list: [], reason: "wrapper-unresolved" };
    for (const scopeNode of scopeChainOf(ts, atNode)) {
        const initializer = localAssignmentExpr(ts, scopeNode, name, atNode);
        if (initializer) return resolveBody(ts, context, initializer, atNode, depth + 1);
        const args = paramCallArgs(ts, context.sourceFile, scopeNode, name);
        if (args.length === 0) continue;
        const list = [];
        let reason = "";
        for (const arg of args) {
            const resolved = resolveBody(ts, context, arg, atNode, depth + 1);
            if (resolved.list.length > 0) list.push(...resolved.list);
            else reason = resolved.reason || reason;
        }
        if (list.length > 0) return { list, reason: "" };
        return { list: [], reason: reason || "wrapper-unresolved" };
    }
    return { list: [], reason: "wrapper-unresolved" };
}

function resolveBody(ts, context, expr, atNode, depth) {
    if (depth > 4) return { list: [], reason: "wrapper-unresolved" };
    const node = unwrapExpr(ts, expr);
    if (ts.isIdentifier(node)) return resolveIdentifier(ts, context, node.text, atNode, depth);
    if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : "";
        // `new Response(JSON.stringify(x))`：序列化只是载体，判的是 x 的形状。
        if (name === "stringify" && node.arguments && node.arguments[0]) {
            return resolveBody(ts, context, node.arguments[0], atNode, depth + 1);
        }
        const factory = name ? context.factories.get(name) : null;
        if (factory) return { list: [{ kind: "factory", node, factory }], reason: "" };
        return { list: [], reason: "call-not-a-factory" };
    }
    if (!ts.isObjectLiteralExpression(node)) return { list: [], reason: "unresolved-body" };
    const spreads = node.properties.filter((property) => ts.isSpreadAssignment(property));
    const named = node.properties.filter((property) => !ts.isSpreadAssignment(property));
    if (spreads.length > 0) return { list: [], reason: "spread-in-literal" };
    if (named.length === 1 && ts.isShorthandPropertyAssignment(named[0])) {
        return resolveIdentifier(ts, context, named[0].name.text, atNode, depth + 1);
    }
    return { list: [{ kind: "literal", node }], reason: "" };
}

function namesOfLiteral(ts, literal) {
    const names = new Set();
    for (const property of literal.properties) {
        const name = property.name;
        if (!name) continue;
        if (ts.isIdentifier(name)) names.add(name.text);
        else if (ts.isStringLiteral(name)) names.add(name.text);
    }
    return names;
}

// ---------------------------------------------------------------- 路径与方法（就近判定）

function literalTextOf(ts, node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isTemplateExpression(node)) return null;
    let out = node.head.text;
    for (const span of node.templateSpans) out += "${EXPR}" + span.literal.text;
    return out;
}

// 唯一约定：夹具 URL 必须能被认成 API 路径（含 `/api/` 或 `/workspaces/`）。
function urlLiteralsIn(ts, node) {
    const found = [];
    const visit = (child) => {
        const text = literalTextOf(ts, child);
        if (text && (text.indexOf("/api/") !== -1 || text.indexOf("/workspaces/") !== -1)) {
            found.push({ text, node: child });
        }
        ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
}

// 只认**最近的 if 条件**，不做函数级兜底：函数里常有多条互斥分支（配置页 `{}` / `{domain}`），
// 兜底会把 A 分支的 URL 配到 B 分支的响应上（task-166 实证：WorkspaceSettingsView 两个假阳性）。
function nearestUrlLiteral(ts, atNode) {
    let current = atNode;
    while (current && !ts.isFunctionLike(current)) {
        if (ts.isIfStatement(current)) {
            const hits = urlLiteralsIn(ts, current.expression);
            if (hits.length > 0) return hits[0];
        }
        current = current.parent;
    }
    return null;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function nearestMethod(ts, atNode) {
    let current = atNode;
    while (current) {
        const text = literalTextOf(ts, current);
        if (text && HTTP_METHODS.has(text)) return text;
        current = current.parent;
    }
    return "GET";
}

function fixtureSegmentsOf(urlText) {
    let raw = urlText.split("?")[0];
    const scheme = raw.indexOf("://");
    if (scheme >= 0) {
        const slash = raw.indexOf("/", scheme + 3);
        raw = slash >= 0 ? raw.slice(slash) : "/";
    }
    const segments = segmentsOf(raw);
    // 尾斜杠的 URL 是「被截断的前缀」（`pathname.includes("/api/v1/workspaces/")`），
    // 后面至少还有一个段 —— 补一个哨兵段，否则它会被当成集合端点（`/api/v1/workspaces`）。
    if (raw.endsWith("/")) segments.push("{truncated}");
    return segments;
}
// ---------------------------------------------------------------- 判定

function scanFile(ts, contract, file) {
    const findings = [];
    const fileLabel = relPathOf(file);
    const sourceFile = parseTsFile(ts, file);
    const context = { sourceFile, factories: factoryIndexFor(ts, sourceFile, file) };
    for (const payload of responsePayloads(ts, sourceFile)) {
        const callLine = lineOf(ts, sourceFile, payload.host);
        if (isParamCarrier(ts, payload.expr, payload.host)) {
            findings.push({ file: fileLabel, line: callLine, code: "fixture-carrier" });
            continue;
        }
        const urlLiteral = nearestUrlLiteral(ts, payload.host);
        if (!urlLiteral) {
            findings.push({ file: fileLabel, line: callLine, reason: "no-api-url-in-scope" });
            continue;
        }
        const method = nearestMethod(ts, payload.host);
        const fixtureSegments = fixtureSegmentsOf(urlLiteral.text);
        const resolvedOperation = resolveOperationLoosely(
            contract.operations,
            method,
            "/" + fixtureSegments.join("/"),
        );
        if (!resolvedOperation.op || !resolvedOperation.op.schema) {
            findings.push({
                file: fileLabel,
                line: callLine,
                reason: resolvedOperation.reason || "no-response-schema",
                url: urlLiteral.text,
            });
            continue;
        }
        const operation = resolvedOperation.op;
        const required = (contract.schemas[operation.schema] || {}).required || [];
        if (required.length === 0) continue;
        const base = {
            file: fileLabel,
            line: callLine,
            schema: operation.schema,
            method: operation.method,
            path: operation.path,
            url: urlLiteral.text,
        };
        // 规则①：夹具自己声明非 2xx ⇒ 它是错误体，不是成功 schema 的实例。
        const status = declaredStatus(ts, payload.host);
        if (typeof status === "number" && (status < 200 || status >= 300)) {
            findings.push({ ...base, code: "fixture-error-body", status });
            continue;
        }
        const resolved = resolveBody(ts, context, payload.expr, payload.host, 0);
        if (resolved.list.length === 0) {
            findings.push({ ...base, reason: resolved.reason || "wrapper-unresolved" });
            continue;
        }
        for (const source of resolved.list) {
            // 锚点取**形状来源**那一行：直接写在 `new Response(...)` 里时就是响应体行；
            // 经辅助函数 `jsonResponse({ workspace })` 回到调用点时，就是 `hydrateFromHttp(makeWorkspace(...))` 那一行 ——
            // 三个调用点各出一条，不再挤在辅助函数的同一行上。
            const siteBase = { ...base, line: lineOf(ts, sourceFile, source.node) };
            if (source.kind === "literal") {
                const props = namesOfLiteral(ts, source.node);
                const missing = required.filter((field) => !props.has(field));
                findings.push({ ...siteBase, missing, ok: missing.length === 0 });
                continue;
            }
            // 规则②：工厂调用点 → 用**工厂定义处**的属性集合判，缺项时锚点指工厂行。
            const factory = source.factory;
            const missing = required.filter((field) => !factory.props.has(field));
            if (missing.length === 0) {
                findings.push({
                    ...siteBase,
                    missing,
                    ok: true,
                    via: "factory",
                    factory: { file: factory.file, line: factory.line, name: factory.name },
                });
                continue;
            }
            findings.push({
                file: factory.file,
                line: factory.line,
                callSite: { file: fileLabel, line: siteBase.line },
                schema: operation.schema,
                method: operation.method,
                path: operation.path,
                url: urlLiteral.text,
                missing,
                ok: false,
                via: "factory",
                factory: { file: factory.file, line: factory.line, name: factory.name },
            });
        }
    }
    return findings;
}

function walkSpecFiles() {
    const files = [];
    const visit = (directory) => {
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === "dist") continue;
                visit(full);
                continue;
            }
            if (!entry.name.endsWith(".spec.ts")) continue;
            if (full.split(path.sep).join("/").indexOf("/__tests__/") === -1) continue;
            files.push(full);
        }
    };
    for (const root of SCAN_ROOTS) visit(root);
    return files.sort();
}

function bucketOf(finding) {
    if (finding.code === "fixture-carrier") return "carrier";
    if (finding.code === "fixture-error-body") return "undecidable";
    if (finding.reason) return "undecidable";
    return finding.ok ? "ok" : "missing";
}

function describeFinding(finding) {
    const anchor = finding.file + ":" + String(finding.line);
    if (finding.code === "fixture-carrier") {
        return (
            "NOTE fixture-carrier " +
            anchor +
            " (辅助函数把形参原样包成响应体；夹具在调用点，已单独判定)"
        );
    }
    if (finding.code === "fixture-error-body") {
        const callSite = finding.callSite
            ? " callSite=" + finding.callSite.file + ":" + String(finding.callSite.line)
            : "";
        return (
            "NOTE fixture-error-body " +
            anchor +
            callSite +
            " status=" +
            String(finding.status) +
            " schema=" +
            finding.schema +
            " " +
            finding.method.toUpperCase() +
            " " +
            finding.path +
            " (非 2xx ⇒ 错误体，不按成功 schema 判定)"
        );
    }
    if (finding.reason) {
        return (
            "NOTE fixture-unclassified " +
            anchor +
            " reason=" +
            finding.reason +
            " url=" +
            (finding.url || "<none>")
        );
    }
    if (finding.ok) {
        if (finding.via === "factory") {
            return (
                "OK via factory " +
                anchor +
                " factory=" +
                finding.factory.file +
                ":" +
                String(finding.factory.line) +
                " (" +
                finding.factory.name +
                ") schema=" +
                finding.schema +
                " " +
                finding.method.toUpperCase() +
                " " +
                finding.path
            );
        }
        return (
            "OK literal " +
            anchor +
            " schema=" +
            finding.schema +
            " " +
            finding.method.toUpperCase() +
            " " +
            finding.path
        );
    }
    const callSite = finding.callSite
        ? " callSites=" + finding.callSite.file + ":" + String(finding.callSite.line)
        : "";
    const via = finding.via === "factory" ? " via=factory " + finding.factory.name + callSite : "";
    return (
        "E_FIXTURE_MISSING_REQUIRED " +
        anchor +
        via +
        " schema=" +
        finding.schema +
        " " +
        finding.method.toUpperCase() +
        " " +
        finding.path +
        " missing=[" +
        finding.missing.join(", ") +
        "]"
    );
}
// ---------------------------------------------------------------- 报告

function summarize(findings) {
    const summary = { total: 0, ok: 0, missing: 0, undecidable: 0, carrier: 0 };
    for (const finding of findings) {
        const bucket = bucketOf(finding);
        summary[bucket] += 1;
        if (bucket !== "carrier") summary.total += 1;
    }
    return summary;
}

function printFindings(findings) {
    for (const kind of ["missing", "undecidable", "ok", ...(VERBOSE ? ["carrier"] : [])]) {
        for (const finding of findings) {
            if (bucketOf(finding) === kind) console.log(describeFinding(finding));
        }
    }
}

function reasonHistogram(findings) {
    const counts = new Map();
    for (const finding of findings) {
        const key =
            finding.code === "fixture-error-body" ? "fixture-error-body" : finding.reason || "";
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function main() {
    const python = findPython();
    const contract = parseContractAt(python, CONTRACT);
    const ts = loadTs();
    const files = walkSpecFiles();
    const findings = [];
    for (const file of files) {
        for (const finding of scanFile(ts, contract, file)) findings.push(finding);
    }
    const summary = summarize(findings);
    const requiredSchemas = Object.values(contract.schemas).filter(
        (schema) => (schema.required || []).length > 0,
    ).length;
    if (JSON_OUT) {
        const payload = {
            contract: {
                schemas: Object.keys(contract.schemas).length,
                operations: contract.operations.length,
                requiredSchemas,
            },
            specFiles: files.length,
            summary,
            reasons: reasonHistogram(findings),
            findings: findings.map((finding) => ({
                bucket: bucketOf(finding),
                line: describeFinding(finding),
                file: finding.file,
                sourceLine: finding.line,
                schema: finding.schema || null,
                missing: finding.missing || [],
                reason: finding.reason || finding.code || null,
                via: finding.via || null,
            })),
        };
        console.log(JSON.stringify(payload, null, 2));
        if (ENFORCE && summary.missing > 0) process.exit(1);
        return;
    }
    printFindings(findings);
    for (const entry of reasonHistogram(findings))
        console.log("reason " + entry[0] + " = " + String(entry[1]));
    console.log(
        "contract schemas=" +
            String(Object.keys(contract.schemas).length) +
            " operations=" +
            String(contract.operations.length) +
            " (required 非空的 schema=" +
            String(requiredSchemas) +
            ") specFiles=" +
            String(files.length),
    );
    console.log(
        "summary total=" +
            String(summary.total) +
            " ok=" +
            String(summary.ok) +
            " missing=" +
            String(summary.missing) +
            " undecidable=" +
            String(summary.undecidable) +
            " carrier=" +
            String(summary.carrier),
    );
    if (ENFORCE && summary.missing > 0) process.exit(1);
}
// ---------------------------------------------------------------- selftest：6 组夹具，逐组证明会响

function writeFixture(root, relative, lines) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join(LF) + LF, "utf8");
    return file;
}

const SELFTEST_CONTRACT = [
    "openapi: 3.0.3",
    "paths:",
    "  /api/v1/workspaces/{workspaceId}:",
    "    get:",
    "      responses:",
    "        '200':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Workspace'",
    "components:",
    "  schemas:",
    "    Workspace:",
    "      type: object",
    "      required: [id, name, ownerId]",
    "      properties:",
    "        id: { type: string }",
    "        name: { type: string }",
    "        ownerId: { type: string }",
];

// 夹具骨架：URL 在最近的 if 条件里（与真树同形），响应体由 corpus 决定。
function selftestSpecWithResponseBody(bodyLines) {
    return [
        "const fetchMock = vi.fn();",
        "",
        "function mockFetch(): void {",
        "    fetchMock.mockImplementation((input: unknown) => {",
        "        const url = String(input);",
        '        if (url.endsWith("/api/v1/workspaces/ws-1")) {',
        "            return Promise.resolve(",
        ...bodyLines,
        "            );",
        "        }",
        "        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));",
        "    });",
        "}",
    ];
}

const SELFTEST_BODIES = {
    missing: [
        '                new Response(JSON.stringify({ id: "ws-1", name: "W" }), { status: 200 }),',
    ],
    full: [
        '                new Response(JSON.stringify({ id: "ws-1", name: "W", ownerId: "p-1" }), { status: 200 }),',
    ],
    extra: [
        '                new Response(JSON.stringify({ id: "ws-1", name: "W", ownerId: "p-1", capability: "canWrite" }), { status: 200 }),',
    ],
    errorBody: [
        '                new Response(JSON.stringify({ code: "WORKSPACE_FORBIDDEN", status: 403, detail: "x" }), { status: 403 }),',
    ],
    factoryCall: ["                new Response(JSON.stringify(makeWs()), { status: 200 }),"],
};

function runSelftest() {
    const python = findPython();
    const ts = loadTs();
    const root = path.join(os.tmpdir(), "check-fixture-schema-selftest-" + String(process.pid));
    fs.rmSync(root, { recursive: true, force: true });
    const contract = parseContractAt(python, writeFixture(root, "openapi.yaml", SELFTEST_CONTRACT));
    let failures = 0;
    const report = (name, ok, detail) => {
        if (!ok) failures += 1;
        console.log((ok ? "PASS " : "FAIL ") + name + " " + detail);
    };
    const scan = (file) => summarize(scanFile(ts, contract, file));
    const missingOf = (file) => {
        const hits = scanFile(ts, contract, file).filter(
            (finding) => bucketOf(finding) === "missing",
        );
        return hits.length > 0 ? hits : null;
    };
    const okOf = (file) => {
        const hits = scanFile(ts, contract, file).filter((finding) => bucketOf(finding) === "ok");
        return hits.length > 0 ? hits : null;
    };
    const noteOf = (file) => {
        const hits = scanFile(ts, contract, file).filter(
            (finding) => bucketOf(finding) === "undecidable",
        );
        return hits.length > 0 ? hits : null;
    };

    // ① 缺 1 项必报
    const fileMissing = writeFixture(
        root,
        "a/__tests__/missing.spec.ts",
        selftestSpecWithResponseBody(SELFTEST_BODIES.missing),
    );
    const hitMissing = missingOf(fileMissing);
    report(
        "① 缺 1 项必报",
        Boolean(hitMissing) &&
            hitMissing.length === 1 &&
            hitMissing[0].missing.join(",") === "ownerId",
        "findings=" +
            String(scan(fileMissing).total) +
            " missing=" +
            String(scan(fileMissing).missing) +
            " fields=[" +
            (hitMissing ? hitMissing[0].missing.join(",") : "") +
            "]",
    );

    // ② 全必填不报
    const fileFull = writeFixture(
        root,
        "b/__tests__/full.spec.ts",
        selftestSpecWithResponseBody(SELFTEST_BODIES.full),
    );
    report(
        "② 全必填不报",
        Boolean(okOf(fileFull)) && scan(fileFull).missing === 0,
        "findings=" +
            String(scan(fileFull).total) +
            " ok=" +
            String(scan(fileFull).ok) +
            " missing=" +
            String(scan(fileFull).missing),
    );

    // ③ 多字段不报（契约允许增量）
    const fileExtra = writeFixture(
        root,
        "c/__tests__/extra.spec.ts",
        selftestSpecWithResponseBody(SELFTEST_BODIES.extra),
    );
    report(
        "③ 多字段不报",
        Boolean(okOf(fileExtra)) && scan(fileExtra).missing === 0,
        "findings=" +
            String(scan(fileExtra).total) +
            " ok=" +
            String(scan(fileExtra).ok) +
            " missing=" +
            String(scan(fileExtra).missing),
    );

    // ④ 非 2xx 问题体 ⇒ NOTE（不是 E、也不静默）
    const fileError = writeFixture(
        root,
        "d/__tests__/errorBody.spec.ts",
        selftestSpecWithResponseBody(SELFTEST_BODIES.errorBody),
    );
    const hitError = noteOf(fileError);
    const errorBodyFinding = hitError
        ? hitError.find((finding) => finding.code === "fixture-error-body")
        : null;
    report(
        "④ 非 2xx 问题体 ⇒ NOTE",
        Boolean(errorBodyFinding) && scan(fileError).missing === 0,
        "findings=" +
            String(scan(fileError).total) +
            " undecidable=" +
            String(scan(fileError).undecidable) +
            " code=" +
            (errorBodyFinding ? errorBodyFinding.code : "<none>") +
            " status=" +
            (errorBodyFinding ? String(errorBodyFinding.status) : "<none>"),
    );

    // ⑤ 工厂形状不全 ⇒ 调用点报 E，锚点指**工厂定义行**（不是调用行）
    writeFixture(root, "e/fixtures/incomplete.ts", [
        'const DEFAULTS = { id: "ws-1" } as const;',
        "",
        "export function makeWs(overrides: Record<string, unknown> = {}): Record<string, unknown> {",
        "    return { ...DEFAULTS, ...overrides };",
        "}",
    ]);
    const fileIncomplete = writeFixture(root, "e/__tests__/factoryIncomplete.spec.ts", [
        'import { makeWs } from "../fixtures/incomplete";',
        "",
        ...selftestSpecWithResponseBody(SELFTEST_BODIES.factoryCall),
    ]);
    const hitIncomplete = missingOf(fileIncomplete);
    const anchoredAtFactory =
        hitIncomplete !== null &&
        path.basename(hitIncomplete[0].file) === "incomplete.ts" &&
        path.basename(hitIncomplete[0].file) !== path.basename(fileIncomplete);
    report(
        "⑤ 工厂形状不全 ⇒ 调用点报 E 且指工厂行",
        Boolean(anchoredAtFactory) && hitIncomplete[0].missing.join(",") === "name,ownerId",
        "anchor=" +
            (hitIncomplete
                ? path.basename(hitIncomplete[0].file) + ":" + String(hitIncomplete[0].line)
                : "<none>") +
            " callSite=" +
            (hitIncomplete && hitIncomplete[0].callSite
                ? path.basename(hitIncomplete[0].callSite.file) +
                  ":" +
                  String(hitIncomplete[0].callSite.line)
                : "<none>") +
            " fields=[" +
            (hitIncomplete ? hitIncomplete[0].missing.join(",") : "") +
            "]",
    );

    // ⑥ 工厂形状全 ⇒ 调用点 `OK via factory`（ok 计数要涨，不能恒 0）
    writeFixture(root, "f/fixtures/full.ts", [
        'const DEFAULTS = { id: "ws-1", name: "W", ownerId: "p-1" } as const;',
        "",
        "export function makeWs(overrides: Record<string, unknown> = {}): Record<string, unknown> {",
        "    return { ...DEFAULTS, ...overrides };",
        "}",
    ]);
    const fileFactoryFull = writeFixture(root, "f/__tests__/factoryFull.spec.ts", [
        'import { makeWs } from "../fixtures/full";',
        "",
        ...selftestSpecWithResponseBody(SELFTEST_BODIES.factoryCall),
    ]);
    const hitFactoryOk = okOf(fileFactoryFull);
    report(
        "⑥ 工厂形状全 ⇒ OK via factory",
        Boolean(hitFactoryOk) &&
            hitFactoryOk[0].via === "factory" &&
            scan(fileFactoryFull).missing === 0,
        "findings=" +
            String(scan(fileFactoryFull).total) +
            " ok=" +
            String(scan(fileFactoryFull).ok) +
            " via=" +
            (hitFactoryOk ? String(hitFactoryOk[0].via) : "<none>") +
            " factory=" +
            (hitFactoryOk
                ? path.basename(hitFactoryOk[0].factory.file) +
                  ":" +
                  String(hitFactoryOk[0].factory.line)
                : "<none>"),
    );

    fs.rmSync(root, { recursive: true, force: true });
    if (failures > 0) {
        console.error("selftest FAILED (" + String(failures) + "/6)");
        process.exit(1);
    }
    console.log("selftest OK (6 cases)");
}

if (SELFTEST) runSelftest();
else main();
