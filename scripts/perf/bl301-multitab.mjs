#!/usr/bin/env node
/**
 * BL-301 — 多会话/多标签叠加下的 WebUI 进程内存与主线程表现（测量工具，不改 UI 代码）。
 *
 * 前提：e2e-host `--persistent` 已启动（`.tmp/e2e-host/persistent-stack.json`）。
 * 用法：node scripts/perf/bl301-multitab.mjs [--out <json>]
 *
 * 档位（每档独立 browser context，避免互相污染）：
 *   1 tab  : [5k]
 *   3 tabs : [5k,5k,1k]
 *   5 tabs : [5k,5k,5k,1k,1k]
 *   10 tabs: [5k×5, 1k×5]
 *
 * 指标：浏览器全部进程 RSS 汇总（SystemInfo.getProcessInfo → OS WorkingSet）、renderer 进程数、
 * 每标签 DOM/已渲染行/JSHeap、加载耗时、活动标签 4s 滚动 FPS/longtask。
 * 背景标签默认被 Chromium 节流，故 launch args 关闭 backgrounding/throttling（否则多标签对比失真）。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const A03 = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const requireUi = createRequire(`${A03}/packages/ui/package.json`);
const { chromium } = requireUi('@playwright/test');

const STATE_FILE = `${A03}/.tmp/e2e-host/persistent-stack.json`;
const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const CP = `http://127.0.0.1:${state.ports.cp}`;
// BL-307：生产 bundle 复测时用 --ui-base 指向静态服务；缺省仍用 e2e-host 的 Vite dev UI。
const uiBaseInline = process.argv.find((arg) => arg.startsWith('--ui-base='));
const uiBaseIndex = process.argv.indexOf('--ui-base');
const UI = uiBaseInline ? uiBaseInline.slice('--ui-base='.length)
    : (uiBaseIndex !== -1 ? process.argv[uiBaseIndex + 1] : `http://127.0.0.1:${state.ports.ui}`);
const ADMIN_EMAIL = 'admin@xihe.local';
const ADMIN_PASSWORD = state.adminPassword;
const pgContainer = `${state.pgProjectName}-postgres-1`;
const pgDb = `xihe_e2e_host_${state.runId.replace(/^host-/, '').replace(/-/g, '_')}`;

const argValue = (name, fallback = null) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1) return process.argv[index + 1];
    const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return inline === undefined ? fallback : inline.slice(name.length + 3);
};
const OUT = resolve(argValue('out',
    `H:/zeotmp/bl301/bl301-multitab-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`));
mkdirSync(dirname(OUT), { recursive: true });

function psql(sql) {
    return execFileSync('docker', ['exec', pgContainer, 'psql', '-U', 'xihe', '-d', pgDb, '-tAc', sql],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function api(method, path, { token, workspaceId, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
    const response = await fetch(`${CP}${path}`, {
        // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- Fetch 规范里 body 为 undefined 等同「没有 body」（`Request` init 不会带 body），所以 GET 分支实际不发 body；改成条件展开只会让调用点更难读
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, json, text };
}
function fail(label, result) {
    console.error(`[fail] ${label}: HTTP ${result.status}\n${result.text?.slice(0, 500)}`);
    process.exit(1);
}

function processRssBytes(pids) {
    if (pids.length === 0) return null;
    const command = `$ids=@(${pids.join(',')}); (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`;
    const output = execFileSync('powershell', ['-NoProfile', '-Command', command],
        { encoding: 'utf8' }).trim();
    return output ? Number(output) : null;
}

// BL-301 归因：CP 侧堆采样，用来区分"多标签浏览器成本"与"每次页面加载触发的 CP 读放大"。
const CP_PID = state.pids['control-plane'];
function cpHeapUsedKb() {
    try {
        const text = execFileSync('jcmd', [String(CP_PID), 'GC.heap_info'], { encoding: 'utf8' });
        const matches = [...text.matchAll(/used\s+(\d+)K/g)];
        if (matches.length === 0) return null;
        return matches.reduce((sum, match) => sum + Number(match[1]), 0);
    } catch { return null; }
}
function cpForceGc() {
    try { execFileSync('jcmd', [String(CP_PID), 'GC.run'], { encoding: 'utf8' }); } catch { /* ignore */ }
}

