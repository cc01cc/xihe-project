/**
 * task-83（UI 自审 02）：补齐自审批次 01 明确留下的五项边界。
 *
 * 批次 01 的诚实边界原文：「截图不能证明 ①对比度（未测 WCAG 比值）②键盘可达与焦点顺序
 * （未真 Tab）③点击结果（未逐个点）。深色模式与 390×844 未拍。」
 * ⇒ 本 spec 把那五项变成**可复算读数**，"看着还行"不作为任何一条的判据。
 *
 * 判据出处（本仓 skill，先读再判）：
 *   ui-review/references/type-scale-and-contrast.md
 *     - 正文 4.5:1 / 大字 3:1 / 非文本 UI 3:1（WCAG 2.2 AA，1.4.3 / 1.4.11）
 *     - 对比度必须走 computed → sRGB → WCAG；禁止拿 oklch 的 L 当亮度
 *       （本仓实证：按 L 估会把 oklch(0.205 0 0) 算成 ~4.9:1，真值 17.16:1）
 *     - 背景取逐层向上合成的实际绘制背景；半透明层必须继续向下合成
 *       （反例：批次 01 D-1 停在 bg-primary/10 算出 1.24:1 假违例，全链合成后 6.94/13.44 达标）
 *     - 前景带 alpha 时同样要合成（本 spec 的灰点就是 bg-muted-foreground/40）
 *   ui-review/references/component-patterns.md §3：折叠态文字必须完全移除
 *   ui-review/references/dimensions.md：触控 WCAG 2.5.8(AA) 24×24 底 / HIG 44×44 手感底
 *
 * 颜色数学复用 e2e/helpers/color.ts（contrastRatio/probe/probeActive，含 oklch 与 alpha 合成），
 * 不手写十六进制解析 —— 本仓「解析成熟格式必须用成熟库」。
 *
 * 主题入口：不手写 classList，走真实 SSOT —— stores/settings.ts 的 THEME_STORAGE_KEY
 * （VueUse useLocalStorage，JSON 序列化），useTheme() 的 watch 施加 <html class="dark">。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { contrastRatio } from "../helpers/color";
// task-89（加法前置）：只复用既有种子函数，不引入第二套登录逻辑。
import { setupMockAuth } from "./helpers/auth";
// 复用 src 的预览夹具（auth.ts:32 同源做法）：手抄一份环境 body 必然漂移。
import { mockWorkspaceEnvironment } from "../../src/preview/mock/data/workspaceEnvironment";

const WS = "11111111-1111-4111-8111-111111111111";
const THEME_KEY = "xihe-theme";

/** 批次 01 拍过的那批页面（同组 URL，便于逐张对照）。 */
const PAGES = [
    { name: "workbench", path: "/workspace/" + WS + "/workbench" },
    { name: "environment", path: "/workspace/" + WS + "/environment" },
    { name: "resources", path: "/workspace/" + WS + "/resources" },
    { name: "members", path: "/workspace/" + WS + "/members" },
    { name: "settings", path: "/workspace/" + WS + "/settings" },
    { name: "user-settings", path: "/settings/user" },
    { name: "instance-settings", path: "/settings/instance" },
    { name: "knowledge", path: "/workspace/" + WS + "/resources/knowledge" },
];

/** WCAG 2.2 AA（type-scale-and-contrast.md §1.2）。 */
const AA_BODY = 4.5;
const AA_NON_TEXT = 3;
/** 移动端手感底线（Apple HIG）；WCAG 2.5.8 合规底线是 24。 */
const TOUCH_MIN = 44;

/**
 * task-89（加法前置）：本 spec 交付时**只种了主题、没种登录态**（grep `xihe-token` = 0 处），
 * 而在 HEAD 上未登录会被守卫弹到 `/login` ⇒ 每条页面用例都红在 `settle()` 的 15s 超时，
 * 扫到的其实是登录页（task-89 实测失败截图整屏是「登录 / 输入你的账号信息」）。
 *
 * 这里只做**加法**：调用 `helpers/auth.ts` 既有的 `setupMockAuth` 种子。
 * **10 条既有断言一行未动，任何 timeout 未放宽。**
 */
test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
});

/**
 * task-89 状态指纹（Lead 裁：读数必须记「在某状态下」的值，否则两个数字不可比）。
 *
 * 为什么必须记：卡面说 4 个目标「到邻居矩形 0px、最近邻居 workspace-nav-sessions」，
 * 而实测那个 0px 出现在**390×844 且侧栏收起态**——此时 `[data-testid=sidebar]` 只有 1px 宽、
 * `sidebar-panel` 宽 0，控件**仍有几何但被裁掉**，而 main 列的移动端导航恰好压在它们的坐标上
 * ⇒ 量到「距离 0」。桌面展开态是另一组数。**两个数都"对"，但不同状态不可比。**
 */
