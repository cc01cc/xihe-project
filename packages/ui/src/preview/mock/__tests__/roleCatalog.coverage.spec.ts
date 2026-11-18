import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { mockApiPlugin } from "../api-server";
import { deriveRoleCatalog, mockRoleCatalog, ROLE_CATALOG_SOURCES } from "../data/roleCatalog";

/**
 * task-84：\`GET /api/v1/roles/catalog\` mock 夹具的**机器判据**。
 *
 * <p><b>为什么要这道门</b>：这条面此前在 mock 车道是 404，角色页整页渲染成「该页面需要的服务端能力
 * 还没提供」；补夹具最容易踩的坑是**手抄一份原子表** —— 那既不会红也不会绿，只会让页面看起来正常而
 * 少了几个选项（\`D-1485\` 的「第二份清单」）。所以本门判的不是「形状对不对」，而是
 * 「**这 44 个名字是不是 CP 真会认的那些**」（task-188 MVP⑤ S2 起：40→41 action atoms，
 * 新增 TEAM_TASK_MANAGE —— 夹具从 CP 源码派生、本数随 CP 词汇表同批刷新）。</p>
 *
 * <p><b>判据分四层，每层都能红</b>：</p>
 * <ol>
 *   <li><b>词汇表（本轮核心，复用 task-70 的读法）</b>：每个非能力原子名都必须在
 *       \`ToolFaceRegistry.builtinActionClasses()\` 的方法体里（\`//\` 注释先剥掉 —— 否则
 *       「在词汇表里」是句空话）；反之，该集合必须**等于** mock 的动作原子集，
 *       「漏一个」与「多一个」都红。</li>
 *   <li><b>能力原子</b>：\`cap:*\` 三个不在动作词汇表里（它们是授权前缀，不是 action class），
 *       因此单独判：必须出现在 \`PermissionAtomCatalog\` 的 \`CAP_*\` 声明值里，
 *       且 mock 只标 3 个 \`capability: true\`。</li>
 *   <li><b>派生 vs 独立读</b>：spec 自己**再读一遍** \`INSTANCE_ONLY_ATOMS\` / \`AGENT_FORBIDDEN_ATOMS\`
 *       与 \`roleSeeds()\` 的角色名，和 mock 的 \`scopeClass\` / \`agentPrincipalForbidden\` /
 *       \`defaultGrants\` 比**集合相等**。派生代码与判据各算一次、走不同路径 ⇒ 派生错位会露出来
 *       （同源同法只能证明自己和自己一致）。</li>
 *   <li><b>接线</b>：走真实中间件打 \`GET /roles/catalog\` 拿 200 + 43 原子；\`locale=en-US\` 拿英文
 *       文案（CP 两侧都有，不需要猜）；**写面仍然是 404** \`MOCK_ENDPOINT_MISSING\`
 *       （\`POST /roles\` / \`PATCH /roles/{id}\`）—— 这是有意留的边界，不是缺口。</li>
 * </ol>
 *
 * <p><b>反空集前提</b>：读不到 CP 源码时**抛**（不是 skip）；词汇表大小 &gt; 20 且
 * \`builtinActionClasses()\` 签名找得到，否则「每条都在词汇表里」是空集上的全称断言，恒真。</p>
 */

const CP_POLICY_DIR = resolve(
    process.cwd(),
    "../control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy",
);
const TOOL_FACE_REGISTRY = resolve(CP_POLICY_DIR, "ToolFaceRegistry.java");
const ATOM_CATALOG = resolve(CP_POLICY_DIR, "PermissionAtomCatalog.java");
const SYSTEM_ROLES = resolve(CP_POLICY_DIR, "SystemAccessRoleCatalog.java");
const SIGNATURE = "public static Set<String> builtinActionClasses()";

