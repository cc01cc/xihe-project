<script setup lang="ts">
import { ref } from "vue";
import BaseModal from "@/components/shared/BaseModal.vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import SectionShell from "../SectionShell.vue";

const open = ref(false);
const picked = ref("");

function choose(): void {
    picked.value = "已选择：层级正确";
}
</script>

<template>
    <SectionShell
        id="modal-overlay"
        index="09"
        title="Modal 内 Popover"
        description="BL-518 / PLAN-0714：BaseModal backdrop 之上的 Popover 选项必须可点击；真实组件 + mock 数据，供 e2e 回归。"
    >
        <div class="flex items-center gap-4">
            <Button data-testid="preview-open-modal" @click="open = true">打开 Modal</Button>
            <p data-testid="preview-picked" class="text-sm text-muted-foreground">
                {{ picked || "未选择" }}
            </p>
        </div>

        <BaseModal :show="open" title="Modal + Popover" trap-focus @close="open = false">
            <Popover>
                <PopoverTrigger as-child>
                    <Button data-testid="preview-popover-trigger">打开 Popover</Button>
                </PopoverTrigger>
                <PopoverContent data-testid="preview-popover-content" class="w-64">
                    <button
                        type="button"
                        data-testid="preview-popover-item"
                        class="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                        @click="choose"
                    >
                        可点击项
                    </button>
                </PopoverContent>
            </Popover>
        </BaseModal>
    </SectionShell>
</template>
