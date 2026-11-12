<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "../ui/button";

/**
 * PLAN-0772 M2：按工作区归属的资源层（凭据 / MCP / 技能的工作区层）在**没有工作区上下文**时
 * 的诚实态。
 *
 * <p>为什么不静默回落到别的层（≤ 这是一条判据，不是一个提示语）：`verify.md` V11 要求
 * 「各层数据必须来自各自契约，禁拿实例层数据冒充其它层」。工作区层的读面全部按 `workspace_id`
 * 过滤（`mcp_remote_servers.workspace_id NOT NULL`、`owner_type=WORKSPACE` 的凭据行、
 * `GET /skills?definitionScope=workspace&workspaceId=`）⇒ 没有 workspaceId 时**没有任何合法数据
 * 可显示**，只能给「先选工作区」的出口。</p>
 */
const { t } = useI18n();
</script>

<template>
    <section
        data-testid="resources-workspace-required"
        class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
    >
        <h2 class="text-base font-semibold">{{ t("resources.workspaceMissing.title") }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            {{ t("resources.workspaceMissing.body") }}
        </p>
        <Button as-child variant="outline" size="sm" class="mt-3">
            <router-link to="/workspace">{{ t("resources.workspaceMissing.action") }}</router-link>
        </Button>
    </section>
</template>
