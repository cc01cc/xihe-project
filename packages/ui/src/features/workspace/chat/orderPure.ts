/**
 * task-152 / `D-1221` ④：独立会话列表的**用户可控顺序**（L3）——纯函数侧。
 *
 * <p>只被 `components/SessionList.vue` 与其单测使用；持久化读写仍在
 * `composables/useWorkspaceLayout.ts`（单一 writer，`D-1222` ⑥）。</p>
 *
 * <p><b>三条纪律</b>（卡面判据 3/4/6 的纯函数侧）：</p>
 * <ul>
 *   <li>顺序只存 **id 数组**、在读侧投影：`replaceFromServer` 会全量替换会话数组
 *       （`stores/session.ts`），把顺序存在组件里每次刷新/SSE 必丢。</li>
 *   <li>**未知 id 落最前**（= 最近在上），不是追加末尾 —— 追加末尾会把新会话压到
 *       列表底部，与「最近在上」的默认序正相反。</li>
 *   <li>认不出的 id（已删会话 / 换了分组）在写回时**静默丢弃**：不报错、不阻塞，
 *       也不留垃圾越滚越长。</li>
 * </ul>
 */

/** 一次移动：相对位移，或直接到首/尾。 */
export type MoveAction = { kind: "delta"; delta: number } | { kind: "home" } | { kind: "end" };

/**
 * `id` 在持久顺序里的名次；未知 ⇒ `-1`（排在所有已知 id 之前）。
 *
 * <p>用 `-1` 而不是「末尾」是刻意的：它与 `orderIds()` 的「未知在最前」同源，
 * 两者必须一起看，否则新会话会掉到列表底。</p>
 */
export function rankIn(order: readonly string[], id: string): number {
    const index = order.indexOf(id);
    return index < 0 ? -1 : index;
}

/**
 * 把 `ids` 投影成**用户顺序**：未知 id 按传入相对序排在最前，已知 id 按持久名次排。
 *
 * <p>空 order ⇒ 原样返回（等价「没有自定义顺序」，此时渲染顺序就是传入顺序 =
 * API 的 `updatedAt desc`）。</p>
 *
 * <p>重复 id：取**首次**出现的位置（后写的重复项忽略），避免同一会话出现两名次。</p>
 */
export function orderIds(ids: readonly string[], order: readonly string[]): string[] {
    if (order.length === 0) return [...ids];
    const rank = new Map<string, number>();
    for (let index = 0; index < order.length; index += 1) {
        const id = order[index]!;
        if (!rank.has(id)) rank.set(id, index);
    }
    const unknown: string[] = [];
    const known: string[] = [];
    for (const id of ids) {
        if (rank.has(id)) known.push(id);
        else unknown.push(id);
    }
    known.sort((left, right) => rank.get(left)! - rank.get(right)!);
    return [...unknown, ...known];
}

/**
 * 在当前渲染列表内移动 `id`，返回**完整的下一份 order**；无需改动时返回 `null`。
 *
 * <p>返回的是「当前渲染 id 的完整投影」而不是逐点点改：这样写回后 order 与可见列表
 * 严丝合缝，已删会话的名次顺带被裁掉（判据 4 的落地形态）。</p>
 *
 * <p>`rendered` 必须是**该可拖区域内的全部行**：调用方在搜索态不许给出过滤后的子集
 * （会把不可见的行从 order 里抹掉），这也是 `SessionList` 的 `sortable` prop 由父层
 * 按 `!isSearching` 控制的原因。</p>
 */
export function moveInList(
    order: readonly string[],
    rendered: readonly string[],
    id: string,
    action: MoveAction,
): string[] | null {
    const current = orderIds(rendered, order);
    const from = current.indexOf(id);
    if (from < 0) return null;
    const last = current.length - 1;
    const to =
        action.kind === "home"
            ? 0
            : action.kind === "end"
              ? last
              : Math.min(last, Math.max(0, from + action.delta));
    if (to === from) return null;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
}
