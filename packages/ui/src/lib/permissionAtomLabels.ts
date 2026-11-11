/**
 * task-22 / P2-4：能力原子（capability atom）是 CP 授权层的机器标识，形如
 * `credential_manage`、`CREATE_OWN_AGENT`。设置区正文直接显示裸值等于把内部标识端给用户，
 * 所以这里只提供**显示名词表**（i18n 键）。
 *
 * 权限判定与默认授予集仍以 CP `PermissionAtomCatalog` 为准 —— UI 不据此推断任何权限，
 * 也不据此决定渲染哪一档权限面。
 *
 * 未登记的原子**回退原码**（诚实优先，不猜）：新增原子不会因为漏配词表而显示错误名字。
 */
const ATOM_LABEL_KEYS: Record<string, string> = {
    credential_manage: "settings.permissionAtom.credentialManage",
    CREATE_OWN_AGENT: "settings.permissionAtom.createOwnAgent",
    WRITE_INSTANCE_CONTENT: "settings.permissionAtom.writeInstanceContent",
};

/** i18n 键，或 `null`（未登记 ⇒ 调用方回退到原始 atom 名）。 */
export function permissionAtomLabelKey(atom: string | null | undefined): string | null {
    return ATOM_LABEL_KEYS[(atom ?? "").trim()] ?? null;
}

/**
 * 展示用名：登记过走译文，未登记原样返回；空值返回空串（调用方决定占位）。
 * 原始码由调用方另处呈现（支持排查需要「中文名 + 机器码」同时在屏）。
 */
export function formatPermissionAtom(
    atom: string | null | undefined,
    translate: (key: string) => string,
): string {
    const code = (atom ?? "").trim();
    if (!code) return "";
    const key = permissionAtomLabelKey(code);
    return key ? translate(key) : code;
}
