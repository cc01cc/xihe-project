<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Activity, Code, FileDiff, FolderTree, GitBranch, Users } from "@lucide/vue";

/**
 * task-38 C1（DEV-011 §13.1「顶栏单行」）：桌面六个面板开关从 `WorkspaceToolbar` 那条
 * **内容区**工具带里独立出来，成为可单独落位的一簇 —— 宿主用 `<Teleport>` 把它投进
 * `workspace-secondary-nav` 右端的挂载点，**props / emits / testid 一律不变**，
 * 因此不需要把 workbench 的 6 组 props + 6 组 emits 上提到壳层（那会把一张视觉卡变成结构重构）。
 *
 * 为什么单独成文件：「投得出去」与「投不出去就留在原地」两条路径必须渲染**同一份**标记；
 * 复制两份就是第四种样式，且必然漂移（§13.1 的反例锚点要求判据能红）。
 * 调用方传入的 class 由 Vue 的单根 fallthrough 合并到根 div，无需 class prop。
 */
defineProps<{
    filesOpen?: boolean;
    codeOpen?: boolean;
    changesOpen?: boolean;
    monitorOpen?: boolean;
    membersOpen?: boolean;
    delegationOpen?: boolean;
}>();

const emit = defineEmits<{
    toggleFiles: [];
    toggleCode: [];
    toggleChanges: [];
    toggleMonitor: [];
    toggleMembers: [];
    toggleDelegation: [];
}>();

const { t } = useI18n();

/** 六个按钮同族：类名元组必须一致（选中 = 浅底 + 前景色，未选中 = 淡色 + hover 浅底）。 */
function toggleClass(open?: boolean): string {
    return open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent";
}
</script>

<template>
    <div class="flex items-center gap-1" data-testid="workspace-panel-actions">
        <!--
            D-1777/D-1778 第 5 行：files（目录树）面板的桌面重开/收起入口。
            树在右栏容器里被关掉后（files 页签关闭），从这里重开。
        -->
        <button
            type="button"
            data-testid="workspace-toolbar-files"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(filesOpen)"
            :title="filesOpen ? t('workspace.collapseFiles') : t('workspace.expandFiles')"
            :aria-label="filesOpen ? t('workspace.collapseFiles') : t('workspace.expandFiles')"
            :aria-pressed="filesOpen === true"
            @click="emit('toggleFiles')"
        >
            <FolderTree class="size-3.5" />
        </button>
        <button
            type="button"
            data-testid="workspace-toolbar-code"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(codeOpen)"
            :title="t('workspace.toggleCode')"
            :aria-label="t('workspace.toggleCode')"
            :aria-pressed="codeOpen === true"
            @click="emit('toggleCode')"
        >
            <Code class="size-3.5" />
        </button>
        <button
            type="button"
            data-testid="workspace-toolbar-changes"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(changesOpen)"
            :title="t('workspace.toggleDiff')"
            :aria-label="t('workspace.toggleDiff')"
            :aria-pressed="changesOpen === true"
            @click="emit('toggleChanges')"
        >
            <FileDiff class="size-3.5" />
        </button>
        <button
            type="button"
            data-testid="workspace-toolbar-monitor"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(monitorOpen)"
            :title="t('workspace.toggleMonitor')"
            :aria-label="t('workspace.toggleMonitor')"
            :aria-pressed="monitorOpen === true"
            @click="emit('toggleMonitor')"
        >
            <Activity class="size-3.5" />
        </button>
        <!-- PLAN-0623 U1：参与者面板入口（与 monitor 同构；移动端由 dock 溢出菜单进入）。 -->
        <button
            type="button"
            data-testid="workspace-toolbar-members"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(membersOpen)"
            :title="t('workspace.toggleMembers')"
            :aria-label="t('workspace.toggleMembers')"
            :aria-pressed="membersOpen === true"
            @click="emit('toggleMembers')"
        >
            <Users class="size-3.5" />
        </button>
        <!-- PLAN-0659 T1.4：委派 DAG 面板入口（与 monitor/members 同构）。 -->
        <button
            type="button"
            data-testid="workspace-toolbar-delegation"
            class="rounded p-1.5 transition-colors"
            :class="toggleClass(delegationOpen)"
            :title="t('workspace.toggleDelegation')"
            :aria-label="t('workspace.toggleDelegation')"
            :aria-pressed="delegationOpen === true"
            @click="emit('toggleDelegation')"
        >
            <GitBranch class="size-3.5" />
        </button>
    </div>
</template>
