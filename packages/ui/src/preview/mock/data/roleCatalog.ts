import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * task-84：GET /api/v1/roles/catalog?locale= 的 mock 夹具 —— **从 CP 源码派生，不抄第二份清单**。
 *
 * <p><b>选档理由（(b) 全量派生，卡面要求写死）</b>：本仓此前在 e2e 夹具
 * （e2e/mock/helpers/stub-families.ts 的 ROLE_CATALOG_FIXTURE）里手抄了 **9 个原子子集**，
 * 头注释自己写着「子集不是全集：真实 43 个」。子集在 e2e 里够用（那里只验身份投影里真会判的原子），
 * 但预览车道的价值是「让人看见真实形态」：只给 9 个 ⇒ 角色编辑器的原子选择器缺 34 项，
 * 等于把「可选原子」这件事在预览里说成 9 个。而**再抄一份 43 个**就是 D-1485 那类「第二份清单」
 * —— 手抄件随 CP 增原子必然滞后，且滞后时页面**看起来正常**（少几个选项没人报错）。
 * ⇒ 选 **(b) 从 CP 源码派生全量**（Lead 倾向），代价与边界见下方。</p>
 *
 * <p><b>派生来源（逐项，file:line 见 ROLE_CATALOG_SOURCES）</b>：本模块在运行时读下面 4 个 Java 源文件：</p>
 * <ul>
 *   <li>policy/ToolFaceRegistry.java —— 常量**声明值**（:20-146 一带）与 builtinActionClasses()
 *       词汇表（:260-308）。后者是 GrantIntersectionEvaluator 校验 grant 的集合
 *       （「a constant without this line is invisible」，:266-267）。</li>
 *   <li>policy/PermissionAtomCatalog.java —— 原子**顺序**（ACTION_ATOM_NAMES :148-224 /
 *       CAPABILITY_ATOM_NAMES :226-227）、scope_class（INSTANCE_ONLY_ATOMS :230-264）、
 *       agentPrincipalForbidden（AGENT_FORBIDDEN_ATOMS :96-146）、resource 规则
 *       （actionResource :319-323：credential 族用 credential:*，其余 *）。</li>
 *   <li>policy/PermissionAtomLabels.java —— displayName（put(labels, REF, 中文, 英文)，:49-134）。
 *       **两语都可派生** ⇒ 这里没有 e2e 夹具那条「en-US 也回 zh-CN」的妥协（e2e 夹具承认自己在猜）。</li>
 *   <li>policy/SystemAccessRoleCatalog.java —— defaultGrants（roleSeeds() :129-299，含
 *       BASE_ATOMS :80-93 / USER_DEFAULT_ATOMS :107-117 / CREDENTIAL_ATOMS :75-78 /
 *       superAdminAtoms() :301-306 的展开规则）。</li>
 * </ul>
 *
 * <p><b>边界（必须知道）</b>：① 这是**源码文本解析**，不是编译期契约 —— CP 改了声明形态
 * （换 record、改成 Map.of、把 list 拆成方法调用）会让 deriveRoleCatalog() **抛错**而不是静默少几项；
 * 抛错时 /roles/catalog 明确失败（**不是**回一个短清单冒充全量），单测同批红。
 * ② 派生只在 Node 侧发生（预览 mock 是 vite 中间件、单测是 forks 池）⇒ **本模块不得被浏览器入口 import**
 * （node:fs 在浏览器里不存在；目前唯一消费方是 api-server.ts，它只被 vite.config.ts 与单测 import）。
 * ③ defaultGrants 的 description 是源码字符串字面量的拼接结果，**不本地化** —— CP 的 RoleSeed
 * 描述本来就只有英文一份，UI 也不渲染它（RolesView 只消费 atoms / roles）。
 * ④ 本模块**不提供写面**：角色/绑定的 POST/PATCH/DELETE 仍走 404 兜底（CP 侧有配额、授权、
 * 409 状态机，只复刻一半就是「mock 里点得通、真栈 409」的假通过 —— 同 task-72 的裁定）。</p>
 */

/** CP 的 policy 包相对检出根的路径（UI 与 CP 是 packages/ 下的兄弟包）。 */
const CP_POLICY_RELATIVE = "control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy";

const CP_POLICY_FILE = {
    toolFace: "ToolFaceRegistry.java",
    atomCatalog: "PermissionAtomCatalog.java",
    atomLabels: "PermissionAtomLabels.java",
    systemRoles: "SystemAccessRoleCatalog.java",
    accessScope: "AccessScope.java",
} as const;

export type CpSourceFile = (typeof CP_POLICY_FILE)[keyof typeof CP_POLICY_FILE];

