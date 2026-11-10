import { writableAtOf, type MockDomain } from "./types";

/**
 * 设置页 mock · B 组域（3 个）：`user-preference` / `logging` / `job-policy`。
 *
 * ## 键集判据（唯一事实源）
 * 合法键集 = `packages/control-plane/src/main/resources/config-schemas/<domain>.json` 的
 * `properties`（[实测] 2026-11-11 逐份读原文件）：user-preference **2** / logging **6** /
 * job-policy **2**。本文件共 **10 行，全部是真键，0 个 gap**（本批唯一允许的 gap 在
 * `domains-a.ts` 的 `approval-policy.toolFaces`，这里不许再补任何一行）。
 *
 * ## 本批最要紧的一条：**四个键写了不生效**
 * 这不是文案问题，是本轮查出来的真产品缺陷——界面给了输入框，后端没有消费方：
 * - `user-preference.theme` / `.language`：UI 只读浏览器 localStorage
 *   （`stores/settings.ts:8,10`），CP 侧这两个值没有任何读者；
 * - `logging.levelRuntime`：Runtime 只读**启动环境变量**，从不读 CP 配置；
 * - `logging.levelUi`：UI 只读**构建期** env，且该键连代码默认值都没有。
 * 四处都写进 `help` 了（`help` 是用户唯一会读到的地方，注释里写等于没写）。
 *
 * ## 层可写性（一律走 `writableAtOf()`，不手填）
 * `ConfigService.java:90-96`：user-preference 只在 USER_WRITABLE ⇒ instance+user；
 * logging 两个集合都不含 ⇒ 仅 instance；job-policy 在 WORKSPACE_WRITABLE ⇒ instance+workspace。
 *
 * ## 每行出处（`[源码]` = 读过代码；`[推导]` = 由该代码推得）
 * | key | 出处 | 等级 |
 * | --- | --- | --- |
 * | user-preference.theme | user-preference.json:4；stores/settings.ts:8 | 源码 |
 * | user-preference.language | user-preference.json:5；stores/settings.ts:10；i18n/locale.ts:7 | 源码 |
 * | logging.logLevel | logging.json:4；LoggingConfigInitializer.java:42-50 | 源码 |
 * | logging.levelAgent | logging.json:5；agent/src/xihe_agent/main.py:147-153 | 源码 |
 * | logging.levelCp | logging.json:6；LoggingConfigInitializer.java:52-59 | 源码 |
 * | logging.levelRuntime | logging.json:7；runtime/src/main.rs:3890-3891（只读 env，不读本键） | 源码 |
 * | logging.levelUi | logging.json:8；ui/vite.config.ts:31-36；ConfigService.java:163-170（无默认值） | 源码 |
 * | logging.centralTelemetryEnabled | logging.json:9；TelemetryRelayService.java:30-43 | 源码 |
 * | job-policy.defaultTimeoutSecs | job-policy.json:4；McpProxyController.java:1934-1955,2013-2021 | 源码 |
 * | job-policy.maxTimeoutSecs | job-policy.json:5；McpProxyController.java:2013-2021 | 源码 |
 *
 * 行号只写在这里：`help` 里不放 Java 行号（屏上只留「[源码]」类别标签）。
 */

/**
 * user-preference：2 个真键，**两个都没有消费方**。
 *
 * 产品现状 [源码]：主题与语言都由 `stores/settings.ts:8,10` 的 `useLocalStorage` 直接读写
 * 浏览器存储（键名 `xihe-theme` / `xihe-language`），CP 配置域里的同名键只被写入、从不被读。
 * 所以这一屏对用户的诚实说法是「改了不变外观」——不能写成「下次启动生效」。
 */
