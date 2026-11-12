package com.cc01cc.p.xihe.cp.support;

import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-11（task-255 全量分桶）静态守卫：把 148 个 AbstractIntegrationTest 体系类锁进两个互斥且穷尽的桶——
 * reusable（AbstractReusableIntegrationTest，共享 1 个上下文）与 per-class（白名单
 * context-reuse/per-class-whitelist.tsv，保持原基类/原 context key）。
 *
 * <p>三道锁：(R1) reusable 类不得带 per-class 标记，@DynamicPropertySource/@TestPropertySource/
 * @ActiveProfiles/@DirtiesContext/mockito bean override 属 context key 本体**无逃生口**；@BeforeAll/@AfterAll/
 * @Nested/@Async 等可选标记只允许带 // context-reuse-ok: <理由> 且逐条打印（预算 10）。
 * (R2/R3) 白名单与复用桶互斥且穷尽 148 类；白名单判定码与源码推导严格一致、类必须存在（stale/漂移即红）。
 *
 * <p>判定码推导是静态文本启发式（去注释 + 行首注解 + 并发/SSE 类型 + 类自己的 @SpringBootTest 参数变体）。
 * 它是 ratchet 不是证明：误判成 per-class 只损失时间；漏判方向由 R2 兜住（未迁移类必须在白名单显式登记）。
 *
 * <p><b>R4（task-29，context key 注解 ratchet）</b>：全测试树里会改 TestContext cache key 的 9 类注解
 * （{@code @DirtiesContext} / {@code @DynamicPropertySource} / {@code @ActiveProfiles} /
 * {@code @TestPropertySource} / {@code @MockitoBean} / {@code @MockitoSpyBean} / {@code @Import} /
 * {@code @TestConfiguration} / {@code @SpringBootTest}）必须逐条登记在
 * {@code context-reuse/context-cache-key-annotations.tsv}。基线由
 * {@code node scripts/check-context-cache-key-annotations.mjs --write} 重算（禁止手抄），守卫用同一
 * 口径重扫并双向比对：新增未登记 ⇒ 红（打印 annotation+file）；基线残留行 ⇒ 红（防腐化）；reasonCode
 * 由注解类别推导，不接受自定义理由；行序必须稳定（annotation,file 升序），防止手插行。</p>
 */
class ContextReuseBucketingTest {

    /** 可选标记豁免预算（照 Jackson2NodeWireScanTest：只许收紧）。 */
    static final int EXEMPTION_BUDGET = 10;

    static final String EXEMPTION_MARKER = "context-reuse-ok:";

    static final Path TEST_SOURCES = Path.of("src/test/java");

    static final String WHITELIST_RESOURCE = "/context-reuse/per-class-whitelist.tsv";

    /** task-29 R4：全测试树 context cache-key 注解基线（生成脚本产出，禁止手抄）。 */
    static final String CONTEXT_KEY_RESOURCE = "/context-reuse/context-cache-key-annotations.tsv";

    /**
     * task-29：会改 Spring TestContext cache key 的 9 类注解 → 推导 reasonCode。
     *
     * <p>reasonCode 是**注解类别**的函数（不是人工理由）：这样基线行既不能编造解释，也不需要第二套
     * 判定逻辑；九类之外出现的新注解类型必须先改这里（并用脚本重算基线），等于每次扩面都要过一道卡。</p>
     */
    static final Map<String, String> CONTEXT_KEY_ANNOTATIONS = new LinkedHashMap<>();

    static {
        CONTEXT_KEY_ANNOTATIONS.put("@SpringBootTest", "suite-context");
        CONTEXT_KEY_ANNOTATIONS.put("@DirtiesContext", "isolation");
        CONTEXT_KEY_ANNOTATIONS.put("@TestPropertySource", "property-variant");
        CONTEXT_KEY_ANNOTATIONS.put("@DynamicPropertySource", "property-variant");
        CONTEXT_KEY_ANNOTATIONS.put("@ActiveProfiles", "profile-variant");
        CONTEXT_KEY_ANNOTATIONS.put("@MockitoBean", "bean-override");
        CONTEXT_KEY_ANNOTATIONS.put("@MockitoSpyBean", "bean-override");
        CONTEXT_KEY_ANNOTATIONS.put("@Import", "fixture-config");
        CONTEXT_KEY_ANNOTATIONS.put("@TestConfiguration", "fixture-config");
    }

