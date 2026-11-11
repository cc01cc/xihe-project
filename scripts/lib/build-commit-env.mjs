/**
 * G12（task-154）—— **运维面注入** `XIHE_BUILD_COMMIT`（env-first 契约不动，项目侧仍只读 env）。
 *
 * 背景（BL-535）：`GET /api/v1/version` 的 `commit` 只读 env `XIHE_BUILD_COMMIT`，三个服务都有
 * 读取点（cp `VersionController.java`、agent `version.py`、runtime `main.rs`），但全仓**零注入点**
 * ⇒ 恒 null。而 launcher 编译后已把 commit 写进 `classes/META-INF/build-info.properties`
 * （PLAN-0662），`dev-stack status` 与 `XIHE_E2E_EXPECT_CP_COMMIT` 读的就是这个戳。
 *
 * 本模块只做一件事：**把那个戳翻成 env 值**，供 dev-stack / launcher 的子进程 env 出口使用。
 * 刻意不碰任何项目代码 —— 用户裁定 (a) 运维面注入，**禁止 (a)(b) 各修一半**：若这里改、项目里
 * 也加回退读 build-info，就会出现「两个来源两个值」的新假信号。
 *
 * 缺失语义（卡面要求）：build-info 不存在/不可读/commit 非法 ⇒ **返回空串并标 `unknown`，仍然注入**。
 * 注入空串与「跳过不注入」在服务侧看到的都是 null，但运维面必须能显示「我知道它不该有值」，
 * 所以 status 里 `unknown` 与其 `reason` 必须显式出现，而不是静默略过。
 */
import { readBuildInfo, shortSha } from './cp-build-info.mjs';

/** 三个服务共同读取的 env 名（cp `VersionController`、agent `version.py`、runtime `main.rs`）。 */
export const BUILD_COMMIT_ENV = 'XIHE_BUILD_COMMIT';

/** 与三侧 reader 的取值校验口径一致：7–40 位十六进制（短 sha 也接受）。 */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * 「无值」的规范化形态：`value` 空串 + `status=unknown` + **必须带 `reason`**（运维要能区分
 * 「没有 build-info」与「有但不敢注入」）。`buildCommitEnv` 才会产出 `{ XIHE_BUILD_COMMIT: '' }`。
 */
export function unknownBuildCommit(reason, file = null) {
    return {
        value: '',
        status: 'unknown',
        commit: null,
        sha: null,
        reason,
        builtAt: '',
        dirty: null,
        file,
    };
}

/**
 * 解析本次 run 应注入的 commit。
 *
 * @param {{targetDir?: string, read?: typeof readBuildInfo}} [input]
 * @returns {{value: string, status: "ok"|"unknown", commit: string|null, sha: string|null,
 *   reason: string|null, builtAt: string, dirty: boolean|null, file: string|null}}
 */
export function resolveBuildCommit({ targetDir, read = readBuildInfo } = {}) {
    if (typeof targetDir !== 'string' || targetDir.trim() === '') return unknownBuildCommit('no-target-dir');

    let file = null;
    let info = null;
    try {
        const result = read(targetDir);
        file = result?.file ?? null;
        info = result?.info ?? null;
    } catch {
        // readBuildInfo 自己吞 ENOENT，但调用方可能传别的 read 实现（单测替身）
        return unknownBuildCommit('unreadable', file);
    }

    if (!info) return unknownBuildCommit('missing-build-info', file);

    const commit = typeof info.commit === 'string' ? info.commit.trim() : '';
    if (!SHA_RE.test(commit)) return unknownBuildCommit('invalid-commit', file);

    return {
        value: commit,
        status: 'ok',
        commit,
        sha: shortSha(commit),
        reason: null,
        builtAt: typeof info.builtAt === 'string' ? info.builtAt : '',
        dirty: info.dirty === true,
        file,
    };
}

/**
 * 「本次起栈应注入哪个 commit」—— task-61 的唯一实现。
 *
 * **为什么不能直接读 `cpBuildFor(...).targetDir` 的戳**：`targetDir` 在有 `.current` 指针时是
 * **上一次** start 用过的目录（`targetDirSource=pointer`），而 CP 的重建发生在**之后**
 * （`scripts/stack-run.mjs` 的 stale 门，重建集 = `stale|missing|dirty`，见其注释 BL-325）。
 * ⇒ 只要本次 start 触发重建，指针里的 sha 就**不是**将要运行的那个构建，
 * 而 `/api/v1/version` 又会把它当「当前进程的构建提交」展示给用户 —— 那是一条**错的 sha**
 * （2026-11-12 实测：端点报 `be2cd4e9…`，跑着的 classes 是 `850a011cb…`）。
 *
 * 取舍：**宁可没有值，不可报错值**。`verdict === 'fresh'` 时指针里的 sha 必等于将要运行的构建
 * （fresh ⇒ 不会重建），照常注入；其余一律注入空串，消费方按既有契约报 `null`（"未注入"），
 * 运维面用 `reason` 说明是哪种非 fresh。真正的「构建后注入」是 A 案（另案排期）。
 *
 * @param {{cpBuild?: {verdict?: string, targetDir?: string, file?: string|null},
 *   resolve?: typeof resolveBuildCommit}} [input]
 */
export function buildCommitForBoot({ cpBuild, resolve = resolveBuildCommit } = {}) {
    const verdict = typeof cpBuild?.verdict === 'string' && cpBuild.verdict !== ''
        ? cpBuild.verdict
        : 'unverified';
    if (verdict !== 'fresh') return unknownBuildCommit(`cp-build-${verdict}`, cpBuild?.file ?? null);
    return resolve({ targetDir: cpBuild?.targetDir });
}

/**
 * 子进程 env 片段。**永远返回一个键**（不是 `{}`）—— 缺失时是空串，符合卡面「注入空串」。
 *
 * @param {{value?: string}|null|undefined} state
 * @returns {Record<string, string>}
 */
export function buildCommitEnv(state) {
    return { [BUILD_COMMIT_ENV]: typeof state?.value === 'string' ? state.value : '' };
}

/**
 * status 展示/机读用的一行。`unknown` 与**原因**都要出现（只印 `<unknown>` 运维还得再查一遍）。
 *
 * @param {{value?: string, status?: string, reason?: string|null, sha?: string|null}|null|undefined} state
 */
export function describeBuildCommit(state) {
    const status = state?.status ?? 'unknown';
    const shown = status === 'ok' ? state?.sha ?? shortSha(String(state?.value ?? '')) : '(none)';
    const reason = state?.reason ? ` reason=${state.reason}` : '';
    return `commit=${shown} status=${status}${reason}`;
}
