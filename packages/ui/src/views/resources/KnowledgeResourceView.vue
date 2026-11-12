<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../components/ui/button";
import { readTabWorkspaceId } from "../../lib/workspaceContext";
import { workspacePath } from "../../lib/routes";

/**
 * PLAN-0772 M2：知识库（`/resources/knowledge`）—— **后端缺口 G3，不是页面没做**。
 *
 * <p>依据（`resource-layer-permission-audit.md` §F G3）：CP 侧没有知识库实体（无表、无 CRUD），
 * 只有 4 个按 `workspace_id` 分区的代理端点（`RagProxyController.java:47,74-97`）⇒ 资源区里
 * 「库」这个被管理对象不存在，所以左栏按缺口留位（D7：留位不隐藏），本页只解释缺口并给出口。</p>
 *
 * <p>为什么入口在左栏仍是**不可点的一行**：`resourceGroups()` 对 `gaps` 非空的条目不给 `path`
 * （与 `SettingsResourceNav` 的缺口形态同源）；本路由存在是为了两件事：①深链不 404（老书签/文档链接）
 * ②给缺口一个可读的落点。</p>
 */
const { t } = useI18n();
const workspaceId = computed(() => readTabWorkspaceId());
const knowledgePath = computed(() =>
    workspaceId.value ? workspacePath(workspaceId.value) + "/settings?tab=knowledge" : "/workspace",
);
</script>

<template>
    <section
        data-testid="resources-knowledge-gap"
        class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
    >
        <h2 class="text-base font-semibold">{{ t("resources.knowledgeGap.title") }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            {{ t("resources.knowledgeGap.body") }}
        </p>
        <Button as-child variant="outline" size="sm" class="mt-3">
            <router-link :to="knowledgePath">{{ t("resources.knowledgeGap.action") }}</router-link>
        </Button>
    </section>
</template>
