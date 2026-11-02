<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { X } from "@lucide/vue";
import { FocusScope } from "reka-ui";

const props = withDefaults(
    defineProps<{
        title?: string;
        show: boolean;
        /**
         * Opt-in focus trap for dialogs that own form input. Besides keeping Tab inside
         * the card, joining reka's focus-scope stack **pauses** an enclosing dialog
         * scope (mobile chat is a `Sheet`): a modal teleported to `<body>` is otherwise
         * "outside" that scope, so the sheet's trap pulled focus back on every focusin
         * and text fields in this dialog could not be typed into.
         */
        trapFocus?: boolean;
    }>(),
    { trapFocus: false },
);

const emit = defineEmits<{
    close: [];
}>();

function onKeydown(e: KeyboardEvent) {
    if (props.show && e.key === "Escape") emit("close");
}

/** Each dialog keeps its own explicit focus entry point; no implicit first-tabbable. */
function preventMountAutoFocus(event: Event) {
    event.preventDefault();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
    <Teleport to="body">
        <Transition name="modal">
            <div
                v-if="show"
                data-testid="modal-backdrop"
                class="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center"
                @click.self="emit('close')"
            >
                <div data-testid="modal-overlay" class="fixed inset-0 bg-black/50" />
                <FocusScope
                    as-child
                    :present="trapFocus"
                    :trapped="trapFocus"
                    :loop="trapFocus"
                    @mount-auto-focus="preventMountAutoFocus"
                >
                    <div
                        data-testid="modal-content"
                        class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg"
                    >
                        <div v-if="title" class="flex items-center justify-between mb-4">
                            <h2 class="text-lg font-semibold">{{ title }}</h2>
                            <button
                                type="button"
                                class="p-1 rounded hover:bg-accent"
                                aria-label="Close"
                                @click="emit('close')"
                            >
                                <X class="size-4" aria-hidden="true" />
                            </button>
                        </div>
                        <slot />
                    </div>
                </FocusScope>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.modal-enter-active {
    transition: all 0.2s ease-out;
}
.modal-leave-active {
    transition: all 0.15s ease-in;
}
.modal-enter-from {
    opacity: 0;
}
.modal-enter-from > .relative {
    transform: scale(0.95);
}
.modal-leave-to {
    opacity: 0;
}
.modal-leave-to > .relative {
    transform: scale(0.95);
}
</style>
