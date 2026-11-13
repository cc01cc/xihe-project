-- PLAN-0773 M1-9 (task-245；43A / D-1089 口径：principal 主体组，不是 scope)。
-- 一行 = 「该单元（含其子树）的全体成员」这个主体组拿到 role_id。
-- 它不是 scope：没有 workspace_id、不进 grants/role_bindings、不参与 RoleGrantMaterializer；
-- 只在求值时被展开成「成员 ⇒ 权限原子」（design §4.1.1）。
-- role_id 只允许治理类角色（design §4.1.1 硬约束：原子 ⊆ {MANAGE_ORG_UNITS,
-- MANAGE_ORG_UNIT_MEMBERS, READ_ORG_UNIT_MEMBERS}）；写入时在服务端拒绝，本表不加 CHECK。
-- 表与 design §3.5 的 DDL 逐字一致（迁移即规格，不得顺手加列/加约束）。
CREATE TABLE org_unit_role_bindings (
    id          UUID PRIMARY KEY,
    org_unit_id UUID NOT NULL REFERENCES org_units (id) ON DELETE CASCADE,  -- 主体组 = 该单元的子树
    role_id     UUID NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,     -- 只允许治理类角色（§4.1.1 硬约束）
    granted_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_unit_role_bindings UNIQUE (org_unit_id, role_id)
);
CREATE INDEX idx_org_unit_role_bindings_unit ON org_unit_role_bindings (org_unit_id);
