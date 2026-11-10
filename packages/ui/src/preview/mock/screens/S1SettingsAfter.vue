<script setup lang="ts">
import { computed, inject, ref, type Ref } from "vue";
import { ArrowLeft, ChevronRight, Globe, Search, ShieldCheck } from "@lucide/vue";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarSeparator,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldSet,
    FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import NavRail from "@/components/sidebar/NavRail.vue";
import DomainCanvas from "./DomainCanvas.vue";
import DomainPanelCanvas from "./DomainPanelCanvas.vue";
import { CORE_DOMAINS } from "../data/domains-core";
import { ALL_DOMAINS } from "../data/all-domains";
import { domains, opsItems, securityItems, userItems } from "../data";

/**
 * Sheet 01 — settings shell after the switch to the vendored `Sidebar`.
 *
 * **判据（先写判据，再改样式）：「用户在这一屏怎样才能 3 秒内答出『我在哪一层』」**
 * ⇒ 必须同时满足两条，缺一不算可辨：
 *   (a) 层的**作用域**与层名同屏出现（「实例层」+「作用于所有用户」，不是只有一个名词）；
 *   (b) 左栏把「当前层」与「其他层」**并列展示**并各自标注（当前层 = 实心徽标 +「当前层」；
 *       其他层 = 虚线徽标），读者是把两层**对比**出来的，不是靠记住一个词。
 * 只靠「设置 | 实例层 | /settings/instance」这一行文字不满足 (a)：它说了名字，没说改了什么算谁的。
 *
 * Everything below is a real vendored component; the only page-local thing is the active-item
 * state (`active`). Four things the reader should be able to check without reading code:
 * 1. **全局 rail 常驻，56px**（task-253 用户裁定 ①；产品 `layouts/SettingsLayout.vue:60` 真渲染
 *    `<NavRail :show-expand="false" />`）。本屏**直接复用该组件**，不自造任何 rail 图标数组：
 *    - 它是 icon-only 形态，语义由 `aria-label` + `title` 承担（PLAN-0582 S2 ruling #1/#2）——
 *      **视觉上没有文字 label 是既定形态，不是缺陷**，不要「补 label」；
 *    - 「能否一层 Sidebar 全扛（rail 与设置左栏合并）」是跨区结构重构，归
 *      `webui-design-research-20261110.md` 方案 B，**单独立 PLAN**，本屏不表态。
 * 2. there is **no layer switcher**: the layer comes from the URL (`/settings/instance/**`), and the
 *    left column only groups entries by layer;
 * 3. 「实例」「用户」are **collapsible groups** (`Collapsible`, already vendored). The current layer
 *    is open by default; the other one can be opened to look, and its rows are links that navigate
 *    to that layer's route;
 * 4. every row carries a lucide icon (16px) and the active row shows a **2px left indicator bar** +
 *    tinted row (DEV-011 §10) instead of a full-row fill.
 *
 * 全局设置只有两层：工作区设置在各工作区内部（本轮不设计），所以左栏不出现「工作区层」。
 */
const active = ref("rag");
/** 审阅辅助注记（内容列宽边线/尺寸标注）由外壳的 `?notes=0` 统一开关，画布内默认不显示。 */
const notes = inject<Ref<boolean>>("mockNotes", ref(false));

/** URL 决定层：这是 `/settings/instance/rag`，所以实例组默认展开、用户组默认收起。 */
const instanceOpen = ref(true);
const userOpen = ref(false);

// task-77：内容区按 ?domain= 切换；未指定时退回原有的 RAG 硬编码体（便于对照）
const domainParam = new URLSearchParams(window.location.search).get("domain");
// 表单域（我）+ 专用面板域（ui-2）合成唯一查找表；否则 ?domain=embedding 会静默落回 rag
// 面板域排在最前：同 id 时专用面板实现优先（A/B 数据待 Lead 重派，暂不并入）
/**
 * 面板域（DEDICATED）与核心域优先：同 id 时表单域让位。
 * 必要性 [实测 2026-11-11]：A/B 组里定义了 embedding / agent-templates /
 * api-request-templates 的表单版，`find()` 先命中它们 ⇒ 面板域取不到，
 * 详情态与列表态 sha 完全相同（画错域的假绿）。
 */
