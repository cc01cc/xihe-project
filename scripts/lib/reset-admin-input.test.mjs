// BL-523 / task-19：ResetAdmin 的输入优先级与「只改密码」契约。
//
// 两层验证：
//   ①  Java 侧（需要 JDK + spring-security-crypto jar）：用 `--dry-run` 真跑三种输入通道，
//       断言「stdin > env > --password」与「都缺失 ⇒ 生成」；缺 JDK/jar 时 skip（不假绿）。
//   ② 静态契约：INSERT 分支必须已删除（V89 删了 users.role），且 fail-explicit 的退出码与
//       指导文案在位 —— 这条不需要任何运行时依赖，任何环境都应通过。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test, { describe } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SOURCE = join(REPO_ROOT, "packages", "control-plane", "scripts", "ResetAdmin.java");
const PASSWORD_ENV = "XIHE_RESET_ADMIN_PASSWORD";
const SECRET = "pw-from-test-1234567890";

/** 在 `~/.m2` 里找 spring-security-crypto 的最高版本 jar；找不到返回 null（测试转 skip）。 */
function findCryptoJar() {
    const base = join(homedir(), ".m2", "repository", "org", "springframework", "security", "spring-security-crypto");
    if (!existsSync(base)) return null;
    const versions = readdirSync(base)
        .filter((name) => existsSync(join(base, name, `spring-security-crypto-${name}.jar`)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length === 0) return null;
    return join(base, versions.at(-1), `spring-security-crypto-${versions.at(-1)}.jar`);
}

const JAR = findCryptoJar();
const CAN_RUN_JAVA = JAR !== null && spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;
const SKIP_REASON = CAN_RUN_JAVA
    ? false
    : "需要 JDK + spring-security-crypto jar（~/.m2）；本机缺失时跳过 Java 侧用例";

/**
 * 跑一次 `--dry-run`：只解析来源、不连库、不回显密码值。
 * @param {{env?: Record<string, string|undefined>, input?: string, args?: string[]}} options
 */
function dryRun({ env = {}, input, args = [] } = {}) {
    const childEnv = { ...process.env, ...env };
    if (!(PASSWORD_ENV in env)) delete childEnv[PASSWORD_ENV];
    const result = spawnSync(
        "java",
        [
            "--class-path", JAR,
            SOURCE,
            "--dry-run",
            "--url", "jdbc:postgresql://localhost:1/bl523-none",
            ...args,
        ],
        { env: childEnv, input, encoding: "utf8", timeout: 60_000 },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

describe("ResetAdmin 输入优先级（stdin > env > --password，BL-523）", { skip: SKIP_REASON }, () => {
    test("只有 env ⇒ source=env，且输出不含密码值", () => {
        const r = dryRun({ env: { [PASSWORD_ENV]: SECRET } });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /password-source = env/);
        assert.ok(!r.stdout.includes(SECRET), "the value must never be printed");
    });

    test("stdin 与 env 同时存在 ⇒ 取 stdin（显式 --password-stdin）", () => {
        const r = dryRun({ env: { [PASSWORD_ENV]: "pw-from-env-1234567890" }, input: SECRET, args: ["--password-stdin"] });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /password-source = stdin/);
        assert.match(r.stderr, /取 stdin/);
        assert.ok(!r.stdout.includes(SECRET));
    });

    test("只有 argv ⇒ source=argv 且打 deprecated WARN", () => {
        const r = dryRun({ args: ["--password", SECRET] });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /password-source = argv/);
        assert.match(r.stderr, /已废弃/);
        assert.ok(!r.stdout.includes(SECRET), "the value must never be printed");
    });

    test("三路都缺 ⇒ 生成随机密码（不落盘、不打印）", () => {
        const r = dryRun({});
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /password-source = generated/);
    });
});

describe("ResetAdmin 只改密码（BL-523 静态契约，无运行时依赖）", () => {
    const source = readFileSync(SOURCE, "utf8");

    test("INSERT 分支已删除：不再写 users.role（V89 已删该列）", () => {
        assert.ok(!/INSERT\s+INTO\s+users/i.test(source), "the INSERT branch must be gone");
        assert.ok(!/\brole\s*,/i.test(source), "no users.role column may be written");
        assert.ok(!/ck_users_role/.test(source));
    });

    test("用户行缺失时 fail-explicit：exit 3 + 可执行的指导文案", () => {
        assert.match(source, /EXIT_USER_MISSING\s*=\s*3/);
        assert.match(source, /System\.exit\(EXIT_USER_MISSING\)/);
        assert.match(source, /mise run dev:reset/);
        assert.match(source, /DataSeeder/);
    });

    test("三条输入通道都在源码里各就各位，且没有明文 argv 回显", () => {
        assert.match(source, new RegExp(`XIHE_RESET_ADMIN_PASSWORD`));
        assert.match(source, /--password-stdin/);
        assert.match(source, /warnDeprecatedArgv\(\)/);
        // dry-run 只报来源与长度，绝不打印值
        assert.ok(!/password-source = " \+ password/.test(source));
    });
});

describe("reset-admin.ps1 包装层（BL-523：-Password 不再进 argv）", () => {
    const wrapper = readFileSync(join(REPO_ROOT, "scripts", "reset-admin.ps1"), "utf8");

    test("java 参数里没有 --password；-Password 转成 env 并 WARN", () => {
        assert.ok(!wrapper.includes('"--password"'), "no --password may reach java argv any more");
        assert.match(wrapper, /\$env:XIHE_RESET_ADMIN_PASSWORD = \$Password/);
        assert.match(wrapper, /已废弃/);
    });

    test("支持 -DryRun 透传（用于输入通道核对）", () => {
        assert.match(wrapper, /\[switch\]\$DryRun/);
        assert.match(wrapper, /\$javaArgs \+= "--dry-run"/);
    });
});
