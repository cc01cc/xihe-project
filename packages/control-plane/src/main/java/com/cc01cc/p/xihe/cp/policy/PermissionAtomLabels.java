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
        put(labels, ToolFaceRegistry.ACTION_OWN_AGENT, "创建个人智能体", "Create personal agent");
        put(labels, ToolFaceRegistry.ACTION_MEMORY_WRITE, "写入智能体记忆", "Write agent memory");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                "管理智能体主体（实例）", "Manage agent principals (instance)");
        put(labels, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                "管理工作区成员", "Manage workspace members");
        put(labels, PermissionAtomCatalog.CAP_INSTANCE_SUPER, "实例超级管理员", "Instance super admin");
        put(labels, PermissionAtomCatalog.CAP_INSTANCE_ADMIN, "实例管理员", "Instance admin");
        put(labels, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN, "工作区管理员", "Workspace admin");
        return labels;
    }

    private static void put(Map<String, Map<String, String>> labels, String atom,
                            String zh, String en) {
        labels.put(atom, Map.of(DEFAULT_LOCALE, zh, EN_LOCALE, en));
    }
}
