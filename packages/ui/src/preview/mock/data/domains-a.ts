import { writableAtOf, type MockDomain } from "./types";

/**
 * 设置页 mock · A 组域（2 个）：`agent-profile` / `approval-policy`。
 *
 * ## 键集判据（唯一事实源）
 * 合法键集 = `packages/control-plane/src/main/resources/config-schemas/<domain>.json` 的
 * `properties`（[实测] 2026-11-11 逐份读原文件）：agent-profile **1** / approval-policy **2**。
 * 本文件共 **4 行** = 3 行真键 + 1 行 `state:"gap"`（`approval-policy.toolFaces`，见下）。
 *
 * **不补位凑数**：字段数就是 1 + 3。上一版这里曾有 14 行 `state:"gap"`，是为了对齐旧 mock
 * 的虚构计数补出来的，已按 Lead 裁定全部删除；**只有下面这一个 gap 是被点名保留的**。
 *
 * ## 为什么只有这 4 行
 * - `embedding` / `agent-templates` / `api-request-templates` 三个域**已不在本文件**：它们是
 *   专用面板域，整块编辑由 `panels/domains-dedicated.ts` 负责。同 id 的表单版会让 `?domain=`
 *   先命中表单、拿不到面板域（[实测] `screens/S1SettingsAfter.vue:96-101` 的 `TAKEN_IDS`）。
 * - `approval-policy.toolFaces` 是**唯一**允许的 gap 行：它覆盖在 `tool_faces` 表上
 *   （[源码] `DbPolicyContextProvider.java:22-23`），不是配置键，但用户会来这页找
 *   「这个工具算哪类动作」——藏起来只会让人以为产品没有这个面。
 *
 * ## 层可写性（一律走 `writableAtOf()`，不手填）
 * 取自 `ConfigService.java:90-96` 的两个可写集合：agent-profile 只在 USER_WRITABLE
 * ⇒ instance+user；approval-policy 只在 WORKSPACE_WRITABLE ⇒ instance+workspace
 * （[源码] `DbPolicyContextProvider.java:128-131`：没有 workspaceId 时本域整体不参与解析，
 * 所以它在「无工作区上下文」的页面上改了也不会有任何效果）。
 *
 * ## 每行出处（`[源码]` = 读过代码；`[推导]` = 由该代码推得）
 * | key | 出处 | 等级 |
 * | --- | --- | --- |
 * | agent-profile.userName | api/chat.py:402-403,551；app_state.py:509；prompts.py:9,35 | 源码 |
 * | approval-policy.mode | approval-policy.json:4；PolicyEngine.java:146-161；PolicyVerdict.java:25-27；DbPolicyContextProvider.java:135-145 | 源码 |
 * | approval-policy.askActionClasses | approval-policy.json:5-8；PolicyContext.java:36-38,70-74；PolicyEngine.java:149-152；DbPolicyContextProvider.java:162-190 | 源码 |
 * | approval-policy.toolFaces | DbPolicyContextProvider.java:22-23,226-232；ToolFaceEntity.java:19-21；PolicyController.java:60-83 | 源码（gap） |
 *
 * 行号只写在这里：`help` 里不放 Java 行号（屏上只留「[源码]」类别标签）。
 */

const agentProfile: MockDomain = {
    id: "agent-profile",
    label: "智能体档案",
    summary: "只有一个真键：Agent 在系统提示里怎么称呼你。它只是称呼，不参与权限判定。",
    layout: "form",
    groups: [
        {
            label: "身份",
            fields: [
                {
                    // [源码] config-schemas/agent-profile.json:4 —— 本域唯一的属性。
                    // [源码] 每次 Run 按配置快照重新解析（api/chat.py:402-403,551），
                    //        进程级默认值 app_state.py:509（空值回落 "User"）。
                    // [源码] 注入系统提示 "Current user: {user_name}"（prompts.py:9,35）。
                    key: "userName",
                    label: "用户名",
                    help: "[源码] Agent 每次 Run 都按配置快照重新解析（`api/chat.py:402-403`，进程级默认值见 `app_state.py:509`，空值回落 `User`），注入系统提示的 `Current user: {user_name}`（`agent/prompts.py:9,35`）。改完下一次 Run 就生效；它只是称呼，不影响权限——权限由 principal 与授权原子决定。",
                    control: "text",
                    value: "xihe-user",
                    writableAt: writableAtOf("agent-profile", "userName"),
                },
            ],
        },
    ],
};