// ---- fixture：workspace / principal / provider connection ----
const login = await api('POST', '/api/v1/auth/login',
    { body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
if (login.status !== 200) fail('login', login);
const token = login.json.accessToken;

const workspaces = await api('GET', '/api/v1/workspaces', { token });
if (workspaces.status !== 200) fail('workspaces', workspaces);
const workspaceList = workspaces.json.workspaces ?? workspaces.json ?? [];
let workspaceId = workspaceList[0]?.id;
if (!workspaceId) {
    const hostPath = `${A03}/.tmp/bl301-measure-ws`;
    mkdirSync(hostPath, { recursive: true });
    const created = await api('POST', '/api/v1/workspaces',
        { token, body: { name: 'bl301measure', storageMode: 'direct_attach', hostPath } });
    if (created.status !== 201 && created.status !== 200) fail('create workspace', created);
    workspaceId = created.json.id ?? created.json.workspaceId;
}
const roles = await api('GET', `/api/v1/roles?workspaceId=${workspaceId}`, { token, workspaceId });
const roleList = Array.isArray(roles.json) ? roles.json : (roles.json.items ?? []);
const roleId = roleList.find((role) => /WS_EDITOR/i.test(String(role.name ?? role.key ?? '')))?.id;
if (!roleId) fail('no WS_EDITOR role', roles);
const principal = await api('POST', '/api/v1/agent-principals',
    { token, workspaceId, body: { name: 'bl301measureAgent', scope: 'workspace' } });
if (principal.status !== 201 && principal.status !== 200) fail('create principal', principal);
const principalId = principal.json.id ?? principal.json.principalId;
await api('PUT', `/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
    { token, workspaceId, body: { permissions: [] } });
const connections = await api('GET', `/api/v1/provider-connections?workspaceId=${workspaceId}`,
    { token, workspaceId });
const connection = (connections.json?.connections ?? connections.json ?? [])[0];
if (!connection) fail('no provider connection', connections);
const modelName = (connection.manualModels ?? [])[0] ?? 'fake-openai';

async function createSession(title) {
    const response = await api('POST', `/api/v1/workspaces/${workspaceId}/sessions`, {
        token, workspaceId,
        body: {
            title, agentPrincipalId: principalId,
            modelProvider: connection.providerId, modelName,
            providerConnectionId: connection.id,
        },
    });
    if (response.status !== 201 && response.status !== 200) fail(`create session ${title}`, response);
    const sessionId = response.json.id;
    const branches = await api('GET', `/api/v1/sessions/${sessionId}/branches`, { token, workspaceId });
    const branchList = branches.json.items ?? branches.json.branches ?? branches.json;
    const branchId = (branchList.find((branch) => branch.parentBranchId == null) ?? branchList[0]).branchId
        ?? branchList[0].id;
    return { sessionId, branchId };
}

function seedMessages(sessionId, branchId, count) {
    const filler = 'x'.repeat(1024);
    psql(`INSERT INTO messages (id, session_id, run_id, role, content, created_at, branch_id, visibility)
          SELECT gen_random_uuid(), '${sessionId}'::uuid, NULL,
                 CASE WHEN i % 2 = 0 THEN 'USER' ELSE 'ASSISTANT' END,
                 'message #' || i || ' ' || '${filler}',
                 now() - ((interval '1 second') * (${count} - i)),
                 '${branchId}'::uuid, 'user'
          FROM generate_series(1, ${count}) AS i`);
    const actual = Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}'`));
    if (actual < count) throw new Error(`seeded ${actual} < ${count}`);
}

const withTimeout = (promise, ms, fallback) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
]);

