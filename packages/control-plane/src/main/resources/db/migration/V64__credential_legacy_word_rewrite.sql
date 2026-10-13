-- PLAN-0496 round-4（依据 0494 #9「dev 期直接切换并清理」授权）：改写仍携带退役单字
-- `credential` 的 grant 行（V41 bootstrap 形态）为 PLAN-0496 三原子 + 宽 resource。
-- 升级链先跑 V41 后跑本改写，因此不存在携带词表外字面的终态行——否则
-- PermissionAtom 解析在读路径 fail-closed（授权全拒）而写路径 500。
--
-- * 幂等：仅命中仍含旧词的行（已清理的 dev 行 no-op）。
-- * USER / Agent 默认行不受影响（V41 从未向其写入该词）。
-- * 可回滚：否（前向修复；改写前状态即 V41 字面）。

UPDATE grants
SET permissions = (
    SELECT COALESCE(jsonb_agg(atom) FILTER (WHERE atom->>'actionClass' <> 'credential'), '[]'::jsonb)
    FROM jsonb_array_elements(permissions) atom
) || ('[{"actionClass":"credential_use","resource":"credential:*"},'
   || '{"actionClass":"credential_reveal","resource":"credential:*"},'
   || '{"actionClass":"credential_manage","resource":"credential:*"}]')::jsonb
WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(permissions) atom
    WHERE atom->>'actionClass' = 'credential'
);
