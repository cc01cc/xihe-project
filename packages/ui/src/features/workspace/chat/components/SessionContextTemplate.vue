<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { request } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";

/**
 * PLAN-0414 T1.3/V3: per-Session explicit Context Template binding entry.
 * Resolution order when no explicit choice exists is fixed by the CP
 * (provider/model > user default > built-in); this control shows and changes
 * the pinned Session binding only, and never mutates a live ChatRun.
 */
const props = defineProps<{
    sessionId: string;
}>();

const { t } = useI18n();

const BUILTIN_TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";

interface TemplateOption {
    layer: "instance" | "user" | "workspace";
    templateId: string;
    version: number;
    name: string;
}

interface SessionView {
    id: string;
    workspaceId?: string;
    contextTemplateLayer?: string;
    contextTemplateId?: string;
    contextTemplateVersion?: number;
}

const options = ref<TemplateOption[]>([]),
    binding = ref<TemplateOption | null>(null),
    busy = ref(false),
    error = ref<string | null>(null);

function parseTemplates(raw: string | undefined): TemplateOption[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item: { id?: string; version?: number; name?: string }) => ({
            layer: "user" as const,
            templateId: String(item.id ?? ""),
            version: Number(item.version ?? 1),
            name: String(item.name ?? item.id ?? ""),
        }));
    } catch {
        return [];
    }
}

async function loadOptions(session: SessionView): Promise<TemplateOption[]> {
    const result: TemplateOption[] = [
        {
            layer: "instance",
            templateId: BUILTIN_TEMPLATE_ID,
            version: 1,
            name: t("settings.contextTemplate.builtinName"),
        },
    ];
    try {
        const userBody = await request<{ entries?: Record<string, string> }>(
            "/config/context-templates?layer=user&includeMeta=true",
        );
        result.push(
            ...parseTemplates(userBody.entries?.templates).map((option) => ({
                ...option,
                layer: "user" as const,
            })),
        );
    } catch (cause) {
        logger.warn("Failed to load user context templates", cause);
    }
    if (session.workspaceId) {
        try {
            const workspaceBody = await request<{ entries?: Record<string, string> }>(
                `/config/context-templates?layer=workspace&includeMeta=true&workspaceId=${encodeURIComponent(session.workspaceId)}`,
            );
            result.push(
                ...parseTemplates(workspaceBody.entries?.templates).map((option) => ({
                    ...option,
                    layer: "workspace" as const,
                })),
            );
        } catch (cause) {
            logger.warn("Failed to load workspace context templates", cause);
        }
    }
    return result;
}

function optionKey(option: TemplateOption): string {
    return `${option.layer}:${option.templateId}:${option.version}`;
}

function findOption(
    layer: string,
    templateId: string,
    version: number,
): TemplateOption | undefined {
    return options.value.find(
        (option) =>
            option.layer === layer &&
            option.templateId.toLowerCase() === templateId.toLowerCase() &&
            option.version === version,
    );
}

const current = computed(() => binding.value);

watch(
    () => props.sessionId,
    (sessionId) => {
        if (!sessionId) return;
        void (async () => {
            error.value = null;
            try {
                const session = await request<SessionView>(
                    `/sessions/${encodeURIComponent(sessionId)}`,
                );
                options.value = await loadOptions(session);
                binding.value = findOption(
                    session.contextTemplateLayer ?? "instance",
                    session.contextTemplateId ?? BUILTIN_TEMPLATE_ID,
                    session.contextTemplateVersion ?? 1,
                ) ?? {
                    layer: (session.contextTemplateLayer as TemplateOption["layer"]) ?? "instance",
                    templateId: session.contextTemplateId ?? BUILTIN_TEMPLATE_ID,
                    version: session.contextTemplateVersion ?? 1,
                    name: session.contextTemplateId ?? BUILTIN_TEMPLATE_ID,
                };
            } catch (cause) {
                error.value = t("chat.contextTemplateUnavailable");
                logger.warn("Failed to load Session Context Template binding", cause);
            }
        })();
    },
    { immediate: true },
);

async function handleChange(event: Event) {
    const key = (event.target as HTMLSelectElement).value;
    const option = options.value.find((item) => optionKey(item) === key),
        sessionId = props.sessionId;
    if (!option || !sessionId || busy.value) return;
    busy.value = true;
    error.value = null;
    try {
        await request(`/sessions/${encodeURIComponent(sessionId)}/context-template`, {
            method: "PATCH",
            body: JSON.stringify({
                layer: option.layer,
                templateId: option.templateId,
                version: option.version,
            }),
        });
        binding.value = option;
        toast.success(`${t("chat.contextTemplateLabel")}: ${option.name} v${option.version}`);
    } catch (cause) {
        error.value = t("chat.contextTemplateUnavailable");
        logger.warn("Context Template rebind failed", cause);
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <div class="shrink-0 border-b bg-background/80 px-3 py-2">
        <div class="flex items-center justify-between gap-2">
            <span
                data-testid="session-context-template-badge"
                class="inline-flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground"
            >
                <span>{{ t("chat.contextTemplateLabel") }}</span>
                <span
                    class="truncate font-medium text-foreground"
                    data-testid="session-context-template-current"
                >
                    {{
                        current
                            ? `${current.name} v${current.version}`
                            : t("chat.contextTemplateUnavailable")
                    }}
                </span>
            </span>
            <label class="sr-only" :for="`session-context-template-${sessionId}`">{{
                t("chat.contextTemplateLabel")
            }}</label>
            <select
                :id="`session-context-template-${sessionId}`"
                data-testid="session-context-template-select"
                class="max-w-44 rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                :value="current ? optionKey(current) : ''"
                :disabled="busy || options.length === 0"
                @change="handleChange"
            >
                <option
                    v-if="
                        current && !findOption(current.layer, current.templateId, current.version)
                    "
                    :value="optionKey(current)"
                >
                    {{ current.name }} v{{ current.version }}
                </option>
                <option
                    v-for="option in options"
                    :key="optionKey(option)"
                    :value="optionKey(option)"
                >
                    {{ option.name }} v{{ option.version }}
                </option>
            </select>
        </div>
        <p
            v-if="error"
            data-testid="session-context-template-error"
            class="mt-1 text-xs text-destructive"
            role="alert"
        >
            {{ error }}
        </p>
    </div>
</template>
