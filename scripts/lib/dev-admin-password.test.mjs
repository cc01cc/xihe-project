import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
    ADMIN_PASSWORD_BYTES,
    ADMIN_PASSWORD_ENV,
    RESET_ADMIN_WRAPPER,
    assertPasswordString,
    buildResetAdminCommand,
    devAdminPasswordFrom,
    RESET_ADMIN_PASSWORD_ENV,
    resetAdminEnv,
    devAdminPasswordFile,
    describeDevAdminSource,
    devAdminEmail,
    formatDevAdminPassword,
    generateDevAdminPassword,
    readDevAdminPasswordFile,
    resetAdminWrapperPath,
    resolveDevAdminPassword,
    resolveDevAdminPasswordSafe,
    writeDevAdminPasswordFile,
} from "./dev-admin-password.mjs";

// D-766 乙案最小版 + PLAN-0770 B′：钉住「四层优先级（OS env > 文件 > .env 链 > 生成）+ 不 materialize + 不打印密码值」。
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

describe("resolveDevAdminPassword 优先级（B′：OS env > 持久文件 > .env 链 > 生成）", () => {
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

    test("③ `.env` 链**只做首次种子**：持久文件存在时链值不生效（B′ 核心）", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        writeDevAdminPasswordFile(devAdminPasswordFile(root), FILE_SECRET);
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "file");
        assert.equal(result.password, FILE_SECRET, "文件即真相：.env 链不得覆盖已持久的值");
        // 也**不**把链值写进文件（无 materialize）
        assert.equal(readDevAdminPasswordFile(devAdminPasswordFile(root)), FILE_SECRET);
    });

    test("③ 无文件时 `.env` 链生效，但**不**材料化到文件（不 materialize）", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        const result = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(result.source, "env-file");
        assert.equal(result.password, SECRET);
        assert.equal(existsSync(devAdminPasswordFile(root)), false, "链命中不该顺手写一份凭据文件");
    });

    test("② 已持久文件在第二次起栈时复用（密码跨重启稳定）", (t) => {
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

    test("④ 都没有时生成一次并持久到 gitignored 路径（`.local/dev/admin-password`）", (t) => {
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
    test("包含来源，绝不包含密码值（PLAN-0770 D4：**连长度也不打**）", (t) => {
        const root = fakeRoot(t);
        const result = resolveDevAdminPassword({ projectRoot: root, env: { [ADMIN_PASSWORD_ENV]: SECRET } });
        const line = formatDevAdminPassword(result);
        assert.match(line, /source=env\b/);
        // D4：长度是派生量（可用于缩小暴力面）⇒ 元数据行里不许出现。
        assert.ok(!/length=/.test(line), `log line must not leak the length: ${line}`);
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

describe("buildResetAdminCommand（复用既有入口、密码完全不进命令行）", () => {
    test("BL-523: 命令行里既没有密码值、也没有任何密码参数（连 $env: 引用都不留）", () => {
        const wrapperPath = resetAdminWrapperPath("H:/repo");
        const { args } = buildResetAdminCommand({ wrapperPath, stackId: "stack-2" });
        assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
        const command = args[2];
        assert.ok(command.includes("stack-2"));
        assert.ok(command.includes(wrapperPath));
        assert.ok(!command.includes("-Password"), command);
        assert.ok(!command.includes("$env:"), "no env reference is needed any more — the value travels via spawn env");
        assert.ok(!JSON.stringify(args).includes(SECRET));
    });

    test("密码只经 spawn env（XIHE_RESET_ADMIN_PASSWORD）传递，且不污染其他 env 键", () => {
        const env = resetAdminEnv({ env: { PATH: "x", XIHE_STACK_ID: "stack-2" }, password: SECRET });
        assert.equal(env[RESET_ADMIN_PASSWORD_ENV], SECRET);
        assert.equal(env.XIHE_STACK_ID, "stack-2");
        assert.equal(env.PATH, "x");
        // 独立函数：不传 env 时以 process.env 为底仍是新对象，不会写坏 process.env
        const fresh = resetAdminEnv({ password: SECRET });
        assert.equal(fresh[RESET_ADMIN_PASSWORD_ENV], SECRET);
        assert.notEqual(fresh, process.env);
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

describe("resolveDevAdminPasswordSafe（解析/落盘失败降级，不炸起栈前段）", () => {
    test("生成抛错 ⇒ ok:false，reason 带错误码，且不带 password 字段", (t) => {
        const root = fakeRoot(t);
        const error = Object.assign(new Error("rng exploded"), { code: "E_RNG" });
        const result = resolveDevAdminPasswordSafe({
            projectRoot: root,
            env: {},
            generate: () => {
                throw error;
            },
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /E_RNG/);
        assert.match(result.reason, /rng exploded/);
        assert.equal("password" in result, false);
    });

    test("落盘位置不可写（路径中间是普通文件）⇒ ok:false 且不留半成品文件", (t) => {
        const root = fakeRoot(t);
        const blocker = join(root, "blocker");
        writeFileSync(blocker, "not a directory\n", "utf8");
        const target = join(blocker, "dev", "admin-password");
        const result = resolveDevAdminPasswordSafe({ projectRoot: root, env: {}, file: target });
        assert.equal(result.ok, false, `expected a graceful failure, got ${JSON.stringify(result)}`);
        assert.ok(result.reason.length > 0);
        assert.equal(existsSync(target), false, "no half-written password file may be left behind");
    });

    test("成功时 ok:true，字段与直接调用一致（调用方拿到可直接注入的 password）", (t) => {
        const root = fakeRoot(t);
        const safe = resolveDevAdminPasswordSafe({ projectRoot: root, env: {} });
        assert.equal(safe.ok, true);
        assert.equal(safe.source, "generated");
        assert.equal(safe.persisted, "created");
        assert.equal(safe.length, 32);
        // 第二次调用（同 root）走持久文件：值稳定、来源翻成 file/reused。
        const direct = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(safe.password, direct.password);
        assert.equal(direct.source, "file");
        assert.equal(direct.persisted, "reused");
    });
});

// BL-527 护栏：`resetAdminEnv()` / `devAdminPasswordFrom()` 出口只许 string。
// 事故（2026-11-09）：dev-stack 把 `resolveDevAdminPasswordSafe()` 的**结果对象**当密码传下来，
// Node 强转成 `"[object Object]"`（15 字符，绕开 ResetAdmin 的 <12 位告警）写进库 ⇒ 任何真实
// 密码都 401，而日志仍是 `ok … length=36`（打的是元数据的 length 字段）。这组测试钉住：
// 非 string 必须**抛错**，不允许静默强转。
describe("BL-527 护栏：密码值必须是 string（禁止对象被强转进子进程 env）", () => {
    test("正常路径：resetAdminEnv() 的值是 string，且与传入密码逐字节相同", () => {
        const env = resetAdminEnv({ env: { PATH: "/usr/bin" }, password: SECRET });
        assert.equal(typeof env[RESET_ADMIN_PASSWORD_ENV], "string");
        assert.equal(env[RESET_ADMIN_PASSWORD_ENV], SECRET);
        assert.equal(env.PATH, "/usr/bin", "既有 env 必须原样保留");
    });

    test("传「解析结果对象」/ undefined / null ⇒ 抛 TypeError，绝不静默强转", (t) => {
        const root = fakeRoot(t);
        const safe = resolveDevAdminPasswordSafe({ projectRoot: root, env: {} });
        assert.equal(safe.ok, true);
        // 事故原样：把整个结果对象传进来
        assert.throws(() => resetAdminEnv({ password: safe }), /必须是 string/);
        assert.throws(() => resetAdminEnv({ password: undefined }), /必须是 string/);
        assert.throws(() => resetAdminEnv({ password: null }), /必须是 string/);
        // 已经被别处 String() 过的对象串同样拒收
        assert.throws(() => resetAdminEnv({ password: String(safe) }), /\[object /);
        assert.throws(() => resetAdminEnv({ password: "   " }), /不能为空/);
        assert.throws(() => assertPasswordString(42), /必须是 string/);
    });

    test("ok=false ⇒ devAdminPasswordFrom() 返回 null（env 里不会出现该键）", (t) => {
        const root = fakeRoot(t);
        // 失败契约（真实失败原因见 resolveDevAdminPasswordSafe 的用例）：只要 ok!==true 就必须 null
        assert.equal(devAdminPasswordFrom({ ok: false, reason: "EACCES: permission denied" }), null);
        assert.equal(devAdminPasswordFrom(null), null);
        assert.equal(devAdminPasswordFrom(undefined), null);
        // 正向：成功结果取出的是字符串本身，不是对象
        const ok = resolveDevAdminPasswordSafe({ projectRoot: root, env: {} });
        assert.equal(typeof devAdminPasswordFrom(ok), "string");
        assert.equal(devAdminPasswordFrom(ok), ok.password);
    });
});

// PLAN-0770 M1/M3/M4：来源可观测的契约（只读 / 非密 / 单一链条）+ 不物化。
describe("describeDevAdminSource（PLAN-0770 INV-3：只读、非密、单一链条）", () => {
    test("文件命中 ⇒ source=file，且带出持久路径与 hasFile", (t) => {
        const root = fakeRoot(t);
        writeDevAdminPasswordFile(devAdminPasswordFile(root), FILE_SECRET);
        const info = describeDevAdminSource({ checkoutRoot: root, env: {} });
        assert.equal(info.source, "file");
        assert.equal(info.hasFile, true);
        assert.ok(info.persistedPath && info.persistedPath.endsWith("admin-password"));
        assert.equal(info.wouldGenerate, false);
    });

    test("OS env 命中 ⇒ source=env", (t) => {
        const root = fakeRoot(t);
        const info = describeDevAdminSource({ checkoutRoot: root, env: { [ADMIN_PASSWORD_ENV]: SECRET } });
        assert.equal(info.source, "env");
        assert.equal(info.hasFile, false);
    });

    test("`.env` 链命中 ⇒ source=env-file 且报出**是哪个文件**", (t) => {
        const root = fakeRoot(t, { envLines: `${ADMIN_PASSWORD_ENV}=${SECRET}\n` });
        const info = describeDevAdminSource({ checkoutRoot: root, env: {} });
        assert.equal(info.source, "env-file");
        // 来源文件必须由链加载器自己给出（第二份链条 = 同一事实多处写）。
        assert.ok(info.envFile && info.envFile.endsWith(".env"), `expected the .env file, got ${info.envFile}`);
    });

    test("都没有 ⇒ source=missing，且**不生成、不落盘**（读操作不许有副作用）", (t) => {
        const root = fakeRoot(t);
        const info = describeDevAdminSource({ checkoutRoot: root, env: {} });
        assert.equal(info.source, "missing");
        assert.equal(info.hasFile, false);
        assert.equal(info.wouldGenerate, true);
        assert.equal(existsSync(devAdminPasswordFile(root)), false, "describe 不许因为看一眼就造出一份凭据");
    });

    test("输出零外泄：序列化后不含值、不含长度、不含前缀", (t) => {
        const root = fakeRoot(t);
        writeDevAdminPasswordFile(devAdminPasswordFile(root), FILE_SECRET);
        const info = describeDevAdminSource({ checkoutRoot: root, env: {} });
        const text = JSON.stringify(info);
        assert.ok(!text.includes(FILE_SECRET), `描述里出现了值: ${text}`);
        assert.ok(!text.includes(FILE_SECRET.slice(0, 6)), "前缀也不行");
        assert.ok(!("password" in info) && !("length" in info), `字段面过宽: ${Object.keys(info).join(",")}`);
    });

    test("devAdminEmail：默认 admin@xihe.local，可被 XIHE_DEV_ADMIN_EMAIL 覆盖", () => {
        assert.equal(devAdminEmail({}), "admin@xihe.local");
        assert.equal(devAdminEmail({ XIHE_DEV_ADMIN_EMAIL: " ops@xihe.local " }), "ops@xihe.local");
    });
});

describe("resolveDevAdminPassword({persist:false})（只读解析）", () => {
    test("命不中时返回 source=missing 且不写文件；persist 默认仍为 true（起栈路径行为不变）", (t) => {
        const root = fakeRoot(t);
        const dry = resolveDevAdminPassword({ projectRoot: root, env: {}, persist: false });
        assert.equal(dry.source, "missing");
        assert.equal(dry.password, null);
        assert.equal(existsSync(devAdminPasswordFile(root)), false);

        const wet = resolveDevAdminPassword({ projectRoot: root, env: {} });
        assert.equal(wet.source, "generated");
        assert.equal(existsSync(devAdminPasswordFile(root)), true);
    });
});
