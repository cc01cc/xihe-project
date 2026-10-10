<script setup lang="ts">
import { computed } from "vue";
import { useMediaQuery } from "@vueuse/core";
import Dialog from "../../../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../../../components/ui/dialog/DialogContent.vue";
import DialogHeader from "../../../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../../../components/ui/dialog/DialogTitle.vue";
import DialogDescription from "../../../../components/ui/dialog/DialogDescription.vue";
import SheetContent from "../../../../components/ui/sheet/SheetContent.vue";
import SheetHeader from "../../../../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../../components/ui/sheet/SheetDescription.vue";

/**
 * Responsive shell for the checkpoint dialogs (spec/ui-ux §7 U6): reka-ui Dialog on desktop,
 * bottom Sheet on mobile (≤767px, same breakpoint as WorkspaceView). The open auto-focus is
 * intercepted so each dialog can land focus on its conservative default (cancel) instead of
 * the first control reka-ui would pick.
 */
const props = defineProps<{
    show: boolean;
    title: string;
    description?: string;
}>();

const emit = defineEmits<{
    "update:show": [value: boolean];
    "initial-focus": [];
}>();

const isMobileViewport = useMediaQuery("(max-width: 767px)");

const open = computed({
    get: () => props.show,
    set: (value: boolean) => emit("update:show", value),
});

function handleOpenAutoFocus(event: Event) {
    event.preventDefault();
    emit("initial-focus");
}
</script>

<template>
    <Dialog :open="open" @update:open="open = $event">
        <DialogContent
            v-if="!isMobileViewport"
            data-testid="checkpoint-dialog"
            class="max-w-lg"
            @open-auto-focus="handleOpenAutoFocus"
        >
            <DialogHeader>
                <DialogTitle>{{ title }}</DialogTitle>
                <DialogDescription v-if="description">{{ description }}</DialogDescription>
            </DialogHeader>
            <slot />
        </DialogContent>
        <SheetContent
            v-else
            data-testid="checkpoint-dialog-mobile"
            side="bottom"
            class="max-h-[90vh] overflow-y-auto p-4"
            @open-auto-focus="handleOpenAutoFocus"
        >
            <SheetHeader>
                <SheetTitle>{{ title }}</SheetTitle>
                <SheetDescription v-if="description">{{ description }}</SheetDescription>
            </SheetHeader>
            <slot />
        </SheetContent>
    </Dialog>
</template>
