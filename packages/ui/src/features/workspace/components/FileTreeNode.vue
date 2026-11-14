<script setup lang="ts">
import { computed, type Component } from "vue";
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
import type { FileNode } from "../../../types";
import { isDotfileName, isEmptyDirectoryNode } from "../stores/workspace";

const props = defineProps<{
    node: FileNode;
    depth: number;
    selectedPath: string | null;
    expandedPaths: Set<string>;
}>();

const emit = defineEmits<{
    select: [path: string];
    toggle: [path: string];
    contextmenu: [path: string, type: FileNode["type"], event: MouseEvent];
}>();

const indent = computed(() => `${props.depth * 16 + 8}px`);
const isExpanded = computed(() => props.expandedPaths.has(props.node.path));
const isSelected = computed(() => props.selectedPath === props.node.path);
// task-484 / D-1234：dotfile 置灰、空目录淡样式。判据来自 store（不在模板里靠猜），
// 同时落成 data 属性，好让断言/变异验证能精确点名而不是靠颜色。
const isDotfile = computed(() => isDotfileName(props.node.name));
const isEmptyDirectory = computed(() => isEmptyDirectoryNode(props.node));

function getIcon(): Component {
    if (props.node.type === "directory") return isExpanded.value ? FolderOpen : Folder;
    const ext = props.node.name.split(".").pop()?.toLowerCase();
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

function handleClick() {
    if (props.node.type === "directory") {
        emit("toggle", props.node.path);
    } else {
        emit("select", props.node.path);
    }
}

function handleContextmenu(e: MouseEvent) {
    emit("contextmenu", props.node.path, props.node.type, e);
}
</script>

<template>
    <div>
        <div
            data-testid="file-tree-node"
            :data-dotfile="isDotfile ? 'true' : undefined"
            :data-empty-dir="isEmptyDirectory ? 'true' : undefined"
            class="flex items-center gap-1 py-1 text-sm cursor-pointer rounded hover:bg-accent/50 transition-colors select-none"
            :class="{
                'bg-accent text-accent-foreground': isSelected,
                'opacity-60': isEmptyDirectory,
            }"
            :style="{ paddingLeft: indent }"
            @click="handleClick"
            @contextmenu.prevent="handleContextmenu"
        >
            <span class="w-4 shrink-0 text-xs text-muted-foreground">
                {{ node.type === "directory" ? (isExpanded ? "▼" : "▶") : "" }}
            </span>
            <component :is="getIcon()" class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate flex-1 ml-1" :class="{ 'text-muted-foreground': isDotfile }">{{
                node.name
            }}</span>
        </div>
        <template v-if="node.type === 'directory' && isExpanded && node.children">
            <FileTreeNode
                v-for="child in node.children"
                :key="child.path"
                :node="child"
                :depth="depth + 1"
                :selected-path="selectedPath"
                :expanded-paths="expandedPaths"
                @select="(p: string) => emit('select', p)"
                @toggle="(p: string) => emit('toggle', p)"
                @contextmenu="
                    (p: string, t: FileNode['type'], e: MouseEvent) => emit('contextmenu', p, t, e)
                "
            />
        </template>
    </div>
</template>
