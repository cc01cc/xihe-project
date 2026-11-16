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
 * 层级缩进：**步长 16 + 基准 8**，与工作区文件树同一套（\`TreeNodeList.vue\` 的
 * \`level * 16 + 8\`）。
 *
 * <p>task-76：此前这里还并列写着 \`FileTreeNode.vue:41\` 的 \`depth * 16 + 8\` ——
 * 那个组件是死代码（全仓 0 个 import，自 \`abccd7004\` 起被 \`TreeNodeList\` 取代），已随本卡删除。
 * 出处改指真实产品路径，否则注释成了悬空引用。</p>
 *
 * <p>task-33（用户截图报障）：本页此前**只有 loading / error 两种占位行**做了缩进
 * （且写的是 \`level * 16\`，缺基准 8），正常行一处都没有 ⇒ depth 0/1/2 的行首 x 完全相同，
 * 用户看到的"分析组在数据部下面却没有缩进"就是这个。占位态与正常态用不同基准是**同一个 bug
 * 的第二次出现**，所以两处一起收。常量只在本页定义、三处共用，模板里不出现 16/8 字面量。</p>
 *
 * <p><b>抽 helper 的人请先看这里</b>：\`16/8\` 目前有**三个副本**（上述两个文件 + 本页），
 * 统一抽走要另立卡（本卡写面只到 org-members），别只改一处。</p>
 */
const INDENT_STEP = 16;
const INDENT_BASE = 8;
/**
 * reka 的 `flattenItems` 给的是 **1 基** `level`（根节点 = 1，实测：根行按 `level * 16` 得到
 * 24px）⇒ 这里减 1 换成 0 基深度，最上层才是基准 8px，与文件树的 `depth * 16 + 8`（depth 0 起）对齐。
 * 写成 `level - 1` 而不是改模板里的调用点：调用点三处都只说"第几层"，换算只在这里做。
 */
const indentOf = (level: number) => INDENT_BASE + (level - 1) * INDENT_STEP;

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

/**
 * **行点击 = 选中，只走 chevron 才展开/收起**。
 *
 * <p>为什么不用 reka 的行默认行为（实测 reka `TreeItem.js:152-154` 的行 onClick =
 * select **+** toggle）：在读面里"点一下父单元想选中它"会顺手把子树收起 —— 用户刚展开的层级
 * 白展开了，而右栏此时还显示着该子树成员（左收右展的错位）。所以行的内容区
 * `@click.stop` 后只调 `handleSelect`（reka 的纯 select，不 toggle），展开只认 chevron 的
 * `handleToggle`。键盘 Enter/Space 仍走 reka 默认（select + toggle），与既有树控件一致。</p>
 */
function pick(item: OrgTreeItem, select: () => void) {
    if (item.key.endsWith(LOADING_SUFFIX) || item.key.endsWith(ERROR_SUFFIX)) return;
    select();
    selectedKey.value = item.key;
    emit("select", item.unit);
}

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
                        v-slot="{ isExpanded, handleToggle, handleSelect }"
                        v-bind="fi.bind"
                        :data-testid="'org-tree-node-' + fi.value.key"
                        class="flex min-h-8 w-full items-center gap-1 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[selected]:bg-accent"
                    >
                        <span
                            v-if="fi.value.key.endsWith(LOADING_SUFFIX)"
                            class="flex items-center gap-2 text-muted-foreground"
                            :style="{ paddingLeft: indentOf(fi.level) + 'px' }"
                        >
                            <LoaderCircle class="size-4 animate-spin" />
                            {{ t("orgMembers.treeLoading") }}
                        </span>
                        <span
                            v-else-if="fi.value.key.endsWith(ERROR_SUFFIX)"
                            class="flex items-center gap-2"
                            :style="{ paddingLeft: indentOf(fi.level) + 'px' }"
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
                            <!--
                                task-33：正常行的层级缩进挂在 label 上（内联），**不包一层容器** ——
                                行容器已有 \`px-2\`，包容器会让"整行 hover/选中底色"的起点（行首）
                                与内容起点（缩进）脱开，视觉上就是"底色从行首开始、文字却缩进"。
                                内联在 label 上则底色边界不变，只有文字位移；chevron 列同理不动。
                            -->
                            <button
                                type="button"
                                class="min-w-0 flex-1 truncate text-left"
                                :style="{ paddingLeft: indentOf(fi.level) + 'px' }"
                                :data-testid="'org-tree-label-' + fi.value.key"
                                @click.stop="pick(fi.value, handleSelect)"
                            >
                                {{ fi.value.label }}
                            </button>
                        </template>
                    </TreeItem>
                </template>
            </Tree>
        </div>
    </div>
</template>
