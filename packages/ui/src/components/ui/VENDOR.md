# `src/components/ui` 第三方组件来源台账（VENDOR）

本目录除 Xihe 自有组件外，还收录**逐字复制**的 shadcn-vue 注册表组件（reka-ui 版本）。
它们不是本仓库原创代码：升级与重取只走上游，**禁止手写近似实现**；改本地副本必须回写本台账。

## 1. 收录范围（BL-476 L1 试点）

| 组件目录 | 上游名 | 本地文件数 | 接线情况 |
| ---- | ---- | ---- | ---- |
| `select/` | `select` | 12 | 已接线 1 处：`../settings/ProviderHub.vue`（模型发现字段 `form.modelDiscovery`） |
| `tabs/` | `tabs` | 5 | 已接线 1 处：`src/features/workspace/components/WorkspaceTabBar.vue`（工作台页签条） |
| `popover/` | `popover` | 8 | **仅收录、未接线**：两个试点文件内没有天然锚定浮动面板需求，按任务口径不硬塞，留作 L2 批量素材 |

合计 **25** 个文件。同一批要替换的原生 `<select>` 全仓基线见 §7。

## 1.1 PLAN-0697 第二批（task-77：vendor 6 族，不接线业务页）

| 组件目录 | 上游名 | 本地文件数 | 接线情况 |
| ---- | ---- | ---- | ---- |
| `dropdown-menu/` | `dropdown-menu` | 15 | **仅收录、未接线**（PLAN-0697 口径：只 vendor，不接业务页） |
| `combobox/` | `combobox` | 12 | **仅收录、未接线**（依赖 `input-group`，见下） |
| `toggle/` | `toggle` | 2 | **仅收录、未接线**（PLAN-0697 口径：只 vendor，不接业务页） |
| `slider/` | `slider` | 2 | **仅收录、未接线**（PLAN-0697 口径：只 vendor，不接业务页） |
| `accordion/` | `accordion` | 5 | **仅收录、未接线**（PLAN-0697 口径：只 vendor，不接业务页） |
| `hover-card/` | `hover-card` | 4 | **仅收录、未接线**（PLAN-0697 口径：只 vendor，不接业务页） |
| `input-group/` | `input-group` | 7 | **仅收录、未接线**（combobox 的 registryDependency；其 deps=`button`/`input`/`textarea` 均已在仓） |

合计 **47** 个文件（6 族 40 + `input-group` 传递依赖 7）；本批不接线业务页。

## 2. 上游来源与版本

- 注册表端点：`https://shadcn-vue.com/r/styles/reka-nova/<name>.json`
  （`packages/ui/components.json` 的 `"style": "reka-nova"`；注意 `r/<name>.json` 会 404）
