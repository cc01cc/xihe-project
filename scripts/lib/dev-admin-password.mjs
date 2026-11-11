#!/usr/bin/env node
/**
 * D-766（用户裁定 P5=A）乙案最小版：dev 栈管理员密码的**确定性来源**。
 *
 * 问题：`DataSeeder` 只在 `admin@xihe.local` **不存在**时按 `XIHE_DEV_ADMIN_PASSWORD`
 * 建行，存量库里随机生成的旧密码不会被更新 ⇒ 拿不到密码就没法登录 dev 栈。
 *
 * 本模块只做一件事：按固定优先级**算出**本次 dev 栈应该用的密码，并回答「它从哪来」。
 * 它**不**打印密码值、不碰数据库、不起进程 —— upsert 由 `dev-stack.mjs` 复用既有
 * `scripts/reset-admin.ps1`（内部 ResetAdmin.java）完成，日志只取 `formatDevAdminPassword()`
 * 的非密元数据（来源 / 字符数 / 落盘路径）。
 *
 * 优先级（**B′ 四层序**，2026-11-11 用户裁定；与 Spring Boot / AWS CLI / Ansible /
 * Docker Compose 的「显式 override > 持久文件（真相）> 打包默认」同构）：
 *   1. 显式 OS env `XIHE_DEV_ADMIN_PASSWORD`（调用方/CI 指定，最高；不落盘）
 *   2. `.local/dev/admin-password`（gitignored，0700/0600 owner-only）—— **持久单源 = 真相**
 *   3. `.env → .env.$XIHE_ENV → .env.local` 链（复用 `env-file.mjs`，与 CP 侧 DotenvLoader /
 *      `xihe` CLI 同一口径；fill-gaps）—— **仅首次种子**，不覆盖 ②
 *   4. 生成一次（24 字节 base64url = 32 字符）并持久到 ② 的路径，此后稳定复用
 *
 * B′ 与旧序（D-766 乙案）的唯一差别：②③ **对调**。旧的 `.env` 优先会让持久文件被永久遮蔽
 * （实测主检 `source=env-file` 且 `hasFile=true`，改了 `.env.local` 悄悄换掉登录密码），
 * 现在**文件存在即文件生效**，改 `.env.local` 不再影响已持久化的 checkout。
 * 显式 OS env 仍在最前，CI/临时验证的覆盖通道保留。
 *
 * **不做 materialize**：③ 命中且 ② 不存在时只使用该值，**不**把 ③ 写进 ②（用户裁定；
 * 否则"看一眼/起一次栈"就会凭空改写持久源）。
 *
 * 落盘权限：`mode: 0o600`（owner-only）。Windows/NTFS 上 mode 位基本是建议值，真正的
 * 访问控制在 ACL 上；仓库内不写机器路径，文件位置一律由调用方给的项目根派生。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadEnvFileChain } from "./env-file.mjs";

/** 与 CP `DataSeeder` 同一个注入键（PLAN-0547）。 */
export const ADMIN_PASSWORD_ENV = "XIHE_DEV_ADMIN_PASSWORD";

/** 相对 checkout 根的持久位置（`.local/` 已在 .gitignore，见 .gitignore §Dev/test data）。 */
export const ADMIN_PASSWORD_FILE = [".local", "dev", "admin-password"];

/** 24 字节 → base64url 32 字符，满足「随机 12+ 位」的 workspace 约定（同 ResetAdmin/DataSeeder）。 */
export const ADMIN_PASSWORD_BYTES = 24;

/** 持久文件路径：`<projectRoot>/.local/dev/admin-password`。 */
export function devAdminPasswordFile(projectRoot) {
    return resolve(projectRoot, ...ADMIN_PASSWORD_FILE);
}

function normalize(value) {
    return typeof value === "string" ? value.trim() : "";
}

/** 生成一次密码：24 字节 base64url、无填充（URL 安全，能直接进 env）。 */
export function generateDevAdminPassword({ bytes = ADMIN_PASSWORD_BYTES, randomBytesImpl = randomBytes } = {}) {
    return randomBytesImpl(bytes).toString("base64url");
}

