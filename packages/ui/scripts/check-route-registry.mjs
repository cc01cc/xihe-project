#!/usr/bin/env node
/**
 * check-route-registry.mjs —— task-934：**全局导航路径必须在路由表里**的普查门。
 *
 * 为什么需要这道门（真实事故，不是假想）：`lib/globalModules.ts` 的
 * `SCHEDULED_TASKS_PATH = "/scheduled-tasks"` 是全局 rail「自动化任务」按钮的落地路径，
 * 但 `src/router/index.ts` 当时只注册了工作区子路由 `workspace-scheduled-tasks`
 * （`/workspace/:id/scheduled-tasks`）⇒ 顶层 `/scheduled-tasks` 落到文件末尾的
 * `/:pathMatch(.*)* → /workbench`，再被 tab 上下文守卫恢复回原会话页。真实效果是：
 * 点「自动化任务」**URL 逐字不变、无报错、无 toast**，入口是死的。而当时的单元测试只断言
 * 「模块 path 等于常量」——**常量自洽**，从不把 path 交给路由表验证，所以全绿。
 *
 * 判据（与 `lib/__tests__/globalModules.spec.ts` 同口径，两处读同一个 `GLOBAL_MODULES`）：
 *   对 `module.path` 与每个 `items[].path` 调 **真实 `router.resolve()`**，命中的必须是
 *   **已注册的命名路由**。以下任一成立即 FAIL（死链）：
 *     ① `resolved.name` 为空（只有兜底 `/:pathMatch(.*)*` 会这样）；
 *     ② 命中的末条记录 name ≠ resolved.name（兜底记录没有 name）；
 *     ③ 命中记录带 `redirect`（打开会被换到别处）；
 *     ④ `resolved.path` ≠ 请求路径（redirect 已经把 path 改了）。
 *
 * `basePath` **不按「可导航」判**（它的语义是激活态前缀，不是落地页），另判一条弱判据：
 * 必须至少有某个已注册路由的 path 以它开头（前缀写错时 rail 的激活态会静默失灵）。
 *
 * 为什么不是静态解析 `router/index.ts`：路由表里有 `.flatMap()/.map()` 派生的记录
 * （`RESOURCE_DEFS` / `LAYER_DOMAINS` / 资源详情路径），手写解析器只能看到字面量那一半，
 * 会对派生路由**系统性盲**。这里用 Vite 的 `ssrLoadModule` 载入**真实** router 与模块表
 * （与 vitest 同一套 TS/别名解析），再用 `jsdom` 提供 `createWebHistory()` 需要的 DOM。
 *
 * 盲区（诚实登记）：① 只验证「路径能解析到命名路由」，不验证该路由的组件能渲染（组件级由
 * 单测 / e2e 负责）；② `basePath` 只判前缀覆盖，不判前缀是否与业务语义一致；
 * ③ 依赖 `vite.config.ts` 能成功加载（配置坏了本门 exit 2，不当「没有死链」放行）。
 *
 * 用法（cwd 任意；UI 目录按脚本位置解析，或 `XH_UI_DIR` 覆盖）：
 *   node scripts/check-route-registry.mjs
 *   node scripts/check-route-registry.mjs --json
 *   node scripts/check-route-registry.mjs --selftest
 *
 * 退出码：0 全部命中命名路由；1 有死链 / 前缀未覆盖；2 用法或环境错误（加载失败，fail-closed）；
 *        selftest 不符 1。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_DIR = resolve(HERE, "..");

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, BAD_INPUT: 2 });

/** 死链原因码（打印与断言都用它，避免"看了半天不知道哪条判据红"）。 */
export const REASON = Object.freeze({
    NO_NAME: "no-name",
    UNNAMED_MATCH: "unnamed-match",
    REDIRECT: "redirect",
    PATH_CHANGED: "path-changed",
});

/**
 * 全局导航真正会 `router.push()` 的路径：模块落地页 + 每个二级项。
 *
 * **口径**：`basePath` 不在此列（见文件头）；`items[].path` 必须在此列 —— 二级菜单项
 * 是用户直接点击的对象，漏一项就是一条死链。
 */