/**
 * approval-policy：`mode` + `askActionClasses` 是真键；`toolFaces` 是 gap。
 *
 * 决策链 [源码] `PolicyEngine.java:146-161`：动作类**在 ask 清单里**才问人，不在清单里的
 * 直接放行；`auto` 模式把「在清单里」升级为放行并记 `allowed_by`。所以这两个键必须挨着看——
 * 只改 `mode` 而不看清单，会得到「以为放宽了其实没有」或反过来的结果。
 */
const approvalPolicy: MockDomain = {
    id: "approval-policy",
    label: "审批策略",
    summary:
        "两个真键决定「什么操作要人点确认」：模式管命中清单后是问还是放行，清单管哪些动作类算命中。",
    layout: "form",
    groups: [
        {
            label: "审批模式与提问清单",
            fields: [
                {
                    // [源码] approval-policy.json:4（enum manual|auto）。
                    // [源码] manual → 命中清单 ASK；auto → 命中清单 ALLOW + allowedBy=auto@<层>
                    //        （PolicyEngine.java:153-157、PolicyVerdict.java:25-27）。
                    // [源码] 受保护文件（AGENTS.md）的写入在 auto 下仍 ASK（PolicyEngine.java:257-273）。
                    // [源码] 值不合法/读不到 → 回落 manual（DbPolicyContextProvider.java:135-145）。
                    key: "mode",
                    label: "审批模式",
                    help: "[源码] `manual`：命中下面清单的动作类要人点确认；`auto`：命中清单的动作类直接放行，并在审计里记 `policy_allowed_by_mode=auto@<层>`。例外：写 AGENTS.md 这类受保护文件在 `auto` 下仍然要审批。值不合法或读不到配置一律按 `manual` 处理（fail-closed，不会因为读失败就放宽）。",
                    control: "select",
                    value: "manual",
                    options: ["manual", "auto"],
                    writableAt: writableAtOf("approval-policy", "mode"),
                },
                {
                    // [源码] approval-policy.json:5-8（字符串数组，条目 1-64 字符）。
                    // [源码] 只有命中清单才 ASK，未命中直接 ALLOW（PolicyEngine.java:149-152）。
                    // [源码] null（未配置）→ 7 项内置清单；显式 [] → 什么都不问（PolicyContext.java:36-38,70-74）。
                    // [源码] 解析失败（非数组/条目非字符串/超长）整串丢弃并回落内置清单
                    //        （DbPolicyContextProvider.java:162-190）。
                    key: "askActionClasses",
                    label: "需要审批的操作类（JSON 数组）",
                    help: "[源码] 只有**命中这个清单**的动作类才触发审批，不在清单里的直接放行。留空/未配置 ≠ 什么都不问：会回落 7 项内置清单（write / exec / delete / CREATE_ACCOUNT / CREATE_TEMPLATE / MANAGE_WORKSPACE_AGENTS / SPAWN_AGENT）；**显式写 `[]` 才是「什么都不问」**。条目必须是 1–64 字符的字符串，整串解析失败会被丢弃并回落内置清单。",
                    control: "textarea",
                    value: '["write","exec","delete","CREATE_ACCOUNT","CREATE_TEMPLATE","MANAGE_WORKSPACE_AGENTS","SPAWN_AGENT"]',
                    writableAt: writableAtOf("approval-policy", "askActionClasses"),
                },
            ],
        },
        {
            label: "工具面（不是配置键）",
            fields: [
                {
                    // [源码] 后端无此配置键：工具面在 tool_faces 表（ToolFaceEntity.java:19-21）。
                    // [源码] 解析顺序 instance → workspace，workspace 覆盖同名工具
                    //        （DbPolicyContextProvider.java:22-23,226-232）。
                    // [源码] 写入口 POST /api/v1/policy/tool-faces（PolicyController.java:71-83）。
                    // [源码] 未分类工具恒 ASK，auto 模式也不绕过（PolicyEngine.java:246-253）。
                    key: "toolFaces",
                    label: "工具面（tool → 动作类）",
                    help: "[源码] 不是独立配置键，也不是本域的字段：工具面存在 `tool_faces` 表里（scope 为 instance 或 workspace，workspace 覆盖 instance 的同名工具），只能经 `POST /api/v1/policy/tool-faces` 写。放在本页是因为它决定上面清单里的「动作类」到底落在哪些工具上——没分类的工具一律按未分类处理，永远要审批，`auto` 也不绕过。",
                    control: "textarea",
                    value: '{"write_file":"write","apply_patch":"write","execute_command":"exec"}',
                    writableAt: writableAtOf("approval-policy", "toolFaces"),
                    state: "gap",
                },
            ],
        },
    ],
};

export const domains: MockDomain[] = [agentProfile, approvalPolicy];

export default domains;