if (!existsSync(TOOL_FACE_REGISTRY) || !existsSync(ATOM_CATALOG) || !existsSync(SYSTEM_ROLES)) {
    throw new Error(
        "task-84 判据需要 CP 源码：" +
            [TOOL_FACE_REGISTRY, ATOM_CATALOG, SYSTEM_ROLES].join(", ") +
            " 有文件不存在。本包单测假定 UI 与 control-plane 在同一检出（同 packages/）；" +
            "只用 ui 单体检出时这道门无法判定，请按仓库拓扑跑（不要改成 skip）。",
    );
}

/** 去注释：注释里写满原子名（「PLAN-0750 M1 … CREATE_OWN_AGENT」），留着判据就变成空话。 */
function code(source: string): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

const TFR = code(readFileSync(TOOL_FACE_REGISTRY, "utf8"));
const PAC = code(readFileSync(ATOM_CATALOG, "utf8"));
const SARC = code(readFileSync(SYSTEM_ROLES, "utf8"));

/** \`public static final String X = "V";\` ⇒ X → V（只认这一种声明形态）。 */
function declarations(source: string): Map<string, string> {
    const table = new Map<string, string>();
    for (const hit of source.matchAll(/public static final String ([A-Z0-9_]+) = "([^"]+)";/g)) {
        table.set(hit[1], hit[2]);
    }
    return table;
}

const CONSTANTS = new Map<string, string>([
    ...declarations(TFR),
    ...declarations(PAC),
    ...declarations(SARC),
]);

/** 括号体（从 marker 之后第一个左括号起配平）。 */
function parenBody(source: string, marker: string): string {
    const at = source.indexOf(marker);
    if (at < 0) throw new Error("task-84 判据：CP 源码里找不到 [" + marker + "]");
    const open = source.indexOf("(", at);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "(") depth += 1;
        else if (source[index] === ")") {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }
    throw new Error("task-84 判据：[" + marker + "] 括号不配平");
}

/** 括号体里的常量名 ⇒ 声明值。 */
function values(body: string): string[] {
    const out: string[] = [];
    for (const hit of body.matchAll(
        /(?:ToolFaceRegistry\.|PermissionAtomCatalog\.)?([A-Z][A-Z0-9_]*)/g,
    )) {
        const value = CONSTANTS.get(hit[1]);
        if (value !== undefined) out.push(value);
    }
    return out;
}

/** \`builtinActionClasses()\` 的方法体（与 task-70 同一读法：从签名后第一个 \`{\` 到第一个 \`}\`）。 */
const BUILTIN_START = TFR.indexOf(SIGNATURE);
const BUILTIN_BODY = (() => {
    if (BUILTIN_START <= 0) return "";
    const open = TFR.indexOf("{", BUILTIN_START);
    const close = TFR.indexOf("}", open);
    return TFR.slice(open, close);
})();

/** 词汇表：方法体引用的 \`ACTION_*\` 常量 ⇒ 声明值（去重）。 */
const VOCABULARY = new Set(
    [...BUILTIN_BODY.matchAll(/ACTION_[A-Z0-9_]+/g)]
        .map((hit) => CONSTANTS.get(hit[0]))
        .filter((value): value is string => typeof value === "string"),
);

/** 独立读的 \`INSTANCE_ONLY_ATOMS\` / \`AGENT_FORBIDDEN_ATOMS\`（用于与派生结果比集合相等）。 */
const INSTANCE_ONLY = new Set(values(parenBody(PAC, "INSTANCE_ONLY_ATOMS = Set.of")));
const AGENT_FORBIDDEN = new Set(values(parenBody(PAC, "AGENT_FORBIDDEN_ATOMS = Set.of")));
const CAPABILITY_CONSTANTS = values(parenBody(PAC, "CAPABILITY_ATOM_NAMES = List.of"));

/**
 * 独立读的 8 个系统角色名：`new RoleSeed(UUID, NAME, displayName, description, atoms)` 的**第二个**实参。
 *
 * <p>第一个实参是 `SUPER_ADMIN_ID` 这类 `public static final UUID`（不是 String 常量），所以按
 * 「`new RoleSeed(` 之后走一遍顶层逗号切分」取第 2 段 —— 与派生侧**各算一遍**（同源同法只能证明
 * 自己和自己一致）。</p>
 */
