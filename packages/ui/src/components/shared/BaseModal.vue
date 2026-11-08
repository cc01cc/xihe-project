<script lang="ts">
/**
 * Module-scope layer state shared by every `BaseModal` instance.
 *
 * The card content is teleported to `<body>`, so nested modals have no common component
 * ancestor to provide/inject through — the arbitration has to live at module scope.
 *
 * - `openStack`: innermost-first Escape arbitration (BL-477). Before this, every open
 *   instance listened on `document` and all of them closed on one Escape — an enclosing
 *   `Sheet` plus a teleported modal closed in the same keypress.
 *
 * The body-scroll counter that used to live here moved to `composables/useScrollLock` so
 * that overlays which are not `BaseModal` (and not a reka `Dialog`) can share the same
 * counter instead of keeping a second one (BL-477).
 */
const openModalStack: symbol[] = [];
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { X } from "@lucide/vue";
import { FocusScope } from "reka-ui";
import { useI18n } from "vue-i18n";
import { useScrollLock } from "@/composables/useScrollLock";

const { t } = useI18n();

const props = withDefaults(
    defineProps<{
        title?: string;
        show: boolean;
        /**
         * Accessible name for dialogs that pass no `title`: with no visible heading there
         * is nothing to point `aria-labelledby` at, and a labelled dialog beats an
         * unnamed one. Callers can localise this; the default keeps the element from
         * ever shipping an empty accessible name.
         */
        ariaLabel?: string;
        /**
         * Opt-in focus trap for dialogs that own form input. Besides keeping Tab inside
         * the card, joining reka's focus-scope stack **pauses** an enclosing dialog
         * scope (mobile chat is a `Sheet`): a modal teleported to `<body>` is otherwise
         * "outside" that scope, so the sheet's trap pulled focus back on every focusin
         * and text fields in this dialog could not be typed into.
         */
        trapFocus?: boolean;
    }>(),
    { trapFocus: false, ariaLabel: "Dialog" },
);

const emit = defineEmits<{
    close: [];
}>();

/** Names the dialog card through its own heading (unique per instance). */
const titleId = `base-modal-title-${useId()}`;
const labelledBy = computed(() => (props.title ? titleId : undefined));
const labelFallback = computed(() => (props.title ? undefined : props.ariaLabel));

const contentRef = ref<HTMLElement | null>(null);
const instanceId = Symbol("base-modal");
const isOpen = ref(false);
/** Shared, counted body-scroll lock (see `composables/useScrollLock`). */
const scrollLock = useScrollLock();
/** Element that owned focus before opening, restored on close for keyboard users. */
let focusBeforeOpen: HTMLElement | null = null;

/**
 * Escape belongs to the innermost layer. The listener runs in the **capture** phase so
 * it can stop the event before document-level listeners registered by reka's
 * `DismissableLayer` (an enclosing `Sheet`) see it; `stopImmediatePropagation` is what
 * keeps those same-target listeners from also closing.
 *
 * A reka dialog opened *on top* of this modal (for example an AlertDialog confirm) owns
 * Escape instead — it is not part of this module's stack, so it is detected by checking
 * whether the key event originates inside another `role="dialog"` subtree.
 */
function onDocumentKeydown(event: KeyboardEvent): void {
    if (!props.show || event.key !== "Escape") return;
    if (openModalStack[openModalStack.length - 1] !== instanceId) return;

    const target = event.target instanceof Element ? event.target : null;
    const content = contentRef.value;
    const targetInside = target !== null && content !== null ? content.contains(target) : false;
    const activeElement = document.activeElement;
    const focusInside =
        activeElement instanceof Node && content !== null ? content.contains(activeElement) : false;
    if (!targetInside && !focusInside && isOwnedByAnotherDialog(target ?? activeElement)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    emit("close");
}

function isOwnedByAnotherDialog(element: Element | null): boolean {
    if (element === null) return false;
    const owner = element.closest('[role="dialog"], [aria-modal="true"]');
    if (owner === null) return false;
    return contentRef.value === null || !contentRef.value.contains(owner);
}

function registerOpen(): void {
    if (openModalStack.includes(instanceId)) return;
    const active = document.activeElement;
    focusBeforeOpen = active instanceof HTMLElement && active !== document.body ? active : null;
    openModalStack.push(instanceId);
    scrollLock.lock();
    document.addEventListener("keydown", onDocumentKeydown, true);
}

function registerClose(): void {
    const stackIndex = openModalStack.indexOf(instanceId);
    if (stackIndex !== -1) openModalStack.splice(stackIndex, 1);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    scrollLock.unlock();
    const target = focusBeforeOpen;
    focusBeforeOpen = null;
    if (target?.isConnected) {
        void nextTick(() => target.focus({ preventScroll: true }));
    }
}

function syncOpenState(show: boolean): void {
    if (show === isOpen.value) return;
    isOpen.value = show;
    if (show) registerOpen();
    else registerClose();
}

watch(() => props.show, syncOpenState, { immediate: true });
onBeforeUnmount(() => syncOpenState(false));

/** Each dialog keeps its own explicit focus entry point; no implicit first-tabbable. */
function preventMountAutoFocus(event: Event) {
    event.preventDefault();
}
</script>

<template>
    <Teleport to="body">
        <Transition name="modal">
            <div
                v-if="show"
                data-testid="modal-backdrop"
                class="pointer-events-auto fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center"
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
                        ref="contentRef"
                        data-testid="modal-content"
                        role="dialog"
                        aria-modal="true"
                        :aria-labelledby="labelledBy"
                        :aria-label="labelFallback"
                        class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg"
                    >
                        <div v-if="title" class="flex items-center justify-between mb-4">
                            <h2 :id="titleId" class="text-lg font-semibold">{{ title }}</h2>
                            <button
                                type="button"
                                class="p-1 rounded hover:bg-accent"
                                :aria-label="t('common.close')"
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
