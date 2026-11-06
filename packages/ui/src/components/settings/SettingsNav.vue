<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

// PLAN-0651 T4.2 / D51-07: the roles & bindings tab asks for the **action atom** CP asks for
// (`MANAGE_ROLES`, RoleController:52-53), read from `GET /me/permissions`. While the projection is
// in flight (or when it failed) the tab stays hidden — the same fail-closed shape CP gives a
// subject without the atom. The fetch is started here because this nav is the only consumer that
// renders before any settings page has loaded.
onMounted(() => {
    void auth.ensureSelfPermissions();
});

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
        // BL-392: this face is still gated on CP by the `cap:instance:admin` **capability**
        // (ConfigLockController:41/51/70), not by an action atom, so there is no atom to ask for
        // here yet. Keep the capability flag and revisit when that face is atomized.
        items.push({
            name: "settings-config-locks",
            label: "settings.configLockNav",
            path: "/settings/config-locks",
        });
    }
    if (auth.canManageRoles) {
        // PLAN-0610 W5b/W5c: access-role definitions + bindings replaced the retired
        // principal-grant page. PLAN-0651 T4.2: gated by `MANAGE_ROLES` above, not `isInstanceAdmin`.
        items.push({
            name: "settings-roles",
            label: "settings.rolesNav",
            path: "/settings/roles",
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
                    ? 'border-brand text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
            "
        >
            {{ t(tab.label) }}
        </router-link>
    </nav>
</template>
