import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

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

export default defineConfig(({ mode }) => {
    const envDir = new URL("../../", import.meta.url).pathname;
    const env = loadEnv(mode, envDir, "");
    const uiPort = Number.parseInt(pickEnv(env, "XIHE_UI_PORT") || "12630", 10);
    const cpBaseUrl =
        pickEnv(env, "XIHE_CP_BASE_URL") ||
        pickEnv(env, "XIHE_CP_URL") ||
        `http://localhost:${pickEnv(env, "XIHE_CP_PORT") || "12631"}`;
    const uiLogLevel = resolveUiLogLevel(env);

    return {
        logLevel: uiLogLevel,
        define: {
            'import.meta.env.VITE_XIHE_LOG_LEVEL': JSON.stringify(uiLogLevel === 'silent' ? 'error' : uiLogLevel === 'warn' ? 'warn' : 'info'),
            'import.meta.env.VITE_XIHE_CP_BASE_URL': JSON.stringify(cpBaseUrl),
        },
        plugins: [vue(), tailwindcss()],
        test: {
            globals: true,
            environment: 'jsdom',
            setupFiles: ['src/tests/setup.ts'],
            include: ['src/**/*.spec.ts'],
            exclude: ['e2e/**', 'node_modules/**'],
            testTimeout: 5000,
            pool: 'forks',
            fileParallelism: false,
            maxWorkers: 1,
            minWorkers: 1,
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        server: {
            port: uiPort,
            strictPort: false,
            fs: {
                // pdfjs-dist is hoisted to the workspace root by pnpm.
                allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../..')],
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