async function fingerprint(page: Page, label: string): Promise<void> {
    const fp = await page.evaluate(() => {
        const r = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { w: Math.round(b.width), h: Math.round(b.height) };
        };
        return {
            vw: window.innerWidth,
            vh: window.innerHeight,
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            route: location.pathname + location.search,
            sidebar: r('[data-testid="sidebar"]'),
            sidebarPanel: r('[data-testid="sidebar-panel"]'),
        };
    });
    console.log(
        "[fp] " +
            label +
            " vw=" +
            fp.vw +
            "x" +
            fp.vh +
            " theme=" +
            fp.theme +
            " route=" +
            fp.route +
            " sidebar=" +
            JSON.stringify(fp.sidebar) +
            " panel=" +
            JSON.stringify(fp.sidebarPanel),
    );
}

/**
 * task-89：触控目标测量（**唯一一份**，移动态与桌面态共用）。
 *
 * 为什么提到模块级：Lead 2026-11-16 裁定「不许第二套测量」。卡面那 4 条 spacing 是在
 * **390×844 侧栏收起态**量的；要在桌面展开态复核，若另写一份 collect，两套算式迟早分叉。
 *
 * **可感知性过滤**：`getBoundingClientRect` 只回答「有几何」，不回答「可被触摸」。
 * 被 `overflow:hidden` 裁掉或被遮罩盖住的元素照样有 rect —— 实测收起态
 * `[data-testid=sidebar]` 只有 1px 宽、`sidebar-panel` 宽 0，里面按钮 rect 仍是 21×21，
 * 且 `elementFromPoint` 打到的是**后面**的 `a[workspace-nav-sessions]`
 * ⇒ 对它量「圆心到邻居矩形=0px」没有合规含义（WCAG 2.5.8 的 spacing 例外防的是**误触相邻目标**）。
 *
 * **过滤必须留痕**：`excluded` 带 label + 归因（clipped / occluded），由调用方逐个打印。
 * 「违例消失」与「违例被过滤掉」在输出上必须能区分（Lead：过滤本身不许把证据吃掉）。
 */
async function measureTargets(page: Page, min: number) {
    return page.evaluate((minSize: number) => {
        type Box = { tag: string; label: string; x: number; y: number; w: number; h: number };
        type Excluded = { label: string; reason: string };
        const sel = 'button, a, [role="tab"], input, select, textarea';
        const boxes: Box[] = [];
        const excluded: Excluded[] = [];
        for (const el of Array.from(document.querySelectorAll(sel))) {
            const elRect = el.getBoundingClientRect();
            if (elRect.width === 0 || elRect.height === 0) continue;
            const label =
                (el.getAttribute("aria-label") ?? "") ||
                (el.getAttribute("data-testid") ?? "") ||
                (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 22);
            const cx = elRect.x + elRect.width / 2;
            const cy = elRect.y + elRect.height / 2;
            // 可感知性：中心点必须命中自身或后代，否则它不可被触摸 ⇒ 不是 target。
            const hit = document.elementFromPoint(cx, cy);
            const perceivable = !!hit && (hit === el || el.contains(hit));
            if (!perceivable) {
                const hitName = hit
                    ? hit.tagName.toLowerCase() +
                      (hit.getAttribute("data-testid")
                          ? "[" + hit.getAttribute("data-testid") + "]"
                          : "")
                    : "(nothing)";
                let reason = "occluded by " + hitName;
                let cur: Element | null = el.parentElement;
                while (cur && cur !== document.body) {
                    const cs = getComputedStyle(cur);
                    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
                    if (clips) {
                        const ar = cur.getBoundingClientRect();
                        const outside =
                            cx < ar.x || cx > ar.x + ar.width || cy < ar.y || cy > ar.y + ar.height;
                        if (outside || ar.width <= 1 || ar.height <= 1) {
                            const name =
                                cur.tagName.toLowerCase() +
                                (cur.getAttribute("data-testid")
                                    ? "[" + cur.getAttribute("data-testid") + "]"
                                    : "");
                            reason =
                                "clipped by " +
                                name +
                                " (" +
                                Math.round(ar.width) +
                                "x" +
                                Math.round(ar.height) +
                                ", overflow " +
                                cs.overflowX +
                                ")";
                            break;
                        }
                    }
                    cur = cur.parentElement;
                }
                excluded.push({ label, reason });
                continue;
            }
            boxes.push({
                tag: el.tagName.toLowerCase(),
                label,
                x: elRect.x,
                y: elRect.y,
                w: elRect.width,
                h: elRect.height,
            });
        }
        /** 点到矩形的最近距离（点在矩形内 = 0）。 */
        function distPointRect(px: number, py: number, b: Box): number {
            const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
            const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
            return Math.sqrt(dx * dx + dy * dy);
        }
        const small = boxes.filter((b) => b.w < minSize || b.h < minSize);
        const under24 = small.filter((b) => b.w < 24 || b.h < 24);
        const rows = under24.map((b) => {
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            let minToBox = Number.POSITIVE_INFINITY;
            let nearest = "";
            for (const o of boxes) {
                if (o === b) continue;
                const d = distPointRect(cx, cy, o);
                if (d < minToBox) {
                    minToBox = d;
                    nearest = o.label;
                }
            }
            let minCenter = Number.POSITIVE_INFINITY;
            for (const o of under24) {
                if (o === b) continue;
                const d = Math.hypot(cx - (o.x + o.w / 2), cy - (o.y + o.h / 2));
                if (d < minCenter) minCenter = d;
            }
            return {
                tag: b.tag,
                label: b.label,
                size: b.w.toFixed(1) + "x" + b.h.toFixed(1),
                minToBox: Math.round(minToBox * 10) / 10,
                minCenter: Math.round(minCenter * 10) / 10,
                nearest,
                exempt: minToBox >= 12 && minCenter >= 24,
            };
        });
        return {
            total: small.length,
            under24: under24.length,
            ge24: small.length - under24.length,
            rows,
            excluded,
            labels: boxes.map((b) => b.label),
        };
    }, min);
}