function topLevelArguments(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let current = "";
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            current += char;
            if (char === String.raw`\\`) {
                current += text[index + 1] ?? "";
                index += 1;
            } else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') {
            quoted = true;
            current += char;
        } else if (char === "(" || char === "{" || char === "[") {
            depth += 1;
            current += char;
        } else if (char === ")" || char === "}" || char === "]") {
            depth -= 1;
            current += char;
        } else if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    parts.push(current.trim());
    return parts;
}

const SYSTEM_ROLE_NAMES = (() => {
    const at = SARC.indexOf("public static List<RoleSeed> roleSeeds()");
    if (at < 0) throw new Error("task-84 判据：roleSeeds() 不在了");
    const open = SARC.indexOf("{", at);
    let depth = 0;
    let close = open;
    for (let index = open; index < SARC.length; index += 1) {
        if (SARC[index] === "{") depth += 1;
        else if (SARC[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                close = index;
                break;
            }
        }
    }
    const body = SARC.slice(open, close);
    const names: string[] = [];
    for (const hit of body.matchAll(/new RoleSeed\(/g)) {
        const from = (hit.index ?? 0) + "new RoleSeed".length;
        const openParen = body.indexOf("(", from);
        let parenDepth = 0;
        let endParen = openParen;
        for (let index = openParen; index < body.length; index += 1) {
            if (body[index] === "(") parenDepth += 1;
            else if (body[index] === ")") {
                parenDepth -= 1;
                if (parenDepth === 0) {
                    endParen = index;
                    break;
                }
            }
        }
        const name = CONSTANTS.get(topLevelArguments(body.slice(openParen + 1, endParen))[1] ?? "");
        if (name === undefined) throw new Error("roleSeeds 的角色常量解析不到");
        names.push(name);
    }
    if (names.length === 0)
        throw new Error("task-84 判据：roleSeeds() 里没解析出角色名（空集不是通过）");
    return names;
})();

const CATALOG = mockRoleCatalog("zh-CN");
const CATALOG_EN = mockRoleCatalog("en-US");
const actionAtoms = CATALOG.atoms.filter((atom) => !atom.capability);
const capabilityAtoms = CATALOG.atoms.filter((atom) => atom.capability);

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 与 providerConnections.coverage.spec.ts 同形的挂载（假 server + 假 req）。 */
function mountApiHandler(): ApiHandler {
    let handler: ApiHandler | null = null;
    const plugin = mockApiPlugin();
    const server = {
        middlewares: {
            use: (first: unknown, second?: unknown) => {
                if (first === "/api/v1" && typeof second === "function") {
                    handler = second as ApiHandler;
                }
            },
        },
    };
    (plugin as unknown as { configureServer: (s: unknown) => void }).configureServer(server);
    if (!handler) throw new Error("mock api middleware 未注册");
    return handler;
}

function call(handler: ApiHandler, url: string, method = "GET", body?: unknown): Promise<Captured> {
    return new Promise((resolveCaptured, reject) => {
        const payload = body === undefined ? [] : [JSON.stringify(body)];
        const req = Readable.from(payload) as unknown as Record<string, unknown>;
        req.method = method;
        req.url = url;
        req.headers = {};
        const res = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            setHeader(key: string, value: string) {
                this.headers[key] = value;
            },
            end(text?: string) {
                try {
                    resolveCaptured({
                        status: (this as unknown as { statusCode: number }).statusCode,
                        body: text ? JSON.parse(text) : null,
                    });
                } catch (cause) {
                    reject(cause);
                }
            },
        };
        handler(req, res);
    });
}

