import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "node:fs";
import { mockApiPlugin } from "./src/preview/mock/api-server";

const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    .version as string;
const RELEASE_CHANNELS = ["stable", "beta", "dev"] as const;

const processEnv =
    (
        globalThis as typeof globalThis & {
            process?: {
                env?: Record<string, string | undefined>;
            };
        }
    ).process?.env ?? {};

const viteLogLevels = ["info", "warn", "error", "silent"] as const;
type ViteLogLevel = (typeof viteLogLevels)[number];

function pickEnv(env: Record<string, string>, name: string): string | undefined {
    const processValue = processEnv[name];
    if (processValue && processValue.length > 0) {
        return processValue;
    }
    return env[name];
}

function resolveUiLogLevel(env: Record<string, string>): ViteLogLevel {
    const configuredLevel = (
        pickEnv(env, "XIHE_LOG_LEVEL_UI") ||
        pickEnv(env, "XIHE_LOG_LEVEL") ||
        "info"
    ).toLowerCase();

    if (configuredLevel === "warning") {
        return "warn";
    }

    if (configuredLevel === "debug" || configuredLevel === "trace") {
        return "info";
    }

    return viteLogLevels.includes(configuredLevel as ViteLogLevel)
        ? (configuredLevel as ViteLogLevel)
        : "info";
}

/**
 * task-105 · 从 locale 模块里抽出**扁平键清单**（虚拟模块 `virtual:xihe-i18n-keys`）。
 *
 * <p>为什么要走虚拟模块而不是让测试 import `src/i18n/index.ts`：那个文件在 import 期就调
 * `createI18n`，而 15 个 spec 会 `vi.mock("vue-i18n")`（只给 `useI18n`）⇒ 直接 import 真 i18n 会让
 * 这些 spec 在收集阶段就炸（实测 `No "createI18n" export is defined on the "vue-i18n" mock`）。
 * 在**构建期**算好键清单，运行期就与 vue-i18n 依赖解耦。</p>
 *
 * <p>解析方式是本仓 `scripts/i18n-scan.mjs` 已在用的同一招：去掉首行 import、把
 * `export const i18n = createI18n(` 换成局部 const，用桩函数求值取 `messages`。</p>
 */
function flattenI18nKeys(): string[] {
    const source = readFileSync(path.resolve(__dirname, "src/i18n/index.ts"), "utf8");
    const body = source
        // task-1011: the locale module now exports more than `i18n` (the copy gate imports
        // `messages`), and `new Function` bodies cannot contain `export`. Strip every import
        // line and neutralise the `export` keyword; everything else stays byte-identical.
        .replace(/^import[^\n]*\n/gm, "")
        .replace(/\bexport\s+(const|let|var|function|class)\b/g, "$1");
    const messages = new Function("createI18n", `${body}\nreturn i18n.global.messages;`)(
        (options: { messages: Record<string, unknown> }) => ({
            global: { messages: options.messages },
        }),
    ) as Record<string, unknown>;
    const keys: string[] = [];
    const walk = (node: unknown, prefix: string): void => {
        if (typeof node === "string") {
            if (prefix) keys.push(prefix);
            return;
        }
        if (node && typeof node === "object") {
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                walk(value, prefix ? `${prefix}.${key}` : key);
            }
        }
    };
    // 逐 locale 展开（不能从 messages 顶层展开，否则键会带 `zh-CN.` 前缀）
    for (const localeMessages of Object.values(messages)) walk(localeMessages, "");
    return keys;
}

const VIRTUAL_I18N_KEYS = "virtual:xihe-i18n-keys";

/**
 * task-105 · 单元测试的挂载接线：把 **`.spec.ts` 里** 的 `@vue/test-utils` 改指向
 * `src/test-utils/vueTestUtils.ts`（那里 `mount`/`shallowMount` 之后自动跑裸 i18n 键断言）。
 *
 * <p>为什么用插件而不是给每个 spec 加一行 import：32 处相对导入 = 32 个将来会坏的地方
 * （2026-11-12 实测过一次：32 个 spec 同时 `../../test-utils/…` 少一级，全部解析失败），
 * 而断言属于测试基础设施，跟 `flushPromises` 同级 —— 一处接线，新增 spec 自动受保护。</p>
 *
 * <p>**只对 `.spec.ts` 生效**（产品代码与 `e2e/` 不受影响）；shim 自身 import 真实包时
 * importer 就是这个 shim 文件，返回 null 走默认解析，不会自引用。</p>
 */