/** 与 openapi RoleAtomView（:7066-7075）逐字段对齐；displayName 恒非空。 */
export interface MockRoleAtomView {
    name: string;
    scopeClass: "instance" | "both";
    capability: boolean;
    resource: string;
    displayName: string;
    agentPrincipalForbidden: boolean;
}

/** openapi RoleDefaultGrantView（:7084-7091）：required roleName / displayName / atoms。 */
export interface MockRoleDefaultGrantView {
    roleName: string;
    displayName: string;
    description: string | null;
    atoms: string[];
}

/** openapi RoleCatalogView（:7076-7083）：required atoms / scopes / defaultGrants。 */
export interface MockRoleCatalogView {
    atoms: MockRoleAtomView[];
    scopes: string[];
    defaultGrants: MockRoleDefaultGrantView[];
}

/**
 * 定位 CP 的 policy 目录。两种 cwd 都认（cwd = packages/ui 的 pnpm 脚本、cwd = 仓根的 mise run），
 * 都没有就抛 —— 派生门读不到源码时必须是「门在这里断了」，不是静默空表。
 */
function cpPolicyDir(): string {
    const candidates = [
        resolve(process.cwd(), "..", CP_POLICY_RELATIVE),
        resolve(process.cwd(), "packages", CP_POLICY_RELATIVE),
    ];
    for (const candidate of candidates) {
        if (existsSync(resolve(candidate, CP_POLICY_FILE.toolFace))) return candidate;
    }
    throw new Error(
        "task-84 夹具需要 CP 源码做派生：未找到 " +
            candidates.join(" | ") +
            " 里的 " +
            CP_POLICY_FILE.toolFace +
            "。预览 mock 假定 UI 与 control-plane 在同一检出（同 packages/）；" +
            "只用 ui 单体检出时本夹具无法派生（不要改成回退手抄表）。",
    );
}

function readCpFile(dir: string, file: CpSourceFile): string {
    const full = resolve(dir, file);
    if (!existsSync(full)) {
        throw new Error("task-84 夹具需要 CP 源码，但该文件不存在：" + full);
    }
    return readFileSync(full, "utf8");
}

/** 去行注释：正文注释里到处写原子名（「PLAN-0750 M1 … CREATE_OWN_AGENT」），留着会把「在集合里」变成空话。 */
function withoutLineComments(source: string): string {
    // 用 replace + /g 而不是 replaceAll：本包 tsconfig 的 lib 是 ES2020（没有 replaceAll）。
    return source.replace(/\/\/[^\n]*/g, "");
}

/** 去块注释：Javadoc 里同样写满原子名与计数（Action atoms (40)），判据只能认代码。 */
function withoutBlockComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** public static final String ACTION_X = "VALUE"; ⇒ ACTION_X → VALUE（只认这一种声明形态）。 */
function declaredConstants(source: string): Map<string, string> {
    const table = new Map<string, string>();
    for (const hit of source.matchAll(/public static final String ([A-Z0-9_]+) = "([^"]+)";/g)) {
        table.set(hit[1], hit[2]);
    }
    return table;
}

/** 从 marker 之后第一个左括号起取配平的括号体。 */
function parenBodyAfter(source: string, marker: string): string {
    const at = source.indexOf(marker);
    if (at < 0) {
        throw new Error(
            "task-84 派生失败：CP 源码里找不到 [" +
                marker +
                "]（CP 改结构了，派生与判据要同批改）。",
        );
    }
    const open = source.indexOf("(", at);
    if (open < 0) {
        throw new Error("task-84 派生失败：[" + marker + "] 后面没有括号体。");
    }
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        const char = source[index];
        if (char === "(") depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }
    throw new Error("task-84 派生失败：[" + marker + "] 的括号不配平。");
}

/** 括号体里引用的常量名 ⇒ 声明值。不认识的大写标识符（局部变量、方法名）跳过。 */
function constantValues(body: string, table: Map<string, string>): string[] {
    const values: string[] = [];
    const pattern =
        /(?:ToolFaceRegistry\.|PermissionAtomCatalog\.|SystemAccessRoleCatalog\.)?([A-Z][A-Z0-9_]*)/g;
    for (const hit of body.matchAll(pattern)) {
        const value = table.get(hit[1]);
        if (value !== undefined) values.push(value);
    }
    return values;
}

/** 声明值 ⇒ 常量名（反向表，供标签表按常量名对位；CP 里值唯一）。 */
function constantNamesByValue(table: Map<string, string>): Map<string, string> {
    const reverse = new Map<string, string>();
    for (const [name, value] of table) if (!reverse.has(value)) reverse.set(value, name);
    return reverse;
}

