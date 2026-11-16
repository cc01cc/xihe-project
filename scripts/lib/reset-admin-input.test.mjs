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

    test("三路都缺 ⇒ 报 not-provided（不得谎报 generated；真实来源由 wrapper 决定）", () => {
        const r = dryRun({});
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /password-source = not-provided/);
        // PLAN-0770：dry-run 若报 generated，会被读成"这次要随机生成一个新密码"，
        // 而经 wrapper 调用时真实来源是单源链（B′）—— 实测已误导过一次。
        assert.ok(!/password-source = generated/.test(r.stdout), "dry-run 不得把'没传值'报成'将随机生成'");
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

    test("java 参数里没有 --password；wrapper 的 -Password 入口整条删除（D-1753 ③）", () => {
        assert.ok(!wrapper.includes('"--password"'), "no --password may reach java argv any more");
        // D-1753 ③（task-62）：不是「接受后悄悄转 env」，而是**参数绑定就拒绝** —— 只要
        // param 块还声明 -Password，明文就仍然会进 shell 历史，转 env 也救不回来。
        assert.ok(!/\[string\]\$Password/.test(wrapper), "param 块不得再声明 -Password");
        assert.ok(!/\$Password\b/.test(wrapper), "脚本体内不得再引用 $Password");
        // 单一注入点不变：解析出来的值仍然只在末尾一处进 env。
        assert.match(wrapper, /\$env:XIHE_RESET_ADMIN_PASSWORD = \$resolvedPassword/);
        assert.match(wrapper, /D-1753/);
        // 拒绝靠的是 CmdletBinding：简单脚本会把未知命名参数静默塞进 $args（实测 exit 0），
        // 删掉这一行 = 把「显式拒绝」换回「静默忽略」，所以它必须被钉住。
        assert.match(wrapper, /\[CmdletBinding\(\)\]/);
    });

    test("支持 -DryRun 透传（用于输入通道核对）", () => {
        assert.match(wrapper, /\[switch\]\$DryRun/);
        assert.match(wrapper, /\$javaArgs \+= "--dry-run"/);
    });

    // D-952 F1（2026-11-12，task-85）：java 侧早已改成 `password-source = not-provided`，
    // wrapper 的括号文案却还写「上面 java 的 generated 只表示未传值」——**指着一个并不存在的词**，
    // 照它去读输出会找不到（PLAN-0770 §4.6.4「读命令自报错源」那个坑的指代版）。
    // 静态文本断言是唯一能钉住"两处用同一个词"的方式：谁单边改词，这条就红。
    test("dry-run 文案与 java 侧同词：wrapper 不出现 generated，且指向 not-provided", () => {
        assert.ok(!/\bgenerated\b/u.test(wrapper), "wrapper 不得再提 java 侧已不存在的 generated（要指就指 not-provided）");
        assert.match(wrapper, /上面 java 的 not-provided 只表示未传值/u);
        const java = readFileSync(SOURCE, "utf8");
        assert.match(java, /"not-provided/u, "java 侧必须仍产出 not-provided —— wrapper 的文案指向它");
        assert.ok(!/password-source = generated/u.test(java), "java 侧不得再产出 password-source = generated");
    });
});

// D-1753 ③（task-62）：静态断言只能证明「源码里没有」，这条证明**真进程**会拒绝 ——
// 参数绑定失败必须发生在任何副作用之前（不导出 maven classpath、不调 java、不回显值）。
const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;

describe("reset-admin.ps1 真进程：-Password 已被拒绝", { skip: HAS_PWSH ? false : "需要 pwsh" }, () => {
    test("传 -Password ⇒ 非 0 退出，且脚本体一步都没跑", () => {
        const r = spawnSync(
            "pwsh",
            ["-NoProfile", "-File", join(REPO_ROOT, "scripts", "reset-admin.ps1"), "-Password", SECRET, "-DryRun"],
            { encoding: "utf8", timeout: 60_000 },
        );
        const out = (r.stdout ?? "") + (r.stderr ?? "");
        assert.notEqual(r.status, 0, "-Password 必须被参数绑定拒绝");
        assert.match(out, /Password/);
        assert.ok(!out.includes("导出 maven classpath"), "拒绝必须早于任何副作用");
        assert.ok(!out.includes("password-source"), "拒绝必须早于 java 调用");
        assert.ok(!out.includes(SECRET), "值不得被回显");
    });
});
