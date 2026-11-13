<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, LoaderCircle, Search } from "@lucide/vue";
import { Tree, TreeItem } from "../../../components/ui/tree";
import { useOrgUnitTree, type OrgTreeItem } from "../composables/useOrgUnitTree";
import type { ApiOrgUnitNode } from "../../../composables/api";

const emit = defineEmits<{ select: [unit: ApiOrgUnitNode] }>();
const { t } = useI18n();

const tree = useOrgUnitTree();
const query = ref("");
const selectedKey = ref<string | null>(null);

/**
 * 展开 = 懒加载的扳机。reka 把展开态写进 expandedIds ⇒ 对每个**新展开**的节点
 * 调 ensureChildren（内部按 hasChildren / 已拉取去重——重复展开/搜索命中不重复发请求），
 * 同时把展开集落 localStorage（M3-1「记住展开」）。
 */
const expandedProxy = computed({
    get: () => tree.expandedIds.value,
    set: (ids: string[]) => {
        for (const id of ids) void tree.ensureChildren(id);
        tree.rememberExpanded(ids);
    },
});

/** 搜索命中态渲染扁平结果；否则渲染树。 */
const items = computed<OrgTreeItem[]>(() => tree.searchResults.value ?? tree.roots.value);

/** 展开 watch 会在子级未拉取时先发生：getChildren 在加载中/失败时给**占位子项**，
 * 渲染成一行状态（转圈 / 错误+重试），加载完成后被真实子级替换。 */
const LOADING_SUFFIX = "::loading",
    ERROR_SUFFIX = "::error";

function placeholderOf(item: OrgTreeItem, suffix: string): OrgTreeItem {
    return {
        key: item.key + suffix,
        label: "",
        unit: { id: "", name: "", parentId: null, depth: item.unit.depth + 1, hasChildren: false },
        children: [],
        childrenLoaded: true,
        childrenLoading: false,
        childrenError: "",
    };
}

function childrenOf(item: OrgTreeItem): OrgTreeItem[] {
    if (item.childrenLoading) return [placeholderOf(item, LOADING_SUFFIX)];
    if (item.childrenError) return [placeholderOf(item, ERROR_SUFFIX)];
    return item.children;
}

const getKey = (item: OrgTreeItem) => item.key;
const getChildren = (item: OrgTreeItem) => childrenOf(item);

function onSelect(next: OrgTreeItem | OrgTreeItem[] | undefined) {
    const single = Array.isArray(next) ? next[0] : next;
    if (!single || single.key.endsWith(LOADING_SUFFIX) || single.key.endsWith(ERROR_SUFFIX)) {
        return;
    }
    selectedKey.value = single.key;
    emit("select", single.unit);
}

/** 名搜防抖 200ms；退出搜索（清空）不自动重拉树，树状态原样保留。 */
let debounce: ReturnType<typeof setTimeout> | null = null;
watch(query, (q) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void tree.search(q), 200);
});

onMounted(() => void tree.loadRoots());

/**
 * 树级错误文案（卡面 ② 在列表侧还有一份同款判据）：404 与 403 不许混 ——
 * not-found 是「单元不存在 / 你不是任何单元的成员」，atom-denied 是「缺 READ_ORG_UNIT_MEMBERS
 * 原子」。"other" 才有重试键；404/403 重试没有意义（状态不会自己变）。
 */
const errorTitle = computed(() =>
    tree.error.value === "not-found"
        ? t("orgMembers.notFoundTitle")
        : tree.error.value === "forbidden"
          ? t("orgMembers.atomDeniedTitle")
          : t("orgMembers.treeError"),
);
const errorDesc = computed(() =>
    tree.error.value === "not-found"
        ? t("orgMembers.notFoundDesc")
        : tree.error.value === "forbidden"
          ? t("orgMembers.atomDeniedDesc")
          : tree.errorDetail.value,
);

function retryChildren(item: OrgTreeItem) {
    void tree.ensureChildren(item.key.replace(ERROR_SUFFIX, ""));
}
</script>

