/**
 * BL-382 A′ POC 入口（task-33）。
 *
 * 只做**探针**：把 `@tanstack/vue-virtual` 挂进现有 `MessageScroller` 引擎，量四项风险。
 * 不参与产品路由、不 import 任何 `MessageList`/`ChatPanel`，产品代码零改动。
 * 运行方式见同目录 `run-poc.mjs`（它负责起 vite、开浏览器、采集数据）。
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/i18n";
import "@/styles/main.css";
import PocHarness from "./PocHarness.vue";

const app = createApp(PocHarness);
app.use(createPinia());
app.use(i18n);
app.mount("#poc");