    static final String BASE_PACKAGE = "com.cc01cc.p.xihe.cp.";

    static final String REUSABLE_BASE = "AbstractReusableIntegrationTest";

    static final String PER_CLASS_BASE = "AbstractIntegrationTest";

    /** 判定码枚举（与 TSV 表头同源）。 */
    record Marker(String code, Pattern pattern, boolean strict) {
    }

    private static final List<Marker> MARKERS = List.of(
            strict("dynamic-property-source", "^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?DynamicPropertySource\\b"),
            strict("test-property-source", "^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?TestPropertySource\\b"),
            strict("active-profiles", "^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?ActiveProfiles\\b"),
            strict("dirties-context", "^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?DirtiesContext\\b"),
            strict("mockito-bean", "^\\s*@(?:MockitoBean|MockitoSpyBean|MockBean|SpyBean)\\b|^\\s*@org\\."
                    + "springframework\\.test\\.context\\.bean\\.override\\.mockito\\.Mockito(?:Bean|SpyBean)\\b"),
            strict("test-configuration", "^\\s*@(?:Import\\(|TestConfiguration|ContextConfiguration|BootstrapWith)"),
            strict("docker-frozen", "^\\s*@Tag\\([^)]*docker-frozen"),
            optional("async-sse", "\\b(?:ExecutorService|CompletableFuture|CountDownLatch|CyclicBarrier|Phaser|"
                    + "SseEmitter|StreamingResponseBody)\\b|new\\s+Thread\\(|\\btext/event-stream\\b|^\\s*@Async\\b"),
            optional("before-all", "^\\s*@(?:BeforeAll|AfterAll)\\b"),
            optional("nested", "^\\s*@Nested\\b"),
            optional("test-listeners", "^\\s*@(?:TestExecutionListeners|RecordApplicationEvents|Sql\\()"),
            optional("test-constructor", "^\\s*@TestConstructor\\b"));

    /** 手动判定码：只允许 design §4.1 已批准的「提交/派发 async chat run」17 类。 */
    static final String MANUAL_CHAT_RUN_DISPATCH = "chat-run-dispatch";

    static final Set<String> ASYNC_CHAT_RUN_CLASSES = Set.of(
            BASE_PACKAGE + "chat.SessionPrimaryParticipantTest",
            BASE_PACKAGE + "service.AgentPrincipalVisibilityContractTest",
            BASE_PACKAGE + "chat.ChatRunContextTruncationIntegrationTest",
            BASE_PACKAGE + "chat.ChatRunGuidanceHttpIntegrationTest",
            BASE_PACKAGE + "chat.ChatRunGuidanceRecoveryIntegrationTest",
            BASE_PACKAGE + "chat.ChatRunGuidanceServiceIntegrationTest",
            BASE_PACKAGE + "chat.ChatSubmissionServiceIntegrationTest",
            BASE_PACKAGE + "chat.DelegationBudgetSpawnIntegrationTest",
            BASE_PACKAGE + "chat.DelegationTimeoutPropagationIntegrationTest",
            BASE_PACKAGE + "chat.ForkPropagationTest",
            BASE_PACKAGE + "chat.RunTraceControllerIntegrationTest",
            BASE_PACKAGE + "chat.SessionParticipantHttpTest",
            BASE_PACKAGE + "chat.SkillSnapshotFreezeIntegrationTest",
            BASE_PACKAGE + "chat.SkillSnapshotPrincipalContrastTest",
            BASE_PACKAGE + "chat.SpawnLifecycleTest",
            BASE_PACKAGE + "mcp.McpInvocationIntegrationTest",
            BASE_PACKAGE + "migration.StateEnumConformanceTest");

    /** Boot 4 bean override 注解改名表（@SpyBean -> @MockitoSpyBean、@MockBean -> @MockitoBean；@MockitoBean 无旧名）。 */
    static final Map<String, String> BOOT4_BEAN_OVERRIDE_RENAMES = Map.of(
            "@SpyBean", "@MockitoSpyBean",
            "@MockBean", "@MockitoBean");

