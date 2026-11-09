/**
 * env 值类型闸（BL-527 同类风险统一收口，task-56）。
 *
 * Node 的 `spawn`/`spawnSync` 对 `env` 里的**非 string 值会静默 `String()` 强转**：
 * `{ XIHE_X: { ok: true, password: "..." } }` 会变成 `"[object Object]"`。BL-527 就是这样
 * 把库里的管理员密码写成 15 字符的对象串（长度 ≥12 绕过短密码告警）⇒ 登录永久 401，而起栈
 * 日志还在打 `ok … length=36`。**跨进程边界上的错误，静态门与单测都看不见**，所以只能在这里拦。
 *
 * 原则：**宁可抛错，不可静默强转**。`undefined` / `null` 同样拒收（env 里根本不该有这两个值，
 * 传进来说明上游字段名拼错或拿错了对象）。
 */

/**
 * 断言 env 的每个值都是非空 string。
 * @param {Record<string, unknown>} env
 * @param {string} [label] 出错时定位用的调用点标签（如 `spawn:control-plane`）
 * @returns {Record<string, string>} 原对象（不复制）
 */
export function assertEnvValues(env, label = "env") {
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
        throw new TypeError(`${label}: env 必须是对象，收到 ${env === null ? "null" : Array.isArray(env) ? "array" : typeof env}`);
    }
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") continue;
        const shown = value === undefined ? "undefined" : value === null ? "null" : describeValue(value);
        throw new TypeError(
            `${label}: env[${JSON.stringify(key)}] 必须是 string，收到 ${value === null ? "null" : typeof value}` +
                `（${shown}）—— Node 会把它 String() 强转后传给子进程，正是 BL-527 的 [object Object] 通道`,
        );
    }
    return env;
}

/** 值的可读摘要：**只给类型/键名/长度，绝不打值**（对象里可能正好是密码或不透明凭证）。 */
function describeValue(value) {
    if (Array.isArray(value)) return `array(length=${value.length})`;
    const ctor = value?.constructor?.name && value.constructor.name !== "Object" ? `${value.constructor.name} ` : "";
    const keys = Object.keys(value);
    const shown = keys.slice(0, 6).join(", ") + (keys.length > 6 ? `, …+${keys.length - 6}` : "");
    return `${ctor}object{${shown}}（不打印值）`;
}

/**
 * `dev-stack` 子进程 env 的**单一出口**：基础 env + 栈标识，返回**冻结对象**禁止散点赋值。
 * 冻结是刻意的：BL-527 那种「后来某处冒出一个 `childEnv.X = <对象>`」的写法在这里直接 TypeError。
 *
 * @param {{stackId: string, env?: Record<string, string|undefined>, defaultEnv?: string, extra?: Record<string, unknown>}} input
 */
export function makeChildEnv({ stackId, env = process.env, defaultEnv = "dev", extra = {} }) {
    const merged = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
    const built = {
        ...merged,
        XIHE_STACK_ID: stackId,
        XIHE_ENV: merged.XIHE_ENV ?? defaultEnv,
        ...extra,
    };
    return Object.freeze(assertEnvValues(built, `makeChildEnv(stackId=${stackId})`));
}