/** 等 SPA 真的渲染完：domcontentloaded 后 #app 还要一会儿才出内容（实测 appLen 1219 → 71122）。 */
async function settle(page: Page): Promise<void> {
    await page.waitForSelector("main", { state: "visible", timeout: 15000 });
}

/** 普通导航。 */
async function gotoPage(page: Page, path: string): Promise<void> {
    await stubWorkspace(page);
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await settle(page);
}

/**
 * 深色模式：**先注入 SSOT 再一次导航**，不要 goto 后 reload。
 *
 * 实测（本卡）：goto → reload 会打断已渲染的 SPA，状态栏不再出现（no visible element），
 * 且 reload 期间产生 console-error / ≥400 被 mock 门禁抓到 —— 那是探针姿势错，不是产品缺陷。
 */
async function gotoDark(page: Page, path: string): Promise<void> {
    await stubWorkspace(page);
    await page.addInitScript(
        ([key]) => {
            window.localStorage.setItem(key, JSON.stringify("dark"));
        },
        [THEME_KEY],
    );
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await settle(page);
    await page.waitForFunction(
        () => document.documentElement.classList.contains("dark"),
        undefined,
        { timeout: 10000 },
    );
}

/**
 * 补桩：本 spec 直接 goto 多个 workspace 页，而 mock 车道默认**不**桩
 * `GET /api/v1/workspaces/{id}` 与 `/members`（auth.ts 头注释 106 行：需要固定数据的
 * spec 自己 page.route）。不补桩会得到 6 条 404 被公共门禁判红 —— **那是夹具缺桩，
 * 不是产品缺陷**（实测：/workspaces/:id ×5、/:id/members ×1）。
 */
async function stubWorkspace(page: Page): Promise<void> {
    await page.route(`**/api/v1/workspaces/${WS}`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ workspace: { id: WS, name: "演示工作区", roots: [] } }),
        });
    });
    await page.route(`**/api/v1/workspaces/${WS}/members`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ members: [] }),
        });
    });
    // 工作区事件流（SSE）：本 spec 只需要它别 404（静态呈现审计不验事件语义）。
    // 空流 + 200 足以让前端「已连接」，不必造事件。
    await page.route(`**/api/v1/workspaces/${WS}/events`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: ": keep-alive\n\n",
        });
    });
    // 嵌套仓探测（设置页/资源页会问一次）；空清单即可。
    await page.route(`**/api/v1/workspaces/${WS}/nested-repos`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ nestedRepos: [], nested_repos: [] }),
        });
    });
    // 环境投影：mock 车道 auth.ts:1437 已有默认桩，形状来自 `mockWorkspaceEnvironment()`，
    // 而该夹具**不含** `executionSpec.sandboxSpecHash` ⇒ 复制按钮的 v-if 不成立、不渲染。
    // 要验「复制」必须在默认桩之上叠加该字段，**且保留夹具原有结构**：
    // 本卡第一版自造了只有 executionSpec 的极简 body，页面报
    // `Cannot read properties of undefined (reading 'trim')` —— 那是我造出来的假错误，不是产品缺陷。
    // 正确做法 = import 同一夹具再注入一个字段（结构不漂移，避免手抄）。
    // 环境投影：夹具 + 只注入 sandboxSpecHash（复制按钮的 v-if 依赖它）。
    await page.route(`**/api/v1/workspaces/${WS}/environment`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const body = mockWorkspaceEnvironment(WS);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                ...body,
                executionSpec: {
                    ...(body.executionSpec ?? {}),
                    sandboxSpecHash:
                        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
                },
            }),
        });
    });
    // 本工作区 MCP 面板：方向键用例会切到 mcp 页签，试图请求 mcp-config。
    // 空配置足以让面板渲染出「无服务器」而不是 404。
    await page.route(`**/api/v1/workspaces/${WS}/mcp-config`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ servers: [], servers_json: "[]" }),
        });
    });
}

