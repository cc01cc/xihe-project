import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import App from "./App.vue";
import router from "./router";
import { i18n } from "./i18n";
import { useSettingsStore } from "./stores/settings";
import { installGlobalErrorTelemetry, logger } from "./lib/logger";
import { initVisualVariant } from "./lib/visualVariant";
import { initColorScheme } from "./lib/colorScheme";
import { setCustomComponents, setKaTeXWorker } from "markstream-vue";
import MarkstreamCodeBlockAdapter from "./features/workspace/chat/components/MarkstreamCodeBlockAdapter.vue";
import "./styles/main.css";

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const app = createApp(App);
app.use(pinia);
// PLAN-0602: apply the persisted language before the first paint so English never flashes zh-CN.
useSettingsStore().initLanguage();
// PLAN-0631 M2（D31-M2 = B 密集）：默认语言就是 B（token 在 styles/main.css 的 :root）；
// 这里只把 opt-in 覆盖 `?variant=a|c` 投影到 `<html data-xh-variant>`（仅对比/回归用），
// 并清掉旧版持久化的 `xihe-visual-variant` 键，保证"无参数 = B"。
initVisualVariant();
// task-48 M2（配色统一到 shadcn-vue 官方 5 个 base color）：启动期把 localStorage
// `xihe-color-scheme`（旧候选值就地归一成 5 值之一）+ 可选 `?color=<5 值>` 投影到
// `<html data-xh-color>`，保证首屏即最终配色（无闪烁）。色彩与视觉语言正交。
initColorScheme();
app.use(router);
app.use(i18n);
app.mount("#app");

setCustomComponents("xihe", { code_block: MarkstreamCodeBlockAdapter });

async function initKaTeXWorker() {
    try {
        const KaTeXWorker = await import(
            /* webpackChunkName: "katex-worker" */
            "markstream-vue/workers/katexRenderer.worker?worker"
        );
        setKaTeXWorker(new KaTeXWorker.default());
    } catch {
        // KaTeX Worker is optional — falls back to synchronous rendering
    }
}
initKaTeXWorker();

installGlobalErrorTelemetry();

window.addEventListener("beforeunload", () => logger.flush());