const userPreference: MockDomain = {
    id: "user-preference",
    label: "偏好设置",
    summary: "两个键都能存进 CP，但界面外观不读它们：主题与语言真正生效的是浏览器本地存储。",
    layout: "form",
    groups: [
        {
            label: "外观与语言",
            fields: [
                {
                    // [源码] user-preference.json:4（enum light|dark|system）。
                    // [源码] UI 主题读 localStorage xihe-theme（stores/settings.ts:8），不读本键。
                    key: "theme",
                    label: "主题",
                    help: "[源码] **写了不生效**：界面主题只读浏览器 localStorage 的 `xihe-theme`（`stores/settings.ts:8`），没有任何代码读本键。改这里只把偏好值写进 CP，换外观要走界面自己的主题入口。",
                    control: "select",
                    value: "system",
                    options: ["light", "dark", "system"],
                    writableAt: writableAtOf("user-preference", "theme"),
                },
                {
                    // [源码] user-preference.json:5（pattern ^[a-z]{2}(-[A-Z][a-z]+)?$）。
                    // [源码] UI 语言读 localStorage xihe-language（stores/settings.ts:10），
                    //        启动期由 i18n/locale.ts 的 applyLocale 应用。
                    key: "language",
                    label: "语言",
                    help: "[源码] **写了不生效**：界面语言只读浏览器 localStorage 的 `xihe-language`（`stores/settings.ts:10`，启动时由 `i18n/locale.ts` 的 `applyLocale` 应用），本键没有消费方。格式必须形如 `zh-CN`/`en-US`（schema `^[a-z]{2}(-[A-Z][a-z]+)?$`），写成 `zh_CN` 会被拒。",
                    control: "text",
                    value: "zh-CN",
                    writableAt: writableAtOf("user-preference", "language"),
                },
            ],
        },
    ],
};

/**
 * logging：6 个真键，全部仅实例层可写。
 *
 * 只讲一件事：**哪个键真的会改变日志**。`levelCp` / `levelAgent` 有消费方且热应用；
 * `logLevel` 是 legacy（被 `levelCp` 覆盖）；`levelRuntime` / `levelUi` 无消费方。
 */
const logging: MockDomain = {
    id: "logging",
    label: "日志",
    summary:
        "调低级别等于放大日志量。六个键里两个真的会改日志、一个是被覆盖的 legacy、两个没有消费方。",
    layout: "form",
    groups: [
        {
            label: "级别",
            fields: [
                {
                    // [源码] logging.json:4；CODE_DEFAULTS logging 含 logLevel=INFO（ConfigService.java:163-170）。
                    // [源码] CP 先应用它，再用 levelCp 覆盖（LoggingConfigInitializer.java:42-59）。
                    key: "logLevel",
                    label: "日志级别",
                    help: "[源码] legacy 通用键：CP 先按它设 `com.cc01cc.p.xihe.cp` 的级别，随后被 `levelCp` 覆盖——两个都配时只有 `levelCp` 生效，单配它才有用。",
                    control: "select",
                    value: "INFO",
                    options: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
                    writableAt: writableAtOf("logging", "logLevel"),
                },
                {
                    // [源码] logging.json:5；agent main.py:147-153 读 levelAgent 并热应用。
                    key: "levelAgent",
                    label: "智能体日志级别",
                    help: "[源码] Agent 启动与配置刷新时读它并热应用（`agent/src/xihe_agent/main.py:147-153`）。调成 DEBUG 会让 Agent 日志成倍增长——每次工具调用都会落明细。",
                    control: "select",
                    value: "INFO",
                    options: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
                    writableAt: writableAtOf("logging", "levelAgent"),
                },
                {
                    // [源码] logging.json:6；LoggingConfigInitializer.java:52-59 应用到
                    //        com.cc01cc.p.xihe.cp，且写在 logLevel 之后 ⇒ 覆盖 legacy。
                    key: "levelCp",
                    label: "CP 日志级别",
                    help: "[源码] CP 自身日志级别，写入后由 CP 热应用（无需重启）；它优先于 `logLevel`，所以只改 `logLevel` 看不到变化。",
                    control: "select",
                    value: "INFO",
                    options: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
                    writableAt: writableAtOf("logging", "levelCp"),
                },
                {
                    // [源码] logging.json:7；runtime 只读 env XIHE_LOG_LEVEL_RUNTIME
                    //        （runtime/src/main.rs:3890-3891），不读 CP 配置域。
                    key: "levelRuntime",
                    label: "Runtime 日志级别",
                    help: "[源码] **当前无消费方**：Runtime 只读启动环境变量 `XIHE_LOG_LEVEL_RUNTIME`（`runtime/src/main.rs:3890-3891`），改了不生效——要改只能改部署环境变量并重启 Runtime。",
                    control: "select",
                    value: "INFO",
                    options: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
                    writableAt: writableAtOf("logging", "levelRuntime"),
                },
                {
                    // [源码] logging.json:8；UI 只读构建期 env（ui/vite.config.ts:31-36）。
                    // [源码] CODE_DEFAULTS 的 logging 表没有 levelUi（ConfigService.java:163-170）。
                    key: "levelUi",
                    label: "UI 日志级别",
                    help: "[源码] **当前无消费方**：UI 只读构建期 env（`ui/vite.config.ts:33-34`），改了不生效；且该键没有代码默认值（CP 的 logging 默认表里没有它）。",
                    control: "select",
                    value: "INFO",
                    options: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"],
                    writableAt: writableAtOf("logging", "levelUi"),
                },
                {
                    // [源码] logging.json:9（enum "true"|"false" 字符串）；默认 false
                    //        （ConfigService.java:168-170）。
                    // [源码] 闸门在 TelemetryRelayService.java:30-43；还需部署侧中继地址与令牌。
                    // 用 select 而不是 switch：value 是字符串 "false"，switch 的 Boolean("false") 为真，
                    // 会把「默认关」画成「已开」——这是本域最容易画错的一行。
                    key: "centralTelemetryEnabled",
                    label: "中央遥测上报",
                    help: "[源码] 中央遥测中继的总开关（默认关）。打开只是**允许**转发，部署侧还必须配好中继地址与令牌才真的送得出去；缺了它们事件只留本地、不报错。自由文本（message / data）永远不转发。",
                    control: "select",
                    value: "false",
                    options: ["false", "true"],
                    writableAt: writableAtOf("logging", "centralTelemetryEnabled"),
                },
            ],
        },
    ],
};