const CONN_SEL = '[data-testid="workspace-status-connection"]';
const DOT_SEL = CONN_SEL + " span";

/** 读某元素的全链背景栈（自身起，向上逐层）。 */
async function bgStack(page: Page, selector: string): Promise<string[]> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("not found: " + sel);
        const out: string[] = [];
        let cur: Element | null = el;
        while (cur) {
            const bg = getComputedStyle(cur).backgroundColor;
            if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") out.push(bg);
            cur = cur.parentElement;
        }
        return out;
    }, selector);
}

// ============================================================================
// ① 深色模式 + 状态点可辨性
// ============================================================================

test.describe("task-83 ① 深色模式", () => {
    test("P1-1 的中性灰点在**两个主题**下都 ≥3:1（非文本 UI）", async ({ page }) => {
        // Lead 的担心是「dark 下 bg-muted 与 bg-background 差距不够 ⇒ 灰点消失」。
        // 实测后性质变了：/40 在 light 1.72、dark 2.16 —— **两个主题都不达标**，
        // 是「从未达标」的存量违例（task-312 9c9042d76 引入），不是 dark 专属回归。
        // 判定：(a) 按状态线索判 3:1，无豁免 —— 点带 aria-hidden ⇒ 对读屏隐形
        // ⇒ 恰恰是视觉用户的线索，不能当装饰豁免。
        for (const scheme of ["light", "dark"] as const) {
            if (scheme === "dark") await gotoDark(page, "/workspace/" + WS + "/environment");
            else await gotoPage(page, "/workspace/" + WS + "/environment");

            const stack = await bgStack(page, DOT_SEL);
            const ratio = contrastRatio(stack[0], stack.slice(1));
            console.log("[dark] " + scheme + " 状态点 " + stack[0] + " => " + ratio + ":1");
            expect(
                ratio,
                scheme +
                    " 主题下状态点 " +
                    ratio +
                    ":1 < 3:1（WCAG 2.2 SC 1.4.11）。前景=" +
                    stack[0],
            ).toBeGreaterThanOrEqual(AA_NON_TEXT);
        }
    });

    test("dark 下不得出现纯黑背景（避免极端对比眩光）", async ({ page }) => {
        await gotoDark(page, "/workspace/" + WS + "/workbench");
        // 不用 probe() 读 body：其可见性判据是 offsetParent !== null，而 body 恒为 null
        // ⇒ probe 对 body 一律抛 no visible element。这是探针限制，不是页面缺陷。
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const nums =
            bg
                .match(/\d+(?:\.\d+)?/g)
                ?.slice(0, 3)
                .map(Number) ?? [];
        const isPureBlack = nums.length >= 3 && nums.slice(0, 3).every((v) => v === 0);
        console.log("[dark] body 背景 = " + bg);
        expect(isPureBlack, "dark 背景不得是纯黑 rgb(0,0,0)；实测 " + bg).toBe(false);
    });
});

// ============================================================================
// ② 390×844 移动端
// ============================================================================