// 域全集收敛在 `data/all-domains.ts`（task-81）：面板域在前、同 id 时表单域让位。
// 这里不再自己拼集合 —— 那样会漏掉 agent-runtime（`?domain=agent-runtime` 曾静默落回 rag）。
const activeDomain = computed(
    () => ALL_DOMAINS.find((domain) => domain.id === domainParam) ?? CORE_DOMAINS[0],
);
// [裁定 E] 专用面板域有两个状态：列表态 / 详情态（?detail=1）
const detailParam = new URLSearchParams(window.location.search).get("detail") === "1";
// 层切换（task-77 ③）：?layer=user|workspace|instance，默认实例层
const layerParam = new URLSearchParams(window.location.search).get("layer");
const currentLayer = computed<"instance" | "workspace" | "user">(() =>
    layerParam === "workspace" || layerParam === "user" ? layerParam : "instance",
);
const LAYER_TEXT = {
    instance: {
        name: "实例层",
        crumb: "实例配置",
        scope: "实例层 · 改动对所有用户生效",
        path: "/settings/instance",
    },
    workspace: {
        name: "工作区层",
        crumb: "工作区配置",
        scope: "工作区层 · 只影响本工作区",
        path: "/workspace/settings",
    },
    user: {
        name: "用户层",
        crumb: "用户配置",
        scope: "用户层 · 只影响你自己的账号",
        path: "/settings/user",
    },
} as const;
const layerText = computed(() => LAYER_TEXT[currentLayer.value]);

function instanceTotal(): number {
    return domains.length + opsItems.length + securityItems.length;
}
function userTotal(): number {
    return userItems.length;
}
</script>

