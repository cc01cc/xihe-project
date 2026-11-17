import { i18n } from "../i18n";
import { DEFAULT_LOCALE, normalizeLocale } from "../i18n/locale";

/**
 * `task-73` · 用户可见日期/时间的**唯一**渲染入口。
 *
 * <p>真因：`new Date(x).toLocaleString()` 不带 locale 时用的是**浏览器 locale**
 * （`Intl.DateTimeFormat().resolvedOptions().locale`），而界面语言由 `applyLocale` 写进
 * `i18n.global.locale` —— 这是两个**互不相关**的轴。二者只是**恰好**在一台英文系统上同时
 * 出现，所以中文界面上会出现 `11/1/2026, 5:00:00 PM`（US 月/日 + 12 小时制）：语言是中文，
 * 日期格式是美式。</p>
 *
 * <p>为什么把 locale **读**在这里、而不是让调用方每次传：调用点有二十处、散布在十六个文件里，
 * 传参的写法一定会漏一处，而漏掉的那一处**看上去完全正常**（它在英文机器上是对的）。locale
 * 只由 `i18n/locale.ts#applyLocale` 写入 ⇒ 这里读 `i18n.global.locale.value` 就永远是
 * **当前界面语言**，不需要第二份状态。</p>
 *
 * <p>时区：默认**不传** `timeZone`，即用宿主/浏览器所在时区 —— 这是有意的，聊天与监控面板上的
 * 时钟是「用户本地墙上时间」。**不要**为了「统一」改成 UTC：那会让
 * `SessionMonitorPanel` / `MessageItem` 的时间整体偏 8 小时（实证见 task-73 收据
 * §时区前后对比）。唯一的指定时区需求是排程 `nextFire`（按任务自己的 IANA 时区渲染），
 * 走 `options.timeZone`，仍然不出本入口。</p>
 */

export type DateInput = string | number | Date | null | undefined;

/**
 * 值不可渲染时的占位形态，**全包只有这一个**。
 *
 * <p>`task-73` 之前 `"—"` 与 `""` 混用。`""` 那几处（`McpStdioServerList#sinceText`、
 * `MessageList` 的日期分隔符、`RunCheckpointMarker#revertedAt`）的真实语义是
 * **「这一项不渲染」**（`v-if` 或 `filter(Boolean)` 的哨兵），不是「渲染一个占位」。所以本入口
 * 只负责一种语义：**值缺失或不可解析 ⇒ 渲染 `—`**；需要「没有就不渲染」的调用方先用
 * `isValidDate()` 判真，别让占位符冒充哨兵（那会把 `—` 当成日期分隔符画出来）。</p>
 *
 * <p>唯一例外是**已是本地化文案**的兜底：`settings.auditNotAvailable`（「不可用」）在审计表里与
 * `runId`、时长共用同一句话，它是文案不是占位 ⇒ 通过 `fallback` 参数覆盖，不改词。</p>
 */
export const DATE_FALLBACK = "—";

/**
 * 显式选项集，**不用** `dateStyle`/`timeStyle`：`short` 在 en-US 会退成两位年
 * （`11/2/26`），而这里要的是与语言一致的完整年。
 */