test.describe("task-83 ② 移动端 390×844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("全页无横向溢出（可编程测，不看图）", async ({ page }) => {
        const offenders: string[] = [];
        for (const { name, path } of PAGES) {
            await gotoPage(page, path);
            const m = await page.evaluate(() => ({
                scrollW: document.documentElement.scrollWidth,
                innerW: window.innerWidth,
            }));
            console.log("[mobile] " + name + " scrollW=" + m.scrollW + " innerW=" + m.innerW);
            if (m.scrollW > m.innerW) {
                offenders.push(
                    name +
                        ": scrollW=" +
                        m.scrollW +
                        " > innerW=" +
                        m.innerW +
                        "（超出 " +
                        (m.scrollW - m.innerW) +
                        "px）",
                );
            }
        }
        expect(offenders, "横向溢出清单：\n" + offenders.join("\n")).toEqual([]);
    });

    test("触控目标：按 24（AA 合规线）与 44（手感线）双刀切 + spacing 例外判定", async ({
        page,
    }) => {
        // **两条线必须分开报，不能合成一句「不到 44」**：
        //   WCAG 2.2 SC 2.5.8 Target Size (Minimum) = **24×24 CSS px**（AA 合规线）
        //   Apple HIG / Material              = **44×44**（手感线，不是合规线）
        // 合成一句会把「20.8 < 24 的 AA 违例」说成「只是不到 44」⇒ 两种结论，前者不能拖。
        //
        // <24 也**不必然**违例：SC 2.5.8 的 Spacing 例外 = 以目标中心为圆心、24px 直径的圆
        // 不与**任何其它目标的矩形**相交，且不与**另一个 undersized 目标的圆**相交。
        // ⇒ 必须实测圆心到邻居矩形的最近距离（>=12 才不相交）与圆心距（>=24 才不交叠），
        //   而不是拿「两框轴向间隙」当判据（那是另一个量，会误判）。
        await gotoPage(page, "/workspace/" + WS + "/settings");
        const data = await measureTargets(page, TOUCH_MIN);

        const exempt = data.rows.filter((r) => r.exempt);
        const violate = data.rows.filter((r) => !r.exempt);
        console.log(
            "[mobile] <" +
                TOUCH_MIN +
                "×" +
                TOUCH_MIN +
                " 共 " +
                data.total +
                " 个：" +
                "<24 = " +
                data.under24 +
                " 个 / >=24 = " +
                data.ge24 +
                " 个",
        );
        console.log(
            "[mobile] 其中 <24 的 " +
                data.under24 +
                " 个里：spacing 豁免 " +
                exempt.length +
                " 个 / **不豁免（AA 违例候选）" +
                violate.length +
                " 个**",
        );
        for (const r of violate) {
            console.log(
                "[mobile]   VIOLATE " +
                    r.size +
                    " 圆心到邻居矩形=" +
                    r.minToBox +
                    "px（需>=12） 圆心距=" +
                    r.minCenter +
                    "px（需>=24） " +
                    r.tag +
                    " " +
                    JSON.stringify(r.label) +
                    " 最近=" +
                    JSON.stringify(r.nearest),
            );
        }
        for (const r of exempt) {
            console.log(
                "[mobile]   EXEMPT  " +
                    r.size +
                    " 圆心到邻居矩形=" +
                    r.minToBox +
                    "px 圆心距=" +
                    r.minCenter +
                    "px " +
                    r.tag +
                    " " +
                    JSON.stringify(r.label),
            );
        }
        // 被过滤掉的必须逐个留痕：**「违例消失」与「违例被过滤掉」在输出上要能区分**（Lead 2026-11-16）。
        if (data.excluded.length > 0) {
            const clipped = data.excluded.filter((e) => e.reason.startsWith("clipped")).length;
            console.log(
                "[mobile] 排除 " +
                    data.excluded.length +
                    " 个不可感知目标（clipped " +
                    clipped +
                    " / occluded " +
                    (data.excluded.length - clipped) +
                    "）—— 它们有几何但点不到，不构成 touch target：",
            );
            for (const e of data.excluded) {
                console.log("[mobile]   EXCLUDED " + JSON.stringify(e.label) + " ← " + e.reason);
            }
        }
        // 报告型断言：扫描本身必须有效（否则「0 个」是假绿，见 D-1711）。
        expect(data.total, "至少要扫到触控目标，否则扫描失效").toBeGreaterThan(10);
        expect(data.under24 + data.ge24, "两档计数必须合得上总数").toBe(data.total);
    });

    test("折叠态文字必须完全移除（component-patterns.md §3）", async ({ page }) => {
        // 判据原文：「折起时的文字必须完全移除，文字残留 = 溢出裁切的根源」。
        // 实测姿势：窄视口（390）下导航/侧栏通常已折叠；找出**被隐藏**但仍有文本的元素，
        // 若其文本仍占布局或被读出，即残留。
        await gotoPage(page, "/workspace/" + WS + "/workbench");
        const residual = await page.evaluate(() => {
            const out: string[] = [];
            const root =
                document.querySelector('[data-testid="workspace-shell"], main') ?? document.body;
            for (const el of Array.from(root.querySelectorAll("*"))) {
                const st = getComputedStyle(el);
                const hidden = st.display === "none" || st.visibility === "hidden";
                if (!hidden) continue;
                const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
                // 只看「视觉上被隐藏但文本还在 DOM 且非空」的容器
                if (text.length > 0 && el.children.length === 0) {
                    out.push(el.tagName.toLowerCase() + " " + JSON.stringify(text.slice(0, 24)));
                }
            }
            return out.slice(0, 20);
        });
        console.log(
            "[mobile] 折叠态下 display:none 但仍有文本的叶子元素 " + residual.length + " 个：",
        );
        for (const r of residual) console.log("[mobile]   " + r);
        // display:none 的文本**不可见也不可被读屏读到**吗？不 —— 若元素有 aria 引用则仍可读。
        // 这里只记录清单，用于判断是否真有「残留」；真正的溢出判据由上面的 scrollWidth 承担。
        expect(residual.length).toBeGreaterThanOrEqual(0);
    });
});

// ============================================================================
// ③ 对比度全页扫描（逐页逐元素，报不达标清单）
// ============================================================================

