/**
 * Dev-only entry for `preview.html` — the real-component UI preview page.
 *
 * Bootstraps the same pinia + i18n + markstream setup the product `main.ts` uses, then
 * mounts a **separate** app on a separate root. It never imports the router, so no
 * product route is added and no guard/auth fetch runs. Every data source is a module-level
 * mock object — this page issues no `/api/v1/**` request at all.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { setCustomComponents } from "markstream-vue";
import { i18n } from "../i18n";
import MarkstreamCodeBlockAdapter from "../features/workspace/chat/components/MarkstreamCodeBlockAdapter.vue";
import UiPreviewApp from "./UiPreviewApp.vue";
import { installPreviewStores } from "./previewStores";
import "../styles/main.css";

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

setCustomComponents("xihe", { code_block: MarkstreamCodeBlockAdapter });

// A memory-history router with no routes keeps `useRouter()` happy for the reused
// composer (its ModelPopover injects a router) without registering a product route or
// enabling any navigation/guard side effect.
const previewRouter = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
});

const app = createApp(UiPreviewApp);
app.use(pinia);
app.use(previewRouter);
app.use(i18n);

installPreviewStores();

app.mount("#ui-preview-root");
