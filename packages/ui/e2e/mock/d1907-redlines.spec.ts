/**
 * task-125（D-1907 rev7 五条红线 + rev9/rev8 追加 G-11/G-12）：把模型结论固化成 e2e 断言组。
 *
 * <p><b>为什么落 mock 车道而不是 \`e2e/real/\`</b>（Lead 2026-11-20 裁定 ①）：real 车道要 CP :12631 +
 * runner，当下没起（\`curl → 000\`）⇒ 给不出读数；本卡的交付判据是「**现在应红**」的读数，不是闸门绿。
 * 卡面 write_scopes 写的是 \`e2e/real\`，落 mock 是范围例外，已在回报里点名。real 车道的真机复跑记挂账。</p>
 *
 * <p><b>为什么「现在应红」也要写成断言</b>：目标态（「+」= 组件选择器、两容器组件集合相等、
 * 会话配置作为容器组件、工作区配置不进「+」）今天**没有对象可测** —— 主栏「+」是
 * \`WorkspaceWorkbench.vue:685-687 openNewMainTab()\`（直接 \`?newChat=1\` 新建会话），右栏「+」是
 * \`WorkspaceDock.vue:333-362\` 的「重开已关闭面板」菜单（\`dock-reopen-menu\`）。
 * 于是所有「集合里没有配置项」的断言都会**真空绿**（0 个选项当然不含配置项）。
 * 本文件因此统一按「先证明选择器存在 → 再判选择器内容」的顺序写：选择器不存在时红在第一条，
 * 而不是绿在「什么都没查到」。这与 \`task97-container-plus.spec.ts\` 文件头「实现落地前必然红」同一口径。</p>
 *
 * <p><b>帧门</b>：所有布局读数前必须过 \`e2e/helpers/frame-gate.ts#waitForSettledLayout\`
 * （后台标签页 rAF 不推进 ⇒ 行高/宽度会读成 0 或中间态，task-82/93/117 实测）。门的返回值
 * （是否自然收敛 / 强制定格几帧）随读数一起落盘，不许静默。</p>
 *
 * <p><b>读数落盘</b>：\`one/.tmp/xh/ui-gates/task-125/readings.json\`（按 section 累积，
 * 与 \`e2e/real/ui-baseline.spec.ts\` 的 persist 同形）。断言红也照样写盘 —— 红点要能复核。</p>
 */
// timeout-exempt: 6 个用例各自要多页装载（会话页 / 工作区页 / 设置页 / 成员页）并逐条落盘读数
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForSettledLayout } from "../helpers/frame-gate";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const LAYOUT_KEY = "xihe-layout-ws:" + WORKSPACE_ID;
/** 两个会话夹具：G-11「两会话各开一份不串台」需要两个不同 session id。 */
const SESSIONS = ["d1907-a", "d1907-b"] as const;
const CHAT_PATH = "/workspace/" + WORKSPACE_ID + "/chat/" + SESSIONS[0];

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/e2e/mock → A03-xihe（与 e2e/real 同深度） */
const PROJECT_ROOT = path.resolve(HERE, "../../../..");
/** A03-xihe → one */
const ONE_ROOT = path.resolve(PROJECT_ROOT, "..");
const OUT_FILE = path.join(ONE_ROOT, ".tmp", "xh", "ui-gates", "task-125", "readings.json");

/** 复制自 task97 的虹膜口径：容器行的 testid 契约（改名前先改这里与 task97）。 */
function row(page: Page, container: "main" | "right") {
    return page.locator(
        '[data-testid="workspace-container-tabs"][data-container="' + container + '"]',
    );
}
function plus(page: Page, container: "main" | "right") {
    return page.getByTestId("workspace-container-plus-" + container);
}

/**
 * 「容器「+」产出的浮层」的**形状**：主栏的目标态是组件选择器，右栏今天是重开菜单。
 * 所以这里认「点开之后出现的浮层」：menu / listbox / dialog / *-picker ——
 * **外加 `[data-testid="dock-reopen-menu"]`**：右栏菜单在 task-140 换成 reka 原语前是
 * 裸 `div`（没有 role），task-125 首版只认 role ⇒ 右栏恒被记成 `pickerFound=false`，
 * 那是**探针漏采**而不是产品没菜单（2026-11-20 复跑实测：`right.dockReopenMenuPresent=true`）。
 * 目标态落地后应给选择器钉一个稳定 testid，并把这里收窄到它（届时本注释一起改）。
 */
const PICKER_SELECTOR =
    '[role="menu"], [role="listbox"], [role="dialog"], [data-testid$="-picker"], [data-testid*="component-picker"], [data-testid="dock-reopen-menu"]';