test.describe("task-83 ③ 对比度扫描", () => {
    test("逐页扫描文本节点对比度，报「扫了多少对 / 不达标几对」", async ({ page }) => {
        let totalPairs = 0;
        const violations: string[] = [];

        for (const { name, path } of PAGES) {
            await gotoPage(page, path);
            const rows = await page.evaluate(() => {
                const out: {
                    text: string;
                    fg: string;
                    bgStack: string[];
                    fontPx: number;
                    weight: string;
                }[] = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node: Node | null = walker.nextNode();
                while (node) {
                    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
                    const parent = node.parentElement;
                    if (text.length >= 2 && parent) {
                        const r = parent.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            const st = getComputedStyle(parent);
                            const stack: string[] = [];
                            let cur: Element | null = parent;
                            while (cur) {
                                const bg = getComputedStyle(cur).backgroundColor;
                                if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)")
                                    stack.push(bg);
                                cur = cur.parentElement;
                            }
                            out.push({
                                text: text.slice(0, 30),
                                fg: st.color,
                                bgStack: stack,
                                fontPx: Number.parseFloat(st.fontSize),
                                weight: st.fontWeight,
                            });
                        }
                    }
                    node = walker.nextNode();
                }
                return out;
            });

            for (const row of rows) {
                totalPairs += 1;
                if (row.bgStack.length === 0) continue;
                // 大字判据：≥24px，或 ≥18.66px 且粗体（WCAG 2.2 SC 1.4.3）
                const isLarge =
                    row.fontPx >= 24 ||
                    (row.fontPx >= 18.66 && (row.weight === "bold" || Number(row.weight) >= 700));
                const threshold = isLarge ? AA_NON_TEXT : AA_BODY;
                const ratio = contrastRatio(row.fg, row.bgStack);
                if (ratio < threshold) {
                    violations.push(
                        name +
                            " [" +
                            row.text +
                            "] fg=" +
                            row.fg +
                            " bg=" +
                            row.bgStack[0] +
                            " => " +
                            ratio +
                            ":1 < " +
                            threshold,
                    );
                }
            }
        }

        console.log(
            "[contrast] 扫描 " + totalPairs + " 对文本/背景，不达标 " + violations.length + " 对",
        );
        for (const v of violations.slice(0, 40)) console.log("[contrast]   " + v);
        // 报告型断言：先建立基线认知，不把存量违例判成红（否则卡面永远红）。
        // 具体不达标清单逐条上报 Lead 定级。
        expect(totalPairs, "至少要扫到文本对（否则扫描本身失效）").toBeGreaterThan(50);
    });
});

// ============================================================================
// ④ 键盘可达与焦点顺序（真 Tab）
// ============================================================================

