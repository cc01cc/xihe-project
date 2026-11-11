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
        .replace(/^import[^\n]*\n/m, "")
        .replace("export const i18n = createI18n(", "const i18n = createI18n(");
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
        },
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "src"),
            },
        },
        server: {
            port: uiPort,
            strictPort: false,
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
