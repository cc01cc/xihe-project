<script setup lang="ts">
import BackToChatButton from "../../components/settings/BackToChatButton.vue";
import SettingsNav from "../../components/settings/SettingsNav.vue";
import CredentialsPanel from "../../components/settings/credentials/CredentialsPanel.vue";
</script>

<template>
    <BackToChatButton />
    <SettingsNav />
    <main class="mx-auto max-w-5xl px-4 py-6">
        <CredentialsPanel />
    </main>
</template>