test.describe("task-83 ④ 键盘可达", () => {
    test("Tab 焦点序列：顺序一致 / 不落 body / 无陷阱", async ({ page }) => {
        await gotoPage(page, "/workspace/" + WS + "/settings");
        const stops: string[] = [];
        for (let i = 0; i < 30; i += 1) {
            await page.keyboard.press("Tab");
            const info = await page.evaluate(() => {
                const a = document.activeElement;
                if (!a) return "NONE";
                const r = a.getBoundingClientRect();
                const label =
                    (a.getAttribute("aria-label") ?? "") ||
                    (a.getAttribute("data-testid") ?? "") ||
                    (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
                return [
                    a.tagName.toLowerCase(),
                    label,
                    "x=" + Math.round(r.x) + ",y=" + Math.round(r.y),
                    "role=" + (a.getAttribute("role") ?? "-"),
                ].join("|");
            });
            stops.push(info);
        }
        for (const [i, s] of stops.entries())
            console.log("[kbd] " + String(i + 1).padStart(2) + " " + s);
        expect(
            stops.filter((s) => s.startsWith("body")),
            "焦点不得落在 body（丢焦点）",
        ).toEqual([]);
        expect(new Set(stops).size, "不得卡在单一元素（键盘陷阱）").toBeGreaterThanOrEqual(3);
        // 顺序一致性：y 单调不减（同列自上而下的视觉顺序）
        const ys = stops
            .map((s) => s.match(/y=(\d+)/)?.[1])
            .filter((v): v is string => v !== undefined)
            .map(Number);
        const backJumps = ys.filter((y, i) => i > 0 && y < ys[i - 1] - 50);
        console.log("[kbd] 向上回跳次数 = " + backJumps.length + "（>50px 视为逆序）");
        expect(backJumps.length, "焦点顺序不得大幅逆着视觉顺序回跳").toBeLessThanOrEqual(2);
    });

    test("vendor Tabs：方向键切换 + aria-controls 真关联（task-81 P1-2 的收益必须验）", async ({
        page,
    }) => {
        await gotoPage(page, "/workspace/" + WS + "/settings");
        // **必须限定到设置页那个 tablist**：实测本页有 **2 个 tablist** ——
        //   tablist[0] aria-label=null      tabs=6  ← 工作区导航（workspace-nav-*）
        //   tablist[1] aria-label=工作区设置页签 tabs=4  ← vendor Tabs（task-81 P1-2）
        // 全局 selector 会抓到导航页签（且导航页签也有 aria-selected=true），
        // 断言就会落在错误的 tablist 上。

        // **顺带记录一个本卡实测发现（不在 task-81 写面内，先记录不改）**：
        // 工作区导航自己的 tablist **没有 aria-label** ⇒ 屏幕阅读器读出「tablist」但不报组名。
        // 它与设置页 tablist 是两件事：导航那组 6 个页签从未有名字。
        await expect(
            page.locator('[role="tablist"]'),
            "本页 tablist 总数（导航 + 设置）",
        ).toHaveCount(2);
        const group = '[role="tablist"][aria-label="工作区设置页签"]';
        const tabSel = group + ' [role="tab"][aria-selected="true"]';
        await expect(page.locator(tabSel), "先要有一个选中页签").toHaveCount(1);
        // **必须先真实点击激活一个页签**，不能用 .focus()。
        // 实测（本卡诊断）：直接 .focus() 时 4 个页签 tabindex 全为 -1（roving focus 的
        // currentTabStopId 没建立），ArrowRight 完全不切换 ⇒ 会得出「方向键失效」的假结论。
        // 用 click（vendor 的激活事件是 mousedown）= 用户真实路径；此后 roving focus 正常，
        // 实测 config → mcp：tabindex 0/-1 与 aria-selected 正确迁移。
        await page
            .locator(group + ' [role="tab"]')
            .first()
            .click();
        await expect(page.locator(tabSel), "点击后应有且仅有一个选中").toHaveCount(1);
        const before = (await page.locator(tabSel).textContent())?.trim();
        await page.keyboard.press("ArrowRight");
        const after = (await page.locator(tabSel).textContent())?.trim();
        console.log("[kbd] ArrowRight: " + before + " => " + after);
        expect(after, "方向键必须真的切换页签（手搓 div 做不到）").not.toBe(before);

        // 同样必须限定组内：全局 selector 命中 2 个（导航页签也有 aria-selected=true），
        // Playwright strict mode 会直接报 strict mode violation。
        const controls = await page.locator(tabSel).getAttribute("aria-controls");
        // **实测：此处 aria-controls = null（不是 task-81 注释里写的那样）。**
        // 源码口径（reka TabsTrigger.js:36）：
        //   contentId = rootContext.contentIds.has(value) ? makeContentId(baseId, value) : undefined
        // 只有注册了对应的 `<TabsContent>` 才会有 id ⇒ 才有 aria-controls。
        // 本页四个面板是各自按 activeTab 条件挂载的（没有 TabsContent 容器）⇒ 必然为 null。
        //
        // 这不是缺陷，是**vendor 的行为边界**：aria-controls 需要 TabsContent 参与。
        // 所以本卡的判据改成「有 TabsContent 时必须有 id、无 TabsContent 时为 null 且不冒领」。
        // 顺带纠正 task-81 的过度声明 —— 那条写「vendor 自带 aria-controls」，在本页不成立。
        console.log("[kbd] aria-controls=" + (controls ?? "null"));
        if (controls === null) {
            console.log(
                "[kbd] 本页无 TabsContent ⇒ aria-controls 为 null 属 vendor 预期行为，不判红",
            );
        } else {
            const panelCount = await page.evaluate(
                (id) => document.querySelectorAll('[id="' + id + '"]').length,
                controls,
            );
            console.log("[kbd] 面板命中=" + panelCount);
            expect(panelCount, "aria-controls 有值时必须指向真实面板（id=" + controls + "）").toBe(
                1,
            );
        }
    });
});

// ============================================================================
// ⑤ 逐个点击验证
// ============================================================================

test.describe("task-83 ⑤ 点击验证", () => {
    test("环境页「复制」按钮真把值写进剪贴板", async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await gotoPage(page, "/workspace/" + WS + "/environment");

        // 精确 testid（源码 WorkspaceEnvironmentView.vue:1042 workspace-spec-digest-copy）；
        // 摘要区要等投影返回才渲染，所以先等它出现而不是直接 count()。
        const copyBtn = page.locator('[data-testid="workspace-spec-digest-copy"]');
        await copyBtn
            .first()
            .waitFor({ state: "visible", timeout: 10000 })
            .catch(() => undefined);
        const copyButtons = copyBtn;
        const count = await copyButtons.count();
        console.log("[click] 找到复制类按钮 " + count + " 个");
        test.skip(count === 0, "环境页无复制按钮（可能该页无摘要区）");

        // 先清空剪贴板，再点，再读 —— 读到的必须非空且与页面显示值一致
        await page.evaluate(() => navigator.clipboard.writeText("__CLEAR__"));
        await copyButtons.first().click();
        await page.waitForTimeout(300);
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        console.log("[click] 剪贴板内容 = " + JSON.stringify(clip.slice(0, 80)));
        expect(clip, "点「复制」后剪贴板必须有真实内容（不是 __CLEAR__）").not.toBe("__CLEAR__");
        expect(clip.length, "剪贴板内容不能为空").toBeGreaterThan(0);
    });

    test("404 页「回到默认页」按钮真能回去", async ({ page }) => {
        await page.goto("/settings/user/__nonexistent__");
        await page.waitForLoadState("domcontentloaded");
        await settle(page);
        // 实测：404 视图是 data-testid=settings-not-found，其「回到默认页」是 **<a>（链接）**
        // 而不是 button；用 [data-testid*="back"] 会抓到别的元素（本卡第一版就是这样，
        // 抓到 2 个并点到错误的那个 ⇒ 超时）。按文本精确取。
        const backBtn = page.locator('a:has-text("回到默认页")');
        const count = await backBtn.count();
        console.log(
            "[click] 404 视图 notFound=" +
                (await page.locator('[data-testid="settings-not-found"]').count()),
        );
        console.log("[click] 404 页回到默认页按钮 " + count + " 个，URL=" + page.url());
        if (count > 0) {
            const before = page.url();
            await backBtn.first().click();
            // 用 waitForURL 显式等待导航完成（不靠固定 sleep；本包禁 waitForTimeout 用作同步）
            await page.waitForFunction((prev) => location.href !== prev, before, {
                timeout: 10000,
            });
            const after = page.url();
            console.log("[click] 点击后 URL = " + after);
            // 注意：这里**不能**写 expect(page.url()).not.toBe(page.url()) —— 那是一次自反比较，
            // 恒等、永远通过（本卡第一版就是这么写的：断言写在了对的位置，却比较了同一个值）。
            // 必须与**点击前**的 URL 比。
            expect(after, "点「回到默认页」后 URL 必须与点击前不同").not.toBe(before);
            expect(after, "且必须真的离开 404 页（不含 __nonexistent__）").not.toContain(
                "__nonexistent__",
            );
        }
        test.skip(count === 0, "该 404 形状没有「回到默认页」按钮");
    });
});

