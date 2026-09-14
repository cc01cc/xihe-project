package com.cc01cc.p.xihe.cp.policy;

/**
 * Tool shape. See PLAN-0328 spec/approval.md §8.1.
 *
 * <ul>
 *   <li>STRUCTURED — bounded effect (file/CRUD style tools); approval binding may include the
 *       resolved target.</li>
 *   <li>INTERPRETER — unbounded effect (shell/exec style); binding is argv-only.</li>
 *   <li>OPAQUE — third-party MCP tool with unknown semantics; default ask + no reuse.</li>
 * </ul>
 */
public enum ToolShape {
    STRUCTURED,
    INTERPRETER,
    OPAQUE
}