/** 落盘（按 section 合并，后跑的 section 不覆盖先跑的）。 */
function persist(section: string, payload: unknown): void {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    let existing: { generatedAt?: string; sections?: Record<string, unknown> } = {};
    try {
        existing = JSON.parse(readFileSync(OUT_FILE, "utf8")) as typeof existing;
    } catch {
        /* 首次运行或旧格式：重建 */
    }
    const sections = { ...(existing.sections ?? {}), [section]: payload };
    writeFileSync(
        OUT_FILE,
        JSON.stringify({ generatedAt: new Date().toISOString(), sections }, null, 2) + "\n",
        "utf8",
    );
}

/** 与会话页同一套显式桩（口径同 task-118 的 mock spec：config/provider/mcp/environment 全给）。 */
async function boot(page: Page, options: { persistentSeed?: boolean } = {}): Promise<void> {
    await setupMockAuth(page, {});
    await setupMockSessions(page, { sessions: SESSIONS.map((id) => ({ id, title: id })) });
    /*
     * task-150（Lead 裁定 B）：种子里的会话页签必须是**合法 id**。旧版写的是
     * `openTabs: [String(key)]` —— 那是 localStorage 键名本身，`isWorkTabId` 读侧直接丢掉
     * ⇒ 固定布局的 pin 每次装载都被冲成空集，旧 G-11 主栏断言恒红的真根因就是这个夹具缺陷。
     * 合法值 = `session:<sid>`（主栏会话页签的 id 域，见 `useWorkspaceLayout.ts` 的
     * `WORK_TAB_ID_PREFIX`），取 `SESSIONS[0]` 才与 `CHAT_PATH`（首屏会话）同形。
     *
     * `persistentSeed`：只种**第一次**（标记 `<layout-key>:seeded`）。主栏 pin 的累积与
     * 「关掉的页签 reload 后不复活」都必须跨导航保住产品落盘值，而每次导航重写种子会把两者都抹掉
     * ⇒ G-11b 用这个模式做**真 reload** 证法，而不是「只等落盘再读一次 store」。
     * 默认仍是每次导航重写，保证用例之间不串残留。
     */
    await page.addInitScript(
        ({
            key,
            seededFlag,
            persistent,
            firstTab,
        }: {
            key: string;
            seededFlag: string;
            persistent: boolean;
            firstTab: string;
        }) => {
            if (persistent && localStorage.getItem(seededFlag) === "1") return;
            localStorage.setItem("xihe-mock-filetree", JSON.stringify([]));
            // 固定布局：右栏关闭、只留一个会话页签，读数是「首启态」而不是上一个用例的残留。
            localStorage.setItem(
                key,
                JSON.stringify({
                    treeCollapsed: false,
                    treeWidth: 240,
                    dockCollapsed: true,
                    dockWidth: 360,
                    dockTabs: [],
                    activeDockTab: null,
                    dockMode: "pinned",
                    dockFocus: false,
                    openTabs: [firstTab],
                    activeColumn: "main",
                    openTarget: "main",
                }),
            );
            if (persistent) localStorage.setItem(seededFlag, "1");
        },
        {
            key: LAYOUT_KEY,
            seededFlag: LAYOUT_KEY + ":seeded",
            persistent: Boolean(options.persistentSeed),
            firstTab: "session:" + SESSIONS[0],
        },
    );
    await page.route("**/api/v1/config/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalogRevision: "d1907", providers: [] }),
        }),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: [] }),
        }),
    );
    await page.route("**/api/v1/mcp", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { content: [{ type: "text", text: JSON.stringify({ entries: [] }) }] },
            }),
        }),
    );
    await page.route("**/api/v1/workspaces/" + WORKSPACE_ID + "/environment", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                status: "ready",
                storageBackend: "host_directory",
                storageRef: WORKSPACE_ID,
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "d1907" },
                runtime: { status: "ready", deviceId: "d1907-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
    await page.goto(CHAT_PATH);
    await page.locator('[data-testid="workspace-main"]').waitFor({
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/**
 * 打开右栏容器，并等右栏页签行出现。
 *
 * 两条路，先 UI 后种子：
 * ① 点工具栏的面板开关键（`workspace-toolbar-<id>`）—— 这是「用户怎么开」；
 * ② 种子兜底 —— task-137 已把桌面六个开关**下线**（唯一入口 = 主列行行尾 `workspace-dock-toggle`
 *    → 右栏 `+` → 选面板类型），所以 ① 在当下源码里恒找不到按钮。本 spec 要测的是
 *    **右栏页签行里的东西**（「+」的选项集合 / 容器名标签），不关心它怎么被打开的，
 *    因此在 ① 无果时直接把「右栏开着」写进布局种子再重载，而不是断言入口存在 ——
 *    入口属于 task-137 的卡，在这里断言会让本 spec 跟着别人的重构反复红。
 */
async function openRightContainer(page: Page): Promise<void> {
    const candidates = ["files", "code", "changes", "monitor", "members", "context", "agents"];
    for (const id of candidates) {
        const toggle = page.getByTestId("workspace-toolbar-" + id);
        if ((await toggle.count()) === 0) continue;
        if ((await toggle.getAttribute("aria-pressed")) !== "true") {
            await toggle.click({ timeout: ACTION_TIMEOUT_MS });
        }
        if (
            await row(page, "right")
                .isVisible()
                .catch(() => false)
        )
            return;
    }
    await page.addInitScript((key: string) => {
        const layout = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
        layout.dockCollapsed = false;
        layout.dockTabs = ["files"];
        layout.activeDockTab = "files";
        localStorage.setItem(key, JSON.stringify(layout));
    }, LAYOUT_KEY);
    await page.reload();
    await page.locator('[data-testid="workspace-main"]').waitFor({
        state: "visible",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await expect(row(page, "right")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

interface PickerProbe {
    container: "main" | "right";
    plusPresent: boolean;
    /** 点完后出现过哪些候选浮层（testid 或 role 名），诊断用。 */
    candidates: string[];
    pickerFound: boolean;
    optionCount: number;
    optionLabels: string[];
    optionTestids: string[];
    /** 右栏「+」今天的真实产物：重开已关闭面板的菜单。 */
    dockReopenMenuPresent: boolean;
    urlAfterClick: string;
}

/** 点「+」并把它产出的浮层读成结构化读数（不判红，判红留给用例）。 */
async function probePicker(page: Page, container: "main" | "right"): Promise<PickerProbe> {
    const button = plus(page, container);
    const plusPresent = (await button.count()) > 0;
    const probe: PickerProbe = {
        container,
        plusPresent,
        candidates: [],
        pickerFound: false,
        optionCount: 0,
        optionLabels: [],
        optionTestids: [],
        dockReopenMenuPresent: false,
        urlAfterClick: page.url(),
    };
    if (!plusPresent) return probe;
    await button.click({ timeout: ACTION_TIMEOUT_MS });
    // 浮层是异步挂载的：给一个短的显式等待窗（不是固定 sleep —— 一到就继续）。
    await page
        .locator(PICKER_SELECTOR)
        .first()
        .waitFor({ state: "visible", timeout: 2000 })
        .catch(() => undefined);
    probe.urlAfterClick = page.url();
    probe.dockReopenMenuPresent = (await page.getByTestId("dock-reopen-menu").count()) > 0;
    const candidates = page.locator(PICKER_SELECTOR);
    const candidateCount = await candidates.count();
    for (let i = 0; i < candidateCount; i += 1) {
        const node = candidates.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const testid = await node.getAttribute("data-testid");
        const role = await node.getAttribute("role");
        probe.candidates.push(testid ?? "role=" + String(role));
    }
    const visiblePicker = candidates.filter({ visible: true }).first();
    if ((await visiblePicker.count()) === 0) return probe;
    probe.pickerFound = true;
    const items = await visiblePicker.evaluate((root) => {
        const nodes = Array.from(
            root.querySelectorAll(
                '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], button, li',
            ),
        );
        return nodes
            .filter((el) => el.getBoundingClientRect().height > 0)
            .map((el) => ({
                text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
                testid: el.getAttribute("data-testid"),
            }))
            .filter((item) => item.text.length > 0);
    });
    probe.optionCount = items.length;
    probe.optionLabels = items.map((item) => item.text);
    probe.optionTestids = items.map((item) => item.testid ?? "");
    return probe;
}

/** 读数：会话页顶带扫描（与 ui-baseline 同口径：elementFromPoint 走 contentX 列，取最近 data-testid）。 */
async function readChatChrome(page: Page) {
    const gate = await waitForSettledLayout(page);
    const reading = await page.evaluate(() => {
        const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
        const navFamily = document.querySelectorAll('[data-testid^="workspace-nav-"]');
        const mainRow = q('[data-testid="workspace-container-tabs"][data-container="main"]');
        const rectOf = (el: Element | null) =>
            el ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
        const mainRowRect = rectOf(mainRow);
        const contentX = Math.round(window.innerWidth * 0.55);
        const firstHit = document.elementFromPoint(contentX, 2);
        let key: string | null = null;
        let node: Element | null = firstHit;
        while (node && node !== document.body) {
            const tid = node.getAttribute("data-testid");
            if (tid) {
                key = tid;
                break;
            }
            if (node.getAttribute("role") === "tablist") {
                key = "role=tablist";
                break;
            }
            node = node.parentElement;
        }
        const label = q('[data-testid="workspace-container-label"]');
        return {
            navFamilyCount: navFamily.length,
            navIds: Array.from(navFamily).map((el) => el.getAttribute("data-testid")),
            secondaryNavPresent: q('[data-testid="workspace-secondary-nav"]') !== null,
            statusBarPresent: q('[data-testid="workspace-status-bar"]') !== null,
            firstBandKey: key,
            mainRowHeight: Math.round(mainRowRect.height),
            mainRowTop: Math.round(mainRowRect.y),
            labelPresent: label !== null,
            labelOffsetWidth: label ? label.offsetWidth : null,
        };
    });
    return { gate, ...reading };
}

test.describe("task-125：D-1907 rev7 红线断言组（mock 车道，现在应为红/部分红）", () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

    test("红线 2：chat-page-has-no-workspace-nav —— 会话页没有工作区级导航，容器页签行仍在", async ({
        page,
    }) => {
        await boot(page);
        const reading = await readChatChrome(page);
        persist("redline-2-chat-chrome", reading);
        console.log("[task125] 红线 2 读数 " + JSON.stringify(reading));

        // 3–5 条补充断言（与 task-118 的 mock spec 不重复：那条只数 workspace-nav-*，
        // 这里把「首带是谁、行高多少、状态栏还在不在」一起钉住，避免「整条顶带被删光」也算绿）。
        expect(reading.navFamilyCount, "会话页不得出现任何 workspace-nav-* 条目").toBe(0);
        expect(reading.navIds, "workspace-nav-* 的实际 testid 列表应为空").toEqual([]);
        expect(reading.secondaryNavPresent, "会话页不得渲染 workspace-secondary-nav").toBe(false);
        expect(reading.firstBandKey, "y=2 处的首带应是容器页签行（而不是空/其它带）").toBe(
            "workspace-container-tabs",
        );
        expect(reading.mainRowTop, "容器页签行必须贴顶（y=0）").toBe(0);
        expect(reading.mainRowHeight, "容器页签行高仍是 8 档 = 32px").toBe(32);
        expect(reading.statusBarPresent, "状态栏（D-1527 面包屑宿主）不得随导航带一起消失").toBe(
            true,
        );
    });

    test("红线 5：container-label-not-visible —— 容器名标签 offsetWidth=0 且行高仍 32px", async ({
        page,
    }) => {
        await boot(page);
        await openRightContainer(page);
        const gate = await waitForSettledLayout(page);
        const reading = await page.evaluate(() => {
            const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
            const rows = ["main", "right"].map((container) => {
                const rowEl = q(
                    '[data-testid="workspace-container-tabs"][data-container="' + container + '"]',
                );
                const label = rowEl
                    ? rowEl.querySelector<HTMLElement>('[data-testid="workspace-container-label"]')
                    : null;
                const rowRect = rowEl ? rowEl.getBoundingClientRect() : null;
                return {
                    container,
                    rowPresent: rowEl !== null,
                    rowHeight: rowRect ? Math.round(rowRect.height) : null,
                    labelPresent: label !== null,
                    labelOffsetWidth: label ? label.offsetWidth : null,
                    labelRectWidth: label
                        ? Number(label.getBoundingClientRect().width.toFixed(2))
                        : null,
                    labelPosition: label ? getComputedStyle(label).position : null,
                };
            });
            return { rows };
        });
        persist("redline-5-container-label", { gate, ...reading });
        console.log("[task125] 红线 5 读数 " + JSON.stringify({ gate, ...reading }));

        for (const item of reading.rows) {
            expect(item.rowPresent, item.container + " 容器的页签行应可见").toBe(true);
            expect(item.rowHeight, item.container + " 容器行高仍是 32px（task-100 回归锁）").toBe(
                32,
            );
            // 单 tab 且与容器名同名时标签节点按契约可以不存在（singleTabRedundant）—— 那也算不可见。
            if (item.labelPresent) {
                expect(
                    item.labelOffsetWidth,
                    item.container + " 容器名标签必须视觉隐藏（offsetWidth === 0）",
                ).toBe(0);
            }
        }
    });

    test("红线 3：containers-are-symmetric —— 两容器「+」列出同一组件集合", async ({ page }) => {
        await boot(page);
        await openRightContainer(page);
        await waitForSettledLayout(page);
        const mainProbe = await probePicker(page, "main");
        // 主栏「+」今天会离开会话页（?newChat=1）⇒ 回到会话页再探右栏，否则右栏行根本不在。
        if (!page.url().includes("/chat/")) await page.goto(CHAT_PATH);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await openRightContainer(page);
        const rightProbe = await probePicker(page, "right");
        persist("redline-3-symmetry", { main: mainProbe, right: rightProbe });
        console.log(
            "[task125] 红线 3 读数 " +
                JSON.stringify({
                    main: { pickerFound: mainProbe.pickerFound, options: mainProbe.optionLabels },
                    right: {
                        pickerFound: rightProbe.pickerFound,
                        options: rightProbe.optionLabels,
                    },
                }),
        );

        // 先证明选择器存在：否则「集合相等」会在两个空集合上真空成立（0 === 0）。
        expect(mainProbe.plusPresent, "主栏页签行应有「+」").toBe(true);
        expect(rightProbe.plusPresent, "右栏页签行应有「+」").toBe(true);
        expect(
            mainProbe.pickerFound,
            "主栏「+」应打开组件选择器（今天直接 ?newChat=1 新建会话；候选浮层=" +
                JSON.stringify(mainProbe.candidates) +
                "）",
        ).toBe(true);
        expect(
            rightProbe.pickerFound,
            "右栏「+」应打开组件选择器（今天是 dock-reopen-menu 重开菜单；候选浮层=" +
                JSON.stringify(rightProbe.candidates) +
                "）",
        ).toBe(true);
        expect(mainProbe.optionCount, "主栏选择器不得是空列表").toBeGreaterThan(0);
        expect(rightProbe.optionCount, "右栏选择器不得是空列表").toBeGreaterThan(0);
        // 集合相等，不比顺序（D-1907 rev7：两容器对等，无容器专属白名单）。
        expect(
            [...new Set(rightProbe.optionLabels)].sort(),
            "两容器「+」列出的组件集合必须相等",
        ).toEqual([...new Set(mainProbe.optionLabels)].sort());
    });

    test("红线 1 + G-12：workspace-config-absent-from-containers —— 「+」里没有工作区配置类项", async ({
        page,
    }) => {
        await boot(page);
        await openRightContainer(page);
        await waitForSettledLayout(page);
        const mainProbe = await probePicker(page, "main");
        if (!page.url().includes("/chat/")) await page.goto(CHAT_PATH);
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await openRightContainer(page);
        const rightProbe = await probePicker(page, "right");
        persist("redline-1-config-absent", { main: mainProbe, right: rightProbe });
        console.log(
            "[task125] 红线 1 读数 " +
                JSON.stringify({
                    main: { pickerFound: mainProbe.pickerFound, options: mainProbe.optionLabels },
                    right: {
                        pickerFound: rightProbe.pickerFound,
                        options: rightProbe.optionLabels,
                    },
                }),
        );

        // rev8 口径把两类东西分开了：**会话配置/设置 = 容器组件**（合法，G-11 要求它能进「+」）；
        // **工作区配置/设置 = 工作区页面**（不是组件，绝不能出现在容器选择器里）。
        // ⇒ 不能一刀切拦 /配置|设置/：右栏那项「会话设置」（dock-reopen-item-context）是合法组件，
        // 拦它会把这条红线误判成红，反过来也掩盖了真正的问题。只拦「工作区级」字样。
        const WORKSPACE_WORD = /工作区|workspace/i;
        const CONFIG_WORD = /配置|设置|configure|config|settings/i;
        const looksLikeWorkspaceConfig = (text: string) =>
            WORKSPACE_WORD.test(text) && CONFIG_WORD.test(text);
        /** 选择器条目的 testid 前缀（主栏 `workspace-add-item-*`、右栏重开菜单 `dock-reopen-item-*`）。 */
        const PICKER_ITEM_PREFIX = /^(?:workspace-add-item|dock-reopen-item)-/;
        for (const probe of [mainProbe, rightProbe]) {
            const tag = probe.container === "main" ? "主栏" : "右栏";
            expect(
                probe.pickerFound,
                tag + "「+」应打开组件选择器（否则「没有配置项」会真空绿）",
            ).toBe(true);
            expect(probe.optionCount, tag + "选择器不得是空列表").toBeGreaterThan(0);
            expect(
                probe.optionLabels.filter(looksLikeWorkspaceConfig),
                tag + "选择器不得出现工作区配置/设置类选项（G-12）",
            ).toEqual([]);
            // testid 侧不能直接套文本正则：产品前缀 `workspace-` 自带 "workspace"，组件名
            // `session-config` 自带 "config"，两项一拼就把合法的「会话配置」条目恒判成工作区配置项
            // （HEAD 版本单跑同样红 —— task-150 用 `git show HEAD:` 副本复现过，与布局种子无关）。
            // ⇒ 先剥掉产品前缀，只判**条目身份**；条目键里真的写了「工作区 + 配置」仍然红。
            expect(
                probe.optionTestids.filter((testid) =>
                    looksLikeWorkspaceConfig(testid.replace(PICKER_ITEM_PREFIX, "")),
                ),
                tag + "选择器不得出现工作区配置类 testid",
            ).toEqual([]);
        }
    });

    test("G-11：+ 选择器含「会话配置」组件，且两会话各开一份不串台", async ({ page }) => {
        await boot(page);
        await waitForSettledLayout(page);
        const mainProbe = await probePicker(page, "main");
        persist("g11-session-config-picker", { main: mainProbe });
        console.log("[task125] G-11 读数 " + JSON.stringify({ main: mainProbe }));

        expect(
            mainProbe.pickerFound,
            "主栏「+」应打开组件选择器（候选浮层=" + JSON.stringify(mainProbe.candidates) + "）",
        ).toBe(true);
        // 措辞按产品现状放宽：面板标题叫「会话设置」（`DOCK_TAB_LABEL_KEYS.context`），
        // rev8 写的是「会话配置」——同一个东西，两种叫法都认；具体用哪个词由产品定，
        // 这里只钉「会话级配置是个可开的组件项」。
        const sessionConfigOption = mainProbe.optionLabels.filter((label) =>
            /会话(配置|设置)/.test(label),
        );
        expect(
            sessionConfigOption.length,
            "「+」选择器应含「会话配置」组件项（全部选项=" +
                JSON.stringify(mainProbe.optionLabels) +
                "）",
        ).toBeGreaterThan(0);
        /*
         * 第二段（task-138，Lead 2026-11-20 裁定 Q3 选 (a)）：`session-config` 是**容器页签**，
         * 读的是**右栏**行而不是主栏。旧版本读主栏 `[data-container="main"] [data-tab-id]` 并期望
         * 两个 session id 同时出现 —— 那测的是「同一时刻两个会话路由页签」= task-69 三元组接线，
         * 不是本卡的 `session-config`（当时恒红：`perSession=[["…d1907-a"],[]]`）。
         *
         * 本段自己种布局：把两份 `pane:right:session-config:<sid>` 直接写进 `dockTabs` 再 reload，
         * 断言「两份都在、各一份、主栏不串台」，然后点掉一份、reload 复核「关掉不残留」。
         * 页签 id 契约 = `pane:<container>:<view>[:<sid>]`（`lib/panelTabs.ts`）。
         */
        const paneTabs = SESSIONS.map((sid) => "pane:right:session-config:" + sid);
        await page.addInitScript(
            ({ key, tabs }: { key: string; tabs: string[] }) => {
                const raw = localStorage.getItem(key);
                const layout = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
                localStorage.setItem(
                    key,
                    JSON.stringify({
                        ...layout,
                        dockCollapsed: false,
                        dockTabs: tabs,
                        activeDockTab: tabs[tabs.length - 1],
                        activeDockTabs: { main: null, right: tabs[tabs.length - 1] },
                    }),
                );
            },
            { key: LAYOUT_KEY, tabs: paneTabs },
        );
        await page.reload();
        await expect(row(page, "right")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await waitForSettledLayout(page);
        const opened = await page.evaluate(() => {
            const read = (container: "main" | "right") =>
                Array.from(
                    document.querySelectorAll(
                        '[data-testid="workspace-container-tabs"][data-container="' +
                            container +
                            '"] [data-tab-id]',
                    ),
                ).map((el) => el.getAttribute("data-tab-id") ?? "");
            return { rightTabs: read("right"), mainTabs: read("main") };
        });
        const perSession = SESSIONS.map((sid) => opened.rightTabs.filter((id) => id.includes(sid)));
        persist("g11-session-config-tabs", { ...opened, perSession, dockTabIds: paneTabs });
        console.log("[task125] G-11 第二段读数 " + JSON.stringify({ ...opened, perSession }));
        for (const [index, hits] of perSession.entries()) {
            expect(
                hits.length,
                "会话 " +
                    SESSIONS[index] +
                    " 应在右栏各有**恰好一份**会话配置页签（实测=" +
                    JSON.stringify(opened.rightTabs) +
                    "）",
            ).toBe(1);
        }
        // 不串台：两份都在**右栏**；主栏行不得出现 session-config 页签。
        expect(opened.rightTabs.length, "右栏应同时挂两份会话配置页签").toBe(SESSIONS.length);
        expect(
            opened.mainTabs.filter((id) => id.includes("session-config")),
            "会话配置页签不得跑进主栏（实测主栏=" + JSON.stringify(opened.mainTabs) + "）",
        ).toEqual([]);
        // 关掉第一份 ⇒ 落盘与 reload 后都不残留。
        // 先点活它：右栏行只在**当前页签**上渲染关闭按钮（closeActiveOnly），直接点关闭会超时。
        await page.getByTestId("dock-tab-" + paneTabs[0]).click({ timeout: ACTION_TIMEOUT_MS });
        await page.getByTestId("dock-tab-close-" + paneTabs[0]).click({
            timeout: ACTION_TIMEOUT_MS,
        });
        const storedTabs = async (): Promise<string[]> =>
            page.evaluate((key: string) => {
                const raw = localStorage.getItem(key);
                const parsed = raw ? (JSON.parse(raw) as { dockTabs?: unknown }) : {};
                return Array.isArray(parsed.dockTabs) ? (parsed.dockTabs as string[]) : [];
            }, LAYOUT_KEY);
        // 落盘是异步的（布局 writer 会攒批）⇒ 不能点完立刻读，必须轮询到收敛。
        await expect
            .poll(storedTabs, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "关掉的会话配置页签不得留在布局里",
            })
            .not.toContain(paneTabs[0]);
        const afterClose = await storedTabs();
        // 行内也要立刻少一份（DOM 与落盘同口径）。
        const remainingTabs = await page.evaluate(() =>
            Array.from(
                document.querySelectorAll(
                    '[data-testid="workspace-container-tabs"][data-container="right"] [data-tab-id]',
                ),
            ).map((el) => el.getAttribute("data-tab-id") ?? ""),
        );
        persist("g11-session-config-after-close", { afterClose, remainingTabs });
        console.log("[task125] G-11 关掉后读数 " + JSON.stringify({ afterClose, remainingTabs }));
        expect(
            remainingTabs,
            "关掉后右栏应只剩第二份会话配置（实测=" + JSON.stringify(remainingTabs) + "）",
        ).toEqual([paneTabs[1]]);
        /*
         * 注：「刷新后仍在」**不**在本段做 —— 本文件 `boot()` 的 init script 每次导航都会把固定布局
         * 重写一遍（隔离用），reload 后看到的不是产品落盘值，而是种子里那两份。刷新往返由单测守：
         * `useWorkspaceLayout.spec.ts` 的 "keeps a pane tab active after a reload"。
         */
    });

    /*
     * G-11b（task-150，Lead 裁定 B：主栏会话页签保持 `session:<sid>`，**不**扩 `pane:` 值域）：
     * 三条可执行判据 —— ①访问过的会话各留一份页签（并存）②点页签切换不串台（url/高亮各自对得上）
     * ③关掉的那份在**真 reload** 后不复活。
     *
     * 为什么必须 `persistentSeed`：默认种子每次导航重写固定布局，pin 的累积与「关掉后仍在」都会
     * 被它抹掉（旧 G-11 主栏断言恒红就是这个夹具缺陷，不是产品缺口）。本次证法 = 「种子只在首次
     * 导航生效」（`<layout-key>:seeded` 标记），后续导航读的都是产品落盘值 ⇒ 第三段是真 reload，
     * 不是「只等落盘再读一次 store」。
     *
     * id 域：主栏会话页签 = `session:<sid>`（`useWorkspaceLayout.ts` 的 `WORK_TAB_ID_PREFIX`）。
     * 容器归属由 `containerOf` 反推（非 `DOCK_TAB_IDS` ⇒ main），容器信息本来就不丢，
     * 所以这里不需要（也不该有）`pane:main:*` 拼法。
     */
    test("G-11b：主栏 route 页签按会话 pin —— 两会话并存、切换不串台、关掉不复活", async ({
        page,
    }) => {
        const tabIdOf = (sid: string): string => "session:" + sid;
        const readMainRow = async (): Promise<{ ids: string[]; active: string[] }> =>
            page.evaluate(() => {
                const tabs = Array.from(
                    document.querySelectorAll(
                        '[data-testid="workspace-container-tabs"][data-container="main"] [data-tab-id]',
                    ),
                );
                return {
                    ids: tabs.map((el) => el.getAttribute("data-tab-id") ?? ""),
                    active: tabs
                        .filter((el) => el.getAttribute("aria-selected") === "true")
                        .map((el) => el.getAttribute("data-tab-id") ?? ""),
                };
            });
        const readStored = async (): Promise<string[]> =>
            page.evaluate((key: string) => {
                const raw = localStorage.getItem(key);
                const parsed = raw ? (JSON.parse(raw) as { openTabs?: unknown }) : {};
                return Array.isArray(parsed.openTabs) ? (parsed.openTabs as string[]) : [];
            }, LAYOUT_KEY);
        const gotoChat = async (sid: string): Promise<void> => {
            await page.goto("/workspace/" + WORKSPACE_ID + "/chat/" + sid);
            await page.locator('[data-testid="workspace-main"]').waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });
            await waitForSettledLayout(page);
        };

        // ① 首屏会话已 pin；再深链第二个会话 ⇒ 两份并存（pin 是 append，不是「只留当前」）。
        await boot(page, { persistentSeed: true });
        await waitForSettledLayout(page);
        const first = { row: await readMainRow(), stored: await readStored() };
        expect(first.row.ids, "首屏会话应已 pin 成一份主栏页签").toEqual([tabIdOf(SESSIONS[0])]);
        expect(first.row.active, "首屏页签应是高亮项").toEqual([tabIdOf(SESSIONS[0])]);

        await gotoChat(SESSIONS[1]);
        const second = { row: await readMainRow(), stored: await readStored() };
        expect(second.row.ids, "访问第二个会话后主栏应同时挂两份页签").toEqual([
            tabIdOf(SESSIONS[0]),
            tabIdOf(SESSIONS[1]),
        ]);
        expect(second.row.active, "高亮跟着路由走（当前 = 第二个会话）").toEqual([
            tabIdOf(SESSIONS[1]),
        ]);
        expect(second.stored, "两份页签都要落盘（关掉不复活依赖它）").toEqual([
            tabIdOf(SESSIONS[0]),
            tabIdOf(SESSIONS[1]),
        ]);

        // ② 点页签切换：url 与高亮各自对得上，两份都不丢（不串台）。
        await page
            .getByTestId("workspace-container-tab-main-" + tabIdOf(SESSIONS[0]))
            .click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForURL(new RegExp("/chat/" + SESSIONS[0] + "$"), {
            timeout: EXPECT_TIMEOUT_MS,
        });
        const switched = { row: await readMainRow(), stored: await readStored() };
        expect(switched.row.active, "点第一份后高亮应回到第一个会话").toEqual([
            tabIdOf(SESSIONS[0]),
        ]);
        expect(switched.stored, "切换不得丢页签").toEqual([
            tabIdOf(SESSIONS[0]),
            tabIdOf(SESSIONS[1]),
        ]);

        await page
            .getByTestId("workspace-container-tab-main-" + tabIdOf(SESSIONS[1]))
            .click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForURL(new RegExp("/chat/" + SESSIONS[1] + "$"), {
            timeout: EXPECT_TIMEOUT_MS,
        });

        // ③ 关掉**非当前**那份 ⇒ 立刻少一份，且 reload 后不复活（单一 writer：只写 openTabs 分片）。
        await page
            .getByTestId("workspace-container-tab-close-main-" + tabIdOf(SESSIONS[0]))
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect
            .poll(readStored, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "关掉的主栏页签不得留在布局里",
            })
            .toEqual([tabIdOf(SESSIONS[1])]);
        // 行内少一份是布局写入驱动的异步效果：读一次可能撞在重渲染中间态，用精确值轮询收敛。
        await expect
            .poll(async () => (await readMainRow()).ids, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "关掉后主栏行内应只剩第二份",
            })
            .toEqual([tabIdOf(SESSIONS[1])]);
        const afterClose = { row: await readMainRow(), stored: await readStored() };

        // 真 reload：种子已经种过（persistentSeed），这里读到的是产品落盘值。
        await page.reload();
        await page.locator('[data-testid="workspace-main"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await waitForSettledLayout(page);
        // 布局恢复（读 localStorage → 挂载页签）也在渲染之后才稳定，同样用精确值轮询收口。
        await expect
            .poll(async () => (await readMainRow()).ids, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "reload 后主栏行内不得复活已关掉的页签",
            })
            .toEqual([tabIdOf(SESSIONS[1])]);
        const afterReload = { row: await readMainRow(), stored: await readStored() };

        persist("g11b-main-pin", { first, second, switched, afterClose, afterReload });
        console.log(
            "[task125] G-11b 读数 " +
                JSON.stringify({
                    first,
                    second,
                    switched,
                    afterClose,
                    afterReload,
                }),
        );

        expect(afterClose.row.ids, "关掉后行内应只剩第二份").toEqual([tabIdOf(SESSIONS[1])]);
        expect(afterReload.row.ids, "reload 后不得复活已关掉的页签").toEqual([
            tabIdOf(SESSIONS[1]),
        ]);
        expect(afterReload.row.active, "reload 后高亮仍是第二个会话").toEqual([
            tabIdOf(SESSIONS[1]),
        ]);
        expect(afterReload.stored, "落盘也不得把关掉的页签写回来").toEqual([tabIdOf(SESSIONS[1])]);
    });

    test("红线 4：workspace-config-reachable-from-workspace-page —— 配置/成员页可达且页内无右容器", async ({
        page,
    }) => {
        await boot(page);
        await page.goto("/workspace/" + WORKSPACE_ID);
        await expect(page.getByTestId("workspace-secondary-nav")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        const nav = page.getByTestId("workspace-nav-settings");
        await expect(nav).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await nav.click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForURL(/\/settings/, { timeout: EXPECT_TIMEOUT_MS });
        const gate = await waitForSettledLayout(page);
        const settingsReading = await page.evaluate(() => ({
            url: location.pathname + location.search,
            rightContainers: document.querySelectorAll('[data-container="right"]').length,
            mainContainers: document.querySelectorAll('[data-container="main"]').length,
            containerRows: document.querySelectorAll('[data-testid="workspace-container-tabs"]')
                .length,
        }));
        persist("redline-4-settings-page", { gate, ...settingsReading });
        console.log("[task125] 红线 4 设置页读数 " + JSON.stringify({ gate, ...settingsReading }));
        expect(settingsReading.url, "工作区配置页应是 /settings?tab=config").toContain(
            "/workspace/" + WORKSPACE_ID + "/settings",
        );
        expect(settingsReading.rightContainers, "配置页里不得出现会话右容器").toBe(0);

        await page.goto("/workspace/" + WORKSPACE_ID);
        const members = page.getByTestId("workspace-nav-members");
        await expect(members).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await members.click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForURL(/\/members/, { timeout: EXPECT_TIMEOUT_MS });
        const membersReading = await page.evaluate(() => ({
            url: location.pathname + location.search,
            rightContainers: document.querySelectorAll('[data-container="right"]').length,
        }));
        persist("redline-4-members-page", membersReading);
        console.log("[task125] 红线 4 成员页读数 " + JSON.stringify(membersReading));
        expect(membersReading.url, "成员页仍是 /workspace/:id/members").toContain("/members");
        expect(membersReading.rightContainers, "成员页里不得出现会话右容器").toBe(0);
    });
});
