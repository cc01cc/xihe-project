package com.cc01cc.p.xihe.cp.policy;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * PLAN-0651 D51-37: display labels for the permission-atom vocabulary.
 *
 * <p>Why this lives in the CP and not in the UI: the role editor deliberately keeps <b>no
 * vocabulary of its own</b> (it renders whatever {@code GET /api/v1/roles/catalog} returns), and the
 * same principle as D51-19 applies — a wire field is produced by the capability layer, never
 * inferred by the view layer. One label table here also means adding a language is a one-file
 * change.</p>
 *
 * <p>The locale is resolved <b>explicitly</b> from the request ({@code ?locale=en-US}); the payload
 * carries a single string, never a {@code {zh, en}} pair, so the UI cannot grow a second source of
 * truth. Unknown locales fall back to {@code zh-CN}; unknown atoms fall back to the atom name (a new
 * atom must never render as an empty string — {@code RoleAdminApiIntegrationTest} asserts that).</p>
 */
public final class PermissionAtomLabels {

    public static final String DEFAULT_LOCALE = "zh-CN";
    public static final String EN_LOCALE = "en-US";

    private static final Map<String, Map<String, String>> LABELS = build();

    private PermissionAtomLabels() {
    }

    /** Label for {@code atom}; never empty (unknown atom ⇒ its own name). */
    public static String label(String atom, String locale) {
        Map<String, String> byLocale = LABELS.get(atom);
        if (byLocale == null) {
            return atom;
        }
        String resolved = normalize(locale);
        return byLocale.getOrDefault(resolved, byLocale.getOrDefault(DEFAULT_LOCALE, atom));
    }

    /** Supported locale tag for an arbitrary request value ({@code en*} ⇒ en-US, else zh-CN). */
    public static String normalize(String locale) {
        if (locale == null || locale.isBlank()) {
            return DEFAULT_LOCALE;
        }
        return locale.trim().toLowerCase(Locale.ROOT).startsWith("en") ? EN_LOCALE : DEFAULT_LOCALE;
    }

    private static Map<String, Map<String, String>> build() {
        Map<String, Map<String, String>> labels = new LinkedHashMap<>();
        put(labels, ToolFaceRegistry.ACTION_READ, "读取", "Read");
        put(labels, ToolFaceRegistry.ACTION_WRITE, "写入", "Write");
        put(labels, ToolFaceRegistry.ACTION_DELETE, "删除", "Delete");
        put(labels, ToolFaceRegistry.ACTION_EXEC, "执行命令", "Execute");
        put(labels, ToolFaceRegistry.ACTION_NETWORK, "出网访问", "Network access");
        put(labels, ToolFaceRegistry.ACTION_CREDENTIAL_USE, "使用凭证", "Use credential");
        put(labels, ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL, "查看凭证明文", "Reveal credential");
        put(labels, ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, "管理凭证", "Manage credentials");
        put(labels, ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "创建实例账户", "Create instance account");
        put(labels, ToolFaceRegistry.ACTION_CREATE_TEMPLATE, "创建实例模板", "Create instance template");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                "管理智能体（工作区）", "Manage agents (workspace)");
        put(labels, ToolFaceRegistry.ACTION_SPAWN_AGENT, "委派子智能体", "Delegate child agent");
        put(labels, ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK,
                "创建定时任务", "Create scheduled task");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK,
                "管理定时任务", "Manage scheduled tasks");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_ROLES, "管理角色与绑定", "Manage roles & bindings");
        // BL-312 (option B, 2026-11-09): the CREATE_OWN_AGENT label is removed with its atom;
        // PermissionAtomLabelsTest walks the catalog, so no entry must remain here for it.
        put(labels, ToolFaceRegistry.ACTION_MEMORY_WRITE, "写入智能体记忆", "Write agent memory");
        put(labels, ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF,
                "写入自己的智能体记忆", "Write own agent memory");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                "管理智能体主体（实例）", "Manage agent principals (instance)");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                "管理工作区成员", "Manage workspace members");
        put(labels, PermissionAtomCatalog.CAP_INSTANCE_SUPER, "实例超级管理员", "Instance super admin");
        put(labels, PermissionAtomCatalog.CAP_INSTANCE_ADMIN, "实例管理员", "Instance admin");
        put(labels, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN, "工作区管理员", "Workspace admin");
        // PLAN-0651 M2 T2.1: the eight P1 atoms.
        put(labels, ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
                "读取实例内容", "Read instance content");
        put(labels, ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
                "写实例内容", "Write instance content");
        put(labels, ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
                "查看密文内容", "View secret content");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                "管理技能库", "Manage skill library");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                "管理模型连接", "Manage provider connections");
        put(labels, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                "使用工作区运行态", "Use workspace runtime");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                "管理工作区运行态", "Manage workspace runtime");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
                "管理工作区策略", "Manage workspace policy");
        // PLAN-0673 M2 (D-166, 2026-11-05): the subset-bypass atom — SUPER_ADMIN-only by default.
        put(labels, ToolFaceRegistry.ACTION_GRANT_ANY_ATOM,
                "授予任意原子（旁路）", "Grant any atom (bypass)");
        // PLAN-0691 T1.3 (M1): the plugin binding face. The external wording keeps the `plugin:*`
        // spelling the spec uses; the atom itself is UPPER_SNAKE (see ToolFaceRegistry).
        put(labels, ToolFaceRegistry.ACTION_PLUGIN_MANAGE,
                "管理插件（安装/启停）", "Manage plugins");
        put(labels, ToolFaceRegistry.ACTION_PLUGIN_BIND,
                "绑定插件到工作区", "Bind a plugin to a workspace");
        put(labels, ToolFaceRegistry.ACTION_PLUGIN_INVOKE,
                "调用已绑定插件", "Invoke a bound plugin");
        put(labels, ToolFaceRegistry.ACTION_PLUGIN_DATA,
                "读写插件数据面", "Read/write the plugin data plane");
        return labels;
    }

    private static void put(Map<String, Map<String, String>> labels, String atom,
                            String zh, String en) {
        labels.put(atom, Map.of(DEFAULT_LOCALE, zh, EN_LOCALE, en));
    }
}