describe("task-84 · /roles/catalog mock 夹具（形状与派生）", () => {
    it("判据前提：CP 词汇表读到了（否则下面几条是全绿的空门）", () => {
        // ≠ 造绿：词汇表为空时「每个 mock 原子都在词汇表里」是空集上的全称断言，恒真。
        expect(
            BUILTIN_START,
            "CP 的 builtinActionClasses() 签名不在了（改名要同批改这道门）",
        ).toBeGreaterThan(0);
        expect(VOCABULARY.size).toBeGreaterThan(20);
        // 44 = 41 action + 3 capability 是本卡的读取值（task-188 MVP⑤ S2 加 TEAM_TASK_MANAGE）；
        // 写成常量断言，CP 增原子时这里先红。
        expect(actionAtoms).toHaveLength(41);
        expect(capabilityAtoms).toHaveLength(3);
        expect(VOCABULARY.size).toBe(actionAtoms.length);
    });

    it("词汇表相等（不漏不多）：mock 的 41 个动作原子 == builtinActionClasses()", () => {
        const mockActions = new Set(actionAtoms.map((atom) => atom.name));
        // 两侧都要「相等」：只在一边有用的是另一个方向的漏洞（漏一个不报、多一个也只报一边）。
        for (const name of mockActions) {
            expect(VOCABULARY, name + " 不在 CP 的 builtinActionClasses() 词汇表里").toContain(
                name,
            );
        }
        for (const name of VOCABULARY) {
            expect(mockActions, name + " 在 CP 词汇表里而 mock 漏了").toContain(name);
        }
    });

    it("能力原子：3 个 cap:* 且都不是动作原子（能力原子不进 builtinActionClasses）", () => {
        const names = capabilityAtoms.map((atom) => atom.name);
        expect(names).toEqual(["instance:super", "instance:admin", "workspace:admin"]);
        // 独立读 CAPABILITY_ATOM_NAMES 再比一次（不信任派生内部的一致性）。
        expect(names).toEqual(CAPABILITY_CONSTANTS);
        for (const name of names) {
            expect(VOCABULARY, name + " 不该出现在动作词汇表里").not.toContain(name);
        }
        // 能力原子在授权里是 cap: 前缀，不是 action class。
        for (const atom of capabilityAtoms) expect(atom.name.startsWith("cap:")).toBe(false);
    });

    it("scopeClass / agentPrincipalForbidden 与 CP 的 INSTANCE_ONLY_ATOMS / AGENT_FORBIDDEN_ATOMS 集合相等", () => {
        const instanceOnlyMock = new Set(
            CATALOG.atoms.filter((atom) => atom.scopeClass === "instance").map((atom) => atom.name),
        );
        const forbiddenMock = new Set(
            CATALOG.atoms.filter((atom) => atom.agentPrincipalForbidden).map((atom) => atom.name),
        );
        // 两个方向都比：派生少标 / 多标都要红（单向断言只挡一半）。
        for (const name of INSTANCE_ONLY) {
            expect(instanceOnlyMock, name + " 在 CP 是 instance-only，mock 没标").toContain(name);
        }
        for (const name of instanceOnlyMock) {
            expect(INSTANCE_ONLY, name + " 被 mock 标成 instance-only，CP 里不在该集合").toContain(
                name,
            );
        }
        expect(instanceOnlyMock.size).toBe(INSTANCE_ONLY.size);
        for (const name of AGENT_FORBIDDEN) {
            expect(forbiddenMock, name + " 在 CP 里对 agent 禁用，mock 没标").toContain(name);
        }
        for (const name of forbiddenMock) {
            expect(AGENT_FORBIDDEN, name + " 被 mock 标成禁用，CP 里不在该集合").toContain(name);
        }
        expect(forbiddenMock.size).toBe(AGENT_FORBIDDEN.size);
        // scopeClass 的取值域就是两个（openapi RoleAtomView 的 enum）。
        for (const atom of CATALOG.atoms) expect(["instance", "both"]).toContain(atom.scopeClass);
    });

    it("resource 规则：credential 族是 credential:*，其余是 *（PermissionAtomCatalog:319-323）", () => {
        for (const atom of actionAtoms) {
            const expected = atom.name.startsWith("credential_") ? "credential:*" : "*";
            expect(atom.resource, atom.name).toBe(expected);
        }
        // 能力原子的 resource 恒为 *（buildAtoms 里写死 WILDCARD）。
        for (const atom of capabilityAtoms) expect(atom.resource).toBe("*");
        // 至少一条 credential 族存在，否则上面那条 credential 分支是空转。
        expect(actionAtoms.some((atom) => atom.name.startsWith("credential_"))).toBe(true);
    });

    it("scopes 是 AccessScope 的 wire 值 [instance, workspace]（不是原子 scopeClass 的 instance|both）", () => {
        expect(CATALOG.scopes).toEqual(["instance", "workspace"]);
    });

    it("displayName：zh-CN 全部本地化、en-US 换成英文，且都非空（CP 有双语标签）", () => {
        const zh = CATALOG.atoms.map((atom) => atom.displayName);
        const en = CATALOG_EN.atoms.map((atom) => atom.displayName);
        expect(zh.every((name) => name.length > 0)).toBe(true);
        expect(en.every((name) => name.length > 0)).toBe(true);
        // 至少多数条目在两侧不同 ⇒ 证明 locale 真的被用上了，不是「回退成原子名」。
        const changed = zh.filter((name, index) => name !== en[index]).length;
        expect(changed).toBeGreaterThan(35);
        // 中文侧至少有一条含 CJK：防止整份回退成机器码（那正是 tier (c) 的退路，这里用不上）。
        expect(zh.some((name) => /[\u4e00-\u9fa5]/.test(name))).toBe(true);
    });

    it("defaultGrants：8 个系统角色 + atoms 是字符串数组（openapi RoleDefaultGrantView）", () => {
        expect(CATALOG.defaultGrants).toHaveLength(8);
        expect(CATALOG.defaultGrants.map((grant) => grant.roleName)).toEqual(SYSTEM_ROLE_NAMES);
        const known = new Set(CATALOG.atoms.map((atom) => atom.name));
        for (const grant of CATALOG.defaultGrants) {
            // atoms 是 **string[]**（不是 RoleAtomView 对象）—— 这是最容易抄错的一处。
            for (const atomName of grant.atoms) {
                expect(typeof atomName, grant.roleName).toBe("string");
                expect(known, grant.roleName + " 的默认授予里有不存在的原子 " + atomName).toContain(
                    atomName,
                );
            }
            expect(grant.displayName.length, grant.roleName).toBeGreaterThan(0);
            // CP 侧是 distinct()：重复项在这里就是抄重了。
            expect(new Set(grant.atoms).size, grant.roleName).toBe(grant.atoms.length);
        }
        // SUPER_ADMIN 拿到全集（含 3 个能力原子）—— 这条能让 defaultGrants 的派生真的被判定。
        const superAdmin = CATALOG.defaultGrants[0];
        expect(superAdmin.roleName).toBe("SUPER_ADMIN");
        expect(superAdmin.atoms).toHaveLength(CATALOG.atoms.length);
        expect(superAdmin.atoms).toContain("instance:super");
        const wsViewer = CATALOG.defaultGrants.find((grant) => grant.roleName === "WS_VIEWER");
        expect(wsViewer?.atoms).toEqual(["read", "USE_WORKSPACE_RUNTIME"]);
    });

    it("派生可独立调用（不依赖 mockRoleCatalog 的缓存）且来源清单每条都指向真文件", () => {
        // deriveRoleCatalog 是纯函数入口：同一 locale 两次派生深相等（缓存是另一层的事）。
        const again = deriveRoleCatalog("en-US");
        expect(again).toEqual(CATALOG_EN);
        expect(again).not.toBe(CATALOG_EN);
        // 来源清单（文件头那 6 条）：**每条都点名真文件**，文件没了这条就红 —— 否则头注释里的
        // file:line 会静默过期，第二个人按它去核对时对不上。
        expect(ROLE_CATALOG_SOURCES.length).toBe(6);
        for (const entry of ROLE_CATALOG_SOURCES) {
            const file = entry.split(":")[0];
            expect(
                existsSync(resolve(CP_POLICY_DIR, file)),
                "来源清单点名的文件不存在：" + file,
            ).toBe(true);
        }
    });

    it("fixture 稳定：同 locale 两次取到同一对象；未知 locale 回退 zh-CN（CP 既有语义）", () => {
        expect(mockRoleCatalog("zh-CN")).toBe(CATALOG);
        expect(mockRoleCatalog("zh")).toBe(CATALOG);
        expect(mockRoleCatalog("en-US")).toBe(CATALOG_EN);
        expect(mockRoleCatalog("fr-FR")).toBe(CATALOG);
    });
});