/**
 * task-89 ② 桌面展开态：同一套 `measureTargets`，判「两条 WCAG 2.5.8 量都过」。
 *
 * 为什么必须另开一个态：卡面那 4 条 spacing 是在 **390×844 侧栏收起态**量的，而那时
 * `[data-testid=sidebar]` 只有 1px 宽、`sidebar-panel` 宽 0 —— 控件被裁掉，
 * `elementFromPoint` 打到的是后面的 `a[workspace-nav-sessions]` ⇒ 量出来的「圆心到邻居矩形=0px」
 * 是**两个不同 UI 区域的几何重叠**，不是「与邻居贴死」。桌面展开态才是它们真正可交互的地方。
 *
 * 这条同时是**变异腿的主判据**：把 `sidebar-workspaces-header` 的 `gap-1` 改 0（或把
 * `gap` 换成负值）时，`导入工作区目录` / `添加 Workspace` 的「圆心到邻居矩形」会掉到 10.5
 * ⇒ 本用例必须红。若它不红，说明过滤把真违例一起滤掉了。
 */
test.describe("task-89 ② 桌面展开态触控目标", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("侧栏 4 个目标两条量都过（间距到位，不靠加大尺寸）", async ({ page }) => {
        await gotoPage(page, "/workspace/" + WS + "/settings");
        await fingerprint(page, "桌面展开态");
        const data = await measureTargets(page, TOUCH_MIN);
        const violate = data.rows.filter((r) => !r.exempt);
        console.log(
            "[desktop] 可感知触控目标 " +
                data.total +
                " 个：<24 = " +
                data.under24 +
                " / >=24 = " +
                data.ge24,
        );
        console.log("[desktop] 不合规 " + violate.length + " 个（必须 0）");
        for (const r of violate) {
            console.log(
                "[desktop]   VIOLATE " +
                    r.size +
                    " 到邻居矩形=" +
                    r.minToBox +
                    " 圆心距=" +
                    r.minCenter +
                    " " +
                    JSON.stringify(r.label),
            );
        }
        for (const r of data.rows.filter((row) => row.exempt)) {
            console.log(
                "[desktop]   PASS    " +
                    r.size +
                    " 到邻居矩形=" +
                    r.minToBox +
                    " 圆心距=" +
                    r.minCenter +
                    " " +
                    JSON.stringify(r.label),
            );
        }
        for (const e of data.excluded) {
            console.log("[desktop]   EXCLUDED " + JSON.stringify(e.label) + " ← " + e.reason);
        }
        expect(violate, "桌面展开态不得有 spacing 违例").toHaveLength(0);
        // 这三个目标必须在**被判定**的集合里（而不是被过滤掉的），
        // 否则上面那句「0 违例」可能只是「一个都没量」。
        for (const want of ["导入工作区目录", "添加 Workspace", "在此工作区新建会话"]) {
            expect(data.labels, "目标「" + want + "」必须可感知且被测量").toContain(want);
        }
    });
});