- 上游仓库：[`unovue/shadcn-vue`](https://github.com/unovue/shadcn-vue)，默认分支 `dev`
- 取件时上游 HEAD：`d1bf1b3a2d1a824b19f32d7253a28a43797b8253`（2026-11-03T09:14:04Z）
- 许可证：MIT
- 取件时间：2026-11-08；第二批（PLAN-0697，6 族）取件时间 2026-11-09，快照在 `one/.local/evidence/plan-0697/registry/`。
- 原始 JSON 快照（不入库，保留在 lane 证据目录 `one/.local/evidence/bl-476-l1/registry/`）：

| 快照 | 大小 | SHA256[0:16] |
| ---- | ---- | ---- |
| `select.reka-nova.json` | 12662 B | `DFDAA7621E5969F1` |
| `tabs.reka-nova.json` | 6132 B | `617CCB1930B23053` |
| `popover.reka-nova.json` | 5348 B | `5C0DD4C5783DDD24` |
| `toggle.reka-nova.json` | 2913 B | `896C875877BC3AAB` |
| `dropdown-menu.reka-nova.json` | 16582 B | `EF4EF416D50ABE38` |
| `combobox.reka-nova.json` | 12047 B | `FBE5E77D4DBEE65A` |
| `slider.reka-nova.json` | 2698 B | `8342C7FF50661A1E` |
| `accordion.reka-nova.json` | 5107 B | `D98414F53C97F469` |
| `hover-card.reka-nova.json` | 3178 B | `0DF83C4F6F8C0DC8` |
| `input-group.reka-nova.json` | 8016 B | `128D4C1D4A279152` |

- 取件脚本：`one/.local/evidence/bl-476-l1/vendor.mjs`（读快照 → 去掉 `styles/reka-nova/ui/` 路径前缀 → 重写 `cn` import → 写入本目录）

## 3. 运行时依赖与已知版本漂移

组件只依赖 `packages/ui/package.json` 的既有依赖：`reka-ui`、`@lucide/vue`、`@vueuse/core`（`reactiveOmit`）、`class-variance-authority`，以及本仓库的 `@/lib/utils`（`cn`）。
**本批未新增依赖、未改 lockfile。**

⚠️ 既有版本漂移（非本批引入）：`package.json` 声明 `reka-ui: ^2.11.0`、lock 也写 2.11.0，但磁盘
`node_modules/reka-ui` 实际为 **2.10.5**（来自 `aa597564 build(PLAN-0633 D)`）。本批组件按 **2.10.5** 的
导出与内部行为核验（`Select*` / `Tabs*` / `Popover*` / `RovingFocusGroup` / `useForwardProps(Emits)` 全部存在）。
install 当前冻结（BL-478 前置），由 Lead 在 UI 单测基线转绿后统一安装；安装后需复核本目录在 2.11.0 下仍兼容。

## 4. 本地改动清单（重取上游时必须重做）

1. `from 'cn'` → `from "@/lib/utils"`：注册表把 `cn` 当外部包名，本仓库没有该包。
1b. 跨族 import `@/styles/reka-nova/ui/<name>` → `@/components/ui/<name>`：注册表按上游站点根写路径，本仓组件在 `src/components/ui/`。本批命中 5 处（`input-group` 3 文件 × button/input/textarea、`combobox/ComboboxInput.vue` × input-group）。
2. `oxfmt` 统一格式化（4 空格缩进、`printWidth: 100`、双引号、分号）——只动空白与引号，无逻辑改动。
3. 原样保留的**惰性类名**：`cn-menu-target`、`cn-menu-translucent`、`cn-font-heading`、`cn-tabs`、`cn-card`
   在本仓库 `src/styles/` 下没有定义（`rg` 为空），属上游其他 style 的残留产物。保留是为了与上游 diff 可读，
   **不要**把它们当作既有 token 或新建设计语言来使用。
4. 除上述三条外无改动：组件逻辑、props、emits、slot 名与上游逐字一致。

> 已知风格债务：本批 vendor 为上游新一代写法（`data-[state=open]` 等），与既有 `dialog`/`button` 旧一代并存；风格统一留待专项，不在本批处理。

## 5. 逐文件清单（SHA256[0:12]）

`select/`（12）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 710 B | `CDB286FB2B98` |
| `Select.vue` | 460 B | `271A1C82572D` |
| `SelectContent.vue` | 2558 B | `3D79BA34996A` |
| `SelectGroup.vue` | 585 B | `3843112C6FC8` |
| `SelectItem.vue` | 1594 B | `0D586A641C23` |
| `SelectItemText.vue` | 308 B | `C53184A58F54` |
| `SelectLabel.vue` | 480 B | `ACA7A29A5DC8` |
| `SelectScrollDownButton.vue` | 978 B | `767909C8487D` |
| `SelectScrollUpButton.vue` | 962 B | `0D0D21C0ABA9` |
| `SelectSeparator.vue` | 600 B | `F05493F6C378` |
| `SelectTrigger.vue` | 1909 B | `B31F4A9115FF` |
| `SelectValue.vue` | 289 B | `85DB3CEE9DDE` |

`tabs/`（5）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 916 B | `26C9716A44C7` |
| `Tabs.vue` | 844 B | `BC3E4871AC93` |
| `TabsContent.vue` | 597 B | `CB723788065D` |
| `TabsList.vue` | 851 B | `1F370B8CFB59` |
| `TabsTrigger.vue` | 2352 B | `A848BF23090C` |

`popover/`（8）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 448 B | `709A53026DD0` |
| `Popover.vue` | 468 B | `3CB2F74ECB39` |
| `PopoverAnchor.vue` | 301 B | `48E326C0206C` |
| `PopoverContent.vue` | 1599 B | `299F11142DEE` |
| `PopoverDescription.vue` | 324 B | `578977AC8E49` |
| `PopoverHeader.vue` | 331 B | `4543B4FB028C` |
| `PopoverTitle.vue` | 328 B | `49D1F9231117` |
| `PopoverTrigger.vue` | 307 B | `E92974A7B74A` |

`dropdown-menu/`（15）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `DropdownMenu.vue` | 509 B | `136AA4B6AD8F` |
| `DropdownMenuCheckboxItem.vue` | 1680 B | `18CC3D19531C` |
| `DropdownMenuContent.vue` | 1768 B | `E28F4509970C` |
| `DropdownMenuGroup.vue` | 326 B | `2A9FF6231CB4` |
| `DropdownMenuItem.vue` | 1664 B | `FE07D66B8690` |
| `DropdownMenuLabel.vue` | 848 B | `DED59F0DB162` |
| `DropdownMenuRadioGroup.vue` | 525 B | `E19600C78D23` |
| `DropdownMenuRadioItem.vue` | 1654 B | `1FC12C87B314` |
| `DropdownMenuSeparator.vue` | 630 B | `775F53972A38` |
| `DropdownMenuShortcut.vue` | 509 B | `AF21D9A3B0E1` |
| `DropdownMenuSub.vue` | 506 B | `92BD6FDE209B` |
| `DropdownMenuSubContent.vue` | 1439 B | `174665E584A3` |
| `DropdownMenuSubTrigger.vue` | 1318 B | `C0B7BA16B480` |
| `DropdownMenuTrigger.vue` | 412 B | `79A70E1F6A44` |
| `index.ts` | 1113 B | `BC31C0DA4040` |

`combobox/`（12）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `Combobox.vue` | 476 B | `D4C9C2D719AA` |
| `ComboboxAnchor.vue` | 623 B | `4E56F9709786` |
| `ComboboxEmpty.vue` | 765 B | `3D2703DDE915` |
| `ComboboxGroup.vue` | 813 B | `2E4EBC304289` |
| `ComboboxInput.vue` | 1240 B | `4258F1C4EC96` |
| `ComboboxItem.vue` | 1190 B | `958E47A295FC` |
| `ComboboxItemIndicator.vue` | 840 B | `20547108044D` |
| `ComboboxList.vue` | 1911 B | `9870B22C2EFE` |
| `ComboboxSeparator.vue` | 631 B | `BD24717F6241` |
| `ComboboxTrigger.vue` | 713 B | `8131A76F3E18` |
| `ComboboxViewport.vue` | 881 B | `F22BCE0426B6` |
| `index.ts` | 769 B | `BC84D5266474` |

`toggle/`（2）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 1578 B | `2BF8C2D648EA` |
| `Toggle.vue` | 1087 B | `7CD67E888DD1` |

`slider/`（2）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 50 B | `C94ACAE44CF7` |
| `Slider.vue` | 2342 B | `FCBDD169A0FB` |

`accordion/`（5）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `Accordion.vue` | 792 B | `C057F080BE80` |
| `AccordionContent.vue` | 949 B | `6AE9B14D5483` |
| `AccordionItem.vue` | 719 B | `338219AD2587` |
| `AccordionTrigger.vue` | 1825 B | `0090B92C91C6` |
| `index.ts` | 260 B | `C080FE8A6F4F` |

`hover-card/`（4）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `HoverCard.vue` | 485 B | `6F7FBDEDAECE` |
| `HoverCardContent.vue` | 1474 B | `9A2F28FC9F7D` |
| `HoverCardTrigger.vue` | 320 B | `554B85D7AC2D` |
| `index.ts` | 196 B | `1C4223AD6386` |

`input-group/`（7）

| 文件 | 大小 | SHA256[0:12] |
| ---- | ---- | ---- |
| `index.ts` | 2397 B | `D3B5BD733B08` |
| `InputGroup.vue` | 1519 B | `7B5F8BD53450` |
| `InputGroupAddon.vue` | 1074 B | `E9B7DDF82CB5` |
| `InputGroupButton.vue` | 563 B | `B5C686BCF651` |
| `InputGroupInput.vue` | 595 B | `1B0D23DBC98F` |
| `InputGroupText.vue` | 475 B | `DD0C38B72008` |
| `InputGroupTextarea.vue` | 621 B | `5DBCFF160BF0` |

## 6. 接线时的行为陷阱（reka-ui 2.10.5 实测）

- **`SelectValue` 的关闭态文案**来自已挂载的 `SelectItemText`，弹层从未打开过时是空串 ⇒ 调用点必须自带 label。
  `ProviderHub.vue` 用同一份 `discoveryOptions` 经 `SelectValue` 插槽渲染，选项与关闭态文案同源。
- **`SelectTrigger`** 靠 `pointerdown`（要求 `button === 0`）或 `OPEN_KEYS`（Enter / Space / ArrowUp / ArrowDown）打开；
  `SelectContentImpl` 挂 `role="listbox"`，`SelectItem` 是 `role="option"`，Enter/Space 由**获得焦点的 option** 处理
  （不是 listbox 本身）。
- **`TabsTrigger`** 在 **`mousedown`** 上切换（另有 Enter/Space 与 focus 自动激活），**没有 click 处理**；
  真实鼠标手势里 mousedown 改 v-model、click 又会进调用点自己的 handler。`WorkspaceTabBar.vue` 因此保留显式
  `@click` 并加 `requestedPath` 幂等守卫（一次手势只 `router.push` 一次）。**不要**把这个守卫当冗余删掉。
- **`RovingFocusGroup` 的 tab stop 在 list 容器上**（`tabindex="0"`；trigger 自身恒为 `-1`），Tab 进入后由容器把焦点
  转给当前激活 trigger。断言键盘可达性时看容器，不要看 trigger。
- **`SelectItem` 的 `value` 不能是空串**（reka 直接抛错；空串语义是"清空选择/显示 placeholder"）。
- **jsdom 无 `scrollIntoView`**：`src/components/__tests__/Select.spec.ts` 在 `beforeAll` 里按文件局部 stub，
  `afterAll` 还原，不要改成全局 patch。

## 7. 原生 select 替换计数（本试点前后）

口径：`rg -c` 统计 `packages/ui/src` 下 `.vue`；"元素"列只统计行首缩进的真实开标签（`^\s*<select`）。

| 口径 | 试点前（`HEAD`） | 试点后（工作树） |
| ---- | ---- | ---- |
| 任意文本出现 `<select` | 54 处 / 29 文件 | 53 处 / 29 文件 |
| 真实 `<select` 元素 | 53 处 / 28 文件 | 52 处 / 28 文件 |
| `src/components/settings/ProviderHub.vue` 元素 | 6 | 5 |

**本试点只替换 1 处**（`ProviderHub.vue` 模型发现字段）；其余原生 select 保持不动，批量替换属 L2。

### 7.1 E2E 触点（DOM 合同变更的连带改动）

原生 select 换掉后 `selectOption` / `toHaveValue` 失效，下列 Playwright 用例已按新 DOM 改成
「点 `provider-connection-field-discovery` → 点 `provider-connection-discovery-option-<value>`」：

- `e2e/real/provider-connection-keys.spec.ts`（`selectDiscovery` 助手 + 3 处）
- `e2e/mock/provider-protocol-groups.spec.ts`（1 处：改为打开弹层读 `role="option"` 文案）

两个 `data-testid` 钩子加在 `ProviderHub.vue` 调用点（触发器 + 每个 `SelectItem`），不改上游组件。
**这批 E2E 改动只过了 `typecheck:e2e`（新增 0 条），未执行**——E2E 属 L2，本轮无栈；L1/L2 波次必须真跑一遍。

## 8. 验证与重取流程

- 改本目录后至少跑：
  `pnpm exec vitest run src/components/__tests__/Select.spec.ts src/features/workspace/components/__tests__/WorkspaceTabBar.spec.ts src/components/settings/__tests__/ProviderHub.spec.ts`
  ＋ `pnpm run typecheck` ＋ `pnpm run lint`。
- 重取上游：按 §2 端点取 JSON（不要用 `r/<name>.json`），落实 §4 的改动清单，再跑上面三条命令。
- **未完成的验证**（不要在此冒充已做）：页签条与下拉在真实浏览器里的键盘/视觉走查（Tab / 箭头 / Esc，
  以及 `after:hidden`、`data-active:*` 等覆盖类是否如预期生效）属 L1 波次；本轮只有 L0 单测证据，无栈、无 host E2E。
