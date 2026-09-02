package com.cc01cc.p.xihe.cp.files;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.multipdf.Splitter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * PDF splitter that writes the resulting chunks through the Runtime file
 * client. CP itself never opens the workspace directory.
 */
@Service
public class PdfSplitService {

    private static final Logger logger = LoggerFactory.getLogger(PdfSplitService.class);
    private static final int PAGES_PER_GROUP = 10;
    private static final int MAX_PAGES = 500;
    private static final long MAX_FILE_SIZE = 500L * 1024 * 1024;

    private final FileProxy fileProxy;

    public PdfSplitService(FileProxy fileProxy) {
        this.fileProxy = fileProxy;
    }

    public List<String> splitPdf(Path pdfPath, String originalName, String wsId) throws IOException {
        long fileSize = Files.size(pdfPath);
        if (fileSize > MAX_FILE_SIZE) {
            throw new IllegalArgumentException("File too large for splitting: " + fileSize
                    + " bytes (max " + MAX_FILE_SIZE + ")");
        }

        try (PDDocument doc = Loader.loadPDF(pdfPath.toFile())) {
            int totalPages = doc.getNumberOfPages();
            if (totalPages > MAX_PAGES) {
                throw new IllegalArgumentException("Too many pages: " + totalPages
                        + " (max " + MAX_PAGES + ")");
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
                        if (!fileProxy.writeBinary(wsId, chunkName, baos.toByteArray())) {
                            throw new IOException("Runtime rejected PDF chunk " + chunkName);
                        }
                        chunks.add(chunkName);
                        logger.debug("Wrote chunk {} ({}/{} pages)", chunkName, end - start, totalPages);
                    }
                }
            } catch (Exception e) {
                fileProxy.deleteAll(wsId, chunks);
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

    /** Thin seam so tests can stub the file transport. */
    public interface FileProxy {
        boolean writeBinary(String workspaceId, String path, byte[] data);
        void deleteAll(String workspaceId, List<String> paths);
    }
}
