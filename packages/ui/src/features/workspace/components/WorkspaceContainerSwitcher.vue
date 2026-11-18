<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import type { ActiveColumn } from "../lib/containers";

/**
 * task-174（S2b）/ `D-1545`：窄屏「两栏仍然是两栏，只是同时只能显示单栏、可以切换」的**切换控件**。
 *
 * <p>为什么用 reka `Tabs` 而不是自造两个按钮：`D-1545` 明写「优先用栈内 UI 库，必须有键盘可达与
 * `aria-selected`，不许自造」；`components/ui/tabs` 是已 vendor 的 reka 封装，roving focus /
 * `role=tab` / `aria-selected` / 方向键全由库提供（与 `WorkspaceContainerTabs` 同源）。</p>
 *
 * <p>它**只改可见性**，不改归属：`containerOf` 与形态无关（`lib/containers.ts` 的不变式），
 * 所以切换回来时页签还在原来的栏里 —— 这正是 `D-1545` 相对 `D-1544` 并集方案的关键收益。</p>
 */
const props = defineProps<{
    activeColumn: ActiveColumn;
}>();

const emit = defineEmits<{
    (event: "update:activeColumn", value: ActiveColumn): void;
}>();

const { t } = useI18n();
const domId = useId();

const COLUMNS: readonly ActiveColumn[] = ["main", "right"];

const activeTab = computed<string>({
    get: () => props.activeColumn,
    set: (next) => {
        if (next === "main" || next === "right") emit("update:activeColumn", next);
    },
});
</script>

<template>
    <nav
        data-testid="workspace-container-switcher"
        class="flex h-8 shrink-0 items-center gap-1 border-b bg-card px-2"
        :aria-label="t('workspace.containerSwitcherLabel')"
    >
        <Tabs :id="domId" v-model="activeTab">
            <TabsList variant="line" class="p-0">
                <TabsTrigger
                    v-for="column in COLUMNS"
                    :key="column"
                    :value="column"
                    :data-testid="'workspace-container-switcher-' + column"
                    class="h-auto rounded-md px-2 py-1 text-xs after:hidden"
                    @click="emit('update:activeColumn', column)"
                >
                    {{
                        t(
                            column === "main"
                                ? "workspace.containerMain"
                                : "workspace.containerRight",
                        )
                    }}
                </TabsTrigger>
            </TabsList>
        </Tabs>
    </nav>
</template>