/** 读持久文件；不存在 / 空文件 ⇒ null（空文件视为未配置，不当成「空密码」）。 */
export function readDevAdminPasswordFile(file, { readFile = readFileSync } = {}) {
    if (!existsSync(file)) return null;
    return normalize(readFile(file, "utf8")) || null;
}

/** 写持久文件（owner-only）。目录按需创建；返回值即路径，便于日志只打路径。 */
export function writeDevAdminPasswordFile(
    file,
    password,
    { mkdir = mkdirSync, write = writeFileSync } = {},
) {
    mkdir(dirname(file), { recursive: true, mode: 0o700 });
    write(file, `${password}\n`, { encoding: "utf8", mode: 0o600 });
    return file;
}

/**
 * 按 **B′ 四层序**解析本次 dev 管理员密码（① OS env → ② 持久文件 → ③ `.env` 链 → ④ 生成）。
 *
 * @param {object} options
 * @param {string} options.projectRoot checkout 根（持久文件与 .env 链都相对它）
 * @param {Record<string, string|undefined>} [options.env] 环境袋，默认 process.env
 * @param {string} [options.cwd] `.env` 链的查找起点，默认 projectRoot
 * @param {string} [options.file] 覆盖持久文件路径（测试用）
 * @param {() => string} [options.generate] 覆盖生成器（测试用）
 * @param {boolean} [options.persist] `false` = 只读观察（status/诊断），绝不生成/落盘
 * @returns {{password: string|null, source: "env"|"file"|"env-file"|"generated"|"missing",
 *   length: number, file: string|null, persisted: "none"|"reused"|"created"}}
 */
export function resolveDevAdminPassword({
    projectRoot,
    env = process.env,
    cwd = projectRoot,
    file,
    generate = generateDevAdminPassword,
    persist = true,
} = {}) {
    const target = file ?? devAdminPasswordFile(projectRoot);

    // ① 显式 OS env（调用方/CI）：最高优先级，且**不落盘**（一次性的 override 不该被持久化）。
    const explicit = normalize(env?.[ADMIN_PASSWORD_ENV]);
    if (explicit !== "") {
        return { password: explicit, source: "env", length: explicit.length, file: null, persisted: "none" };
    }

    // ② 持久文件 = 单源真相（B′）：存在即生效，**不被 .env 链覆盖**。
    const stored = readDevAdminPasswordFile(target);
    if (stored !== null) {
        return { password: stored, source: "file", length: stored.length, file: target, persisted: "reused" };
    }

    // ③ `.env` 链：**仅首次种子**（② 不存在时才轮到它；命中后也不写进 ②）。
    const configured = chainValue(ADMIN_PASSWORD_ENV, cwd);
    if (configured !== "") {
        return {
            password: configured,
            source: "env-file",
            length: configured.length,
            file: null,
            persisted: "none",
        };
    }

    // PLAN-0770：`persist: false` 是**只读观察**（status/诊断用）——绝不因为"看一眼来源"
    // 就凭空生成并落盘一份凭据。命不中任何一层时报 `source: "missing"`，由调用方显示
    // "尚未材料化"，而不是让读操作产生副作用。
    if (!persist) {
        return { password: null, source: "missing", length: 0, file: target, persisted: "none" };
    }

    // ④ 生成并落盘（此后 ② 生效）。
    const password = generate();
    writeDevAdminPasswordFile(target, password);
    return { password, source: "generated", length: password.length, file: target, persisted: "created" };
}

/**
 * 读 `.env` 链里的某个键（`.env` → `.env.$XIHE_ENV` → `.env.local`，fill-gaps，与 CP
 * `DotenvLoader` / `xihe` CLI 同一口径）。**只喂空袋**给链加载器：拿到的是「文件里写了什么」，
 * 不会被 `process.env` 混进来 —— OS env 的优先级由调用方显式表达。
 *
 * 链读失败（权限/编码）⇒ 视为未配置、不向上抛：调用方都在起栈路径上，读不到配置不该打断 `start`。
 */
