package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import com.cc01cc.p.xihe.cp.files.PdfSplitService;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;

class RuntimeFileIntegrationTest extends AbstractWireMockTest {

    private static final String TEST_WS_BASE = "/tmp/xihe-test-files-" + System.currentTimeMillis();
    private static final String TEST_WS_ID = "test-file-ws";

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private PdfSplitService pdfSplitService;

    private String tempWsId;

    @BeforeEach
    void setUp() {
        super.setUp();
        tempWsId = "ws-" + UUID.randomUUID().toString().substring(0, 8);
        try {
            Files.createDirectories(Path.of(TEST_WS_BASE));
        } catch (Exception e) {
            throw new RuntimeException("Failed to create test dir", e);
        }
    }

    @Test
    void pdfSplitUploadChunkForwardsToRuntime() {
        Path tempPdf = Path.of(TEST_WS_BASE, "test-split.pdf");
        try (PDDocument doc = new PDDocument()) {
            doc.addPage(new PDPage());
            doc.save(tempPdf.toFile());
        } catch (Exception e) {
            throw new RuntimeException("Failed to create test PDF", e);
        }

        String chunkName = PdfSplitService.generateChunkName("test-split.pdf", 1, 1);
        String encodedPath = URLEncoder.encode(chunkName, StandardCharsets.UTF_8)
                .replace("+", "%20");
        String expectedUrl = "/workspace/" + tempWsId + "/files/write/" + encodedPath;

        wireMock.stubFor(post(urlPathMatching("/workspace/.*/files/write/.*"))
                .willReturn(aResponse().withStatus(200)));

        try {
            pdfSplitService.splitPdf(tempPdf, "test-split.pdf", tempWsId);
        } catch (Exception e) {
            throw new RuntimeException("PDF split failed", e);
        }

        wireMock.verify(postRequestedFor(urlEqualTo(expectedUrl)));
    }

    @Test
    void pdfSplitUploadUsesOctetStreamContentType() {
        Path tempPdf = Path.of(TEST_WS_BASE, "ct-test.pdf");
        try (PDDocument doc = new PDDocument()) {
            doc.addPage(new PDPage());
            doc.save(tempPdf.toFile());
        } catch (Exception e) {
            throw new RuntimeException("Failed to create test PDF", e);
        }

        String chunkName = PdfSplitService.generateChunkName("ct-test.pdf", 1, 1);
        String encodedPath = URLEncoder.encode(chunkName, StandardCharsets.UTF_8)
                .replace("+", "%20");
        String expectedUrl = "/workspace/" + tempWsId + "/files/write/" + encodedPath;

        wireMock.stubFor(post(urlPathMatching("/workspace/.*/files/write/.*"))
                .willReturn(aResponse().withStatus(200)));

        try {
            pdfSplitService.splitPdf(tempPdf, "ct-test.pdf", tempWsId);
        } catch (Exception e) {
            throw new RuntimeException("PDF split failed", e);
        }

        wireMock.verify(postRequestedFor(urlEqualTo(expectedUrl))
                .withHeader("Content-Type", containing("application/octet-stream")));
    }

    @Test
    void pdfSplitUploadHandlesRuntimeError() {
        Path tempPdf = Path.of(TEST_WS_BASE, "error-test.pdf");
        try (PDDocument doc = new PDDocument()) {
            doc.addPage(new PDPage());
            doc.save(tempPdf.toFile());
        } catch (Exception e) {
            throw new RuntimeException("Failed to create test PDF", e);
        }

        wireMock.stubFor(post(urlPathMatching("/workspace/.*/files/write/.*"))
                .willReturn(aResponse().withStatus(500)));

        Exception ex = assertThrows(Exception.class, () ->
                pdfSplitService.splitPdf(tempPdf, "error-test.pdf", tempWsId));

        assertNotNull(ex.getMessage());
    }

    @AfterEach
    @SuppressWarnings("ResultOfMethodCallIgnored")
    void tearDown() {
        Path testDir = Path.of(TEST_WS_BASE);
        if (Files.exists(testDir)) {
            try (var files = Files.walk(testDir)) {
                files.sorted(Comparator.reverseOrder())
                        .forEach(p -> {
                            try {
                                Files.deleteIfExists(p);
                            } catch (Exception ignored) {
                            }
                        });
            } catch (Exception e) {
                // cleanup best-effort
            }
        }
    }
}
