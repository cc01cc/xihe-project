<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

const tabs = computed(() => {
    const items = [
        { name: "settings-config", label: "settings.configTab", path: "/settings/config" },
        { name: "settings-tool-faces", label: "settings.toolFaces", path: "/settings/tool-faces" },
        { name: "settings-credentials", label: "credentials.title", path: "/settings/credentials" },
        { name: "settings-knowledge", label: "settings.knowledge", path: "/settings/knowledge" },
        { name: "settings-data", label: "settings.dataControls", path: "/settings/data" },
        { name: "settings-monitoring", label: "settings.monitoring", path: "/settings/monitoring" },
        { name: "settings-audit", label: "settings.audit", path: "/settings/audit" },
    ];
    if (auth.isAdmin) {
        items.push({
            name: "settings-config-locks",
            label: "settings.configLockNav",
            path: "/settings/config-locks",
        });
        items.push({
            // PLAN-0585 M2: the principal grant surface is instance-ADMIN only.
            name: "settings-principal-grants",
            label: "settings.principalGrantsNav",
            path: "/settings/principal-grants",
        });
    }
    return items;
});
</script>

<template>
    <nav class="flex gap-1 overflow-x-auto border-b mb-4 px-1 whitespace-nowrap">
        <router-link
            v-for="tab in tabs"
            :key="tab.name"
            :to="tab.path"
            :data-testid="`settings-nav-${tab.name}`"
            class="px-3 py-2 text-sm border-b-2 transition-colors"
            :class="
                route?.name === tab.name
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
            "
        >
            {{ t(tab.label) }}
        </router-link>
    </nav>
</template>