    private static Marker strict(String code, String regex) {
        return new Marker(code, Pattern.compile(regex, Pattern.MULTILINE), true);
    }

    private static Marker optional(String code, String regex) {
        return new Marker(code, Pattern.compile(regex, Pattern.MULTILINE), false);
    }

    // ------------------------------------------------------------------ R1

    @Test
    void reusableClassesCarryNoPerClassMarkers() throws IOException {
        List<ScannedClass> classes = scan();
        List<String> violations = new ArrayList<>();
        List<String> exemptions = new ArrayList<>();
        for (ScannedClass candidate : classes) {
            if (!REUSABLE_BASE.equals(candidate.base())) {
                continue;
            }
            if (candidate.manual().contains(MANUAL_CHAT_RUN_DISPATCH)) {
                violations.add(candidate.relative() + " [" + MANUAL_CHAT_RUN_DISPATCH + "] -> 异步 chat run 类只能 per-class");
            }
            for (Marker marker : MARKERS) {
                if (!candidate.derived().contains(marker.code())) {
                    continue;
                }
                int line = firstMatchLine(candidate, marker);
                if (marker.strict()) {
                    violations.add(candidate.relative() + ":" + line + " [" + marker.code() + "] -> context key 本体，无逃生口");
                    continue;
                }
                String exemption = exemptionReason(candidate, line);
                if (exemption == null) {
                    violations.add(candidate.relative() + ":" + line + " [" + marker.code() + "] -> 缺 // context-reuse-ok: <理由>");
                } else {
                    exemptions.add(candidate.relative() + ":" + line + " [" + marker.code() + "] -> " + exemption);
                }
            }
        }
        assertEquals(List.of(), violations, "reusable 类不得带 per-class 标记（严格标记无逃生口）：" + violations);
        assertTrue(exemptions.size() <= EXEMPTION_BUDGET, "可选标记豁免超过预算（" + EXEMPTION_BUDGET + "）：" + exemptions);
        System.out.println("[context-reuse] reusable 桶可选标记豁免（" + exemptions.size() + "）：");
        exemptions.forEach(exemption -> System.out.println("  " + exemption));
    }

    // ------------------------------------------------------------ R2 / R3

    @Test
    void whitelistAndReusableBucketPartitionEveryIntegrationBaseClass() throws IOException {
        Map<String, WhitelistEntry> whitelist = loadWhitelist();
        List<ScannedClass> classes = scan();
        List<String> problems = new ArrayList<>();
        int perClass = 0;
        int reusable = 0;
        for (ScannedClass candidate : classes) {
            WhitelistEntry entry = whitelist.get(candidate.fqcn());
            if (PER_CLASS_BASE.equals(candidate.base())) {
                perClass++;
                if (entry == null) {
                    problems.add("per-class 基类但未登记白名单：" + candidate.fqcn());
                    continue;
                }
                Set<String> declaredDerived = new LinkedHashSet<>(entry.codes());
                declaredDerived.removeAll(manualCodes());
                if (!declaredDerived.equals(candidate.derived())) {
                    problems.add("判定码漂移 " + candidate.fqcn() + " 声明=" + declaredDerived + " 推导=" + candidate.derived());
                }
                Set<String> declaredManual = new LinkedHashSet<>(entry.codes());
                declaredManual.retainAll(manualCodes());
                if (!declaredManual.equals(candidate.manual())) {
                    problems.add("手动判定码漂移 " + candidate.fqcn() + " 声明=" + declaredManual + " 推导=" + candidate.manual());
                }
                if (entry.note() == null || entry.note().isBlank()) {
                    problems.add("白名单缺判定说明：" + candidate.fqcn());
                }
            } else if (REUSABLE_BASE.equals(candidate.base())) {
                reusable++;
                if (entry != null) {
                    problems.add("reusable 基类但出现在 per-class 白名单：" + candidate.fqcn());
                }
            }
        }
        for (String fqcn : whitelist.keySet()) {
            if (classes.stream().noneMatch(candidate -> candidate.fqcn().equals(fqcn))) {
                problems.add("白名单条目对应类不存在（stale）：" + fqcn);
            }
        }
        assertEquals(List.of(), problems, "白名单/复用桶必须互斥且穷尽 155 类：" + problems);
        assertEquals(77, whitelist.size(), "per-class 白名单 = 77（51 flagged + 5 @MockitoSpyBean + 17 §4.1 async-chat + 1 0691 T1.6b + 1 0646 MVP + 1 0642 MVP + 2 0647 3.1/3.2 + 1 0705 + 1 0767，去重）");
        assertEquals(77, perClass, "per-class 类数必须等于白名单条目数");
        assertEquals(78, reusable, "reusable 桶 = 78（实测读数，含 task-309 新增审计类 1 类）");
        assertEquals(155, classes.size(), "155 = 77 per-class + 78 reusable");
        Map<String, Integer> counts = new TreeMap<>();
        for (WhitelistEntry entry : whitelist.values()) {
            for (String code : entry.codes()) {
                counts.merge(code, 1, Integer::sum);
            }
        }
        System.out.println("[context-reuse] per-class=" + perClass + " reusable=" + reusable
                + " total=" + classes.size() + "；判定码计数=" + counts);
    }

