/**
 * Dev-only entry for `preview-dockview.html` — dockview 能力演示页（真组件 + mock 数据）。
 *
 * 形态照 `src/preview/main.ts`：独立 `createApp`、独立 root、**不 import 产品 router**、
 * 零 `/api/v1/**` 请求。区别：本页只需要 dockview 本身，不挂 pinia / vue-router / i18n ——
 * 演示内容是静态 mock 标记，没有 store 与路由消费方，少挂一层就少一层与产品耦合。
 *
 * **样式**：`dockview-vue/dist/styles/dockview.css` 是 dockview 的布局样式表（161 KB），
 * 产品代码目前**没有** import 它（`useDockview` 默认 false，产品路径还没走 dockview）；
 * 本页显式引入，否则 `.dv-*` 无布局规则、面板会堆叠成一条流。
 */
import { createApp } from "vue";
import "dockview-vue/dist/styles/dockview.css";
import "../styles/main.css";
import DockviewDemoApp from "./DockviewDemoApp.vue";

createApp(DockviewDemoApp).mount("#dockview-preview-root");
