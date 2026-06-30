package com.cc01cc.p.xihe.cp.files;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.multipdf.Splitter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

@Service
public class PdfSplitService {

    private static final Logger logger = LoggerFactory.getLogger(PdfSplitService.class);
    private static final int PAGES_PER_GROUP = 10;
    private static final int MAX_PAGES = 500;
    private static final long MAX_FILE_SIZE = 500L * 1024 * 1024;

    private final RestTemplate restTemplate;
    private final String runtimeUrl;

    public PdfSplitService(RestTemplate restTemplate,
                           @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl) {
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
    }

    public List<String> splitPdf(Path pdfPath, String originalName, String wsId) throws IOException {
        long fileSize = Files.size(pdfPath);
        if (fileSize > MAX_FILE_SIZE) {
            throw new IllegalArgumentException("File too large for splitting: " + fileSize + " bytes (max " + MAX_FILE_SIZE + ")");
        }

        try (PDDocument doc = Loader.loadPDF(pdfPath.toFile())) {
            int totalPages = doc.getNumberOfPages();
            if (totalPages > MAX_PAGES) {
                throw new IllegalArgumentException("Too many pages: " + totalPages + " (max " + MAX_PAGES + ")");
            }

            List<String> chunks = new ArrayList<>();
            try {
                for (int start = 0; start < totalPages; start += PAGES_PER_GROUP) {
                    int end = Math.min(start + PAGES_PER_GROUP, totalPages);

                    Splitter splitter = new Splitter();
                    splitter.setStartPage(start + 1);
                    splitter.setEndPage(end);
                    splitter.setSplitAtPage(PAGES_PER_GROUP);
                    List<PDDocument> splitDocs = splitter.split(doc);

                    try (PDDocument chunkDoc = splitDocs.get(0);
                         ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                        chunkDoc.save(baos);

                        String chunkName = generateChunkName(originalName, start + 1, end);
                        uploadChunk(wsId, chunkName, baos.toByteArray());
                        chunks.add(chunkName);
                        logger.debug("Wrote chunk {} ({}/{} pages)", chunkName, end - start, totalPages);
                    }
                }
            } catch (Exception e) {
                cleanupChunks(wsId, chunks);
                throw new IOException("Split failed, rolled back " + chunks.size() + " chunks", e);
            }

            return chunks;
        }
    }

    public static String generateChunkName(String originalName, int startPage, int endPage) {
        String base = originalName.replaceAll("\\.pdf$", "");
        return base + ".p" + startPage + "-" + endPage + ".pdf";
    }

    public static boolean isChunkFile(String name) {
        return name.matches(".+\\.p\\d+-\\d+\\.pdf$");
    }

    public static String baseNameOf(String chunkName) {
        return chunkName.replaceAll("\\.p\\d+-\\d+\\.pdf$", ".pdf");
    }

    void uploadChunk(String wsId, String chunkName, byte[] data) {
        String encodedPath = URLEncoder.encode(chunkName, StandardCharsets.UTF_8)
                .replace("+", "%20");
        String url = runtimeUrl + "/workspace/" + wsId + "/files/write/" + encodedPath;

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        HttpEntity<byte[]> request = new HttpEntity<>(data, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(url, request, String.class);
        if (!response.getStatusCode().is2xxSuccessful()) {
            throw new RuntimeException("Failed to upload chunk, HTTP " + response.getStatusCode());
        }
    }

    void cleanupChunks(String wsId, List<String> chunks) {
        for (String chunk : chunks) {
            try {
                String url = runtimeUrl + "/workspace/" + wsId + "/files/delete";
                HttpHeaders headers = new HttpHeaders();
                headers.setContentType(MediaType.APPLICATION_JSON);
                HttpEntity<String> req = new HttpEntity<>("{\"path\":\"" + chunk + "\"}", headers);
                restTemplate.postForEntity(url, req, String.class);
                logger.debug("Cleaned up chunk: {}", chunk);
            } catch (Exception e) {
                logger.warn("Failed to clean up chunk {}: {}", chunk, e.getMessage());
            }
        }
    }
}
