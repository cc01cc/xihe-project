<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "../ui/button";
import {
    workspaceSettingsResourcePath,
    type WorkspaceSettingsResourceId,
} from "../../lib/settingsIa";

/**
 * 「本工作区」这一层已迁到**工作区设置** —— 资源区的指路页（D-1432 / task-41）。
 *
 * <p>这是 D-1023 / task-209 的**反向**处理，语义沿用同一条：**不 404、不静默跳走** ——
 * 就地说明东西搬到哪了，并给一条能直接点过去的深链。为什么不在路由层做 redirect：
 * 静默跳走会让「我在资源区点开的链接怎么变成了设置页」变成一个无法解释的事实，
 * 而一句说明加一个按钮把因果关系留在页面上。</p>
 *
 * <p>三个使用点（同一个组件，不许各写一版）：全局资源区 <code>/resources/&lt;id&gt;?layer=WORKSPACE</code>、
 * 工作区资源页 <code>/workspace/:id/resources?resource=&lt;id&gt;</code>、以及这两个页面将来的深链。</p>
 */
const props = defineProps<{
    /** 已迁走的资源 id（SSOT = lib/settingsIa.ts 的 WORKSPACE_SETTINGS_RESOURCE_IDS）。 */
    resource: WorkspaceSettingsResourceId;
    /** 目标工作区；缺省时只说明不给按钮（不猜一个工作区出来）。 */
    workspaceId?: string;
}>();

const { t } = useI18n();

const targetWorkspaceId = computed(() => (props.workspaceId ?? "").trim());
const href = computed(() =>
    targetWorkspaceId.value
        ? workspaceSettingsResourcePath(targetWorkspaceId.value, props.resource)
        : "",
);
/** 资源名：写成显式映射而不是拼 key —— 拼出来的 key 无法被 i18n 静态扫描校验。 */
const nameKey = computed(() =>
    props.resource === "mcp" ? "settings.ia.resourceMcp" : "settings.ia.resourceSkills",
);
</script>

<template>
    <div
        data-testid="workspace-layer-moved"
        class="rounded-lg border bg-muted/40 px-4 py-3 text-sm"
    >
        <p class="font-medium">{{ t("resources.workspaceLayerMovedTitle") }}</p>
        <p class="mt-1 text-muted-foreground">
            {{
                t("resources.workspaceLayerMovedBody", {
                    name: t(nameKey),
                })
            }}
        </p>
        <Button v-if="href" as-child variant="outline" size="sm" class="mt-2">
            <RouterLink :to="href" data-testid="workspace-layer-moved-action">
                {{ t("resources.workspaceLayerMovedAction") }}
            </RouterLink>
        </Button>
        <p v-else class="mt-2 text-xs text-muted-foreground">
            {{ t("resources.workspaceLayerMovedNoWorkspace") }}
        </p>
    </div>
</template>