export function collectEntries(globalModules) {
    return globalModules.flatMap((module) => [
        { module: module.id, kind: "module.path", path: module.path },
        ...module.items.map((item, index) => ({
            module: module.id,
            kind: `items[${index}].path`,
            path: item.path,
        })),
    ]);
}

/**
 * 纯判定层：`resolveFn(path)` 返回 vue-router 的 `resolve()` 结果形态
 * （`{ name, path, matched: [{ name, path, redirect }] }`）。
 * 抽成纯函数是为了 `--selftest` 能在内存里证明「这套判据能分辨活/死」。
 */
export function classify(entries, resolveFn) {
    const failures = [];
    for (const entry of entries) {
        let resolved;
        try {
            resolved = resolveFn(entry.path);
        } catch (error) {
            failures.push({
                ...entry,
                reason: REASON.NO_NAME,
                detail: `resolve() 抛错：${message(error)}`,
            });
            continue;
        }
        const last = resolved.matched?.at(-1);
        if (!resolved.name) {
            failures.push({
                ...entry,
                reason: REASON.NO_NAME,
                detail: `命中 ${last?.path ?? "(无匹配)"}，没有命名路由`,
            });
        } else if (last?.name !== resolved.name) {
            failures.push({
                ...entry,
                reason: REASON.UNNAMED_MATCH,
                detail: `name=${resolved.name}，但末条匹配 ${last?.path ?? "(无)"} 不带同名 name`,
            });
        } else if (last?.redirect !== undefined) {
            failures.push({
                ...entry,
                reason: REASON.REDIRECT,
                detail: `命中的路由带 redirect（打开会被换到别处）`,
            });
        } else if (resolved.path !== entry.path) {
            failures.push({
                ...entry,
                reason: REASON.PATH_CHANGED,
                detail: `resolved.path=${resolved.path} ≠ ${entry.path}`,
            });
        }
    }
    return failures;
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * `basePath` 的弱判据：必须被某条已注册路由覆盖（精确相等或以 `basePath + "/"` 开头）。
 * 前缀写错时 rail 的激活态会静默失灵，而它不像 path 那样会被点击暴露。
 */
export function checkBasePaths(globalModules, routePaths) {
    const failures = [];
    for (const module of globalModules) {
        const base = module.basePath;
        const covered = routePaths.some((path) => path === base || path.startsWith(`${base}/`));
        if (!covered) {
            failures.push({
                module: module.id,
                kind: "basePath",
                path: base,
                reason: "uncovered-base-path",
                detail: "没有任何已注册路由的 path 落在该前缀下",
            });
        }
    }
    return failures;
}

/** jsdom 提供 `createWebHistory()` 需要的最小 DOM；`navigator` 在 Node 里只有 getter，不覆盖。 */
async function installDom() {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "http://localhost/",
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.history = dom.window.history;
    return dom;
}

async function loadRegistry(uiDir) {
    const dom = await installDom();
    const { createServer } = await import("vite");
    const server = await createServer({
        root: uiDir,
        configFile: resolve(uiDir, "vite.config.ts"),
        server: { middlewareMode: true },
        appType: "custom",
        logLevel: "error",
    });
    try {
        const routerModule = await server.ssrLoadModule("/src/router/index.ts");
        const modulesModule = await server.ssrLoadModule("/src/lib/globalModules.ts");
        if (!Array.isArray(modulesModule.GLOBAL_MODULES)) {
            throw new Error("/src/lib/globalModules.ts 没有导出 GLOBAL_MODULES 数组");
        }
        if (!routerModule.default?.resolve) {
            throw new Error("/src/router/index.ts 没有默认导出可 resolve 的 router");
        }
        return { router: routerModule.default, globalModules: modulesModule.GLOBAL_MODULES };
    } finally {
        await server.close();
        dom.window.close();
    }
}

/**
 * 自检：用内存夹具证明判据能分辨活/死（不是「跑通了所以对」）。
 * 四条都是**本门真会遇到的形态**，其中 `empty-table` 就是「路由记录被删掉」的样子。
 */
export function selftest() {
    const named = (path, name) => ({
        name,
        path,
        matched: [{ path, name, redirect: undefined }],
    });
    const entries = [{ module: "demo", kind: "module.path", path: "/demo" }];
    const cases = [
        {
            name: "live route passes",
            resolveFn: () => named("/demo", "demo"),
            expected: 0,
        },
        {
            name: "catch-all (no name) fails",
            resolveFn: () => ({
                name: undefined,
                path: "/demo",
                matched: [{ path: "/:pathMatch(.*)*" }],
            }),
            expected: 1,
        },
        {
            name: "redirect record fails",
            resolveFn: () => ({
                name: "demo",
                path: "/other",
                matched: [{ path: "/demo", name: "demo", redirect: "/other" }],
            }),
            expected: 1,
        },
        {
            name: "empty route table fails",
            resolveFn: () => {
                throw new Error("No route matched");
            },
            expected: 1,
        },
    ];
    const results = cases.map((testCase) => ({
        ...testCase,
        failures: classify(entries, testCase.resolveFn),
    }));
    const failed = results.filter((result) => result.failures.length !== result.expected);
    const lines = results.map(
        (result) =>
            `${result.failures.length === result.expected ? "PASS" : "FAIL"} selftest: ${result.name} ` +
            `(failures=${result.failures.length}, expected=${result.expected})`,
    );
    for (const line of lines) console.log(line);
    return failed.length === 0 ? EXIT.PASS : EXIT.FAIL;
}

function printJson(payload) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(argv) {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log("用法: node scripts/check-route-registry.mjs [--json] [--selftest]");
        return EXIT.PASS;
    }
    if (argv.includes("--selftest")) return selftest();

    const uiDir = process.env.XH_UI_DIR ? resolve(process.env.XH_UI_DIR) : DEFAULT_UI_DIR;
    if (
        !existsSync(resolve(uiDir, "package.json")) ||
        !existsSync(resolve(uiDir, "vite.config.ts"))
    ) {
        console.error(`[route-registry] UI 目录不可用：${uiDir}`);
        return EXIT.BAD_INPUT;
    }

    let registry;
    try {
        registry = await loadRegistry(uiDir);
    } catch (error) {
        console.error(
            `[route-registry] 加载真实 router 失败（fail-closed，不当"没有死链"）：${message(error)}`,
        );
        return EXIT.BAD_INPUT;
    }

    const { router, globalModules } = registry;
    const entries = collectEntries(globalModules);
    const deadLinks = classify(entries, (path) => router.resolve(path));
    const basePathFailures = checkBasePaths(
        globalModules,
        router.getRoutes().map((route) => route.path),
    );
    const failures = [...deadLinks, ...basePathFailures];

    if (argv.includes("--json")) {
        printJson({
            ok: failures.length === 0,
            uiDir,
            checked: entries.length,
            entries,
            failures,
        });
    } else {
        for (const entry of entries) {
            const failure = deadLinks.find(
                (candidate) => candidate.module === entry.module && candidate.kind === entry.kind,
            );
            console.log(
                `${failure ? "FAIL" : "PASS"} ${entry.module} ${entry.kind} = ${entry.path}` +
                    (failure ? ` (${failure.reason}: ${failure.detail})` : ""),
            );
        }
        for (const failure of basePathFailures) {
            console.log(
                `FAIL ${failure.module} basePath = ${failure.path} (${failure.reason}: ${failure.detail})`,
            );
        }
        console.log(
            `[route-registry] ${failures.length === 0 ? "PASS" : "FAIL"} ` +
                `${entries.length} 个导航路径 / ${globalModules.length} 个模块 / ${failures.length} 条死链`,
        );
    }
    return failures.length === 0 ? EXIT.PASS : EXIT.FAIL;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error) => {
            console.error(`[route-registry] 未捕获错误：${message(error)}`);
            process.exit(EXIT.BAD_INPUT);
        },
    );
}

export { loadRegistry, main };