function chainValue(name, cwd) {
    return chainOrigin(name, cwd).value;
}

/**
 * `.env` 链里某个键的**值与来源文件**（PLAN-0770）。来源取自 `env-file.mjs` 自己的
 * `origins` 映射 —— 不在本模块重排链顺序（第二份链条 = 同一事实多处写）。
 */
function chainOrigin(name, cwd) {
    try {
        const fromFiles = {};
        const { origins } = loadEnvFileChain({ env: fromFiles, cwd });
        return { value: normalize(fromFiles[name]), file: origins?.get(name) ?? null };
    } catch {
        return { value: "", file: null };
    }
}

/**
 * **只读**来源描述（PLAN-0770 INV-3）：给 `status` / `--json` 用，回答「当前 checkout 的
 * dev 管理员凭据现在会取自哪一层」，而**不**产生任何副作用（不生成、不落盘）。
 *
 * 契约（D4 值零外泄）：返回的每个字段都必须能回答「它能不能反推密码」——
 * 这里只有身份（user）、层级名、相对路径、是否存在的布尔。
 *
 * @param {object} options
 * @param {string} options.checkoutRoot
 * @param {Record<string,string|undefined>} [options.env]
 * @param {(p:string)=>string} [options.relative] 由调用方注入相对化（避免本模块依赖 cwd）
 * @returns {{user:string, source:"env"|"env-file"|"file"|"missing",
 *   envFile:string|null, persistedPath:string|null, hasFile:boolean, wouldGenerate:boolean}}
 */
export function describeDevAdminSource({ checkoutRoot, env = process.env, relative = (p) => p } = {}) {
    const target = devAdminPasswordFile(checkoutRoot);
    const hasFile = readDevAdminPasswordFile(target) !== null;
    const resolved = resolveDevAdminPassword({ projectRoot: checkoutRoot, env, persist: false });
    const envOrigin = resolved.source === "env-file" ? chainOrigin(ADMIN_PASSWORD_ENV, checkoutRoot).file : null;
    return {
        user: devAdminEmail(env),
        source: resolved.source,
        envFile: envOrigin === null ? null : relative(envOrigin),
        persistedPath: hasFile ? relative(target) : null,
        hasFile,
        wouldGenerate: resolved.source === "missing",
    };
}

/** dev 管理员 email：`XIHE_DEV_ADMIN_EMAIL` 可覆盖，否则与 `DataSeeder`/`reset-admin` 同一缺省值。 */
export function devAdminEmail(env = process.env) {
    const value = normalize(env?.XIHE_DEV_ADMIN_EMAIL);
    return value !== "" ? value : "admin@xihe.local";
}

/**
 * 密码值**只接受非空 string**（BL-527 护栏 A）。
 *
 * 事故（2026-11-09 W-23 后）：`dev-stack.mjs` 把 `resolveDevAdminPasswordSafe()` 的**结果对象**
 * 当成密码传下来，Node 把它写进子进程 env 时强转成 `"[object Object]"`（15 字符）——
 * 长度 ≥12 不触发 `ResetAdmin` 的短密码告警，于是这个串被 bcrypt 写库，**任何真实密码都 401**，
 * 而起栈日志照样打印 `ok … length=36`（打的是解析元数据的 length 字段）。宁可抛错，不可静默强转。
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string} 原值（不做 trim，保留调用方语义）
 */
export function assertPasswordString(value, label = "password") {
    if (typeof value !== "string") {
        const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        throw new TypeError(
            `${label} 必须是 string，收到 ${got}` +
                (got === "object"
                    ? "（常见错因：把 resolveDevAdminPasswordSafe() 的结果对象当密码传出，应取 .password）"
                    : ""),
        );
    }
    if (value.trim() === "") {
        throw new TypeError(`${label} 不能为空串/纯空白（空输入会让 ResetAdmin 走随机生成分支，库与调用方都不知道密码）`);
    }
    if (/\[object .*\]/i.test(value)) {
        throw new TypeError(`${label} 含 "[object …]"：调用方把对象当值传进来了`);
    }
    return value;
}

