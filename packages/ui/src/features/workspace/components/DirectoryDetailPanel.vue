<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FolderTree } from "@lucide/vue";
import type { FileNode } from "../../../types";

/**
 * task-78 ①：**目录详情页 v1**。
 *
 * <h3>数据源：`ws.fileTree` 里那一条，不重查（Lead 裁定）</h3>
 * <p>用户原话「数据源肯定是要复用的」。`fetchDirectoryTree`（`stores/workspace.ts`）是
 * <b>全递归</b>的 —— 它把每个子目录都展开后才返回 ⇒ 树里目录节点的 `children` 是**权威的**：
 * `[]` 真的是空目录，不是「还没加载」。这一点让「零请求」有了语义基础：不用再问服务器一次。</p>
 *
 * <p><b>为什么不用 `files/stat`</b>：① `get_file_info` 不在 CP 用户面白名单
 * （`McpProxyController.java:105-107`），用户 token 走 `/mcp` 必 403；② 即便能调，
 * **目录的 `size` 无意义**（不是子项总大小）⇒ 靠它算「占用」必然错。</p>
 *
 * <h3>三条诚实边界（都不许靠推断补）</h3>
 * <ul>
 *   <li><b>计数口径 = 树内可见子项</b>：隐藏项（`isHiddenTreeEntry`）与空运行产物目录
 *       已被 `fetchDirectoryTree` 过滤 ⇒ 数字**不等于**原始目录条目数。面板必须写清口径，
 *       否则「12 项」与 `ls` 的 15 项对不上时用户会以为界面错。</li>
 *   <li><b>目录无修改时间</b>：树投影只给文件填 `modified`（`FileNode.modified?`）⇒ 标「未知」，
 *       不拿子项里最大的那个日期冒充目录时间。</li>
 *   <li><b>不显示目录大小</b>：语义不存在。</li>
 * </ul>
 */
const props = defineProps<{ node: FileNode | null; path: string; snapshotAt: number | null }>();

const { t } = useI18n();

const children = computed<FileNode[]>(() => props.node?.children ?? []);
const dirCount = computed(() => children.value.filter((n) => n.type === "directory").length);
const fileCount = computed(() => children.value.filter((n) => n.type === "file").length);
const totalCount = computed(() => children.value.length);

const ageSeconds = computed(() => {
    if (props.snapshotAt === null) return null;
    const d = Date.now() - props.snapshotAt;
    return d <= 0 ? 0 : Math.floor(d / 1000);
});
const freshnessText = computed(() => {
    const age = ageSeconds.value;
    return age === null
        ? t("workspace.dirDetailFreshnessUnknown")
        : t("workspace.dirDetailFreshnessAge", { seconds: age });
});
</script>

<template>
    <section
        v-if="node"
        data-testid="workspace-dir-detail"
        class="flex-1 overflow-auto p-4"
        :aria-label="t('workspace.dirDetailTitle')"
    >
        <header class="flex items-center gap-2">
            <FolderTree class="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 class="text-sm font-medium">{{ t("workspace.dirDetailTitle") }}</h2>
        </header>

        <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaName") }}</dt>
            <dd data-testid="workspace-dir-detail-name" class="truncate font-mono">
                {{ node.name }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaPath") }}</dt>
            <dd data-testid="workspace-dir-detail-path" class="truncate font-mono">
                {{ node.path }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaType") }}</dt>
            <dd data-testid="workspace-dir-detail-type">{{ t("workspace.fileMetaDir") }}</dd>
            <dt class="text-muted-foreground">{{ t("workspace.dirDetailChildren") }}</dt>
            <dd data-testid="workspace-dir-detail-count">
                {{
                    t("workspace.dirDetailCounts", {
                        total: totalCount,
                        dirs: dirCount,
                        files: fileCount,
                    })
                }}
            </dd>
            <dt class="text-muted-foreground">{{ t("workspace.fileMetaModified") }}</dt>
            <dd data-testid="workspace-dir-detail-modified" class="text-muted-foreground">
                {{ t("workspace.fileMetaUnknown") }}
            </dd>
        </dl>

        <!-- 计数口径必须写出来：数字与 `ls` 对不上时，用户要知道为什么。 -->
        <p data-testid="workspace-dir-detail-scope" class="mt-3 text-xs text-muted-foreground">
            {{ t("workspace.dirDetailScope") }}
        </p>
        <p data-testid="workspace-dir-detail-freshness" class="mt-1 text-xs text-muted-foreground">
            {{ freshnessText }}
        </p>
    </section>
</template>
