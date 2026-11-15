package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-159（D-1529，更正 D-1527 的错约束）：`user-preference` 域新增两个**布局**键族
 * —— `layout.global` 与 `layout.ws.<workspaceId>`。
 *
 * <p><b>判据是「解析后的形状」，不是 wire 类型</b>。wire 侧 body 是
 * `Map&lt;String,String&gt;`（`ConfigController` 的 putLayer 签名），布局值是一段 **JSON 序列化文本**；
 * 而 `ConfigService.validateBySchema`（`:1949-1973`，PLAN-0307 T2.17 的存储契约）会在校验**之前**
 * 把以 `{` / `[` 开头的文本预解析成 `JsonNode`。所以 schema 看到的是**对象**：
 * 声明 `type: string` 会让真实 PUT 必然失败（`Schema validation failed: object found, string expected`，
 * 实测见 task-159 的临时探针；`D-1529` 就是这条更正）。</p>
 *
 * <p><b>本类不声明也不断言字节上限</b>：`maxLength` 只作用于字符串分支，预解析后不存在长度概念 ⇒
 * 当前形态**没有**强制上限（`D-1529` 的已知取舍）。UI 侧自限 4096 字符，服务端长度门另卡。
 * 读者不要误以为这里漏了一条断言。</p>
 *
 * <p>类的做派：手工 `new ConfigDomainSchema(...)` + `init()`（只扫 classpath，不拉 Spring 上下文）⇒
 * 毫秒级。**真实写路径**（含预解析与非 JSON 文本的 400）由
 * `ConfigDomainSchemaCoverageTest#layoutKeysFollowTheParsedShapeOnTheRealWritePath` 钉。</p>
 */
class UserPreferenceLayoutSchemaTest {

    private static final String DOMAIN = "user-preference";

    /** 一个合法的 workspace UUID（小写十六进制，CP 其它地方发的形态）。 */
    private static final String WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static ConfigDomainSchema schema;

    @BeforeAll
    static void loadSchemas() throws IOException {
        schema = new ConfigDomainSchema(MAPPER);
        schema.init();
        assertTrue(schema.hasSchema(DOMAIN), "user-preference must carry a schema file");
    }

    /** 一个真实的布局：面板集合 / 三处栏宽 / 组顺序。 */
    private static Map<String, Object> realLayout() {
        Map<String, Object> layout = new LinkedHashMap<>();
        layout.put("treeCollapsed", false);
        layout.put("treeWidth", 240);
        layout.put("dockWidth", 360);
        layout.put("dockMode", "pinned");
        layout.put("dockTabs", List.of("files", "memory", "jobs"));
        layout.put("activeDockTab", "files");
        return layout;
    }

    /**
     * 复算 `ConfigService.validateBySchema` 的预解析：值以 `{` / `[` 开头 ⇒ 解析成 JsonNode。
     * 这是**镜像**，只为让形状类用例保持毫秒级；真实路径的一致性由 Spring 那个用例保证。
     */
    private static Map<String, Object> effective(Map<String, String> wire) throws IOException {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : wire.entrySet()) {
            String trimmed = entry.getValue() == null ? "" : entry.getValue().trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                out.put(entry.getKey(), MAPPER.readTree(trimmed));
            } else {
                out.put(entry.getKey(), entry.getValue());
            }
        }
        return out;
    }

    private static List<String> validateWire(Map<String, String> wire) throws IOException {
        JsonNode body = MAPPER.valueToTree(effective(wire));
        return schema.validate(DOMAIN, body);
    }

    @Test
    void acceptsBothLayoutKeyFamiliesAsParsedObjects() throws JsonProcessingException {
        String layoutText = MAPPER.writeValueAsString(realLayout());
        Map<String, String> wire = new LinkedHashMap<>();
        wire.put("layout.global", layoutText);
        wire.put("layout.ws." + WS, layoutText);
        // 直接按预解析后的形状断言（对象），证明 additionalProperties:false 下两个键族都合法。
        JsonNode body = MAPPER.valueToTree(Map.of(
                "layout.global", realLayout(),
                "layout.ws." + WS, realLayout()));
        assertEquals(List.of(), schema.validate(DOMAIN, body),
                "layout.global (literal) and layout.ws.<uuid> (pattern) must both be legal objects");
    }

    @Test
    void aRealLayoutPayloadSurvivesTheWireRoundTrip() throws IOException {
        String layoutText = MAPPER.writeValueAsString(realLayout());
        assertEquals(List.of(), validateWire(Map.of("layout.global", layoutText)),
                "a real layout serialized to JSON text must pass the parsed-shape validation");
        assertEquals(List.of(), validateWire(Map.of("layout.ws." + WS, layoutText)),
                "same for the per-workspace family");
    }

    @Test
    void rejectsValuesThatAreNotJsonObjects() throws IOException {
        // 裸字符串（不以 { / [ 开头 ⇒ 不被预解析 ⇒ schema 看到 string，期望 object）
        assertFalse(validateWire(Map.of("layout.global", "not json at all")).isEmpty(),
                "a bare string must be rejected: the parsed shape is a string, not an object");
        // 数字文本同理
        assertFalse(validateWire(Map.of("layout.global", "123")).isEmpty(),
                "numeric text must be rejected");
        // 数组文本会被预解析成 array ⇒ 仍不是 object
        assertFalse(validateWire(Map.of("layout.ws." + WS, "[1,2,3]")).isEmpty(),
                "an array payload must be rejected: layout is an object, not a list");
    }

    @Test
    void rejectsAWorkspaceIdThatIsNotUuidShaped() throws IOException {
        for (String bad : List.of("not-a-uuid", WS + "-stale", "3f2504e04f8941d39a0c0305e82c3301")) {
            JsonNode body = MAPPER.valueToTree(
                    Map.of("layout.ws." + bad, realLayout()));
            assertFalse(schema.validate(DOMAIN, body).isEmpty(),
                    "layout.ws.<id> must reject non-UUID ids under additionalProperties:false; accepted: "
                            + bad);
        }
    }

    @Test
    void keepsTheExistingPreferenceKeysWorkingAndTheDomainClosed() throws IOException {
        // 既有 pattern 是 ^[a-z]{2}(-[A-Z][a-z]+)?$ ⇒ 合法值形如 zh-Hans（zh-CN 本来就不匹配，
        // 与本卡无关，见 D-1529 附记；不得在此"顺手改宽"）。
        assertEquals(List.of(), validateWire(Map.of("theme", "dark", "language", "zh-Hans")),
                "the two pre-existing keys must not regress");
        assertFalse(validateWire(Map.of("theme", "solarized")).isEmpty(),
                "the theme enum must still reject unknown values");
        assertFalse(validateWire(Map.of("layout", "{}")).isEmpty(),
                "additionalProperties:false must stay closed: the literal key 'layout' is not declared");
        assertFalse(validateWire(Map.of("layout.workspace", "{}")).isEmpty(),
                "near-miss key layout.workspace must stay rejected");
    }
}
