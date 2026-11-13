<script setup lang="ts">
import { useI18n } from "vue-i18n";

/**
 * PLAN-0772 M2：知识库（`/resources/knowledge`）—— 后端缺口 G3，本页只解释缺口。
 *
 * <p><b>task-42：文案改由实测缺口逐条驱动</b>。改之前的正文是一段概括（「CP 侧没有知识库实体」）
 * 加一句「恢复要等 G3 落地后挂到本资源页」—— 后半句是**时间承诺**，而没有人能给出这个时间，
 * 于是它既不可核也不可兑现。现在每一缺口是一条独立条目，带自己的**核法**（`basis`），
 * 文案与 `internal/A03-xihe/evidence/2026-11-13-task-42-resource-detail/README.md` 的读数一致。</p>
 *
 * <p>四条缺口的读面出处（逐条见 i18n 的 `gaps.*.basis`）：
 * ① CP 无库实体（openapi 的 `/api/v1/rag/*` 只有 4 条 path，CP java 里 grep 0 命中）；
 * ② 无文档列表读面（`documents/{docId}` 只有 DELETE、`stats` 的 200 无 schema）；
 * ③ 分区键是（用户, 工作区）而非库（`RagProxyController` 从 TenantContext 取分区）；
 * ④ 写入口没有挂载点（`/settings/knowledge` 路由已删、`KnowledgeBaseView` 无处挂载）。</p>
 *
 * <p><b>不承诺时间</b>：本页任何一句都不得出现「等某事件落地」「恢复要等」「计划在」这类排期措辞，
 * 机器判据见 `__tests__/KnowledgeResourceView.spec.ts` 的正则负断言。能力回来了就改文案，
 * 而不是先写一句愿望。</p>
 */

/** 缺口条目 id（顺序即页面顺序；文案键 = `resources.knowledgeGap.gaps.<id>.<field>`）。 */
const GAPS = ["noLibrary", "noDocList", "partition", "noWriteEntry"] as const;

const { t } = useI18n();

function gapText(id: string, field: "title" | "body" | "basis"): string {
    return t(`resources.knowledgeGap.gaps.${id}.${field}`);
}
</script>

<template>
    <section
        data-testid="resources-knowledge-gap"
        class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
    >
        <h2 data-testid="resources-knowledge-gap-title" class="text-base font-semibold">
            {{ t("resources.knowledgeGap.title") }}
        </h2>
        <p
            data-testid="resources-knowledge-gap-intro"
            class="mt-1 text-sm leading-relaxed text-muted-foreground"
        >
            {{ t("resources.knowledgeGap.intro") }}
        </p>

        <ol class="mt-4 space-y-4">
            <li
                v-for="id in GAPS"
                :key="id"
                :data-testid="`resources-knowledge-gap-${id}`"
                class="space-y-1"
            >
                <h3 class="text-sm font-medium">{{ gapText(id, "title") }}</h3>
                <p
                    class="text-sm leading-relaxed"
                    :data-testid="
                        id === 'noWriteEntry' ? 'resources-knowledge-write-gone' : undefined
                    "
                >
                    {{ gapText(id, "body") }}
                </p>
                <p class="text-xs leading-relaxed text-muted-foreground">
                    {{ t("resources.knowledgeGap.basisLabel") }}：{{ gapText(id, "basis") }}
                </p>
            </li>
        </ol>
    </section>
</template>
