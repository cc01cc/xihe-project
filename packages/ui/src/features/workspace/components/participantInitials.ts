/**
 * PLAN-0631 D31-10: `initials` for a participant, in **one** place.
 *
 * Extracted from `ParticipantRow` (PLAN-0623) so the message identity row and the members
 * panel cannot drift. Two rules carried over verbatim:
 *  - only `displayName` produces letters — **never** the UUID (DEV-032: a principal id is
 *    noise, not a name);
 *  - a nameless participant shows the first letter of the localized "unknown user" label,
 *    so the badge still reads as a person placeholder rather than a fake identity.
 *
 * Deliberately color-free: per-participant hues would be new color values, which this PLAN
 * forbids (distinction comes from the name, the role badge and the icon).
 */

/**
 * **缩写契约：恰好 1 个字符**（`D-1142` ①，2026-11-13 Lead 裁定）。
 *
 * <p><b>为什么必须钉成 1 个字符</b>：本函数原来取前两个词的首字母（`"Atlas · 架构"` ⇒
 * `"A架"`），而这个字符串渲染在 `rounded-full` 的圆形徽标里。实测（Range API，见
 * `task-292` 证据）：`size-3.5` 徽标的 contentBox 只有 10.92px、`size-4` 是 12.67px，
 * 而两个字符的实测宽度 `AB`=15.98px、`A架`=20.45px ⇒ **两个字符在任何一档圆里都装不下**，
 * 会被裁掉或撑出圆外。单字符实测：`A`=8.45px、`架`=12.00px ⇒ 装得下 14px 档
 * （`size-4` = 4 × `--spacing` 3.5 = 14）。</p>
 *
 * <p><b>所以这不是「少显示一个字」的取舍，而是「徽标装不装得下」的硬约束</b>：契约取 1，
 * 圆的直径才有唯一解。两个都改（缩写成 1 + 圆用 `size-4`）才是自洽的组合 —— 只改一边
 * 要么裁字、要么圆里空一大圈。</p>
 *
 * <p><b>边界行为</b>（每条都有用例，见 `participantInitials.spec.ts`）：
 * ① 多词名取**首词首字**；② 纯标点/分隔词跳过（`"Atlas · 架构"` ⇒ `"A"`）；
 * ③ **整个名字都是标点** ⇒ 走无名回退（不是返回空串 —— 旧实现这里返回 `""`，
 * 会在圆里渲染出一个纯色空块）；④ 无名字符串本身为空 ⇒ `"?"`；
 * ⑤ 用 `Array.from` 而不是 `[0]` 取首字，避免把代理对（emoji 等）劈成半个码元。</p>
 */
export function participantInitials(
    displayName: string | null | undefined,
    unknownNameLabel: string,
): string {
    const name = displayName?.trim() ?? "";
    if (name) {
        // 纯分隔符/标点词不参与首字母（"Atlas · 架构" ⇒ "A"，而不是 "A·"）。
        const words = name.split(/\s+/).filter((word) => !/^[\p{P}\p{S}]+$/u.test(word));
        // ① 取**首个有效词**的首字符（不是前两个词的首字母）。
        const first = words[0];
        if (first) return (Array.from(first)[0] ?? "").toUpperCase();
        // ③ 全部词都是标点 ⇒ 落到无名回退，不返回空串。
    }
    // ④ 无名（或名字无有效字符）：取本地化占位文案的首字符；占位文案也空则是 "?"。
    return Array.from(unknownNameLabel)[0]?.toUpperCase() ?? "?";
}

/** The name to print: the real one, or the localized placeholder (never a UUID). */
export function participantDisplayName(
    displayName: string | null | undefined,
    unknownNameLabel: string,
): string {
    return displayName?.trim() || unknownNameLabel;
}
