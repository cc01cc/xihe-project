/**
 * 夹具侧「这条 404 到底为什么」的登记簿（task-118 ②）。
 *
 * <p><b>为什么需要它</b>：浏览器 console 里那条
 * `Failed to load resource: the server responded with a status of 404 (Not Found)` 是 <b>Chrome 生成</b>的，
 * 拿不到响应体；而 `page-failures.ts` 的 `>=400` 通道原本只记 `status + url`。两者都不带「为什么 404」，
 * 于是红点落在离真因很远的地方 —— `task-75` 的 23 条红就是红在 `chat-input` 找不到，而真因是
 * 「这个 workspace id 不在 `KNOWN_WORKSPACE_IDS` 里」。</p>
 *
 * <p><b>为什么不用 `response.body()`</b>：读 body 是异步的，而门禁在 fixture teardown 里<b>同步</b>断言
 * ⇒ 会变成「有时有说明、有时没有」的竞态。这里改成<b>同步登记</b>：夹具在 fulfill 之前按 URL 记下原因，
 * 收集器拼失败信息时按同一 URL 取回。key 是 URL，值是确定性字符串（同一 URL 重复请求得到同一条）。</p>
 *
 * <p><b>跨用例残留不是问题</b>：Map 以完整 URL 为 key，只有取到同一 URL 时才用得到；不同 spec 偶然复用
 * 同一 URL 时后登记的覆盖前一条，而两条都是「这条 URL 的夹具解释」，不会把 A 的说明安到 B 的失败上。</p>
 */
const hints = new Map<string, string>();

/** 夹具在回错误响应**之前**调用，把「为什么」登记到该请求的 URL 上。 */
export function recordFixtureHint(url: string, hint: string): void {
    hints.set(url, hint);
}

/** 收集器在拼失败信息时调用；没有登记就返回 `undefined`（调用方保持原来的输出形态）。 */
export function fixtureHintFor(url: string): string | undefined {
    return hints.get(url);
}