    // --------------------------------------------------- Boot 4 rename table

    @Test
    void boot4BeanOverrideRenameTableIsEnforced() throws IOException {
        System.out.println("[context-reuse] Boot 4 bean override 改名表：");
        System.out.println("  @SpyBean -> @MockitoSpyBean");
        System.out.println("  @MockBean -> @MockitoBean");
        System.out.println("  @MockitoBean -> (Boot 4 新增名，无 pre-Boot4 对应)");
        assertEquals(Set.of("mockito-bean"), derive("@MockitoSpyBean private Object x;"), "改名后的 @MockitoSpyBean 必须被识别");
        assertEquals(Set.of("mockito-bean"), derive("@MockitoBean private Object x;"), "改名后的 @MockitoBean 必须被识别");
        List<String> stale = new ArrayList<>();
        for (ScannedClass candidate : scan()) {
            Matcher matcher = Pattern.compile("^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?(SpyBean|MockBean)\\b", Pattern.MULTILINE)
                    .matcher(stripComments(candidate.source()));
            while (matcher.find()) {
                stale.add(candidate.relative() + " -> @" + matcher.group(1) + "（应改为 "
                        + BOOT4_BEAN_OVERRIDE_RENAMES.get("@" + matcher.group(1)) + "）");
            }
        }
        assertEquals(List.of(), stale, "测试源码仍用 Boot 3 旧注解名：" + stale);
    }

    // -------------------------------------------------------------- scanner

    record ScannedClass(String fqcn, String relative, String base, Set<String> derived, Set<String> manual, String source) {
    }

    record WhitelistEntry(Set<String> codes, String note) {
    }

    static Set<String> manualCodes() {
        return Set.of(MANUAL_CHAT_RUN_DISPATCH);
    }

