<script setup lang="ts">
import { useI18n } from "vue-i18n";
import InstanceAgentsPanel from "../../components/settings/InstanceAgentsPanel.vue";

const { t } = useI18n();

/**
 * task-91（用户裁定「智能体是组织成员，不是资源」）：**平台智能体的新家**（实例层）。
 *
 * <p>本页只是宿主：面板仍是 `InstanceAgentsPanel`（资源区 `/resources/agents?layer=INSTANCE`
 * 原先挂的就是它）。不新写面板、不复制判据 —— 权限门也在面板里（读面任何已认证调用者，
 * 写面 `INSTANCE_PRINCIPAL_WRITE_GATE` = 能力位 `instance:admin` and 原子
 * `MANAGE_AGENT_PRINCIPALS`），与它挂在资源区时**逐条相同**。</p>
 *
 * <p>标题复用 `settings.ia.resourceAgents`（「平台智能体」）而不是新造 i18n 键：这是**迁移**
 * 不是新概念；资源区摘除后旧键去留另裁（见 `task-91` 卡面「哪些键保留、哪些将来删」）。</p>
 */
</script>

<template>
    <section class="min-h-full" data-testid="settings-instance-agents">
        <header class="border-b">
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1
                    data-testid="settings-instance-agents-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ t("settings.ia.resourceAgents") }}
                </h1>
            </div>
        </header>
        <div class="mx-auto w-full max-w-6xl px-6 py-4">
            <InstanceAgentsPanel />
        </div>
    </section>
</template>
