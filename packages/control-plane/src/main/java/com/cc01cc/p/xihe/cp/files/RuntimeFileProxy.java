package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceFileClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/** Wraps Runtime file writes for the PDF splitter, keeping the service testable. */
@Component
public class RuntimeFileProxy implements PdfSplitService.FileProxy {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeFileProxy.class);

    private final RuntimeWorkspaceFileClient client;

    public RuntimeFileProxy(RuntimeWorkspaceFileClient client) {
        this.client = client;
    }

    @Override
    public boolean writeBinary(String workspaceId, String path, byte[] data) {
        return client.writeBinary(workspaceId, path, data);
    }

    @Override
    public void deleteAll(String workspaceId, List<String> paths) {
        for (String path : paths) {
            try {
                client.deleteFile(workspaceId, path);
            } catch (Exception e) {
                logger.warn("Failed to clean up chunk {}: {}", path, e.getMessage());
            }
        }
    }
}
