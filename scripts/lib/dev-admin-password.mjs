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
 * 优先级（D-766 乙案）：
 *   1. 显式 env `XIHE_DEV_ADMIN_PASSWORD`（调用方/CI 指定，最高）
 *   2. 本机已配置值：`.env → .env.$XIHE_ENV → .env.local` 链（复用 `env-file.mjs`，
 *      与 CP 侧 DotenvLoader / `xihe` CLI 同一口径；fill-gaps，OS env 不覆盖）
 *   3. `.local/dev/admin-password`（gitignored，0700/0600 owner-only）里已持久的值
 *   4. 生成一次（24 字节 base64url = 32 字符）并持久到同一路径，此后稳定复用
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
 * 按 D-766 优先级解析本次 dev 管理员密码。
 *
 * @param {object} options
 * @param {string} options.projectRoot checkout 根（持久文件与 .env 链都相对它）
 * @param {Record<string, string|undefined>} [options.env] 环境袋，默认 process.env
 * @param {string} [options.cwd] `.env` 链的查找起点，默认 projectRoot
 * @param {string} [options.file] 覆盖持久文件路径（测试用）
 * @param {() => string} [options.generate] 覆盖生成器（测试用）
 * @returns {{password: string, source: "env"|"env-file"|"file"|"generated", length: number,
 *   file: string|null, persisted: "none"|"reused"|"created"}}
 */
export function resolveDevAdminPassword({
    projectRoot,
    env = process.env,
    cwd = projectRoot,
    file,
    generate = generateDevAdminPassword,
} = {}) {
    const target = file ?? devAdminPasswordFile(projectRoot);

    const explicit = normalize(env?.[ADMIN_PASSWORD_ENV]);
    if (explicit !== "") {
        return { password: explicit, source: "env", length: explicit.length, file: null, persisted: "none" };
    }

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

    const stored = readDevAdminPasswordFile(target);
    if (stored !== null) {
        return { password: stored, source: "file", length: stored.length, file: target, persisted: "reused" };
    }

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
    try {
        const fromFiles = {};
        loadEnvFileChain({ env: fromFiles, cwd });
        return normalize(fromFiles[name]);
    } catch {
        return "";
    }
}

/** CP 的 local-mode 开关键（PLAN-0526；与 `LocalModeService` 同口径：`"true"` 大小写不敏感）。 */
export const LOCAL_MODE_ENV = "XIHE_LOCAL_MODE";

/**
 * 解析 CP 的 local-mode 开关：**OS env 优先，其次 `.env` 链**。
 *
 * 为什么不能只看 `process.env`（W-22 verify 非阻塞发现）：CP 侧的 `DotenvLoader` 会把
 * `.env*` 的值装进 system properties，所以**只在 `.env.local` 写 `XIHE_LOCAL_MODE=true`
 * 时 CP 自己是真的进入 local mode**；而 `dev-stack` 只读 OS env 就会漏判，接着去 upsert
 * admin 行 —— 正好破坏 local mode「零用户首启」的前提。这里与密码来源统一走同一条链。
 */
export function resolveLocalMode({ env = process.env, cwd = process.cwd() } = {}) {
    const direct = normalize(env?.[LOCAL_MODE_ENV]);
    const value = direct !== "" ? direct : chainValue(LOCAL_MODE_ENV, cwd);
    const source = direct !== "" ? "env" : value !== "" ? "env-file" : "unset";
    return { enabled: value.toLowerCase() === "true", source };
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

/**
 * 生成调用既有 `reset-admin.ps1` 的 PowerShell 参数（`pwsh` / `powershell.exe` 通用）。
 *
 * 关键点：密码**从子进程 env 读**（`$env:XIHE_DEV_ADMIN_PASSWORD`），不进命令行 ——
 * 命令行会进进程列表与 shell 历史。`ResetAdmin.java` 自己仍以 `--password` 接收（该入口
 * 现有形态，改它属产品面/另立卡），那一步是本链路唯一仍走 argv 的环节。
 *
 * @param {{wrapperPath: string, stackId: string, envName?: string}} options
 * @returns {{args: string[]}} 交给 `spawnSync('pwsh'|'powershell.exe', args)`
 */
export function buildResetAdminCommand({ wrapperPath, stackId, envName = ADMIN_PASSWORD_ENV }) {
    const command = `& ${psLiteral(wrapperPath)} -Password $env:${envName} -StackId ${psLiteral(stackId)}`;
    return { args: ["-NoProfile", "-Command", command] };
}

/**
 * 非密元数据行（**绝不**含密码值）：来源 / 字符数 / 落盘路径。
 * 任何新增字段都必须先回答「它能不能反推密码」。
 */
export function formatDevAdminPassword(result) {
    const parts = [`source=${result.source}`, `length=${result.length}`, "value=not-logged"];
    if (result.file) parts.push(`file=${result.file}`, `persisted=${result.persisted}`);
    return `[dev-stack] dev admin password: ${parts.join(" ")}`;
}
