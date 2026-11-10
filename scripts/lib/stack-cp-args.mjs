/**
 * G12（task-154）反证专用逃生门：把 `stack-run.mjs cp --no-rebuild` 透传给 cp 子进程。
 *
 * 为什么需要它（写进证据的那句）：`stack-run.mjs cp` 在 build-info 缺失时**会自动重建并重写戳**
 * （`scripts/stack-run.mjs:396-443`，60–120 s）。所以「把 build-info 改名 ⇒ 端点 null + status unknown」
 * 的**稳态根本不存在** —— 只能在重建完成前抢瞬态，那不是证据是竞态。要造出卡面 ④ 要的稳态，
 * 必须让 cp 子进程跳过重建（沿用旧 classes），即透传 stack-run 已有的 `--no-rebuild`。
 *
 * 纪律（Lead 批的三条）：
 *  1. **默认关闭**：不传 flag ⇒ 子进程参数与原先逐字节相同；
 *  2. **单一来源**：flag 与 env 同时给出 ⇒ 直接报错，不猜、不「两个都读」；
 *  3. **可复算**：`serviceArgs()` 是纯函数，单测断言「传/不传时参数分别是什么」。
 */

/** dev-stack 的 flag 名。 */
export const CP_NO_REBUILD_FLAG = '--cp-no-rebuild';

/** 等价 env（只允许一个来源生效，见文件头第 2 条）。 */
export const CP_NO_REBUILD_ENV = 'XIHE_STACK_CP_NO_REBUILD';

/** stack-run 侧已有的逃生门参数。 */
export const STACK_RUN_NO_REBUILD_ARG = '--no-rebuild';

const FALSEY = new Set(['', '0', 'false', 'no', 'off']);

/**
 * 判定本次 start 是否要求 cp 子进程跳过重建。
 *
 * @param {{flag?: boolean, env?: Record<string, string|undefined>}} input
 * @returns {{active: boolean, source: 'flag'|'env'|null}}
 */
export function resolveCpNoRebuild({ flag = false, env = {} } = {}) {
    const raw = env?.[CP_NO_REBUILD_ENV];
    const fromEnv = typeof raw === 'string' && !FALSEY.has(raw.trim().toLowerCase());
    if (flag && fromEnv) {
        throw new Error(
            `${CP_NO_REBUILD_FLAG} 与 ${CP_NO_REBUILD_ENV}=${JSON.stringify(raw)} 同时给出：` +
                '只允许一个来源生效（避免两处各说一半）',
        );
    }
    if (flag) return { active: true, source: 'flag' };
    if (fromEnv) return { active: true, source: 'env' };
    return { active: false, source: null };
}

/**
 * 子进程 argv。**不要求跳过重建时与原先完全一致**：`[stackRun, service]`。
 *
 * @param {{stackRun: string, service: string, noRebuild?: boolean}} input
 * @returns {string[]}
 */
export function serviceArgs({ stackRun, service, noRebuild = false }) {
    const args = [stackRun, service];
    if (noRebuild && service === 'cp') args.push(STACK_RUN_NO_REBUILD_ARG);
    return args;
}

/** 人类可读的一行（start 时打印，便于事后核对实际生效值）。 */
export function describeCpNoRebuild(state) {
    return state.active
        ? `cp 子进程跳过重建（来源 ${state.source}）—— 反证用，正常起栈不要带`
        : 'cp 子进程按默认策略（verdict 非 fresh 会重建）';
}
