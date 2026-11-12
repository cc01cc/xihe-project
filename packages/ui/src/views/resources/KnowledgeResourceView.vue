<script setup lang="ts">
import { useI18n } from "vue-i18n";

/**
 * PLAN-0772 M2：知识库（`/resources/knowledge`）—— **后端缺口 G3，不是页面没做**。
 *
 * <p>依据（`resource-layer-permission-audit.md` §F G3）：CP 侧没有知识库实体（无表、无 CRUD），
 * 只有 4 个按 `workspace_id` 分区的代理端点（`RagProxyController.java:47,74-97`）⇒ 资源区里
 * 「库」这个被管理对象不存在，所以左栏按缺口留位（D7：留位不隐藏），本页只解释缺口。</p>
 *
 * <p>为什么入口在左栏仍是**不可点的一行**：`resourceGroups()` 对 `gaps` 非空的条目不给 `path`
 * （与 `SettingsResourceNav` 的缺口形态同源）；本路由存在是为了两件事：①深链不 404（老书签/文档链接）
 * ②给缺口一个可读的落点。</p>
 *
 * <p><b>task-209（D-1019）</b>：本页**不再给"打开当前工作区的知识库"出口** —— 那条链接原来指向
 * `/workspace/:id/settings?tab=knowledge`，而该 tab 已随「工作区设置页只保留常规/成员」一起撤下
 * （`WorkspaceSettingsView.vue`）。**撤掉的是入口，不是能力**：`KnowledgeBaseView` 组件与
 * `/rag/ingest`、`/rag/documents/{id}` 端点都还在，但当前**没有任何可达页面**挂载它 ——
 * 这条缺口已写进回执，等 G3 实体落地时把写面接回本页（而不是再造一个设置 tab）。</p>
 */
const { t } = useI18n();
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
        <p
            class="mt-2 text-sm leading-relaxed text-muted-foreground"
            data-testid="resources-knowledge-write-gone"
        >
            {{ t("resources.knowledgeGap.writeEntryGone") }}
        </p>
    </section>
</template>
