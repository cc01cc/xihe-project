/**
 * Dev-only entry for `preview-mock.html` — the static mock sheets (task-233).
 *
 * Separate from `preview.html` on purpose: that page is a long scrolling catalogue, while these
 * are **one screen per image** at exactly 1920x1080 so Playwright can shoot them without cropping.
 *
 * Same rules as `src/preview/main.ts`: no router, no product route, and **no `/api/v1/**` request** —
 * every number and label below is a module-level mock object.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../../i18n";
import MockApp from "./MockApp.vue";
import { installMockStores } from "./stores";
import "../../styles/main.css";

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const previewRouter = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
});

const app = createApp(MockApp);
app.use(pinia);
app.use(previewRouter);
app.use(i18n);

installMockStores();

app.mount("#ui-mock-root");
