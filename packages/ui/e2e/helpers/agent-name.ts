/**
 * 2026-11-04 用户裁定（PLAN-0661）：agent 主体名 / username 只允许 英文字母、中文汉字、数字，
 * 不得以数字开头，不得含空格与符号。CP 侧权威判定 = `auth/NameFormat.PATTERN_SOURCE`，
 * 两侧正则逐字同源（UI 侧见 `src/lib/principalName.ts`）。
 *
 * 为什么需要这个 helper：PLAN-0661 的 census 显示既有 e2e 夹具里 66/67 个主体名违反该规则
 * （kebab-case、空格、数字开头），逐个改名之后仍会有人随手写回 `r1-agent-${nonce}`。
 * 夹具名一律经这里拼装：非法字符直接剥离，结果仍非法就**抛错**（fail fast，别让 CP 的
 * 400 INVALID_NAME_FORMAT 在深层流程里才冒出来）。
 */
export const AGENT_NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

const ILLEGAL = /[^A-Za-z0-9\u4e00-\u9fff]/g;

/** `agentName("ProvenanceWriter")` / `agentName("JourneyA", Date.now())`。 */
export function agentName(prefix: string, suffix?: string | number): string {
    const name = `${prefix.replace(ILLEGAL, "")}${
        suffix === undefined ? "" : String(suffix).replace(ILLEGAL, "")
    }`;
    if (!AGENT_NAME_PATTERN.test(name) || name.length > 64) {
        throw new Error(
            `agentName() produced an invalid agent principal name: ${JSON.stringify(name)}`,
        );
    }
    return name;
}
