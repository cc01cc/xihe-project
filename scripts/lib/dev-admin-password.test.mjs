import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
    ADMIN_PASSWORD_BYTES,
    ADMIN_PASSWORD_ENV,
    RESET_ADMIN_WRAPPER,
    buildResetAdminCommand,
    devAdminPasswordFile,
    formatDevAdminPassword,
    generateDevAdminPassword,
    readDevAdminPasswordFile,
    resetAdminWrapperPath,
    resolveDevAdminPassword,
    writeDevAdminPasswordFile,
} from "./dev-admin-password.mjs";

// D-766 乙案最小版：钉住「env 优先级 + 生成持久化 + 不打印密码值」三条验收口径。
// 全部在 os.tmpdir() 的临时 checkout 里跑，不读开发者机器上真实的 .env / .local。

const SECRET = "s3cret-from-env-chain-9f2a";
const FILE_SECRET = "s3cret-from-persisted-file-7b1c";

/** 造一个假 checkout：有 `.git` 目录（`.env` 链靠它找根），可选写 `.env`。 */
function fakeRoot(t, { envLines = "" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "dev-admin-pw-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    if (envLines !== "") writeFileSync(join(dir, ".env"), envLines, "utf8");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

describe("generateDevAdminPassword", () => {
    test("24 bytes → 32 个 base64url 字符，无填充、URL 安全", () => {
        const password = generateDevAdminPassword();
        assert.equal(password.length, 32);
        assert.match(password, /^[A-Za-z0-9_-]+$/);
        assert.ok(!password.includes("="), "base64url withoutPadding must not emit padding");
    });

    test("两次生成不相同（真随机，不是常量）", () => {
        assert.notEqual(generateDevAdminPassword(), generateDevAdminPassword());
    });

    test("长度随注入的字节数变化（可注入 randomBytes 便于测试）", () => {
        const fixed = generateDevAdminPassword({ bytes: 3, randomBytesImpl: () => Buffer.from([0, 1, 2]) });
        assert.equal(fixed, Buffer.from([0, 1, 2]).toString("base64url"));
        assert.equal(ADMIN_PASSWORD_BYTES, 24);
    });
});

describe("resolveDevAdminPassword 优先级（D-766 乙案）", () => {
    test("① 显式 env 最高：压过 .env 链与已持久文件", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        const file = writeDevAdminPasswordFile(devAdminPasswordFile(root), FILE_SECRET);
        const result = resolveDevAdminPassword({ projectRoot: root, env: { [ADMIN_PASSWORD_ENV]: "explicit-env-pw" } });
        assert.equal(result.source, "env");
        assert.equal(result.password, "explicit-env-pw");
        assert.equal(result.length, "explicit-env-pw".length);
        assert.equal(result.file, null, "env 来源不落盘");
        assert.equal(result.persisted, "none");
        // 只读：已有文件一个字节都不动
        assert.equal(readFileSync(file, "utf8").trim(), FILE_SECRET);
    });

    test("env 值两侧空白被裁掉（避免把 \\r 带进密码）", (t) => {
        const root = fakeRoot(t);
        const result = resolveDevAdminPassword({ projectRoot: root, env: { [ADMIN_PASSWORD_ENV]: `  ${SECRET}\r\n` } });
        assert.equal(result.source, "env");
        assert.equal(result.password, SECRET);
    });

    test("空 / 纯空白的 env 视为未配置，落到下一层", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        for (const blank of ["", "   ", undefined]) {
            const result = resolveDevAdminPassword({ projectRoot: root, env: { [ADMIN_PASSWORD_ENV]: blank } });
            assert.equal(result.source, "env-file", `blank=${JSON.stringify(blank)} must fall through`);
            assert.equal(result.password, SECRET);
        }
    });

    test("② 本机已配置值（.env 链）压过已持久文件", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        writeDevAdminPasswordFile(devAdminPasswordFile(root), FILE_SECRET);
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "env-file");
        assert.equal(result.password, SECRET);
        assert.equal(result.file, null);
        assert.equal(result.persisted, "none");
    });

    test("③ 已持久文件在第二次起栈时复用（密码跨重启稳定）", (t) => {
        const root = fakeRoot(t);
        const first = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(first.source, "generated");
        assert.equal(first.persisted, "created");

        const second = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(second.source, "file");
        assert.equal(second.persisted, "reused");
        assert.equal(second.file, first.file);
        assert.equal(second.password, first.password, "second start must reuse the persisted value");
    });

    test("④ 生成一次并持久到 gitignored 路径（`.local/dev/admin-password`）", (t) => {
        const root = fakeRoot(t);
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "generated");
        assert.equal(result.length, 32);
        assert.equal(result.file, devAdminPasswordFile(root));
        assert.equal(result.file, join(root, ".local", "dev", "admin-password"));
        assert.ok(existsSync(result.file), "the generated password must be persisted");
        assert.equal(readFileSync(result.file, "utf8").trim(), result.password);
        // 目录 0700 / 文件 0600（Windows 上 mode 位是建议值，真正的控制在 ACL，故只在 POSIX 断言）
        if (process.platform !== "win32") {
            assert.equal(statSync(result.file).mode & 0o777, 0o600);
            assert.equal(statSync(join(root, ".local", "dev")).mode & 0o777, 0o700);
        }
    });

    test("空文件 / 只有换行 ⇒ 视为未配置，重新生成并覆盖", (t) => {
        const root = fakeRoot(t);
        const file = devAdminPasswordFile(root);
        writeDevAdminPasswordFile(file, "");
        assert.equal(readDevAdminPasswordFile(file), null);
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "generated");
        assert.notEqual(result.password, "");
    });

    test("`.env` 里留空占位（.env.example 的写法）⇒ 不当作已配置", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=\n` });
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "generated");
        assert.equal(result.length, 32);
    });
});

describe("formatDevAdminPassword（只打非密元数据）", () => {
    test("包含来源/字符数，绝不包含密码值", (t) => {
        const root = fakeRoot(t);
        const result = resolveDevAdminPassword({ projectRoot: root, env: { [ADMIN_PASSWORD_ENV]: SECRET } });
        const line = formatDevAdminPassword(result);
        assert.match(line, /source=env\b/);
        assert.match(line, /length=26\b/);
        assert.ok(!line.includes(SECRET), `log line leaked the password: ${line}`);
        assert.ok(!line.includes(SECRET.slice(0, 8)), "not even a prefix may leak");
        assert.match(line, /value=not-logged/);
    });

    test("持久来源额外带路径与 persisted 状态（仍不含值）", (t) => {
        const root = fakeRoot(t);
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        const line = formatDevAdminPassword(result);
        assert.match(line, /source=generated/);
        assert.match(line, /persisted=created/);
        assert.ok(line.includes(result.file), "the path is non-secret and useful for the operator");
        assert.ok(!line.includes(result.password), `log line leaked the generated password: ${line}`);
    });
});

describe("buildResetAdminCommand（复用既有入口、密码不进命令行）", () => {
    test("密码走子进程 env（$env:XIHE_DEV_ADMIN_PASSWORD），命令行里没有值", () => {
        const wrapperPath = resetAdminWrapperPath("H:/repo");
        const { args } = buildResetAdminCommand({ wrapperPath, stackId: "stack-2" });
        assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
        const command = args[2];
        assert.ok(command.includes("$env:XIHE_DEV_ADMIN_PASSWORD"), "the password must come from the child env");
        assert.ok(command.includes("stack-2"));
        assert.ok(command.includes(wrapperPath.replaceAll("\\", "\\")));
        // 构造函数根本不收密码 ⇒ 任何命令行里都拼不出值
        assert.ok(!JSON.stringify(args).includes(SECRET));
        assert.ok(!command.includes("-Password '"), "no literal password value may be baked into the command");
    });

    test("路径与栈名里的单引号被转义成 ''（不会被当代码执行）", () => {
        const { args } = buildResetAdminCommand({ wrapperPath: "H:/o'brien/reset-admin.ps1", stackId: "stack-1" });
        assert.ok(args[2].includes("'H:/o''brien/reset-admin.ps1'"), args[2]);
    });

    test("默认入口路径 = <root>/scripts/reset-admin.ps1", () => {
        assert.equal(resetAdminWrapperPath("H:/repo"), join("H:/repo", "scripts", "reset-admin.ps1"));
        assert.deepEqual(RESET_ADMIN_WRAPPER, ["scripts", "reset-admin.ps1"]);
    });
});