<template>
    <div class="flex h-full min-h-0 flex-col" data-testid="org-tree-panel">
        <div class="border-b p-3">
            <div class="relative">
                <Search class="absolute top-2 left-2 size-4 text-muted-foreground" />
                <input
                    v-model="query"
                    type="search"
                    data-testid="org-tree-search"
                    :placeholder="t('orgMembers.searchPlaceholder')"
                    class="w-full rounded-md border bg-background py-1.5 pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
            </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <p
                v-if="tree.loading.value"
                data-testid="org-tree-loading"
                class="p-3 text-sm text-muted-foreground"
            >
                {{ t("orgMembers.treeLoading") }}
            </p>
            <div v-else-if="tree.error.value" data-testid="org-tree-error" class="p-3">
                <p class="text-sm font-medium">{{ errorTitle }}</p>
                <p class="mt-1 text-sm text-muted-foreground">{{ errorDesc }}</p>
                <button
                    v-if="tree.error.value === 'other'"
                    type="button"
                    data-testid="org-tree-retry"
                    class="mt-2 rounded-md border px-2 py-1 text-sm hover:bg-accent"
                    @click="void tree.loadRoots()"
                >
                    {{ t("orgMembers.retry") }}
                </button>
            </div>
            <p
                v-else-if="!items.length && tree.searchResults.value === null"
                data-testid="org-tree-empty"
                class="p-3 text-sm text-muted-foreground"
            >
                {{ t("orgMembers.treeEmpty") }}
            </p>
            <p
                v-else-if="!items.length"
                data-testid="org-tree-search-empty"
                class="p-3 text-sm text-muted-foreground"
            >
                {{ t("orgMembers.searchEmpty") }}
            </p>
            <Tree
                v-else
                :items="items"
                :get-key="getKey"
                :get-children="getChildren"
                v-model:expanded="expandedProxy"
                :default-value="undefined"
                @update:model-value="onSelect"
            >
                <template #default="{ flattenItems }">
                    <TreeItem
                        v-for="fi in flattenItems"
                        :key="fi._id"
                        v-slot="{ isExpanded, handleToggle }"
                        v-bind="fi.bind"
                        :data-testid="'org-tree-node-' + fi.value.key"
                        class="flex min-h-8 w-full items-center gap-1 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[selected]:bg-accent"
                    >
                        <span
                            v-if="fi.value.key.endsWith(LOADING_SUFFIX)"
                            class="flex items-center gap-2 text-muted-foreground"
                            :style="{ paddingLeft: fi.level * 16 + 'px' }"
                        >
                            <LoaderCircle class="size-4 animate-spin" />
                            {{ t("orgMembers.treeLoading") }}
                        </span>
                        <span
                            v-else-if="fi.value.key.endsWith(ERROR_SUFFIX)"
                            class="flex items-center gap-2"
                            :style="{ paddingLeft: fi.level * 16 + 'px' }"
                        >
                            <span class="text-muted-foreground">{{
                                t("orgMembers.treeError")
                            }}</span>
                            <button
                                type="button"
                                class="text-primary underline-offset-2 hover:underline"
                                @click.stop="retryChildren(fi.value)"
                            >
                                {{ t("orgMembers.retry") }}
                            </button>
                        </span>
                        <template v-else>
                            <button
                                v-if="fi.hasChildren"
                                type="button"
                                :aria-label="
                                    isExpanded ? t('orgMembers.collapse') : t('orgMembers.expand')
                                "
                                :data-testid="'org-tree-toggle-' + fi.value.key"
                                class="rounded p-0.5 hover:bg-accent"
                                @click.stop="handleToggle"
                            >
                                <ChevronDown v-if="isExpanded" class="size-4" />
                                <ChevronRight v-else class="size-4" />
                            </button>
                            <span v-else class="size-4" />
                            <span
                                :style="{ paddingLeft: fi.hasChildren ? '0' : '4px' }"
                                :data-testid="'org-tree-label-' + fi.value.key"
                                >{{ fi.value.label }}</span
                            >
                        </template>
                    </TreeItem>
                </template>
            </Tree>
        </div>
    </div>
</template>