/**
 * job-policy：2 个真键（默认值 + 硬上限），仅 instance 与 workspace 两层可写。
 *
 * 两个键必须一起看：`maxTimeoutSecs` 会钳制 `defaultTimeoutSecs` 与模型传入的 `timeout`，
 * 而「显式传 0」的语义与直觉相反（钳到上限，不是不限）。
 */
const jobPolicy: MockDomain = {
    id: "job-policy",
    label: "任务策略",
    summary: "后台任务的默认时限与硬上限。上限会钳制默认值和模型传入的值，0 表示未设上限。",
    layout: "form",
    groups: [
        {
            label: "时限",
            fields: [
                {
                    // [源码] job-policy.json:4；默认 3600（ConfigService.java:174-176）。
                    // [源码] 未传/负值 → 上限已设时取 min(默认, 上限)（McpProxyController.java:2013-2021）。
                    // [源码] 两键都是 env 映射键，env 命中时写入被拒 409 CONFIG_ENV_LOCKED。
                    key: "defaultTimeoutSecs",
                    label: "默认时限（秒）",
                    help: "[源码] 模型调后台任务没传 `timeout` 时用它；上限已设时实际取两者较小值，保证硬上限不被默认值顶穿。调大长任务不易被掐断，代价是卡死的任务占资源更久。部署侧若已用环境变量钉住本键，界面上的写入会被拒（409）。",
                    control: "number",
                    value: 3600,
                    writableAt: writableAtOf("job-policy", "defaultTimeoutSecs"),
                },
                {
                    // [源码] job-policy.json:5；默认 0 = 未设上限（ConfigService.java:174-176）。
                    // [源码] 钳制矩阵 McpProxyController.java:2013-2021：
                    //        参数 0 → 返回上限；上限 0 → 返回参数（= 不限）。
                    key: "maxTimeoutSecs",
                    label: "上限（秒，0 = 未设上限）",
                    help: "[源码] 硬上限，`0` = 未设上限。传了更大的 `timeout` 会被压到它；**显式传 `0` 表示「压到上限」而不是「不限」**——上限为 0 时两者恰好相同，设了上限后想放行反而会拿到上限值。",
                    control: "number",
                    value: 0,
                    writableAt: writableAtOf("job-policy", "maxTimeoutSecs"),
                },
            ],
        },
    ],
};

export const domains: MockDomain[] = [userPreference, logging, jobPolicy];

export default domains;
