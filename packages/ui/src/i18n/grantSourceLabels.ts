/**
 * task-91（Q-112 档 B）：`provenance.grantSources` 的来源值 → 文案键。
 *
 * <p><b>词表 SSOT 不是这个文件</b>：契约在 `docs/api/openapi.yaml` 的
 * `EffectiveCapView.provenance.grantSources.additionalProperties.enum`，CP 真身是
 * `.../cp/policy/GrantSources.java`。这里只做「wire 值 → i18n 键」的机械映射，**不含任何业务判断**。</p>
 *
 * <p>两处消费者（`WorkspaceAgentsPanel` 的 per-grant 标签、`AuthorizationOverviewView` 的来源分布）
 * 必须共享同一张表：抄两份的下场是一页写「角色授权」另一页把 `role` 原样吐出来。</p>
 *
 * <p><b>不在词表内的值由调用方原样显示</b>（不回落 `role`、不吞掉该条 grant）—— CP 加了新来源值而 UI
 * 没跟上的时候，显示原值比显示一个错的来源诚实。</p>
 */
export const GRANT_SOURCE_LABEL_KEYS: Readonly<Record<string, string>> = {
    role: "workspace.agentEffectiveCapSource.role",
    spawn: "workspace.agentEffectiveCapSource.spawn",
    template: "workspace.agentEffectiveCapSource.template",
    credential_binding: "workspace.agentEffectiveCapSource.credentialBinding",
    agent_default: "workspace.agentEffectiveCapSource.agentDefault",
    plugin_binding: "workspace.agentEffectiveCapSource.pluginBinding",
    // 契约合法值，但线上当前无落库行可命中（org-unit 合成行 id 恒 null）；出现就按契约显示。
    org_unit: "workspace.agentEffectiveCapSource.orgUnit",
    // CP 的防御值：`GrantSources.provenanceSource` 把 null / 词表外折成 unknown。
    unknown: "workspace.agentEffectiveCapSource.unknown",
};

/** 词表内的值 → i18n 键；**词表外返回 `null`**（调用方原样显示 wire 值）。 */
export function grantSourceLabelKey(raw: string): string | null {
    return GRANT_SOURCE_LABEL_KEYS[raw] ?? null;
}