function checkedMountPlugin(): Plugin {
    const shim = path.resolve(__dirname, "src/test-utils/vueTestUtils.ts");
    return {
        name: "xihe-checked-mount",
        enforce: "pre",
        resolveId(source, importer) {
            if (source === VIRTUAL_I18N_KEYS) return `\0${VIRTUAL_I18N_KEYS}`;
            if (source !== "@vue/test-utils" || !importer) return null;
            const from = importer.split("?")[0].split("\\").join("/");
            if (!/\.(spec|test)\.ts$/.test(from)) return null;
            if (path.resolve(from) === shim) return null;
            return shim;
        },
        load(id) {
            if (id === `\0${VIRTUAL_I18N_KEYS}`) {
                return `export default ${JSON.stringify(flattenI18nKeys())};`;
            }
            return null;
        },
    };
}

export default defineConfig(({ mode }) => {
    const envDir = new URL("../../", import.meta.url).pathname,
        env = loadEnv(mode, envDir, "");
    const uiPort = Number.parseInt(pickEnv(env, "XIHE_UI_PORT") || "12630", 10);
    const cpBaseUrl =
        pickEnv(env, "XIHE_CP_BASE_URL") ||
        pickEnv(env, "XIHE_CP_URL") ||
        `http://localhost:${pickEnv(env, "XIHE_CP_PORT") || "12631"}`;
    const uiLogLevel = resolveUiLogLevel(env);
    // task-137 rev2：mock 数据 lane。只有显式 XIHE_UI_MOCK_API=1 才挂中间件（正常 dev 不受影响）；
    // 产品代码零分支 —— 真页面跑在真 router 上，数据来自这里拦的 /api/v1。
    const mockApiEnabled = pickEnv(env, "XIHE_UI_MOCK_API") === "1";
    const releaseChannelRaw = (pickEnv(env, "XIHE_RELEASE_CHANNEL") || "dev").toLowerCase();
    const releaseChannel = (RELEASE_CHANNELS as readonly string[]).includes(releaseChannelRaw)
        ? releaseChannelRaw
        : "dev";

    return {
        logLevel: uiLogLevel,
        define: {
            "import.meta.env.VITE_XIHE_LOG_LEVEL": JSON.stringify(
                uiLogLevel === "silent" ? "error" : uiLogLevel === "warn" ? "warn" : "info",
            ),
            "import.meta.env.VITE_XIHE_CP_BASE_URL": JSON.stringify(cpBaseUrl),
            "import.meta.env.VITE_XIHE_SERVICE_VERSION": JSON.stringify(pkgVersion),
            "import.meta.env.VITE_XIHE_RELEASE_CHANNEL": JSON.stringify(releaseChannel),
        },
        plugins: [
            vue(),
            tailwindcss(),
            ...(mockApiEnabled ? [mockApiPlugin({ log: (line) => console.log(line) })] : []),
            checkedMountPlugin(),
        ],
        test: {
            globals: true,
            environment: "jsdom",
            setupFiles: ["src/tests/setup.ts"],
            include: ["src/**/*.spec.ts"],
            exclude: ["e2e/**", "node_modules/**"],
            testTimeout: 5000,
            pool: "forks",
            fileParallelism: false,
            maxWorkers: 1,
            minWorkers: 1,
            // task-151 —— 显式钉死 `default` reporter，**不要删**。
            //
            // <p>**要钉的是什么**：vitest 4.1.11 在 `resolved.reporters` 为空时走
            // `resolved.reporters.push([isAgent ? "agent" : "default", {}])`（dist 实测位置
            // `vitest/dist/chunks/coverage.*.js:455`，同一处 :451 是「CLI `--reporter` 覆盖本项」）。
            // `agent`/`minimal` 都指向 `MinimalReporter extends DefaultReporter`，它把 `silent` 硬钉成
            // `"passed-only"`（`vitest/dist/chunks/index.*.js:3871`），于是 `shouldLog()` 对**通过用例**
            // 的 console 日志返回 false（同文件 :2429）⇒ **一条 `[i18n]` 告警都不打印**，连 `stderr | …`
            // 分段头都没有。本仓 `std-env` 判 `isAgent: true`（codex 规则 = `CODEX_SANDBOX`/`CODEX_THREAD_ID`；
            // 实测清掉这两个仍命中 `pi` 规则 ⇒ 不解），所以**在 agent harness 里不带 flag 跑单 spec
            // 会得到「零告警」的假绿读数**。</p>
            //
            // <p>**为什么这条判据必须能被看见**：裸 i18n 键护栏（`src/test-utils/i18nKeys.ts`）与
            // `[SLOW TEST]`（`src/tests/setup.ts`）都是 `console.warn` 落地的 —— 它们**只在日志里存在**。
            // 实证：task-121 普查据此把「全量 18 条 / 单跑 0 条」记成了一条**跨文件 i18n 状态泄漏**，
            // 而 task-128 实测证伪：单跑带 `--reporter=default` 同样是 18 条 / 28 键，与全量逐字节相同；
            // 32 个告警 spec 单独成批重跑仍是 305 行、逐 spec 全等 ⇒ 告警由**各自局部夹具**决定，与顺序无关。
            // 也就是说：这条假绿差点换来一次「修一个不存在的泄漏」的返工。</p>
            //
            // <p>**与 CI/机器可读 reporter 共存**：CLI 显式给 `--reporter` 时**整表替换**本项（:451，只保留
            // 同名项的 options），所以 `--reporter=json --outputFile.json=…` 与 `--reporter=default
            // --reporter=json` 都照旧可用（实测：json 文件正常产出、`numTotalTests 18`）。本卡**不需要**在
            // 这里挂 json —— 需要机器可读报告时在命令行追加即可。
            // 被否决的替代：只在文档里写「记得加 `--reporter=default`」—— 靠人遵守的约定正是这次踩坑的形态，
            // 而配置层钉死是零成本的（只改默认 reporter，不动 `pool`/`isolate`/`environment`）。</p>
            reporters: ["default"],
        },
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "src"),
            },
        },
        // task-159 O3 —— 卡面写「收窄 include」，实测证伪：本文件此前**没有 optimizeDeps 段**，
        // 依赖全靠 Vite 启动扫描自动发现，没有可收窄的清单。真正可量的缺陷是 katex 走**裸文件**：
        // `src/main.ts:42-53` 用 `import("markstream-vue/workers/katexRenderer.worker?worker")` 起
        // KaTeX worker，该 worker 内部 `import e from "katex"` + `import "katex/dist/contrib/mhchem"`；
        // 扫描器不进 worker 入口，于是这两个裸依赖没被预构建，浏览器每次首屏直取
        // `/node_modules/.pnpm/katex@0.18.10/.../katex.mjs`（实测 3,531,091B）与
        // `mhchem.mjs`（516,542B）= 4.05MB 未打包、未缓存复用。这里**加**两条 include，
        // 让它们进 `.vite/deps`（单文件、immutable 缓存）。被否决候选：`optimizeDeps.entries`
        // 把 worker 文件加进扫描面 —— 多一个入口去扫 worker 的整个依赖图，代价高于点名两个依赖。
        optimizeDeps: {
            include: ["katex", "katex/dist/contrib/mhchem"],
        },
        // task-159 O2 —— dev 首屏预变换。Vite 8 的 `server.warmup.clientFiles` 在
        // `dist/node/chunks/node.js:37725` 被搬进 `environments.client.dev.warmup`，服务器启动时由
        // `warmupFiles`（同文件 :36989）逐条 `warmupRequest`；而 `transformRequest`（:20231）会对
        // **每个静态 import** 递归预变换（`imp.d === -1 && dev.preTransformRequests`），动态 import 不爬。
        // 所以这里只列六条主路由的**入口模块**（`src/router/index.ts` 里那些 `() => import(...)` 的目标），
        // 让浏览器首次请求某路由时命中已变换缓存，而不是把 483 个 /src 模块全列一遍。
        // 判据：只影响 dev server，不改 `build` 语义（生产产物字节完全不变）。
        server: {
            port: uiPort,
            strictPort: false,
            warmup: {
                clientFiles: [
                    "./src/main.ts",
                    "./src/App.vue",
                    "./src/layouts/AppLayout.vue",
                    "./src/components/WorkspacePicker.vue",
                    "./src/features/workspace/pages/WorkspaceShell.vue",
                    "./src/features/workspace/pages/WorkspaceView.vue",
                    "./src/views/chat/StandaloneChatView.vue",
                    "./src/features/org-members/pages/OrgMembersView.vue",
                    "./src/layouts/SettingsLayout.vue",
                    "./src/views/settings/RolesView.vue",
                ],
            },
            fs: {
                // pdfjs-dist is hoisted to the workspace root by pnpm.
                allow: [path.resolve(__dirname, "../.."), path.resolve(__dirname, "../../..")],
            },
            proxy: {
                "/api": {
                    target: cpBaseUrl,
                    changeOrigin: true,
                    ws: true,
                    configure: (proxy) => {
                        proxy.on("proxyReq", (proxyReq, req) => {
                            if (req.url?.includes("/v1/events")) {
                                proxyReq.setHeader("Accept", "text/event-stream");
                            }
                        });
                    },
                },
            },
        },
    };
});