describe("task-84 · /roles/catalog 走真实中间件（接线 + 边界）", () => {
    const handler = mountApiHandler();

    it("GET /roles/catalog?locale=zh-CN ⇒ 200 且 44 原子（此前是 404 MOCK_ENDPOINT_MISSING）", async () => {
        const answer = await call(handler, "/roles/catalog?locale=zh-CN");
        expect(answer.status).toBe(200);
        const body = answer.body as {
            atoms: unknown[];
            scopes: unknown[];
            defaultGrants: unknown[];
        };
        expect(Array.isArray(body.atoms)).toBe(true);
        expect(body.atoms).toHaveLength(44);
        expect(body.scopes).toEqual(["instance", "workspace"]);
        expect(body.defaultGrants).toHaveLength(8);
        // 形状对齐 openapi RoleAtomView（字段齐、类型对）。
        for (const atom of body.atoms as Record<string, unknown>[]) {
            for (const key of [
                "name",
                "scopeClass",
                "capability",
                "resource",
                "displayName",
                "agentPrincipalForbidden",
            ]) {
                expect(atom, "RoleAtomView 缺字段 " + key).toHaveProperty(key);
            }
        }
    });

    it("locale 参数真的被消费：en-US 拿英文、zh-CN 拿中文，同一原子两侧不同", async () => {
        const zh = (await call(handler, "/roles/catalog?locale=zh-CN")).body as {
            atoms: { name: string; displayName: string }[];
        };
        const en = (await call(handler, "/roles/catalog?locale=en-US")).body as {
            atoms: { name: string; displayName: string }[];
        };
        const zhRead = zh.atoms.find((atom) => atom.name === "read")?.displayName;
        const enRead = en.atoms.find((atom) => atom.name === "read")?.displayName;
        expect(zhRead).toBe("读取");
        expect(enRead).toBe("Read");
        expect(zhRead).not.toBe(enRead);
        // 缺省 locale（不传）按 zh-CN。
        const fallback = (await call(handler, "/roles/catalog")).body as { atoms: unknown[] };
        expect(fallback.atoms).toHaveLength(44);
    });

    it("GET /roles 仍是裸数组（角色列表读面不受本次改动影响）", async () => {
        const answer = await call(handler, "/roles");
        expect(answer.status).toBe(200);
        expect(Array.isArray(answer.body)).toBe(true);
        expect((answer.body as unknown[]).length).toBeGreaterThan(0);
    });

    it("写面**有意**仍是 404 MOCK_ENDPOINT_MISSING（不复刻半套 CP 状态机）", async () => {
        // task-72 的裁定：只复刻一半的写面 ⇒ 「mock 里点得通、真栈 409」的假通过。
        const created = await call(handler, "/roles", "POST", {
            name: "MOCK_ROLE",
            displayName: "x",
            atoms: [],
        });
        expect(created.status).toBe(404);
        expect((created.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
        const patched = await call(handler, "/roles/whatever", "PATCH", { displayName: "y" });
        expect(patched.status).toBe(404);
        // 定向：只补了 catalog 一条面，/roles/<id> 的 GET 仍 404（不通配 200）。
        const detail = await call(handler, "/roles/whatever");
        expect(detail.status).toBe(404);
    });
});
