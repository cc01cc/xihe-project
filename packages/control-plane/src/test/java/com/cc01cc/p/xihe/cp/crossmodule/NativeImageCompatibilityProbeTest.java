package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.config.NativeAotRuntimeHints;
import com.cc01cc.p.xihe.cp.files.PdfSplitService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.aot.hint.ExecutableMode;
import org.springframework.aot.hint.MemberCategory;
import org.springframework.aot.hint.RuntimeHints;
import org.springframework.aot.hint.RuntimeHintsRegistrar;
import org.springframework.aot.hint.TypeHint;
import org.springframework.aot.hint.TypeReference;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.ImportRuntimeHints;

import java.awt.image.BufferedImage;
import java.awt.image.ColorModel;
import java.awt.image.DataBuffer;
import java.awt.image.Raster;
import java.awt.image.SampleModel;
import java.awt.image.SinglePixelPackedSampleModel;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(classes = NativeImageCompatibilityProbeTest.ProbeConfiguration.class)
class NativeImageCompatibilityProbeTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private final JwtTokenProvider jwtTokenProvider = new JwtTokenProvider(
            "native-image-probe-jwt-secret-for-tests", 900, 3600);

    @TempDir
    Path tempDir;

    @Configuration(proxyBeanMethods = false)
    @ImportRuntimeHints({NativeAotRuntimeHints.class, TestContextRuntimeHints.class})
    static class ProbeConfiguration {
    }

    static class TestContextRuntimeHints implements RuntimeHintsRegistrar {

        @Override
        public void registerHints(RuntimeHints hints, ClassLoader classLoader) {
            hints.reflection().registerType(
                    TypeReference.of("org.springframework.test.context.web.WebAppConfiguration"),
                    MemberCategory.INVOKE_PUBLIC_METHODS);
            // The tracing agent observed these JNI members while running the PDFBox probe.
            registerAwtJniHints(hints);
        }
    }

    private static void registerAwtJniHints(RuntimeHints hints) {
        registerJniType(hints, BufferedImage.class, type -> type
                .withField("colorModel")
                .withField("imageType")
                .withField("raster")
                .withMethod("getRGB", List.of(
                        TypeReference.of(int.class), TypeReference.of(int.class), TypeReference.of(int.class),
                        TypeReference.of(int.class), TypeReference.of(int[].class), TypeReference.of(int.class),
                        TypeReference.of(int.class)), ExecutableMode.INVOKE)
                .withMethod("setRGB", List.of(
                        TypeReference.of(int.class), TypeReference.of(int.class), TypeReference.of(int.class),
                        TypeReference.of(int.class), TypeReference.of(int[].class), TypeReference.of(int.class),
                        TypeReference.of(int.class)), ExecutableMode.INVOKE));
        registerJniType(hints, ColorModel.class, type -> type
                .withField("colorSpace")
                .withField("colorSpaceType")
                .withField("isAlphaPremultiplied")
                .withField("is_sRGB")
                .withField("nBits")
                .withField("numComponents")
                .withField("supportsAlpha")
                .withField("transparency")
                .withMethod("getRGBdefault", List.of(), ExecutableMode.INVOKE));
        registerJniType(hints, Raster.class, type -> type
                .withField("dataBuffer")
                .withField("height")
                .withField("minX")
                .withField("minY")
                .withField("numBands")
                .withField("numDataElements")
                .withField("sampleModel")
                .withField("sampleModelTranslateX")
                .withField("sampleModelTranslateY")
                .withField("width"));
        registerJniType(hints, SampleModel.class, type -> type
                .withField("height")
                .withField("width")
                .withMethod("getPixels", List.of(
                        TypeReference.of(int.class), TypeReference.of(int.class), TypeReference.of(int.class),
                        TypeReference.of(int.class), TypeReference.of(int[].class), TypeReference.of(DataBuffer.class)),
                        ExecutableMode.INVOKE)
                .withMethod("setPixels", List.of(
                        TypeReference.of(int.class), TypeReference.of(int.class), TypeReference.of(int.class),
                        TypeReference.of(int.class), TypeReference.of(int[].class), TypeReference.of(DataBuffer.class)),
                        ExecutableMode.INVOKE));
        registerJniType(hints, SinglePixelPackedSampleModel.class, type -> type
                .withField("bitMasks")
                .withField("bitOffsets")
                .withField("bitSizes")
                .withField("maxBitSize"));
        hints.jni().registerType(TypeReference.of("sun.awt.image.IntegerComponentRaster"), type -> type
                .withField("data")
                .withField("dataOffsets")
                .withField("pixelStride")
                .withField("scanlineStride")
                .withField("type"));
    }

    private static void registerJniType(
            RuntimeHints hints, Class<?> type, Consumer<TypeHint.Builder> customizer) {
        hints.jni().registerType(TypeReference.of(type), customizer);
    }

    @Test
    void configSchemaResourcesAreLoadedAndValidateBothOutcomes() throws IOException {
        ConfigDomainSchema configDomainSchema = new ConfigDomainSchema(objectMapper);
        configDomainSchema.init();

        assertTrue(configDomainSchema.hasSchema("logging"));
        assertTrue(configDomainSchema.validate(
                "logging", objectMapper.readTree("{\"logLevel\":\"INFO\"}"))
                .isEmpty());
        assertFalse(configDomainSchema.validate(
                "logging", objectMapper.readTree("{\"unknownKey\":\"value\"}"))
                .isEmpty());
    }

    @Test
    void authResponseSerializesAccessTokenProperty() throws IOException {
        AuthResponse response = new AuthResponse("probe-access-token", "probe-refresh-token", 900);
        JsonNode json = objectMapper.readTree(objectMapper.writeValueAsBytes(response));

        assertEquals("probe-access-token", json.path("accessToken").asText());
        assertEquals("Bearer", json.path("tokenType").asText());
    }

    @Test
    void jwtAccessTokenRoundTrips() {
        String token = jwtTokenProvider.createAccessToken("native-probe-user", "probe@example.invalid", "ADMIN");

        assertTrue(jwtTokenProvider.validateToken(token));
        assertEquals("native-probe-user", jwtTokenProvider.getUserIdFromToken(token));
    }

    @Test
    void pdfBoxSplitsDocumentAndEmitsValidPdfChunk() throws Exception {
        Path input = tempDir.resolve("native-image-probe.pdf");
        try (PDDocument document = new PDDocument()) {
            document.addPage(new PDPage());
            document.save(input.toFile());
        }

        List<String> writtenPaths = new ArrayList<>();
        List<byte[]> writtenBytes = new ArrayList<>();
        PdfSplitService service = new PdfSplitService(new PdfSplitService.FileProxy() {
            @Override
            public boolean writeBinary(String workspaceId, String path, byte[] bytes) {
                assertEquals("probe-workspace", workspaceId);
                writtenPaths.add(path);
                writtenBytes.add(bytes.clone());
                return true;
            }

            @Override
            public void deleteAll(String workspaceId, List<String> paths) {
                assertEquals("probe-workspace", workspaceId);
                assertTrue(paths.isEmpty());
            }
        });

        List<String> chunks = service.splitPdf(input, "native-image-probe.pdf", "probe-workspace");

        assertEquals(List.of("native-image-probe.p1-1.pdf"), chunks);
        assertEquals(chunks, writtenPaths);
        assertEquals(1, writtenBytes.size());
        try (PDDocument chunk = Loader.loadPDF(writtenBytes.get(0))) {
            assertEquals(1, chunk.getNumberOfPages());
        }
    }
}
