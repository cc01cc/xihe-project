<script setup lang="ts">
import { computed } from "vue";
import { isHiddenTreeEntry, isRuntimeArtifactDir, useWorkspaceStore } from "../stores/workspace";
import type { FileNode } from "../../../types";
import Tree from "../../../components/ui/tree/Tree.vue";
import TreeNodeList from "./TreeNodeList.vue";

const props = withDefaults(
    defineProps<{
        searchQuery?: string;
        /**
         * PLAN-0639 M2: nodes of one root group of a multi-root workspace. Omitting
         * `nodes` renders the primary root tree (legacy single-root behavior);
         * `rootId` scopes file opens to the owning declared root.
         */
        nodes?: FileNode[];
        rootId?: string;
    }>(),
    {
        searchQuery: "",
        nodes: undefined,
        rootId: undefined,
    },
);

const ws = useWorkspaceStore();

const expandedArray = computed({
    get: () => Array.from(ws.expandedPaths),
    set: (next: string[]) => {
        ws.expandedPaths = new Set(next);
    },
});

// task-484：判据统一在 stores/workspace.ts（此前这里与 store 各写一份正则 + 一份 logs 规则，
// 两处同形必然漂）。store 侧负责构建时过滤，这里负责已传入的 props.nodes（多根分组）二次过滤。
function hideRuntimeArtifacts(nodes: FileNode[]): FileNode[] {
    return nodes.flatMap((node) => {
        if (isHiddenTreeEntry(node)) return [];
        const children = node.children ? hideRuntimeArtifacts(node.children) : undefined;
        if (node.type === "directory" && isRuntimeArtifactDir(node.name) && children?.length === 0)
            return [];
        return [{ ...node, ...(children ? { children } : {}) }];
    });
}

// NOTE(PLAN-0639 M2): expansion state is a path Set shared across root groups, so two
// roots that contain the same relative directory share expansion — cosmetic only.
const userTree = computed(() => hideRuntimeArtifacts(props.nodes ?? ws.fileTree));

/** Frontend filter over the loaded tree (M3 task 3.5): matches name substring,
 *  keeps ancestors of matches, and auto-expands them. Empty query = full tree. */
const displayTree = computed((): FileNode[] => {
    const q = props.searchQuery.trim().toLowerCase();
    if (!q) return userTree.value;
    const filter = (nodes: FileNode[]): FileNode[] => {
        const out: FileNode[] = [];
        for (const n of nodes) {
            const children = n.children ? filter(n.children) : undefined;
            if (n.name.toLowerCase().includes(q) || (children && children.length > 0)) {
                out.push({ ...n, children: children ?? n.children });
            }
        }
        return out;
    };
    return filter(userTree.value);
});

/**
 * task-76 判据④：**把 reka 的 selection 与「当前定位的节点」对齐**。
 *
 * <p>为什么不能自己塞 `aria-selected`：`TreeItem.vue:26` 的 `delegatedProps` 合并方向是
 * `{...rest, ...attrs}` ⇒ 使用方传的 attrs 会**覆盖 vendor 的**，塞进去只会和 vendor 打架。
 * reka 的 `TreeItem.js:139/144` 已按 `rootContext.selectedKeys` 输出 `aria-selected` +
 * `data-selected`；正确做法是**喂它同一个值**，让那条属性说的是「当前打开/定位的节点」
 * 而不是「鼠标点过谁」。</p>
 *
 * <p>目录与文件在这里**合流**（reka 只认一个 selection），互斥语义已由 store 保证
 * （`openFile` 清 `activeDirPath`、`openDirectory` 清 `activeFilePath`）⇒
 * 任一时刻只有一个是非 null，故 `selected` 恒为「那一个」。</p>
 */
// 注意 prop 名是 reka 的 **`modelValue`**（不是 `selected`）：`Tree.vue` 走
// `useForwardPropsEmits`，未声明的名字会当普通 attr 落到 `<ul>` 上（实测：
// 传 `:selected` 时 DOM 出现 `selected="[object Object]"`、`aria-selected` 恒 false）。
// **必须传单个节点对象、不是数组**：reka 的 `selectedKeys`（`TreeRoot.js:2936`）在
// `multiple` 为假时走 `[getKey(modelValue ?? {})]` —— 传数组会被当成一个整体去 `getKey`，
// 结果 `undefined` ⇒ `aria-selected` 恒 false（实测两次踩到）。
// 本树是单选语义（「当前打开的那一个」），故不传数组、也不开 `multiple`。
const selectedPath = computed<FileNode | undefined>(() => {
    const active = ws.activeFilePath ?? ws.activeDirPath;
    if (!active) return undefined;
    // 必须传**节点对象**而不是路径字符串：reka 的 `selectedKeys` 是
    // `props.getKey(modelValue)`（`TreeRoot.js:2936`），而这里的 `getKey` 是
    // `(node) => node.path` ⇒ 传字符串会变成 `getKey("a.ts")` = `undefined`，
    // `aria-selected` 恒为 false（实测踩过：⑥a 因此红在 `expected "false" to be "true"`）。
    return findNodesByPath(displayTree.value, active)[0];
});

/** 按路径在多根/嵌套树里找节点（selection 需要对象，见上）。找不到 ⇒ 空（不猜）。 */
function findNodesByPath(nodes: FileNode[], path: string): FileNode[] {
    for (const node of nodes) {
        if (node.path === path) return [node];
        if (node.children) {
            const hit = findNodesByPath(node.children, path);
            if (hit.length) return hit;
        }
    }
    return [];
}

const searchExpanded = computed(() => {
    if (!props.searchQuery.trim()) return expandedArray.value;
    const keys = new Set<string>();
    const walk = (nodes: FileNode[]) => {
        for (const n of nodes) {
            if (n.type === "directory") keys.add(n.path);
            if (n.children) walk(n.children);
        }
    };
    walk(displayTree.value);
    return Array.from(new Set([...expandedArray.value, ...keys]));
});
</script>

<template>
    <Tree
        :expanded="searchExpanded"
        :model-value="selectedPath"
        :items="displayTree"
        :get-key="(node: FileNode) => node.path"
        :get-children="(node: FileNode) => node.children"
        class="py-1"
        @update:expanded="
            (next: string[]) => {
                if (!props.searchQuery.trim()) expandedArray = next;
            }
        "
    >
        <TreeNodeList
            :nodes="displayTree"
            :level="0"
            :search-query="searchQuery"
            :root-id="rootId"
        />
    </Tree>
</template>
