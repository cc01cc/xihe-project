#!/usr/bin/env node
/**
 * 对话框主操作可达性扫描（task-120 候选 (a)，Lead 2026-11-18 批落地；report-only 不阻断，同 task-172 口径）。
 * 真判据主门：真触发点打开对话框（不用 store 直改），在 mock 真实数据量下量「主操作是否可达」。
 *
 * 操作定义（task-173 不变）：不可达 = 矩形视口外 且 无「用户能滚的有效容器」——
 * 向上 walk 止于第一个 position:fixed；overflowY∈{auto,scroll} 且 scrollHeight>clientHeight；hidden 不算。
 *
 * 组成：
 *  - SITES 触发表：每站点 {id, route, pre?, open, panel, expect?, mobile?, covers, note?}。
 *    expect = D-1811 身份期望（主操作 testid 或精确文案）；对不上记 n/a 并警告，不猜身份。
 *  - 空心绿守卫：静态无约束清单（同 check-dialog-shape 口径）与 SITES 的 covers 差集 ⇒ UNCOVERED 报告
 *    （静态无约束但没人量 = 显式列出，不许消失 = D-1804；零命中当「没测到」不当「没问题」）。
 *  - 自检臂（--selftest）：变体 C（overflow:hidden 假绿）/ 变体 D（max-h-only 真不可达）/ 正例，
 *    证明「门能红」。不开浏览器不行（jsdom 量不了布局）。
 *
 * 视口：1920×1080 / 1440×900 / 1280×720（桌面）+ 375×667（SITES 标 mobile 的 sheet/抽屉/表单）。
 * 前置：XIHE_UI_MOCK_API=1 起的 vite（默认 http://127.0.0.1:5197，--base 可改）+ chrome-beta。
 *
 * 必须写的限制（输出尾段打印）：只判「量到的站点」；mock 数据量决定内容高度，真实数据更长时门未覆盖；
 * 权限门/状态门/mock 缺数据的站点记 n/a 单列，不许当通过。
 *
 * 退出码：恒 0（report-only）；--enforce 时 UNREACHABLE>0 ⇒ 1；环境错误（server 不通/浏览器缺）⇒ 2。
 * 用法：node scripts/dialog-reachability-sweep.mjs [--base URL] [--selftest] [--enforce] [--out FILE]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "..");
const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const opt = (n, d) => {
    const i = ARGS.indexOf(n);
    return i >= 0 ? ARGS[i + 1] : d;
};
const BASE = opt("--base", "http://127.0.0.1:5197");
const OUT = opt("--out", "");
const WS = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const VPS = [
    { w: 1920, h: 1080 },
    { w: 1440, h: 900 },
    { w: 1280, h: 720 },
];
const VP_MOBILE = { w: 375, h: 667 };

// ---- PROBE（page.evaluate 内执行；返回面板几何 + 按钮身份 + 主操作判定）----
function PROBE(panelSel) {
    const panel = document.querySelector(panelSel);
    if (!panel) return { error: "panel not found: " + panelSel };
    const vh = window.innerHeight,
        vw = window.innerWidth;
    const rect = panel.getBoundingClientRect();
    const btns = [...panel.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0);
    const ACTION =
        /保存|创建|确定|确认删除|确认|删除|新建|提交|下一步|绑定|解绑|移除|导入|上传|开始|重命名|移动|关联|替换|显示|注册|Rename|Move|Create|Delete|Confirm|Save|Link|Replace|Reveal/;
    const notCancel = btns.filter(
        (b) => !/^取消$|^关闭$|^Cancel$|^Close$/i.test((b.textContent || "").trim()),
    );
    const primary =
        notCancel.find((b) => b.type === "submit") ||
        notCancel.filter((b) => ACTION.test((b.textContent || "").trim())).pop() ||
        null;
    const ident = (el) =>
        el
            ? {
                  text: (el.textContent || "").trim().slice(0, 18),
                  testid: el.getAttribute("data-testid") || "",
                  aria: el.getAttribute("aria-label") || "",
                  type: el.getAttribute("type") || "",
              }
            : null;
    const measure = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        let p = el.parentElement,
            fixed = false,
            cont = null;
        while (p && p.nodeType === 1) {
            const cs = getComputedStyle(p);
            if (
                !fixed &&
                !cont &&
                (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
                p.scrollHeight > p.clientHeight + 1
            )
                cont = p;
            if (cs.position === "fixed") fixed = true;
            p = p.parentElement;
        }
        const inView = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
        let byScroll = false;
        if (!inView && cont) {
            const before = cont.scrollTop;
            cont.scrollTop = cont.scrollHeight;
            const r2 = el.getBoundingClientRect();
            const atBottom = r2.top >= 0 && r2.bottom <= vh;
            cont.scrollTop = 0;
            const r3 = el.getBoundingClientRect();
            const atTop = r3.top >= 0 && r3.bottom <= vh;
            byScroll = atBottom || atTop;
            cont.scrollTop = before;
        }
        return {
            ...ident(el),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            inView,
            containerOy: cont ? getComputedStyle(cont).overflowY : null,
            byScroll,
            verdict: inView || byScroll ? "REACHABLE" : "UNREACHABLE",
        };
    };
    return {
        viewport: { w: vw, h: vh },
        panel: {
            ...ident(panel),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            h: Math.round(rect.height),
            scrollH: panel.scrollHeight,
            clientH: panel.clientHeight,
            overflowY: getComputedStyle(panel).overflowY,
            maxH: getComputedStyle(panel).maxHeight,
        },
        overflowsTop: rect.top < 0,
        overflowsBottom: rect.bottom > vh,
        primary: measure(primary),
    };
}

// ---- SITES 触发表（id / 路由 / 打开动作 / 面板选择器 / D-1811 身份期望 / 覆盖的源文件）----
// expect：主操作身份期望（text 或 testid），对不上 ⇒ 该单元记 n/a + WARN（不猜身份）。
// mobile：true ⇒ 加跑 375×667。covers：空心绿守卫用（静态无约束清单的 file:line 必须被某站点覆盖）。
const INSTANCE_PRE = async (p) => {
    await p.getByTestId("resource-layer-tab-INSTANCE").click();
    await p.waitForTimeout(1500);
};
const USER_PRE = async (p) => {
    await p.getByTestId("resource-layer-tab-USER").click();
    await p.waitForTimeout(1500);
};
const SITES = [
    {
        id: "credCreate",
        route: "/resources/credentials",
        open: (p) => p.getByTestId("credentials-create-button").click({ timeout: 8000 }),
        panel: '[data-testid="credentials-create-dialog"]',
        expect: { text: "创建" },
        covers: ["src/components/settings/credentials/CredentialCreateDialog.vue:145"],
    },
    {
        id: "credLink",
        route: "/resources/credentials",
        open: (p) =>
            p.getByTestId("credentials-link-action-mock-cred-deploy").click({ timeout: 8000 }),
        panel: '[data-testid="credentials-link-dialog"]',
        expect: { text: "关联到连接" },
        covers: ["src/components/settings/credentials/CredentialLinkDialog.vue:80"],
    },
    {
        id: "credDetail",
        route: "/resources/credentials",
        open: (p) => p.getByTestId("credentials-row-mock-cred-deploy").click({ timeout: 8000 }),
        panel: '[data-testid="credentials-detail-dialog"]',
        covers: ["src/components/settings/credentials/CredentialDetailDialog.vue:115"],
    },
    {
        id: "credReplace",
        route: "/resources/credentials",
        open: async (p) => {
            await p.getByTestId("credentials-row-mock-cred-deploy").click({ timeout: 8000 });
            await p.waitForSelector('[data-testid="credentials-detail-dialog"]', { timeout: 5000 });
            await p.getByTestId("credentials-detail-replace").click({ timeout: 8000 });
        },
        panel: '[data-testid="credentials-replace-dialog"]',
        expect: { text: "替换" },
        covers: ["src/components/settings/credentials/CredentialReplaceDialog.vue:98"],
    },
    {
        id: "credReveal",
        route: "/resources/credentials",
        open: async (p) => {
            await p.getByTestId("credentials-row-mock-cred-deploy").click({ timeout: 8000 });
            await p.waitForSelector('[data-testid="credentials-detail-dialog"]', { timeout: 5000 });
            await p.getByTestId("credentials-detail-reveal").click({ timeout: 8000 });
        },
        panel: '[data-testid="credentials-reveal-dialog"]',
        expect: { text: "查看" },
        covers: ["src/components/settings/credentials/CredentialRevealDialog.vue:128"],
    },
    {
        id: "instCredCreate",
        route: "/resources/credentials",
        pre: INSTANCE_PRE,
        open: (p) => p.getByTestId("instance-credentials-create").click({ timeout: 8000 }),
        panel: '[data-testid="instance-credentials-create-dialog"]',
        expect: { text: "创建" },
        covers: ["src/components/settings/InstanceCredentialsPanel.vue:470"],
    },
    {
        id: "instCredDelete",
        route: "/resources/credentials",
        pre: INSTANCE_PRE,
        open: (p) =>
            p
                .locator('[data-testid^="instance-credential-delete-"]')
                .first()
                .click({ timeout: 8000 }),
        panel: '[data-testid="instance-credential-delete-dialog"]',
        expect: { text: "删除" },
        covers: ["src/components/settings/InstanceCredentialsPanel.vue:658"],
    },
    {
        id: "instMcpCreate",
        route: "/resources/mcp",
        pre: INSTANCE_PRE,
        open: (p) =>
            p
                .locator(
                    '[data-testid="instance-mcp-create"], [data-testid="instance-mcp-empty-create"]',
                )
                .first()
                .click({ timeout: 8000 }),
        panel: '[data-testid="instance-mcp-create-dialog"]',
        expect: { text: "注册" },
        covers: ["src/components/settings/InstanceMcpPanel.vue:370"],
    },
    {
        id: "instMcpDelete",
        route: "/resources/mcp",
        pre: INSTANCE_PRE,
        open: (p) =>
            p.locator('[data-testid^="instance-mcp-delete-"]').first().click({ timeout: 8000 }),
        panel: '[data-testid="instance-mcp-delete-dialog"]',
        expect: { text: "删除" },
        covers: ["src/components/settings/InstanceMcpPanel.vue:470"],
    },
    {
        id: "instAgentCreate",
        route: "/settings/instance/agent-principals",
        open: (p) => p.getByTestId("instance-agents-create").click({ timeout: 8000 }),
        panel: '[data-testid="instance-agents-create-dialog"]',
        expect: { text: "创建" },
        covers: ["src/components/settings/InstanceAgentsPanel.vue:628"], // task-201：task-191 抽屉提交推移 +40 行（原 588）
    },
    {
        id: "instAgentEdit",
        route: "/settings/instance/agent-principals",
        open: (p) =>
            p.locator('[data-testid^="instance-agent-edit-"]').first().click({ timeout: 8000 }),
        panel: '[data-testid="instance-agents-edit-dialog"]',
        expect: { text: "保存" },
        covers: ["src/components/settings/InstanceAgentsPanel.vue:692"], // task-201：原 652，+40
    },
    {
        id: "instAgentDelete",
        route: "/settings/instance/agent-principals",
        open: (p) =>
            p.locator('[data-testid^="instance-agent-delete-"]').first().click({ timeout: 8000 }),
        panel: '[data-testid="instance-agent-delete-dialog"]',
        expect: { text: "删除" },
        covers: ["src/components/settings/InstanceAgentsPanel.vue:795"], // task-201：原 755，+40
    },
    {
        id: "instAgentSkills",
        route: "/settings/instance/agent-principals",
        open: (p) =>
            p.locator('[data-testid^="instance-agent-skills-"]').first().click({ timeout: 8000 }),
        panel: '[data-testid="instance-agent-skills-dialog"]',
        note: "mock 下内容为错误态「重试」，非真实内容读数",
        covers: ["src/components/resources/InstanceAgentSkillsDialog.vue:168"],
    },
    {
        id: "personalSkillCreate",
        route: "/resources/skills",
        pre: USER_PRE,
        open: (p) => p.getByTestId("personal-skills-create").click({ timeout: 8000 }),
        panel: '[data-testid="personal-skill-create-dialog"]',
        expect: { text: "创建" },
        covers: ["src/components/settings/PersonalSkillCreateDialog.vue:213"],
    },
    {
        id: "skillsImport",
        route: "/resources/skills",
        pre: INSTANCE_PRE,
        open: (p) => p.getByTestId("settings-skills-import").click({ timeout: 8000 }),
        panel: '[data-testid="skills-import-dialog"]',
        expect: { text: "开始导入" },
        covers: ["src/components/settings/SkillsImportDialog.vue:185"],
    },
    {
        id: "settingsErrorGap",
        route: "/settings/audit",
        open: (p) => p.getByTestId("settings-error-gap-more").click({ timeout: 8000 }),
        panel: '[data-testid="settings-error-gap-dialog"]',
        expect: { text: "知道了" },
        covers: ["src/components/settings/SettingsErrorSurface.vue:88"],
    },
    {
        id: "wsDeleteConfirm",
        route: "/workspace/" + WS + "/settings",
        open: (p) => p.getByTestId("ws-settings-delete").click({ timeout: 8000 }),
        panel: '[data-testid="workspace-delete-confirm"]',
        expect: { text: "确认删除" },
        covers: ["src/features/workspace/pages/WorkspaceSettingsView.vue:691"],
    },
    {
        id: "wsMembersRemoveConfirm",
        route: "/workspace/" + WS + "/members",
        open: (p) => p.getByTestId("ws-members-remove-u-alan").click({ timeout: 8000 }),
        panel: '[data-testid="ws-members-remove-confirm"]',
        expect: { text: "确认移除" },
        covers: ["src/features/workspace/components/WorkspaceMembersPanel.vue:403"],
    },
    {
        id: "providerDeleteInner",
        route: "/settings",
        open: (p) =>
            p
                .getByTestId("provider-connection-delete-conn-claude-primary")
                .click({ timeout: 8000 }),
        panel: '[data-testid="provider-delete-confirm-modal"] [role="alertdialog"]',
        expect: { testid: "provider-delete-confirm" },
        covers: [],
    },
    {
        id: "mobileFiles",
        route: "/workspace/" + WS,
        mobile: true,
        open: (p) => p.getByTestId("workspace-toolbar-files-mobile").click({ timeout: 8000 }),
        panel: '[data-testid="mobile-files-sheet"]',
        covers: ["src/features/workspace/components/MobileWorkspaceSheet.vue:34"],
    },
    {
        id: "mobileChanges",
        route: "/workspace/" + WS,
        mobile: true,
        open: async (p) => {
            await p.getByTestId("workspace-toolbar-more-mobile").click({ timeout: 8000 });
            await p.waitForTimeout(400);
            await p.getByTestId("workspace-toolbar-more-changes").click({ timeout: 8000 });
        },
        panel: '[data-testid="mobile-changes-sheet"]',
        covers: ["src/features/workspace/components/MobileChangesSheet.vue:77"],
    },
    {
        id: "mobileCredCreate",
        route: "/resources/credentials",
        mobile: true,
        open: (p) => p.getByTestId("credentials-create-button").click({ timeout: 8000 }),
        panel: '[data-testid="credentials-create-dialog"]',
        expect: { text: "创建" },
        covers: [],
    },
    // task-201：task-191 新抽屉 AgentPrincipalDetailDrawer 的三层宿主触发点（各宿主列表行的「详情」键）。
    // 抽屉主体 DialogContent 自带 max-h-[85vh] overflow-y-auto（shape PASS）；此三站点只判主操作可达。
    {
        id: "apdInstance",
        route: "/settings/instance/agent-principals",
        open: (p) =>
            p.locator('[data-testid^="instance-agent-details-"]').first().click({ timeout: 8000 }),
        panel: '[data-testid="agent-principal-detail-drawer"]',
        covers: [],
    },
    {
        id: "apdOrg",
        route: "/members",
        open: (p) =>
            p
                .locator('[data-testid^="agent-principals-configure-"]')
                .first()
                .click({ timeout: 8000 }),
        panel: '[data-testid="agent-principal-detail-drawer"]',
        covers: [],
    },
    {
        id: "apdWorkspace",
        route: "/workspace/" + WS + "/members",
        open: async (p) => {
            await p.getByTestId("members-tab-agents").click({ timeout: 8000 });
            await p
                .locator('[data-testid^="workspace-agent-details-"]')
                .first()
                .click({ timeout: 8000 });
        },
        panel: '[data-testid="agent-principal-detail-drawer"]',
        covers: [],
    },
];

// n/a 站点（mock 下不可触发，各有具体门；列在此不许当通过，也不进 UNCOVERED——是已知覆盖缺口）。
const NA_SITES = [
    {
        site: "InstanceCredentialsPanel.vue:589 reveal",
        why: "权限门：credential_reveal 原子未授（按钮不渲染）",
    },
    { site: "PersonalSkillCreateDialog.vue:388 冲突确认", why: "状态门：冲突确认态未触发" },
    { site: "AgentPrincipalsPanel.vue:467 bind", why: "权限门：mock 下无 bind 按钮" },
    { site: "Sidebar.vue:36 移动侧栏", why: "状态门：侧栏开合依赖会话面，本轮未开" },
    { site: "AttachmentPreviewDialog.vue:347", why: "数据门：mock 会话无带附件消息" },
    {
        site: "CheckpointDialogShell.vue:46 RevertPreview",
        why: "数据门：mock 消息无 checkpoint 数据",
    },
    { site: "DelegationDialog.vue:98", why: "权限门：canDelegate 为假（按钮 disabled）" },
    { site: "MobileMembersSheet.vue:86", why: "状态门：more-members 未开出该 sheet" },
    { site: "ScheduledTaskPostponeDialog.vue:130", why: "权限门：行按钮 disabled（canManage 假）" },
    { site: "ScheduledTasksView.vue:809/843", why: "权限门：行按钮 disabled（canManage 假）" },
    {
        site: "WorkspaceEnvironmentView.vue:820 发布",
        why: "状态门：release disabled（activeJobCount>0）",
    },
    {
        site: "SettingsLayout.vue:142 移动抽屉",
        why: "抽屉本身非问题（无操作键）；mobile 量测见 mobileFiles/mobileChanges",
    },
    { site: "RolesView.vue:453 删除", why: "权限门：系统角色删除键 disabled（role.system）" },
];

// ---- 空心绿守卫：静态无约束清单（R1 口径，同 check-dialog-shape）与 SITES/NA 覆盖差集 ----
const TAG_RE2 = /<(DialogContent|AlertDialogContent|SheetContent|DrawerContent)[\s\S]*?>/g;
// task-201 方案A（Lead 批）：tracked∪未跟踪未忽略 ⇒ 新组件提交前即进门视野；干净树 --others 为空 ⇒ 行为逐字节不变。
const UNTRACKED = new Set(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    })
        .split(/\r?\n/)
        .filter(Boolean),
);
function staticUnconstrained() {
    const files = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
        .split(/\r?\n/)
        .filter(
            (p) =>
                p.endsWith(".vue") &&
                !p.includes("__tests__") &&
                !p.includes("/preview/") &&
                !/src\/components\/ui\/(dialog\/(DialogContent|DialogScrollContent)|alert-dialog\/AlertDialogContent|sheet\/SheetContent|drawer\/DrawerContent)\.vue$/.test(
                    p,
                ),
        );
    const sites = [];
    for (const f of files) {
        const src = readFileSync(resolve(ROOT, f), "utf8");
        let m;
        while ((m = TAG_RE2.exec(src)) !== null) {
            const tag = m[0];
            if (tag.includes("$attrs")) continue;
            const line = src.slice(0, m.index).split("\n").length;
            const cls = (/class="([^"]*)"/.exec(tag) || [])[1] || "";
            if (/overflow-y-(auto|scroll)/.test(cls) || /:class=/.test(tag)) continue;
            sites.push(f + ":" + line);
        }
    }
    return sites.sort();
}

function coverageReport() {
    const static_ = staticUnconstrained();
    const claimed = new Set();
    for (const s of SITES) for (const c of s.covers) claimed.add(c);
    // NA 站点名是裸文件名（无 src/ 前缀），按 basename 匹配静态清单的 repo 相对路径。
    const naNames = new Set(NA_SITES.map((n) => n.site.split(" ")[0].split(":")[0]));
    const uncovered = static_.filter(
        (s) => !claimed.has(s) && !naNames.has(s.split(":")[0].split("/").pop()),
    );
    return { total: static_.length, measured: claimed.size, uncovered };
}

// ---- 自检臂（--selftest）：变体 C / 变体 D / 正例，证明「门能红」。需 chrome-beta（jsdom 量不了布局）。----
async function selftest() {
    const { chromium } = createRequire(ROOT + "/package.json")("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome-beta" });
    const page = await (
        await browser.newContext({ viewport: { width: 1280, height: 720 } })
    ).newPage();
    await page.setContent("<div id=root></div>");
    const mk = (html) =>
        page.evaluate((h) => {
            document.getElementById("root").innerHTML = h;
        }, html);
    const run = (sel) => page.evaluate(PROBE, sel);
    const results = [];
    // 变体 C：overflow:hidden，程序可滚但用户滚轮不动 ⇒ 必须 UNREACHABLE（hidden 不算有效容器）。
    await mk(
        '<div style="position:fixed;inset:0"><div id=pc style="overflow:hidden;height:200px">' +
            '<div style="height:900px"></div>'.repeat(1) +
            '<button id=bc style="display:block">删除</button></div></div>',
    );
    // task-198：接 run()=真 PROBE（此前内联几何副本没测到门函数本体，空心绿风险 D-1804）。
    const c = await run("#pc");
    results.push({
        arm: "C",
        expect: "UNREACHABLE",
        got: c.primary ? c.primary.verdict : "NO_PRIMARY",
        raw: c.primary,
    });
    // 变体 D：max-height 盒子无 overflow，内容溢出 ⇒ 必须 UNREACHABLE。
    await mk(
        '<div style="position:fixed;inset:0"><div id=pd style="max-height:200px;overflow:visible"><div style="height:900px"></div><button id=bd style="display:block">删除</button></div></div>',
    );
    // task-198：接 run()=真 PROBE（同臂 C，测门函数本体而非内联副本）。
    const d = await run("#pd");
    results.push({
        arm: "D",
        expect: "UNREACHABLE",
        got: d.primary ? d.primary.verdict : "NO_PRIMARY",
        raw: d.primary,
    });
    // 正例：overflow-y-auto 容器，按钮在折叠区 ⇒ 必须 REACHABLE（byScroll）。
    await mk(
        '<div style="position:fixed;inset:0"><div id=pp style="overflow-y:auto;height:200px"><div style="height:900px"></div><button id=bp style="display:block">删除</button></div></div>',
    );
    // task-198：接 run()=真 PROBE；byScroll 由 PROBE.measure 内部滚到底/顶判定并复位 scrollTop。
    const ctrl = await run("#pp");
    results.push({
        arm: "control",
        expect: "REACHABLE",
        got: ctrl.primary ? ctrl.primary.verdict : "NO_PRIMARY",
        raw: ctrl.primary,
    });
    await browser.close();
    return results;
}

// ---- 主流程 ----
async function main() {
    console.log("dialog-reachability-sweep（task-120 候选 (a)）base=" + BASE);

    // 环境探活：不通 ⇒ 试 localhost 回退（vite 可能只绑 ::1）；都不通 ⇒ exit 2（门没跑成不许静默绿）。
    let base = BASE;
    const probe = async (b) => {
        try {
            const r = await fetch(b + "/api/v1/auth/me", { signal: AbortSignal.timeout(5000) });
            return r.status;
        } catch {
            return 0;
        }
    };
    let st = await probe(base);
    if (!st) {
        const alt = base.replace(/127\.0\.0\.1|localhost|\[::1\]/, "localhost");
        st = await probe(alt);
        if (st) base = alt;
    }
    if (!st) {
        console.error(
            "server unreachable: " +
                BASE +
                "（localhost 回退亦不通）—— 先起 XIHE_UI_MOCK_API=1 vite（--base 可改）。exit 2",
        );
        process.exit(2);
    }
    console.log("server probe: HTTP " + st + " via " + base);

    if (flag("--selftest")) {
        const r = await selftest();
        for (const x of r)
            console.log(
                "selftest arm " +
                    x.arm +
                    ": expect=" +
                    x.expect +
                    " got=" +
                    x.got +
                    " " +
                    JSON.stringify(x.raw),
            );
        const bad = r.filter((x) => x.expect !== x.got).length;
        console.log("selftest: " + (bad === 0 ? "OK（门能红）" : bad + " 条对不上！"));
        if (bad > 0) process.exit(2);
        return;
    }

    const { chromium } = createRequire(ROOT + "/package.json")("@playwright/test");
    let browser;
    try {
        browser = await chromium.launch({ channel: "chrome-beta" });
    } catch (e) {
        console.error("chrome-beta 不可用: " + e.message + " exit 2");
        process.exit(2);
    }
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    await ctx.addInitScript(() => localStorage.setItem("xihe-token", "mock-token"));
    const page = await ctx.newPage();

    const results = [];
    let unreachable = 0,
        na = 0,
        measured = 0;
    for (const site of SITES) {
        const vps = site.mobile ? [VP_MOBILE] : VPS;
        for (const vp of vps) {
            const rec = { id: site.id, vp, route: site.route };
            try {
                await page.setViewportSize({ width: vp.w, height: vp.h });
                await page.goto(base + site.route, { waitUntil: "domcontentloaded" });
                await page.waitForTimeout(1800);
                if (site.pre) await site.pre(page);
                await site.open(page);
                await page.waitForSelector(site.panel, { state: "visible", timeout: 6000 });
                await page.waitForTimeout(300);
                rec.data = await page.evaluate(PROBE, site.panel);
                // D-1811 身份核验：有 expect 就对；对不上 ⇒ n/a（不猜身份）。
                if (rec.data && rec.data.primary && site.expect) {
                    const p = rec.data.primary;
                    const ok =
                        (site.expect.text && p.text === site.expect.text) ||
                        (site.expect.testid && p.testid === site.expect.testid);
                    if (!ok) {
                        rec.naReason =
                            "D-1811 身份不符：expect=" +
                            JSON.stringify(site.expect) +
                            " got text=" +
                            p.text +
                            " testid=" +
                            p.testid;
                        rec.data.primary = null;
                    }
                }
            } catch (e) {
                rec.error = String((e && e.message) || e)
                    .split("\n")[0]
                    .slice(0, 120);
            }
            if (rec.error) {
                na++;
                rec.verdict = "n/a";
            } else if (rec.naReason) {
                na++;
                rec.verdict = "n/a";
            } else if (!rec.data || !rec.data.primary) {
                na++;
                rec.verdict = "n/a(no-primary)";
            } else {
                measured++;
                rec.verdict = rec.data.primary.verdict;
                if (rec.verdict === "UNREACHABLE") unreachable++;
            }
            results.push(rec);
            const d = rec.data;
            console.log(
                rec.id.padEnd(22),
                (vp.w + "x" + vp.h).padEnd(10),
                rec.error
                    ? "ERR " + rec.error
                    : rec.naReason
                      ? "n/a " + rec.naReason.slice(0, 60)
                      : d && d.panel
                        ? "h=" +
                          d.panel.h +
                          " ovf=" +
                          d.overflowsTop +
                          "/" +
                          d.overflowsBottom +
                          " primary=" +
                          (d.primary
                              ? d.primary.verdict + " " + JSON.stringify(d.primary.text)
                              : "n/a")
                        : JSON.stringify(rec.data).slice(0, 50),
            );
        }
    }
    await browser.close();

    // 空心绿守卫 + n/a 清单 + 限制 footer。
    const cov = coverageReport();
    console.log("");
    console.log("== 空心绿守卫 ==");
    console.log(
        "静态无约束站点 " +
            cov.total +
            " 个；触发表覆盖 " +
            measured +
            " 单元；UNCOVERED（静态无约束但没人量）: " +
            cov.uncovered.length,
    );
    for (const u of cov.uncovered)
        console.log("  UNCOVERED " + u + (UNTRACKED.has(u.split(":")[0]) ? " [untracked]" : ""));
    if (UNTRACKED.size > 0)
        console.log(
            "  （discovery 含 untracked 未提交 src 文件 " +
                UNTRACKED.size +
                " 个 —— 提交前可见，[untracked] 标）",
        );
    console.log("");
    console.log("== n/a 站点（已知覆盖缺口，不许当通过）== " + NA_SITES.length + " 条");
    for (const n of NA_SITES) console.log("  n/a " + n.site + " —— " + n.why);
    console.log("");
    console.log("== 限制 ==");
    console.log("  - 只判「量到的站点」；mock 数据量决定内容高度，真实数据更长时门未覆盖。");
    console.log(
        "  - 权限门 / 状态门 / 数据门站点记 n/a；零命中当「没测到」不当「没问题」（D-1804）。",
    );
    console.log("  - 形态约束是否合规由 check-dialog-shape.mjs 判；两门互补不互替。");
    console.log(
        "summary: measured=" +
            measured +
            " na=" +
            na +
            " UNREACHABLE=" +
            unreachable +
            " UNCOVERED=" +
            cov.uncovered.length +
            " (report-only)",
    );

    if (OUT) {
        writeFileSync(
            OUT,
            JSON.stringify({ base: BASE, results, coverage: cov, naSites: NA_SITES }, null, 1),
        );
        console.log("wrote " + OUT);
    }

    if (flag("--enforce") && unreachable > 0) process.exit(1);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
