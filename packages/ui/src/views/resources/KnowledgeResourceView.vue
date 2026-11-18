<script setup lang="ts">
import { useI18n } from "vue-i18n";

/**
 * PLAN-0772 M2：知识库（`/resources/knowledge`）—— 后端缺口 G3，本页只解释缺口。
 *
 * <p><b>D-1879 裁定一（task-47）：受众口径改正。</b>本页文案只写**用户能感知的后果**。
 * 此前每条缺口自带一句「怎么核」（`basis`：类名 / grep 命令 / 契约文件名 / 源码 `文件:行号` /
 * 接口路径），那是**审查者的验证义务被写进了正文** —— 于是面向用户的页面长成工程工作日志。
 * 引入它的 `225020d73` 目的正确（干掉一句不可兑现的时间承诺），错的只是把「核验方式」当「正文」。
 * 可核验性现在归两个面，不在页面上复述：
 *   ① 测试面 —— `__tests__/KnowledgeResourceView.spec.ts` 的 7 形态正则**负**断言（判据见 DEV-011 §14）；
 *   ② 证据面 —— `internal/A03-xihe/evidence/2026-11-13-task-42-resource-detail/README.md`（四条读数原文）
 *      与 `internal/A03-xihe/evidence/2026-11-19-task47-copy-audience/`（本次定性与真机盘点）。</p>
 *
 * <p>五条缺口：① 还没有「库」这个对象 ② 看不到库里收了哪些文档 ③ 索引按「人 + 工作区」分开、
 * 不按库共享 ④ 上传入口当前没有挂载点 ⑤ 提问不会触发知识库检索。</p>
 *
 * <p><b>⑤ 的出处</b>（task-59 / 卡面硬约束「写不出出处的句子一律不写」）：真机 stack-2 真模型一轮，
 * CP 自己打的 event=tool_timeout_payload 记 tools=0、agent 日志本轮无任何检索事件、durable records 只有
 * USER+ASSISTANT 两条且 jobSummary 为空。读数与两处仪器坑见
 * internal/A03-xihe/evidence/2026-11-19-task59-kb-retrieval-face/README.md。
 * 卡面示例句里「当前检索只覆盖本会话与工作区文件」那半句**没写** —— 那一轮恰恰不支持它。</p>
 *
 * <p>出口：本页渲染在 `ResourcesLayout` 内，左侧资源目录里的凭据 / MCP 服务器 / 技能三个**可用**
 * 项就在旁边（`settings-nav-resource-*`），不需要页内再造一个跳转按钮。</p>
 *
 * <p><b>不承诺时间</b>（自 task-42 保留的纪律）：本页任何一句都不得出现「等某事件落地」「恢复要等」
 * 「计划在」这类排期措辞，机器判据见 spec 的正则负断言。能力回来了就改文案，而不是先写一句愿望。</p>
 */
/** 缺口条目 id（顺序即页面顺序；文案键 = `resources.knowledgeGap.gaps.<id>.<field>`）。 */
const GAPS = ["noLibrary", "noDocList", "partition", "noWriteEntry", "chatSide"] as const;

const { t } = useI18n();

function gapText(id: string, field: "title" | "body"): string {
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
            </li>
        </ol>
    </section>
</template>