/** 标签表：put(labels, REF, 中文, 英文) ⇒ 常量名 → 双语。 */
function atomLabels(source: string): Map<string, { zh: string; en: string }> {
    const labels = new Map<string, { zh: string; en: string }>();
    const pattern =
        /put\(\s*labels\s*,\s*(?:ToolFaceRegistry\.|PermissionAtomCatalog\.)?([A-Z0-9_]+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
    for (const hit of source.matchAll(pattern)) {
        labels.set(hit[1], { zh: unescapeJavaString(hit[2]), en: unescapeJavaString(hit[3]) });
    }
    return labels;
}

function unescapeJavaString(raw: string): string {
    return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

interface CpSources {
    /** 去注释后的 ToolFaceRegistry 源码。 */
    toolFace: string;
    /** 去注释后的 PermissionAtomCatalog 源码（原子顺序 / scope_class / 禁用集）。 */
    atomCatalog: string;
    /** 去注释后的 SystemAccessRoleCatalog 源码（defaultGrants 的来源）。 */
    systemRoles: string;
    labels: Map<string, { zh: string; en: string }>;
    /** AccessScope 的两个 scope 类型（instance / workspace）。 */
    scopes: string[];
    constants: Map<string, string>;
}

function loadCpSources(dir = cpPolicyDir()): CpSources {
    const toolFace = withoutLineComments(readCpFile(dir, CP_POLICY_FILE.toolFace));
    const atomCatalog = withoutBlockComments(
        withoutLineComments(readCpFile(dir, CP_POLICY_FILE.atomCatalog)),
    );
    const labelsSource = withoutBlockComments(
        withoutLineComments(readCpFile(dir, CP_POLICY_FILE.atomLabels)),
    );
    const systemRoles = withoutBlockComments(
        withoutLineComments(readCpFile(dir, CP_POLICY_FILE.systemRoles)),
    );
    const scopesSource = withoutBlockComments(
        withoutLineComments(readCpFile(dir, CP_POLICY_FILE.accessScope)),
    );
    const constants = new Map<string, string>([
        ...declaredConstants(toolFace),
        ...declaredConstants(atomCatalog),
        ...declaredConstants(systemRoles),
        // AccessScope:15-16 的 INSTANCE / WORKSPACE 是 scopes 的来源（值是小写枚举原值）。
        ...declaredConstants(scopesSource),
    ]);
    const scopes = [constants.get("INSTANCE"), constants.get("WORKSPACE")].filter(
        (value): value is string => typeof value === "string",
    );
    if (scopes.length !== 2) {
        throw new Error(
            "task-84 派生失败：AccessScope 的 INSTANCE / WORKSPACE 常量读不到（scopes 要两个值）。",
        );
    }
    if (!scopesSource.includes(constants.get("INSTANCE") ?? "\u0000")) {
        throw new Error("task-84 派生失败：AccessScope 源码里没有 INSTANCE 的声明值。");
    }
    return {
        toolFace,
        atomCatalog,
        systemRoles,
        labels: atomLabels(labelsSource),
        scopes,
        constants,
    };
}

interface CpVocabulary {
    actionAtoms: string[];
    capabilityAtoms: string[];
    instanceOnly: Set<string>;
    agentForbidden: Set<string>;
}

/** CP 的原子顺序与分类（PermissionAtomCatalog:148-227 与 :96-264）。 */
function atomVocabulary(sources: CpSources): CpVocabulary {
    return {
        actionAtoms: constantValues(
            parenBodyAfter(sources.atomCatalog, "ACTION_ATOM_NAMES = List.of"),
            sources.constants,
        ),
        capabilityAtoms: constantValues(
            parenBodyAfter(sources.atomCatalog, "CAPABILITY_ATOM_NAMES = List.of"),
            sources.constants,
        ),
        instanceOnly: new Set(
            constantValues(
                parenBodyAfter(sources.atomCatalog, "INSTANCE_ONLY_ATOMS = Set.of"),
                sources.constants,
            ),
        ),
        agentForbidden: new Set(
            constantValues(
                parenBodyAfter(sources.atomCatalog, "AGENT_FORBIDDEN_ATOMS = Set.of"),
                sources.constants,
            ),
        ),
    };
}

/**
 * displayName：CP 的 PermissionAtomLabels.label() 对未登记原子回退**原子名本身**
 * （:32-38 与 :19 的注释），这里照该语义 —— 不另建一份「必须登记的原子」清单。
 */
function atomDisplayName(sources: CpSources, atomName: string, locale: string): string {
    const constant = constantNamesByValue(sources.constants).get(atomName);
    const byLocale = constant ? sources.labels.get(constant) : undefined;
    if (!byLocale) return atomName;
    return locale.trim().toLowerCase().startsWith("en") ? byLocale.en : byLocale.zh;
}

/** AtomRef.wildcard 的 resource 规则（PermissionAtomCatalog:319-323 + ToolFaceRegistry:150-152）。 */
function canonicalResource(sources: CpSources, atomName: string): string {
    const credentialPrefix = sources.constants.get("CREDENTIAL_ACTION_PREFIX") ?? "credential_";
    const credentialWildcard =
        sources.constants.get("CREDENTIAL_RESOURCE_WILDCARD") ?? "credential:*";
    const wildcard = sources.constants.get("WILDCARD") ?? "*";
    return atomName.startsWith(credentialPrefix) ? credentialWildcard : wildcard;
}

/** 一条 RoleSeed 的原子表达式 ⇒ 原子名（展开 BASE_ATOMS / USER_DEFAULT_ATOMS / CREDENTIAL_ATOMS / superAdminAtoms()）。 */
function expandSeedAtoms(opts: {
    expression: string;
    sources: CpSources;
    bodies: Map<string, string>;
    vocabulary: CpVocabulary;
}): string[] {
    const { expression, sources, bodies, vocabulary } = opts;
    let text = expression;
    for (let round = 0; round < 8; round += 1) {
        const before = text;
        for (const [name, body] of bodies) {
            text = text.replace(new RegExp(String.raw`\b${name}\b`, "g"), () => body);
        }
        if (text === before) break;
    }
    const names: string[] = [];
    const pattern =
        /superAdminAtoms\(\)|AtomRef\.wildcard\(\s*(?:ToolFaceRegistry\.|PermissionAtomCatalog\.)?([A-Za-z0-9_]+)\s*\)/g;
    for (const hit of text.matchAll(pattern)) {
        if (hit[0] === "superAdminAtoms()") {
            names.push(...vocabulary.actionAtoms, ...vocabulary.capabilityAtoms);
            continue;
        }
        const name = sources.constants.get(hit[1]);
        if (name === undefined) {
            throw new Error(
                "task-84 派生失败：RoleSeed 里的常量 [" + hit[1] + "] 解析不到声明值。",
            );
        }
        names.push(name);
    }
    // CP 侧是 stream().map(AtomRef::actionClass).distinct()（RoleAdminService:128-129）⇒ 保序去重。
    return [...new Set(names)];
}

/** new RoleSeed(...) 的实参切分：只在顶层逗号处切，括号与字符串里的逗号不算。 */
function splitTopLevelArguments(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let current = "";
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            current += char;
            if (char === "\\") {
                current += text[index + 1] ?? "";
                index += 1;
            } else if (char === '"') {
                quoted = false;
            }
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

/** Java 字符串字面量拼接（"a" + "b"）⇒ 结果。 */
function stringLiteralValue(expression: string): string {
    return [...expression.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map((hit) => unescapeJavaString(hit[1]))
        .join("");
}

/** SystemAccessRoleCatalog:75-117 的三个种子常量（defaultGrants 的展开表）。 */
function seedBodies(sources: CpSources): Map<string, string> {
    const table = new Map<string, string>();
    for (const marker of ["CREDENTIAL_ATOMS = ", "BASE_ATOMS = ", "USER_DEFAULT_ATOMS = "]) {
        table.set(marker.split(" = ")[0], parenBodyAfter(sources.systemRoles, marker));
    }
    return table;
}

/** 配平某个方法的方法体（roleSeeds 里逐条 new RoleSeed(...)）。 */
function methodBody(source: string, signature: string): string {
    const at = source.indexOf(signature);
    if (at < 0) {
        throw new Error(
            "task-84 派生失败：CP 源码里找不到 [" +
                signature +
                "]（defaultGrants 的来源，需同批改）。",
        );
    }
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(open, index + 1);
        }
    }
    throw new Error("task-84 派生失败：[" + signature + "] 的花括号不配平。");
}

/** 括号配平取值（与 parenBodyAfter 同形，但按位置起算）。 */
function parenBodyAt(source: string, from: number): { text: string; end: number } {
    const open = source.indexOf("(", from);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "(") depth += 1;
        else if (source[index] === ")") {
            depth -= 1;
            if (depth === 0) return { text: source.slice(open + 1, index), end: index };
        }
    }
    throw new Error("task-84 派生失败：括号不配平。");
}

function defaultGrants(sources: CpSources, vocabulary: CpVocabulary): MockRoleDefaultGrantView[] {
    const body = methodBody(sources.systemRoles, "public static List<RoleSeed> roleSeeds()");
    const bodies = seedBodies(sources);
    const grants: MockRoleDefaultGrantView[] = [];
    for (const hit of body.matchAll(/new RoleSeed\(/g)) {
        const args = splitTopLevelArguments(parenBodyAt(body, (hit.index ?? 0) + 1).text);
        const roleName = sources.constants.get(args[1] ?? "");
        if (roleName === undefined) {
            throw new Error(
                "task-84 派生失败：RoleSeed 的 name 实参 [" +
                    (args[1] ?? "") +
                    "] 解析不到声明值。",
            );
        }
        const description = stringLiteralValue(args[3] ?? "");
        grants.push({
            roleName,
            displayName: stringLiteralValue(args[2] ?? ""),
            description: description.length > 0 ? description : null,
            atoms: expandSeedAtoms({ expression: args[4] ?? "", sources, bodies, vocabulary }),
        });
    }
    if (grants.length === 0) {
        throw new Error("task-84 派生失败：roleSeeds() 里一条 RoleSeed 都没解析出来。");
    }
    return grants;
}

/**
 * 派生整份 RoleCatalogView（openapi :5519-5535 的 getRoleCatalog 与 :7066-7091 的三个 schema）。
 *
 * <p>locale 与服务端口径一致：en* ⇒ en-US 文案，其余 ⇒ zh-CN（PermissionAtomLabels:42-47）。
 * 未知 locale 不是错误，回退 zh-CN 是 CP 的既有语义。</p>
 */
export function deriveRoleCatalog(locale = "zh-CN", dir = cpPolicyDir()): MockRoleCatalogView {
    const sources = loadCpSources(dir);
    const vocabulary = atomVocabulary(sources);
    const capabilitySet = new Set(vocabulary.capabilityAtoms);
    const atoms: MockRoleAtomView[] = [
        ...vocabulary.actionAtoms,
        ...vocabulary.capabilityAtoms,
    ].map((atomName) => ({
        name: atomName,
        scopeClass: vocabulary.instanceOnly.has(atomName) ? "instance" : "both",
        capability: capabilitySet.has(atomName),
        resource: canonicalResource(sources, atomName),
        displayName: atomDisplayName(sources, atomName, locale),
        agentPrincipalForbidden: vocabulary.agentForbidden.has(atomName),
    }));
    return { atoms, scopes: sources.scopes, defaultGrants: defaultGrants(sources, vocabulary) };
}

/** 派生来源清单（写进卡面/回执用；CP 改结构时这些锚点会先红在单测里）。 */
export const ROLE_CATALOG_SOURCES = [
    "ToolFaceRegistry.java:20-146 常量声明 / :260-308 builtinActionClasses() 词汇表",
    "PermissionAtomCatalog.java:148-224 ACTION_ATOM_NAMES / :226-227 CAPABILITY_ATOM_NAMES",
    "PermissionAtomCatalog.java:230-264 INSTANCE_ONLY_ATOMS / :96-146 AGENT_FORBIDDEN_ATOMS",
    "PermissionAtomLabels.java:49-134 displayName（zh-CN / en-US 双语）",
    "SystemAccessRoleCatalog.java:129-299 roleSeeds()（defaultGrants），展开 :75-117 三个种子常量",
    "AccessScope.java:15-16 scopes = instance / workspace",
] as const;

/**
 * 预览 mock 的入口：按 locale 取夹具，**懒派生 + 缓存**（每份 locale 只读一次 CP 源码）。
 *
 * <p>为什么不在模块顶层就派生：CP 源码缺失时（例如只检出 ui 包）顶层派生会让 **import 即抛**，
 * 也就是 api-server.ts / vite.config.ts 整个挂掉 —— 一条面的缺口会连坐整条 mock 车道。
 * 懒派生把失败面收窄到 `GET /roles/catalog` 本身（dispatch 里转 500 并带原因），
 * 其余端点照常。**仍然不静默**：失败不会回退成手抄表或空清单。</p>
 *
 * <p>locale 归一与服务端一致：`en*` ⇒ en-US，其余 ⇒ zh-CN（未知 locale 回退是 CP 既有语义）。</p>
 */
const catalogCache = new Map<string, MockRoleCatalogView>();

export function mockRoleCatalog(locale = "zh-CN"): MockRoleCatalogView {
    const key = locale.trim().toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
    let view = catalogCache.get(key);
    if (view === undefined) {
        view = deriveRoleCatalog(key);
        catalogCache.set(key, view);
    }
    return view;
}