async function waitForPageReady(page, timeoutMs = 40_000) {
    try {
        await page.waitForSelector('[data-testid="message-list"]', { timeout: timeoutMs });
    } catch {
        return 0;
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const rendered = await withTimeout(page.evaluate(
            () => document.querySelectorAll('[data-message-role]').length), 5000, 0);
        if (rendered > 0) {
            await new Promise((r) => setTimeout(r, 600));
            const stable = await withTimeout(page.evaluate(
                () => document.querySelectorAll('[data-message-role]').length), 5000, 0);
            if (stable > 0) return stable;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return 0;
}

async function measureProfile(profile) {
    const sessions = [];
    for (let index = 0; index < profile.counts.length; index += 1) {
        const count = profile.counts[index];
        const session = await createSession(`bl301-${profile.name}-tab${index + 1}-${count}`);
        seedMessages(session.sessionId, session.branchId, count);
        sessions.push({ ...session, count });
    }
    console.log(`[ok] ${profile.name}: seeded ${profile.counts.join('+')}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
        ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const browserCdp = await browser.newBrowserCDPSession();
    const rssSamples = [];
    let sampling = true;
    const rssTimer = setInterval(async () => {
        if (!sampling) return;
        try {
            const info = await browserCdp.send('SystemInfo.getProcessInfo');
            const bytes = processRssBytes((info.processInfo ?? []).map((process) => process.id));
            if (bytes !== null) rssSamples.push(bytes);
        } catch { /* browser busy */ }
    }, 700);
    rssTimer.unref?.();

    // CP 堆：开标签前 GC 稳定基线；开标签期间 1s 采样；结束后 GC 读 retained。
    cpForceGc();
    await new Promise((r) => setTimeout(r, 400));
    const cpHeapBefore = cpHeapUsedKb();
    const cpHeapSamples = [];
    let cpSampling = true;
    const cpTimer = setInterval(() => {
        if (!cpSampling) return;
        const used = cpHeapUsedKb();
        if (used !== null) cpHeapSamples.push(used);
    }, 1000);
    cpTimer.unref?.();

    // 同一个 context 登录一次；新标签共享 localStorage/session，无需重复登录。
    const loginPage = await context.newPage();
    await loginPage.goto(`${UI}/login`, { waitUntil: 'load', timeout: 60_000 });
    await loginPage.locator('#identifier').fill(ADMIN_EMAIL);
    await loginPage.locator('#password').fill(ADMIN_PASSWORD);
    const loginResponse = loginPage.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/v1/auth/login'
        && response.request().method() === 'POST');
    await loginPage.locator('button[type=submit]').first().click();
    if ((await loginResponse).status() !== 200) throw new Error('UI login failed');
    await loginPage.close();

    const tabs = [];
    const pageErrors = [];
    for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index];
        const page = await context.newPage();
        const apiCalls = [];
        page.on('pageerror', (error) => pageErrors.push({
            tab: index + 1, error: String(error).slice(0, 200),
        }));
        page.on('response', (response) => {
            const url = response.url();
            if (!url.includes('/api/v1/')) return;
            const path = new URL(url).pathname;
            if (/snapshot|context/i.test(path) || /\/(runs|commands|policy)/i.test(path)) {
                apiCalls.push({ path, status: response.status() });
            }
        });
        const started = Date.now();
        let rendered = 0;
        let tabStatus = 'ok';
        try {
            await page.goto(`${UI}/workspace/${workspaceId}/chat/${session.sessionId}`,
                { waitUntil: 'domcontentloaded', timeout: 90_000 });
            rendered = await waitForPageReady(page);
            if (rendered === 0) {
                // 多标签 + Vite dev 首次编译可能让单标签超过 45s 未渲染；重载一次再判。
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
                rendered = await waitForPageReady(page);
            }
        } catch (error) {
            tabStatus = 'load_error';
            pageErrors.push({ tab: index + 1, error: String(error).slice(0, 200) });
        }
        if (rendered === 0 && tabStatus === 'ok') tabStatus = 'load_timeout';
        const loadMs = Date.now() - started;
        // per-tab heap/DOM 采样（不切前台，避免改变活动标签）；每次 CDP/evaluate 都有超时，
        // 否则一个被主线程阻塞的 renderer 会让整个 profile 永久卡住（2026-11-05 实测 5-tab 卡在 tab4）。
        let heapMetrics = {};
        try {
            const cdp = await withTimeout(context.newCDPSession(page), 5000, null);
            if (cdp) {
                await withTimeout(cdp.send('Performance.enable'), 5000, null);
                const metricResult = await withTimeout(cdp.send('Performance.getMetrics'), 5000, null);
                if (metricResult) {
                    heapMetrics = Object.fromEntries(metricResult.metrics.map(
                        (metric) => [metric.name, metric.value]));
                }
            }
        } catch { /* renderer busy */ }
        const domNodes = await withTimeout(page.evaluate(
            () => document.getElementsByTagName('*').length), 5000, null);
            tabs.push({
            index: index + 1, messageCount: session.count, sessionId: session.sessionId,
            status: tabStatus, renderedRows: rendered, domNodes, loadMs, apiCalls,
            jsHeapUsedBytes: heapMetrics.JSHeapUsedSize ?? null,
            jsHeapTotalBytes: heapMetrics.JSHeapTotalSize ?? null,
            documents: heapMetrics.Documents ?? null,
        });
        console.log(`[tab ${index + 1}/${sessions.length}] ${session.count} msgs: rendered=${rendered} `
            + `dom=${domNodes} heapMB=${tabs.at(-1).jsHeapUsedBytes === null ? 'n/a'
                : (tabs.at(-1).jsHeapUsedBytes / 1048576).toFixed(1)} loadMs=${loadMs}`);
    }
    clearInterval(rssTimer);
    cpSampling = false;
    clearInterval(cpTimer);
    const cpHeapPeak = cpHeapSamples.length ? Math.max(...cpHeapSamples) : null;
    cpForceGc();
    await new Promise((r) => setTimeout(r, 400));
    const cpHeapAfter = cpHeapUsedKb();
    const toMb = (kb) => kb === null ? null : Number((kb / 1024).toFixed(1));

    // 活动标签性能：切第一个标签到前台后滚动 4s。
    const activePage = context.pages().find((page) => page.url().includes(sessions[0].sessionId));
    let scrollPerf = { skipped: true, fps: null, longTaskCount: null, longTaskOver50ms: null };
    if (activePage) {
        try { await activePage.bringToFront(); } catch { /* tab may have crashed */ }
        try {
            scrollPerf = await Promise.race([
                activePage.evaluate(async (durationMs) => {
                    const scroller = document.querySelector('[data-testid="message-scroller-viewport"]');
                    const longTasks = [];
                    let observer = null;
                    try {
                        observer = new PerformanceObserver((list) => {
                            for (const entry of list.getEntries()) longTasks.push(entry.duration);
                        });
                        observer.observe({ type: 'longtask', buffered: true });
                    } catch { /* no longtask */ }
                    const start = performance.now();
                    let frames = 0;
                    await new Promise((resolve) => {
                        function tick(now) {
                            frames += 1;
                            const progress = Math.min(1, (now - start) / durationMs);
                            if (scroller) {
                                const max = scroller.scrollHeight - scroller.clientHeight;
                                scroller.scrollTop = progress * max;
                            }
                            if (progress < 1) requestAnimationFrame(tick);
                            else resolve();
                        }
                        requestAnimationFrame(tick);
                    });
                    const duration = performance.now() - start;
                    observer?.disconnect();
                    return {
                        skipped: false,
                        scrollerFound: Boolean(scroller),
                        frames,
                        durationMs: Math.round(duration),
                        fps: Number((frames / (duration / 1000)).toFixed(1)),
                        longTaskCount: longTasks.length,
                        longTaskOver50ms: longTasks.filter((value) => value > 50).length,
                        longTaskMaxMs: longTasks.length
                            ? Number(Math.max(...longTasks).toFixed(1)) : 0,
                    };
                }, 4000),
                new Promise((resolve) => setTimeout(
                    () => resolve({ skipped: true, fps: null, timeout: true }), 15_000)),
            ]);
        } catch { /* ignore */ }
    }

    const processInfo = await browserCdp.send('SystemInfo.getProcessInfo').catch(() => null);
    const processes = processInfo?.processInfo ?? [];
    const rendererCount = processes.filter((item) => String(item.type).includes('renderer')).length;
    const rssBytes = processRssBytes(processes.map((item) => item.id));
    const rssPeakBytes = rssSamples.length ? Math.max(...rssSamples) : rssBytes;
    await browser.close().catch(() => {});

    const sum = (field) => tabs.reduce((total, tab) => total + (tab[field] ?? 0), 0);
    return {
        profile: profile.name,
        tabCount: profile.counts.length,
        messageCounts: profile.counts,
        messageTotal: sum('messageCount'),
        tabs,
        totals: {
            renderedRows: sum('renderedRows'),
            domNodes: sum('domNodes'),
            jsHeapUsedBytes: sum('jsHeapUsedBytes'),
            loadMs: sum('loadMs'),
        },
        activeTabPerf: scrollPerf,
        cpHeap: {
            beforeKb: cpHeapBefore,
            peakKb: cpHeapPeak,
            afterKb: cpHeapAfter,
            allocGrowthMb: cpHeapBefore === null || cpHeapPeak === null
                ? null : toMb(cpHeapPeak - cpHeapBefore),
            retainedGrowthMb: cpHeapBefore === null || cpHeapAfter === null
                ? null : toMb(cpHeapAfter - cpHeapBefore),
            samples: cpHeapSamples.length,
        },
        browser: {
            rendererProcessCount: rendererCount,
            processCount: processes.length,
            processTypes: processes.reduce((acc, item) => {
                const key = String(item.type ?? 'unknown');
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
            }, {}),
            rssBytes,
            rssMB: rssBytes === null ? null : Number((rssBytes / 1048576).toFixed(1)),
            rssPeakMB: rssPeakBytes === null ? null : Number((rssPeakBytes / 1048576).toFixed(1)),
            rssSamples: rssSamples.length,
        },
        pageErrors,
        status: pageErrors.length ? 'page_errors' : 'ok',
    };
}

const PROFILES = [
    { name: '1-tab', counts: [5000] },
    { name: '3-tabs', counts: [5000, 5000, 1000] },
    { name: '4-tabs', counts: [5000, 5000, 1000, 1000] },
    { name: '5-tabs', counts: [5000, 5000, 5000, 1000, 1000] },
    { name: '10-tabs', counts: [5000, 5000, 5000, 5000, 5000, 1000, 1000, 1000, 1000, 1000] },
    { name: '5-tabs-1k', counts: [1000, 1000, 1000, 1000, 1000] },
    { name: '10-tabs-1k', counts: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] },
];

const output = {
    id: 'BL-301',
    title: '多会话/多标签叠加下的 WebUI 进程内存与主线程表现',
    capturedAt: new Date().toISOString(),
    stack: { runId: state.runId, ports: state.ports },
    fixture: { workspaceId, principalId, contentBytesPerMessage: 1024 },
    notes: [
        '每档独立 browser context（同一登录态），标签数=会话数；每标签独立 session。',
        'Chromium 背景节流已关闭（--disable-background-timer-throttling/--disable-renderer-backgrounding/--disable-backgrounding-occluded-windows），否则背景标签 rAF 暂停会让多标签 FPS 不可比。',
        'browser RSS = SystemInfo.getProcessInfo 全部进程 OS WorkingSet 汇总；renderer 进程数同源。',
        '活动标签 = 每档第 1 个标签，bringToFront 后滚动 4s。',
    ],
    profiles: [],
};

const onlyProfiles = argValue('profiles');
const selectedProfiles = onlyProfiles
    ? PROFILES.filter((profile) => onlyProfiles.split(',').includes(profile.name))
    : PROFILES;
if (selectedProfiles.length === 0) throw new Error(`no profile matches --profiles=${onlyProfiles}`);
console.log(`[ok] output -> ${OUT}`);
for (const profile of selectedProfiles) {
    const measured = await measureProfile(profile);
    output.profiles.push(measured);
    writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

const fmtMB = (bytes) => bytes === null ? 'n/a' : (bytes / 1048576).toFixed(1);
console.log('\n| 档位 | 标签 | 消息合计 | renderer 进程 | 浏览器 RSS 峰值 | RSS/标签 | DOM 合计 | JSHeap 合计 | 活动标签 FPS | >50ms longtask |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const item of output.profiles) {
    console.log(`| ${item.profile} | ${item.tabCount} | ${item.messageTotal} `
        + `| ${item.browser.rendererProcessCount} | ${item.browser.rssPeakMB} MB `
        + `| ${(item.browser.rssPeakMB / item.tabCount).toFixed(1)} MB `
        + `| ${item.totals.domNodes} | ${fmtMB(item.totals.jsHeapUsedBytes)} MB `
        + `| ${item.activeTabPerf.fps ?? 'n/a'} | ${item.activeTabPerf.longTaskOver50ms ?? 'n/a'} |`);
}
console.log(`\n[ok] written ${OUT}`);