<template>
    <div class="flex h-full min-h-0">
        <!-- 全局 rail：复用产品真组件（task-253 用户裁定 ①），56px icon-only，语义靠 aria-label/title -->
        <div class="h-full shrink-0">
            <NavRail :show-expand="false" />
        </div>
        <SidebarProvider class="min-w-0 flex-1">
            <!-- shrink-0 必须有：内容列 w-full 会把左栏挤窄（实测挤到 145px，页眉整段竖排） -->
            <Sidebar collapsible="none" class="h-full w-[264px] shrink-0" style="width: 264px">
                <SidebarHeader class="gap-3 border-b border-sidebar-border px-3 py-3">
                    <div class="flex items-center gap-2">
                        <span class="mk-body font-semibold" data-single-line>设置</span>
                        <Badge
                            variant="secondary"
                            class="h-5 gap-1 px-1.5 mk-caption"
                            data-single-line
                            ><Globe class="size-3" aria-hidden="true" />{{ layerText.name }}</Badge
                        >
                    </div>
                    <button
                        type="button"
                        class="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2 mk-caption text-muted-foreground"
                    >
                        <Search class="size-3.5" aria-hidden="true" />
                        <span>搜索设置项</span>
                        <kbd
                            class="ml-auto rounded border border-border bg-muted px-1 font-mono mk-caption"
                            >⌘K</kbd
                        >
                    </button>
                </SidebarHeader>

                <ScrollArea class="min-h-0 flex-1">
                    <SidebarContent class="px-1">
                        <!-- 组 1：实例层（当前层，默认展开） -->
                        <Collapsible v-model:open="instanceOpen">
                            <SidebarGroup>
                                <SidebarGroupLabel as-child>
                                    <CollapsibleTrigger
                                        class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 mk-caption uppercase tracking-wide hover:bg-sidebar-accent"
                                    >
                                        <ChevronRight
                                            class="size-3 transition-transform"
                                            :class="instanceOpen ? 'rotate-90' : ''"
                                            aria-hidden="true"
                                        />
                                        <span>实例</span>
                                        <span class="font-mono mk-caption text-muted-foreground">{{
                                            instanceTotal()
                                        }}</span>
                                        <span
                                            class="ml-auto mk-caption normal-case text-muted-foreground"
                                            >当前层</span
                                        >
                                    </CollapsibleTrigger>
                                </SidebarGroupLabel>
                                <CollapsibleContent>
                                    <SidebarGroupContent>
                                        <SidebarMenu>
                                            <SidebarMenuItem v-for="item in domains" :key="item.id">
                                                <SidebarMenuButton
                                                    :is-active="active === item.id"
                                                    class="relative h-8"
                                                    @click="active = item.id"
                                                >
                                                    <span
                                                        v-if="active === item.id"
                                                        class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                        aria-hidden="true"
                                                    />
                                                    <component
                                                        :is="item.icon"
                                                        class="size-4 shrink-0"
                                                    />
                                                    <span class="truncate">{{ item.label }}</span>
                                                    <SidebarMenuBadge v-if="item.badge">
                                                        {{ item.badge }}
                                                    </SidebarMenuBadge>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        </SidebarMenu>
                                    </SidebarGroupContent>

                                    <SidebarSeparator class="my-1" />
                                    <p
                                        class="px-2 pb-1 mk-caption uppercase tracking-wide text-muted-foreground"
                                    >
                                        实例运维 <span class="font-mono">2</span>
                                    </p>
                                    <SidebarGroupContent>
                                        <SidebarMenu>
                                            <SidebarMenuItem
                                                v-for="item in opsItems"
                                                :key="item.id"
                                            >
                                                <SidebarMenuButton
                                                    :is-active="active === item.id"
                                                    :disabled="item.gap"
                                                    :aria-label="
                                                        item.gap
                                                            ? item.label + '（后端缺口，暂不可用）'
                                                            : item.label
                                                    "
                                                    class="relative h-8"
                                                    @click="!item.gap && (active = item.id)"
                                                >
                                                    <span
                                                        v-if="active === item.id"
                                                        class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                        aria-hidden="true"
                                                    />
                                                    <component
                                                        :is="item.icon"
                                                        class="size-4 shrink-0"
                                                    />
                                                    <span class="truncate">{{ item.label }}</span>
                                                    <span
                                                        v-if="item.gap"
                                                        class="ml-auto shrink-0 rounded border border-border px-1 mk-caption text-muted-foreground"
                                                        >后端缺口</span
                                                    >
                                                    <span
                                                        v-else-if="item.unconfigured"
                                                        class="ml-auto shrink-0 rounded border border-dashed border-border px-1 mk-caption text-muted-foreground"
                                                        >未配置</span
                                                    >
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        </SidebarMenu>
                                    </SidebarGroupContent>

                                    <SidebarSeparator class="my-1" />
                                    <p
                                        class="px-2 pb-1 mk-caption uppercase tracking-wide text-muted-foreground"
                                    >
                                        安全与权限 <span class="font-mono">3</span>
                                    </p>
                                    <SidebarGroupContent>
                                        <SidebarMenu>
                                            <SidebarMenuItem
                                                v-for="item in securityItems"
                                                :key="item.id"
                                            >
                                                <SidebarMenuButton
                                                    :is-active="active === item.id"
                                                    :disabled="item.gap"
                                                    :aria-label="
                                                        item.gap
                                                            ? item.label + '（后端缺口，暂不可用）'
                                                            : item.label
                                                    "
                                                    class="relative h-8"
                                                    @click="!item.gap && (active = item.id)"
                                                >
                                                    <span
                                                        v-if="active === item.id"
                                                        class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                        aria-hidden="true"
                                                    />
                                                    <component
                                                        :is="item.icon"
                                                        class="size-4 shrink-0"
                                                    />
                                                    <span class="truncate">{{ item.label }}</span>
                                                    <span
                                                        v-if="item.gap"
                                                        class="ml-auto shrink-0 rounded border border-border px-1 mk-caption text-muted-foreground"
                                                        >后端缺口</span
                                                    >
                                                    <span
                                                        v-else-if="item.unconfigured"
                                                        class="ml-auto shrink-0 rounded border border-dashed border-border px-1 mk-caption text-muted-foreground"
                                                        >未配置</span
                                                    >
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        </SidebarMenu>
                                    </SidebarGroupContent>
                                </CollapsibleContent>
                            </SidebarGroup>
                        </Collapsible>

                        <!-- 组 2：用户层（非当前层，默认收起；展开是「看一眼」，点条目跳该层路由） -->
                        <Collapsible v-model:open="userOpen">
                            <SidebarGroup>
                                <SidebarGroupLabel as-child>
                                    <CollapsibleTrigger
                                        class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 mk-caption uppercase tracking-wide hover:bg-sidebar-accent"
                                    >
                                        <ChevronRight
                                            class="size-3 transition-transform"
                                            :class="userOpen ? 'rotate-90' : ''"
                                            aria-hidden="true"
                                        />
                                        <span>用户</span>
                                        <span class="font-mono mk-caption text-muted-foreground">{{
                                            userTotal()
                                        }}</span>
                                    </CollapsibleTrigger>
                                </SidebarGroupLabel>
                                <CollapsibleContent>
                                    <SidebarGroupContent>
                                        <SidebarMenu>
                                            <SidebarMenuItem
                                                v-for="item in userItems"
                                                :key="'user-' + item.id"
                                            >
                                                <SidebarMenuButton
                                                    class="h-8"
                                                    :href="'/settings/user/' + item.id"
                                                >
                                                    <component
                                                        :is="item.icon"
                                                        class="size-4 shrink-0"
                                                    />
                                                    <span class="truncate">{{ item.label }}</span>
                                                    <SidebarMenuBadge v-if="item.badge">
                                                        {{ item.badge }}
                                                    </SidebarMenuBadge>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        </SidebarMenu>
                                        <p
                                            class="px-2 pt-1 mk-caption leading-4 text-muted-foreground"
                                        >
                                            点条目跳
                                            /settings/user/*：偏好设置在此层是「我自己的偏好」，
                                            实例层同名域是默认值。
                                        </p>
                                    </SidebarGroupContent>
                                </CollapsibleContent>
                            </SidebarGroup>
                        </Collapsible>
                    </SidebarContent>
                </ScrollArea>

                <SidebarFooter class="border-t border-sidebar-border p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton size="sm">
                                <ArrowLeft class="size-4" />
                                <span>返回对话</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarFooter>
            </Sidebar>

            <SidebarInset class="h-full min-h-0 overflow-hidden bg-background">
                <div class="flex h-full min-h-0 flex-col">
                    <div class="flex items-center border-b border-border px-10 py-3">
                        <Breadcrumb>
                            <BreadcrumbList>
                                <BreadcrumbItem>
                                    <BreadcrumbLink href="#">设置</BreadcrumbLink>
                                </BreadcrumbItem>
                                <BreadcrumbSeparator />
                                <BreadcrumbItem>
                                    <BreadcrumbLink href="#">{{ layerText.crumb }}</BreadcrumbLink>
                                </BreadcrumbItem>
                                <BreadcrumbSeparator />
                                <BreadcrumbItem>
                                    <BreadcrumbPage>{{ activeDomain.label }}</BreadcrumbPage>
                                </BreadcrumbItem>
                            </BreadcrumbList>
                        </Breadcrumb>
                        <span
                            class="ml-auto flex items-center gap-2 mk-caption text-muted-foreground"
                            data-single-line
                        >
                            <span>{{ layerText.scope }}</span>
                            <span class="font-mono">{{ layerText.path }}</span>
                        </span>
                        <div
                            v-if="notes"
                            class="ml-auto flex flex-col items-end gap-0.5 text-right"
                        >
                            <span class="mk-caption text-muted-foreground"
                                >注记：内容列 1152px（max-w-6xl）</span
                            >
                            <span class="mk-caption text-muted-foreground"
                                >注记：「后端缺口 / 未配置」为示例标注，非真实缺口名单（真实名单见
                                settings-ui-issue-inventory N-09 / C-01）</span
                            >
                        </div>
                    </div>

                    <div class="min-h-0 flex-1 overflow-hidden px-10 py-6">
                        <div class="relative mx-auto w-full max-w-6xl">
                            <!-- task-77：内容区参数化（?domain=<id>）；外壳一行未动 -->
                            <DomainPanelCanvas
                                v-if="domainParam && activeDomain.layout === 'panel'"
                                :domain="activeDomain"
                                :detail="detailParam"
                                :current-layer="currentLayer"
                            />
                            <DomainCanvas
                                v-else-if="domainParam"
                                :domain="activeDomain"
                                :current-layer="currentLayer"
                            />
                            <template v-else>
                                <div class="flex items-baseline gap-3">
                                    <h1 class="mk-title font-semibold tracking-tight">RAG 检索</h1>
                                    <Badge variant="outline">9 项配置</Badge>
                                    <Badge variant="secondary">3 项被下层覆盖</Badge>
                                </div>
                                <p class="mt-2 mk-body leading-6 text-muted-foreground">
                                    检索参数：分块、召回、重排与相似度阈值。数值越大召回越粗、调用越少。
                                </p>

                                <Alert class="mt-5">
                                    <ShieldCheck class="size-4" />
                                    <AlertTitle>继承自实例层</AlertTitle>
                                    <AlertDescription>
                                        <span class="font-mono">embeddingModel</span> 与
                                        <span class="font-mono">indexerEndpoint</span>
                                        由实例统一指定，本层只读（换模型会使既有索引失效）。
                                    </AlertDescription>
                                </Alert>

                                <div class="mt-6 rounded-lg border border-border p-6">
                                    <FieldGroup>
                                        <FieldSet>
                                            <FieldLegend>分块与召回</FieldLegend>
                                            <FieldGroup>
                                                <Field>
                                                    <FieldLabel for="chunk">分块大小</FieldLabel>
                                                    <Input
                                                        id="chunk"
                                                        model-value="128k"
                                                        class="h-9"
                                                    />
                                                    <FieldDescription
                                                        >单文档切块上限；越大召回越粗、embedding
                                                        调用越少</FieldDescription
                                                    >
                                                </Field>
                                                <Field>
                                                    <FieldLabel for="topk">召回条数</FieldLabel>
                                                    <Input id="topk" model-value="8" class="h-9" />
                                                    <FieldDescription
                                                        >每次检索回填给模型的片段数</FieldDescription
                                                    >
                                                </Field>
                                                <Field>
                                                    <FieldLabel for="score">最低相关度</FieldLabel>
                                                    <Input
                                                        id="score"
                                                        model-value="0.35"
                                                        class="h-9"
                                                    />
                                                    <FieldDescription
                                                        >低于该分数的片段直接丢弃</FieldDescription
                                                    >
                                                </Field>
                                            </FieldGroup>
                                        </FieldSet>
                                    </FieldGroup>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
            </SidebarInset>
        </SidebarProvider>
    </div>
</template>