const OPTIONS = {
    /** 日期 + 时分秒（本地），对应旧的裸 `toLocaleString()` 精度。 */
    dateTime: {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    },
    /** 日期 + 时分（本地），排程与「到分钟」读数用。 */
    dateTimeShort: {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    },
    /**
     * 日期 + 时分秒，月份用**短名**（中「11月」/ 英「Nov」）：复刻 `dateStyle:"medium"` 的日期段，
     * 给回合执行记录（`RunTraceTimeline`）这类「中等粒度」读面用。见 `formatDateTimeMedium`。
     */
    dateTimeMedium: {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    },
    date: { year: "numeric", month: "numeric", day: "numeric" },
    time: { hour: "2-digit", minute: "2-digit" },
    timeWithSeconds: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

type OptionKind = keyof typeof OPTIONS;

/** `Intl.DateTimeFormat` 构造很贵（每次 0.1 ms 级），而这里按行/按秒重渲染 ⇒ 按 key 复用实例。 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(
    locale: string,
    kind: OptionKind,
    timeZone: string | undefined,
): Intl.DateTimeFormat {
    const key = `${kind}|${locale}|${timeZone ?? ""}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        const options: Intl.DateTimeFormatOptions = timeZone
            ? { ...OPTIONS[kind], timeZone }
            : OPTIONS[kind];
        formatter = new Intl.DateTimeFormat(locale, options);
        formatters.set(key, formatter);
    }
    return formatter;
}

/**
 * 当前界面语言（`i18n.global.locale` 是唯一 SSOT，写入方只有 `applyLocale`）。
 *
 * <p>`legacy: false` 下它是 `WritableComputedRef` ⇒ 读 `.value`；这里同时容忍字符串形态，因为
 * 单测里的局部 `createI18n` 可能以 `legacy: true` 配置构造。</p>
 */
function currentLocale(): string {
    const locale: unknown = i18n.global.locale;
    const raw: unknown =
        typeof locale === "string"
            ? locale
            : ((locale as { value?: unknown } | null | undefined)?.value ?? DEFAULT_LOCALE);
    return normalizeLocale(raw);
}

function toDate(value: DateInput): Date | null {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 值是否可渲染。
 *
 * <p>只给「没有就不渲染」的调用方用（见 `DATE_FALLBACK` 的说明）；渲染一侧直接调
 * `formatDateTime` / `formatDate` / `formatTime`，占位由它们统一产出。</p>
 */
export function isValidDate(value: DateInput): boolean {
    return toDate(value) !== null;
}

export interface FormatDateTimeOptions {
    /** 指定 IANA 时区（排程用）；省略 ⇒ 宿主/浏览器本地时区。 */
    timeZone?: string;
    /** 是否带秒（默认 true，与旧的裸 `toLocaleString()` 精度一致）。 */
    seconds?: boolean;
}

/**
 * 日期 + 时间。
 *
 * <p>实测读数（`2026-11-01T17:00:00Z`，宿主 Asia/Singapore）：zh-CN ⇒
 * `2026/11/2 01:00:00`；en-US ⇒ `11/2/2026, 01:00:00 AM`。</p>
 */
export function formatDateTime(
    value: DateInput,
    fallback: string = DATE_FALLBACK,
    options: FormatDateTimeOptions = {},
): string {
    const date = toDate(value);
    if (!date) return fallback;
    const locale = currentLocale();
    return formatterFor(
        locale,
        options.seconds === false ? "dateTimeShort" : "dateTime",
        options.timeZone,
    ).format(date);
}

/**
 * 日期 + 时分秒，**月份用短名**（中「11月」/ 英「Nov」）。
 *
 * <p>存在的唯一理由：`RunTraceTimeline` 原先是 `dateStyle:"medium"`，而本入口整体不用
 * `dateStyle`（`short` 在 en-US 会退成两位年）。显式字段里只有 `month:"short"` 能复刻它的
 * 日期段，所以给它一个**具名**粒度，而不是把入口改造成能表达任意 `Intl` 选项的转发层。</p>
 *
 * <p>两种语言各自的字符串形态由 `__tests__/dateFormat.spec.ts` 钉住 —— 本注释不复制那些
 * 字符串（`D-1767`：没有机器判据会跟着改的数不进注释）。</p>
 */
export function formatDateTimeMedium(
    value: DateInput,
    fallback: string = DATE_FALLBACK,
    options: Pick<FormatDateTimeOptions, "timeZone"> = {},
): string {
    const date = toDate(value);
    if (!date) return fallback;
    return formatterFor(currentLocale(), "dateTimeMedium", options.timeZone).format(date);
}

/** 只有日期，如 zh-CN `2026/11/2` / en-US `11/2/2026`。 */
export function formatDate(value: DateInput, fallback: string = DATE_FALLBACK): string {
    const date = toDate(value);
    return date ? formatterFor(currentLocale(), "date", undefined).format(date) : fallback;
}

/** 只有时间（默认到分钟；`seconds: true` 给「最后更新」这类需要秒的读数）。 */
export function formatTime(
    value: DateInput,
    options: { seconds?: boolean; fallback?: string } = {},
): string {
    const date = toDate(value);
    if (!date) return options.fallback ?? DATE_FALLBACK;
    return formatterFor(
        currentLocale(),
        options.seconds ? "timeWithSeconds" : "time",
        undefined,
    ).format(date);
}
