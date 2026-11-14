import { expect } from "vitest";

/**
 * 用户文案里**不得出现实现事实**（Lead 2026-11-15 裁定，`task-44` → 抽公共件供 `task-58` 复用）。
 *
 * <p>理由：用户看到 "409" / "MANAGE_ROLES" / "effective-cap" 会去搜「409 是什么」，而他要知道的
 * 只是「这件事在工作区里做」。这不是风格问题 —— 把内部协议写给用户，等于把我们的实现当成他的
 * 解释模型。</p>
 *
 * <p><b>按「键组」调用而不是做成全局规则</b>：合法出现错误码的地方（错误提示要把 CP 的
 * `problem.code` 翻成人话，也可能照实说"服务器返回 403 但你仍可查看"）不能被这条误伤。
 * 所以调用方自己声明被检查的那几句属于哪一组。</p>
 *
 * @param copy 该组的**纯用户可见文本**（不要把 aria/title/测试名混进来）
 * @param groupName 组名，进断言消息，便于失败时定位是哪一段文案
 */
export function expectNoInternalFacts(copy: string, groupName: string) {
    expect(copy.trim().length, `${groupName}：文案不能为空）`).toBeGreaterThan(0);
    expect(
        copy,
        `${groupName}：用户文案里出现了内部实现事实（错误码 / 原子名 / 端点名）`,
    ).not.toMatch(/409|403|MANAGE_[A-Z_]+|effective-cap|\/api\//);
}
