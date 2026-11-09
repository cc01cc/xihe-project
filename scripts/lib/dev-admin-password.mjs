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

    // 只喂空袋给链加载器：拿到的是「文件里配置了什么」，不会被 process.env 混进来。
    const fromFiles = {};
    loadEnvFileChain({ env: fromFiles, cwd });
    const configured = normalize(fromFiles[ADMIN_PASSWORD_ENV]);
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
 */
export function resetAdminEnv({ env = process.env, password }) {
    return { ...env, [RESET_ADMIN_PASSWORD_ENV]: password };
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
