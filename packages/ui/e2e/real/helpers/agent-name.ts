/**
 * PLAN-0658 夹具共用：**agent 主体名**生成器。
 *
 * 决策 v23（名称格式规则）把 agent 主体名字符集钉成
 * `^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$` —— **kebab-case 也非法**
 * （连字符 / 下划线 / 点 / 数字开头一律 400）。此前 spec 里手写的
 * `r1-agent-<nonce>` / `r2-extra-<nonce>` 之类在规则落地后会直接 400，
 * 所以统一从这里生成，别再手写。
 *
 * 形态：`Agent<Label><nonce>`。首字符固定 `A` ⇒ 恒合法；`label` 只保留字母数字，
 * `nonce` 本身是 base36（小写字母+数字）⇒ 名字唯一且可读。
 *
 * lane-0661 之后若提供公共 `agentName(...)` helper，收敛到那一份，本文件即可删除。
 */
export function agentName(label: string, nonce: string): string {
    const safeLabel = label.replace(/[^A-Za-z0-9]/g, "");
    return `Agent${safeLabel}${nonce}`;
}
