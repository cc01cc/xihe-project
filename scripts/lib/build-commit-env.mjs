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
 * 解析本次 run 应注入的 commit。
 *
 * @param {{targetDir?: string, read?: typeof readBuildInfo}} [input]
 * @returns {{value: string, status: "ok"|"unknown", commit: string|null, sha: string|null,
 *   reason: string|null, builtAt: string, dirty: boolean|null, file: string|null}}
 */
export function resolveBuildCommit({ targetDir, read = readBuildInfo } = {}) {
    const unknown = (reason, file = null) => ({
        value: '',
        status: 'unknown',
        commit: null,
        sha: null,
        reason,
        builtAt: '',
        dirty: null,
        file,
    });

    if (typeof targetDir !== 'string' || targetDir.trim() === '') return unknown('no-target-dir');

    let file = null;
    let info = null;
    try {
        const result = read(targetDir);
        file = result?.file ?? null;
        info = result?.info ?? null;
    } catch {
        // readBuildInfo 自己吞 ENOENT，但调用方可能传别的 read 实现（单测替身）
        return unknown('unreadable', file);
    }

    if (!info) return unknown('missing-build-info', file);

    const commit = typeof info.commit === 'string' ? info.commit.trim() : '';
    if (!SHA_RE.test(commit)) return unknown('invalid-commit', file);

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