/**
 * 从 `resolveDevAdminPasswordSafe()` 的结果取出**密码字符串**（拿不到就是 `null`）。
 * 这是 dev-stack 起栈路径上唯一允许的取值方式：宁可 `null`（跳过 upsert）也不传对象。
 *
 * @param {{ok: boolean, password?: unknown} | null | undefined} result
 * @returns {string | null}
 */
export function devAdminPasswordFrom(result) {
    if (result == null || result.ok !== true) return null;
    return assertPasswordString(result.password, "resolveDevAdminPasswordSafe().password");
}

/**
 * `resolveDevAdminPassword` 的**不抛**版本：解析/落盘失败降级为 `{ ok: false, reason }`，
 * 由调用方 WARN + 跳过注入后继续起栈（与 upsert 失败同口径 —— 文档承诺的是「起栈不被
 * 密码链路打断」，之前只有 upsert 那一段做到了）。
 *
 * `reason` 只含错误码/消息（路径与 errno 级别的信息，非密码内容）。
 *
 * @returns {{ok: true, password: string, source: string, length: number,
 *   file: string|null, persisted: string} | {ok: false, reason: string}}
 */
export function resolveDevAdminPasswordSafe(options = {}) {
    try {
        return { ok: true, ...resolveDevAdminPassword(options) };
    } catch (error) {
        const code = error?.code ?? "ERROR";
        const message = error?.message ?? String(error);
        return { ok: false, reason: `${code}: ${message}` };
    }
}

/** 既有 reset-admin 入口（相对 checkout 根）；upsert 复用它的 ps1 + ResetAdmin.java，不新写 SQL。 */
export const RESET_ADMIN_WRAPPER = ["scripts", "reset-admin.ps1"];

/** `<projectRoot>/scripts/reset-admin.ps1`。 */
export function resetAdminWrapperPath(projectRoot) {
    return resolve(projectRoot, ...RESET_ADMIN_WRAPPER);
}

/** PowerShell 单引号字面量（`'` → `''`），避免路径/栈名里的引号被当代码执行。 */
function psLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** `ResetAdmin.java` 的**非 argv** 输入通道（BL-523 / D-766 后续）：优先级高于已废弃的 `--password`。 */
export const RESET_ADMIN_PASSWORD_ENV = "XIHE_RESET_ADMIN_PASSWORD";

/**
 * 生成调用既有 `reset-admin.ps1` 的 PowerShell 参数（`pwsh` / `powershell.exe` 通用）。
 *
 * 关键点：命令行里**不再出现任何密码**（连 `$env:` 引用都去掉更干脆）。密码只经子进程 env
 * `XIHE_RESET_ADMIN_PASSWORD` 传给 `ResetAdmin.java`（`stdin > env > --password`，见 BL-523）；
 * 命令行会进进程表与 shell 历史，这条链路必须彻底不碰它。
 *
 * @param {{wrapperPath: string, stackId: string}} options
 * @returns {{args: string[]}} 交给 `spawnSync('pwsh'|'powershell.exe', args, { env })`
 */
export function buildResetAdminCommand({ wrapperPath, stackId }) {
    const command = `& ${psLiteral(wrapperPath)} -StackId ${psLiteral(stackId)}`;
    return { args: ["-NoProfile", "-Command", command] };
}

/**
 * 给 `reset-admin.ps1` 子进程准备 env：在既有 env 上叠加非 argv 密码通道。
 * **这是密码在本链路里唯一的传递方式**（不写盘、不进 argv、不进日志）。
 *
 * BL-527 护栏 A：出口强制校验——非 string / 空串 / 含 `[object …]` 一律抛 TypeError。
 * Node 对非 string 的 env 值会 `String()` 强转（对象 ⇒ `"[object Object]"`），这个强转
 * 曾把库里的密码写成 15 字符的对象字符串，因此绝不能静默通过。
 */