    private static List<ScannedClass> scan() throws IOException {
        assertTrue(Files.isDirectory(TEST_SOURCES), "守卫必须在 packages/control-plane 目录下运行（src/test/java 缺失）");
        List<ScannedClass> classes = new ArrayList<>();
        try (Stream<Path> files = Files.walk(TEST_SOURCES)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String source = Files.readString(file, StandardCharsets.UTF_8);
                Matcher extendsMatcher = Pattern.compile("extends\\s+(" + PER_CLASS_BASE + "|" + REUSABLE_BASE + ")\\b").matcher(source);
                if (!extendsMatcher.find()) {
                    continue;
                }
                String relative = TEST_SOURCES.relativize(file).toString().replace('\\', '/');
                String base = extendsMatcher.group(1);
                String fqcn = relative.replace(".java", "").replace('/', '.');
                classes.add(new ScannedClass(fqcn, relative, base, derive(source), manual(fqcn), source));
            }
        }
        return classes;
    }

    static Set<String> derive(String source) {
        Set<String> codes = new LinkedHashSet<>();
        String stripped = stripComments(source);
        for (Marker marker : MARKERS) {
            if (marker.pattern().matcher(stripped).find()) {
                codes.add(marker.code());
            }
        }
        if (bootTestVariant(stripped)) {
            codes.add("boot-test-variant");
        }
        return codes;
    }

    private static Set<String> manual(String fqcn) {
        return ASYNC_CHAT_RUN_CLASSES.contains(fqcn) ? Set.of(MANUAL_CHAT_RUN_DISPATCH) : Set.of();
    }

    /** 类自己的 @SpringBootTest 若参数与基类逐字相同则不算变体（同 key 可共享）。 */
    private static boolean bootTestVariant(String source) {
        String base = "@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)";
        String normalizedBase = base.replaceAll("\\s+", " ").trim();
        String[] lines = source.split("\\n", -1);
        Pattern annotationStart = Pattern.compile("^\\s*@SpringBootTest\\b");
        for (int index = 0; index < lines.length; index++) {
            if (!annotationStart.matcher(lines[index]).find()) {
                continue;
            }
            String annotation = lines[index].trim();
            int cursor = index;
            while (!annotation.contains(")") && cursor + 1 < lines.length && cursor - index < 4) {
                cursor++;
                annotation = annotation + " " + lines[cursor].trim();
            }
            if (!annotation.replaceAll("\\s+", " ").trim().equals(normalizedBase)) {
                return true;
            }
        }
        return false;
    }

    /** 去掉块注释与行注释（判定码推导口径：注释里提到的标记不算证据）。 */
    static String stripComments(String source) {
        String withoutBlocks = source.replaceAll("/\\*[\\s\\S]*?\\*/", "");
        StringBuilder builder = new StringBuilder();
        for (String line : withoutBlocks.split("\\n", -1)) {
            int comment = indexOfLineComment(line);
            builder.append(comment >= 0 ? line.substring(0, comment) : line).append('\n');
        }
        return builder.toString();
    }

    private static int indexOfLineComment(String line) {
        boolean inString = false;
        for (int index = 0; index + 1 < line.length(); index++) {
            char current = line.charAt(index);
            if (current == '"' && (index == 0 || line.charAt(index - 1) != '\\')) {
                inString = !inString;
            }
            if (!inString && current == '/' && line.charAt(index + 1) == '/') {
                return index;
            }
        }
        return -1;
    }

    private static int firstMatchLine(ScannedClass candidate, Marker marker) {
        String[] lines = stripComments(candidate.source()).split("\\n", -1);
        for (int index = 0; index < lines.length; index++) {
            if (marker.pattern().matcher(lines[index]).find()) {
                return index + 1;
            }
        }
        return 0;
    }

    /** 可选标记逃生口：标记行或前一行带 // context-reuse-ok: <理由>；返回值=理由（无=null）。 */
    private static String exemptionReason(ScannedClass candidate, int lineNumber) {
        String[] lines = candidate.source().split("\\n", -1);
        for (int probe = Math.max(0, lineNumber - 1); probe <= Math.min(lineNumber, lines.length - 1); probe++) {
            String line = lines[probe];
            int marker = line.indexOf(EXEMPTION_MARKER);
            if (marker >= 0) {
                String reason = line.substring(marker + EXEMPTION_MARKER.length()).trim();
                return reason.isEmpty() ? "(无理由)" : reason;
            }
        }
        return null;
    }

    private static Map<String, WhitelistEntry> loadWhitelist() throws IOException {
        try (InputStream stream = ContextReuseBucketingTest.class.getResourceAsStream(WHITELIST_RESOURCE)) {
            assertNotNull(stream, "缺少白名单资源 " + WHITELIST_RESOURCE);
            Map<String, WhitelistEntry> entries = new LinkedHashMap<>();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                reader.lines()
                        .filter(line -> !line.isBlank() && !line.startsWith("#"))
                        .forEach(line -> {
                            String[] columns = line.split("\\t", 3);
                            assertTrue(columns.length >= 2, "白名单列不足（FQCN TAB 判定码 TAB 说明）：" + line);
                            Set<String> codes = columns[1].isBlank()
                                    ? Set.of()
                                    : new LinkedHashSet<>(List.of(columns[1].split(",")));
                            String note = columns.length > 2 ? columns[2].trim() : "";
                            entries.put(columns[0].trim(), new WhitelistEntry(codes, note));
                        });
            }
            return entries;
        }
    }

    /** 防止「判定码枚举」表头与 TSV 实际使用脱节：TSV 只允许出现枚举内的码。 */
    @Test
    void whitelistUsesOnlyKnownCodes() throws IOException {
        Set<String> known = new LinkedHashSet<>(manualCodes());
        MARKERS.forEach(marker -> known.add(marker.code()));
        known.add("boot-test-variant");
        List<String> unknown = new ArrayList<>();
        for (Map.Entry<String, WhitelistEntry> entry : loadWhitelist().entrySet()) {
            for (String code : entry.getValue().codes()) {
                if (!known.contains(code)) {
                    unknown.add(entry.getKey() + " -> " + code);
                }
            }
        }
        assertFalse(known.isEmpty(), "判定码枚举不能为空");
        assertEquals(List.of(), unknown, "白名单出现枚举外的判定码：" + unknown);
    }

    // ------------------------------------------------- R4 (task-29 context-key ratchet)

    record ContextKeyRow(String annotation, String relative, String reason) {
    }

    /** 基线解析结果：rows = 已登记行；problems = 列数/词汇/文件存在/重复/行序问题（自洽性用）。 */
    record ContextKeyBaseline(Map<String, ContextKeyRow> rows, List<String> problems) {
    }

    /**
     * R4（task-29）：全测试树里会改 TestContext cache key 的 9 类注解必须登记在基线 TSV 里。
     *
     * <p>双向比对：新增未登记 ⇒ 红（打印 annotation+file，照卡面要求）；基线残留行 ⇒ 红（防腐化，
     * 基线只能随源码一起缩）；reasonCode 漂移 ⇒ 红（必须由注解类别推导）。重算基线：
     * {@code node scripts/check-context-cache-key-annotations.mjs --write}。</p>
     */
    @Test
    void contextCacheKeyAnnotationsAreRegisteredInBaseline() throws IOException {
        ContextKeyBaseline baseline = loadContextKeyBaseline();
        Map<String, ContextKeyRow> current = scanContextKeyAnnotations();
        List<String> added = new ArrayList<>();
        List<String> stale = new ArrayList<>();
        List<String> drifted = new ArrayList<>();
        for (Map.Entry<String, ContextKeyRow> entry : current.entrySet()) {
            ContextKeyRow registered = baseline.rows().get(entry.getKey());
            if (registered == null) {
                added.add(entry.getValue().annotation() + "  " + entry.getValue().relative());
            } else if (!registered.reason().equals(entry.getValue().reason())) {
                drifted.add(entry.getValue().annotation() + "  " + entry.getValue().relative()
                        + " 基线=" + registered.reason() + " 推导=" + entry.getValue().reason());
            }
        }
        for (Map.Entry<String, ContextKeyRow> entry : baseline.rows().entrySet()) {
            if (!current.containsKey(entry.getKey())) {
                stale.add(entry.getValue().annotation() + "  " + entry.getValue().relative());
            }
        }
        assertEquals(List.of(), added, "新增的 context-key 注解未登记基线（重算：node scripts/"
                + "check-context-cache-key-annotations.mjs --write，禁止手抄）：" + added);
        assertEquals(List.of(), stale, "基线行已无对应注解（防腐化：删除该行或用生成脚本重写）：" + stale);
        assertEquals(List.of(), drifted, "基线 reasonCode 必须由注解类别推导：" + drifted);
        assertFalse(current.isEmpty(), "扫描必须命中最少一条注解（否则 R4 口径失效）");
        Map<String, Integer> counts = new TreeMap<>();
        for (ContextKeyRow row : current.values()) {
            counts.merge(row.annotation(), 1, Integer::sum);
        }
        System.out.println("[context-reuse] context-key R4：rows=" + current.size()
                + " baseline=" + baseline.rows().size() + "；注解计数=" + counts);
    }

    /** R4 自洽性：基线表本身必须能读（3 列 / 9 类词汇 / 推导 reasonCode / 文件存在 / 无重复 / 行序稳定）。 */
    @Test
    void contextCacheKeyBaselineIsSelfConsistent() throws IOException {
        ContextKeyBaseline baseline = loadContextKeyBaseline();
        assertEquals(List.of(), baseline.problems(), "context-key 基线表不自洽（格式/词汇/文件/行序）："
                + baseline.problems());
        assertFalse(baseline.rows().isEmpty(), "空基线会让 R4 永远绿");
        assertEquals(9, CONTEXT_KEY_ANNOTATIONS.size(), "task-29 固定 9 类注解；扩面必须先改守卫与生成脚本");
        System.out.println("[context-reuse] context-key 基线自洽（" + baseline.rows().size()
                + " 行，reasonCode 词汇=" + new LinkedHashSet<>(CONTEXT_KEY_ANNOTATIONS.values()) + "）");
    }

    private static Map<String, ContextKeyRow> scanContextKeyAnnotations() throws IOException {
        assertTrue(Files.isDirectory(TEST_SOURCES),
                "守卫必须在 packages/control-plane 目录下运行（src/test/java 缺失）");
        Map<String, ContextKeyRow> rows = new LinkedHashMap<>();
        try (Stream<Path> files = Files.walk(TEST_SOURCES)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).sorted().toList()) {
                String relative = TEST_SOURCES.relativize(file).toString().replace('\\', '/');
                String stripped = stripComments(Files.readString(file, StandardCharsets.UTF_8));
                for (Map.Entry<String, String> annotation : CONTEXT_KEY_ANNOTATIONS.entrySet()) {
                    Pattern pattern = Pattern.compile("^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?"
                            + annotation.getKey().substring(1) + "\\b", Pattern.MULTILINE);
                    if (pattern.matcher(stripped).find()) {
                        rows.put(annotation.getKey() + "\t" + relative,
                                new ContextKeyRow(annotation.getKey(), relative, annotation.getValue()));
                    }
                }
            }
        }
        return rows;
    }

    private static ContextKeyBaseline loadContextKeyBaseline() throws IOException {
        try (InputStream stream = ContextReuseBucketingTest.class.getResourceAsStream(CONTEXT_KEY_RESOURCE)) {
            assertNotNull(stream, "缺少 context-key 基线资源 " + CONTEXT_KEY_RESOURCE);
            Map<String, ContextKeyRow> rows = new LinkedHashMap<>();
            List<String> problems = new ArrayList<>();
            List<String> lines;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                lines = reader.lines().toList();
            }
            String previousKey = null;
            for (int index = 0; index < lines.size(); index++) {
                String line = lines.get(index);
                if (line.isBlank() || line.startsWith("#")) {
                    continue;
                }
                String[] columns = line.split("\t", -1);
                if (columns.length != 3) {
                    problems.add("line " + (index + 1)
                            + " 必须 3 列（annotation TAB file TAB reasonCode）：" + line);
                    continue;
                }
                String annotation = columns[0].trim();
                String relative = columns[1].trim();
                String reason = columns[2].trim();
                String derived = CONTEXT_KEY_ANNOTATIONS.get(annotation);
                if (derived == null) {
                    problems.add("line " + (index + 1) + " 注解不在 9 类清单：" + annotation);
                    continue;
                }
                if (!derived.equals(reason)) {
                    problems.add("line " + (index + 1) + " reasonCode 必须=" + derived + "，实际=" + reason);
                    continue;
                }
                if (!relative.endsWith(".java") || relative.contains("\\") || relative.contains("..")) {
                    problems.add("line " + (index + 1) + " file 必须是 src/test/java 相对路径：" + relative);
                    continue;
                }
                if (!Files.isRegularFile(TEST_SOURCES.resolve(relative))) {
                    problems.add("line " + (index + 1) + " file 不存在（stale）：" + relative);
                    continue;
                }
                String key = annotation + "\t" + relative;
                if (rows.putIfAbsent(key, new ContextKeyRow(annotation, relative, reason)) != null) {
                    problems.add("line " + (index + 1) + " 重复行：" + annotation + "  " + relative);
                    continue;
                }
                if (previousKey != null && previousKey.compareTo(key) >= 0) {
                    problems.add("line " + (index + 1) + " 行序必须稳定（annotation,file 升序），请用生成脚本重写");
                }
                previousKey = key;
            }
            return new ContextKeyBaseline(rows, problems);
        }
    }
}
