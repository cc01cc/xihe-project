/**
 * 「覆盖判据」的判定与退出码 —— 单点实现，供 `scripts/l2/shard-report.mjs` 消费。
 *
 * <p>为什么单独抽出来：这个判定此前写在脚本里、而且是**错的**（BL-572）。缺陷不是算术，
 * 而是**没有分母的概念**：`ok = missing==0 && unexpected==0 && duplicates==0` 在
 * `expected==0`（报告目录不存在 / 源码根指错）时**恒为 true**，于是空输入会印
 * `coverage ok=true` 并以 0 退出 —— 一个恒绿的门。抽成纯函数才能用断言把三种结论钉住。</p>
 *
 * <p>判据（D-816：要么不修，要么修到能真红）：</p>
 * <ul>
 *   <li>`expected === 0` ⇒ `NOT_EVALUATED`（退出码 2）—— 没有分母就没有结论，
 *       <b>不许</b>把「没东西可查」算成「查过了没问题」；</li>
 *   <li>有分母且 `missing / unexpected / duplicates` 任一非空 ⇒ `FAIL`（退出码 1）；</li>
 *   <li>有分母且三项皆空 ⇒ `PASS`（退出码 0）。</li>
 * </ul>
 *
 * <p>退出码语义与 `mise run gate:agent-quality` 一致（`0/1/2` = PASS/FAIL/NOT_EVALUATED），
 * 免得同一个仓库里出现两套「2 是什么意思」。</p>
 */

export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, NOT_EVALUATED: 2 });

/**
 * @param {{ expected: number, missing: readonly unknown[], unexpected: readonly unknown[], duplicates: readonly unknown[] }} coverage
 * @returns {'PASS'|'FAIL'|'NOT_EVALUATED'}
 */
export function coverageVerdict(coverage) {
  const expected = Array.isArray(coverage?.expected) ? coverage.expected.length : coverage?.expected;
  if (!Number.isFinite(expected) || expected <= 0) return 'NOT_EVALUATED';
  const failures = (coverage?.missing?.length ?? 0)
    + (coverage?.unexpected?.length ?? 0)
    + (coverage?.duplicates?.length ?? 0);
  return failures === 0 ? 'PASS' : 'FAIL';
}

/** 给一段输出打上「为什么是这个结论」的一句话（NOT_EVALUATED 必须自己说出来，不许静默）。 */
export function coverageVerdictNote(verdict, coverage) {
  if (verdict === 'NOT_EVALUATED') {
    return 'NOT_EVALUATED: expected=0 —— 期望类集合为空（报告目录或源码根不对？），本门既不判绿也不判红，exit 2';
  }
  if (verdict === 'FAIL') {
    return `FAIL: missing=${coverage.missing.length} unexpected=${coverage.unexpected.length} duplicates=${coverage.duplicates.length} —— 覆盖不全，exit 1`;
  }
  return 'PASS: expected 全部跑到，missing/unexpected/duplicates 皆空，exit 0';
}