export function resetAdminEnv({ env = process.env, password }) {
    const checked = assertPasswordString(password, "resetAdminEnv.password");
    return { ...env, [RESET_ADMIN_PASSWORD_ENV]: checked };
}

/**
 * 非密元数据行（**绝不**含密码值）：来源 / 落盘路径。
 * 任何新增字段都必须先回答「它能不能反推密码」。
 *
 * PLAN-0770 D4：**连长度都不报**（长度也是派生量，可按长度缩小搜索空间）。
 * 老版本打过 `length=36`，已按用户裁定的凭据卫生口径删除。
 */
export function formatDevAdminPassword(result) {
    const parts = [`source=${result.source}`, "value=not-logged"];
    if (result.file) parts.push(`file=${result.file}`, `persisted=${result.persisted}`);
    return `[dev-stack] dev admin password: ${parts.join(" ")}`;
}

/* ------------------------------------------------------------------ CLI */

// PLAN-0770 M4：`reset-admin.ps1` 成功后要把同一把钥匙写回持久文件（单源不漂），
// 但它不该自己再实现一遍「24B base64url 生成 + 优先级链」——那正是第二份链条。
// 因此这里开两个**值只走 stdout/stdin** 的子命令（与 `env-file.mjs --print` 同一先例）：
//   --ensure      按优先级解析；命中 env/env-file 时把它**材料化**到持久文件；都没有则生成并落盘。
//                 打印值到 stdout（调用方捕获，不落日志、不进 argv）。
//   --write-stdin 从 stdin 读一个已知值并落盘，打印**相对/绝对路径**（不打印值）。
//   --describe    输出 JSON 非密元数据（身份/来源/路径/布尔），给诊断用。
function readStdinValue() {
    try {
        const text = readFileSync(0, "utf8");
        return normalize(text);
    } catch {
        return "";
    }
}

function main(argv = process.argv.slice(2)) {
    const checkoutRoot = process.env.XIHE_CHECKOUT_ROOT || process.cwd();
    const arg = argv[0] ?? "";
    if (arg === "--ensure") {
        const resolved = resolveDevAdminPassword({ projectRoot: checkoutRoot, env: process.env });
        if (!resolved.password) {
            process.stderr.write("[dev-admin] 无法解析 dev 管理员密码（生成失败）\n");
            process.exit(1);
        }
        // **不在 --ensure 里 materialize**（PLAN-0770 INV-1 选项 A 仍待用户裁定）：
        // 命中 env/env-file 时只回报值，不把 env 值写进持久文件 —— 那会改变"哪份是真相"，
        // 属于 B 类语义变更。真正的写回只发生在 `reset-admin` 成功后（M4，显式动作）。
        process.stderr.write(`[dev-admin] resolved source=${resolved.source} (not materialized)\n`);
        process.stdout.write(`${resolved.password}\n`);
        process.exit(0);
    }
    if (arg === "--write-stdin") {
        const value = readStdinValue();
        if (value === "") {
            process.stderr.write("[dev-admin] stdin 为空，不写文件\n");
            process.exit(1);
        }
        assertPasswordString(value, "dev-admin --write-stdin");
        const file = writeDevAdminPasswordFile(devAdminPasswordFile(checkoutRoot), value);
        process.stdout.write(`${file}\n`);
        process.exit(0);
    }
    if (arg === "--describe") {
        const described = describeDevAdminSource({ checkoutRoot, env: process.env });
        process.stdout.write(`${JSON.stringify(described, null, 2)}\n`);
        process.exit(0);
    }
    process.stderr.write("usage: node dev-admin-password.mjs --ensure | --write-stdin | --describe\n");
    process.exit(2);
}

function isMainModule() {
    try {
        const self = resolve(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"));
        const invoked = resolve(process.argv[1] ?? "");
        return self.toLowerCase() === invoked.toLowerCase();
    } catch {
        return false;
    }
}

if (isMainModule()) {
    main();
}
