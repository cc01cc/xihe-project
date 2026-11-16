<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Info, X } from "@lucide/vue";
import { formatFileSize } from "../../../lib/fileSize";
import type { FileNode } from "../../../types";
import { OPEN_PREVIEW_BUDGET_BYTES, type OpenOutcome } from "../lib/openOutcome";

/**
 * task-78（Q-1116-21）：**文件元信息面板**。
 *
 * <h3>数据来源（Lead 2026-11-16 裁定 C1：读已有数据，零请求）</h3>
 * <p>`files/stat` 在 UI 侧**今天调不通** —— CP 的 `USER_WORKSPACE_FILE_TOOLS`
 * （`McpProxyController.java:105-107`）不含 `get_file_info`，用户 token 走 `/mcp` 必然 403
 * （实测：同信封下 `list_directory` 200 / `get_file_info` 403）。权威实时读取需另一张卡先解 CP 白名单。</p>
 * <p>⇒ 本面板读**文件树快照**（`ws.fileTree` 的 `FileNode`），**不产生任何请求**。
 * 这是有意的取舍，不是省事：卡面判据②「子项列表零请求」用同一条原则。</p>
 *
 * <h3>三条诚实的边界（Lead 明确要求，都不许静默）</h3>
 * <ul>
 *   <li><b>新鲜度必须标</b>：树是快照，不标就等于把「不是我读的」显示成「就是这个值」
 *       —— 与 P1-1 假断线同病。</li>
 *   <li><b>`is_symlink` / `created` 缺值必须标「未知」</b>：树投影里没有这两个字段，
 *       <b>不许编</b>（编一个 `false` 比不显示更坏 —— 用户会当事实）。补投影要改 store 映射、
 *       影响所有 `FileNode` 消费方 ⇒ 膨胀门：先做最小的那个。</li>
 *   <li><b>目录的 `size` 无意义</b>：本面板对目录不显示大小（那会让人以为是子项总大小）。</li>
 * </ul>
 */
const props = defineProps<{
    node: FileNode | null;
    outcome: OpenOutcome | null;
    /** 树快照的取数时刻（毫秒时间戳）；null = 未知（懒加载子树/测试夹具）。 */
    snapshotAt: number | null;
}>();

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

/** 「X 秒前」：快照年龄。取整到秒，负数（时钟回拨）按 0 处理。 */
const snapshotAgeSeconds = computed(() => {
    if (props.snapshotAt === null) return null;
    const delta = Date.now() - props.snapshotAt;
    return delta <= 0 ? 0 : Math.floor(delta / 1000);
});

const freshnessText = computed(() => {
    const age = snapshotAgeSeconds.value;
    if (age === null) return t("workspace.fileMetaFreshnessUnknown");
    return t("workspace.fileMetaFreshnessAge", { seconds: age });
});

/**
 * **面板自己不做可见性门控**（自查修）：可见性只由父组件 `FileEditor` 决定。
 *
 * <p>原先这里还有一层 `v-if="showsMetadata(outcome)"`，结果「用户手动点『文件信息』」这条路径
 * 被挡死：按钮的 `aria-pressed` 已经是 true，面板却一个像素都不渲染 —— 典型的**两个地方各判一次
 * 同一件事**（判据分叉）。① / ② 两档自动展示也由父组件的同一个 `showMeta` 负责。</p>
 */

/** 不可解析与「太大了」的提示语**必须不同**（Lead 抬成判据：撒谎的提示比没有提示更坏）。 */
const noticeKey = computed(() => {
    switch (props.outcome?.state) {
        case "unparsable":
            return "workspace.fileMetaUnparsable";
        case "oversized-partial":
            return "workspace.fileMetaOversizedPartial";
        case "oversized-empty":
            return "workspace.fileMetaOversizedEmpty";
        default:
            return null;
    }
});

const previewText = computed(() => {
    const outcome = props.outcome;
    if (outcome?.state !== "oversized-partial") return null;
    return t("workspace.fileMetaPreviewBytes", {
        shown: formatFileSize(outcome.previewBytes ?? OPEN_PREVIEW_BUDGET_BYTES),
        total: outcome.totalBytes === null ? "?" : formatFileSize(outcome.totalBytes),
    });
});

/** 目录的大小不显示（无意义）；文件才显示。 */
const sizeText = computed(() => {
    if (!props.node || props.node.type === "directory") return null;
    return props.node.size === undefined ? null : formatFileSize(props.node.size);
});
</script>

<template>
    <section
        data-testid="workspace-file-meta"
        class="shrink-0 border-b bg-muted/20 px-3 py-2 text-xs"
        :aria-label="t('workspace.fileMetaTitle')"
    >
        <div class="flex items-center justify-between gap-2">
            <span class="flex items-center gap-1.5 font-medium">
                <Info class="size-3.5" aria-hidden="true" />
                {{ t("workspace.fileMetaTitle") }}
            </span>
            <button
                type="button"
                data-testid="workspace-file-meta-close"
                class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                :aria-label="t('workspace.fileMetaClose')"
                @click="emit('close')"
            >
                <X class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <!-- 分流提示：三种处境三句不同的话，不共用一句。 -->
        <p v-if="noticeKey" data-testid="workspace-file-meta-notice" class="mt-1.5 font-medium">
            {{ t(noticeKey) }}
        </p>
        <p v-if="previewText" data-testid="workspace-file-meta-preview" class="mt-1">
            {{ previewText }}
        </p>

        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaName") }}</dt>
            <dd data-testid="workspace-file-meta-name" class="truncate font-mono">
                {{ node?.name ?? "—" }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaPath") }}</dt>
            <dd data-testid="workspace-file-meta-path" class="truncate font-mono">
                {{ node?.path ?? "—" }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaType") }}</dt>
            <dd data-testid="workspace-file-meta-type">
                {{
                    node?.type === "directory"
                        ? t("workspace.fileMetaDir")
                        : t("workspace.fileMetaFile")
                }}
            </dd>
            <template v-if="sizeText">
                <dt class="text-muted-foreground">{{ t("workspace.fileMetaSize") }}</dt>
                <dd data-testid="workspace-file-meta-size" class="font-mono">{{ sizeText }}</dd>
            </template>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaModified") }}</dt>
            <dd data-testid="workspace-file-meta-modified" class="font-mono">
                {{ node?.modified ?? t("workspace.fileMetaUnknown") }}
            </dd>
            <!-- 树投影里没有 is_symlink / created ⇒ **如实标未知，不编**。 -->
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaSymlink") }}</dt>
            <dd data-testid="workspace-file-meta-symlink" class="text-muted-foreground">
                {{ t("workspace.fileMetaUnknown") }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaCreated") }}</dt>
            <dd data-testid="workspace-file-meta-created" class="text-muted-foreground">
                {{ t("workspace.fileMetaUnknown") }}
            </dd>
        </dl>

        <p data-testid="workspace-file-meta-freshness" class="mt-2 text-muted-foreground">
            {{ freshnessText }}
        </p>
    </section>
</template>
