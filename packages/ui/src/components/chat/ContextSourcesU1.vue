<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../composables/api";

const props = defineProps<{ sessionId: string }>();
const { t } = useI18n();

const open = ref(false);
const loading = ref(false);
const failed = ref(false);
const sourceKey = ref("");
const status = ref("");
const hashPrefix = ref("");
const envBranch = ref("");
const envHead = ref("");

async function load() {
  if (!props.sessionId) return;
  loading.value = true;
  failed.value = false;
  try {
    const res = await api.getContextSources(props.sessionId);
    sourceKey.value = res.sourceKey ?? "AGENTS.md";
    status.value = res.status ?? "unknown";
    hashPrefix.value = res.hashPrefix ?? "";
    envBranch.value = res.envBranch ?? "";
    envHead.value = res.envHead ?? "";
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.sessionId,
  () => {
    if (props.sessionId) void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="px-3 pt-1" data-testid="u1-context-sources">
    <button
      type="button"
      class="text-xs text-muted-foreground hover:text-foreground"
      data-testid="u1-toggle"
      :aria-expanded="open"
      :aria-label="t('chat.contextSourcesToggle')"
      @click="open = !open; if (open) void load()"
    >
      {{ open ? "▾" : "▸" }} {{ t("chat.contextSourcesTitle") }}
    </button>
    <div
      v-if="open"
      class="mt-1 rounded-md border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid="u1-body"
    >
      <div v-if="loading" data-testid="u1-loading">{{ t("chat.contextSourcesLoading") }}</div>
      <div v-else-if="failed" data-testid="u1-error" class="text-destructive">
        {{ t("chat.contextSourcesError") }}
      </div>
      <div v-else>
        <div data-testid="u1-source-line">
          <span class="font-medium text-foreground">{{ sourceKey }}</span>
          <span v-if="status === 'failed'" class="text-destructive">
            · {{ t("chat.contextSourcesFailed") }}
          </span>
          <span v-else-if="status && status !== 'unknown'"> · {{ status }}</span>
          <span v-if="hashPrefix"> · {{ hashPrefix }}</span>
        </div>
        <div v-if="envBranch || envHead" data-testid="u1-env-line" class="mt-0.5">
          git {{ envBranch || "—" }} @ {{ envHead || "—" }}
        </div>
      </div>
    </div>
  </div>
</template>
