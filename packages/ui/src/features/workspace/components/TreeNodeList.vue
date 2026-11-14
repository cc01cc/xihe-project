<script setup lang="ts">
import type { Component } from "vue";
import {
    Database,
    File,
    FileCode2,
    FileJson,
    FileText,
    Folder,
    FolderOpen,
    Image,
    Settings2,
    Table2,
    Terminal,
} from "@lucide/vue";
import { isEmptyDirectoryNode, isDotfileName, useWorkspaceStore } from "../stores/workspace";
import type { FileNode } from "../../../types";
import TreeItem from "../../../components/ui/tree/TreeItem.vue";
import FileNodeMenu from "./FileNodeMenu.vue";

const props = defineProps<{
    nodes: FileNode[];
    level: number;
    searchQuery?: string;
    /** PLAN-0639 M2: owning declared root of this tree slice (multi-root grouping). */
    rootId?: string;
}>();

const ws = useWorkspaceStore();

function getIcon(node: FileNode, isExpanded: boolean): Component {
    if (node.type === "directory") return isExpanded ? FolderOpen : Folder;
    const ext = node.name.split(".").pop()?.toLowerCase();
    const map: Record<string, Component> = {
        md: FileText,
        pdf: FileText,
        ts: FileCode2,
        tsx: FileCode2,
        js: FileCode2,
        jsx: FileCode2,
        py: FileCode2,
        rs: FileCode2,
        java: FileCode2,
        go: FileCode2,
        vue: FileCode2,
        json: FileJson,
        yaml: FileJson,
        yml: FileJson,
        css: FileCode2,
        html: FileCode2,
        png: Image,
        jpg: Image,
        jpeg: Image,
        gif: Image,
        svg: Image,
        webp: Image,
        toml: Settings2,
        sql: Database,
        sh: Terminal,
        txt: FileText,
        log: FileText,
        csv: Table2,
    };
    return map[ext || ""] || File;
}

function handleSelect(node: FileNode) {
    if (node.type === "directory") return;
    ws.openFile(node.path, props.rootId);
}

/**
 * task-519（484 复盘）：D-1234 的两条视觉判据一�must落在**产品路径**上。
 *
 * 判据本体在 store（`isDotfileName` / `isEmptyDirectoryNode`），这里只做渲染映射。
 * 484 当时把它们写在 `FileTreeNode.vue` 上 —— 那个组件自 `abccd7004`（2026-11-03）起
 * 就被本组件取代、产品路径没有任何 import ⇒ 视觉判据在产品上是空的（真页面行既没有
 * `data-dotfile` 也没有 muted class）。挪到这里才算真的生效。
 *
 * 同时落成 data 属性：颜色是渲染产物，断言要能点名到行/节点而不是猜 CSS。
 */
function isDotfile(node: FileNode): boolean {
    return isDotfileName(node.name);
}

function isEmptyDir(node: FileNode): boolean {
    return isEmptyDirectoryNode(node);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function highlightName(name: string, query?: string): string {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return escapeHtml(name);
    const idx = name.toLowerCase().indexOf(q);
    if (idx < 0) return escapeHtml(name);
    return `${escapeHtml(name.substring(0, idx))}<b class="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-px">${escapeHtml(name.substring(idx, idx + q.length))}</b>${escapeHtml(name.substring(idx + q.length))}`;
}
</script>

<template>
    <ul>
        <li v-for="node in nodes" :key="node.path">
            <TreeItem
                v-slot="{ isExpanded }"
                :value="node"
                :level="level"
                @select="handleSelect(node)"
            >
                <FileNodeMenu :node="node">
                    <button
                        class="flex w-full items-center gap-1 py-1 text-sm rounded hover:bg-accent/50 transition-colors select-none text-left"
                        :data-dotfile="isDotfile(node) ? 'true' : undefined"
                        :data-empty-dir="isEmptyDir(node) ? 'true' : undefined"
                        :class="{
                            'bg-accent text-accent-foreground': ws.activeFilePath === node.path,
                            'opacity-60': isEmptyDir(node),
                        }"
                        :style="{ paddingLeft: `${level * 16 + 8}px` }"
                    >
                        <span class="w-4 shrink-0 text-xs text-muted-foreground">
                            {{ node.type === "directory" ? (isExpanded ? "▼" : "▶") : "" }}
                        </span>
                        <component
                            :is="getIcon(node, isExpanded)"
                            class="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <span
                            v-if="!searchQuery"
                            class="truncate flex-1 ml-1"
                            :class="{ 'text-muted-foreground': isDotfile(node) }"
                            >{{ node.name }}</span
                        >
                        <span
                            v-else
                            class="truncate flex-1 ml-1"
                            :class="{ 'text-muted-foreground': isDotfile(node) }"
                            v-html="highlightName(node.name, searchQuery)"
                        />
                    </button>
                </FileNodeMenu>
                <TreeNodeList
                    v-if="isExpanded && node.children && node.children.length > 0"
                    :nodes="node.children"
                    :level="level + 1"
                    :search-query="searchQuery"
                    :root-id="rootId"
                />
            </TreeItem>
        </li>
    </ul>
</template>
