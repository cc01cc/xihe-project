/**
 * agent 主体名生成器（PLAN-0658 建立，PLAN-0661 收敛为 e2e 唯一实现）。
 *
 * 决策 v23（名称格式规则）把 agent 主体名字符集钉成
 * `^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$` —— **kebab-case 也非法**
 * （连字符 / 下划线 / 点 / 数字开头一律 400）。此前 spec 里手写的
 * `r1-agent-<nonce>` / `r2-extra-<nonce>` 之类在规则落地后会直接 400，所以统一从这里生成。
 *
 * 形态：`Agent<Label><nonce>`。首字符固定 `A` ⇒ 恒合法；`label` / `nonce` 只保留字母数字，
 * 名字因此唯一且可读（排障时能按前缀定位，例：`AgentR5Primary…`）。
 *
 * 这是 **e2e 唯一实现**（real / headed / mock 共用；不要另建第二份，就是 PLAN-0661 那次
 * 「UI 与 CP 各写一份正则」的同型坑）。生成结果仍非法（如 label 全被剥空）就抛错，
 * 让错误落在夹具层而不是 CP 的 400 深处。
 */
export const AGENT_NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

const ILLEGAL = /[^A-Za-z0-9\u4e00-\u9fff]/g;

export function agentName(label: string, nonce: string | number = ""): string {
    const name = `Agent${label.replace(ILLEGAL, "")}${String(nonce).replace(ILLEGAL, "")}`;
    if (!AGENT_NAME_PATTERN.test(name) || name.length > 64) {
        throw new Error(
            `agentName() produced an invalid agent principal name: ${JSON.stringify(name)}`,
        );
    }
    return name;
}
